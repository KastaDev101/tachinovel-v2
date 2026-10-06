//
//  CarAudio.swift — what the car (and the lock screen, headphones, steering wheel, Siri) shows and does
//  while narrating.
//
//  Without Apple's CarPlay audio entitlement, CarPlay's own Now Playing screen still shows and controls any
//  app that plays audio, from MPNowPlayingInfoCenter (metadata) and MPRemoteCommandCenter (buttons). This
//  file is the platform-free part of that, unit-tested on the CI host:
//    - RemoteCommandMap: a remote command (+ the "Car buttons" setting) → a narration action, and which
//      commands to offer;
//    - ChapterTimeline: chapter time for speech that is synthesized sentence by sentence (no file, so no
//      known length): estimated from the text, refined with every sentence actually spoken;
//    - NowPlayingSmoother: keeps the shown time and length steady while estimates move (no jumps, no
//      flicker of the length on every sentence);
//    - NowPlayingMetadata: the fields, the same for Kokoro, the Apple voice, prepared audio and PC audio.
//

import Foundation

/// Settings › Voices › In the car › "Car buttons": what the two side buttons do in the car, on the lock
/// screen, on headphones and on the steering wheel.
public enum CarButtons: String, Sendable, Codable, CaseIterable {
    /// ⏮ ⏭ previous / next chapter.
    case chapters
    /// ↺15 ↻15 back / forward 15 seconds.
    case skip15
}

/// A remote control command, as MPRemoteCommandCenter delivers it.
public enum RemoteCommand: Equatable, Sendable {
    case play
    case pause
    case togglePlayPause
    case nextTrack
    case previousTrack
    case skipForward(Double)
    case skipBackward(Double)
    case changePlaybackPosition(Double)
    case changePlaybackRate(Float)

    /// Stable name (diagnostics, the simulator self-test).
    public var name: String {
        switch self {
        case .play: return "play"
        case .pause: return "pause"
        case .togglePlayPause: return "togglePlayPause"
        case .nextTrack: return "nextTrack"
        case .previousTrack: return "previousTrack"
        case .skipForward: return "skipForward"
        case .skipBackward: return "skipBackward"
        case .changePlaybackPosition: return "changePlaybackPosition"
        case .changePlaybackRate: return "changePlaybackRate"
        }
    }

    /// The command named `name` (the simulator self-test drives commands by name). `value`: seconds for
    /// skips and positions, the speed for a rate change.
    public static func named(_ name: String, value: Double?) -> RemoteCommand? {
        switch name {
        case "play": return .play
        case "pause": return .pause
        case "togglePlayPause": return .togglePlayPause
        case "nextTrack": return .nextTrack
        case "previousTrack": return .previousTrack
        case "skipForward": return .skipForward(value ?? RemoteCommandMap.skipInterval)
        case "skipBackward": return .skipBackward(value ?? RemoteCommandMap.skipInterval)
        case "changePlaybackPosition": return value.map { RemoteCommand.changePlaybackPosition($0) }
        case "changePlaybackRate": return value.map { RemoteCommand.changePlaybackRate(Float($0)) }
        default: return nil
        }
    }
}

/// What narration does in response to a remote command.
public enum RemoteAction: Equatable, Sendable {
    case resume
    case pause
    case nextChapter
    case previousChapter
    case restartChapter
    /// Relative seek in chapter seconds (at 1×).
    case seekBy(Double)
    /// Absolute chapter time (seconds at 1×).
    case seekTo(Double)
    case setRate(Float)
}

/// The state a command is interpreted in.
public struct RemoteContext: Equatable, Sendable {
    public var playing: Bool
    /// Chapter time now (seconds at 1×).
    public var elapsed: Double
    public var hasPreviousChapter: Bool

    public init(playing: Bool, elapsed: Double, hasPreviousChapter: Bool) {
        self.playing = playing
        self.elapsed = elapsed
        self.hasPreviousChapter = hasPreviousChapter
    }
}

/// Which commands the system offers. Play, pause and toggle are always on. The side slots show either the
/// track buttons or the skip buttons; enabling only one pair makes the choice deterministic, and hardware
/// next/previous buttons (steering wheel, headphones) then follow the same setting.
public struct EnabledCommands: Equatable, Sendable {
    public var nextTrack: Bool
    public var previousTrack: Bool
    public var skipForward: Bool
    public var skipBackward: Bool
    public var changePlaybackPosition: Bool
    public var changePlaybackRate: Bool

    public init(nextTrack: Bool, previousTrack: Bool, skipForward: Bool, skipBackward: Bool, changePlaybackPosition: Bool, changePlaybackRate: Bool) {
        self.nextTrack = nextTrack
        self.previousTrack = previousTrack
        self.skipForward = skipForward
        self.skipBackward = skipBackward
        self.changePlaybackPosition = changePlaybackPosition
        self.changePlaybackRate = changePlaybackRate
    }
}

public enum RemoteCommandMap {
    /// The skip buttons' interval (seconds).
    public static let skipInterval: Double = 15
    /// "Previous" within this many seconds of a chapter's start goes to the previous chapter; later, it
    /// starts the chapter over (like a music player).
    public static let restartWindow: Double = 5
    /// Speeds offered by the system's rate control (some cars, Siri "play faster"): the Listen player's chips.
    public static let rates: [Float] = SpeechSpeed.presets.map { Float($0) }

    public static func enabled(_ buttons: CarButtons) -> EnabledCommands {
        switch buttons {
        case .chapters:
            return EnabledCommands(nextTrack: true, previousTrack: true, skipForward: false, skipBackward: false,
                                   changePlaybackPosition: true, changePlaybackRate: true)
        case .skip15:
            return EnabledCommands(nextTrack: false, previousTrack: false, skipForward: true, skipBackward: true,
                                   changePlaybackPosition: true, changePlaybackRate: true)
        }
    }

    public static func action(for command: RemoteCommand, in context: RemoteContext) -> RemoteAction {
        switch command {
        case .play: return .resume
        case .pause: return .pause
        case .togglePlayPause: return context.playing ? .pause : .resume
        case .nextTrack: return .nextChapter
        case .previousTrack:
            return context.elapsed > restartWindow || !context.hasPreviousChapter ? .restartChapter : .previousChapter
        case .skipForward(let s): return .seekBy(interval(s))
        case .skipBackward(let s): return .seekBy(-interval(s))
        case .changePlaybackPosition(let t): return .seekTo(t.isFinite ? max(0, t) : 0)
        case .changePlaybackRate(let r): return .setRate(Float(SpeechSpeed.clamp(Double(r))))
        }
    }

    private static func interval(_ s: Double) -> Double {
        s.isFinite && abs(s) > 0 ? abs(s) : skipInterval
    }
}

// MARK: - Chapter time for synthesized speech

/// Chapter time while speech is synthesized sentence by sentence. Times are "media seconds" at 1× speed:
/// what the lock screen and the car show, advanced by the system at the playback rate. The length is
/// estimated from the characters left; every sentence actually spoken refines the speaking speed.
public struct ChapterTimeline: Equatable, Sendable {
    public struct Sentence: Equatable, Sendable {
        public let characters: Int
        /// Pause after the sentence at 1× (seconds).
        public let pause: Double

        public init(characters: Int, pause: Double) {
            self.characters = max(0, characters)
            self.pause = pause.isFinite ? max(0, pause) : 0
        }
    }

    /// Speaking speed assumed before anything was measured: characters per second at 1× (English
    /// narration, ~165 words per minute).
    public static let priorCharactersPerSecond = 14.5
    /// How many characters of evidence the prior is worth (a few sentences), so the first measurements
    /// refine the estimate smoothly instead of swinging it.
    public static let priorWeight = 400.0

    public private(set) var sentences: [Sentence]
    /// Measured speaking time at 1× (seconds, without the pause), per sentence.
    public private(set) var measured: [Double?]
    public let prior: Double
    /// Blended speaking speed (characters per second at 1×).
    public private(set) var charactersPerSecond: Double
    /// starts[i] = chapter time where sentence i begins; starts[count] = the length.
    private var starts: [Double]

    public init(_ sentences: [Sentence], prior: Double = ChapterTimeline.priorCharactersPerSecond) {
        let p = prior > 0 && prior.isFinite ? prior : ChapterTimeline.priorCharactersPerSecond
        self.sentences = sentences
        self.measured = Array(repeating: nil, count: sentences.count)
        self.prior = p
        self.charactersPerSecond = p
        self.starts = []
        rebuild()
    }

    public var count: Int { sentences.count }

    /// A sentence was spoken: its speaking time at 1× (wall seconds × speed, without the pause after it).
    public mutating func record(_ index: Int, seconds: Double) {
        guard sentences.indices.contains(index), seconds.isFinite, seconds > 0.05 else { return }
        measured[index] = seconds
        rebuild()
    }

    /// Speaking time of sentence `i` at 1× (measured, else estimated).
    public func speaking(_ i: Int) -> Double {
        guard sentences.indices.contains(i) else { return 0 }
        return measured[i] ?? Double(sentences[i].characters) / charactersPerSecond
    }

    /// Chapter time where sentence `i` begins (`count` → the length).
    public func start(of i: Int) -> Double {
        starts[min(max(0, i), sentences.count)]
    }

    public var duration: Double { starts[sentences.count] }

    /// The sentence playing at chapter time `t` (the last one starting at or before it).
    public func index(at t: Double) -> Int {
        guard !sentences.isEmpty else { return 0 }
        var lo = 0
        var hi = sentences.count - 1
        var ans = 0
        while lo <= hi {
            let mid = (lo + hi) / 2
            if starts[mid] <= t {
                ans = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return ans
    }

    private mutating func rebuild() {
        var chars = 0.0
        var secs = 0.0
        for (i, m) in measured.enumerated() {
            guard let m else { continue }
            chars += Double(sentences[i].characters)
            secs += m
        }
        let w = Self.priorWeight
        charactersPerSecond = (chars + w) / (secs + w / prior)
        var t = 0.0
        var out: [Double] = []
        out.reserveCapacity(sentences.count + 1)
        for i in sentences.indices {
            out.append(t)
            t += speaking(i) + sentences[i].pause
        }
        out.append(t)
        starts = out
    }
}

// MARK: - Steady Now Playing time

/// The system shows `elapsed + (now − published) × rate` between updates. Republishing a slightly different
/// estimate on every sentence would make the time jump back and forth and the length flicker; this keeps
/// what is shown unless it drifted by more than a tolerance, and only moves the length in real steps.
public struct NowPlayingSmoother: Equatable, Sendable {
    public struct Shown: Equatable, Sendable {
        public let elapsed: Double
        public let duration: Double
        /// 0 while paused.
        public let rate: Double
        /// When it was published (seconds, any monotonic clock).
        public let at: Double

        /// The time the system shows at `now`.
        public func elapsedShown(at now: Double) -> Double { elapsed + max(0, now - at) * rate }
    }

    /// Drift the shown time may have from the model before it is corrected (seconds).
    public var tolerance = 2.0
    /// The length moves only by this fraction of itself, and at least `minDurationStep` seconds.
    public var durationStep = 0.04
    public var minDurationStep = 10.0
    public private(set) var shown: Shown?

    public init() {}

    public mutating func reset() { shown = nil }

    /// What to publish now. `jump`: a deliberate move (seek, new chapter, rate change) that must show at once.
    public mutating func next(elapsed: Double, duration: Double, rate: Double, now: Double, jump: Bool = false) -> Shown {
        var e = elapsed.isFinite ? max(0, elapsed) : 0
        var d = duration.isFinite ? max(0, duration) : 0
        let r = rate.isFinite ? max(0, rate) : 0
        if !jump, let s = shown {
            let shownNow = s.elapsedShown(at: now)
            if abs(shownNow - e) <= tolerance { e = shownNow }
            if abs(d - s.duration) < max(minDurationStep, s.duration * durationStep) { d = s.duration }
        }
        d = max(d, e) // never a length shorter than the time shown
        let out = Shown(elapsed: e, duration: d, rate: r, at: now)
        shown = out
        return out
    }
}

/// The Now Playing fields (MPNowPlayingInfoCenter), the same for every source.
public struct NowPlayingMetadata: Equatable, Sendable {
    public static let albumTitle = "TachiNovel"

    /// The chapter.
    public var title: String
    /// The novel.
    public var artist: String
    public var album: String
    public var duration: Double
    public var elapsed: Double
    /// 0 while paused (the system then stops advancing the time).
    public var rate: Double
    public var defaultRate: Double

    public init(title: String, artist: String, album: String = NowPlayingMetadata.albumTitle, duration: Double, elapsed: Double, rate: Double, defaultRate: Double = 1) {
        self.title = title
        self.artist = artist
        self.album = album
        self.duration = duration
        self.elapsed = elapsed
        self.rate = rate
        self.defaultRate = defaultRate
    }

    public static func make(chapter: String, novel: String, shown: NowPlayingSmoother.Shown) -> NowPlayingMetadata {
        let c = chapter.trimmingCharacters(in: .whitespacesAndNewlines)
        let n = novel.trimmingCharacters(in: .whitespacesAndNewlines)
        return NowPlayingMetadata(title: c.isEmpty ? "Chapter" : c, artist: n.isEmpty ? albumTitle : n,
                                  duration: shown.duration, elapsed: shown.elapsed, rate: shown.rate)
    }
}
