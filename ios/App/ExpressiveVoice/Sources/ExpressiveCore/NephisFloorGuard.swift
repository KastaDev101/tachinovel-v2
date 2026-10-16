//
//  NephisFloorGuard.swift — the browser EQ tuner's floor guard (pack.json chain "floorGuard", Kasta 2026-10-15): a
//  gentle downward expander after the closeness compressor, so the quiet floor the compressor lifted (breath noise, the
//  model's hiss between words) sinks again while words stay as they are.
//
//    "floorGuard": {"amount": 0.4}        amount g, 0…1; g < 0.005 = off
//
//  The tuner's definition (WebAudio, at its page level):
//    envelope  e = 30 · LPF20(|x|)       LPF20: a 2nd-order low-pass at 20 Hz, WebAudio's BiquadFilterNode "lowpass" with
//                                          Q -3 (dB: Chromium SetLowpassParams, resonance 10^(-3/20) = 0.7079)
//    curve     c(e) = 1                           when g < 0.005 or e >= xT
//                     max(floor, (e / xT)^(r - 1)) otherwise, with xT = 0.075, r = 1 + 2g, floor = 10^(-12g / 20)
//    output    y = x · c(e)
//  The tuner's signal is 6.02 dB quieter than the phone's (x_phone = 2 · x_page, as for closeness and breath air), so
//  here the envelope is 30 · LPF20(|x|) / 2: the same gain for the same sound. Evaluated exactly (the tuner's curve is a
//  WaveShaper table; its input, the envelope, is clamped to [-1, 1] there, which changes nothing: c = 1 from xT on).
//  No look-ahead and no delay: the gain follows the 20 Hz envelope (a ~25 ms lag), as in the tuner.
//
//  One guard runs over a whole read like the other finishing stages (its filter state carries from call to call); a new
//  read or another rate starts a fresh one, settled on silence. Absent, unreadable or under 0.005: off, the audio
//  bit-identical. Cost: one biquad, one pow per sample under the threshold (~1-2 ms per second of audio).
//

import Foundation

public struct NephisFloorGuard: Sendable {
    /// pack.json chain "floorGuard": {"amount": 0.4}. `amount` is needed (a block without it is unreadable: off), 0…1.
    public struct Settings: Codable, Sendable, Equatable {
        public var amount: Double

        public init(amount: Double) {
            self.amount = amount.isFinite ? min(1, max(0, amount)) : 0
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(amount: try c.decode(Double.self, forKey: .amount))
        }

        /// Under this the stage is bypassed (the tuner's).
        public static let off = 0.005
        public var on: Bool { amount >= Self.off }
        /// The expander's ratio r = 1 + 2g and its deepest cut, 10^(-12g/20) (-12 dB at g = 1).
        public var ratio: Double { 1 + 2 * amount }
        public var floorGain: Double { pow(10, -12 * amount / 20) }
    }

    /// The tuner's threshold on its envelope, its envelope gain, the detector's corner and WebAudio Q (dB).
    public static let threshold = 0.075
    public static let envelopeGain = 30.0
    public static let detectorHz = 20.0
    public static let detectorQ = pow(10, -3.0 / 20)
    /// The phone's signal is this much hotter than the tuner's (x_phone = 2 · x_page).
    public static let phoneLevel = 2.0

    public let settings: Settings
    public let sampleRate: Int
    private var detector: ToneBiquad

    public init(settings: Settings, sampleRate: Int) {
        self.settings = settings
        self.sampleRate = sampleRate
        detector = .lowPass(hz: Self.detectorHz, q: Self.detectorQ, fs: Double(max(1, sampleRate)))
    }

    /// The tuner's gain for an envelope value `e` (its units).
    public static func gain(envelope e: Double, settings: Settings) -> Double {
        guard settings.on, e < threshold else { return 1 }
        return max(settings.floorGain, pow(max(0, e) / threshold, settings.ratio - 1))
    }

    public mutating func process(_ x: inout [Float]) {
        let scale = Self.envelopeGain / Self.phoneLevel
        for i in x.indices {
            let v = Double(x[i])
            let e = detector.process(abs(v)) * scale
            x[i] = Float(v * Self.gain(envelope: e, settings: settings))
        }
    }

    /// The guard over one call (the read's guard, carried in `guarded`; nil while off). Off (absent or under 0.005): the
    /// samples untouched and `guarded` dropped. `restart` (a new read) or another rate starts a fresh one. True when it ran.
    @discardableResult
    public static func apply(_ guarded: inout NephisFloorGuard?, settings: Settings?, to samples: inout [Float], sampleRate: Int,
                             restart: Bool) -> Bool {
        guard let settings, settings.on, sampleRate > 0 else {
            guarded = nil
            return false
        }
        if restart || guarded?.sampleRate != sampleRate || guarded?.settings != settings {
            guarded = NephisFloorGuard(settings: settings, sampleRate: sampleRate)
        }
        guarded?.process(&samples)
        return true
    }
}
