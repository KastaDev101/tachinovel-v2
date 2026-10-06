//
//  ListenControls.swift — the Listen player's "Voice volume" and speed: app-level, persisted, the same for
//  every voice (Kokoro, the Apple voice, prepared and PC-narrated audio), since all of them play through
//  the app's own audio graph (gain stage + peak limiter; HybridSpeechEngine, AudioChapterPlayer).
//

import Foundation

/// "Voice volume", 0–150 %. The system volume can't be set by an app, so this is a gain stage in the
/// app's audio graph; above 100 % a peak limiter keeps the boosted voice from clipping.
public enum VoiceVolume {
    public static let range: ClosedRange<Double> = 0...1.5
    public static let defaultValue = 1.0
    /// Gain stage floor (AVAudioUnitEQ.globalGain accepts −96…24 dB).
    public static let silenceDB: Float = -96

    public static func clamp(_ v: Double) -> Double {
        guard v.isFinite else { return defaultValue }
        return min(range.upperBound, max(range.lowerBound, v))
    }

    /// Gain in dB for a volume (1 = 0 dB, 1.5 ≈ +3.5 dB, 0 = silence).
    public static func gainDB(_ v: Double) -> Float {
        let c = clamp(v)
        guard c > 0.0001 else { return silenceDB }
        return max(silenceDB, Float(20 * log10(c)))
    }

    /// The limiter only works above 100 % (below, nothing can clip: voices peak under full scale).
    public static func limiterActive(_ v: Double) -> Bool { clamp(v) > 1.0001 }

    public static func percent(_ v: Double) -> Int { Int((clamp(v) * 100).rounded()) }
}

/// Listening speed, 0.5×–2.5× in 0.05 steps, with preset chips.
public enum SpeechSpeed {
    public static let range: ClosedRange<Double> = 0.5...2.5
    public static let step = 0.05
    public static let defaultValue = 1.0
    /// The Listen player's chips.
    public static let presets: [Double] = [0.9, 1, 1.1, 1.25, 1.5, 2]

    /// Into the range, on the 0.05 grid.
    public static func clamp(_ s: Double) -> Double {
        guard s.isFinite else { return defaultValue }
        let c = min(range.upperBound, max(range.lowerBound, s))
        return ((c / step).rounded() * step * 100).rounded() / 100
    }

    /// The chip a speed matches, if any.
    public static func preset(matching s: Double) -> Double? {
        let c = clamp(s)
        return presets.first { abs($0 - c) < 0.001 }
    }
}
