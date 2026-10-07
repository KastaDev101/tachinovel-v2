//
//  VoiceCatalog.swift — the Kokoro voices TachiNovel offers, and the user's voice preferences.
//
//  All 28 English Kokoro-82M v1.0 voices (20 American, 8 British), bundled with the app (tools/fetch-voices.ts
//  VOICES must list the same ids). Each carries the model card's overall grade (hexgrad/Kokoro-82M
//  VOICES.md, "Overall Grade", A best … F worst): the picker groups voices by accent and gender and lists
//  the best first. Grades reflect the voice's training data, so the low ones sound rougher.
//

import Foundation

public struct KokoroVoice: Sendable, Equatable, Codable {
    public enum Gender: String, Sendable, Codable { case female, male }
    public let id: String
    public let name: String
    /// BCP-47 accent: en-US or en-GB.
    public let language: String
    public let gender: Gender
    /// Kokoro's own grade for the voice (A, A-, B-, C+, C, C-, D+, D, D-, F+).
    public let grade: String
    public let blurb: String

    public init(id: String, name: String, language: String, gender: Gender, grade: String, blurb: String) {
        self.id = id
        self.name = name
        self.language = language
        self.gender = gender
        self.grade = grade
        self.blurb = blurb
    }

    /// Higher is better (A = 13, A- = 12 … F = 1), for sorting.
    public var gradeRank: Int { VoiceCatalog.gradeRank(grade) }
}

public enum VoiceCatalog {
    public static let voices: [KokoroVoice] = [
        KokoroVoice(id: "af_heart", name: "Heart", language: "en-US", gender: .female, grade: "A", blurb: "Warm, expressive. The best Kokoro voice."),
        KokoroVoice(id: "af_bella", name: "Bella", language: "en-US", gender: .female, grade: "A-", blurb: "Bright and lively."),
        KokoroVoice(id: "af_nicole", name: "Nicole", language: "en-US", gender: .female, grade: "B-", blurb: "Soft and close, almost a whisper."),
        KokoroVoice(id: "af_aoede", name: "Aoede", language: "en-US", gender: .female, grade: "C+", blurb: ""),
        KokoroVoice(id: "af_kore", name: "Kore", language: "en-US", gender: .female, grade: "C+", blurb: ""),
        KokoroVoice(id: "af_sarah", name: "Sarah", language: "en-US", gender: .female, grade: "C+", blurb: ""),
        KokoroVoice(id: "af_alloy", name: "Alloy", language: "en-US", gender: .female, grade: "C", blurb: ""),
        KokoroVoice(id: "af_nova", name: "Nova", language: "en-US", gender: .female, grade: "C", blurb: ""),
        KokoroVoice(id: "af_sky", name: "Sky", language: "en-US", gender: .female, grade: "C-", blurb: ""),
        KokoroVoice(id: "af_jessica", name: "Jessica", language: "en-US", gender: .female, grade: "D", blurb: ""),
        KokoroVoice(id: "af_river", name: "River", language: "en-US", gender: .female, grade: "D", blurb: ""),
        KokoroVoice(id: "am_fenrir", name: "Fenrir", language: "en-US", gender: .male, grade: "C+", blurb: "Deep, dramatic."),
        KokoroVoice(id: "am_michael", name: "Michael", language: "en-US", gender: .male, grade: "C+", blurb: "Steady narrator."),
        KokoroVoice(id: "am_puck", name: "Puck", language: "en-US", gender: .male, grade: "C+", blurb: ""),
        KokoroVoice(id: "am_echo", name: "Echo", language: "en-US", gender: .male, grade: "D", blurb: ""),
        KokoroVoice(id: "am_eric", name: "Eric", language: "en-US", gender: .male, grade: "D", blurb: ""),
        KokoroVoice(id: "am_liam", name: "Liam", language: "en-US", gender: .male, grade: "D", blurb: ""),
        KokoroVoice(id: "am_onyx", name: "Onyx", language: "en-US", gender: .male, grade: "D", blurb: ""),
        KokoroVoice(id: "am_santa", name: "Santa", language: "en-US", gender: .male, grade: "D-", blurb: "A novelty voice."),
        KokoroVoice(id: "am_adam", name: "Adam", language: "en-US", gender: .male, grade: "F+", blurb: ""),
        KokoroVoice(id: "bf_emma", name: "Emma", language: "en-GB", gender: .female, grade: "B-", blurb: "British, calm and clear."),
        KokoroVoice(id: "bf_isabella", name: "Isabella", language: "en-GB", gender: .female, grade: "C", blurb: ""),
        KokoroVoice(id: "bf_alice", name: "Alice", language: "en-GB", gender: .female, grade: "D", blurb: ""),
        KokoroVoice(id: "bf_lily", name: "Lily", language: "en-GB", gender: .female, grade: "D", blurb: ""),
        KokoroVoice(id: "bm_fable", name: "Fable", language: "en-GB", gender: .male, grade: "C", blurb: ""),
        KokoroVoice(id: "bm_george", name: "George", language: "en-GB", gender: .male, grade: "C", blurb: "British, classic storyteller."),
        KokoroVoice(id: "bm_lewis", name: "Lewis", language: "en-GB", gender: .male, grade: "D+", blurb: ""),
        KokoroVoice(id: "bm_daniel", name: "Daniel", language: "en-GB", gender: .male, grade: "D", blurb: ""),
    ]

    public static let defaultVoiceId = "af_heart"

    public static func voice(_ id: String?) -> KokoroVoice? {
        guard let id else { return nil }
        return voices.first { $0.id == id }
    }

    public static var ids: [String] { voices.map(\.id) }

    /// A letter grade with an optional + or − (A … F) as a number, higher is better.
    public static func gradeRank(_ grade: String) -> Int {
        let letters: [Character: Int] = ["A": 4, "B": 3, "C": 2, "D": 1, "F": 0]
        guard let first = grade.first, let base = letters[first] else { return -1 }
        let mod = grade.dropFirst().first
        return base * 3 + 1 + (mod == "+" ? 1 : mod == "-" || mod == "\u{2212}" ? -1 : 0)
    }

    public enum Accent: String, Sendable, CaseIterable { case american = "en-US", british = "en-GB" }

    public struct VoiceGroup: Sendable, Equatable {
        public let accent: Accent
        public let gender: KokoroVoice.Gender
        public let voices: [KokoroVoice]
    }

    /// The picker's groups: accent, then gender; inside each, the best grade first (then by name).
    public static func grouped() -> [VoiceGroup] {
        var out: [VoiceGroup] = []
        for accent in Accent.allCases {
            for gender in [KokoroVoice.Gender.female, .male] {
                let vs = voices.filter { $0.language == accent.rawValue && $0.gender == gender }
                    .sorted { $0.gradeRank != $1.gradeRank ? $0.gradeRank > $1.gradeRank : $0.name < $1.name }
                if !vs.isEmpty { out.append(VoiceGroup(accent: accent, gender: gender, voices: vs)) }
            }
        }
        return out
    }
}

/// Persisted voice settings (UserDefaults JSON in the app). Unknown/removed voice ids fall back to the default.
public struct VoicePreferences: Sendable, Equatable, Codable {
    public var defaultVoice: String
    /// novel key ("<pluginId>:<novelPath>") → voice id.
    public var novelVoices: [String: String]
    /// Kokoro on device (on by default). Off = always the Apple voice.
    public var kokoroEnabled: Bool
    /// Play PC-narrated chapter files (the "TachiNovel Audio" folder) when they exist. Advanced, off by default.
    public var usePCAudio: Bool
    /// Core ML placement of the 7 Kokoro stages (Voice Lab). See KokoroRoute.
    public var route: String
    /// Sentences rendered ahead (2–3).
    public var ahead: Int
    /// In the car › "Car buttons" (CarButtons raw value): chapters (default) or 15-second skips.
    public var carButtons: String
    /// Listen player: speed (0.5–2.5) and "Voice volume" (0–1.5), for every voice.
    public var speed: Double
    public var volume: Double

    public init(defaultVoice: String = VoiceCatalog.defaultVoiceId, novelVoices: [String: String] = [:], kokoroEnabled: Bool = true, usePCAudio: Bool = false,
                route: String = KokoroRoute.backgroundSafe.rawValue, ahead: Int = 3, carButtons: String = CarButtons.chapters.rawValue,
                speed: Double = SpeechSpeed.defaultValue, volume: Double = VoiceVolume.defaultValue) {
        self.defaultVoice = defaultVoice
        self.novelVoices = novelVoices
        self.kokoroEnabled = kokoroEnabled
        self.usePCAudio = usePCAudio
        self.route = route
        self.ahead = ahead
        self.carButtons = carButtons
        self.speed = SpeechSpeed.clamp(speed)
        self.volume = VoiceVolume.clamp(volume)
    }

    /// Tolerant decoding: missing keys take their defaults (settings written by older builds).
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = VoicePreferences()
        defaultVoice = (try? c.decode(String.self, forKey: .defaultVoice)) ?? d.defaultVoice
        novelVoices = (try? c.decode([String: String].self, forKey: .novelVoices)) ?? d.novelVoices
        kokoroEnabled = (try? c.decode(Bool.self, forKey: .kokoroEnabled)) ?? d.kokoroEnabled
        usePCAudio = (try? c.decode(Bool.self, forKey: .usePCAudio)) ?? d.usePCAudio
        route = (try? c.decode(String.self, forKey: .route)) ?? d.route
        ahead = (try? c.decode(Int.self, forKey: .ahead)) ?? d.ahead
        carButtons = (try? c.decode(String.self, forKey: .carButtons)) ?? d.carButtons
        speed = SpeechSpeed.clamp((try? c.decode(Double.self, forKey: .speed)) ?? d.speed)
        volume = VoiceVolume.clamp((try? c.decode(Double.self, forKey: .volume)) ?? d.volume)
    }

    /// The voice for a novel: its own choice, else the global default, else Heart.
    public func voice(forNovel key: String?) -> String {
        if let key, let v = novelVoices[key], VoiceCatalog.voice(v) != nil { return v }
        return VoiceCatalog.voice(defaultVoice) != nil ? defaultVoice : VoiceCatalog.defaultVoiceId
    }

    /// Set (or clear with nil) a novel's voice. Choosing the global default clears the override.
    public mutating func setVoice(_ voice: String?, forNovel key: String) {
        if let voice, VoiceCatalog.voice(voice) != nil, voice != defaultVoice {
            novelVoices[key] = voice
        } else {
            novelVoices.removeValue(forKey: key)
        }
    }

    public var clampedAhead: Int { min(3, max(2, ahead)) }

    public var carButtonsChoice: CarButtons { CarButtons(rawValue: carButtons) ?? .chapters }
}

/// Where the Kokoro stages run. All routes keep Metal (GPU) out unless they say so: iOS doesn't allow GPU
/// work in the background, and narration has to keep rendering on the lock screen.
public enum KokoroRoute: String, Sendable, CaseIterable {
    /// Neural Engine for the RNN/attention stages, CPU for the fp32 noise + iSTFT tail. Default.
    case backgroundSafe = "ane-cpu"
    /// FluidAudio's iOS 26 default: noise + tail on the GPU. Faster, foreground only.
    case gpuTail = "ane-gpu"
    /// Every stage on CPU + Neural Engine.
    case allNeuralEngine = "all-ane"
    /// CPU only (slowest; a baseline).
    case cpuOnly = "cpu"

    public var title: String {
        switch self {
        case .backgroundSafe: return "Neural Engine + CPU (default)"
        case .gpuTail: return "Neural Engine + GPU (foreground only)"
        case .allNeuralEngine: return "All Neural Engine"
        case .cpuOnly: return "CPU only"
        }
    }

    public var usesGPU: Bool { self == .gpuTail }

    public static func from(_ raw: String?) -> KokoroRoute {
        raw.flatMap(KokoroRoute.init(rawValue:)) ?? .backgroundSafe
    }
}
