//
//  Narrator.swift — narrator mode: which voice reads each part of a sentence, the pause after it and its
//  speed (Settings › Voices › Narrator mode; Voice Lab A/B).
//
//  The script (src/core/narration/narrator.ts, through speech-script.ts) marks every sentence with what
//  narrator mode can use: quoted speech (`role`, or `parts` for a sentence that mixes speech and narration),
//  the speaker of an exchange, a smarter pause and a deterministic speed jitter. Each piece has its own
//  switch here; with narrator mode off nothing changes. The live engine and Prepare for the drive both go
//  through NarratorPlan, so prepared audio sounds like live narration. Audio polish (EQ, compression,
//  loudness, room tone) is in Polish.swift.
//

import Foundation

public struct NarratorSettings: Sendable, Equatable, Codable {
    /// Narrator mode as a whole (off by default; the pieces below only count when it is on).
    public var enabled: Bool
    /// Quoted speech in this voice (a built-in id or a mix id; nil = the narrator's voice).
    public var dialogueVoice: String?
    /// The other speaker of an exchange (every other paragraph of dialogue); nil = one dialogue voice.
    public var secondDialogueVoice: String?
    /// Smarter pauses (sentence endings, quick exchanges, long paragraphs).
    public var pacing: Bool
    /// Deterministic ±3 % speed variation per sentence.
    public var jitter: Bool
    /// EQ, gentle compression and loudness toward −16 LUFS.
    public var polish: Bool
    /// A faint room tone instead of digital silence (with polish).
    public var roomTone: Bool

    public init(enabled: Bool = false, dialogueVoice: String? = nil, secondDialogueVoice: String? = nil, pacing: Bool = true, jitter: Bool = true,
                polish: Bool = true, roomTone: Bool = false) {
        self.enabled = enabled
        self.dialogueVoice = dialogueVoice
        self.secondDialogueVoice = secondDialogueVoice
        self.pacing = pacing
        self.jitter = jitter
        self.polish = polish
        self.roomTone = roomTone
    }

    /// Tolerant decoding: missing keys take their defaults.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = NarratorSettings()
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? d.enabled
        dialogueVoice = try? c.decode(String.self, forKey: .dialogueVoice)
        secondDialogueVoice = try? c.decode(String.self, forKey: .secondDialogueVoice)
        pacing = (try? c.decode(Bool.self, forKey: .pacing)) ?? d.pacing
        jitter = (try? c.decode(Bool.self, forKey: .jitter)) ?? d.jitter
        polish = (try? c.decode(Bool.self, forKey: .polish)) ?? d.polish
        roomTone = (try? c.decode(Bool.self, forKey: .roomTone)) ?? d.roomTone
    }

    public var usesPacing: Bool { enabled && pacing }
    public var usesJitter: Bool { enabled && jitter }
    public var usesPolish: Bool { enabled && polish }
    public var usesRoomTone: Bool { enabled && polish && roomTone }

    /// Every piece on, with these dialogue voices (Voice Lab "B").
    public static func all(dialogueVoice: String?, secondDialogueVoice: String? = nil, roomTone: Bool = false) -> NarratorSettings {
        NarratorSettings(enabled: true, dialogueVoice: dialogueVoice, secondDialogueVoice: secondDialogueVoice, roomTone: roomTone)
    }
}

/// A sentence as the script sends it (the narrator-mode fields of SpeechItem).
public struct NarratorSentence: Sendable, Equatable {
    public struct Part: Sendable, Equatable {
        public let dialogue: Bool
        public let text: String
        public let runs: [SpeechRun]?

        public init(dialogue: Bool, text: String, runs: [SpeechRun]?) {
            self.dialogue = dialogue
            self.text = text
            self.runs = runs
        }
    }

    public let text: String
    public let runs: [SpeechRun]?
    /// The whole sentence is dialogue.
    public let quoted: Bool
    /// A sentence that mixes speech and narration, by role (nil otherwise).
    public let parts: [Part]?
    /// 0 or 1: which speaker of an exchange.
    public let speaker: Int
    public let pauseMs: Double
    public let pacedMs: Double?
    public let rate: Double?

    public init(text: String, runs: [SpeechRun]?, quoted: Bool = false, parts: [Part]? = nil, speaker: Int = 0, pauseMs: Double, pacedMs: Double? = nil,
                rate: Double? = nil) {
        self.text = text
        self.runs = runs
        self.quoted = quoted
        self.parts = parts
        self.speaker = speaker
        self.pauseMs = pauseMs
        self.pacedMs = pacedMs
        self.rate = rate
    }
}

/// One piece of a sentence to render with one voice (nil = the narrator's voice).
public struct NarratorPart: Sendable, Equatable {
    public let text: String
    public let runs: [SpeechRun]?
    public let voice: String?

    public init(text: String, runs: [SpeechRun]?, voice: String?) {
        self.text = text
        self.runs = runs
        self.voice = voice
    }
}

public enum NarratorPlan {
    /// Silence between the parts of one sentence ("“Run,” | she said."), at 1.0×.
    public static let partGap: TimeInterval = 0.12

    /// The voices of a sentence: nil when it is read as one piece in the narrator's voice (narrator mode
    /// off, no dialogue voice, or a sentence without dialogue). `resolve` turns a stored choice (built-in
    /// or mix id) into the voice the engine speaks with, nil if it no longer exists.
    public static func parts(for s: NarratorSentence, settings: NarratorSettings, resolve: (String) -> String?) -> [NarratorPart]? {
        guard settings.enabled, let first = settings.dialogueVoice.flatMap(resolve) else { return nil }
        let second = settings.secondDialogueVoice.flatMap(resolve)
        let dialogueVoice = s.speaker == 1 ? (second ?? first) : first
        if let parts = s.parts, parts.contains(where: \.dialogue), parts.count > 1 {
            return parts.map { NarratorPart(text: $0.text, runs: $0.runs, voice: $0.dialogue ? dialogueVoice : nil) }
        }
        if s.quoted { return [NarratorPart(text: s.text, runs: s.runs, voice: dialogueVoice)] }
        return nil
    }

    /// The pause after a sentence, in seconds at 1.0×.
    public static func pause(for s: NarratorSentence, settings: NarratorSettings) -> TimeInterval {
        let ms = settings.usesPacing ? (s.pacedMs ?? s.pauseMs) : s.pauseMs
        return max(0, ms) / 1000
    }

    /// The speed for a sentence: the listener's speed, times the jitter factor (clamped to ±3 %).
    public static func rate(_ base: Float, for s: NarratorSentence, settings: NarratorSettings) -> Float {
        guard settings.usesJitter, let r = s.rate, r.isFinite else { return base }
        return base * Float(min(1.03, max(0.97, r)))
    }
}

extension VoicePreferences {
    /// The engine voice for each narrator-mode part (nil voice → the narrator's).
    public func narratorParts(for s: NarratorSentence) -> [NarratorPart]? {
        NarratorPlan.parts(for: s, settings: narrator) { engineVoice($0) }
    }

    /// The key prepared audio is filed under: the voice, plus narrator mode's settings while it is on, so
    /// audio prepared without narrator mode (or with other dialogue voices) isn't played as if it had it.
    public func preparedVoice(voice: String) -> String {
        guard narrator.enabled else { return voice }
        let n = narrator
        let first = n.dialogueVoice.flatMap { engineVoice($0) } ?? "-"
        let second = n.secondDialogueVoice.flatMap { engineVoice($0) } ?? "-"
        let flags = [n.pacing, n.jitter, n.polish, n.usesRoomTone].map { $0 ? "1" : "0" }.joined()
        return "\(voice)|narrator:\(first),\(second),\(flags)"
    }

    public func preparedVoice(forNovel key: String?) -> String { preparedVoice(voice: voice(forNovel: key)) }
}
