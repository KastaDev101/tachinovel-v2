//
//  HybridScheduler.swift — which voice speaks each sentence of a chapter, and what to render next.
//
//  Kokoro (neural, on device) is the voice; the Apple system voice takes over, one sentence at a time,
//  whenever Kokoro can't deliver the next sentence on time:
//    - the model is still loading (cold start) or unavailable (failed, disabled, released under memory
//      pressure),
//    - the render-ahead queue ran dry (the next sentence isn't rendered when the previous one ends),
//    - the device is thermally throttled (serious/critical: no new renders, rendered audio still plays),
//    - one sentence failed to synthesize.
//  Switches happen only at sentence boundaries. After a fallback, Kokoro takes over again as soon as it is
//  `returnAhead` sentences ahead (so it doesn't flip back and forth).
//
//  Rendering: at most `ahead` sentences beyond the one playing are rendered or in flight (2–3 keeps the
//  queue safe without burning battery), one render at a time, none while paused or throttled.
//
//  Pure state machine (no clocks, no audio): the engine feeds it events and the current time and acts on
//  its decisions. Unit-tested in Tests/HDVoiceCoreTests/HybridSchedulerTests.swift.
//

import Foundation

public enum VoiceSource: String, Sendable, Equatable {
    case kokoro
    case apple
}

public enum FallbackReason: String, Sendable, Equatable, CaseIterable {
    /// Kokoro is still loading (first use after install compiles the model for the Neural Engine).
    case modelLoading
    /// Kokoro is missing, failed to load, was turned off after crashes, or was released under memory pressure.
    case modelUnavailable
    /// The render-ahead queue ran dry: the next sentence wasn't ready when the previous one ended.
    case queueDry
    /// The device is thermally throttled (serious or critical).
    case thermal
    /// This one sentence couldn't be synthesized.
    case segmentFailed
    /// Kokoro is turned off in settings.
    case disabled
}

public struct HybridScheduler: Sendable {
    public struct Config: Sendable, Equatable {
        /// Sentences rendered (or rendering) beyond the one playing.
        public var ahead: Int
        /// Ready sentences (from the next one on) needed to switch back from Apple to Kokoro.
        public var returnAhead: Int
        /// At the start of a session, wait this long for the first Kokoro sentence (model load + first render).
        public var startGrace: TimeInterval
        /// At a sentence boundary, wait this long for a render that is in flight before falling back.
        public var dryGrace: TimeInterval
        /// This many failed renders in a row make Kokoro unavailable for the session.
        public var maxConsecutiveFailures: Int

        public init(ahead: Int = 3, returnAhead: Int = 2, startGrace: TimeInterval = 2.5, dryGrace: TimeInterval = 0.25, maxConsecutiveFailures: Int = 3) {
            self.ahead = max(1, ahead)
            self.returnAhead = max(1, returnAhead)
            self.startGrace = max(0, startGrace)
            self.dryGrace = max(0, dryGrace)
            self.maxConsecutiveFailures = max(1, maxConsecutiveFailures)
        }
    }

    public enum KokoroState: String, Sendable, Equatable {
        case ready
        case loading
        case unavailable
        case disabled
    }

    public enum Decision: Sendable, Equatable {
        /// Play segment i's rendered Kokoro audio.
        case kokoro(Int)
        /// Speak segment i with the Apple voice.
        case apple(Int, FallbackReason)
        /// Nothing to start yet: ask again after this many seconds, or as soon as a render finishes.
        case wait(TimeInterval)
        /// Every segment has been handed to a voice.
        case finished
    }

    enum Slot: Sendable, Equatable {
        case pending
        case rendering
        case ready
        case failed
        /// Handed to a voice (played by Kokoro, or taken by Apple; a late render is then discarded).
        case claimed
    }

    public let count: Int
    public var config: Config
    var slots: [Slot]
    /// Next segment not yet handed to a voice.
    public private(set) var cursor: Int
    /// Segment audible now (nil between sentences).
    public private(set) var playing: Int?
    /// The voice sentences go to while things are fine; `.apple` after a fallback until Kokoro is ahead again.
    public private(set) var source: VoiceSource
    public private(set) var lastFallback: FallbackReason?
    public var kokoro: KokoroState {
        didSet {
            guard kokoro != .ready else { return }
            // Renders in flight are abandoned: their segments become pending again, and a late result
            // is ignored (renderDone only promotes a segment that is still marked rendering).
            for i in slots.indices where slots[i] == .rendering { slots[i] = .pending }
            rendering = nil
        }
    }
    public var throttled = false
    public var paused = false
    /// The render in flight (only one at a time).
    public private(set) var rendering: Int?
    private var waitStart: TimeInterval?
    /// Something has been handed to a voice in this session.
    public private(set) var started = false
    private var consecutiveFailures = 0

    // Statistics (Voice Lab).
    public private(set) var underruns = 0
    public private(set) var fallbacks: [FallbackReason: Int] = [:]
    public private(set) var returnsToKokoro = 0
    public private(set) var kokoroSentences = 0
    public private(set) var appleSentences = 0

    public init(count: Int, start: Int = 0, kokoro: KokoroState, config: Config = Config()) {
        self.count = max(0, count)
        self.config = config
        self.slots = Array(repeating: .pending, count: max(0, count))
        self.cursor = min(max(0, start), max(0, count))
        for i in 0..<self.cursor { slots[i] = .claimed }
        self.kokoro = kokoro
        switch kokoro {
        case .ready, .loading:
            source = .kokoro
        case .unavailable:
            source = .apple
            lastFallback = .modelUnavailable
        case .disabled:
            source = .apple
            lastFallback = .disabled
        }
    }

    // MARK: - Rendering

    /// Every sentence has been rendered or taken: Kokoro is free until the next chapter (which it can then
    /// start rendering ahead).
    public var allRendered: Bool { rendering == nil && !slots.contains(.pending) }

    /// The next segment to render, marked as rendering; nil when nothing should be rendered now.
    public mutating func nextRender() -> Int? {
        guard kokoro == .ready, !throttled, !paused, rendering == nil, cursor < count else { return nil }
        let base = playing ?? (cursor - 1)
        let upper = min(count - 1, base + config.ahead)
        guard cursor <= upper else { return nil }
        for i in cursor...upper where slots[i] == .pending {
            slots[i] = .rendering
            rendering = i
            return i
        }
        return nil
    }

    /// A render finished. A segment Apple took in the meantime stays taken (the audio is discarded).
    public mutating func renderDone(_ i: Int, ok: Bool) {
        if rendering == i { rendering = nil }
        guard slots.indices.contains(i) else { return }
        if slots[i] == .rendering { slots[i] = ok ? .ready : .failed }
        if ok {
            consecutiveFailures = 0
        } else {
            consecutiveFailures += 1
            if consecutiveFailures >= config.maxConsecutiveFailures, kokoro == .ready { kokoro = .unavailable }
        }
    }

    /// True if segment i has rendered audio waiting to be played.
    public func isReady(_ i: Int) -> Bool { slots.indices.contains(i) && slots[i] == .ready }

    /// Contiguous ready segments starting at i.
    public func readyRun(from i: Int) -> Int {
        var n = 0
        var j = i
        while j < count, slots[j] == .ready {
            n += 1
            j += 1
        }
        return n
    }

    // MARK: - Playback

    /// The voice is idle (session start, or the previous segment just ended): what plays next?
    public mutating func decide(now: TimeInterval) -> Decision {
        while cursor < count, slots[cursor] == .claimed { cursor += 1 }
        guard cursor < count else { return .finished }
        let i = cursor
        switch slots[i] {
        case .ready:
            if source == .kokoro || canReturn(from: i) { return commitKokoro(i) }
            return commitApple(i, lastFallback ?? .queueDry)
        case .rendering:
            if source == .kokoro {
                if let w = waitRemaining(now: now) { return .wait(w) }
                if started { underruns += 1 }
                return fallBack(i, .queueDry)
            }
            return commitApple(i, lastFallback ?? .queueDry)
        case .pending:
            guard source == .kokoro else { return commitApple(i, lastFallback ?? currentReason()) }
            switch kokoro {
            case .ready:
                if throttled { return fallBack(i, .thermal) }
                // Rendering is about to pick it up (session start, or a render was just discarded).
                if let w = waitRemaining(now: now) { return .wait(w) }
                if started { underruns += 1 }
                return fallBack(i, .queueDry)
            case .loading:
                // A warm load takes well under a second: give it the start grace before Apple begins.
                if !started, let w = waitRemaining(now: now) { return .wait(w) }
                return fallBack(i, .modelLoading)
            case .unavailable:
                return fallBack(i, .modelUnavailable)
            case .disabled:
                return fallBack(i, .disabled)
            }
        case .failed:
            // One bad sentence: Apple reads it, Kokoro carries on with the next.
            return commitApple(i, .segmentFailed)
        case .claimed:
            return .finished // unreachable: skipped above
        }
    }

    /// While a Kokoro segment plays: the next one if it can be queued right behind it (gapless).
    public mutating func prefetchNext() -> Int? {
        guard source == .kokoro, cursor < count, slots[cursor] == .ready else { return nil }
        let i = cursor
        slots[i] = .claimed
        cursor += 1
        kokoroSentences += 1
        return i
    }

    /// Segment i became audible (the engine's start callback).
    public mutating func started(_ i: Int) {
        playing = i
    }

    /// Segment i finished playing.
    public mutating func finished(_ i: Int) {
        if playing == i { playing = nil }
    }

    // MARK: - Private

    private func canReturn(from i: Int) -> Bool {
        guard kokoro == .ready, !throttled else { return false }
        return readyRun(from: i) >= min(config.returnAhead, count - i)
    }

    private func currentReason() -> FallbackReason {
        switch kokoro {
        case .loading: return .modelLoading
        case .unavailable: return .modelUnavailable
        case .disabled: return .disabled
        case .ready: return throttled ? .thermal : .queueDry
        }
    }

    private mutating func waitRemaining(now: TimeInterval) -> TimeInterval? {
        let grace = started ? config.dryGrace : config.startGrace
        if waitStart == nil { waitStart = now }
        let remaining = grace - (now - (waitStart ?? now))
        return remaining > 0.001 ? remaining : nil
    }

    private mutating func fallBack(_ i: Int, _ reason: FallbackReason) -> Decision {
        if source == .kokoro { fallbacks[reason, default: 0] += 1 }
        source = .apple
        lastFallback = reason
        return commitApple(i, reason)
    }

    private mutating func commitApple(_ i: Int, _ reason: FallbackReason) -> Decision {
        slots[i] = .claimed
        cursor = i + 1
        playing = i
        started = true
        waitStart = nil
        appleSentences += 1
        return .apple(i, reason)
    }

    private mutating func commitKokoro(_ i: Int) -> Decision {
        if source == .apple { returnsToKokoro += 1 }
        source = .kokoro
        lastFallback = nil
        slots[i] = .claimed
        cursor = i + 1
        playing = i
        started = true
        waitStart = nil
        kokoroSentences += 1
        return .kokoro(i)
    }
}
