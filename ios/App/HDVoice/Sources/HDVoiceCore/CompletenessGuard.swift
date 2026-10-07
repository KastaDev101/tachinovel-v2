//
//  CompletenessGuard.swift — did the expressive voice say the whole text?
//
//  Pocket TTS sometimes ends a line early (its end-of-speech fires after a "…" or a short interjection) and drops
//  the rest. Measured on the PC (2026-10-07, 40 renders of one line): complete renders had 0.136–0.165 s of voiced
//  audio per syllable, cut-short ones 0.068–0.086 s. A render under 0.105 s per syllable, or under 65 % of the
//  session's running median, is re-rendered once; the longer take is kept. Lines under 8 syllables aren't judged.
//

import Foundation

public struct CompletenessGuard: Sendable {
    public static let minSyllables = 8
    public static let floorPerSyllable = 0.105
    public static let medianShare = 0.65
    private var recent: [Double] = []

    public init() {}

    /// Voiced seconds: 10 ms frames whose RMS is above 6 % of the loudest frame (and above silence).
    public static func voicedSeconds(_ x: [Float], sampleRate: Int) -> Double {
        let n = max(1, sampleRate / 100)
        guard x.count >= n else { return 0 }
        var rms: [Float] = []
        rms.reserveCapacity(x.count / n)
        var i = 0
        while i + n <= x.count {
            var s: Float = 0
            for k in i..<(i + n) { s += x[k] * x[k] }
            rms.append((s / Float(n)).squareRoot())
            i += n
        }
        let threshold = max(1e-4, (rms.max() ?? 0) * 0.06)
        return Double(rms.filter { $0 > threshold }.count) / 100
    }

    /// Voiced seconds per syllable, nil when the line is too short to judge.
    public static func perSyllable(_ x: [Float], sampleRate: Int, syllables: Int) -> Double? {
        guard syllables >= minSyllables else { return nil }
        return voicedSeconds(x, sampleRate: sampleRate) / Double(syllables)
    }

    /// The render looks cut short.
    public func isShort(_ perSyllable: Double?) -> Bool {
        guard let v = perSyllable else { return false }
        if v < Self.floorPerSyllable { return true }
        guard recent.count >= 3 else { return false }
        let sorted = recent.sorted()
        return v < sorted[sorted.count / 2] * Self.medianShare
    }

    /// Remember an accepted render (the last 15).
    public mutating func accept(_ perSyllable: Double?) {
        guard let v = perSyllable else { return }
        recent.append(v)
        if recent.count > 15 { recent.removeFirst() }
    }
}
