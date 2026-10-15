//
//  NephisRoom.swift — a small, close room around her voice (pack.json chain "room", Kasta 2026-10-15).
//
//  Kasta tuned her voice in the browser EQ tuner; its Room setting (7 % wet) is this, sample for sample the tuner's
//  WebAudio graph with a mono impulse response:
//
//    "room": {"amount": 0.07}                     optional: "seconds" 0.35, "decay" 0.07, "seed" 1
//
//    impulse     n = round(fs · seconds) samples: lp = 0.55 · lp + 0.45 · u (u uniform in [-1, 1) from SplitMix64 seeded
//                with `seed`, lp starting at 0), ir[i] = lp · exp(-t / decay) · (t < 4 ms ? t / 4 ms : 1), t = i / fs;
//    normalize   WebAudio's ConvolverNode (normalize = true; Chromium Reverb::calculateNormalizationScale):
//                power = sqrt(Σ ir² / n), at least 0.000125 (and that when not finite), scale = 0.00125 / power ·
//                44,100 / fs; the room is ir · scale;
//    mix         out = (x + (x ∗ ir · scale) · amount · 2.2) · 1 / (1 + 0.6 · amount) (the tuner's wet gain and its
//                level compensation).
//
//  Clamped: amount 0…0.35, seconds 0.1…1.0, decay 0.02…0.3. Absent, unreadable or amount 0: nil / nothing runs, every
//  call bit-identical to before. The tuner's noise came from the browser's Math.random, so its room is another draw of
//  the same recipe; here it is seeded (the same room on every phone and in the tests).
//
//  NephisFlowSynth runs it on every call of hers (her studio's and her plain sound), as the last tone step before her
//  mastering ("master", which comes after it when on) and after the studio EQ / Mimi EQ. In a 24 kHz read without
//  mastering the player gives her Mimi EQ afterwards (NaturalFinish.renderFlow): the same sound, both being linear filters.
//
//  One room runs over a whole read, call after call, like her mastering (NephisMaster): the room's tail at the end of a
//  call (0.35 s) is carried into the next call's start instead of being cut. A new read (`restart`) starts with no tail.
//  A call at another rate (her studio's 44.1 kHz against a plain 24 kHz read) rebuilds the room for that rate and drops
//  the tail: one engine reads at one rate, so this only happens when the read itself changes rate (a new pack).
//
//  Convolution: FFT overlap-add on vDSP (single precision; the dry signal and the mix in Double). FFT size N = the power
//  of two ≥ 2 · ir length (32,768 at 44.1 kHz for 15,435 taps; 32,768 at 24 kHz for 8,400), input blocks of
//  N - length + 1 samples (17,334 at 44.1 kHz). Cost per second of audio at 44.1 kHz: ~2.6 blocks × (two 32,768-point
//  real FFTs ≈ 2 × 1.23 Mflop, 16,384 complex products ≈ 0.1 Mflop, packing ≈ 0.1 Mflop) ≈ 7 Mflop, plus one partial
//  block per call and 3 flops per sample for the mix: under 10 M operations per second of audio (direct convolution
//  would be ~1.4 Gflop). On the phone's vDSP that is well under 1 ms per second of audio, against hundreds of ms for her
//  voice models: no threat to keep-up. Building the room (once per read, or per rate change) is n exponentials and one
//  FFT.
//

import Accelerate
import Foundation

public struct NephisRoom: Sendable {
    /// pack.json chain "room": {"amount": 0.07, "seconds": 0.35, "decay": 0.07, "seed": 1}. `amount` is needed (a block
    /// without it is unreadable: off); the others default as shown; values are clamped.
    public struct Settings: Codable, Sendable, Equatable {
        /// Wet amount (the tuner's Room slider, 0.07 = 7 %), 0…0.35; 0 = off.
        public var amount: Double
        /// Impulse length (s), 0.1…1.0.
        public var seconds: Double
        /// Decay time constant (s): the impulse falls by 1/e every `decay` seconds, 0.02…0.3.
        public var decay: Double
        /// The noise's seed (SplitMix64).
        public var seed: UInt64

        public init(amount: Double, seconds: Double = 0.35, decay: Double = 0.07, seed: UInt64 = 1) {
            self.amount = Self.clamped(amount, 0, 0.35, else: 0)
            self.seconds = Self.clamped(seconds, 0.1, 1.0, else: 0.35)
            self.decay = Self.clamped(decay, 0.02, 0.3, else: 0.07)
            self.seed = seed
        }

        enum CodingKeys: String, CodingKey {
            case amount, seconds, decay, seed
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let amount = try c.decode(Double.self, forKey: .amount)
            self.init(amount: amount, seconds: (try? c.decodeIfPresent(Double.self, forKey: .seconds)) ?? 0.35,
                      decay: (try? c.decodeIfPresent(Double.self, forKey: .decay)) ?? 0.07,
                      seed: (try? c.decodeIfPresent(UInt64.self, forKey: .seed)) ?? 1)
        }

        /// The tuner's wet gain: amount · 2.2.
        public var wetGain: Double { amount * 2.2 }
        /// The tuner's level compensation: 1 / (1 + 0.6 · amount).
        public var level: Double { 1 / (1 + 0.6 * amount) }

        static func clamped(_ v: Double, _ lo: Double, _ hi: Double, else fallback: Double) -> Double {
            v.isFinite ? min(hi, max(lo, v)) : fallback
        }
    }

    /// SplitMix64 (Steele, Lea & Flood 2014, the reference constants): the impulse's noise, the same numbers everywhere.
    public struct SplitMix64: Sendable {
        public var state: UInt64
        public init(seed: UInt64) { state = seed }

        public mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }

        /// Uniform in [-1, 1): the top 53 bits as a fraction of 2^53, times 2, minus 1.
        public mutating func uniform() -> Double {
            Double(next() >> 11) * 0x1.0p-53 * 2 - 1
        }
    }

    /// The room's impulse response before normalization, at `sampleRate` (see the header).
    public static func impulse(_ s: Settings, sampleRate: Int) -> [Double] {
        let fs = Double(max(1, sampleRate))
        let n = max(1, Int((fs * s.seconds).rounded()))
        var rng = SplitMix64(seed: s.seed)
        var lp = 0.0
        var ir = [Double](repeating: 0, count: n)
        for i in 0..<n {
            let t = Double(i) / fs
            lp = 0.55 * lp + 0.45 * rng.uniform()
            ir[i] = lp * exp(-t / s.decay) * (t < 0.004 ? t / 0.004 : 1)
        }
        return ir
    }

    /// WebAudio's ConvolverNode normalization (normalize = true; Chromium Reverb::calculateNormalizationScale, one
    /// channel): power = sqrt(Σ ir² / n), 0.000125 when smaller or not finite; scale = (1 / power) · 0.00125 · 44,100 / fs.
    public static func normalizationScale(_ ir: [Double], sampleRate: Int) -> Double {
        let n = Double(max(1, ir.count))
        var power = (ir.reduce(0) { $0 + $1 * $1 } / n).squareRoot()
        if !power.isFinite || power < 0.000125 { power = 0.000125 }
        return (1 / power) * 0.00125 * (44_100 / Double(max(1, sampleRate)))
    }

    public let settings: Settings
    public let sampleRate: Int
    /// The impulse's length (samples), and its normalization scale.
    public let length: Int
    public let scale: Double
    /// FFT size (a power of two ≥ 2 · length) and the input block (N - length + 1).
    let log2n: Int
    let fftSize: Int
    let block: Int
    /// The scaled impulse's spectrum in vDSP's packed real format (DC in re[0], Nyquist in im[0]), divided by 4N: a
    /// block's forward transform times this, transformed back, is the block's convolution at its true scale (vDSP's
    /// forward is 2× the DFT, its inverse N× the inverse DFT).
    private let hRe: [Float]
    private let hIm: [Float]
    /// The room's sound still to come from the audio already through: length - 1 samples, added to the next call's start.
    private var tail: [Float]

    public init(settings: Settings, sampleRate: Int) {
        let fs = max(1, sampleRate)
        let ir = NephisRoom.impulse(settings, sampleRate: fs)
        let scale = NephisRoom.normalizationScale(ir, sampleRate: fs)
        self.settings = settings
        self.sampleRate = fs
        self.scale = scale
        length = ir.count
        var log2n = 1
        while (1 << log2n) < 2 * ir.count { log2n += 1 }
        let size = 1 << log2n
        self.log2n = log2n
        fftSize = size
        block = size - ir.count + 1
        tail = [Float](repeating: 0, count: ir.count - 1)
        let h = size / 2
        var re = [Float](repeating: 0, count: h), im = [Float](repeating: 0, count: h)
        for (j, v) in ir.enumerated() {
            if j & 1 == 0 { re[j >> 1] = Float(v * scale) } else { im[j >> 1] = Float(v * scale) }
        }
        if let fft = NephisRoom.fft(log2n) {
            NephisRoom.transform(fft, &re, &im, inverse: false)
            let k = Float(1 / (4 * Double(size)))
            for i in 0..<h {
                re[i] *= k
                im[i] *= k
            }
        } else {
            // No FFT (never seen): no room, the dry sound at the tuner's level.
            re = [Float](repeating: 0, count: h)
            im = re
        }
        hRe = re
        hIm = im
    }

    /// A new read: the tail is dropped (the room itself is kept).
    public mutating func reset() {
        tail = [Float](repeating: 0, count: tail.count)
    }

    /// The scaled impulse response (what the room adds to a unit impulse, before the wet gain): for the tests and logs.
    public var scaledImpulse: [Double] {
        Self.impulse(settings, sampleRate: sampleRate).map { $0 * scale }
    }

    /// One call of the read, in place: same length, the room's tail from the calls before added at its start, this
    /// call's own tail kept for the next.
    public mutating func process(_ x: inout [Float]) {
        let m = x.count
        guard m > 0 else { return }
        let l = length
        let h = fftSize / 2
        let wetGain = settings.wetGain, level = settings.level
        guard let fft = Self.fft(log2n) else {
            for i in 0..<m { x[i] = Float(Double(x[i]) * level) }
            return
        }
        var re = [Float](repeating: 0, count: h), im = [Float](repeating: 0, count: h)
        var y = [Float](repeating: 0, count: fftSize)
        var next = [Float](repeating: 0, count: l - 1)
        var start = 0
        while start < m {
            let count = min(block, m - start)
            for i in 0..<h {
                re[i] = 0
                im[i] = 0
            }
            for j in 0..<count {
                if j & 1 == 0 { re[j >> 1] = x[start + j] } else { im[j >> 1] = x[start + j] }
            }
            Self.transform(fft, &re, &im, inverse: false)
            // DC and Nyquist are real and packed in re[0] / im[0]; the other bins are complex products.
            let dc = re[0] * hRe[0], nyquist = im[0] * hIm[0]
            for k in 1..<h {
                let a = re[k], b = im[k], c = hRe[k], d = hIm[k]
                re[k] = a * c - b * d
                im[k] = a * d + b * c
            }
            re[0] = dc
            im[0] = nyquist
            Self.transform(fft, &re, &im, inverse: true)
            for i in 0..<h {
                y[2 * i] = re[i]
                y[2 * i + 1] = im[i]
            }
            // The block's convolution is count + l - 1 samples (≤ N): its first `count` go out now with the tail from
            // before, the rest joins what is left of the tail.
            for j in 0..<count {
                let wet = (j < l - 1 ? tail[j] : 0) + y[j]
                x[start + j] = Float((Double(x[start + j]) + Double(wet) * wetGain) * level)
            }
            for j in 0..<(l - 1) {
                next[j] = (j + count < l - 1 ? tail[j + count] : 0) + y[count + j]
            }
            swap(&tail, &next)
            start += count
        }
    }

    /// The read's room for one call, in call order. Settings nil or amount 0 = off: the samples are untouched and any room
    /// is dropped. A fresh read (`restart`) drops the tail; another rate or other settings build a new room (no tail).
    /// True when the room ran.
    @discardableResult
    public static func apply(_ room: inout NephisRoom?, settings: Settings?, to samples: inout [Float], sampleRate: Int,
                             restart: Bool) -> Bool {
        guard let settings, settings.amount > 0, sampleRate > 0 else {
            room = nil
            return false
        }
        if room?.sampleRate != sampleRate || room?.settings != settings {
            room = NephisRoom(settings: settings, sampleRate: sampleRate)
        } else if restart {
            room?.reset()
        }
        room?.process(&samples)
        return true
    }

    // MARK: - vDSP

    private static func fft(_ log2n: Int) -> vDSP.FFT<DSPSplitComplex>? {
        vDSP.FFT(log2n: vDSP_Length(log2n), radix: .radix2, ofType: DSPSplitComplex.self)
    }

    /// vDSP's packed real FFT in place (forward: 2× the DFT; inverse: N× the inverse DFT), as BreathPolish.RealFFT.
    private static func transform(_ fft: vDSP.FFT<DSPSplitComplex>, _ re: inout [Float], _ im: inout [Float], inverse: Bool) {
        re.withUnsafeMutableBufferPointer { r in
            im.withUnsafeMutableBufferPointer { i in
                var split = DSPSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
                if inverse { fft.inverse(input: split, output: &split) } else { fft.forward(input: split, output: &split) }
            }
        }
    }
}
