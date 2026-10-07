//
//  Phonemes.swift — splice pronunciation-lexicon overrides into Kokoro input.
//
//  The narration front-end (v1 experiments/tts/frontend.ts, shared with the PC narrator) cuts lexicon
//  matches out of a sentence: "Nephis, wait!" → [phonemes "nˈɛfɪs"] [text ", wait!"]. Text runs go through
//  Kokoro's own G2P (Misaki lexicon + BART); phoneme runs are used verbatim. This joins the results into one
//  phoneme string, ready for KokoroAneManager.synthesizeFromPhonemes.
//

import Foundation

public enum SpeechRun: Sendable, Equatable {
    /// Plain text for the engine's G2P.
    case text(String)
    /// Kokoro (misaki) phonemes from the lexicon, used as they are.
    case phonemes(String)
}

public enum PhonemeJoiner {
    /// Punctuation Kokoro's vocabulary carries as prosody tokens.
    public static let punctuation: Set<Character> = [",", ".", "!", "?", ";", ":", "…", "—", "\"", "(", ")"]

    /// Punctuation that attaches to the previous word (no space before it).
    static let attaching: Set<Character> = [",", ".", "!", "?", ";", ":", "…", ")"]

    /// True when a text run has nothing to pronounce (only spaces/punctuation).
    public static func isSilent(_ text: String) -> Bool {
        !text.contains { $0.isLetter || $0.isNumber }
    }

    /// Punctuation of a silent run, kept as prosody tokens (", " → ",").
    public static func punctuationOnly(_ text: String) -> String {
        String(text.filter { punctuation.contains($0) })
    }

    /// Join phonemized runs. `parts` pairs each original run with its phoneme string. Chunks are separated
    /// by a space (runs meet at word boundaries), except before attaching punctuation and where a text run
    /// is glued to the override before it without whitespace ("[Nephis]'s" stays one word).
    public static func join(_ parts: [(run: SpeechRun, phonemes: String)]) -> String {
        var out = ""
        var previousWasOverride = false
        for part in parts {
            let ph = part.phonemes.trimmingCharacters(in: .whitespacesAndNewlines)
            var isOverride = false
            var glued = false
            switch part.run {
            case .phonemes:
                isOverride = true
            case .text(let original):
                if previousWasOverride, let c = original.first, c.isLetter || c == "'" || c == "\u{2019}" { glued = true }
            }
            if !ph.isEmpty {
                if let first = ph.first, !out.isEmpty, !attaching.contains(first), !glued { out += " " }
                out += ph
            }
            previousWasOverride = isOverride
        }
        return out
    }

    /// Kokoro's input limit (ALBERT context 512 incl. BOS/EOS), counted in Unicode scalars.
    public static let maxPhonemes = 510

    public static func fits(_ phonemes: String) -> Bool {
        phonemes.unicodeScalars.count <= maxPhonemes
    }

    /// Split a phoneme string into pieces Kokoro takes in one pass (≤ `limit` Unicode scalars), each cut at
    /// the strongest break before the limit: sentence punctuation (. ! ? ; : …), then a comma or dash, then
    /// a space; a hard cut only when one "word" is longer than the limit. Breaks in the first quarter of a
    /// piece are skipped (no tiny pieces). Pieces are trimmed; a string that fits comes back whole.
    /// (FluidAudio's own chunker is internal; this one serves the paths that bypass its text entry point:
    /// voice mixes, and lexicon overrides in a long sentence.)
    public static func chunks(_ phonemes: String, limit: Int = maxPhonemes) -> [String] {
        let s = Array(phonemes.unicodeScalars)
        guard s.count > limit else {
            let whole = phonemes.trimmingCharacters(in: .whitespaces)
            return whole.isEmpty ? [] : [whole]
        }
        let strong: Set<Unicode.Scalar> = [".", "!", "?", ";", ":", "…"]
        let weak: Set<Unicode.Scalar> = [",", "—"]
        var out: [String] = []
        var start = 0
        while start < s.count {
            while start < s.count, s[start] == " " { start += 1 }
            guard start < s.count else { break }
            var end = s.count
            if s.count - start > limit {
                let hi = start + limit
                let earliest = start + max(1, limit / 4)
                func after(_ set: Set<Unicode.Scalar>) -> Int? {
                    var i = hi - 1
                    while i >= earliest {
                        if set.contains(s[i]) { return i + 1 }
                        i -= 1
                    }
                    return nil
                }
                func atSpace() -> Int? {
                    var i = hi
                    while i > start {
                        if s[i] == " " { return i }
                        i -= 1
                    }
                    return nil
                }
                end = after(strong) ?? after(weak) ?? atSpace() ?? hi
            }
            let piece = String(String.UnicodeScalarView(s[start..<end])).trimmingCharacters(in: .whitespaces)
            if !piece.isEmpty { out.append(piece) }
            start = end
        }
        return out
    }
}

/// Thermal state → throttle Kokoro (no new renders) at serious or critical. ProcessInfo.ThermalState raw
/// values: 0 nominal, 1 fair, 2 serious, 3 critical.
public enum ThermalPolicy {
    public static func throttled(rawState: Int) -> Bool { rawState >= 2 }
}

/// Reloading the model after it was released under memory pressure: wait, and back off if it happens again.
public struct ReloadBackoff: Sendable, Equatable {
    public private(set) var attempt = 0
    public let base: TimeInterval
    public let cap: TimeInterval

    public init(base: TimeInterval = 60, cap: TimeInterval = 600) {
        self.base = base
        self.cap = cap
    }

    /// Delay before the next reload, and count this release.
    public mutating func nextDelay() -> TimeInterval {
        let d = min(cap, base * pow(2, Double(attempt)))
        attempt += 1
        return d
    }

    /// The model stayed loaded long enough: forget earlier releases.
    public mutating func reset() { attempt = 0 }
}
