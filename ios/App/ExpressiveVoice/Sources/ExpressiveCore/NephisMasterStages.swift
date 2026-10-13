//
//  NephisMasterStages.swift — the stages of NephisMaster (her mastering chain), each a streaming processor whose
//  state carries from one call to the next. Mirrors tachinovel-tts-lab finetune/wsl/master_stream.py class for class:
//  1 ms control steps (`cr` samples), trailing boxcar levels, a gain that changes one step after the audio that set
//  it, ramped sample by sample (MasterRamp).
//

import Foundation

/// The dynamics and colour stages a preset uses, in chain order.
struct MasterStages: Sendable {
    var deEss: MasterDeEss?
    var expand: MasterExpand?
    var level: MasterLeveler?
    var comp: MasterCompressor?
    var glue: MasterCompressor?
    var colour: MasterColour?

    init(_ p: MasterParams, clock: MasterClock, p90: Double) {
        deEss = p.deEss.map { MasterDeEss($0, clock: clock, p90: p90) }
        expand = p.expand.map { MasterExpand($0, clock: clock, p90: p90) }
        level = p.level.map { MasterLeveler($0, clock: clock, p90: p90) }
        comp = p.comp.map {
            MasterCompressor(ratio: $0.ratio, q: $0.q, knee: $0.knee, attack: $0.attack, release: $0.release, maxGR: $0.maxGR,
                             clock: clock, p90: p90, threshold: p90 + MasterSeed.comp, mix: nil)
        }
        glue = p.glue > 0
            ? MasterCompressor(ratio: 4, q: 0.5, knee: 6, attack: 5, release: 120, maxGR: 10, clock: clock, p90: p90,
                               threshold: p90 + MasterSeed.glue, mix: p.glue)
            : nil
        if let s = p.saturate {
            colour = MasterColour(.saturate, s, clock: clock, p90: p90)
        } else if let e = p.excite {
            colour = MasterColour(.excite, e, clock: clock, p90: p90)
        }
    }

    mutating func run(_ x: inout [Float], phase: Int, cr: Int) {
        deEss?.run(&x, phase: phase, cr: cr)
        expand?.run(&x, phase: phase, cr: cr)
        level?.run(&x, phase: phase, cr: cr)
        comp?.run(&x, phase: phase, cr: cr)
        glue?.run(&x, phase: phase, cr: cr)
        colour?.run(&x, phase: phase, cr: cr)
    }
}

/// The 5-9 kHz band turned down where it sticks out of 2-5 kHz more than this read's own S sounds usually do.
struct MasterDeEss: Sendable {
    private var band: MasterCascade
    private var ref: MasterCascade
    private var eb = MasterBox(5), er = MasterBox(5), ex = MasterBox(10)
    private var p90: MasterQuantile
    private var thr: MasterQuantile
    private let ratio: Double, maxGR: Double, aa: Double, ar: Double
    private var s = 0.0
    private var ramp = MasterRamp(1)
    private var accB = 0.0, accR = 0.0, accX = 0.0

    init(_ p: MasterParams.DeEss, clock c: MasterClock, p90 seed: Double) {
        band = MasterCascade(MasterSection.butterworth4(.hp, p.lo, fs: c.fs) + MasterSection.butterworth4(.lp, min(p.hi, 0.45 * c.fs), fs: c.fs))
        ref = MasterCascade(MasterSection.butterworth2(.hp, 2000, fs: c.fs) + MasterSection.butterworth2(.lp, 5000, fs: c.fs))
        p90 = MasterQuantile(0.9, seed)
        thr = MasterQuantile(p.q, p.seed)
        ratio = p.ratio
        maxGR = p.maxGR
        aa = c.pole(1)
        ar = c.pole(40)
    }

    mutating func run(_ x: inout [Float], phase: Int, cr: Int) {
        let b = band.run(x), r = ref.run(x)
        var ph = phase
        for i in x.indices {
            let g = Float(ramp.at(ph, cr))
            let v = x[i]
            x[i] = v - b[i] * (1 - g)
            accB += Double(b[i]) * Double(b[i])
            accR += Double(r[i]) * Double(r[i])
            accX += Double(v) * Double(v)
            ph += 1
            if ph == cr {
                ph = 0
                ramp.push(step(Double(cr)))
            }
        }
    }

    private mutating func step(_ n: Double) -> Double {
        let lb = eb.push(accB / n), lr = er.push(accR / n), lx = ex.push(accX / n)
        accB = 0
        accR = 0
        accX = 0
        var gr = 0.0
        if lx > -100 {
            p90.push(lx)
            if lb > lr && lb > p90.v - 30 {
                thr.push(lb - lr)
                gr = min(max((lb - lr - thr.v) * (1 - 1 / ratio), 0), maxGR)
            }
        }
        s += (gr - s) * (gr > s ? aa : ar)
        return pow(10, -s / 20)
    }
}

/// Pause quieting: a few dB off the decoder's own noise between words (threshold at the read's floor + 10 dB, never
/// within 40 dB of its speech), closing over 150 ms, opening in 3 ms with 5 ms lookahead.
struct MasterExpand: Sendable {
    private var det: MasterCascade
    private var e = MasterBox(10)
    private var p90: MasterQuantile
    private var floor: MasterQuantile
    private let above: Double, knee: Double, maxGR: Double, aa: Double, ar: Double
    private var s = 0.0
    private var ramp = MasterRamp(1)
    private var acc = 0.0
    private var delay: [Float]
    private var pos = 0

    init(_ p: MasterParams.Expand, clock c: MasterClock, p90 seed: Double) {
        det = MasterCascade(MasterSection.butterworth2(.hp, 100, fs: c.fs) + MasterSection.butterworth2(.lp, min(8000, 0.45 * c.fs), fs: c.fs))
        p90 = MasterQuantile(0.9, seed + MasterSeed.p90Expand)
        floor = MasterQuantile(0.25, seed + MasterSeed.floor)
        above = p.above
        knee = p.knee
        maxGR = p.maxGR
        aa = c.pole(p.close)
        ar = c.pole(p.open)
        delay = [Float](repeating: 0, count: 5 * c.cr)
    }

    mutating func run(_ x: inout [Float], phase: Int, cr: Int) {
        let d = det.run(x)
        var ph = phase
        for i in x.indices {
            let g = Float(ramp.at(ph, cr))
            let out = delay[pos]
            delay[pos] = x[i]
            pos = (pos + 1) % delay.count
            x[i] = out * g
            acc += Double(d[i]) * Double(d[i])
            ph += 1
            if ph == cr {
                ph = 0
                ramp.push(step(Double(cr)))
            }
        }
    }

    private mutating func step(_ n: Double) -> Double {
        let l = e.push(acc / n)
        acc = 0
        var v = 0.0
        if l > -100 {
            p90.push(l)
            if l < p90.v - 30 { floor.push(l) }
            let threshold = min(floor.v + above, p90.v - 40)
            let t = min(max((threshold - l) / knee + 0.5, 0), 1)
            v = maxGR * t * t * (3 - 2 * t)
        }
        s += (v - s) * (v > s ? aa : ar)
        return pow(10, -s / 20)
    }
}

/// A slow leveler: ±2 dB toward the read's median speech level, following speech only (holds in pauses).
struct MasterLeveler: Sendable {
    private var det: MasterCascade
    private var e = MasterBox(100)
    private var p90: MasterQuantile
    private var median: MasterQuantile
    private var lv: Double
    private let range: Double, amount: Double, a: Double, a5: Double
    private var s = 0.0
    private var ramp = MasterRamp(1)
    private var acc = 0.0

    init(_ p: MasterParams.Level, clock c: MasterClock, p90 seed: Double) {
        det = MasterCascade(MasterSection.butterworth2(.hp, 100, fs: c.fs) + MasterSection.butterworth2(.lp, 5000, fs: c.fs))
        p90 = MasterQuantile(0.9, seed + MasterSeed.p90Level)
        median = MasterQuantile(0.5, seed + MasterSeed.levelMedian)
        lv = seed + MasterSeed.levelMedian
        range = p.range
        amount = p.amount
        a = c.pole(1500)
        a5 = c.pole(500)
    }

    mutating func run(_ x: inout [Float], phase: Int, cr: Int) {
        let d = det.run(x)
        var ph = phase
        for i in x.indices {
            x[i] *= Float(ramp.at(ph, cr))
            acc += Double(d[i]) * Double(d[i])
            ph += 1
            if ph == cr {
                ph = 0
                ramp.push(step(Double(cr)))
            }
        }
    }

    private mutating func step(_ n: Double) -> Double {
        let l = e.push(acc / n)
        acc = 0
        if l > -100 {
            p90.push(l)
            if l > p90.v - 22 {
                median.push(l)
                lv += (l - lv) * a
            }
        }
        let g = min(max((median.v - lv) * amount, -range), range)
        s += (g - s) * a5
        return pow(10, s / 20)
    }
}

/// A soft-knee compressor on 10 ms levels, threshold at a percentile of this read's speech; with `mix`, a parallel
/// copy mixed under the input instead (glue).
struct MasterCompressor: Sendable {
    private var e = MasterBox(10)
    private var p90: MasterQuantile
    private var thr: MasterQuantile
    private let ratio: Double, knee: Double, maxGR: Double, aa: Double, ar: Double
    private let mix: Float?
    private var s = 0.0
    private var ramp = MasterRamp(1)
    private var acc = 0.0

    init(ratio: Double, q: Double, knee: Double, attack: Double, release: Double, maxGR: Double, clock c: MasterClock,
         p90 seed: Double, threshold: Double, mix: Double?) {
        p90 = MasterQuantile(0.9, seed)
        thr = MasterQuantile(q, threshold)
        self.ratio = ratio
        self.knee = knee
        self.maxGR = maxGR
        aa = c.pole(attack)
        ar = c.pole(release)
        self.mix = mix.map { Float($0) }
    }

    mutating func run(_ x: inout [Float], phase: Int, cr: Int) {
        var ph = phase
        for i in x.indices {
            let g = Float(ramp.at(ph, cr))
            let v = x[i]
            if let mix {
                x[i] = v + mix * v * g
            } else {
                x[i] = v * g
            }
            acc += Double(v) * Double(v)
            ph += 1
            if ph == cr {
                ph = 0
                ramp.push(step(Double(cr)))
            }
        }
    }

    private mutating func step(_ n: Double) -> Double {
        let l = e.push(acc / n)
        acc = 0
        var gr = 0.0
        if l > -100 {
            p90.push(l)
            if l > p90.v - 20 { thr.push(l) }
            let o = l - thr.v, r = 1 - 1 / ratio
            if o <= -knee / 2 {
                gr = 0
            } else if o >= knee / 2 {
                gr = o * r
            } else {
                gr = r * (o + knee / 2) * (o + knee / 2) / (2 * knee)
            }
            gr = min(gr, maxGR)
        }
        s += (gr - s) * (gr > s ? aa : ar)
        return pow(10, -s / 20)
    }
}

/// Saturation (warm) or an exciter (crisp): the distortion of a level-normalised copy, filtered, mixed in `level` dB
/// under the speech (the mix from long-term speech energies, starting at the PC chain's typical mix).
struct MasterColour: Sendable {
    enum Kind: Sendable { case saturate, excite }

    private let kind: Kind
    private var bandF: MasterCascade
    private var post: MasterCascade
    private var e = MasterBox(10), eh = MasterBox(10)
    private var p90: MasterQuantile
    private var p90h: MasterQuantile
    private var ax: Double
    private var ad: Double
    private let lvl: Double, b: Double, k: Double, bias: Double, t0: Double
    private var pkRamp: MasterRamp
    private var mixRamp: MasterRamp
    private var accX = 0.0, accH = 0.0, accD = 0.0

    init(_ kind: Kind, _ p: MasterParams.Colour, clock c: MasterClock, p90 seed: Double) {
        self.kind = kind
        let fs = c.fs
        p90 = MasterQuantile(0.9, seed)
        p90h = MasterQuantile(0.9, seed + MasterSeed.p90Band)
        lvl = pow(10, p.level / 20)
        ax = pow(10, seed / 10)
        ad = ax / ((p.mix0 / lvl) * (p.mix0 / lvl))
        b = c.pole(10_000)
        k = p.k
        bias = p.bias
        t0 = tanh(p.k * p.bias)
        mixRamp = MasterRamp(p.mix0)
        switch kind {
        case .saturate:
            bandF = MasterCascade([])
            // The low-pass (warmth), then a 10 Hz DC blocker.
            post = MasterCascade(MasterSection.butterworth2(.lp, p.lp, fs: fs) + [MasterSection(b0: 1, b1: -1, b2: 0, a1: -exp(-2 * Double.pi * 10 / fs), a2: 0)])
            pkRamp = MasterRamp(pow(10, (seed + MasterSeed.peak) / 20))
        case .excite:
            bandF = MasterCascade(MasterSection.butterworth4(.hp, p.lo, fs: fs) + MasterSection.butterworth4(.lp, min(p.hi, 0.45 * fs), fs: fs))
            post = MasterCascade(MasterSection.butterworth4(.hp, p.hp, fs: fs) + (p.lp < 0.45 * fs ? MasterSection.butterworth4(.lp, p.lp, fs: fs) : []))
            pkRamp = MasterRamp(pow(10, (seed + MasterSeed.p90Band + MasterSeed.bandPeak) / 20))
        }
    }

    mutating func run(_ x: inout [Float], phase: Int, cr: Int) {
        let n = x.count, excite = kind == .excite
        let src = excite ? bandF.run(x) : x
        let crd = Double(cr)
        // 1: the normalising peak per sample, and per completed step its power and whether it is speech
        var pk = [Float](repeating: 1, count: n)
        var px: [Double] = []
        var speech: [Bool] = []
        var ph = phase
        for i in 0..<n {
            pk[i] = Float(pkRamp.at(ph, cr))
            accX += Double(x[i]) * Double(x[i])
            if excite { accH += Double(src[i]) * Double(src[i]) }
            ph += 1
            if ph == cr {
                ph = 0
                let p = accX / crd
                px.append(p)
                let lx = e.push(p)
                if lx > -100 { p90.push(lx) }
                speech.append(lx > -100 && lx > p90.v - 20)
                if excite {
                    let lh = eh.push(accH / crd)
                    if lh > -100 { p90h.push(lh) }
                    pkRamp.push(pow(10, (p90h.v + MasterSeed.bandPeak) / 20))
                } else {
                    pkRamp.push(pow(10, (p90.v + MasterSeed.peak) / 20))
                }
                accX = 0
                accH = 0
            }
        }
        // 2: the distortion part only, filtered, back at the signal's scale
        var d = [Float](repeating: 0, count: n)
        for i in 0..<n {
            let u = Double(src[i]) / Double(pk[i])
            d[i] = Float(excite ? tanh(k * u) / k - u : (tanh(k * (u + bias)) - t0) / (k * (1 - t0 * t0)) - u)
        }
        var add = post.run(d)
        for i in 0..<n { add[i] *= pk[i] }
        // 3: mixed in at the level that keeps it `level` dB under the speech
        ph = phase
        var step = 0
        for i in 0..<n {
            x[i] += Float(mixRamp.at(ph, cr)) * add[i]
            accD += Double(add[i]) * Double(add[i])
            ph += 1
            if ph == cr {
                ph = 0
                if step < speech.count, speech[step] {
                    ax += (px[step] - ax) * b
                    ad += (accD / crd - ad) * b
                }
                step += 1
                accD = 0
                mixRamp.push(lvl * (ax / max(ad, 1e-30)).squareRoot())
            }
        }
    }
}

/// BS.1770 gated loudness of the read so far (400 ms blocks every 100 ms, absolute and relative gates, a 0.1 dB
/// histogram) and the gain toward the target: set by the first call with 8 blocks of sound, then at most 0.3 dB/s.
struct MasterLoudness: Sendable {
    private var kw: MasterCascade
    private let sub: Int
    private var acc = 0.0
    private var n = 0
    private var subs: [Double] = []
    private var cnt = [Double](repeating: 0, count: 1000)
    private var pw = [Double](repeating: 0, count: 1000)
    private var total = 0.0
    private var totalPower = 0.0
    private(set) var gain: Double
    private var locked = false
    private var ramp: MasterRamp
    private let cap: Double
    private let target: Double
    private var cached: Double?
    private var dirty = false
    /// What the limiter takes off the loudness (dB), added back to the gain (MasterParams.limiterLoss).
    var loss = 0.0

    init(clock c: MasterClock, target: Double) {
        kw = MasterCascade([MasterSection(.highShelf, 1681.9744509555319, q: 0.7071752369554193, db: 3.99984385397, fs: c.fs),
                            MasterSection(.hp, 38.13547087613982, q: 0.5003270373253953, fs: c.fs)])
        sub = Int((0.1 * c.fs).rounded())
        self.target = target
        gain = min(max(target - MasterSeed.lufs, -12), 24)
        ramp = MasterRamp(gain)
        cap = MasterSeed.slewDBPerSecond * Double(c.cr) / c.fs
    }

    /// Integrated loudness (LUFS) of the blocks so far; nil before the first.
    func integrated() -> Double? {
        guard total > 0 else { return nil }
        let rel = -0.691 + masterDB(totalPower / total) - 10
        let i0 = min(max(Int(((rel + 70) * 10).rounded(.up)), 0), 999)
        var c = 0.0, p = 0.0
        for i in i0..<1000 {
            c += cnt[i]
            p += pw[i]
        }
        return c == 0 ? nil : -0.691 + masterDB(p / c)
    }

    /// Measures the call and returns its gain in dB, sample by sample.
    mutating func measure(_ x: [Float], phase: Int, cr: Int) -> [Double] {
        let k = kw.run(x)
        var gains: [Double] = []
        var ph = phase
        for i in x.indices {
            acc += Double(k[i]) * Double(k[i])
            n += 1
            if n == sub {
                subs.append(acc / Double(sub))
                if subs.count > 4 { subs.removeFirst() }
                acc = 0
                n = 0
                if subs.count == 4 {
                    let z = (subs[0] + subs[1] + subs[2] + subs[3]) / 4
                    let l = -0.691 + masterDB(z)
                    if l > -70 {
                        let bin = min(Int((l + 70) * 10), 999)
                        cnt[bin] += 1
                        pw[bin] += z
                        total += 1
                        totalPower += z
                        dirty = true
                    }
                }
            }
            ph += 1
            if ph == cr {
                ph = 0
                if locked {
                    if dirty {
                        cached = integrated()
                        dirty = false
                    }
                    if let l = cached {
                        let t = min(max(target - l + loss, -12), 24)
                        gain += min(max(t - gain, -cap), cap)
                    }
                }
                gains.append(gain)
            }
        }
        if !locked, total >= 8, let l = integrated() {
            gain = min(max(target - l + loss, -12), 24)
            locked = true
            gains = [Double](repeating: gain, count: gains.count)
            ramp = MasterRamp(gain)
            cached = l
            dirty = false
        }
        var out = [Double](repeating: 0, count: x.count)
        ph = phase
        var s = 0
        for i in x.indices {
            out[i] = ramp.at(ph, cr)
            ph += 1
            if ph == cr {
                ph = 0
                ramp.push(gains[s])
                s += 1
            }
        }
        return out
    }
}

/// One digital-silence pad: where it starts and ends (input samples) and the room tone's amplitude in it.
struct MasterPad: Sendable {
    var start: Int
    var end: Int?
    var amp: Double
}

/// Room tone: shaped noise in the digital-silence pads (|x| < 1.5e-5 for 10 ms or more) and a bed 8 dB under the
/// quietest pad so far, under everything. Output sample t = input t - `delay` (40 ms) + noise × weight; each weight is
/// decided when input t arrives, so a pad's 30 ms fade-in starts before it. Nothing is taken from the input.
struct MasterRoom: Sendable {
    private let minRun: Int, xf: Int, k50: Int
    let delay: Int
    private var hist: [Float]
    private var zrun = 0
    private var pads: [MasterPad] = []
    private var minAmp: Double?
    private var bed = 0.0
    private var bedTarget = 0.0
    private let bedA: Double, bedGain: Double, offset: Double, cap: Double
    private var t = 0
    private var rng: UInt32 = 0x9E37_79B9
    private var noiseF: MasterCascade
    private let norm: Float
    private let up: [Double]
    private var e = MasterBox(10)
    private var acc = 0.0
    private var ph = 0
    private var p90: MasterQuantile
    private var floor: MasterQuantile

    init(_ p: MasterParams.Room, clock c: MasterClock) {
        let fs = c.fs
        minRun = Int((0.010 * fs).rounded())
        let fade = Int((0.030 * fs).rounded())
        xf = fade
        k50 = Int((0.05 * fs).rounded())
        delay = minRun + fade
        hist = [Float](repeating: 0, count: delay + k50)
        bedA = 1 - exp(-1 / (0.5 * fs))
        bedGain = pow(10, p.bed / 20)
        offset = p.offset
        cap = p.cap
        let n = p.noise
        let sections = [MasterSection(.hp, 60, q: 0.7071, fs: fs), MasterSection(.lowShelf, n[0], q: 0.7071, db: n[1], fs: fs),
                        MasterSection(.peak, n[2], q: 1.0, db: n[3], fs: fs), MasterSection(.lp, n[4], q: n[5], fs: fs),
                        MasterSection(.lp, n[6], q: n[7], fs: fs)]
        noiseF = MasterCascade(sections)
        norm = Float(1 / MasterSection.impulseEnergy(sections, count: Int(fs)).squareRoot())
        up = (0..<fade).map { 0.5 - 0.5 * cos(Double.pi * Double($0) / Double(max(1, fade - 1))) }
        p90 = MasterQuantile(0.9, MasterSeed.p90)
        floor = MasterQuantile(0.5, MasterSeed.p90 + MasterSeed.roomFloor, eta: MasterSeed.roomEta)
    }

    /// The floor trackers' starting points from the first call's p90.
    mutating func seed(p90 seed: Double) {
        p90 = MasterQuantile(0.9, seed)
        floor = MasterQuantile(0.5, seed + MasterSeed.roomFloor, eta: MasterSeed.roomEta)
    }

    mutating func run(_ x: inout [Float], gainDB g: [Double], cr: Int) {
        let n = x.count, h = hist.count
        let w0 = hist + x
        var weights = [Double](repeating: 0, count: n)
        var out = [Float](repeating: 0, count: n)
        for i in 0..<n {
            let ti = t + i, v = w0[h + i]
            if abs(v) < 1.5e-5 {
                zrun += 1
                if zrun == minRun {
                    // A pad: its level from the 50 ms before it and the read's floor between words (the far side).
                    let ai = h + i - minRun + 1
                    var s = 0.0
                    for k in (ai - k50)..<ai { s += Double(w0[k]) * Double(w0[k]) }
                    let local = masterDB((s / Double(k50) + pow(10, floor.v / 10)) / 2)
                    let amp = pow(10, (min(local + g[i] + offset, cap) - g[i]) / 20)
                    pads.append(MasterPad(start: ti - minRun + 1, end: nil, amp: amp))
                    let quietest = min(minAmp ?? amp, amp)
                    minAmp = quietest
                    bedTarget = quietest * bedGain
                }
            } else {
                if zrun >= minRun, let last = pads.last, last.end == nil { pads[pads.count - 1].end = ti }
                zrun = 0
            }
            let j = ti - delay
            var wt = 0.0
            for pad in pads {
                if pad.start > j {
                    if pad.start - j <= xf { wt = max(wt, pad.amp * up[xf - (pad.start - j)]) }
                } else if let end = pad.end {
                    if j < end {
                        wt = max(wt, pad.amp)
                    } else if j - end < xf {
                        wt = max(wt, pad.amp * up[xf - 1 - (j - end)])
                    }
                } else {
                    wt = max(wt, pad.amp)
                }
            }
            bed += (bedTarget - bed) * bedA
            weights[i] = max(wt, bed)
            out[i] = w0[h + i - delay]
            if !pads.isEmpty {
                let fade = xf
                pads.removeAll { pad in
                    guard let end = pad.end else { return false }
                    return j - end >= fade
                }
            }
            acc += Double(v) * Double(v)
            ph += 1
            if ph == cr {
                let l = e.push(acc / Double(cr))
                acc = 0
                ph = 0
                if l > -100 {
                    p90.push(l)
                    if l < p90.v - 30 { floor.push(l) }
                }
            }
        }
        t += n
        hist = Array(w0.suffix(h))
        let noise = shapedNoise(n)
        for i in 0..<n { x[i] = out[i] + Float(Double(noise[i]) * weights[i]) }
    }

    /// Unit-RMS noise shaped like the read's quiet floor (xorshift32, four uniforms per sample).
    private mutating func shapedNoise(_ n: Int) -> [Float] {
        var g = [Float](repeating: 0, count: n)
        var s = rng
        for i in 0..<n {
            var acc = 0.0
            for _ in 0..<4 {
                s ^= s << 13
                s ^= s >> 17
                s ^= s << 5
                acc += Double(s) / 4_294_967_296.0
            }
            g[i] = Float((acc - 2) * 1.7320508075688772)
        }
        rng = s
        var y = noiseF.run(g)
        for i in 0..<n { y[i] *= norm }
        return y
    }
}

/// True-peak limiter: peaks from the samples and three points between each pair (8-tap windowed sinc), the gain each
/// needs held over 1.5 ms, released over 80 ms and smoothed by a 1.5 ms boxcar, applied to the audio delayed to match.
/// A sample never exceeds the ceiling. Also tracks what it takes off (energy in / out).
struct MasterLimiter: Sendable {
    let w: Int
    private let a: Double
    private let c: Double
    private let fir: [[Double]]
    private var x: [Float]
    private var need: [Double]
    private var rh: [Double]
    private var r = 1.0
    private var ein = 0.0
    private var eout = 0.0

    init(clock clk: MasterClock, ceilingDB: Double) {
        w = Int((0.0015 * clk.fs).rounded()) + 1
        a = 1 - exp(-1 / (0.08 * clk.fs))
        c = pow(10, ceilingDB / 20)
        fir = MasterLimiter.interpolator()
        x = [Float](repeating: 0, count: 7 + w)
        need = [Double](repeating: 1, count: w - 1)
        rh = [Double](repeating: 1, count: w - 1)
    }

    /// The three fractional-delay filters (positions 1/4, 1/2, 3/4 between samples), taps for x[n-3...n+4].
    static func interpolator() -> [[Double]] {
        (1...3).map { p -> [Double] in
            let h = (-3...4).map { j -> Double in
                let t = Double(j) - Double(p) / 4
                return sin(Double.pi * t) / (Double.pi * t) * (0.5 + 0.5 * cos(Double.pi * t / 4.5))
            }
            let s = h.reduce(0, +)
            return h.map { $0 / s }
        }
    }

    /// The largest of |x[i]| and the three interpolated points after it (needs x[i-3...i+4]).
    static func peak(_ xs: [Float], _ i: Int, _ fir: [[Double]]) -> Double {
        var m = abs(Double(xs[i]))
        for f in fir {
            var acc = 0.0
            for j in 0..<8 { acc += Double(xs[i - 3 + j]) * f[j] }
            m = max(m, abs(acc))
        }
        return m
    }

    var loss: Double { eout > 0 ? masterDB(ein / eout) : 0 }

    mutating func run(_ input: inout [Float]) {
        let n = input.count
        let xs = x + input
        var nb = need
        nb.reserveCapacity(w - 1 + n)
        for i in 0..<n { nb.append(min(1, c / max(Self.peak(xs, w + 3 + i, fir), 1e-12))) }
        // Held: the smallest need over the last w (monotonic deque).
        var held = [Double](repeating: 1, count: n)
        var dq: [Int] = []
        dq.reserveCapacity(nb.count)
        var head = 0
        for k in nb.indices {
            while dq.count > head, let last = dq.last, nb[last] >= nb[k] { dq.removeLast() }
            dq.append(k)
            if dq[head] <= k - w { head += 1 }
            if k >= w - 1 { held[k - (w - 1)] = nb[dq[head]] }
        }
        var rr = [Double](repeating: 1, count: n)
        for i in 0..<n {
            let hv = held[i]
            r = hv < r ? hv : r + (1 - r) * a
            r = min(r, hv)
            rr[i] = r
        }
        let rb = rh + rr
        var sum = 0.0
        for k in 0..<(w - 1) { sum += rb[k] }
        let cf = Float(c)
        for i in 0..<n {
            sum += rb[i + w - 1]
            let gain = sum / Double(w)
            sum -= rb[i]
            let src = xs[i + 4]
            let y = min(max(Float(Double(src) * gain), -cf), cf)
            ein += Double(src) * Double(src)
            eout += Double(y) * Double(y)
            input[i] = y
        }
        x = Array(xs.suffix(7 + w))
        need = Array(nb.suffix(w - 1))
        rh = Array(rb.suffix(w - 1))
    }
}
