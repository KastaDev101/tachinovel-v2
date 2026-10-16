//
//  BreathPolish.swift — her breaths as air, not buzz (Kasta, 2026-10-13).
//
//  The studio's vocoder leaves a pitched buzz in her breaths and in the air of breathy words: Kasta hears it as the
//  robotic part of an otherwise good read. The PC fix (tachinovel-tts-lab finetune/wsl/breath_polish_v2.py, preset "a",
//  tuned by breath_sweep.py with breath_meter.py) rebuilds that air from its own smoothed spectrum with random phase:
//
//    breaths       unvoiced frames, above the call's floor, quieter than its speech, dark (centroid), at least 100 ms:
//                  the magnitude smoothed across ~1/6 octave (no harmonic peaks), the phase randomised, soft mask.
//    breathy words voiced frames whose energy above 1 kHz is mostly BETWEEN the pitch harmonics: only those
//                  between-harmonic bins above 1 kHz are rebuilt as their smoothed envelope with random phase; the
//                  harmonics and everything under 1 kHz stay as they are.
//    level         each rebuilt frame keeps its power per octave band (rebuild, and twice more after overlap-add, which
//                  loses 2-4 dB where neighbouring frames' phases no longer agree).
//
//  This is the phone version, simulated step for step on the PC by finetune/wsl/breath_polish_phone_sim.py (parity:
//  BreathPolishTests). Differences from the lab script: voicing comes from the frame's own autocorrelation (Boersma's
//  window-normalised method, one zero-padded FFT; thresholds calibrated against pyin) instead of pyin; the noise is a
//  counter-based SplitMix64 (the same numbers on the PC and the phone); only touched frames are rebuilt (output = input +
//  the overlap-added difference); no peak normalisation (a call's level must not move).
//
//  Cost (44.1 kHz, 2048-point frames, 512 hop = 86 frames/s): every frame one 2048 and two 4096 real FFTs (~0.31 Mflop);
//  a touched frame (~25% of a read) ~0.35 Mflop more (rebuild, inverse, two level passes): ~35 Mflop per second of audio,
//  a few ms on the phone's vDSP (BreathPolishTests logs the CI Mac's time), against hundreds of ms for the voice models.
//
import Accelerate
import Foundation

public enum BreathPolish {
    /// pack.json chain "breathPolish": {} turns it on with the phone's tuned values; any field overrides one. Absent: off,
    /// every call exactly as before.
    public struct Settings: Codable, Sendable, Equatable {
        /// Breaths: blend of the rebuilt air (0 = breaths untouched), and how much of the phase is randomised.
        public var strength = 1.0
        public var phase = 1.0
        /// Breathy words: the most the between-harmonic air is replaced (0 = words untouched), its phase randomisation.
        public var wordBlend = 0.8
        public var wordPhase = 1.0
        /// Smoothing of a breath's spectrum (octaves, FWHM), the breathy-word cutoff (Hz), the between-harmonic share
        /// where a word starts counting as breathy and over how much it reaches full weight, its envelope smoothing (bins).
        public var smoothOctaves = 1.0 / 6
        public var cutoffHz = 1000.0
        public var wordRampFrom = 0.30
        public var wordRampSpan = 0.25
        public var envelopeBins = 5.0
        /// Voicing strength (window-normalised autocorrelation peak, 0-1): a breath is under `breathVoicing`, a voiced
        /// frame (pitch, harmonics) over `voicedFrom`, the call's speech level is the median over `speechFrom`.
        /// Calibrated on three PC passages against pyin: p < 0.2 ~ 0.91, p > 0.5 ~ 0.97, p > 0.6 ~ 0.98 (90% of frames
        /// agree); the breath line sits at 0.80: the same buzz removed, words under 1 kHz changed half as much.
        public var breathVoicing = 0.80
        public var voicedFrom = 0.97
        public var speechFrom = 0.98
        /// A breath: above the call's floor by (dB), below its speech by (dB), spectral centroid under (Hz), lasting (s).
        public var aboveFloorDB = 6.0
        public var belowSpeechDB = 4.0
        public var centroidHz = 5000.0
        public var minBreathSeconds = 0.10
        /// How much of the per-band power is restored (1 = all), and the passes after overlap-add.
        public var keepLevel = 1.0
        public var levelPasses = 2
        /// The noise's seed (same seed, same sound).
        public var seed = 0
        /// Also the calls the studio didn't render (Mimi's sound). Off: only her studio sound, where it was tuned.
        public var plainToo = false

        public init() {}

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            func num(_ key: CodingKeys, _ value: Double, _ lo: Double, _ hi: Double) -> Double {
                min(hi, max(lo, (try? c.decodeIfPresent(Double.self, forKey: key)) ?? value))
            }
            strength = num(.strength, strength, 0, 1)
            phase = num(.phase, phase, 0, 1)
            wordBlend = num(.wordBlend, wordBlend, 0, 1)
            wordPhase = num(.wordPhase, wordPhase, 0, 1)
            smoothOctaves = num(.smoothOctaves, smoothOctaves, 0.02, 1)
            cutoffHz = num(.cutoffHz, cutoffHz, 300, 8000)
            wordRampFrom = num(.wordRampFrom, wordRampFrom, 0, 1)
            wordRampSpan = num(.wordRampSpan, wordRampSpan, 0.01, 1)
            envelopeBins = num(.envelopeBins, envelopeBins, 0.5, 40)
            breathVoicing = num(.breathVoicing, breathVoicing, 0, 1)
            voicedFrom = num(.voicedFrom, voicedFrom, 0, 1)
            speechFrom = num(.speechFrom, speechFrom, 0, 1)
            aboveFloorDB = num(.aboveFloorDB, aboveFloorDB, 0, 40)
            belowSpeechDB = num(.belowSpeechDB, belowSpeechDB, 0, 40)
            centroidHz = num(.centroidHz, centroidHz, 500, 20_000)
            minBreathSeconds = num(.minBreathSeconds, minBreathSeconds, 0.02, 2)
            keepLevel = num(.keepLevel, keepLevel, 0, 1)
            levelPasses = Int(num(.levelPasses, Double(levelPasses), 0, 4))
            seed = (try? c.decodeIfPresent(Int.self, forKey: .seed)) ?? seed
            plainToo = (try? c.decodeIfPresent(Bool.self, forKey: .plainToo)) ?? plainToo
        }
    }

    /// What one call's polish did.
    public struct Report: Sendable, Equatable {
        public var frames = 0
        public var breathFrames = 0
        public var wordFrames = 0
        public var touchedFrames = 0
        /// Time it took (ms).
        public var ms = 0.0

        public init() {}

        /// One line for the narration log.
        public var summary: String {
            "\(breathFrames) breath and \(wordFrames) breathy-word frames of \(frames), \(String(format: "%.0f", ms)) ms"
        }
    }

    /// Per-frame analysis (the same frames as librosa.stft(n_fft: N, hop: N/4), centred).
    public struct Analysis: Sendable {
        public var fftSize = 0
        public var hop = 0
        /// Frame level (dB, mean power), spectral centroid (Hz), voicing strength (0-1), pitch (Hz; 0 = none).
        public var db: [Double] = []
        public var centroid: [Double] = []
        public var voicing: [Double] = []
        public var f0: [Double] = []
        /// Voiced (voicing over `voicedFrom`), and its between-harmonic share of the energy above 1 kHz.
        public var voiced: [Bool] = []
        public var share: [Double] = []
        /// Power per octave band from 62.5 Hz (9 bands), for the level passes.
        var bands: [[Double]] = []
        /// The breath frames (fix A's detector).
        public var breath: [Bool] = []
    }

    static let harmTolerance = 0.22
    static let fMin = 70.0, fMax = 500.0
    static let bandEdges: [Double] = (0...9).map { 62.5 * pow(2, Double($0)) }

    /// 2048-point frames at 32 kHz and up (the lab's, at the studio's 44.1 kHz), 1024 below (Mimi's 24 kHz: ~43 ms).
    public static func fftSize(sampleRate: Int) -> Int { sampleRate >= 32_000 ? 2048 : 1024 }

    // MARK: - Apply

    /// Polishes one call's audio in place. `nil` settings: untouched.
    @discardableResult
    public static func apply(_ x: inout [Float], sampleRate: Int, settings: Settings?) -> Report {
        guard let settings, !x.isEmpty, sampleRate >= 8000, settings.strength > 0 || settings.wordBlend > 0 else { return Report() }
        let started = Date()
        let st = STFT(x, sampleRate: sampleRate)
        let a = analyze(st, settings)
        let s = settings, T = st.frames, K = st.bins
        var report = Report()
        report.frames = T
        report.breathFrames = a.breath.filter { $0 }.count

        // Weights over time: the breath mask (soft, ~40 ms), the breathy-word weight (voiced frames only).
        var mask = gaussian(a.breath.map { $0 ? 1.0 : 0.0 }, sigma: 2).map { min(1, max(0, $0 * 1.5)) * s.strength }
        if !(s.strength > 0 && a.breath.contains(true)) { mask = [Double](repeating: 0, count: T) }
        var w = gaussian(a.share.map { min(1, max(0, ($0 - s.wordRampFrom) / s.wordRampSpan)) }, sigma: 2).map { $0 * s.wordBlend }
        for t in 0..<T where !a.voiced[t] || s.wordBlend <= 0 { w[t] = 0 }
        report.wordFrames = w.filter { $0 > 0.2 }.count
        let touched = (0..<T).filter { mask[$0] > 1e-3 || w[$0] > 1e-3 }
        report.touchedFrames = touched.count
        guard !touched.isEmpty else { report.ms = Date().timeIntervalSince(started) * 1000; return report }

        let f = st.freqs
        // Log-frequency grid for the breath smoothing (300 points, 30 Hz to Nyquist).
        let lf = f.map { log2(max($0, 30)) }
        let g0 = lf[0], g1 = lf[K - 1]
        let grid = (0..<300).map { g0 + (g1 - g0) * Double($0) / 299 }
        let sig = max(0.3, s.smoothOctaves * (300 / (g1 - g0)) / 2.355)
        let bins = (0..<K).map { Double($0) }
        let bandOf = bandIndex(f)

        var xs: [[Complex]] = [], ys: [[Complex]] = []
        xs.reserveCapacity(touched.count); ys.reserveCapacity(touched.count)
        for t in touched {
            let X = st.spectrum(t)
            var Y = X
            let ph = X.map { atan2($0.im, $0.re) }
            if mask[t] > 1e-3 {
                // Fix A: the frame's spectrum without its harmonic peaks, with new phase.
                let logM = X.map { log(($0.re * $0.re + $0.im * $0.im).squareRoot() + 1e-9) }
                let smooth = gaussian(interp(grid, lf, logM), sigma: sig)
                let ms = interp(lf, grid, smooth).map { exp($0) }
                let u = noise(seed: s.seed, fix: 1, frame: t, bins: Array(0..<K))
                let m = mask[t]
                var mixed = X
                for k in 0..<K {
                    let p = ph[k] + s.phase * u[k]
                    mixed[k] = Complex(re: X[k].re * (1 - m) + ms[k] * cos(p) * m, im: X[k].im * (1 - m) + ms[k] * sin(p) * m)
                }
                Y = matchBands(mixed, to: X, band: bandOf, keep: s.keepLevel)
            }
            if w[t] > 1e-3 {
                // Fix B: the air between her harmonics above the cutoff, rebuilt from its own envelope.
                let f0 = a.f0[t]
                let harm = f.map { (fq: Double) -> Bool in let h = fq / f0; return abs(h - h.rounded()) < harmTolerance }
                let idx = (0..<K).filter { !harm[$0] }
                if idx.count >= 8 {
                    let logMY = idx.map { k in log((Y[k].re * Y[k].re + Y[k].im * Y[k].im).squareRoot() + 1e-9) }
                    let env = gaussian(interp(bins, idx.map { Double($0) }, logMY).map { exp($0) }, sigma: s.envelopeBins)
                    let sb = (0..<K).filter { f[$0] >= s.cutoffHz && !harm[$0] }
                    let u = noise(seed: s.seed, fix: 2, frame: t, bins: sb)
                    var old: [Complex] = [], new: [Complex] = []
                    old.reserveCapacity(sb.count); new.reserveCapacity(sb.count)
                    for (j, k) in sb.enumerated() {
                        let p = ph[k] + s.wordPhase * u[j]
                        old.append(Y[k])
                        new.append(Complex(re: Y[k].re * (1 - w[t]) + env[k] * cos(p) * w[t], im: Y[k].im * (1 - w[t]) + env[k] * sin(p) * w[t]))
                    }
                    let matched = matchBands(new, to: old, band: sb.map { bandOf[$0] }, keep: s.keepLevel)
                    for (j, k) in sb.enumerated() { Y[k] = matched[j] }
                }
            }
            xs.append(X); ys.append(Y)
        }

        var z = st.render(touched: touched, x: xs, y: ys)
        if s.keepLevel > 0, s.levelPasses > 0 {
            // Overlap-add of frames with new phases loses power: measure the output, restore each band's power per frame
            // (3-frame averages, gain 0.5-2.5).
            let need = Array(Set(touched.flatMap { [max(0, $0 - 1), $0, min(T - 1, $0 + 1)] })).sorted()
            for _ in 0..<s.levelPasses {
                var bz: [Int: [Double]] = [:]
                for t in need { bz[t] = bandPower(st.spectrum(t, of: z), band: bandOf) }
                for (i, t) in touched.enumerated() {
                    let tm = t > 0 ? t - 1 : t, tp = t < T - 1 ? t + 1 : t
                    var g = [Double](repeating: 1, count: 9)
                    for b in 0..<9 {
                        let num = (a.bands[tm][b] + a.bands[t][b] + a.bands[tp][b]) / 3
                        let den = ((bz[tm]?[b] ?? 0) + (bz[t]?[b] ?? 0) + (bz[tp]?[b] ?? 0)) / 3
                        var gain = (num / (den + 1e-20)).squareRoot()
                        if !gain.isFinite { gain = 1 }
                        g[b] = 1 - s.keepLevel + s.keepLevel * min(2.5, max(0.5, gain))
                    }
                    for k in 0..<K where bandOf[k] >= 0 {
                        ys[i][k].re *= g[bandOf[k]]; ys[i][k].im *= g[bandOf[k]]
                    }
                }
                z = st.render(touched: touched, x: xs, y: ys)
            }
        }
        let half = st.n / 2
        for i in 0..<x.count { x[i] = Float(min(1, max(-1, z[half + i]))) }
        report.ms = Date().timeIntervalSince(started) * 1000
        return report
    }

    /// Power spectrum of every frame (bins 0...N/2), the frames the polish works on: tests compare them with the PC's.
    public static func powerFrames(_ x: [Float], sampleRate: Int) -> [[Double]] {
        let st = STFT(x, sampleRate: sampleRate)
        return (0..<st.frames).map { (t: Int) -> [Double] in st.spectrum(t).map { (c: Complex) -> Double in c.re * c.re + c.im * c.im } }
    }

    /// The analysis alone (tests, the Voice Lab's log).
    public static func analyze(_ x: [Float], sampleRate: Int, settings: Settings = Settings()) -> Analysis {
        analyze(STFT(x, sampleRate: sampleRate), settings)
    }

    static func analyze(_ st: STFT, _ s: Settings) -> Analysis {
        let T = st.frames, K = st.bins, N = st.n, sr = Double(st.sampleRate), f = st.freqs
        var a = Analysis(fftSize: N, hop: st.hop)
        a.db = .init(repeating: 0, count: T); a.centroid = a.db; a.voicing = a.db; a.f0 = a.db; a.share = a.db
        a.voiced = .init(repeating: false, count: T); a.bands = .init(repeating: [], count: T)
        let lo = Int((sr / fMax).rounded(.down)), hi = min(N - 2, Int((sr / fMin).rounded(.up)))
        let bandOf = bandIndex(f)
        let fft2 = RealFFT(2 * N)
        // The window's own autocorrelation (Boersma): the frame's is divided by it, so a steady tone reads ~1 at its lag.
        var rw = fft2.autocorrelation(st.window)
        let rw0 = rw[0]
        for i in rw.indices { rw[i] /= rw0 }
        for t in 0..<T {
            let frame = st.windowedFrame(t, of: nil)
            let X = st.fft.forward(frame)
            var p2 = [Double](repeating: 0, count: K)
            var sumP = 0.0, sumM = 0.0, sumMF = 0.0
            for k in 0..<K {
                let pk = X[k].re * X[k].re + X[k].im * X[k].im
                p2[k] = pk; sumP += pk
                let m = pk.squareRoot(); sumM += m; sumMF += m * f[k]
            }
            a.db[t] = 10 * log10(sumP / Double(K) + 1e-18)
            a.centroid[t] = sumMF / (sumM + 1e-9)
            a.bands[t] = bandPower(p2, band: bandOf)
            let r = fft2.autocorrelation(frame)
            guard r[0] > 1e-20 else { continue }
            let seg = (lo...hi).map { (r[$0] / r[0]) / max(rw[$0], 1e-6) }
            // The highest local maximum, with Praat's small octave cost for longer lags (0.01 per octave).
            var best = -1.0, bl = 0
            if seg.count >= 3 {
                for i in 1..<(seg.count - 1) where seg[i] >= seg[i - 1] && seg[i] > seg[i + 1] {
                    let score = seg[i] - 0.01 * log2(Double(lo + i) / Double(lo))
                    if score > best { best = score; bl = i }
                }
            }
            guard bl > 0 else { continue }
            let y0 = seg[bl - 1], y1 = seg[bl], y2 = seg[bl + 1], den = y0 - 2 * y1 + y2
            let off = den < 0 ? min(0.5, max(-0.5, 0.5 * (y0 - y2) / den)) : 0
            a.voicing[t] = min(1, max(0, y1 - 0.25 * (y0 - y2) * off))
            a.f0[t] = sr / (Double(lo + bl) + off)
            if a.voicing[t] > s.voicedFrom {
                a.voiced[t] = true
                var eh = 0.0, en = 0.0
                for k in 0..<K where f[k] >= 1000 {
                    let h = f[k] / a.f0[t]
                    if abs(h - h.rounded()) < harmTolerance { eh += p2[k] } else { en += p2[k] }
                }
                a.share[t] = en / (eh + en + 1e-12)
            }
        }
        a.breath = breathFrames(a, s, hopSeconds: Double(st.hop) / sr)
        return a
    }

    static func breathFrames(_ a: Analysis, _ s: Settings, hopSeconds: Double) -> [Bool] {
        let T = a.db.count
        guard T > 0, let top = a.db.max() else { return [] }
        // The floor: 10th percentile, without digital silence (a call's padded edges).
        let floor = percentile(a.db.filter { $0 > top - 100 }, 10) ?? a.db.min() ?? top
        let speechFrames = (0..<T).filter { a.voicing[$0] > s.speechFrom }.map { a.db[$0] }
        let speech = speechFrames.isEmpty ? top - 10 : (percentile(speechFrames, 50) ?? top - 10)
        let cand = (0..<T).map {
            a.voicing[$0] < s.breathVoicing && a.db[$0] > floor + s.aboveFloorDB && a.db[$0] < speech - s.belowSpeechDB
                && a.centroid[$0] < s.centroidHz
        }
        var br = [Bool](repeating: false, count: T)
        var t = 0
        while t < T {
            guard cand[t] else { t += 1; continue }
            let start = t
            while t < T, cand[t] { t += 1 }
            if Double(t - start) * hopSeconds >= s.minBreathSeconds { for i in start..<t { br[i] = true } }
        }
        return br
    }

    // MARK: - Helpers (each written as its numpy / scipy counterpart in the PC simulation)

    struct Complex: Sendable { var re: Double; var im: Double }

    /// numpy.percentile (linear interpolation).
    static func percentile(_ v: [Double], _ q: Double) -> Double? {
        guard !v.isEmpty else { return nil }
        let s = v.sorted(), pos = q / 100 * Double(s.count - 1), i = Int(pos.rounded(.down)), fr = pos - Double(i)
        return i + 1 < s.count ? s[i] + (s[i + 1] - s[i]) * fr : s[i]
    }

    /// scipy.ndimage.gaussian_filter1d(mode: "reflect", truncate: 4).
    static func gaussian(_ a: [Double], sigma: Double) -> [Double] {
        let n = a.count
        guard n > 0, sigma > 0 else { return a }
        let r = Int(4 * sigma + 0.5)
        var k = (-r...r).map { exp(-0.5 * pow(Double($0) / sigma, 2)) }
        let sum = k.reduce(0, +)
        for i in k.indices { k[i] /= sum }
        var out = [Double](repeating: 0, count: n)
        for i in 0..<n {
            var acc = 0.0
            for j in -r...r {
                var idx = i + j
                if idx < 0 { idx = -idx - 1 }
                if idx >= n { idx = 2 * n - idx - 1 }
                idx = min(n - 1, max(0, idx))
                acc += k[j + r] * a[idx]
            }
            out[i] = acc
        }
        return out
    }

    /// numpy.interp: `xp` non-decreasing; outside it the end values; at a repeated `xp` the last one's value.
    static func interp(_ x: [Double], _ xp: [Double], _ fp: [Double]) -> [Double] {
        let m = xp.count
        guard m > 0 else { return x.map { _ in 0 } }
        return x.map { v in
            if v < xp[0] { return fp[0] }
            if v >= xp[m - 1] { return fp[m - 1] }
            // The largest j with xp[j] <= v (then xp[j + 1] > v).
            var lo = 0, hi = m - 1
            while hi - lo > 1 { let mid = (lo + hi) / 2; if xp[mid] <= v { lo = mid } else { hi = mid } }
            let span = xp[lo + 1] - xp[lo]
            return span > 0 ? fp[lo] + (fp[lo + 1] - fp[lo]) * (v - xp[lo]) / span : fp[lo]
        }
    }

    /// Octave band (0-8, from 62.5 Hz) of each bin; -1 outside 62.5 Hz-16 kHz.
    static func bandIndex(_ f: [Double]) -> [Int] {
        f.map { fq in
            for b in 0..<9 where fq >= bandEdges[b] && fq < bandEdges[b + 1] { return b }
            return -1
        }
    }

    static func bandPower(_ p2: [Double], band: [Int]) -> [Double] {
        var out = [Double](repeating: 0, count: 9)
        for k in p2.indices where band[k] >= 0 { out[band[k]] += p2[k] }
        return out
    }

    static func bandPower(_ X: [Complex], band: [Int]) -> [Double] {
        bandPower(X.map { $0.re * $0.re + $0.im * $0.im }, band: band)
    }

    /// Rescales `y` so each octave band's power equals `x`'s (`keep` of the way); bins outside the bands as they are.
    static func matchBands(_ y: [Complex], to x: [Complex], band: [Int], keep: Double) -> [Complex] {
        guard keep > 0 else { return y }
        let px = bandPower(x, band: band), py = bandPower(y, band: band)
        var present = [Bool](repeating: false, count: 9)
        for b in band where b >= 0 { present[b] = true }
        var out = y
        for i in y.indices where band[i] >= 0 && present[band[i]] {
            let g = 1 - keep + keep * (px[band[i]] / (py[band[i]] + 1e-20)).squareRoot()
            out[i].re *= g; out[i].im *= g
        }
        return out
    }

    /// Uniform phase offsets in [-π, π): SplitMix64 of the counter (fix << 48 | frame << 16 | bin), plus the seed.
    static func noise(seed: Int, fix: UInt64, frame: Int, bins: [Int]) -> [Double] {
        let base = (fix << 48) | (UInt64(frame) << 16)
        return bins.map { k in
            var z = UInt64(bitPattern: Int64(seed)) &+ ((base | UInt64(k)) &+ 1) &* 0x9E37_79B9_7F4A_7C15
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            z = z ^ (z >> 31)
            let u = Double(z >> 11) * (1.0 / 9_007_199_254_740_992.0)
            return (u * 2 - 1) * Double.pi
        }
    }

    /// The centred STFT librosa uses (periodic Hann, N/2 zeros each side), its frames, and the overlap-add back.
    final class STFT {
        let sampleRate: Int, n: Int, hop: Int, count: Int, frames: Int, bins: Int
        let padded: [Double]
        let window: [Double]
        let freqs: [Double]
        let fft: RealFFT
        /// Sum of the squared window over all frames, per padded sample (the ISTFT's normaliser).
        let wss: [Double]

        init(_ x: [Float], sampleRate: Int) {
            let size = BreathPolish.fftSize(sampleRate: sampleRate), h = size / 4, nFrames = 1 + x.count / h
            var p = [Double](repeating: 0, count: size / 2 + x.count + size / 2 + size)
            for i in x.indices { p[size / 2 + i] = Double(x[i]) }
            let win = (0..<size).map { 0.5 - 0.5 * cos(2 * Double.pi * Double($0) / Double(size)) }
            var s = [Double](repeating: 0, count: p.count)
            for t in 0..<nFrames { for i in 0..<size { s[t * h + i] += win[i] * win[i] } }
            self.sampleRate = sampleRate
            n = size
            hop = h
            self.count = x.count
            frames = nFrames
            bins = size / 2 + 1
            padded = p
            window = win
            freqs = (0..<(size / 2 + 1)).map { Double($0) * Double(sampleRate) / Double(size) }
            fft = RealFFT(size)
            wss = s
        }

        func windowedFrame(_ t: Int, of signal: [Double]?) -> [Double] {
            let src = signal ?? padded, o = t * hop
            return (0..<n).map { src[o + $0] * window[$0] }
        }

        func spectrum(_ t: Int, of signal: [Double]? = nil) -> [Complex] {
            fft.forward(windowedFrame(t, of: signal))
        }

        /// The input plus the overlap-added difference of the touched frames (a linear ISTFT of the whole edited
        /// spectrogram gives the same: the untouched frames give back the input).
        func render(touched: [Int], x: [[Complex]], y: [[Complex]]) -> [Double] {
            var z = padded
            for (i, t) in touched.enumerated() {
                let d = fft.inverse(zip(y[i], x[i]).map { Complex(re: $0.re - $1.re, im: $0.im - $1.im) })
                let o = t * hop
                for j in 0..<n { z[o + j] += d[j] * window[j] / max(wss[o + j], 1e-8) }
            }
            return z
        }
    }

    /// vDSP's real FFT (single precision; the analysis around it in Double). Forward gives the true DFT (bins 0...n/2),
    /// inverse the true inverse (numpy.fft.rfft / irfft).
    final class RealFFT {
        let n: Int
        private let setup: vDSP.FFT<DSPSplitComplex>

        init(_ n: Int) {
            let log2n = vDSP_Length(log2(Double(n)).rounded())
            guard let fft = vDSP.FFT(log2n: log2n, radix: .radix2, ofType: DSPSplitComplex.self) else {
                fatalError("vDSP.FFT setup failed for n=\(n)")
            }
            self.n = n
            setup = fft
        }

        private func run(_ re: inout [Float], _ im: inout [Float], inverse: Bool) {
            re.withUnsafeMutableBufferPointer { r in
                im.withUnsafeMutableBufferPointer { i in
                    var split = DSPSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
                    if inverse { setup.inverse(input: split, output: &split) } else { setup.forward(input: split, output: &split) }
                }
            }
        }

        func forward(_ x: [Double]) -> [Complex] {
            let h = n / 2
            var re = [Float](repeating: 0, count: h), im = [Float](repeating: 0, count: h)
            for i in 0..<min(h, (x.count + 1) / 2) {
                re[i] = Float(x[2 * i])
                if 2 * i + 1 < x.count { im[i] = Float(x[2 * i + 1]) }
            }
            run(&re, &im, inverse: false)
            // zrip packs DC in re[0] and Nyquist in im[0], everything doubled.
            var out = [Complex](repeating: Complex(re: 0, im: 0), count: h + 1)
            out[0] = Complex(re: Double(re[0]) / 2, im: 0)
            out[h] = Complex(re: Double(im[0]) / 2, im: 0)
            for k in 1..<h { out[k] = Complex(re: Double(re[k]) / 2, im: Double(im[k]) / 2) }
            return out
        }

        func inverse(_ X: [Complex]) -> [Double] {
            let h = n / 2
            var re = [Float](repeating: 0, count: h), im = [Float](repeating: 0, count: h)
            re[0] = Float(X[0].re); im[0] = Float(X[h].re)
            for k in 1..<h { re[k] = Float(X[k].re); im[k] = Float(X[k].im) }
            run(&re, &im, inverse: true)
            // The inverse of the true DFT comes back n times too big.
            var out = [Double](repeating: 0, count: n)
            for i in 0..<h { out[2 * i] = Double(re[i]) / Double(n); out[2 * i + 1] = Double(im[i]) / Double(n) }
            return out
        }

        /// Autocorrelation of `x` (zero-padded to n, so no wrap for lags under n - count), lags 0..<n/2.
        func autocorrelation(_ x: [Double]) -> [Double] {
            let X = forward(x)
            let p = X.map { Complex(re: $0.re * $0.re + $0.im * $0.im, im: 0) }
            return Array(inverse(p).prefix(n / 2))
        }
    }
}
