//
//  ExpressiveCatalog.swift — the experimental engines, what each can act on, and how a line of a novel
//  (text + emotion + style + speaker role, see src/ui/native/expressive-samples.ts) becomes engine input.
//
//  Chatterbox Nano   inline tags in the text: style/emotion tags at the start ([angry], [whispering], …)
//                    and sound events where they occur ([laugh], [sigh], [gasp], …). One built-in voice.
//                    ≤ 9.9 s of audio per call → lines are cut into ≤ 120-character chunks.
//  NeuTTS-2E         an emotion per call (angry, disgusted, fearful, happy, neutral, sad, surprised) and one
//                    of four speakers (emily, paul, sophie, steven): narrator and characters get different
//                    voices. Tags are removed from the text.
//  Pocket TTS        plain text, one voice per call (voice prompt "alba"), streaming; no emotion control.
//

import Foundation

public enum ExpressiveEngineID: String, CaseIterable, Sendable, Codable {
    case chatterboxNano = "chatterbox-nano"
    case neutts2e = "neutts-2e"
    case pocketTts = "pocket-tts"

    public var pinned: PinnedEngineModel? { PinnedModels.model(rawValue) }

    public var title: String {
        switch self {
        case .chatterboxNano: return "Chatterbox Nano"
        case .neutts2e: return "NeuTTS-2E"
        case .pocketTts: return "Pocket TTS"
        }
    }

    public var blurb: String {
        switch self {
        case .chatterboxNano: return "Resemble AI, 110M. Acts on tags: [angry], [whispering], [laugh], [sigh], [gasp]… One voice."
        case .neutts2e: return "Neuphonic, 236M. Seven emotions, four speakers (narrator and characters get their own voice)."
        case .pocketTts: return "Kyutai, 100M. Natural, streaming, voice cloning; no emotion control."
        }
    }

    /// Core ML puts (part of) the model on the GPU, which iOS forbids in the background: such an engine only
    /// renders while the app is in the foreground (the lab falls back to Kokoro on the lock screen).
    public var usesGPU: Bool {
        switch self {
        case .chatterboxNano, .neutts2e: return true
        case .pocketTts: return false
        }
    }

    /// Longest text per synthesis call (characters); longer lines are chunked (TextChunker).
    public var maxCharactersPerCall: Int {
        switch self {
        case .chatterboxNano: return 120 // ≤ 247 speech tokens ≈ 9.9 s of audio with the built-in voice
        case .neutts2e: return 220 // 768-token prefill window incl. the speaker reference
        case .pocketTts: return 400 // FluidAudio chunks internally as well
        }
    }

    public var sampleRate: Int { 24_000 }

    /// Chatterbox Nano and NeuTTS-2E keep their KV cache in Core ML MLState (iOS 18 / macOS 15).
    public var needsIOS18: Bool { self != .pocketTts }
}

/// One line to speak, as the Voice Lab sends it.
public struct ExpressiveLine: Sendable, Equatable, Codable {
    public var text: String
    /// neutral, happy, sad, angry, fearful, surprised, disgusted
    public var emotion: String
    /// whisper, dramatic, sarcastic, narration (Chatterbox tags only)
    public var style: String?
    /// narrator, male, female; "performed" = the narrator voice performing (dialogue, thoughts; Pocket TTS)
    public var role: String

    public static let performedRole = "performed"
    /// Sampling temperature for engines that take one per call (Pocket TTS); nil = the engine's default.
    public var temperature: Float?
    /// Nephis flow (NephisFlowSynth): the pause before this call's first word (seconds; nil = 0.6), a fresh read
    /// (a new chapter, a seek: nothing carries over), the read's last call (its trailing silence is played too), and
    /// how many takes to try (best one kept; nil = 1).
    public var pauseBefore: Double?
    public var flowReset: Bool?
    public var flowLast: Bool?
    public var takes: Int?

    public init(text: String, emotion: String = "neutral", style: String? = nil, role: String = "narrator") {
        self.text = text
        self.emotion = emotion
        self.style = style
        self.role = role
    }
}

public enum StyleMapper {
    /// Chatterbox Nano's sound-event tags (tokenizer added tokens); kept inline for Chatterbox, removed otherwise.
    public static let soundTags = ["laugh", "chuckle", "sigh", "gasp", "cough", "sniff", "groan", "shush", "clear throat"]

    public static let neuttsEmotions = ["angry", "disgusted", "fearful", "happy", "neutral", "sad", "surprised"]
    public static let neuttsSpeakers = ["emily", "paul", "sophie", "steven"]

    /// Text without sound tags and without the spaces they leave behind.
    public static func plainText(_ text: String) -> String {
        var out = text
        for tag in soundTags {
            out = out.replacingOccurrences(of: "[\(tag)]", with: " ", options: .caseInsensitive)
        }
        out = out.replacingOccurrences(of: "\\s+([,.!?;:…”’])", with: "$1", options: .regularExpression)
        out = out.replacingOccurrences(of: "\\s{2,}", with: " ", options: .regularExpression)
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Pocket TTS's text: an ellipsis ends its generation early (measured 2026-10-07: "Hmm... I've seen farmers do
    /// better." lost its second half in 1 of 5 renders with the Narrator voice, 5 of 5 with a performed one; with a
    /// comma 0 of 10). So a trailing-off "…" inside a line becomes a comma, at the end of a line or quote a period,
    /// and a leading one goes. The hesitation comes back afterwards: NaturalFinish stretches the pause at each
    /// ellipsis the director marked (350–450 ms).
    public static func pocketText(_ text: String) -> String {
        let dots = #"(?:\.\s?\.\s?\.|…)"#
        // "Hmm"/"Hmmm" come out erratic, sometimes almost silent (0.09–0.62 s voiced over 4 renders); "Hm" holds a
        // proper hum (0.66–0.81 s in 3 of 4). Measured 2026-10-07.
        var out = joinBrokenWords(text).replacingOccurrences(of: #"\b([Hh])m{2,}\b"#, with: "$1m", options: .regularExpression)
        let rules: [(String, String)] = [
            (#"(^|[“"‘'(\[]\s*)\#(dots)+\s*"#, "$1"), // leading: "…and then", "“…what"
            (#"\#(dots)+(?=[?!])"#, ""), // "what…?" → "what?"
            (#"\#(dots)+(?=[”"’']|\s*$)"#, "."), // trailing off at the end of a line or quote
            (#"\#(dots)+(?=\s)"#, ","), // "Hmm… I've", "bite… often"
            (#"\#(dots)+"#, ", "), // "Hmm…well" (no space)
            (#",(?:\s*,)+"#, ","), // "paused, …, then" → "paused, then"
            (#",\s*([.!?])"#, "$1"),
            (#"\s{2,}"#, " "),
        ]
        for (pattern, template) in rules {
            out = out.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Word endings that, after a trailing-off "…", finish the word before it ("Damna… tion" → "Damnation"); a
    /// real word after one stays apart ("bite… often", "Gods… help").
    static let brokenWordEndings: Set<String> = [
        "tion", "tions", "sion", "sions", "ation", "ible", "able", "ably", "ibly", "ment", "ments", "ness", "less", "ful",
        "ous", "ious", "ive", "ity", "ally", "ing", "ings", "ed", "er", "ers", "est", "ly", "al", "ial", "ian", "ance",
        "ence", "ant", "ent", "ism", "ist", "ize", "ise", "ted", "ble", "tic", "ty", "ry", "ny", "cy",
    ]

    /// "Damna… tion" → "Damnation", "imposs... ible" → "impossible": a word broken by a trailing-off "…" is read
    /// whole (the director's ellipsis stretch still lengthens the moment).
    static func joinBrokenWords(_ text: String) -> String {
        guard let re = try? NSRegularExpression(pattern: #"(\p{L}{2,})(?:\.\s?\.\s?\.|…)\s*(\p{Ll}{1,5})(?=[^\p{L}]|$)"#) else { return text }
        var out = text
        for m in re.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            guard let whole = Range(m.range, in: out), let head = Range(m.range(at: 1), in: out), let tail = Range(m.range(at: 2), in: out) else { continue }
            let fragment = String(out[tail])
            guard brokenWordEndings.contains(fragment) else { continue }
            out.replaceSubrange(whole, with: String(out[head]) + fragment)
        }
        return out
    }

    /// The tag Chatterbox Nano gets in front of a line (style first, else the emotion), or nil.
    public static func chatterboxLeadTag(_ line: ExpressiveLine) -> String? {
        switch line.style ?? "" {
        case "whisper": return "[whispering]"
        case "dramatic": return "[dramatic]"
        case "sarcastic": return "[sarcastic]"
        case "narration": return "[narration]"
        default: break
        }
        switch line.emotion {
        case "angry": return "[angry]"
        case "fearful": return "[fear]"
        case "surprised": return "[surprised]"
        case "happy": return "[happy]"
        default: return nil // neutral, sad (carried by [sigh]/[crying] in the text if wanted), disgusted
        }
    }

    /// Chatterbox input chunks: the lead tag in front of every chunk, sound tags left where they are.
    public static func chatterboxChunks(_ line: ExpressiveLine, limit: Int) -> [String] {
        let prefix = chatterboxLeadTag(line).map { "\($0) " } ?? ""
        let room = max(20, limit - prefix.count)
        let body = line.text.replacingOccurrences(of: "\\s{2,}", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return TextChunker.chunks(body, limit: room).map { prefix + $0 }
    }

    public static func neuttsEmotion(_ line: ExpressiveLine) -> String {
        if neuttsEmotions.contains(line.emotion) { return line.emotion }
        return "neutral"
    }

    /// Narrator and characters get distinct NeuTTS speakers (the narrator's can be chosen).
    public static func neuttsSpeaker(role: String, narrator: String = "emily") -> String {
        let n = neuttsSpeakers.contains(narrator) ? narrator : "emily"
        switch role {
        case "male": return n == "paul" ? "steven" : "paul"
        case "female": return n == "sophie" ? "emily" : "sophie"
        default: return n
        }
    }
}

public enum TextChunker {
    /// Split `text` into pieces of at most `limit` characters: at sentence ends if possible, else at
    /// ; : , or a dash, else at a space. A [tag] is never cut. Pieces are trimmed and never empty.
    public static func chunks(_ text: String, limit: Int) -> [String] {
        let limit = max(8, limit)
        var rest = Array(text.trimmingCharacters(in: .whitespacesAndNewlines))
        var out: [String] = []
        while rest.count > limit {
            let cut = splitIndex(rest, limit: limit)
            let piece = String(rest[..<cut]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !piece.isEmpty { out.append(piece) }
            rest = Array(String(rest[cut...]).trimmingCharacters(in: .whitespacesAndNewlines))
        }
        let last = String(rest).trimmingCharacters(in: .whitespacesAndNewlines)
        if !last.isEmpty { out.append(last) }
        return out
    }

    /// Index to cut at (exclusive end of the first piece), 1...limit.
    static func splitIndex(_ chars: [Character], limit: Int) -> Int {
        var inTag = [Bool](repeating: false, count: chars.count)
        var open = false
        for (i, c) in chars.enumerated() {
            if c == "[" { open = true }
            inTag[i] = open
            if c == "]" { open = false }
        }
        let minPiece = limit / 3
        func best(_ isBreak: (Int) -> Bool) -> Int? {
            var i = min(limit, chars.count) - 1
            while i >= minPiece {
                if !inTag[i], isBreak(i) { return i + 1 }
                i -= 1
            }
            return nil
        }
        let sentenceEnd: Set<Character> = [".", "!", "?", "…"]
        let closers: Set<Character> = ["\"", "”", "’", ")"]
        let clause: Set<Character> = [";", ":", ",", "—", "–"]
        let atSentenceEnd: (Int) -> Bool = { k in
            sentenceEnd.contains(chars[k]) && (k + 1 >= chars.count || chars[k + 1] == " " || closers.contains(chars[k + 1]))
        }
        if let end = best(atSentenceEnd) {
            // Keep a closing quote with its sentence.
            var j = end
            while j < chars.count, j < limit, closers.contains(chars[j]) { j += 1 }
            return j
        }
        if let cut = best({ clause.contains(chars[$0]) }) { return cut }
        if let cut = best({ chars[$0] == " " }) { return cut }
        // No break at all (one huge word): hard cut, outside a tag if possible.
        var i = min(limit, chars.count)
        while i > 1, inTag[i - 1], chars[i - 1] != "]" { i -= 1 }
        if i <= 1, inTag[0], let close = chars.firstIndex(of: "]") {
            // The piece starts with a tag longer than the limit: keep the tag whole (a slightly long piece).
            return close + 1
        }
        return max(1, i)
    }
}
