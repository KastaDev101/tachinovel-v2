//
//  NephisCloseness.swift — her voice brought closer (pack.json chain "closeness", Kasta 2026-10-15).
//
//  The browser EQ tuner's Closeness setting is a WebAudio DynamicsCompressorNode; this is a port of Chromium's
//  implementation of it (Blink, third_party/blink/renderer/platform/audio/dynamics_compressor.cc, formerly
//  dynamics_compressor_kernel.cc; fetched from chromium/chromium main on 2026-10-15), mono, in single precision as there:
//  the 6 ms look-ahead (pre-delay), the detector with its 2.5 ms saturation release, the adaptive release (4th-order
//  polynomial through the release zones), the attack from the largest compression difference so far, the sine warp,
//  the soft-knee static curve (KneeCurve/Saturate/KAtSlope) and the automatic makeup gain (1 / Saturate(1, k))^0.6.
//  Envelope rates are set once per 32-frame division, as there; the divisions stay on the read's 32-frame grid across
//  calls. Left out: the reduction meter (it changes no sample). A stereo node fed the same signal on both channels
//  gives exactly this. One difference on purpose: a fresh compressor starts settled on silence (detector 1, gain 1,
//  largest attack difference 0), the state the tuner's node was in when playback started (it had been running on
//  silence since the page opened). Chromium's Reset() state (detector 0) would dip the gain over a read's first ~0.3 s.
//
//    "closeness": {"amount": 0.15}        amount c, 0…1; c < 0.005 = off
//
//  The tuner's parameters for c (its units): threshold -32c - 18·min(1, 4c) dB, ratio 1 + 3c, knee 12 dB, attack 8 ms,
//  release 180 ms; after the node an extra makeup gain of 10^(((-threshold - 14) · (1 - 1/ratio) · 0.5) / 20). The
//  tuner's signal was 6.02 dB quieter than the phone's (x_phone = 2 · x_page), so the threshold here is the tuner's plus
//  20·log10(2) dB (c = 0.15: -15.6 → -9.58 dBFS); the makeup gains are level-independent.
//
//  Latency: the pre-delay, round(down)(0.006 · fs) frames (264 at 44.1 kHz, 144 at 24 kHz), as in the tuner. One
//  compressor runs over a whole read like her mastering (NephisMaster): every call keeps its length, the last 6 ms of a
//  call come out at the start of the next, and the read's first call starts with 6 ms of silence (calls start in a
//  pause). A new read starts a fresh compressor; another rate builds one for it.
//
//  Cost per sample: about 3 transcendental functions (log10, pow, sin; exp inside the knee) and ~30 flops; per 32 frames
//  an asin and a pow: ~5 M operations per second of audio at 44.1 kHz, a few ms on the phone.
//
//  Chromium's notice (BSD-3-Clause; THIRD_PARTY_NOTICES.md, "Chromium Web Audio"):
//
//  Copyright (C) 2011 Google Inc. All rights reserved.
//
//  Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
//  following conditions are met:
//  1.  Redistributions of source code must retain the above copyright notice, this list of conditions and the following
//      disclaimer.
//  2.  Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
//      following disclaimer in the documentation and/or other materials provided with the distribution.
//  3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of its contributors may be used to endorse or
//      promote products derived from this software without specific prior written permission.
//
//  THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT
//  NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO
//  EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
//  CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA,
//  OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
//  LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
//  ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//

import Foundation

public struct NephisCloseness: Sendable {
    /// pack.json chain "closeness": {"amount": 0.15}. `amount` is needed (a block without it is unreadable: off), 0…1.
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

        /// Under this the stage is bypassed (the tuner's).
        public static let off = 0.005
        public var on: Bool { amount >= Self.off }

        /// The tuner's threshold (dB, its own level).
        public var pageThresholdDB: Double { -32 * amount - 18 * min(1, 4 * amount) }
        /// The threshold at the phone's level: the tuner's + 20·log10(2) (its signal was half the phone's).
        public var thresholdDB: Double { pageThresholdDB + 20 * log10(2.0) }
        public var ratio: Double { 1 + 3 * amount }
        public var kneeDB: Double { 12 }
        public var attack: Double { 0.008 }
        public var release: Double { 0.18 }
        /// The tuner's makeup gain after the node (linear).
        public var extraMakeup: Double { pow(10, ((-pageThresholdDB - 14) * (1 - 1 / ratio) * 0.5) / 20) }
    }

    // MARK: - Chromium's constants

    static let maxPreDelayFrames = 1024
    static let preDelay: Float = 0.006
    static let divisionFrames = 32
    static let satReleaseTime: Float = 0.0025
    static let piOverTwo: Float = Float.pi / 2
    static let releaseZone1: Float = 0.09
    static let releaseZone2: Float = 0.16
    static let releaseZone3: Float = 0.42
    static let releaseZone4: Float = 0.98
    static let aBase: Float = 0.9999999999999998 * releaseZone1 + 1.8432219684323923e-16 * releaseZone2
        - 1.9373394351676423e-16 * releaseZone3 + 8.824516011816245e-18 * releaseZone4
    static let bBase: Float = -1.5788320352845888 * releaseZone1 + 2.3305837032074286 * releaseZone2
        - 0.9141194204840429 * releaseZone3 + 0.1623677525612032 * releaseZone4
    static let cBase: Float = 0.5334142869106424 * releaseZone1 - 1.272736789213631 * releaseZone2
        + 0.9258856042207512 * releaseZone3 - 0.18656310191776226 * releaseZone4
    static let dBase: Float = 0.08783463138207234 * releaseZone1 - 0.1694162967925622 * releaseZone2
        + 0.08588057951595272 * releaseZone3 - 0.00429891410546283 * releaseZone4
    static let eBase: Float = -0.042416883008123074 * releaseZone1 + 0.1115693827987602 * releaseZone2
        - 0.09764676325265872 * releaseZone3 + 0.028494263462021576 * releaseZone4

    @inline(__always) static func linearToDecibels(_ x: Float) -> Float { 20 * log10f(x) }
    @inline(__always) static func decibelsToLinear(_ db: Float) -> Float { powf(10, 0.05 * db) }
    @inline(__always) static func finite(_ x: Float, _ fallback: Float) -> Float { x.isFinite ? x : fallback }
    @inline(__always) static func flushDenormal(_ x: Float) -> Float { abs(x) < Float.leastNormalMagnitude ? 0 : x }

    // MARK: - State

    public let settings: Settings
    public let sampleRate: Int
    /// The look-ahead (frames): the latency.
    public let preDelayFrames: Int

    // The static curve (UpdateStaticCurveParameters).
    let linearThreshold: Float
    let dbKnee: Float
    let slope: Float
    let kneeThreshold: Float
    let dbKneeThreshold: Float
    let dbYKneeThreshold: Float
    let k: Float
    // Per-render constants.
    /// Chromium's automatic makeup gain, (1 / Saturate(1, k))^0.6.
    public let linearPostGain: Float
    let attackFrames: Float
    let satReleaseFrames: Float
    let releaseA: Float, releaseB: Float, releaseC: Float, releaseD: Float, releaseE: Float
    /// The tuner's makeup gain after the node.
    public let extraMakeup: Float

    // Settled on silence (see the header): what Chromium's state converges to with no input.
    private var detectorAverage: Float = 1
    private var compressorGain: Float = 1
    private var maxAttackCompressionDiff: Float = 0
    private var preDelayBuffer: [Float]
    private var readIndex = 0
    private var writeIndex: Int
    /// The division in progress: frames left in it, and its envelope rate and target (set at its start).
    private var divisionLeft = 0
    private var envelopeRate: Float = 0
    private var scaledDesiredGain: Float = 1

    public init(settings: Settings, sampleRate: Int) {
        let fs = Float(max(1, sampleRate))
        self.settings = settings
        self.sampleRate = max(1, sampleRate)
        // AudioParams are single precision.
        let dbThreshold = Float(settings.thresholdDB)
        let dbKnee = Float(settings.kneeDB)
        let ratio = Float(settings.ratio)
        let linearThreshold = Self.decibelsToLinear(dbThreshold)
        let slope = 1 / ratio
        let k = Self.kAtSlope(slope, dbThreshold: dbThreshold, dbKnee: dbKnee, linearThreshold: linearThreshold)
        let dbKneeThreshold = dbThreshold + dbKnee
        let kneeThreshold = Self.decibelsToLinear(dbKneeThreshold)
        let dbYKneeThreshold = Self.linearToDecibels(Self.kneeCurve(kneeThreshold, k, linearThreshold: linearThreshold))
        self.linearThreshold = linearThreshold
        self.dbKnee = dbKnee
        self.slope = slope
        self.kneeThreshold = kneeThreshold
        self.dbKneeThreshold = dbKneeThreshold
        self.dbYKneeThreshold = dbYKneeThreshold
        self.k = k
        let saturated1 = Self.saturate(1, k: k, linearThreshold: linearThreshold, kneeThreshold: kneeThreshold,
                                       dbKneeThreshold: dbKneeThreshold, dbYKneeThreshold: dbYKneeThreshold, slope: slope)
        linearPostGain = powf(1 / saturated1, 0.6)
        attackFrames = max(0.001, Float(settings.attack)) * fs
        let releaseFrames = fs * Float(settings.release)
        satReleaseFrames = Self.satReleaseTime * fs
        releaseA = releaseFrames * Self.aBase
        releaseB = releaseFrames * Self.bBase
        releaseC = releaseFrames * Self.cBase
        releaseD = releaseFrames * Self.dBase
        releaseE = releaseFrames * Self.eBase
        extraMakeup = Float(settings.extraMakeup)
        // SetPreDelayTime on a fresh node: unsigned(0.006 · fs), at most 1023.
        let pre = min(Self.maxPreDelayFrames - 1, Int(Self.preDelay * fs))
        preDelayFrames = pre
        preDelayBuffer = [Float](repeating: 0, count: Self.maxPreDelayFrames)
        writeIndex = pre
    }

    // MARK: - The static curve (Chromium's KneeCurve, Saturate, KAtSlope)

    /// Exponential knee: linear up to the threshold, then approaching linearThreshold + 1/k (1st derivative matched).
    static func kneeCurve(_ x: Float, _ k: Float, linearThreshold: Float) -> Float {
        if x < linearThreshold { return x }
        return linearThreshold + (1 - Float(exp(Double(-k * (x - linearThreshold))))) / k
    }

    /// The full curve: the knee, then a constant ratio.
    static func saturate(_ x: Float, k: Float, linearThreshold: Float, kneeThreshold: Float, dbKneeThreshold: Float,
                         dbYKneeThreshold: Float, slope: Float) -> Float {
        if x < kneeThreshold { return kneeCurve(x, k, linearThreshold: linearThreshold) }
        let dbX = linearToDecibels(x)
        let dbY = dbYKneeThreshold + slope * (dbX - dbKneeThreshold)
        return decibelsToLinear(dbY)
    }

    func saturate(_ x: Float) -> Float {
        Self.saturate(x, k: k, linearThreshold: linearThreshold, kneeThreshold: kneeThreshold, dbKneeThreshold: dbKneeThreshold,
                      dbYKneeThreshold: dbYKneeThreshold, slope: slope)
    }

    /// The knee's k for the slope wanted at the top of the knee (15 bisection steps on the geometric mean).
    static func kAtSlope(_ desiredSlope: Float, dbThreshold: Float, dbKnee: Float, linearThreshold: Float) -> Float {
        let dbX = dbThreshold + dbKnee
        let x = decibelsToLinear(dbX)
        var x2: Float = 1
        var dbX2: Float = 0
        if !(x < linearThreshold) {
            x2 = Float(Double(x) * 1.001)
            dbX2 = linearToDecibels(x2)
        }
        var minK: Float = 0.1
        var maxK: Float = 10000
        var k: Float = 5
        var slope: Float = 1
        for _ in 0..<15 {
            if !(x < linearThreshold) {
                let dbY = linearToDecibels(kneeCurve(x, k, linearThreshold: linearThreshold))
                let dbY2 = linearToDecibels(kneeCurve(x2, k, linearThreshold: linearThreshold))
                slope = (dbY2 - dbY) / (dbX2 - dbX)
            }
            if slope < desiredSlope { maxK = k } else { minK = k }
            k = sqrtf(minK * maxK)
        }
        return k
    }

    // MARK: - Processing

    /// One call of the read, in place (same length; the look-ahead carries across calls).
    public mutating func process(_ x: inout [Float]) {
        var i = 0
        let n = x.count
        let mask = Self.maxPreDelayFrames - 1
        while i < n {
            if divisionLeft == 0 { startDivision() }
            var detector = detectorAverage
            var gain = compressorGain
            let target = scaledDesiredGain
            let rate = envelopeRate
            let frames = min(divisionLeft, n - i)
            for _ in 0..<frames {
                let undelayed = x[i]
                preDelayBuffer[writeIndex] = undelayed
                let absInput = undelayed > 0 ? undelayed : -undelayed
                let shaped = saturate(absInput)
                let attenuation: Float = absInput <= 0.0001 ? 1 : shaped / absInput
                let dbAttenuation = max(2, -Self.linearToDecibels(attenuation))
                let dbPerFrame = dbAttenuation / satReleaseFrames
                let satReleaseRate = Self.decibelsToLinear(dbPerFrame) - 1
                let detectorRate: Float = attenuation > detector ? satReleaseRate : 1
                detector += (attenuation - detector) * detectorRate
                detector = min(1, detector)
                detector = Self.finite(detector, 1)
                if rate < 1 {
                    gain += (target - gain) * rate
                } else {
                    gain *= rate
                    gain = min(1, gain)
                }
                let warped = Float(sin(Double(Self.piOverTwo * gain)))
                let total = linearPostGain * warped
                x[i] = preDelayBuffer[readIndex] * total * extraMakeup
                i += 1
                readIndex = (readIndex + 1) & mask
                writeIndex = (writeIndex + 1) & mask
            }
            divisionLeft -= frames
            detectorAverage = Self.flushDenormal(detector)
            compressorGain = Self.flushDenormal(gain)
        }
    }

    /// The start of a 32-frame division: the desired gain from the detector and the envelope's rate toward it.
    private mutating func startDivision() {
        divisionLeft = Self.divisionFrames
        detectorAverage = Self.finite(detectorAverage, 1)
        let desiredGain = detectorAverage
        let scaled = asinf(desiredGain) / Self.piOverTwo
        scaledDesiredGain = scaled
        let isReleasing = scaled > compressorGain
        var diff: Float
        if scaled == 0 {
            diff = isReleasing ? -1 : 1
        } else {
            diff = Self.linearToDecibels(compressorGain / scaled)
        }
        if isReleasing {
            maxAttackCompressionDiff = -1
            diff = Self.finite(diff, -1)
            var x = min(0, max(-12, diff))
            x = 0.25 * (x + 12)
            let x2 = x * x, x3 = x2 * x, x4 = x2 * x2
            let releaseFrames = releaseA + releaseB * x + releaseC * x2 + releaseD * x3 + releaseE * x4
            let dbPerFrame: Float = 5 / releaseFrames
            envelopeRate = Self.decibelsToLinear(dbPerFrame)
        } else {
            diff = Self.finite(diff, 1)
            if maxAttackCompressionDiff == -1 || maxAttackCompressionDiff < diff { maxAttackCompressionDiff = diff }
            let eff = max(0.5, maxAttackCompressionDiff)
            let x: Float = 0.25 / eff
            envelopeRate = 1 - powf(x, 1 / attackFrames)
        }
    }

    /// The read's compressor for one call, in call order. Settings nil or under 0.005 = off: the samples are untouched
    /// and any compressor is dropped. A fresh read, another rate or other settings start a fresh one. True when it ran.
    @discardableResult
    public static func apply(_ comp: inout NephisCloseness?, settings: Settings?, to samples: inout [Float], sampleRate: Int,
                             restart: Bool) -> Bool {
        guard let settings, settings.on, sampleRate > 0 else {
            comp = nil
            return false
        }
        if restart || comp?.sampleRate != sampleRate || comp?.settings != settings {
            comp = NephisCloseness(settings: settings, sampleRate: sampleRate)
        }
        comp?.process(&samples)
        return true
    }
}
