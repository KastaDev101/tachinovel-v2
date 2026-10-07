//
//  Polish.swift — narrator mode's audio polish for synthesized sentences, before they are scheduled:
//    trim → EQ (rumble cut, a little warmth and presence, softer "s") → gentle compression → loudness toward
//    −16 LUFS (ITU-R BS.1770 gated loudness over the chapter so far, not per sentence, so quiet lines stay
//    quiet) → peaks ≤ −1 dBFS → fades → the pause, as digital silence or a faint room tone.
//  Pure Swift on sample arrays, so the live engine, Prepare for the drive and the CI check (kokoro-check:
//  ASR and UTMOS on polished audio) run the same code. Deterministic: the same sentences give the same audio.
//

import Foundation

/// One second-order IIR section (transposed direct form II).
public struct Biquad: Sendable, Equatable {
    public let b0: Double
    public let b1: Double
    public let b2: Double
    public let a1: Double
    public let a2: Double
    private var z1 = 0.0
    private var z2 = 0.0

    public init(b0: Double, b1: Double, b2: Double, a1: Double, a2: Double) {
        self.b0 = b0
        self.b1 = b1
        self.b2 = b2
        self.a1 = a1
        self.a2 = a2
    }

    public mutating func process(_ x: Double) -> Double {
        let y = b0 * x + z1
        z1 = b1 * x - a1 * y + z2
        z2 = b2 * x - a2 * y
        return y
    }

    public mutating func process(_ samples: inout [Float]) {
        for i in samples.indices { samples[i] = Float(process(Double(samples[i]))) }
    }

    private static func normalized(_ b0: Double, _ b1: Double, _ b2: Double, _ a0: Double, _ a1: Double, _ a2: Double) -> Biquad {
        Biquad(b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0)
    }

    /// RBJ cookbook high-pass.
    public static func highPass(frequency f: Double, q: Double, sampleRate fs: Double) -> Biquad {
        let w = 2 * Double.pi * f / fs
        let alpha = sin(w) / (2 * q)
        let c = cos(w)
        return normalized((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha)
    }

    /// RBJ cookbook peaking EQ.
    public static func peaking(frequency f: Double, q: Double, gainDB: Double, sampleRate fs: Double) -> Biquad {
        let a = pow(10, gainDB / 40)
        let w = 2 * Double.pi * f / fs
        let alpha = sin(w) / (2 * q)
        let c = cos(w)
        return normalized(1 + alpha * a, -2 * c, 1 - alpha * a, 1 + alpha / a, -2 * c, 1 - alpha / a)
    }

    /// BS.1770 K-weighting, stage 1 (head-related high shelf), for any sample rate (libebur128's formulas).
    public static func kShelf(sampleRate fs: Double) -> Biquad {
        let f0 = 1681.974450955533, g = 3.999843853973347, q = 0.7071752369554196
        let k = tan(Double.pi * f0 / fs)
        let vh = pow(10, g / 20)
        let vb = pow(vh, 0.4996667741545416)
        let a0 = 1 + k / q + k * k
        return Biquad(b0: (vh + vb * k / q + k * k) / a0, b1: 2 * (k * k - vh) / a0, b2: (vh - vb * k / q + k * k) / a0,
                      a1: 2 * (k * k - 1) / a0, a2: (1 - k / q + k * k) / a0)
    }

    /// BS.1770 K-weighting, stage 2 (RLB high-pass).
    public static func kHighPass(sampleRate fs: Double) -> Biquad {
        let f0 = 38.13547087602444, q = 0.5003270373238773
        let k = tan(Double.pi * f0 / fs)
        let a0 = 1 + k / q + k * k
        return Biquad(b0: 1, b1: -2, b2: 1, a1: 2 * (k * k - 1) / a0, a2: (1 - k / q + k * k) / a0)
    }
}

/// ITU-R BS.1770-4 integrated loudness (mono): K-weighting, 400 ms blocks every 100 ms, the −70 LUFS
/// absolute gate and the −10 LU relative gate.
public struct LoudnessMeter: Sendable {
    public let sampleRate: Int
    private var shelf: Biquad
    private var highPass: Biquad
    /// Sum of squares of the current 100 ms step, and how many samples it has.
    private var stepSum = 0.0
    private var stepCount = 0
    /// The last four steps (a 400 ms block).
    private var recent: [Double] = []
    /// Mean square of every block so far (capped at about an hour).
    private var blocks: [Double] = []
    private static let maxBlocks = 36_000

    public init(sampleRate: Int) {
        self.sampleRate = sampleRate
        shelf = Biquad.kShelf(sampleRate: Double(sampleRate))
        highPass = Biquad.kHighPass(sampleRate: Double(sampleRate))
    }

    private var stepLength: Int { max(1, sampleRate / 10) }

    public mutating func add(_ samples: [Float]) {
        let n = stepLength
        for s in samples {
            let y = highPass.process(shelf.process(Double(s)))
            stepSum += y * y
            stepCount += 1
            if stepCount == n {
                recent.append(stepSum)
                if recent.count > 4 { recent.removeFirst() }
                if recent.count == 4 {
                    blocks.append(recent.reduce(0, +) / Double(4 * n))
                    if blocks.count > Self.maxBlocks { blocks.removeFirst(blocks.count - Self.maxBlocks) }
                }
                stepSum = 0
                stepCount = 0
            }
        }
    }

    static func lufs(_ meanSquare: Double) -> Double { -0.691 + 10 * log10(max(meanSquare, 1e-20)) }

    /// Gated integrated loudness so far, nil until one block is above −70 LUFS.
    public var integrated: Double? {
        let loud = blocks.filter { Self.lufs($0) > -70 }
        guard !loud.isEmpty else { return nil }
        let relative = Self.lufs(loud.reduce(0, +) / Double(loud.count)) - 10
        let gated = loud.filter { Self.lufs($0) > relative }
        guard !gated.isEmpty else { return nil }
        return Self.lufs(gated.reduce(0, +) / Double(gated.count))
    }

    /// One-shot integrated loudness of a signal.
    public static func integrated(_ samples: [Float], sampleRate: Int) -> Double? {
        var m = LoudnessMeter(sampleRate: sampleRate)
        m.add(samples)
        return m.integrated
    }
}

/// Gentle feed-forward compressor with an RMS detector and a soft knee.
public struct Compressor: Sendable, Equatable {
    public var thresholdDB: Double
    public var ratio: Double
    public var kneeDB: Double
    public var attack: TimeInterval
    public var release: TimeInterval
    private var power = 0.0

    public init(thresholdDB: Double = -18, ratio: Double = 2, kneeDB: Double = 6, attack: TimeInterval = 0.01, release: TimeInterval = 0.12) {
        self.thresholdDB = thresholdDB
        self.ratio = ratio
        self.kneeDB = kneeDB
        self.attack = attack
        self.release = release
    }

    /// Gain reduction in dB for a detector level.
    public func reduction(levelDB: Double) -> Double {
        let over = levelDB - thresholdDB
        let slope = 1 - 1 / ratio
        if over <= -kneeDB / 2 { return 0 }
        if over >= kneeDB / 2 { return over * slope }
        let x = over + kneeDB / 2
        return slope * x * x / (2 * kneeDB)
    }

    public mutating func process(_ samples: inout [Float], sampleRate: Int) {
        let fs = Double(sampleRate)
        let up = exp(-1 / (attack * fs))
        let down = exp(-1 / (release * fs))
        for i in samples.indices {
            let x = Double(samples[i])
            let p = x * x
            let coef = p > power ? up : down
            power = coef * power + (1 - coef) * p
            let gr = reduction(levelDB: 10 * log10(max(power, 1e-12)))
            if gr > 0 { samples[i] = Float(x * pow(10, -gr / 20)) }
        }
    }
}

/// A faint, steady room tone: a pink-noise loop (Paul Kellet's filter on xorshift white noise, fixed seed),
/// normalized to `levelDB` RMS.
public struct RoomTone: Sendable {
    public static let defaultLevelDB = -58.0
    private let loop: [Float]
    private var position = 0

    public init(sampleRate: Int, levelDB: Double = RoomTone.defaultLevelDB, seconds: Double = 4, seed: UInt32 = 0x9E37_79B9) {
        var state = seed == 0 ? 1 : seed
        var b0 = 0.0, b1 = 0.0, b2 = 0.0
        let n = max(1, Int(Double(sampleRate) * seconds))
        var raw = [Double](repeating: 0, count: n)
        for i in 0..<n {
            state ^= state << 13
            state ^= state >> 17
            state ^= state << 5
            let white = Double(state) / Double(UInt32.max) * 2 - 1
            b0 = 0.99765 * b0 + white * 0.0990460
            b1 = 0.96300 * b1 + white * 0.2965164
            b2 = 0.57000 * b2 + white * 1.0526913
            raw[i] = b0 + b1 + b2 + white * 0.1848
        }
        let mean = raw.reduce(0, +) / Double(n)
        let rms = (raw.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(n)).squareRoot()
        let scale = rms > 0 ? pow(10, levelDB / 20) / rms : 0
        loop = raw.map { Float(($0 - mean) * scale) }
    }

    public mutating func next() -> Float {
        let v = loop[position]
        position = (position + 1) % loop.count
        return v
    }
}

/// Narrator mode's chain for one chapter (keep one instance per chapter: the loudness is measured over it).
public struct NarrationPolish: Sendable {
    public static let targetLUFS = -16.0
    /// −1 dBFS.
    public static let peakCeiling: Float = 0.891
    public let sampleRate: Int
    public let roomTone: Bool
    /// The compressor's ratio (1 or less: no compressor).
    public let compressorRatio: Double
    private var meter: LoudnessMeter
    private var tone: RoomTone?
    private var gainDB: Double?

    public init(sampleRate: Int, roomTone: Bool, compressorRatio: Double = 1.5) {
        self.sampleRate = sampleRate
        self.roomTone = roomTone
        self.compressorRatio = compressorRatio
        meter = LoudnessMeter(sampleRate: sampleRate)
        tone = roomTone ? RoomTone(sampleRate: sampleRate) : nil
    }

    /// Rumble cut at 70 Hz, +1.5 dB warmth at 180 Hz, +2 dB presence at 3.2 kHz, −2.5 dB at 7 kHz (softer
    /// sibilants). Fresh filters per sentence (each starts after silence).
    public static func equalize(_ samples: inout [Float], sampleRate: Int) {
        let fs = Double(sampleRate)
        var stages = [
            Biquad.highPass(frequency: 70, q: 0.707, sampleRate: fs),
            Biquad.peaking(frequency: 180, q: 0.8, gainDB: 1.5, sampleRate: fs),
            Biquad.peaking(frequency: 3200, q: 1.0, gainDB: 2, sampleRate: fs),
        ]
        if fs / 2 > 7000 * 1.2 { stages.append(Biquad.peaking(frequency: 7000, q: 2, gainDB: -2.5, sampleRate: fs)) }
        for i in stages.indices { stages[i].process(&samples) }
    }

    /// The current loudness gain in dB (nil before the first sentence).
    public var currentGainDB: Double? { gainDB }

    /// Replaces PCM.prepareSentence when polish is on. Returns the frames to schedule.
    public mutating func prepareSentence(_ samples: [Float], pause: TimeInterval) -> [Float] {
        var out = PCM.trimSilence(samples, sampleRate: sampleRate)
        if !out.isEmpty {
            Self.equalize(&out, sampleRate: sampleRate)
            if compressorRatio > 1 {
                var comp = Compressor(ratio: compressorRatio)
                comp.process(&out, sampleRate: sampleRate)
            }
            meter.add(out)
            let measured = meter.integrated ?? LoudnessMeter.integrated(out, sampleRate: sampleRate)
            if let measured {
                let desired = min(15, max(-12, Self.targetLUFS - measured))
                gainDB = gainDB.map { $0 + 0.35 * (desired - $0) } ?? desired
            }
            var g = Float(pow(10, (gainDB ?? 0) / 20))
            let peak = PCM.peak(out)
            if peak * g > Self.peakCeiling { g = Self.peakCeiling / max(peak, 1e-9) }
            if g != 1 { for i in out.indices { out[i] *= g } }
            PCM.applyFades(&out, sampleRate: sampleRate)
        }
        let silence = PCM.silenceFrames(seconds: pause, sampleRate: sampleRate)
        if silence > 0 { out.append(contentsOf: repeatElement(Float(0), count: silence)) }
        if var t = tone {
            for i in out.indices { out[i] += t.next() }
            tone = t
        }
        return out
    }
}

extension PCM {
    /// The parts of one sentence read by different voices, joined: each trimmed and faded, with `gap` of
    /// silence between them.
    public static func joinParts(_ parts: [[Float]], sampleRate: Int, gap: TimeInterval) -> [Float] {
        joinParts(parts, sampleRate: sampleRate, gaps: Array(repeating: gap, count: parts.count))
    }

    /// As above, with the silence after each part (`gaps[i]` follows part i; none after the last).
    public static func joinParts(_ parts: [[Float]], sampleRate: Int, gaps: [TimeInterval]) -> [Float] {
        var out: [Float] = []
        var pending = 0
        for (i, part) in parts.enumerated() {
            var p = trimSilence(part, sampleRate: sampleRate)
            guard !p.isEmpty else { continue }
            applyFades(&p, sampleRate: sampleRate)
            if !out.isEmpty, pending > 0 { out.append(contentsOf: repeatElement(Float(0), count: pending)) }
            out.append(contentsOf: p)
            pending = silenceFrames(seconds: i < gaps.count ? gaps[i] : 0, sampleRate: sampleRate)
        }
        return out
    }
}
