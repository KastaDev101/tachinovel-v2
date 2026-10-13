//
//  NephisMaster.swift — her mastering chain on the phone (Kasta, 2026-10-13: "even better audio quality, or at least
//  the SOUND of better audio quality").
//
//  The phone version of tachinovel-tts-lab finetune/wsl/master_chain.py (presets A-D), step for step the same as its
//  streaming twin master_stream.py (which the unit test's expected values come from). One chain runs over a whole
//  read, call after call, with every filter, envelope, tracker, gain and delay line carried from one call to the next:
//  no level jump, click or seam at a join. Off unless the pack asks (pack.json chain "master": {"preset": "clean"}).
//
//    tone       high-pass (Butterworth 4th order) and a fixed EQ per preset: six RBJ sections fitted to what the
//               PC chain's adaptive EQ did on three reads (max error 0.9-1.2 dB): fuller 300-600 Hz, darker 2-9 kHz;
//    de-esser   the 5-9 kHz band turned down only on this read's loudest S sounds (its own 90th percentile);
//    dynamics   pause quieting (3-4 dB on the decoder's noise between words, never on breaths), a slow leveler (±2 dB)
//               and a gentle compressor (2-2.5:1, at most 3.5-4 dB), plus parallel glue in "warm";
//    colour     "warm": tube-style saturation 30 dB under the voice; "crisp": an exciter 38 dB under it;
//    room tone  the app's digital-silence pads (NephisFlow.insertSilence) filled with noise shaped like our own quiet
//               floor, at the floor's level at the join, with 30 ms crossfades and a bed under the read: never cut
//               from her takes, never digital black;
//    loudness   -18 LUFS (BS.1770 gated loudness of the read so far: the first call with speech sets the gain, then it
//               moves at most 0.3 dB/s) and a true-peak limiter at -1 dBTP (4x interpolated detection, 1.5 ms
//               lookahead, 80 ms release; a sample never exceeds the ceiling).
//
//  Latency: 5 ms (pause quieting) + 40 ms (room tone) + 1.5 ms (limiter); the same for the whole read, so every call
//  keeps its length. Cost at 44.1 kHz: about 8 (minimal) to 21 (crisp) M operations per second of audio
//  (master_stream.py ops; 7-33 biquad sections, on vDSP).
//

import Foundation
#if canImport(Accelerate)
import Accelerate
#endif

public struct NephisMaster: Sendable {
    /// The PC chain's presets: A minimal (room tone, loudness, limiter), B clean broadcast, C warm ASMR, D crisp studio.
    public enum Preset: String, Codable, Sendable, CaseIterable {
        case minimal, clean, warm, crisp

        /// A preset by name, also the lab's letters and names ("B", "B_clean_broadcast"); nil for an unknown one.
        public init?(name: String) {
            let n = name.lowercased()
            if let p = Preset(rawValue: n) {
                self = p
                return
            }
            switch n {
            case "a", "a_minimal": self = .minimal
            case "b", "b_clean_broadcast": self = .clean
            case "c", "c_warm_asmr": self = .warm
            case "d", "d_crisp_studio": self = .crisp
            default: return nil
            }
        }
    }

    /// pack.json chain "master": {"preset": "clean"|"warm"|"crisp"|"minimal", "lufs": -18, "ceiling": -1,
    /// "roomTone": true}. Any field left out keeps its default; an unknown preset makes the whole block unreadable (off).
    public struct Settings: Codable, Sendable, Equatable {
        public var preset: Preset
        /// Loudness target (LUFS), -30...-12.
        public var lufs: Double
        /// True-peak ceiling (dBFS), -6...-0.1.
        public var ceilingDB: Double
        /// Fill the digital-silence pads (and lay the bed); false leaves them as they are.
        public var roomTone: Bool

        public init(preset: Preset = .clean, lufs: Double = -18, ceilingDB: Double = -1, roomTone: Bool = true) {
            self.preset = preset
            self.lufs = lufs
            self.ceilingDB = ceilingDB
            self.roomTone = roomTone
        }

        enum CodingKeys: String, CodingKey {
            case preset, lufs, ceiling, roomTone
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let name = try c.decodeIfPresent(String.self, forKey: .preset) ?? Preset.clean.rawValue
            guard let p = Preset(name: name) else {
                throw DecodingError.dataCorruptedError(forKey: .preset, in: c, debugDescription: "unknown mastering preset \(name)")
            }
            preset = p
            lufs = min(-12, max(-30, try c.decodeIfPresent(Double.self, forKey: .lufs) ?? -18))
            ceilingDB = min(-0.1, max(-6, try c.decodeIfPresent(Double.self, forKey: .ceiling) ?? -1))
            roomTone = try c.decodeIfPresent(Bool.self, forKey: .roomTone) ?? true
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(preset.rawValue, forKey: .preset)
            try c.encode(lufs, forKey: .lufs)
            try c.encode(ceilingDB, forKey: .ceiling)
            try c.encode(roomTone, forKey: .roomTone)
        }
    }

    public let settings: Settings
    public let sampleRate: Int
    /// Samples per control step (1 ms).
    let cr: Int
    private var phase = 0
    private var primed = false
    private var tone: MasterCascade
    private var stages: MasterStages
    private var loudness: MasterLoudness
    private var room: MasterRoom?
    private var limiter: MasterLimiter

    public init(settings: Settings, sampleRate: Int) {
        self.settings = settings
        self.sampleRate = sampleRate
        let fs = Double(self.sampleRate)
        cr = max(1, Int((fs / 1000).rounded()))
        let p = MasterParams.of(settings.preset)
        var sections: [MasterSection] = []
        if p.hpf > 0 { sections += MasterSection.butterworth4(.hp, p.hpf, fs: fs) }
        for (shape, g) in zip(MasterParams.eqShape, p.eq) where shape.hz < 0.45 * fs && g != 0 {
            sections.append(MasterSection(shape.kind, shape.hz, q: shape.q, db: g, fs: fs))
        }
        tone = MasterCascade(sections)
        let clock = MasterClock(fs: fs, cr: cr)
        stages = MasterStages(p, clock: clock, p90: MasterSeed.p90)
        loudness = MasterLoudness(clock: clock, target: settings.lufs)
        room = settings.roomTone ? MasterRoom(p.room, clock: clock) : nil
        limiter = MasterLimiter(clock: clock, ceilingDB: settings.ceilingDB)
    }

    /// Samples the output lags the input (fixed for the read).
    public var latency: Int {
        (stages.expand == nil ? 0 : 5 * cr) + (room?.delay ?? 0) + limiter.w + 3
    }

    /// The loudness gain now (dB), and what the limiter has taken off on average (dB).
    public var gainDB: Double { loudness.gain }
    public var limiterLossDB: Double { limiter.loss }

    /// Masters one call of the read, in place: same length, continuing exactly where the previous call stopped.
    public mutating func process(_ x: inout [Float]) {
        guard !x.isEmpty else { return }
        if !primed {
            // The first call sets the trackers' starting points from its own level (before any audio went through).
            if let p90 = Self.p90(of: x, sampleRate: sampleRate) {
                stages = MasterStages(MasterParams.of(settings.preset), clock: MasterClock(fs: Double(sampleRate), cr: cr), p90: p90)
                room?.seed(p90: p90)
            }
            primed = true
        }
        var y = tone.run(x)
        stages.run(&y, phase: phase, cr: cr)
        loudness.loss = limiter.loss
        let gain = loudness.measure(y, phase: phase, cr: cr)
        room?.run(&y, gainDB: gain, cr: cr)
        for i in y.indices { y[i] *= Float(pow(10, gain[i] / 20)) }
        limiter.run(&y)
        phase = (phase + x.count) % cr
        x = y
    }

    /// The read's mastering for one call, in call order. Settings nil = off: the samples are untouched and any chain
    /// is dropped. A fresh read (`restart`), another rate or other settings start a new chain. True when mastered.
    @discardableResult
    public static func apply(_ master: inout NephisMaster?, settings: Settings?, to samples: inout [Float], sampleRate: Int,
                             restart: Bool) -> Bool {
        guard let settings else {
            master = nil
            return false
        }
        if restart || master?.sampleRate != sampleRate || master?.settings != settings {
            master = NephisMaster(settings: settings, sampleRate: sampleRate)
        }
        master?.process(&samples)
        return true
    }

    /// The 90th percentile (linear interpolation) of the call's 10 ms frame levels (dBFS), when it holds speech: 30
    /// frames above -100 dBFS, 30 within 20 dB of it. nil otherwise (the defaults stay).
    static func p90(of x: [Float], sampleRate: Int) -> Double? {
        let n = Int((0.01 * Double(sampleRate)).rounded())
        guard n > 0 else { return nil }
        let m = x.count / n
        guard m >= 30 else { return nil }
        var levels: [Double] = []
        levels.reserveCapacity(m)
        for f in 0..<m {
            var s = 0.0
            for i in f * n..<(f + 1) * n { s += Double(x[i]) * Double(x[i]) }
            let l = masterDB(s / Double(n))
            if l > -100 { levels.append(l) }
        }
        guard levels.count >= 30 else { return nil }
        levels.sort()
        let pos = 0.9 * Double(levels.count - 1)
        let lo = Int(pos)
        let p = lo + 1 < levels.count ? levels[lo] + (levels[lo + 1] - levels[lo]) * (pos - Double(lo)) : levels[lo]
        return levels.filter { $0 > p - 20 }.count >= 30 ? p : nil
    }
}

// MARK: - Presets (master_stream.py PRESETS / SEED)

struct MasterParams: Sendable {
    struct DeEss: Sendable { let lo: Double, hi: Double, q: Double, ratio: Double, maxGR: Double, seed: Double }
    struct Expand: Sendable { let above: Double, knee: Double, maxGR: Double, close: Double, open: Double }
    struct Level: Sendable { let range: Double, amount: Double }
    struct Comp: Sendable { let ratio: Double, q: Double, knee: Double, attack: Double, release: Double, maxGR: Double }
    struct Colour: Sendable { let level: Double, k: Double, bias: Double, lo: Double, hi: Double, hp: Double, lp: Double, mix0: Double }
    struct Room: Sendable { let offset: Double, cap: Double, bed: Double, noise: [Double] }

    let hpf: Double
    let eq: [Double]
    let deEss: DeEss?
    let expand: Expand?
    let level: Level?
    let comp: Comp?
    let glue: Double
    let saturate: Colour?
    let excite: Colour?
    let room: Room

    /// The EQ's sections (kind, Hz, Q); each preset gives their gains (dB).
    static let eqShape: [(kind: MasterSection.Kind, hz: Double, q: Double)] = [
        (.lowShelf, 160, 0.7071), (.peak, 450, 1.0), (.peak, 1400, 1.6), (.highShelf, 2300, 0.7071), (.peak, 7000, 0.9), (.highShelf, 13000, 0.7071),
    ]

    static func of(_ preset: NephisMaster.Preset) -> MasterParams {
        let exp = Expand(above: 10, knee: 8, maxGR: 3, close: 150, open: 3)
        let level = Level(range: 2, amount: 0.5)
        switch preset {
        case .minimal:
            return MasterParams(hpf: 0, eq: [], deEss: nil, expand: nil, level: nil, comp: nil, glue: 0, saturate: nil, excite: nil,
                                room: Room(offset: -2, cap: -68, bed: -8, noise: [658.3, 7.58, 193.9, 7.87, 3997.0, 0.785, 11545.0, 0.69]))
        case .clean:
            return MasterParams(hpf: 75, eq: [-0.94, 2.03, 0.97, -2.94, -2.01, 2.46],
                                deEss: DeEss(lo: 5000, hi: 9000, q: 0.90, ratio: 3, maxGR: 5, seed: 20.5), expand: exp, level: level,
                                comp: Comp(ratio: 2, q: 0.70, knee: 6, attack: 20, release: 200, maxGR: 3.5), glue: 0, saturate: nil, excite: nil,
                                room: Room(offset: -2, cap: -68, bed: -8, noise: [753.2, 6.93, 236.9, 7.84, 3712.5, 0.853, 14182.0, 0.539]))
        case .warm:
            return MasterParams(hpf: 65, eq: [-0.2, 2.63, 0.62, -4.51, -1.38, 3.22],
                                deEss: DeEss(lo: 5000, hi: 9000, q: 0.80, ratio: 3, maxGR: 6, seed: 19.1),
                                expand: Expand(above: 10, knee: 8, maxGR: 4, close: 150, open: 3), level: level,
                                comp: Comp(ratio: 2.5, q: 0.65, knee: 6, attack: 20, release: 200, maxGR: 4), glue: 0.2,
                                saturate: Colour(level: -30, k: 1.6, bias: 0.2, lo: 0, hi: 0, hp: 0, lp: 4000, mix0: 0.135), excite: nil,
                                room: Room(offset: -3, cap: -70, bed: -8, noise: [392.1, 9.74, 514.9, 9.26, 3780.3, 0.658, 12808.7, 0.527]))
        case .crisp:
            return MasterParams(hpf: 80, eq: [-0.95, 2.05, 0.75, -0.93, -2.91, 1.27],
                                deEss: DeEss(lo: 5500, hi: 10000, q: 0.90, ratio: 3, maxGR: 5, seed: 20.7), expand: exp, level: level,
                                comp: Comp(ratio: 2, q: 0.70, knee: 6, attack: 20, release: 200, maxGR: 3.5), glue: 0, saturate: nil,
                                excite: Colour(level: -38, k: 3, bias: 0, lo: 3000, hi: 7500, hp: 7000, lp: 16500, mix0: 0.26),
                                room: Room(offset: -2, cap: -68, bed: -8, noise: [755.1, 6.29, 237.7, 8.68, 3680.7, 0.983, 13934.8, 0.663]))
        }
    }
}

/// Trackers' starting points: offsets (dB) from the first call's p90, measured on three reads (master_stream.py SEED).
enum MasterSeed {
    static let p90 = -23.0
    static let roomFloor = -55.0
    static let p90Expand = -0.5
    static let floor = -68.0
    static let p90Level = -0.8
    static let levelMedian = -7.1
    static let comp = -2.9
    static let glue = -6.1
    static let peak = 11.3
    static let p90Band = -17.2
    static let bandPeak = 14.9
    /// Quantile tracker step (dB per 1 ms step); the room's floor tracker moves faster.
    static let eta = 0.005
    static let roomEta = 0.02
    static let lufs = -26.0
    static let slewDBPerSecond = 0.3
}

// MARK: - Building blocks

@inline(__always) func masterDB(_ p: Double) -> Double { 10 * log10(max(p, 1e-20)) }

struct MasterClock: Sendable {
    let fs: Double
    let cr: Int
    /// One-pole coefficient per control step for a time constant of `ms`.
    func pole(_ ms: Double) -> Double { 1 - exp(-Double(cr) / (ms * fs / 1000)) }
}

/// Level (dB) of the mean of the last `w` step powers (zeros before the stream starts).
struct MasterBox: Sendable {
    private var r: [Double]
    private var i = 0
    private var s = 0.0
    init(_ w: Int) { r = [Double](repeating: 0, count: max(1, w)) }
    mutating func push(_ p: Double) -> Double {
        s += p - r[i]
        r[i] = p
        i = (i + 1) % r.count
        return masterDB(s / Double(r.count))
    }
}

/// A streaming quantile (stochastic approximation): up by eta × q when above, down by eta × (1 - q) otherwise.
struct MasterQuantile: Sendable {
    let q: Double
    var v: Double
    let eta: Double
    init(_ q: Double, _ v: Double, eta: Double = MasterSeed.eta) {
        self.q = q
        self.v = v
        self.eta = eta
    }
    mutating func push(_ x: Double) { v += eta * (q - (x <= v ? 1 : 0)) }
}

/// A control value per sample: a step's samples ramp from the value two steps back to the value one step back.
struct MasterRamp: Sendable {
    var g2: Double
    var g1: Double
    init(_ v: Double) {
        g2 = v
        g1 = v
    }
    func at(_ ph: Int, _ cr: Int) -> Double { g2 + (g1 - g2) * Double(ph + 1) / Double(cr) }
    mutating func push(_ v: Double) {
        g2 = g1
        g1 = v
    }
}

/// One biquad section (a0 = 1) and its RBJ cookbook designs (NephisFlow's ToneBiquad formulas; frequency clamped
/// under 0.49 fs).
struct MasterSection: Sendable, Equatable {
    enum Kind: Sendable { case hp, lp, bp, peak, lowShelf, highShelf }

    let b0: Double
    let b1: Double
    let b2: Double
    let a1: Double
    let a2: Double

    init(b0: Double, b1: Double, b2: Double, a1: Double, a2: Double) {
        self.b0 = b0
        self.b1 = b1
        self.b2 = b2
        self.a1 = a1
        self.a2 = a2
    }

    init(_ kind: Kind, _ f: Double, q: Double, db g: Double = 0, fs: Double) {
        let a = pow(10, g / 40), w = 2 * Double.pi * min(f, fs * 0.49) / fs, c = cos(w), al = sin(w) / (2 * q)
        let b: (Double, Double, Double)
        let d: (Double, Double, Double)
        switch kind {
        case .hp:
            b = ((1 + c) / 2, -(1 + c), (1 + c) / 2)
            d = (1 + al, -2 * c, 1 - al)
        case .lp:
            b = ((1 - c) / 2, 1 - c, (1 - c) / 2)
            d = (1 + al, -2 * c, 1 - al)
        case .bp:
            b = (al, 0, -al)
            d = (1 + al, -2 * c, 1 - al)
        case .peak:
            b = (1 + al * a, -2 * c, 1 - al * a)
            d = (1 + al / a, -2 * c, 1 - al / a)
        case .lowShelf:
            let sq = 2 * a.squareRoot() * al
            b = (a * ((a + 1) - (a - 1) * c + sq), 2 * a * ((a - 1) - (a + 1) * c), a * ((a + 1) - (a - 1) * c - sq))
            d = ((a + 1) + (a - 1) * c + sq, -2 * ((a - 1) + (a + 1) * c), (a + 1) + (a - 1) * c - sq)
        case .highShelf:
            let sq = 2 * a.squareRoot() * al
            b = (a * ((a + 1) + (a - 1) * c + sq), -2 * a * ((a - 1) + (a + 1) * c), a * ((a + 1) + (a - 1) * c - sq))
            d = ((a + 1) - (a - 1) * c + sq, 2 * ((a - 1) - (a + 1) * c), (a + 1) - (a - 1) * c - sq)
        }
        self.init(b0: b.0 / d.0, b1: b.1 / d.0, b2: b.2 / d.0, a1: d.1 / d.0, a2: d.2 / d.0)
    }

    /// Butterworth 4th order: two sections.
    static func butterworth4(_ kind: Kind, _ f: Double, fs: Double) -> [MasterSection] {
        [MasterSection(kind, f, q: 0.5411961, fs: fs), MasterSection(kind, f, q: 1.3065630, fs: fs)]
    }

    static func butterworth2(_ kind: Kind, _ f: Double, fs: Double) -> [MasterSection] {
        [MasterSection(kind, f, q: 0.7071, fs: fs)]
    }

    /// Energy of the cascade's impulse response over `count` samples (Double precision).
    static func impulseEnergy(_ sections: [MasterSection], count: Int) -> Double {
        var z = [Double](repeating: 0, count: 2 * sections.count)
        var e = 0.0
        for n in 0..<count {
            var v = n == 0 ? 1.0 : 0.0
            for (k, s) in sections.enumerated() {
                let y = s.b0 * v + z[2 * k]
                z[2 * k] = s.b1 * v - s.a1 * y + z[2 * k + 1]
                z[2 * k + 1] = s.b2 * v - s.a2 * y
                v = y
            }
            e += v * v
        }
        return e
    }
}

/// A cascade of biquads whose state carries over from one call to the next. With Accelerate each section is one
/// vDSP_deq22 pass (direct form I), its state the two inputs and two outputs before the call, kept here explicitly:
/// the same audio whether a read comes in one call or in many.
struct MasterCascade: Sendable {
    let sections: [MasterSection]
    #if canImport(Accelerate)
    private let coefficients: [[Float]]
    /// Per section: x[n-2], x[n-1], y[n-2], y[n-1].
    private var state: [Float]
    #else
    private var z: [Double]
    #endif

    init(_ sections: [MasterSection]) {
        self.sections = sections
        #if canImport(Accelerate)
        coefficients = sections.map { [Float($0.b0), Float($0.b1), Float($0.b2), Float($0.a1), Float($0.a2)] }
        state = [Float](repeating: 0, count: 4 * sections.count)
        #else
        z = [Double](repeating: 0, count: 2 * sections.count)
        #endif
    }

    /// `x` through the cascade.
    mutating func run(_ x: [Float]) -> [Float] {
        guard !sections.isEmpty, !x.isEmpty else { return x }
        #if canImport(Accelerate)
        let n = x.count
        var input = [Float](repeating: 0, count: n + 2)
        var output = [Float](repeating: 0, count: n + 2)
        for i in 0..<n { input[i + 2] = x[i] }
        for k in coefficients.indices {
            input[0] = state[4 * k]
            input[1] = state[4 * k + 1]
            output[0] = state[4 * k + 2]
            output[1] = state[4 * k + 3]
            vDSP_deq22(input, 1, coefficients[k], &output, 1, vDSP_Length(n))
            state[4 * k] = input[n]
            state[4 * k + 1] = input[n + 1]
            state[4 * k + 2] = output[n]
            state[4 * k + 3] = output[n + 1]
            swap(&input, &output)
        }
        return Array(input[2...])
        #else
        var y = x
        for i in y.indices {
            var v = Double(y[i])
            for (k, s) in sections.enumerated() {
                let o = s.b0 * v + z[2 * k]
                z[2 * k] = s.b1 * v - s.a1 * o + z[2 * k + 1]
                z[2 * k + 1] = s.b2 * v - s.a2 * o
                v = o
            }
            y[i] = Float(v)
        }
        return y
        #endif
    }
}
