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
//               taps, polyphase; accumulated in Double, in tap order. 44.1 kHz: up 160 / down 147; 24 kHz: up 2 / down 1.
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
//  Measured (MUST-FIX "duh" at joins, 2026-10-15; the lab's NumPy twin of this code with the real network on a 64 s phone
//  read cut at its 25 call joins): the calls differ from one continuous run by at most -97 dBFS (70 dB under her speech),
//  a 20 ms or equal-power crossfade changes nothing measurable, and the pads spliced in after the cleaner add at most
//  -83 dBFS; the joins are not where a "duh" comes from. testJoinsHaveNoTransient keeps it so. Restarting the network
//  at a paragraph pause (to cap the Neural Engine's fp16 drift) was measured too and isn't done: a fresh network state
//  differs from the running one by 30-40 dB under the speech for seconds (even after 8 s of the read fed again), more
//  than the drift itself (46 dB under it after 5 minutes, then steady).
//
//  Cost per pass (48 kHz): the network 3.3 M MAC per 10 ms frame (0.33 GMAC per audio second; Core ML on the CPU in
//  blocks of 8 frames), the DSP ~4 Mflop per second, the resamplers ~2 M MAC per second; the copy at each call's end
//  adds ~2 model calls per pass. Runs on the synthesis worker (NephisFlowSynth's decode jobs), never the render thread.
//  Heat batch 1 (2026-10-15): nothing is allocated per frame (FrameWork scratch, the spectra in rings, the features
//  written in the network's layout), the network's state goes back in as the arrays it came out as (NetState.carried),
//  and the resamplers run over flat tables; every sum keeps its order, so the output is the same, bit for bit.
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
    /// `carried`: the state as a Core ML network returned it (NephisDewindModel), fed straight back as its next input
    /// instead of being copied out and in again (heat batch 1, 2026-10-15); while it is set it is the state and the arrays
    /// are left as they were. nil: the arrays are the state (a stream's start, a network that keeps its state as arrays).
    /// A copy of the state (a call's tail, Stream) may share it: a network only ever replaces it, never writes into it.
    public struct NetState: Sendable {
        public var erbBuf = [Float](repeating: 0, count: 64)
        public var specBuf = [Float](repeating: 0, count: 384)
        public var c0Buf = [Float](repeating: 0, count: 24_576)
        public var h = [Float](repeating: 0, count: 1_280)
        public var carried: (any Sendable)?
        public init() {}
    }

    // MARK: - Spectra and the 960-point real DFT

    struct Spectrum: Sendable {
        var re: [Float]
        var im: [Float]
        static let zero = Spectrum(re: [Float](repeating: 0, count: bins), im: [Float](repeating: 0, count: bins))
    }

    /// One pass's scratch for its frame work (heat batch 1: nothing is allocated per 10 ms frame): the analysis frame, the
    /// transforms' halves, the spectrum just analysed, the filtered spectrum, the synthesis frame, the band sums and the
    /// deep filter's tap positions. Nothing in it carries from one frame to the next, so a copy of a pass (a call's tail,
    /// Stream) shares it: the two never run at the same time (a read's calls run one after another, in one actor).
    final class FrameWork: @unchecked Sendable {  // @unchecked: scratch used by one pass's calls, one at a time
        var frame = [Float](repeating: 0, count: fftSize)
        var even = [Float](repeating: 0, count: fftSize / 2)
        var odd = [Float](repeating: 0, count: fftSize / 2)
        var outRe = [Float](repeating: 0, count: fftSize / 2)
        var outIm = [Float](repeating: 0, count: fftSize / 2)
        var specRe = [Float](repeating: 0, count: bins)
        var specIm = [Float](repeating: 0, count: bins)
        var yRe = [Float](repeating: 0, count: bins)
        var yIm = [Float](repeating: 0, count: bins)
        var synth = [Float](repeating: 0, count: fftSize)
        var sums = [Double](repeating: 0, count: erbBands)
        var tapAt = [Int](repeating: -1, count: dfOrder)
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

        /// The true DFT of `work.frame` (n real samples) times `scale` into `work.specRe`/`specIm` (bins 0…n/2), with no
        /// allocation. `work` must be sized for this n.
        func forward(_ work: FrameWork, scale: Float) {
            let h = n / 2
            let s = forwardScale * scale, si = s * forwardSign
            work.frame.withUnsafeBufferPointer { x in
                work.even.withUnsafeMutableBufferPointer { e in
                    work.odd.withUnsafeMutableBufferPointer { o in
                        for j in 0..<h {
                            e[j] = x[2 * j]
                            o[j] = x[2 * j + 1]
                        }
                        work.outRe.withUnsafeMutableBufferPointer { pr in
                            work.outIm.withUnsafeMutableBufferPointer { pi in
                                vDSP_DFT_Execute(forwardSetup, e.baseAddress!, o.baseAddress!, pr.baseAddress!, pi.baseAddress!)
                                work.specRe.withUnsafeMutableBufferPointer { re in
                                    work.specIm.withUnsafeMutableBufferPointer { im in
                                        re[0] = pr[0] * s
                                        im[0] = 0
                                        re[h] = pi[0] * s
                                        im[h] = 0
                                        for k in 1..<h {
                                            re[k] = pr[k] * s
                                            im[k] = pi[k] * si
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        /// Σ_k Y[k] e^(+2πikt/n) over the whole Hermitian spectrum `work.yRe`/`yIm` (numpy's irfft · n) into `work.synth`
        /// (n real samples), with no allocation. The imaginary parts of DC and Nyquist are ignored, as irfft does.
        func inverse(_ work: FrameWork) {
            let h = n / 2
            work.yRe.withUnsafeBufferPointer { yr in
                work.yIm.withUnsafeBufferPointer { yi in
                    work.even.withUnsafeMutableBufferPointer { er in
                        work.odd.withUnsafeMutableBufferPointer { ei in
                            er[0] = yr[0]
                            ei[0] = yr[h]
                            for k in 1..<h {
                                er[k] = yr[k]
                                ei[k] = yi[k] * forwardSign
                            }
                            work.outRe.withUnsafeMutableBufferPointer { a in
                                work.outIm.withUnsafeMutableBufferPointer { b in
                                    vDSP_DFT_Execute(inverseSetup, er.baseAddress!, ei.baseAddress!, a.baseAddress!, b.baseAddress!)
                                    work.synth.withUnsafeMutableBufferPointer { out in
                                        for j in 0..<h {
                                            out[2 * j] = a[j] * inverseScale
                                            out[2 * j + 1] = b[j] * inverseScale
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        /// The true DFT of `x` (n real samples) times `scale`: bins 0…n/2 (the tests; the passes use `forward(_:scale:)`).
        func forward(_ x: [Float], scale: Float) -> Spectrum {
            let work = FrameWork()
            work.frame = x
            forward(work, scale: scale)
            return Spectrum(re: work.specRe, im: work.specIm)
        }

        /// The unnormalised inverse of `y`: n real samples (the tests; the passes use `inverse(_:)` on their scratch).
        func inverse(_ y: Spectrum) -> [Float] {
            let work = FrameWork()
            work.yRe = y.re
            work.yIm = y.im
            inverse(work)
            return work.synth
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
        /// Per phase, the taps reversed (so an output is a forward dot product over the input), phase after phase in one
        /// array (`taps` values each).
        let table: [Double]
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
            table = (0..<u).flatMap { phase in (0..<m).map { j in padded[phase + u * (m - 1 - j)] } }
            history = [Double](repeating: 0, count: m)
        }

        /// P[phase][m] (resample_poly's polyphase table), for the tests.
        func polyphase(_ phase: Int) -> [Double] { Array(table[(phase * taps)..<((phase + 1) * taps)].reversed()) }

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
            let first = outputs, up = self.up, down = self.down, pre = self.pre, taps = self.taps
            all.withUnsafeBufferPointer { xa in
                table.withUnsafeBufferPointer { tp in
                    y.withUnsafeMutableBufferPointer { yp in
                        for j in first..<end {
                            let n = (j + pre) * down
                            let start = n / up - base - (taps - 1)
                            // A plain loop in tap order (vDSP's dot product sums in an order that depends on the buffers'
                            // alignment): the same bits however the stream is cut into calls.
                            let p = tp.baseAddress! + (n % up) * taps
                            let x = xa.baseAddress! + start
                            var acc = 0.0
                            for m in 0..<taps { acc += p[m] * x[m] }
                            yp[j - first] = acc
                        }
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
        /// Analysis frames done. The spectra of frames spectraBase ..< analysed are kept, frame i in slot i % slots of the
        /// rings (`bins` values a slot): the deep filter reaches 2 frames back and 2 ahead, and a block of `frames` waits
        /// for its features, so `frames` + 4 are ever needed.
        private var analysed = 0
        private var spectraBase = 0
        private let slots: Int
        private var ringRe: [Float]
        private var ringIm: [Float]
        /// Features waiting for the next network call, in the network's own layout: `blockErb` [frames][32], `blockSpec`
        /// [2][frames][96] (real parts, then imaginary parts); `blockCount` rows filled.
        private var blockErb: [Float]
        private var blockSpec: [Float]
        private var blockCount = 0
        /// Output frames made so far.
        private var produced = 0
        private var state = NetState()
        private(set) var inputs = 0
        private var outputs = 0
        private var skip = fftSize - hop
        private let work = FrameWork()

        init(frames: Int) {
            self.frames = max(1, frames)
            slots = self.frames + 2 * lookahead + 2
            ringRe = [Float](repeating: 0, count: slots * bins)
            ringIm = [Float](repeating: 0, count: slots * bins)
            blockErb = [Float](repeating: 0, count: self.frames * erbBands)
            blockSpec = [Float](repeating: 0, count: 2 * self.frames * dfBins)
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

        /// Frame i's place in the rings, or nil when its spectrum isn't kept (before the stream, dropped, or not yet made).
        private func slot(_ i: Int) -> Int? {
            i >= spectraBase && i < analysed ? (i % slots) * bins : nil
        }

        /// The next analysis frame: the 480 samples at `x[at...]` after the 480 before them, windowed, into the spectrum of
        /// frame `analysed` (work.specRe/specIm and its ring slot).
        private mutating func analyse(_ x: UnsafeBufferPointer<Float>, at: Int, dft: RealDFT) {
            let w = NephisDewind.window
            let work = self.work
            work.frame.withUnsafeMutableBufferPointer { f in
                for i in 0..<hop {
                    f[i] = analysisMemory[i] * w[i]
                }
                for k in 0..<hop {
                    let v = x[at + k]
                    f[hop + k] = v * w[hop + k]
                    analysisMemory[k] = v
                }
            }
            dft.forward(work, scale: Float(2.0 * Double(hop) / Double(fftSize * fftSize)))
            let s = (analysed % slots) * bins
            for k in 0..<bins {
                ringRe[s + k] = work.specRe[k]
                ringIm[s + k] = work.specIm[k]
            }
        }

        /// The spectrum just analysed: its ERB features (dB under the exponential mean, /40) and the unit-normalised DF
        /// features of bins 0…95, into the block's row `row` (the norms move on for every frame; the row counts only once
        /// the frame is enqueued).
        private mutating func features(row: Int) {
            let band = NephisDewind.bandOfBin
            let work = self.work
            for b in 0..<erbBands { work.sums[b] = 0 }
            for k in 0..<bins {
                let p = work.specRe[k] * work.specRe[k] + work.specIm[k] * work.specIm[k]
                work.sums[band[k]] += Double(p)
            }
            for b in 0..<erbBands {
                let mean = Float(work.sums[b] / Double(erbWidths[b]))
                let e = 10 * log10f(mean + Float(1e-10))
                erbNorm[b] = e * oneMinusAlpha + erbNorm[b] * alpha
                blockErb[row * erbBands + b] = (e - erbNorm[b]) / 40
            }
            for k in 0..<dfBins {
                unitNorm[k] = hypotf(work.specRe[k], work.specIm[k]) * oneMinusAlpha + unitNorm[k] * alpha
                // numpy divides a complex64 by a real as x · (1 / s).
                let inv = 1 / unitNorm[k].squareRoot()
                blockSpec[row * dfBins + k] = work.specRe[k] * inv
                blockSpec[(frames + row) * dfBins + k] = work.specIm[k] * inv
            }
        }

        /// Output frame t's spectrum into work.yRe/yIm: the ERB gains above bin 96, the 5-tap deep filter below it.
        /// `gains`/`coefs`: the network's outputs, this frame's at `g0`/`c0`.
        private func enhanced(_ t: Int, gains: UnsafeBufferPointer<Float>, g0: Int, coefs: UnsafeBufferPointer<Float>, c0: Int) {
            let band = NephisDewind.bandOfBin
            let work = self.work
            let xt = slot(t) ?? -1
            for k in dfBins..<bins {
                let g = gains[g0 + band[k]]
                let xr: Float = xt >= 0 ? ringRe[xt + k] : 0, xi: Float = xt >= 0 ? ringIm[xt + k] : 0
                work.yRe[k] = xr * g
                work.yIm[k] = xi * g
            }
            for n in 0..<dfOrder { work.tapAt[n] = slot(t - lookahead + n) ?? -1 }
            for k in 0..<dfBins {
                var ar: Float = 0, ai: Float = 0
                for n in 0..<dfOrder {
                    let cr = coefs[c0 + k * 2 * dfOrder + 2 * n], ci = coefs[c0 + k * 2 * dfOrder + 2 * n + 1]
                    let at = work.tapAt[n]
                    let xr: Float = at >= 0 ? ringRe[at + k] : 0, xi: Float = at >= 0 ? ringIm[at + k] : 0
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
                work.yRe[k] = ar
                work.yIm[k] = ai
            }
        }

        /// Synthesis of work.yRe/yIm: irfft · 960 · window, overlap-added; 480 samples onto `out`.
        private mutating func synthesise(dft: RealDFT, into out: inout [Float]) {
            let w = NephisDewind.window
            let work = self.work
            dft.inverse(work)
            for i in 0..<hop {
                out.append(work.synth[i] * w[i] + synthesisMemory[i])
                synthesisMemory[i] = work.synth[hop + i] * w[hop + i]
            }
        }

        /// One network call on the block (padded to `frames` with zero features at a flush), and the first `real` of its
        /// output frames synthesised onto `out`.
        private mutating func runBlock(real: Int, net: any DewindNetwork, dft: RealDFT, into out: inout [Float]) throws {
            let n = frames
            if blockCount < n {
                for i in blockCount..<n {
                    for b in 0..<erbBands { blockErb[i * erbBands + b] = 0 }
                    for k in 0..<dfBins {
                        blockSpec[i * dfBins + k] = 0
                        blockSpec[(n + i) * dfBins + k] = 0
                    }
                }
            }
            blockCount = 0
            let featErb = blockErb, featSpec = blockSpec
            let r = try net.run(featErb: featErb, featSpec: featSpec, state: &state)
            guard r.gains.count == n * erbBands, r.coefs.count == n * dfBins * 2 * dfOrder else {
                throw DewindError.badNetwork("\(r.gains.count) gains, \(r.coefs.count) coefficients for \(n) frames")
            }
            r.gains.withUnsafeBufferPointer { g in
                r.coefs.withUnsafeBufferPointer { c in
                    for i in 0..<real {
                        enhanced(produced + i, gains: g, g0: i * erbBands, coefs: c, c0: i * dfBins * 2 * dfOrder)
                        synthesise(dft: dft, into: &out)
                        if trace != nil {
                            trace?.enhanced.append(Spectrum(re: work.yRe, im: work.yIm))
                            trace?.synthesised.append(Array(out.suffix(hop)))
                        }
                    }
                }
            }
            produced += real
            // Output frame `produced` needs spectra from produced - 2 on.
            let keepFrom = produced - lookahead
            if keepFrom > spectraBase { spectraBase = min(analysed, keepFrom) }
        }

        private mutating func step(_ x: UnsafeBufferPointer<Float>, at: Int, net: any DewindNetwork, dft: RealDFT, into out: inout [Float]) throws {
            analyse(x, at: at, dft: dft)
            features(row: blockCount)
            if trace != nil {
                trace?.spectra.append(Spectrum(re: work.specRe, im: work.specIm))
                trace?.erb.append(Array(blockErb[(blockCount * erbBands)..<((blockCount + 1) * erbBands)]))
                trace?.specRe.append(Array(blockSpec[(blockCount * dfBins)..<((blockCount + 1) * dfBins)]))
                trace?.specIm.append(Array(blockSpec[((frames + blockCount) * dfBins)..<((frames + blockCount + 1) * dfBins)]))
            }
            analysed += 1
            // Frames 0 and 1 only warm up the norms (DFN's pad_feat drops their features).
            guard analysed > lookahead else { return }
            blockCount += 1
            if blockCount == frames { try runBlock(real: frames, net: net, dft: dft, into: &out) }
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

        /// Every whole hop of `all`, step by step onto `out`; returns where the hops end.
        private mutating func hops(_ all: [Float], net: any DewindNetwork, dft: RealDFT, into out: inout [Float]) throws -> Int {
            var i = 0
            try all.withUnsafeBufferPointer { a in
                while i + hop <= a.count {
                    try step(a, at: i, net: net, dft: dft, into: &out)
                    i += hop
                }
            }
            return i
        }

        /// Any number of 48 kHz samples; the output is aligned with the input (delay-compensated) and lags it.
        mutating func process(_ x: [Float], net: any DewindNetwork) throws -> [Float] {
            guard let dft = RealDFT.shared else { throw DewindError.noDFT }
            inputs += x.count
            let all = pending + x
            var out: [Float] = []
            out.reserveCapacity((all.count / hop + frames) * hop)
            let i = try hops(all, net: net, dft: dft, into: &out)
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
            out.reserveCapacity((all.count / hop + frames + lookahead) * hop)
            _ = try hops(all, net: net, dft: dft, into: &out)
            for _ in 0..<lookahead {
                // A zero spectrum, and zero features for the network.
                let s = (analysed % slots) * bins
                for k in 0..<bins {
                    ringRe[s + k] = 0
                    ringIm[s + k] = 0
                }
                analysed += 1
                for b in 0..<erbBands { blockErb[blockCount * erbBands + b] = 0 }
                for k in 0..<dfBins {
                    blockSpec[blockCount * dfBins + k] = 0
                    blockSpec[(frames + blockCount) * dfBins + k] = 0
                }
                blockCount += 1
                if blockCount == frames { try runBlock(real: frames, net: net, dft: dft, into: &out) }
            }
            if blockCount > 0 { try runBlock(real: blockCount, net: net, dft: dft, into: &out) }
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
    /// Milliseconds spent so far in the network's predictions and in building and reading its arrays (the Voice speed
    /// test's and the listening report's split of the cleaner's time); (0, 0) for a network that doesn't measure.
    func timeSpent() -> (predictMs: Double, ioMs: Double)
}

extension DewindNetwork {
    public func timeSpent() -> (predictMs: Double, ioMs: Double) { (0, 0) }
}
