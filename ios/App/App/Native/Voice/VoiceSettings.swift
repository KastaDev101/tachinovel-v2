//
//  VoiceSettings.swift — persisted voice choices + the Apple voice that stands in for Kokoro.
//
//  Settings › Voices (src/ui/native/voices-screen.ts) and the Listen player read and change these through
//  the Narration plugin (voiceSettings / setVoiceSettings). Main thread only.
//

import AVFoundation
import Foundation
import HDVoiceCore

final class VoiceSettings {
    static let shared = VoiceSettings()
    static let changed = Notification.Name("tachinovel.voiceSettingsChanged")

    private static let key = "tachinovel.voicePreferences"
    private(set) var prefs: VoicePreferences

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.key),
           let p = try? JSONDecoder().decode(VoicePreferences.self, from: data) {
            prefs = p
        } else {
            prefs = VoicePreferences()
        }
    }

    func update(_ change: (inout VoicePreferences) -> Void) {
        var p = prefs
        change(&p)
        guard p != prefs else { return }
        prefs = p
        if let data = try? JSONEncoder().encode(p) { UserDefaults.standard.set(data, forKey: Self.key) }
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }

    static func novelKey(pluginId: String, novelPath: String) -> String { "\(pluginId):\(novelPath)" }

    // MARK: - Apple voices

    /// Installed English voices as ranking candidates.
    static func appleCandidates() -> [AppleVoiceCandidate] {
        AVSpeechSynthesisVoice.speechVoices().compactMap { v in
            guard v.language.lowercased().hasPrefix("en") else { return nil }
            let quality: AppleVoiceCandidate.Quality
            switch v.quality {
            case .premium: quality = .premium
            case .enhanced: quality = .enhanced
            default: quality = .standard
            }
            let gender: AppleVoiceCandidate.Gender
            switch v.gender {
            case .female: gender = .female
            case .male: gender = .male
            default: gender = .unspecified
            }
            return AppleVoiceCandidate(identifier: v.identifier, name: v.name, language: v.language, quality: quality, gender: gender,
                                       isNovelty: v.voiceTraits.contains(.isNoveltyVoice), isPersonal: v.voiceTraits.contains(.isPersonalVoice))
        }
    }

    /// The voice used when Kokoro can't deliver: the user's explicit system voice (Narration.setOptions
    /// voiceId), else the best installed English voice matching the Kokoro voice's gender and accent.
    static func appleVoice(explicit identifier: String?, kokoroVoice: String) -> AVSpeechSynthesisVoice? {
        if let identifier, let v = AVSpeechSynthesisVoice(identifier: identifier) { return v }
        if let pick = AppleVoiceRanking.pick(appleCandidates(), for: VoiceCatalog.voice(kokoroVoice)),
           let v = AVSpeechSynthesisVoice(identifier: pick.voice.identifier) { return v }
        return AVSpeechSynthesisVoice(language: "en-US")
    }

    /// Map the Listen speed 0.5…2.5 onto AVSpeech's 0…1 scale around the default rate.
    static func avRate(_ r: Float) -> Float {
        let base = AVSpeechUtteranceDefaultSpeechRate
        let span = Float(SpeechSpeed.range.upperBound - 1)
        let rate = r >= 1 ? base + (AVSpeechUtteranceMaximumSpeechRate - base) * min(1, (r - 1) / span) : base * max(0.5, r)
        return max(AVSpeechUtteranceMinimumSpeechRate, min(AVSpeechUtteranceMaximumSpeechRate, rate))
    }

    /// For the UI: the fallback voice and whether to show the "download a Premium voice" hint.
    static func appleSummary(kokoroVoice: String) -> [String: Any] {
        guard let pick = AppleVoiceRanking.pick(appleCandidates(), for: VoiceCatalog.voice(kokoroVoice)) else {
            return ["name": "System voice", "quality": "default", "onlyDefault": true]
        }
        return ["id": pick.voice.identifier, "name": pick.voice.name, "language": pick.voice.language,
                "quality": pick.voice.quality.label, "onlyDefault": pick.onlyStandardInstalled]
    }
}
