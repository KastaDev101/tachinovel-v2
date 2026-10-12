import Foundation

/// TachiNovel addition (studio audit A6, 2026-10-12): how a text chunk's generation ends.
///
/// FluidAudio stops a chunk a fixed number of latents after the model signals the end of its text: 3 (80 ms each),
/// or 5 for a short text. With the Nephis actor, 12-20% of short lines were still above -40 dBFS at that point (PC,
/// 24 takes per group): the stop cut the sound off, heard as a clipped final "s". A guard lets a chunk that is still
/// audible at its usual stop run on until it has died away, and ignores an end-of-speech signal in the first steps, as
/// Kyutai's own generation loop does. `.off`, the default everywhere, keeps FluidAudio's behaviour exactly.
///
/// One `ChunkEndTracker` drives the end of every generation loop (session IO and `.aneState` paths, both streaming
/// loops). It needs the decoded level of a latent only at the steps where it decides: loops that decode every latent
/// hand it the level of the audio they already have; a latents-only session asks its `TailLevelProbe`.
extension PocketTtsSynthesizer {

    /// When a chunk's generation may end.
    public struct EndGuard: Sendable, Equatable {
        /// End-of-speech signals before this generation step are ignored (Kyutai's loop: 6; FluidAudio: 0).
        public var minEosStep: Int
        /// A chunk whose last latent decodes louder than this (dBFS, RMS over its 80 ms) at the usual stop keeps
        /// generating; nil = never.
        public var audibleDB: Double?
        /// It stops once `quietLatents` latents in a row decode quieter than `quietDB`...
        public var quietDB: Double
        public var quietLatents: Int
        /// ...or `maxExtraLatents` latents past the usual stop, whichever comes first.
        public var maxExtraLatents: Int

        public init(
            minEosStep: Int = 0, audibleDB: Double? = nil, quietDB: Double = -50, quietLatents: Int = 2,
            maxExtraLatents: Int = 0
        ) {
            self.minEosStep = minEosStep
            self.audibleDB = audibleDB
            self.quietDB = quietDB
            self.quietLatents = quietLatents
            self.maxExtraLatents = maxExtraLatents
        }

        /// FluidAudio's own end: every end-of-speech signal counts, no extension.
        public static let off = EndGuard()

        /// The studio audit's end (A6): end of speech from step 6 on, and a chunk still above -40 dBFS at its usual
        /// stop runs on until 2 latents in a row are under -50 dBFS, for at most 6 more latents (480 ms).
        public static let audibleTail = EndGuard(
            minEosStep: 6, audibleDB: -40, quietDB: -50, quietLatents: 2, maxExtraLatents: 6)

        /// Whether the guard can extend a chunk (it then needs its latents' levels).
        public var extendsTails: Bool { audibleDB != nil && maxExtraLatents > 0 }
    }

    /// How one chunk's generation ended (logs, the Voice test report).
    public struct ChunkEnd: Sendable, Equatable {
        /// The chunk's index within its utterance.
        public let chunkIndex: Int
        /// The enqueued utterance it belongs to (session mode); nil for one-shot and streaming synthesis.
        public let utteranceIndex: Int?
        /// Latents generated for the chunk (80 ms each).
        public let frames: Int
        /// The step at which the end of speech was accepted; nil = never (the chunk ran into its frame budget, or
        /// was cancelled).
        public let eosStep: Int?
        /// The first end-of-speech signal before `EndGuard.minEosStep`, which was ignored; nil = none.
        public let earlyEosStep: Int?
        /// Latents generated after `eosStep`: FluidAudio's own 2 (4 for a short text), plus any extension.
        public let framesAfterEos: Int
        /// The decoded level (dBFS) of the chunk's last latent; nil = not measured (a latents-only session without
        /// a level probe, the streaming pipeline, or a chunk that never reached its usual stop).
        public let lastLatentDB: Double?
        /// The decoded level of the last latent at the usual stop, which decided the extension; nil = the usual stop
        /// was not reached, or its level not measured.
        public let stopLatentDB: Double?
        /// Latents generated past the usual stop because the chunk was still audible there.
        public let extraLatents: Int

        /// Whether the chunk ran past its usual stop.
        public var tailExtended: Bool { extraLatents > 0 }

        /// Whether the chunk still ended above `db` dBFS, a hard cut; nil = not measured.
        public func endsAudible(above db: Double = -40) -> Bool? {
            lastLatentDB.map { $0 > db }
        }
    }

    /// What a level probe is asked: the decoded level (dBFS, RMS over its 1920 samples) of the last of `latents`.
    public struct TailLevelRequest: Sendable {
        /// The chunk's latents so far, in order (the ones the session yielded as `AudioFrame.latent`).
        public let latents: [[Float]]
        public let chunkIndex: Int
        public let utteranceIndex: Int?
        /// True for the chunk's first request (at its usual stop). Otherwise `latents` is the previous request's
        /// plus the one latent generated since, so a probe can carry its decoder state on.
        public let first: Bool

        public init(latents: [[Float]], chunkIndex: Int, utteranceIndex: Int?, first: Bool) {
            self.latents = latents
            self.chunkIndex = chunkIndex
            self.utteranceIndex = utteranceIndex
            self.first = first
        }
    }

    /// Answers a `TailLevelRequest` for a session that yields latents only (`setDecodesAudio(false)`); nil = unknown,
    /// and the chunk then ends: at its usual stop, or at once when it is already running on.
    public typealias TailLevelProbe = @Sendable (TailLevelRequest) async -> Double?

    /// A level probe that decodes on `decoder`, which must be its own (it is reset at each chunk's first request), for
    /// one session at a time: the asked latent after `warmUp` latents before it, then one latent per further request.
    /// That is `warmUp` + 1 Mimi predictions per chunk end, plus one per extra latent, on top of the caller's own
    /// decoding; a caller that already decodes its takes can answer from that audio instead.
    public static func levelProbe(decoder: PocketTtsLatentDecoder, warmUp: Int = 6) -> TailLevelProbe {
        let meter = PocketTtsTailMeter(decoder: decoder, warmUp: warmUp)
        return { request in await meter.level(request) }
    }

    /// The level of one latent's audio (dBFS, RMS), as NephisFlow and the PC measure it; nil without samples.
    static func latentLevel(_ samples: [Float]) -> Double? {
        guard !samples.isEmpty else { return nil }
        var acc = 0.0
        for sample in samples {
            acc += Double(sample) * Double(sample)
        }
        return 10 * log10(max(acc / Double(samples.count), 1e-12))
    }

    /// The end of one chunk's generation loop. Per step, in this order: `noteEos` with the step's end-of-speech
    /// logit; when `needsLevel`, `record(level:)` from a probe; `shouldStop` (break before keeping the step's latent);
    /// then, once the latent is yielded, `kept(level:)` with its audio's level when the loop decoded it.
    struct ChunkEndTracker {
        let endGuard: EndGuard
        /// FluidAudio's own stop: this many steps after the end-of-speech step.
        let usualFramesAfterEos: Int
        private(set) var eosStep: Int?
        private(set) var earlyEosStep: Int?
        /// Latents kept so far.
        private(set) var generated = 0
        /// The level of the last latent kept, once known.
        private(set) var lastLevel: Double?
        private(set) var stopLevel: Double?
        /// Running on past the usual stop, and the latents kept since.
        private(set) var extending = false
        private(set) var extra = 0
        private var quietRun = 0

        init(endGuard: EndGuard, usualFramesAfterEos: Int) {
            self.endGuard = endGuard
            self.usualFramesAfterEos = usualFramesAfterEos
        }

        /// Notes a step's end-of-speech logit; true when this step is accepted as the end of speech.
        @discardableResult
        mutating func noteEos(step: Int, logit: Float) -> Bool {
            guard logit > PocketTtsConstants.eosThreshold, eosStep == nil else { return false }
            guard step >= endGuard.minEosStep else {
                if earlyEosStep == nil { earlyEosStep = step }
                return false
            }
            eosStep = step
            return true
        }

        /// Whether FluidAudio's own loop would stop before step `step`.
        func reachedUsualStop(_ step: Int) -> Bool {
            guard let eosStep else { return false }
            return step >= eosStep + usualFramesAfterEos
        }

        /// Whether the decision before step `step` needs the last latent's level, not known yet.
        func needsLevel(before step: Int) -> Bool {
            endGuard.extendsTails && generated > 0 && lastLevel == nil && (extending || reachedUsualStop(step))
        }

        /// The level of the last latent kept (the first one given counts).
        mutating func record(level: Double) {
            guard generated > 0, lastLevel == nil else { return }
            lastLevel = level
            if extending {
                quietRun = level < endGuard.quietDB ? quietRun + 1 : 0
            }
        }

        /// Whether to stop before keeping step `step`'s latent. With `.off` this is FluidAudio's own condition.
        mutating func shouldStop(before step: Int) -> Bool {
            if extending {
                // Died away, at the cap, or no longer measurable.
                return lastLevel == nil || quietRun >= endGuard.quietLatents || extra >= endGuard.maxExtraLatents
            }
            guard reachedUsualStop(step) else { return false }
            stopLevel = lastLevel
            guard endGuard.maxExtraLatents > 0, let audible = endGuard.audibleDB, let level = lastLevel, level > audible
            else { return true }
            extending = true
            return false
        }

        /// A latent was kept (yielded), with its audio's level when the loop decoded it.
        mutating func kept(level: Double?) {
            generated += 1
            if extending { extra += 1 }
            lastLevel = nil
            if let level { record(level: level) }
        }

        func summary(chunkIndex: Int, utteranceIndex: Int?) -> ChunkEnd {
            ChunkEnd(
                chunkIndex: chunkIndex,
                utteranceIndex: utteranceIndex,
                frames: generated,
                eosStep: eosStep,
                earlyEosStep: earlyEosStep,
                framesAfterEos: eosStep.map { max(0, generated - 1 - $0) } ?? 0,
                lastLatentDB: lastLevel,
                stopLatentDB: stopLevel,
                extraLatents: extra)
        }
    }

    /// A streaming run: its frames and, once they have all been read, how each chunk ended.
    struct StreamingRun {
        let frames: AsyncThrowingStream<AudioFrame, Error>
        let chunkEnds: @Sendable () async -> [ChunkEnd]
    }
}

/// TachiNovel: decodes the latents a `PocketTtsSynthesizer.levelProbe(decoder:warmUp:)` is asked about.
actor PocketTtsTailMeter {
    private let decoder: PocketTtsLatentDecoder
    private let warmUp: Int
    /// Latents of the current chunk decoded so far.
    private var decoded = 0

    init(decoder: PocketTtsLatentDecoder, warmUp: Int) {
        self.decoder = decoder
        self.warmUp = max(0, warmUp)
    }

    func level(_ request: PocketTtsSynthesizer.TailLevelRequest) async -> Double? {
        let latents = request.latents
        guard !latents.isEmpty else { return nil }
        do {
            let audio: [Float]
            if request.first || decoded >= latents.count {
                // A cold decoder's first frames are off: start over, warmed up on the latents before the asked one.
                try await decoder.reset()
                audio = try await decoder.decode(Array(latents.suffix(warmUp + 1)))
            } else {
                audio = try await decoder.decode(Array(latents[decoded...]))
            }
            decoded = latents.count
            return PocketTtsSynthesizer.latentLevel(Array(audio.suffix(PocketTtsConstants.samplesPerFrame)))
        } catch {
            return nil
        }
    }
}
