//
//  NaturalFinish.swift — natural delivery's audio path for one rendered unit (a breath-group chunk of sentences, or
//  one sentence), from the model's samples to one buffer per sentence:
//
//    1. joins     one text in several model calls: each call trimmed (40 dB under its peak) and joined with
//                 equal-power fades and a short gap, so joins never click;
//    2. cleanup   isolated blips dropped, micro-gaps off punctuation closed (SpeechShape);
//    3. rate      the unit's speaking rate leveled toward the running median (≤ ±10 %), times the listener's speed:
//                 one WSOLA time-stretch, pitch kept (TimeStretch);
//    4. "…"       the model's own pause at a dramatic ellipsis stretched to 350–450 ms;
//    5. sound     the app's polish EQ (compressor off), then the clean-warm chain or loudness matching alone: every
//                 unit's speech sits at −20 dBFS RMS, no level jumps;
//    6. timing    the sentence ends found in the audio (ChunkAligner); confident → each sentence gets its own director
//                 DSP (tempo within ±4 %, varispeed for the persona classes, gain), not confident → proportional cuts
//                 for highlighting only, no per-line DSP;
//    7. edges     equal-power fades where a cut sits in silence; a non-verbal from the voice's pack spliced in front
//                 of a line that asks for one; the director's silence before a sound effect;
//    8. time      the context pause after the unit and, when the lung budget says so, a breath inside it (never adding
//                 time).
//  Deterministic for the same input. One instance per session (the breath planner and the rate leveler count across
//  units).
//

import Foundation

extension PCM {
    /// Equal-power (sine) fades over `seconds` at both ends, in place.
    public static func applyEqualPowerFades(_ x: inout [Float], sampleRate: Int, seconds: Double) {
        applyEqualPowerFades(&x, sampleRate: sampleRate, seconds: seconds, start: true, end: true)
    }

    public static func applyEqualPowerFades(_ x: inout [Float], sampleRate: Int, seconds: Double, start: Bool, end: Bool) {
        let n = x.count
        guard n > 2, seconds > 0 else { return }
        let f = min(n / 2, max(1, Int(seconds * Double(sampleRate))))
        for i in 0..<f {
            let g = Float(sin(Double.pi / 2 * Double(i) / Double(f)))
            if start { x[i] *= g }
            if end { x[n - 1 - i] *= g }
        }
    }

    /// Trim leading/trailing audio quieter than `topDB` under the peak (keeping the usual margins).
    public static func trimRelative(_ x: [Float], sampleRate: Int, topDB: Double = 40) -> [Float] {
        let peak = PCM.peak(x)
        guard peak > 0 else { return [] }
        return trimSilence(x, sampleRate: sampleRate, threshold: max(0.0005, peak * Float(pow(10, -topDB / 20))))
    }

    /// The model's calls for one text (split at `ends`), each trimmed and faded, joined with `gap` of silence.
    public static func joinChunks(_ x: [Float], ends: [Int], sampleRate: Int, fade: Double, gap: Double) -> [Float] {
        var pieces: [[Float]] = []
        var start = 0
        for end in ends.sorted() + [x.count] where end > start && end <= x.count {
            pieces.append(Array(x[start..<end]))
            start = end
        }
        if pieces.isEmpty { pieces = [x] }
        var out: [Float] = []
        for p in pieces {
            var t = trimRelative(p, sampleRate: sampleRate)
            guard !t.isEmpty else { continue }
            applyEqualPowerFades(&t, sampleRate: sampleRate, seconds: fade)
            if !out.isEmpty { out.append(contentsOf: repeatElement(Float(0), count: silenceFrames(seconds: gap, sampleRate: sampleRate))) }
            out.append(contentsOf: t)
        }
        return out
    }
}

public struct NaturalFinish: Sendable {
    /// One sentence of a unit.
    public struct Line: Sendable {
        /// The director's parameters (nil: a fallback voice's sentence: no per-line DSP).
        public var params: DeliveryParams?
        /// Letters of the text read (positions inside the unit; the alignment).
        public var letters: Int
        /// Silence after the line, seconds (already for the listener's speed). Used after the unit's last line; inside
        /// a chunk the model's own pause stays.
        public var pause: Double
        public var breath: BreathPoint?
        public var seed: UInt64
        /// A LitRPG system message: the interface chime before it and/or the interface tone on it (SystemMessageSound).
        public var systemChime: Bool
        public var systemTone: Bool

        public init(params: DeliveryParams?, letters: Int, pause: Double, breath: BreathPoint? = nil, seed: UInt64 = 0,
                    systemChime: Bool = false, systemTone: Bool = false) {
            self.params = params
            self.letters = max(1, letters)
            self.pause = pause
            self.breath = breath
            self.seed = seed
            self.systemChime = systemChime
            self.systemTone = systemTone
        }
    }

    public struct Unit: Sendable {
        public var samples: [Float]
        /// Ends of the model's calls (sample indices) when one text came in several.
        public var chunkEnds: [Int]
        public var lines: [Line]
        /// The listener's speed, applied here (Kokoro applies it itself: pass 1).
        public var speed: Double
        /// Rendered by the expressive engine: rate leveling, gap cleanup and the director's DSP apply. False for a
        /// fallback voice's sentence (only the sound chain, pause and breath, so levels still match).
        public var expressive: Bool
        /// A non-verbal to splice in front of a line (by index).
        public var nonVerbals: [Int: NonVerbalPack.Item]
        /// Nephis's flow engine: the samples are one continuous stream that already holds the pause before the unit
        /// and every join; nothing is trimmed, faded, padded, re-leveled or spliced (`renderFlow`).
        public var flow = false

        public init(samples: [Float], chunkEnds: [Int] = [], lines: [Line], speed: Double = 1, expressive: Bool, nonVerbals: [Int: NonVerbalPack.Item] = [:]) {
            self.samples = samples
            self.chunkEnds = chunkEnds
            self.lines = lines
            self.speed = speed
            self.expressive = expressive
            self.nonVerbals = nonVerbals
        }
    }

    public struct Piece: Sendable {
        public var frames: [Float]
        /// Seconds of speech in it (before any added silence).
        public var speechSeconds: Double
    }

    public struct Report: Sendable, Equatable {
        /// The sentence boundaries came from real pauses.
        public var confident = true
        /// The rate leveling's tempo for the unit.
        public var leveling = 1.0
        public var microGapsClosed = 0
        public var ellipsesPadded = 0
        public var breathPlaced = false
    }

    /// −1 dBFS.
    public static let peakCeiling: Float = 0.891
    /// Silence between the model calls of one text.
    public static let callGap = 0.08

    public let sampleRate: Int
    public let audio: DeliveryAudio
    public let studio: StudioSoundParams
    public let breaths: (any BreathSource)?
    public private(set) var planner: BreathPlanner
    public private(set) var leveler: RateLeveler
    private var random: SeededRandom
    /// For the Voice Lab.
    public private(set) var breathsPlaced = 0
    public private(set) var breathsSkipped = 0
    public private(set) var lastReport = Report()

    /// The expressive engine's own tonal correction (VoiceTilt.pocketTts), before the shared chain.
    public var tilt: VoiceTilt?
    /// The voice exactly as approved on the PC (Nephis): the start-up sound before each call's first word turned
    /// down (StartupSound), her own EQ (`tilt`), loudness matching; no polish EQ, no Studio chain.
    public let plain: Bool
    public private(set) var startupSoftened = 0.0

    public init(audio: DeliveryAudio, studioSound: Bool, breaths: (any BreathSource)?, sampleRate: Int = 24_000, seed: UInt64 = 1,
                tilt: VoiceTilt? = nil, plain: Bool = false) {
        self.tilt = tilt
        self.plain = plain
        self.sampleRate = sampleRate
        self.audio = audio
        var chain = studioSound && !plain ? StudioSoundParams.cleanWarm : StudioSoundParams.levelOnly
        chain.level?.speechRmsDB = audio.speechRmsDB
        studio = chain
        self.breaths = breaths
        planner = BreathPlanner(audio: audio, seed: seed)
        leveler = RateLeveler(window: audio.rateWindow, band: audio.rateBand, cap: audio.rateCap)
        random = SeededRandom(seed: seed ^ 0x5EED)
    }

    /// One buffer per line of the unit.
    public mutating func render(_ u: Unit) -> [Piece] {
        if u.flow { return renderFlow(u) }
        var report = Report()
        let lines = u.lines.isEmpty ? [Line(params: nil, letters: 1, pause: 0)] : u.lines
        let speed = u.speed.isFinite && u.speed > 0 ? u.speed : 1
        let totalLetters = lines.reduce(0) { $0 + $1.letters }
        // Letter positions inside the unit: sentence ends, punctuation, dramatic ellipses.
        var ends: [Double] = []
        var punctuation: [Double] = []
        var ellipses: [Double] = []
        var before = 0
        for (k, line) in lines.enumerated() {
            let base = Double(before) / Double(totalLetters)
            let span = Double(line.letters) / Double(totalLetters)
            punctuation += (line.params?.punctuation ?? []).map { base + $0 * span }
            ellipses += (line.params?.ellipses ?? []).map { base + $0 * span }
            before += line.letters
            if k < lines.count - 1 {
                ends.append(Double(before) / Double(totalLetters))
                punctuation.append(Double(before) / Double(totalLetters))
            }
        }

        var raw = u.samples
        if plain, u.expressive {
            StartupSound.removeThump(&raw, sampleRate: sampleRate)
            startupSoftened += StartupSound.softenCalls(&raw, callStarts: u.chunkEnds, sampleRate: sampleRate)
        }
        var speech = PCM.joinChunks(raw, ends: u.chunkEnds, sampleRate: sampleRate, fade: audio.crossfade, gap: Self.callGap)
        if u.expressive, !speech.isEmpty {
            SpeechShape.dropBlips(&speech, sampleRate: sampleRate, blip: audio.blip)
            report.microGapsClosed = SpeechShape.closeMicroGaps(&speech, sampleRate: sampleRate, microGap: audio.microGap, punctuation: punctuation, letters: totalLetters)
            let syllables = lines.reduce(0) { $0 + ($1.params?.syllables ?? 0) }
            report.leveling = leveler.tempo(syllables: syllables, voicedSeconds: SpeechActivity(speech, sampleRate: sampleRate).voicedSeconds)
        }
        let tempo = report.leveling * (u.expressive ? speed : 1)
        if abs(tempo - 1) > 0.002 { speech = TimeStretch.wsola(speech, tempo: tempo, sampleRate: sampleRate) }
        if u.expressive, !ellipses.isEmpty {
            let target = random.uniform(audio.ellipsisPause) / speed
            report.ellipsesPadded = SpeechShape.padEllipses(&speech, sampleRate: sampleRate, ellipses: ellipses, target: target)
        }
        if !speech.isEmpty {
            if u.expressive, studio.fizz != nil || plain, let tilt { tilt.apply(&speech, sampleRate: sampleRate) }
            if !plain { NarrationPolish.equalize(&speech, sampleRate: sampleRate) }
            StudioSound.process(&speech, params: studio, sampleRate: sampleRate)
        }

        // Where the sentences are.
        let timing = lines.count > 1 ? ChunkAligner.align(speech, sampleRate: sampleRate, ends: ends) : ChunkTiming(cuts: [], confident: true)
        report.confident = timing.confident
        var bounds = [0] + timing.cuts + [speech.count]
        for k in 1..<bounds.count { bounds[k] = max(bounds[k], bounds[k - 1]) }
        let perLine = u.expressive && timing.confident

        var pieces: [Piece] = []
        for (k, line) in lines.enumerated() {
            var p = Array(speech[bounds[k]..<bounds[k + 1]])
            let seconds = Double(p.count) / Double(sampleRate)
            if perLine, let params = line.params {
                // The director's own controls for this line: tempo (pitch kept, ±4 % at most) then varispeed for the
                // persona's classes (pitch and pace together), then its gain.
                if abs(params.tempo - 1) > 0.002 { p = TimeStretch.wsola(p, tempo: min(1.04, max(0.96, params.tempo)), sampleRate: sampleRate) }
                if abs(params.cents) >= 0.5 { p = TimeStretch.resample(p, ratio: pow(2, params.cents / 1200)) }
                if params.gainDB != 0 {
                    let g = Float(pow(10, params.gainDB / 20))
                    for i in p.indices { p[i] *= g }
                }
            }
            let peak = PCM.peak(p)
            if peak > Self.peakCeiling { for i in p.indices { p[i] *= Self.peakCeiling / peak } }
            // Fades where the piece meets silence: the unit's own edges always; inner cuts only when they sit in a pause.
            PCM.applyEqualPowerFades(&p, sampleRate: sampleRate, seconds: audio.fade, start: k == 0 || timing.confident, end: k == lines.count - 1 || timing.confident)
            if line.systemChime || line.systemTone {
                p = SystemMessageSound.apply(p, sampleRate: sampleRate, chime: line.systemChime, tone: line.systemTone)
            }
            if let nv = u.nonVerbals[k], perLine || k == 0 {
                p = NonVerbalSplice.splice(nv, before: p, sampleRate: sampleRate, gap: random.uniform(audio.nonVerbalGap) / speed, fade: audio.nonVerbalFade,
                                           relativeDB: audio.nonVerbalDB)
            }
            if let pre = line.params?.preSeconds, pre > 0, perLine || k == 0 {
                p = [Float](repeating: 0, count: PCM.silenceFrames(seconds: pre / speed, sampleRate: sampleRate)) + p
            }
            pieces.append(Piece(frames: p, speechSeconds: seconds))
        }

        // The pause after the unit, maybe with a breath in it.
        if let last = lines.last, !pieces.isEmpty {
            let k = pieces.count - 1
            let pauseStart = pieces[k].frames.count
            pieces[k].frames.append(contentsOf: repeatElement(Float(0), count: PCM.silenceFrames(seconds: last.pause, sampleRate: sampleRate)))
            if let source = breaths {
                let speechSeconds = pieces.reduce(0) { $0 + $1.speechSeconds }
                if let place = planner.plan(speech: speechSeconds, pause: last.pause, point: last.breath, natural: source.naturalLength(seed: last.seed)) {
                    let breath = source.breath(seconds: place.length, seed: last.seed, sampleRate: sampleRate)
                    let level = StudioSound.speechRMS(speech, sampleRate: sampleRate) * Float(pow(10, audio.breathDB / 20))
                    let at = pauseStart + Int(place.start * Double(sampleRate))
                    for i in breath.indices where at + i < pieces[k].frames.count { pieces[k].frames[at + i] += breath[i] * level }
                    breathsPlaced += 1
                    report.breathPlaced = true
                } else if last.breath != nil {
                    breathsSkipped += 1
                }
            }
        }
        lastReport = report
        return pieces
    }

    /// Fixed gain for the flow stream: one gain for the whole read (never per unit, which would step the level at
    /// every join). Pocket TTS's speech sits near -22.5 dBFS and Nephis's EQ lifts it about 1.5 dB.
    public static let flowGainDB = 0.0
    /// Above this the flow stream is softly limited (never hard-clipped: that crackles), reaching at most `peakCeiling`.
    public static let flowKnee: Float = 0.75

    /// Nephis's continuous stream: the thump filter and her EQ, one fixed gain, the listener's speed, then the cut
    /// into sentences for highlighting only. No trims, fades, pauses, breaths, non-verbals or per-line DSP: the
    /// engine made the pauses and joins, and any of those would put a seam back.
    mutating func renderFlow(_ u: Unit) -> [Piece] {
        var report = Report()
        let lines = u.lines.isEmpty ? [Line(params: nil, letters: 1, pause: 0)] : u.lines
        var speech = u.samples
        guard !speech.isEmpty else { lastReport = report; return lines.map { _ in Piece(frames: [], speechSeconds: 0) } }
        StartupSound.removeThump(&speech, sampleRate: sampleRate)
        tilt?.apply(&speech, sampleRate: sampleRate)
        let g = Float(pow(10, Self.flowGainDB / 20))
        let room = Self.peakCeiling - Self.flowKnee
        for i in speech.indices {
            let v = speech[i] * g
            let a = abs(v)
            speech[i] = a <= Self.flowKnee ? v : (v < 0 ? -1 : 1) * (Self.flowKnee + room * Float(tanh(Double((a - Self.flowKnee) / room))))
        }
        let speed = u.speed.isFinite && u.speed > 0 ? u.speed : 1
        if abs(speed - 1) > 0.002 { speech = TimeStretch.wsola(speech, tempo: speed, sampleRate: sampleRate) }
        let total = lines.reduce(0) { $0 + $1.letters }
        var ends: [Double] = []
        var before = 0
        for line in lines.dropLast() {
            before += line.letters
            ends.append(Double(before) / Double(total))
        }
        let timing = lines.count > 1 ? ChunkAligner.align(speech, sampleRate: sampleRate, ends: ends) : ChunkTiming(cuts: [], confident: true)
        report.confident = timing.confident
        var bounds = [0] + timing.cuts + [speech.count]
        for k in 1..<bounds.count { bounds[k] = max(bounds[k], bounds[k - 1]) }
        lastReport = report
        return lines.indices.map { k in
            let p = Array(speech[bounds[k]..<bounds[k + 1]])
            return Piece(frames: p, speechSeconds: Double(p.count) / Double(sampleRate))
        }
    }

    /// A jump or a new chapter: the lung budget starts again.
    public mutating func resetBreathing() {
        planner.reset()
    }
}
