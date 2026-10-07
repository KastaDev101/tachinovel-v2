//
//  StudioSound.swift — the "clean-warm" chain Kasta picked in round 8 (round8.json approvedSpec.chain.cleanWarm;
//  room and saturation were rejected: "sounds like a room"). Clean and dry, per sentence, before scheduling:
//    level      speech RMS to −20 dBFS (RMS of 20 ms frames within 35 dB of the loudest frame), every sentence,
//               so there are no level jumps between sentences;
//    high-pass  65 Hz, Q 0.707;
//    warmth     low shelf 180 Hz +1.75 dB, Q 0.707;
//    presence   peak 2.5 kHz +1.5 dB, Q 1;
//    fizz       voiced-only dynamic cut of the 4.5–9 kHz band (the vocoder's fizz on vowels) up to −3.5 dB, driven by
//               the 100–1000 Hz band against the full band (−2 dB: full cut, −6 dB: none; 5 ms / 80 ms), so
//               fricatives keep their highs;
//    de-esser   split at 5.5 kHz, threshold −30 dB, 2.5:1, at most 4 dB (2 ms / 60 ms);
//    expander   below −50 dBFS 1:1.5, at most 6 dB (2 ms / 80 ms), for Nano's low-level hiss between words.
//  Every stage can be switched off (nil). Biquads from the RBJ cookbook (as AVAudioUnitEQ's bands); envelopes are
//  one-pole power followers with separate attack and release, in dB. Pure Swift on sample arrays, deterministic.
//

import Foundation

public struct StudioSoundParams: Sendable, Equatable {
    public struct Level: Sendable, Equatable {
        public var speechRmsDB = -20.0
        /// Frames within this many dB of the loudest one count as speech.
        public var withinDB = 35.0
        /// Gain limits, dB.
        public var maxBoostDB = 18.0
        public var maxCutDB = 18.0

        public init(speechRmsDB: Double = -20) {
            self.speechRmsDB = speechRmsDB
        }
    }

    public struct Band: Sendable, Equatable {
        public var frequency: Double
        public var gainDB: Double
        public var q: Double

        public init(frequency: Double, gainDB: Double = 0, q: Double = 0.707) {
            self.frequency = frequency
            self.gainDB = gainDB
            self.q = q
        }
    }

    public struct Fizz: Sendable, Equatable {
        public var bandHighpass = 4_500.0
        public var bandLowpass = 9_000.0
        public var q = 0.707
        public var cutDB = 3.5
        public var voicingLow = 100.0
        public var voicingHigh = 1_000.0
        public var voicingFullDB = -2.0
        public var voicingNoneDB = -6.0
        public var attack = 0.005
        public var release = 0.08

        public init() {}
    }

    public struct DeEsser: Sendable, Equatable {
        public var split = 5_500.0
        public var thresholdDB = -30.0
        public var ratio = 2.5
        public var maxReductionDB = 4.0
        public var attack = 0.002
        public var release = 0.06

        public init() {}
    }

    public struct Expander: Sendable, Equatable {
        public var thresholdDB = -50.0
        public var ratio = 1.5
        public var maxReductionDB = 6.0
        public var attack = 0.002
        public var release = 0.08

        public init() {}
    }

    public var level: Level?
    public var highpass: Band?
    public var warmth: Band?
    public var presence: Band?
    public var fizz: Fizz?
    public var deess: DeEsser?
    public var expander: Expander?

    public init(level: Level? = Level(), highpass: Band? = Band(frequency: 65), warmth: Band? = Band(frequency: 180, gainDB: 1.75),
                presence: Band? = Band(frequency: 2_500, gainDB: 1.5, q: 1), fizz: Fizz? = Fizz(), deess: DeEsser? = DeEsser(),
                expander: Expander? = Expander()) {
        self.level = level
        self.highpass = highpass
        self.warmth = warmth
        self.presence = presence
        self.fizz = fizz
        self.deess = deess
        self.expander = expander
    }

    /// Kasta's pick, the default.
    public static let cleanWarm = StudioSoundParams()
    /// The same without the warmth shelf.
    public static let clean = StudioSoundParams(warmth: nil)
    /// Only per-sentence loudness matching (Studio sound off).
    public static let levelOnly = StudioSoundParams(highpass: nil, warmth: nil, presence: nil, fizz: nil, deess: nil, expander: nil)
    /// Nothing at all.
    public static let bypass = StudioSoundParams(level: nil, highpass: nil, warmth: nil, presence: nil, fizz: nil, deess: nil, expander: nil)
}

extension Biquad {
    /// RBJ cookbook low-pass.
    public static func lowPass(frequency f: Double, q: Double, sampleRate fs: Double) -> Biquad {
        let w = 2 * Double.pi * min(f, fs * 0.49) / fs
        let alpha = sin(w) / (2 * q)
        let c = cos(w)
        let a0 = 1 + alpha
        return Biquad(b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - alpha) / a0)
    }

    /// RBJ cookbook low shelf (slope from Q, as AVAudioUnitEQ).
    public static func lowShelf(frequency f: Double, q: Double, gainDB: Double, sampleRate fs: Double) -> Biquad {
        let a = pow(10, gainDB / 40)
        let w = 2 * Double.pi * f / fs
        let c = cos(w)
        let alpha = sin(w) / (2 * q)
        let s = 2 * a.squareRoot() * alpha
        let a0 = (a + 1) + (a - 1) * c + s
        return Biquad(b0: a * ((a + 1) - (a - 1) * c + s) / a0, b1: 2 * a * ((a - 1) - (a + 1) * c) / a0, b2: a * ((a + 1) - (a - 1) * c - s) / a0,
                      a1: -2 * ((a - 1) + (a + 1) * c) / a0, a2: ((a + 1) + (a - 1) * c - s) / a0)
    }
}

/// One-pole power follower (separate attack and release), in dB.
struct EnvelopeFollower {
    private let up: Double
    private let down: Double
    private var state = 0.0

    init(attack: Double, release: Double, sampleRate: Int) {
        let fs = Double(sampleRate)
        up = exp(-1 / (max(1e-4, attack) * fs))
        down = exp(-1 / (max(1e-4, release) * fs))
    }

    /// Feed one sample, get the level in dB.
    mutating func level(_ x: Double) -> Double {
        let p = x * x
        let k = p > state ? up : down
        state = k * state + (1 - k) * p
        return 10 * log10(max(state, 1e-12))
    }

    /// Feed one sample, get the smoothed power.
    mutating func power(_ x: Double) -> Double {
        let p = x * x
        let k = p > state ? up : down
        state = k * state + (1 - k) * p
        return state
    }
}

public enum StudioSound {
    /// RMS of the 20 ms frames within `withinDB` of the loudest frame (the speech, not the gaps); 0 for silence.
    public static func speechRMS(_ x: [Float], sampleRate: Int, withinDB: Double = 35) -> Float {
        let n = max(1, sampleRate / 50)
        var frames: [Double] = []
        var i = 0
        while i < x.count {
            let end = min(x.count, i + n)
            var acc = 0.0
            for k in i..<end { acc += Double(x[k]) * Double(x[k]) }
            frames.append(acc / Double(end - i))
            i = end
        }
        guard let loudest = frames.max(), loudest > 1e-12 else { return 0 }
        let floor = loudest * pow(10, -withinDB / 10)
        let speech = frames.filter { $0 >= floor }
        guard !speech.isEmpty else { return 0 }
        return Float((speech.reduce(0, +) / Double(speech.count)).squareRoot())
    }

    /// Bring a sentence's speech RMS to `targetDB` (per sentence: no level jumps between sentences).
    public static func matchLevel(_ x: inout [Float], sampleRate: Int, level: StudioSoundParams.Level) {
        let rms = speechRMS(x, sampleRate: sampleRate, withinDB: level.withinDB)
        guard rms > 1e-6 else { return }
        let gainDB = min(level.maxBoostDB, max(-level.maxCutDB, level.speechRmsDB - 20 * log10(Double(rms))))
        let g = Float(pow(10, gainDB / 20))
        for i in x.indices { x[i] *= g }
    }

    /// The whole chain, in place, for one sentence (speech only: trimmed, no pause yet).
    public static func process(_ x: inout [Float], params p: StudioSoundParams, sampleRate: Int) {
        guard !x.isEmpty else { return }
        let fs = Double(sampleRate)
        if let level = p.level { matchLevel(&x, sampleRate: sampleRate, level: level) }
        if let h = p.highpass { var f = Biquad.highPass(frequency: h.frequency, q: h.q, sampleRate: fs); f.process(&x) }
        if let w = p.warmth { var f = Biquad.lowShelf(frequency: w.frequency, q: w.q, gainDB: w.gainDB, sampleRate: fs); f.process(&x) }
        if let pr = p.presence { var f = Biquad.peaking(frequency: pr.frequency, q: pr.q, gainDB: pr.gainDB, sampleRate: fs); f.process(&x) }
        if let fz = p.fizz { fizz(&x, fz, sampleRate: sampleRate) }
        if let d = p.deess { deEss(&x, d, sampleRate: sampleRate) }
        if let e = p.expander { expand(&x, e, sampleRate: sampleRate) }
    }

    /// Voiced-only dynamic cut of the fizz band: y = x + (g − 1)·band, g from how voiced the signal is right now.
    static func fizz(_ x: inout [Float], _ p: StudioSoundParams.Fizz, sampleRate: Int) {
        let fs = Double(sampleRate)
        guard p.bandHighpass < fs / 2 else { return }
        var bandHP = Biquad.highPass(frequency: p.bandHighpass, q: p.q, sampleRate: fs)
        var bandLP = Biquad.lowPass(frequency: p.bandLowpass, q: p.q, sampleRate: fs)
        var voiceHP = Biquad.highPass(frequency: p.voicingLow, q: 0.707, sampleRate: fs)
        var voiceLP = Biquad.lowPass(frequency: p.voicingHigh, q: 0.707, sampleRate: fs)
        var envVoiced = EnvelopeFollower(attack: p.attack, release: p.release, sampleRate: sampleRate)
        var envFull = EnvelopeFollower(attack: p.attack, release: p.release, sampleRate: sampleRate)
        let span = p.voicingFullDB - p.voicingNoneDB
        for i in x.indices {
            let s = Double(x[i])
            let band = bandLP.process(bandHP.process(s))
            let voiced = envVoiced.power(voiceLP.process(voiceHP.process(s)))
            let full = envFull.power(s)
            guard full > 1e-10 else { continue }
            let voicingDB = 10 * log10(max(voiced, 1e-12) / full)
            let amount = span > 0 ? min(1, max(0, (voicingDB - p.voicingNoneDB) / span)) : 0
            guard amount > 0 else { continue }
            let g = pow(10, -p.cutDB * amount / 20)
            x[i] = Float(s + (g - 1) * band)
        }
    }

    /// Split-band de-esser: only the band above `split` is turned down while it is over the threshold.
    static func deEss(_ x: inout [Float], _ p: StudioSoundParams.DeEsser, sampleRate: Int) {
        let fs = Double(sampleRate)
        guard p.split < fs / 2 else { return }
        var hp = Biquad.highPass(frequency: p.split, q: 0.707, sampleRate: fs)
        var env = EnvelopeFollower(attack: p.attack, release: p.release, sampleRate: sampleRate)
        let slope = 1 - 1 / max(1, p.ratio)
        for i in x.indices {
            let s = Double(x[i])
            let high = hp.process(s)
            let over = env.level(high) - p.thresholdDB
            guard over > 0 else { continue }
            let reduction = min(p.maxReductionDB, over * slope)
            x[i] = Float(s + (pow(10, -reduction / 20) - 1) * high)
        }
    }

    /// Gentle downward expander below the threshold.
    static func expand(_ x: inout [Float], _ p: StudioSoundParams.Expander, sampleRate: Int) {
        var env = EnvelopeFollower(attack: p.attack, release: p.release, sampleRate: sampleRate)
        let slope = max(0, p.ratio - 1)
        for i in x.indices {
            let s = Double(x[i])
            let under = p.thresholdDB - env.level(s)
            guard under > 0 else { continue }
            let reduction = min(p.maxReductionDB, under * slope)
            x[i] = Float(s * pow(10, -reduction / 20))
        }
    }
}
