//
//  VoiceCatalog.swift — the Kokoro voices TachiNovel offers, and the user's voice preferences.
//
//  Six English Kokoro-82M v1.0 voices, picked from the model card's grades (hexgrad/Kokoro-82M VOICES.md)
//  and the PC lab's listening tests, balanced across US/UK and female/male. They are bundled with the app
//  (tools/fetch-voices.ts VOICES must list the same ids).
//

import Foundation

public struct KokoroVoice: Sendable, Equatable, Codable {
    public enum Gender: String, Sendable, Codable { case female, male }
    public let id: String
    public let name: String
    /// BCP-47 accent: en-US or en-GB.
    public let language: String
    public let gender: Gender
    public let blurb: String

    public init(id: String, name: String, language: String, gender: Gender, blurb: String) {
        self.id = id
        self.name = name
        self.language = language
        self.gender = gender
        self.blurb = blurb
    }
}

public enum VoiceCatalog {
    public static let voices: [KokoroVoice] = [
        KokoroVoice(id: "af_heart", name: "Heart", language: "en-US", gender: .female, blurb: "Warm, expressive. The best Kokoro voice."),
        KokoroVoice(id: "af_bella", name: "Bella", language: "en-US", gender: .female, blurb: "Bright and lively."),
        KokoroVoice(id: "bf_emma", name: "Emma", language: "en-GB", gender: .female, blurb: "British, calm and clear."),
        KokoroVoice(id: "am_michael", name: "Michael", language: "en-US", gender: .male, blurb: "Steady narrator."),
        KokoroVoice(id: "am_fenrir", name: "Fenrir", language: "en-US", gender: .male, blurb: "Deep, dramatic."),
        KokoroVoice(id: "bm_george", name: "George", language: "en-GB", gender: .male, blurb: "British, classic storyteller."),
    ]

    public static let defaultVoiceId = "af_heart"

    public static func voice(_ id: String?) -> KokoroVoice? {
        guard let id else { return nil }
        return voices.first { $0.id == id }
    }

    public static var ids: [String] { voices.map(\.id) }
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

    public init(defaultVoice: String = VoiceCatalog.defaultVoiceId, novelVoices: [String: String] = [:], kokoroEnabled: Bool = true, usePCAudio: Bool = false,
                route: String = KokoroRoute.backgroundSafe.rawValue, ahead: Int = 3, carButtons: String = CarButtons.chapters.rawValue) {
        self.defaultVoice = defaultVoice
        self.novelVoices = novelVoices
        self.kokoroEnabled = kokoroEnabled
        self.usePCAudio = usePCAudio
        self.route = route
        self.ahead = ahead
        self.carButtons = carButtons
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
