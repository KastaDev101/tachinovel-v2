//
//  NephisBreathAir.swift — a little air on top of her voice (pack.json chain "breathAir", Kasta 2026-10-15).
//
//  The browser EQ tuner's Breath air: a parallel exciter,
//
//    y = x + mix · HPF7k( shaper( preGain · HPF5k(x) ) ),   shaper(v) = tanh(4v) / tanh(4)
//
//    "breathAir": {"amount": 0.2}         amount 0…1; 0 = off
//
//  HPF5k / HPF7k: 2nd-order RBJ high-pass, Q 1.1220, at 5,000 and 7,000 Hz (double precision, ToneBiquad): the tuner
//  built them as WebAudio BiquadFilterNodes with the default Q of 1, which WebAudio reads in dB for its low- and high-pass
//  (Chromium Biquad::SetHighpassParams: resonance = 10^(0.05 · Q)), so a linear Q of 10^(1/20) = 1.1220, +1 dB at the
//  corner (until build 361 here: 0.7071, -3 dB; corrected 2026-10-15). The studio EQ's own sections keep their plain
//  RBJ Q (the tuner exports linear Q for those). The tuner's
//  preGain 10 and mix 0.12 · amount were at its level, 6.02 dB under the phone's (x_phone = 2 · x_page): here preGain 5
//  and mix 0.24 · amount. The shaper is the tuner's WebAudio WaveShaperNode with oversample "4x", ported from Chromium
//  (Blink platform/audio up_sampler.cc, down_sampler.cc, modules/webaudio/wave_shaper_handler.cc; BSD-3-Clause, notice in
//  THIRD_PARTY_NOTICES.md, "Chromium Web Audio"):
//
//    up 2x (twice)    even output samples = the input delayed by 64; odd ones = the input through a 128-tap
//                     Blackman-windowed sinc (alpha 0.16) centred half a sample later;
//    shaper           at 4x the rate, its input clamped to [-1, 1] (a WaveShaper curve covers [-1, 1]); the curve
//                     itself evaluated exactly instead of interpolated from the tuner's table;
//    down 2x (twice)  a 256-tap Blackman-windowed half-band sinc (its even taps zero but the 0.5 in the middle), every
//                     other output kept.
//
//  Like the tuner, the oversampled path lags the dry signal by Chromium's latency for 4x, 192 frames (4.4 ms at 44.1 kHz):
//  nothing compensates it there either. One exciter runs over a whole read (filters and sampler histories carried from
//  call to call, as NephisMaster): every call keeps its length. A new read starts a fresh one; another rate builds one.
//
//  Cost per input sample (vDSP_conv for the FIRs): up 1x→2x 128 MACs, up 2x→4x 256, down 4x→2x 256, down 2x→1x 128
//  (768 MACs ≈ 1,540 flops), 4 tanh at 4x, two biquads: ~68 Mflop + 176 k tanh per second of audio at 44.1 kHz, about
//  10-20 ms on the phone's vDSP against hundreds of ms for her voice models. No threat to keep-up.
//
//  Chromium's notice for the up- and down-sampler (BSD-3-Clause; THIRD_PARTY_NOTICES.md, "Chromium Web Audio"):
//
//  Copyright (C) 2013 Google Inc. All rights reserved.
//
//  Redistribution and use in source and binary forms, with or without
//  modification, are permitted provided that the following conditions are
//  met:
//
//      * Redistributions of source code must retain the above copyright
//  notice, this list of conditions and the following disclaimer.
//      * Redistributions in binary form must reproduce the above
//  copyright notice, this list of conditions and the following disclaimer
//  in the documentation and/or other materials provided with the
//  distribution.
//      * Neither the name of Google Inc. nor the names of its
//  contributors may be used to endorse or promote products derived from
//  this software without specific prior written permission.
//
//  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
//  "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
//  LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
//  A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
//  OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
//  SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
//  LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
//  DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
//  THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
//  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
//  OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//

import Accelerate
import Foundation

public struct NephisBreathAir: Sendable {
    /// pack.json chain "breathAir": {"amount": 0.2}. `amount` is needed (a block without it is unreadable: off), 0…1.
    public struct Settings: Codable, Sendable, Equatable {
        public var amount: Double

        public init(amount: Double) {
            self.amount = amount.isFinite ? min(1, max(0, amount)) : 0
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let amount = try c.decode(Double.self, forKey: .amount)
            self.init(amount: amount)
        }

        /// The shaper's input gain and the wet mix at the phone's level (the tuner's 10 and 0.12 · amount, halved and
        /// doubled for its signal being half the phone's).
        public var preGain: Double { 5 }
        public var mix: Double { 0.24 * amount }
    }

    /// Chromium's 2x up-sampler: 128-tap kernel (UpSampler MakeKernel).
    static let upKernel: [Float] = {
        let n = 128, half = n / 2
        let alpha = 0.16, a0 = 0.5 * (1 - alpha), a1 = 0.5, a2 = 0.5 * alpha
        let offset = -0.5
        return (0..<n).map { i in
            let s = Double.pi * (Double(i - half) - offset)
            let sinc = s == 0 ? 1.0 : sin(s) / s
            let x = (Double(i) - offset) / Double(n)
            let window = a0 - a1 * cos(2 * Double.pi * x) + a2 * cos(2 * Double.pi * 2 * x)
            return Float(sinc * window)
        }
    }()

    /// Chromium's 2x down-sampler: the odd taps of a 256-tap half-band kernel (DownSampler MakeReducedKernel); the
    /// middle tap (0.5) is applied apart.
    static let downKernel: [Float] = {
        let n = 256, half = n / 2
        let alpha = 0.16, a0 = 0.5 * (1 - alpha), a1 = 0.5, a2 = 0.5 * alpha
        var k = [Float](repeating: 0, count: n / 2)
        for i in stride(from: 1, to: n, by: 2) {
            let s = 0.5 * Double.pi * Double(i - half)
            var sinc = s == 0 ? 1.0 : sin(s) / s
            sinc *= 0.5
            let x = Double(i) / Double(n)
            let window = a0 - a1 * cos(2 * Double.pi * x) + a2 * cos(2 * Double.pi * 2 * x)
            k[(i - 1) / 2] = Float(sinc * window)
        }
        return k
    }()

    /// The kernels reversed, for vDSP_conv's correlation form.
    static let upReversed: [Float] = upKernel.reversed()
    static let downReversed: [Float] = downKernel.reversed()

    /// The two high-passes' Q: WebAudio's default Q of 1 dB as a linear Q, 10^(1/20) = 1.1220.
    public static let highPassQ = pow(10.0, 1.0 / 20)

    /// The oversampled path's latency (frames at the call's rate): Chromium's for 4x.
    public static let latency = 192

    /// A 2x up-sampler with its history (the last 127 input samples).
    struct Up: Sendable {
        var history = [Float](repeating: 0, count: 127)

        mutating func run(_ x: [Float]) -> [Float] {
            let n = x.count
            guard n > 0 else { return [] }
            let ext = history + x
            var odd = [Float](repeating: 0, count: n)
            // odd[i] = Σ_k h[k] · x[i - k] = Σ_p h[127 - p] · ext[i + p]
            ext.withUnsafeBufferPointer { e in
                NephisBreathAir.upReversed.withUnsafeBufferPointer { f in
                    odd.withUnsafeMutableBufferPointer { o in
                        vDSP_conv(e.baseAddress!, 1, f.baseAddress!, 1, o.baseAddress!, 1, vDSP_Length(n), vDSP_Length(128))
                    }
                }
            }
            var out = [Float](repeating: 0, count: 2 * n)
            for i in 0..<n {
                out[2 * i] = ext[i + 63]  // x[i - 64]
                out[2 * i + 1] = odd[i]
            }
            history = Array(ext.suffix(127))
            return out
        }
    }

    /// A 2x down-sampler with its history (the last 255 input samples). Its input count must be even.
    struct Down: Sendable {
        var history = [Float](repeating: 0, count: 255)

        mutating func run(_ z: [Float]) -> [Float] {
            let m = z.count / 2
            guard m > 0 else { return [] }
            let ext = history + z
            var out = [Float](repeating: 0, count: m)
            // y[i] = Σ_t r[t] · z[2i - 2t - 1] + 0.5 · z[2i - 128] = Σ_p r[127 - p] · ext[2i + 2p] + 0.5 · ext[2i + 127]
            ext.withUnsafeBufferPointer { e in
                NephisBreathAir.downReversed.withUnsafeBufferPointer { f in
                    out.withUnsafeMutableBufferPointer { o in
                        vDSP_conv(e.baseAddress!, 2, f.baseAddress!, 1, o.baseAddress!, 1, vDSP_Length(m), vDSP_Length(128))
                    }
                }
            }
            for i in 0..<m { out[i] += 0.5 * ext[2 * i + 127] }
            history = Array(ext.suffix(255))
            return out
        }
    }

    public let settings: Settings
    public let sampleRate: Int
    private var hp5: ToneBiquad
    private var hp7: ToneBiquad
    private var up1 = Up()
    private var up2 = Up()
    private var down2 = Down()
    private var down1 = Down()

    public init(settings: Settings, sampleRate: Int) {
        let fs = Double(max(1, sampleRate))
        self.settings = settings
        self.sampleRate = max(1, sampleRate)
        hp5 = .highPass(hz: min(5_000, 0.49 * fs), q: Self.highPassQ, fs: fs)
        hp7 = .highPass(hz: min(7_000, 0.49 * fs), q: Self.highPassQ, fs: fs)
    }

    /// The shaper: tanh(4v) / tanh(4) on v clamped to [-1, 1].
    @inline(__always) static func shape(_ v: Float) -> Float {
        tanhf(4 * min(1, max(-1, v))) / tanhf(4)
    }

    /// One call of the read, in place: the dry signal untouched, the air added (same length).
    public mutating func process(_ x: inout [Float]) {
        guard !x.isEmpty else { return }
        let pre = settings.preGain
        var band = [Float](repeating: 0, count: x.count)
        for i in x.indices { band[i] = Float(hp5.process(Double(x[i])) * pre) }
        let up = up1.run(band)
        var z = up2.run(up)
        for i in z.indices { z[i] = Self.shape(z[i]) }
        let half = down2.run(z)
        let wet = down1.run(half)
        let mix = settings.mix
        for i in x.indices { x[i] = Float(Double(x[i]) + mix * hp7.process(Double(wet[i]))) }
    }

    /// The read's exciter for one call, in call order. Settings nil or amount 0 = off: the samples are untouched and any
    /// exciter is dropped. A fresh read, another rate or other settings start a fresh one. True when it ran.
    @discardableResult
    public static func apply(_ air: inout NephisBreathAir?, settings: Settings?, to samples: inout [Float], sampleRate: Int,
                             restart: Bool) -> Bool {
        guard let settings, settings.amount > 0, sampleRate > 0 else {
            air = nil
            return false
        }
        if restart || air?.sampleRate != sampleRate || air?.settings != settings {
            air = NephisBreathAir(settings: settings, sampleRate: sampleRate)
        }
        air?.process(&samples)
        return true
    }
}
