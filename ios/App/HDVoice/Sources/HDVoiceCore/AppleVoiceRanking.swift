//
//  AppleVoiceRanking.swift — which installed Apple voice stands in for Kokoro.
//
//  Quality first (Premium > Enhanced > default: users download the better ones in Settings ›
//  Accessibility › Spoken Content › Voices; apps can't trigger that), then the Kokoro voice's gender and
//  accent so a mid-chapter switch is as unobtrusive as possible. Novelty voices (Bells, Bubbles, …) and
//  Personal Voice are never picked automatically.
//

import Foundation

public struct AppleVoiceCandidate: Sendable, Equatable {
    public enum Quality: Int, Sendable, Comparable {
        case standard = 1
        case enhanced = 2
        case premium = 3
        public static func < (a: Quality, b: Quality) -> Bool { a.rawValue < b.rawValue }
        public var label: String {
            switch self {
            case .standard: return "default"
            case .enhanced: return "enhanced"
            case .premium: return "premium"
            }
        }
    }

    public enum Gender: Sendable, Equatable { case female, male, unspecified }

    public let identifier: String
    public let name: String
    public let language: String
    public let quality: Quality
    public let gender: Gender
    public let isNovelty: Bool
    public let isPersonal: Bool

    public init(identifier: String, name: String, language: String, quality: Quality, gender: Gender, isNovelty: Bool = false, isPersonal: Bool = false) {
        self.identifier = identifier
        self.name = name
        self.language = language
        self.quality = quality
        self.gender = gender
        self.isNovelty = isNovelty
        self.isPersonal = isPersonal
    }
}

public enum AppleVoiceRanking {
    public struct Pick: Sendable, Equatable {
        public let voice: AppleVoiceCandidate
        /// Only default-quality English voices are installed: show the "download a Premium voice" hint.
        public let onlyStandardInstalled: Bool
    }

    /// Best English voice for standing in for `kokoro` (nil when no English voice is installed).
    public static func pick(_ candidates: [AppleVoiceCandidate], for kokoro: KokoroVoice?) -> Pick? {
        let english = candidates.filter { $0.language.lowercased().hasPrefix("en") && !$0.isNovelty && !$0.isPersonal }
        guard !english.isEmpty else { return nil }
        let wantGender: AppleVoiceCandidate.Gender? = kokoro.map { $0.gender == .female ? .female : .male }
        let wantLanguage = kokoro?.language.lowercased() ?? "en-us"
        func score(_ v: AppleVoiceCandidate) -> Int {
            var s = v.quality.rawValue * 100
            if let wantGender, v.gender == wantGender { s += 20 }
            if v.language.lowercased() == wantLanguage { s += 10 } else if v.language.lowercased() == "en-us" { s += 4 }
            return s
        }
        // Stable tie-break by name so the pick doesn't change between launches.
        let best = english.max { a, b in
            let sa = score(a)
            let sb = score(b)
            return sa == sb ? a.name > b.name : sa < sb
        }
        guard let best else { return nil }
        return Pick(voice: best, onlyStandardInstalled: english.allSatisfy { $0.quality == .standard })
    }
}
