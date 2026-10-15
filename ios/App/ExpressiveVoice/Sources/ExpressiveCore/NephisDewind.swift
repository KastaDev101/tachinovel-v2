//
//  NephisDewind.swift — the de-wind cleaner (pack.json chain "dewind", Kasta 2026-10-15): removes the faint wind her
//  source audio taught her voice. A DeepFilterNet3 model (Rikorose/DeepFilterNet, MIT/Apache-2.0; THIRD_PARTY_NOTICES.md)
//  fine-tuned in tachinovel-tts-lab (human-voice/debuzz/train_dewind.py), run at 48 kHz. Kasta's locked narration sound
//  runs it twice:
//
//    "dewind": {"passes": 2}        1 or 2 (clamped); absent, unreadable or 0 = off, every call bit-identical
//
//    call (44.1 kHz studio / 24 kHz Mimi) -> up to 48 kHz -> pass -> pass -> down to the call's rate
//
//  This file is the signal processing, a line-by-line port of the lab's streaming reference (coreml-swap/dewind/
//  dewind_stream.py and PORTING.md, which match the PC's offline enhance() at ~127 dB SNR); the network is behind
//  `DewindNetwork` (NephisDewindModel.swift: Core ML, shipped in the voice pack under Models/nephis-dewind).
//
//  Resampling   scipy.signal.resample_poly's defaults, streamed: Kaiser (beta 5) windowed sinc, 2·10·max(up, down) + 1
//               taps, polyphase; accumulated in Double. 44.1 kHz: up 160 / down 147; 24 kHz: up 2 / down 1.
//  One pass     (libdf, all Float32) per 480 new samples: Vorbis-windowed 960-point frame, X = rfft / 960 (vDSP's real
//               DFT, 960 = 15 · 64); 32 ERB features 10·log10(band power + 1e-10) under an exponential mean (alpha 0.99,
//               from -60…-90 dB), /40; 96 deep-filter features X / sqrt(exp. mean of |X|) (from 0.001…0.0001). Model step
//               t runs on the features of frame t + 2 (frames 0 and 1 only warm the norms); bins >= 96 get the ERB gain
//               of their band, bins < 96 the 5-tap deep filter over frames t-2…t+2 (raw spectra, complex, no
//               conjugate); synthesis irfft · 960 · window, overlap-add; the first 480 output samples are dropped (the
//               STFT delay). End of stream: 960 zeros as hops (the partial hop dropped), then 2 steps on zero features
//               and zero future spectra, output trimmed to the input length. The network takes N frames per call (the
//               pack's model: 8), so the history keeps N + 4 spectra and a flush pads the last block.
//
//  Calls and their joins (NephisDewind.Stream): one chain runs over a read, call after call, so the norms, the GRU
//  states, the STFT overlap and the resamplers carry from call to call. The chain holds back about 70 ms (2 × 1,440
//  samples at 48 kHz of algorithmic latency, the hop remainders, the resamplers' ~11 samples) plus up to 7 frames per
//  pass while a block of 8 fills: ~200 ms at most. A call must keep its length and be complete when it is returned (her
//  last word's fade-out ends the call; held back, it would wait for the next call or be lost to a fresh read: the soft
//  final "s" of 2026-10-12). So each call is returned as: the chain's real output, then the rest of the call from a copy
//  of the chain that is fed `joinFade` (5 ms) of silence and flushed, exactly the end of stream above. The real chain
//  goes on with the true audio; its output for the samples already returned is dropped at the next call, and the first
//  5 ms of the next call are crossfaded from the copy's continuation (what was played assumed silence) into the true
//  output. Only the last ~60-80 ms of a call (two passes' lookahead over her fade-out into the pause the next call starts
//  with) differ from one offline run over the whole read; everything else is sample for sample the same, and nothing is
//  lost or doubled. A new read, a seek or a new chapter starts a fresh chain; the read's last call is simply complete.
//
//  Cost per pass (48 kHz): the network 3.3 M MAC per 10 ms frame (0.33 GMAC per audio second; Core ML on the CPU in
//  blocks of 8 frames), the DSP ~4 Mflop per second, the resamplers ~2 M MAC per second; the copy at each call's end
//  adds ~2 model calls per pass. Runs on the synthesis worker (NephisFlowSynth's decode jobs), never the render thread.
//

import Accelerate
import Foundation

public enum NephisDewind {
    /// pack.json chain "dewind": {"passes": 2}. `passes` is needed (a block without it is unreadable: off); clamped to
    /// 0…2, 0 = off.
    public struct Settings: Codable, Sendable, Equatable {
        public var passes: Int

        public init(passes: Int) {
            self.passes = min(2, max(0, passes))
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let raw = try c.decode(Double.self, forKey: .passes)
            self.init(passes: raw.isFinite ? Int(min(2, max(0, raw.rounded()))) : 0)
        }

        public var on: Bool { passes > 0 }
    }

    // MARK: - Constants (libdf, DeepFilterNet3's config)

    public static let sampleRate = 48_000
    static let fftSize = 960
    static let hop = 480
    static let bins = 481
    static let erbBands = 32
    static let dfBins = 96
    static let dfOrder = 5
    /// Model features are shifted 2 frames (conv_lookahead), and the deep filter reaches 2 frames ahead (df_lookahead).
    static let lookahead = 2
    /// One pass's algorithmic latency at 48 kHz: the STFT overlap (480) plus 2 frames of lookahead.
    public static let passDelay = (fftSize - hop) + lookahead * hop
    static let alpha = Float(0.99)
    static let oneMinusAlpha = Float(1 - 0.99)
    /// The crossfade at a call's start from what the call before assumed (silence after it) into the true output.
    public static let joinFadeSeconds = 0.005

    /// ERB band widths in bins (sum 481) and each bin's band.
    public static let erbWidths: [Int] = [Int](repeating: 2, count: 13) + [5, 5, 7, 7, 8, 10, 12, 13, 15, 18, 20, 24, 28, 31, 37, 42, 50, 56, 67]
    public static let bandOfBin: [Int] = erbWidths.enumerated().flatMap { band, width in [Int](repeating: band, count: width) }
    /// The Vorbis window, computed in Double: w[i] = sin(π/2 · sin²(π(i + 0.5)/960)).
    public static let window: [Float] = (0..<fftSize).map { i in
        let s = sin(Double.pi * (Double(i) + 0.5) / Double(fftSize))
        return Float(sin(0.5 * Double.pi * s * s))
    }

    /// numpy.linspace(a, b, n) cast to Float32: the norms' initial states.
    static func linspace(_ a: Double, _ b: Double, _ n: Int) -> [Float] {
        let step = (b - a) / Double(n - 1)
        return (0..<n).map { i in Float(i == n - 1 ? b : Double(i) * step + a) }
    }

    public static let erbNormInit = linspace(-60, -90, erbBands)
    public static let unitNormInit = linspace(0.001, 0.0001, dfBins)

    // MARK: - The network's interface

    /// What the network carries from frame to frame (all zeros at a stream's start): the last 2 ERB and DF feature frames,
    /// the last 4 frames of its first DF conv, and the 5 GRU states (encoder, ERB decoder 2, DF decoder 2), in the Core ML
    /// model's own layouts ([1,1,2,32], [1,2,2,96], [1,64,4,96], [5,256]).
    public struct NetState: Sendable, Equatable {
        public var erbBuf = [Float](repeating: 0, count: 64)
        public var specBuf = [Float](repeating: 0, count: 384)
        public var c0Buf = [Float](repeating: 0, count: 24_576)
        public var h = [Float](repeating: 0, count: 1_280)
        public init() {}
    }

    // MARK: - Spectra and the 960-point real DFT

    struct Spectrum: Sendable {
        var re: [Float]
        var im: [Float]
        static let zero = Spectrum(re: [Float](repeating: 0, count: bins), im: [Float](repeating: 0, count: bins))
    }

    /// vDSP's real DFT for 960 points (vDSP_fft_zrip only does powers of two). Its packing (DC and Nyquist together in
    /// bin 0) and scale (forward 2×, inverse N×) are measured once at setup, so the transforms here are the true DFT and
    /// the unnormalised inverse (numpy's irfft · n). Setups are read-only once made: one instance serves every thread.
    final class RealDFT: @unchecked Sendable {
        static let shared = RealDFT(n: fftSize)

        let n: Int
        private let forwardSetup: OpaquePointer
        private let inverseSetup: OpaquePointer
        private let forwardScale: Float
        private let forwardSign: Float
        private let inverseScale: Float

        init?(n: Int) {
            guard n % 2 == 0, let f = vDSP_DFT_zrop_CreateSetup(nil, vDSP_Length(n), .FORWARD) else { return nil }
            guard let i = vDSP_DFT_zrop_CreateSetup(nil, vDSP_Length(n), .INVERSE) else {
                vDSP_DFT_DestroySetup(f)
                return nil
            }
            let h = n / 2
            // An impulse at 0: every bin of the true DFT is 1, so DC (packed in bin 0's real part) is the forward scale.
            var impulse = [Float](repeating: 0, count: n)
            impulse[0] = 1
            let dc = Self.execute(f, even: Self.evens(impulse), odd: Self.odds(impulse)).0[0]
            // An impulse at 1: bin 1 of the true DFT is e^(-2πi/n), its imaginary part negative.
            impulse[0] = 0
            impulse[1] = 1
            let bin1 = Self.execute(f, even: Self.evens(impulse), odd: Self.odds(impulse)).1[1]
            // All ones (DC and Nyquist 1, the rest 1 + 0i): the unnormalised inverse is n at sample 0.
            let y0 = Self.execute(i, even: [Float](repeating: 1, count: h), odd: [Float](repeating: 1, count: h)).0[0]
            guard dc.isFinite, dc != 0, y0.isFinite, y0 != 0 else {
                vDSP_DFT_DestroySetup(f)
                vDSP_DFT_DestroySetup(i)
                return nil
            }
            self.n = n
            forwardSetup = f
            inverseSetup = i
            forwardScale = 1 / dc
            forwardSign = bin1 * dc < 0 ? 1 : -1
            inverseScale = Float(n) / y0
        }

        deinit {
            vDSP_DFT_DestroySetup(forwardSetup)
            vDSP_DFT_DestroySetup(inverseSetup)
        }

        private static func evens(_ x: [Float]) -> [Float] { stride(from: 0, to: x.count, by: 2).map { x[$0] } }
        private static func odds(_ x: [Float]) -> [Float] { stride(from: 1, to: x.count, by: 2).map { x[$0] } }

        private static func execute(_ setup: OpaquePointer, even: [Float], odd: [Float]) -> ([Float], [Float]) {
            var outRe = [Float](repeating: 0, count: even.count)
            var outIm = [Float](repeating: 0, count: even.count)
            even.withUnsafeBufferPointer { ir in
                odd.withUnsafeBufferPointer { ii in
                    outRe.withUnsafeMutableBufferPointer { or in
                        outIm.withUnsafeMutableBufferPointer { oi in
                            vDSP_DFT_Execute(setup, ir.baseAddress!, ii.baseAddress!, or.baseAddress!, oi.baseAddress!)
                        }
                    }
                }
            }
            return (outRe, outIm)
        }

        /// The true DFT of `x` (n real samples) times `scale`: bins 0…n/2.
        func forward(_ x: [Float], scale: Float) -> Spectrum {
            let h = n / 2
            let (pr, pi) = Self.execute(forwardSetup, even: Self.evens(x), odd: Self.odds(x))
            let s = forwardScale * scale, si = s * forwardSign
            var re = [Float](repeating: 0, count: h + 1)
            var im = [Float](repeating: 0, count: h + 1)
            re[0] = pr[0] * s
            re[h] = pi[0] * s
            for k in 1..<h {
                re[k] = pr[k] * s
                im[k] = pi[k] * si
            }
            return Spectrum(re: re, im: im)
        }

        /// Σ_k Y[k] e^(+2πikt/n) over the whole Hermitian spectrum (numpy's irfft · n): n real samples. The imaginary
        /// parts of DC and Nyquist are ignored, as irfft does.
        func inverse(_ y: Spectrum) -> [Float] {
            let h = n / 2
            var er = [Float](repeating: 0, count: h)
            var ei = [Float](repeating: 0, count: h)
            er[0] = y.re[0]
            ei[0] = y.re[h]
            for k in 1..<h {
                er[k] = y.re[k]
                ei[k] = y.im[k] * forwardSign
            }
            let (a, b) = Self.execute(inverseSetup, even: er, odd: ei)
            var out = [Float](repeating: 0, count: n)
            for j in 0..<h {
                out[2 * j] = a[j] * inverseScale
                out[2 * j + 1] = b[j] * inverseScale
            }
            return out
        }
    }

    public enum DewindError: Error, CustomStringConvertible {
        case noDFT
        case badNetwork(String)

        public var description: String {
            switch self {
            case .noDFT: return "no 960-point DFT"
            case .badNetwork(let why): return "network: \(why)"
            }
        }
    }

    // MARK: - Resampling (scipy.signal.resample_poly, streamed)

    /// The streaming twin of resample_poly(x, up, down) (padtype constant): output j = Σ_m P[n % up][m] · x[n / up - m]
    /// with n = (j + pre) · down, x outside the stream = 0. Output j is returned once x[n / up] has arrived; `flush`
    /// returns the rest, ceil(inputs · up / down) outputs in all. In Double, as scipy.
    struct StreamResampler: Sendable {
        let up: Int
        let down: Int
        /// Outputs scipy removes at the start, and taps per phase.
        let pre: Int
        let taps: Int
        /// Per phase, the taps reversed (so an output is a forward dot product over the input).
        let reversed: [[Double]]
        private var history: [Double]
        private var inputs = 0
        private var outputs = 0

        init(from: Int, to: Int) {
            let g = Self.gcd(from, to)
            let u = to / g, d = from / g
            let maxRate = max(u, d)
            let half = 10 * maxRate
            let length = 2 * half + 1
            let fc = 1 / Double(maxRate)
            let i0Beta = Self.besselI0(5)
            // firwin(2 · half + 1, 1 / maxRate, window = ("kaiser", 5)): the windowed sinc, summing to 1; then × up.
            var h = (0..<length).map { k -> Double in
                let x = fc * Double(k - half)
                let sinc = x == 0 ? 1 : sin(Double.pi * x) / (Double.pi * x)
                let r = 2 * Double(k) / Double(length - 1) - 1
                return fc * sinc * Self.besselI0(5 * (max(0, 1 - r * r)).squareRoot()) / i0Beta
            }
            let sum = h.reduce(0, +)
            h = h.map { $0 / sum * Double(u) }
            let prePad = d - half % d
            var padded = [Double](repeating: 0, count: prePad) + h
            let m = (padded.count + u - 1) / u
            padded += [Double](repeating: 0, count: m * u - padded.count)
            up = u
            down = d
            pre = (half + prePad) / d
            taps = m
            reversed = (0..<u).map { phase in (0..<m).map { j in padded[phase + u * (m - 1 - j)] } }
            history = [Double](repeating: 0, count: m)
        }

        /// P[phase][m] (resample_poly's polyphase table), for the tests.
        func polyphase(_ phase: Int) -> [Double] { reversed[phase].reversed() }

        static func gcd(_ a: Int, _ b: Int) -> Int { b == 0 ? a : gcd(b, a % b) }

        /// The modified Bessel function I0 (power series; |x| <= 5 here).
        static func besselI0(_ x: Double) -> Double {
            var sum = 1.0, term = 1.0, k = 1.0
            let q = x * x / 4
            while term > 1e-18 * sum {
                term *= q / (k * k)
                sum += term
                k += 1
            }
            return sum
        }

        private mutating func emit(_ all: [Double], base: Int, until end: Int) -> [Double] {
            guard end > outputs else { return [] }
            var y = [Double](repeating: 0, count: end - outputs)
            all.withUnsafeBufferPointer { xa in
                for j in outputs..<end {
                    let n = (j + pre) * down
                    let start = n / up - base - (taps - 1)
                    reversed[n % up].withUnsafeBufferPointer { p in
                        var acc = 0.0
                        vDSP_dotprD(p.baseAddress!, 1, xa.baseAddress! + start, 1, &acc, vDSP_Length(taps))
                        y[j - outputs] = acc
                    }
                }
            }
            outputs = end
            return y
        }

        mutating func process(_ x: [Double]) -> [Double] {
            guard !x.isEmpty else { return [] }
            let base = inputs - taps
            let all = history + x
            inputs += x.count
            // Output j is ready when its newest input, (j + pre) · down / up, has arrived.
            var end = max(outputs, (inputs * up + down - 1) / down - pre)
            while end > outputs, ((end - 1 + pre) * down) / up >= inputs { end -= 1 }
            let y = emit(all, base: base, until: end)
            history = Array(all.suffix(taps))
            return y
        }

        mutating func flush() -> [Double] {
            let total = (inputs * up + down - 1) / down
            return emit(history + [Double](repeating: 0, count: 2 * taps), base: inputs - taps, until: total)
        }
    }

    // MARK: - One pass at 48 kHz

    struct Pass: Sendable {
        let frames: Int
        private var analysisMemory = [Float](repeating: 0, count: hop)
        private var synthesisMemory = [Float](repeating: 0, count: hop)
        private var erbNorm = NephisDewind.erbNormInit
        private var unitNorm = NephisDewind.unitNormInit
        private var pending: [Float] = []
        /// Analysis frames done, and the spectra kept (frames spectraBase ..< spectraBase + spectra.count).
        private var analysed = 0
        private var spectra: [Spectrum] = []
        private var spectraBase = 0
        /// Features waiting for the next network call, and the output frames made so far.
        private var blockErb: [[Float]] = []
        private var blockRe: [[Float]] = []
        private var blockIm: [[Float]] = []
        private var produced = 0
        private var state = NetState()
        private(set) var inputs = 0
        private var outputs = 0
        private var skip = fftSize - hop

        init(frames: Int) {
            self.frames = max(1, frames)
        }

        // Taps for the tests (dsp vectors): every analysis frame and every output frame.
        struct Trace: Sendable {
            var spectra: [Spectrum] = []
            var erb: [[Float]] = []
            var specRe: [[Float]] = []
            var specIm: [[Float]] = []
            var enhanced: [Spectrum] = []
            var synthesised: [[Float]] = []
        }
        var trace: Trace?

        private mutating func analyse(_ x: ArraySlice<Float>, dft: RealDFT) -> Spectrum {
            let w = NephisDewind.window
            var frame = [Float](repeating: 0, count: fftSize)
            var k = 0
            for i in 0..<hop {
                frame[i] = analysisMemory[i] * w[i]
            }
            for v in x {
                frame[hop + k] = v * w[hop + k]
                analysisMemory[k] = v
                k += 1
            }
            return dft.forward(frame, scale: Float(2.0 * Double(hop) / Double(fftSize * fftSize)))
        }

        /// ERB features (dB under the exponential mean, /40) and the unit-normalised DF features of bins 0…95.
        private mutating func features(_ x: Spectrum) -> (erb: [Float], re: [Float], im: [Float]) {
            var sums = [Double](repeating: 0, count: erbBands)
            let band = NephisDewind.bandOfBin
            for k in 0..<bins {
                let p = x.re[k] * x.re[k] + x.im[k] * x.im[k]
                sums[band[k]] += Double(p)
            }
            var erb = [Float](repeating: 0, count: erbBands)
            for b in 0..<erbBands {
                let mean = Float(sums[b] / Double(erbWidths[b]))
                let e = 10 * log10f(mean + Float(1e-10))
                erbNorm[b] = e * oneMinusAlpha + erbNorm[b] * alpha
                erb[b] = (e - erbNorm[b]) / 40
            }
            var re = [Float](repeating: 0, count: dfBins)
            var im = [Float](repeating: 0, count: dfBins)
            for k in 0..<dfBins {
                unitNorm[k] = hypotf(x.re[k], x.im[k]) * oneMinusAlpha + unitNorm[k] * alpha
                // numpy divides a complex64 by a real as x · (1 / s).
                let inv = 1 / unitNorm[k].squareRoot()
                re[k] = x.re[k] * inv
                im[k] = x.im[k] * inv
            }
            return (erb, re, im)
        }

        private func spectrum(_ i: Int) -> Spectrum? {
            guard i >= spectraBase, i - spectraBase < spectra.count else { return nil }
            return spectra[i - spectraBase]
        }

        /// Output frame t's spectrum: the ERB gains above bin 96, the 5-tap deep filter below it.
        private func enhanced(_ t: Int, gains: ArraySlice<Float>, coefs: ArraySlice<Float>) -> Spectrum {
            let band = NephisDewind.bandOfBin
            let xt = spectrum(t) ?? .zero
            var y = Spectrum.zero
            let g0 = gains.startIndex, c0 = coefs.startIndex
            for k in dfBins..<bins {
                let g = gains[g0 + band[k]]
                y.re[k] = xt.re[k] * g
                y.im[k] = xt.im[k] * g
            }
            let taps = (0..<dfOrder).map { spectrum(t - lookahead + $0) }
            for k in 0..<dfBins {
                var ar: Float = 0, ai: Float = 0
                for n in 0..<dfOrder {
                    let cr = coefs[c0 + k * 2 * dfOrder + 2 * n], ci = coefs[c0 + k * 2 * dfOrder + 2 * n + 1]
                    let xr: Float = taps[n]?.re[k] ?? 0, xi: Float = taps[n]?.im[k] ?? 0
                    let pr = xr * cr - xi * ci
                    let pi = xr * ci + xi * cr
                    if n == 0 {
                        ar = pr
                        ai = pi
                    } else {
                        ar += pr
                        ai += pi
                    }
                }
                y.re[k] = ar
                y.im[k] = ai
            }
            return y
        }

        private mutating func synthesise(_ y: Spectrum, dft: RealDFT) -> [Float] {
            let w = NephisDewind.window
            let f = dft.inverse(y)
            var out = [Float](repeating: 0, count: hop)
            for i in 0..<hop {
                out[i] = f[i] * w[i] + synthesisMemory[i]
                synthesisMemory[i] = f[hop + i] * w[hop + i]
            }
            return out
        }

        private mutating func enqueue(erb: [Float], re: [Float], im: [Float]) {
            blockErb.append(erb)
            blockRe.append(re)
            blockIm.append(im)
        }

        /// One network call on the block (padded to `frames` with zero features at a flush), and the first `real` of its
        /// output frames synthesised.
        private mutating func runBlock(real: Int, net: any DewindNetwork, dft: RealDFT) throws -> [Float] {
            let n = frames
            while blockErb.count < n { enqueue(erb: [Float](repeating: 0, count: erbBands), re: [Float](repeating: 0, count: dfBins),
                                               im: [Float](repeating: 0, count: dfBins)) }
            var featErb = [Float](repeating: 0, count: n * erbBands)
            var featSpec = [Float](repeating: 0, count: 2 * n * dfBins)
            for i in 0..<n {
                for b in 0..<erbBands { featErb[i * erbBands + b] = blockErb[i][b] }
                for k in 0..<dfBins {
                    featSpec[i * dfBins + k] = blockRe[i][k]
                    featSpec[(n + i) * dfBins + k] = blockIm[i][k]
                }
            }
            blockErb = []
            blockRe = []
            blockIm = []
            let r = try net.run(featErb: featErb, featSpec: featSpec, state: &state)
            guard r.gains.count == n * erbBands, r.coefs.count == n * dfBins * 2 * dfOrder else {
                throw DewindError.badNetwork("\(r.gains.count) gains, \(r.coefs.count) coefficients for \(n) frames")
            }
            var out: [Float] = []
            out.reserveCapacity(real * hop)
            for i in 0..<real {
                let g = r.gains[(i * erbBands)..<((i + 1) * erbBands)]
                let c = r.coefs[(i * dfBins * 2 * dfOrder)..<((i + 1) * dfBins * 2 * dfOrder)]
                let y = enhanced(produced + i, gains: g, coefs: c)
                let s = synthesise(y, dft: dft)
                trace?.enhanced.append(y)
                trace?.synthesised.append(s)
                out += s
            }
            produced += real
            // Output frame `produced` needs spectra from produced - 2 on.
            let keepFrom = produced - lookahead
            if keepFrom > spectraBase {
                let drop = min(spectra.count, keepFrom - spectraBase)
                spectra.removeFirst(drop)
                spectraBase += drop
            }
            return out
        }

        private mutating func step(_ x: ArraySlice<Float>, net: any DewindNetwork, dft: RealDFT) throws -> [Float] {
            let spectrum = analyse(x, dft: dft)
            let f = features(spectrum)
            trace?.spectra.append(spectrum)
            trace?.erb.append(f.erb)
            trace?.specRe.append(f.re)
            trace?.specIm.append(f.im)
            spectra.append(spectrum)
            analysed += 1
            // Frames 0 and 1 only warm up the norms (DFN's pad_feat drops their features).
            guard analysed > lookahead else { return [] }
            enqueue(erb: f.erb, re: f.re, im: f.im)
            return try blockErb.count == frames ? runBlock(real: frames, net: net, dft: dft) : []
        }

        private mutating func emit(_ y: [Float], limit: Int?) -> [Float] {
            var out = y
            let d = min(skip, out.count)
            out.removeFirst(d)
            skip -= d
            if let limit, out.count > max(0, limit - outputs) { out = Array(out.prefix(max(0, limit - outputs))) }
            outputs += out.count
            return out
        }

        /// Any number of 48 kHz samples; the output is aligned with the input (delay-compensated) and lags it.
        mutating func process(_ x: [Float], net: any DewindNetwork) throws -> [Float] {
            guard let dft = RealDFT.shared else { throw DewindError.noDFT }
            inputs += x.count
            let all = pending + x
            var out: [Float] = []
            var i = 0
            while i + hop <= all.count {
                out += try step(all[i..<(i + hop)], net: net, dft: dft)
                i += hop
            }
            pending = Array(all[i...])
            return emit(out, limit: nil)
        }

        /// End of stream, as enhance(pad = True): 960 zeros as hops (the partial hop left over dropped), then 2 steps on
        /// zero features with zero future spectra; the output trimmed to the input length.
        mutating func flush(net: any DewindNetwork) throws -> [Float] {
            guard let dft = RealDFT.shared else { throw DewindError.noDFT }
            let all = pending + [Float](repeating: 0, count: fftSize)
            pending = []
            var out: [Float] = []
            var i = 0
            while i + hop <= all.count {
                out += try step(all[i..<(i + hop)], net: net, dft: dft)
                i += hop
            }
            for _ in 0..<lookahead {
                spectra.append(.zero)
                analysed += 1
                enqueue(erb: [Float](repeating: 0, count: erbBands), re: [Float](repeating: 0, count: dfBins), im: [Float](repeating: 0, count: dfBins))
                if blockErb.count == frames { out += try runBlock(real: frames, net: net, dft: dft) }
            }
            if !blockErb.isEmpty { out += try runBlock(real: blockErb.count, net: net, dft: dft) }
            return emit(out, limit: inputs)
        }
    }

    // MARK: - The chain: rate -> 48 kHz -> passes -> rate

    struct Chain: Sendable {
        let rate: Int
        private var up: StreamResampler?
        private var down: StreamResampler?
        var passes: [Pass]
        private(set) var inputs = 0
        private(set) var outputs = 0

        init(rate: Int, passes: Int, frames: Int) {
            self.rate = rate
            up = rate == NephisDewind.sampleRate ? nil : StreamResampler(from: rate, to: NephisDewind.sampleRate)
            down = rate == NephisDewind.sampleRate ? nil : StreamResampler(from: NephisDewind.sampleRate, to: rate)
            self.passes = (0..<max(1, passes)).map { _ in Pass(frames: frames) }
        }

        private mutating func toWide(_ x: [Float]) -> [Float] {
            guard var u = up else { return x }
            let y = u.process(x.map(Double.init)).map(Float.init)
            up = u
            return y
        }

        private mutating func toRate(_ z: [Float], flush: Bool) -> [Float] {
            guard var d = down else { return z }
            var y = d.process(z.map(Double.init))
            if flush { y += d.flush() }
            down = d
            return y.map(Float.init)
        }

        /// Any number of samples at `rate`; the output is aligned with the input and lags it.
        mutating func process(_ x: [Float], net: any DewindNetwork) throws -> [Float] {
            inputs += x.count
            var z = toWide(x)
            for i in passes.indices { z = try passes[i].process(z, net: net) }
            let y = toRate(z, flush: false)
            outputs += y.count
            return y
        }

        /// End of stream: each stage flushed into the next, the output trimmed (or padded) to the input length.
        mutating func flush(net: any DewindNetwork) throws -> [Float] {
            var z: [Float] = []
            if var u = up {
                z = u.flush().map(Float.init)
                up = u
            }
            for i in passes.indices { z = try passes[i].process(z, net: net) + passes[i].flush(net: net) }
            var y = toRate(z, flush: true)
            let want = max(0, inputs - outputs)
            y = y.count >= want ? Array(y.prefix(want)) : y + [Float](repeating: 0, count: want - y.count)
            outputs += y.count
            return y
        }
    }

    // MARK: - A read: calls in, calls out

    /// One read's cleaner, call after call (see the top of this file): every call comes back complete and as long as it
    /// went in; the chain's state carries across the joins.
    public struct Stream: Sendable {
        public let settings: Settings
        public let sampleRate: Int
        public let framesPerCall: Int
        var chain: Chain
        /// The copy's continuation past the last call (silence assumed after it), crossfaded into the next call's start.
        private var bridge: [Float] = []

        public init(settings: Settings, sampleRate: Int, framesPerCall: Int) {
            self.settings = settings
            self.sampleRate = sampleRate
            self.framesPerCall = max(1, framesPerCall)
            chain = Chain(rate: sampleRate, passes: settings.passes, frames: self.framesPerCall)
        }

        /// The crossfade length at a join, in samples at the call's rate.
        public var fade: Int { max(1, Int((Double(sampleRate) * NephisDewind.joinFadeSeconds).rounded())) }

        /// One call of the read, cleaned: exactly `x.count` samples. Throws when the network fails (the caller plays the
        /// call as it was and starts a fresh stream).
        public mutating func process(_ x: [Float], net: any DewindNetwork) throws -> [Float] {
            guard !x.isEmpty else { return [] }
            let played = chain.inputs  // samples returned so far (every call came back whole)
            let before = chain.outputs
            var out = try chain.process(x, net: net)
            // The chain's output the previous call already returned from its copy.
            out.removeFirst(min(out.count, max(0, played - before)))
            let after = chain.outputs
            var tail = chain
            let rest = try tail.process([Float](repeating: 0, count: fade), net: net) + tail.flush(net: net)
            let from = max(after, played) - after
            let count = chain.inputs - max(after, played)
            guard from + count + fade <= rest.count else { throw DewindError.badNetwork("tail \(rest.count) samples, needed \(from + count + fade)") }
            out += rest[from..<(from + count)]
            let crossfade = min(bridge.count, out.count)
            for i in 0..<crossfade {
                let w = (Float(i) + 0.5) / Float(bridge.count)
                out[i] = bridge[i] * (1 - w) + out[i] * w
            }
            bridge = Array(rest[(from + count)..<(from + count + fade)])
            return out
        }
    }
}

/// The cleaner's network: N frames of features in (featErb [N][32]; featSpec [2][N][96], real parts then imaginary),
/// N frames of ERB gains ([N][32]) and deep-filter coefficients ([N][96][10], tap · 2 + re/im) out, its state explicit.
public protocol DewindNetwork: Sendable {
    var framesPerCall: Int { get }
    func run(featErb: [Float], featSpec: [Float], state: inout NephisDewind.NetState) throws -> (gains: [Float], coefs: [Float])
}
