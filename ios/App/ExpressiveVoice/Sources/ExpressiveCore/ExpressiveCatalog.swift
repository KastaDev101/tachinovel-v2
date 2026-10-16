//
//  ExpressiveCatalog.swift — the expressive engine (Pocket TTS: Nephis's voice) and how a line of a novel
//  (text + emotion + style + speaker role, see src/ui/native/expressive-samples.ts) becomes its input.
//
//  Pocket TTS        plain text, one voice per call (a voice prompt), streaming; the mood is in the voice prompt.
//

import Foundation

public enum ExpressiveEngineID: String, CaseIterable, Sendable, Codable {
    case pocketTts = "pocket-tts"

    public var pinned: PinnedEngineModel? { PinnedModels.model(rawValue) }

    public var title: String { "Pocket TTS" }

    public var blurb: String { "Kyutai, 100M. Natural, streaming, voice cloning; Nephis reads with it." }

    /// Longest text per synthesis call (characters); FluidAudio chunks inside a call as well.
    public var maxCharactersPerCall: Int { 400 }

    public var sampleRate: Int { 24_000 }
}

/// One line to speak, as the Voice Lab sends it.
public struct ExpressiveLine: Sendable, Equatable, Codable {
    public var text: String
    /// neutral, happy, sad, angry, fearful, surprised, disgusted
    public var emotion: String
    /// whisper, dramatic, sarcastic, narration (the samples carry it; Pocket TTS reads the mood from its voice prompt)
    public var style: String?
    /// narrator, male, female; "performed" = the narrator voice performing (dialogue, thoughts; Pocket TTS)
    public var role: String

    public static let performedRole = "performed"
    /// Sampling temperature for engines that take one per call (Pocket TTS); nil = the engine's default.
    public var temperature: Float?
    /// Nephis flow (NephisFlowSynth): the pause before this call's first word (seconds; nil = 0.6), a fresh read
    /// (a new chapter, a seek: nothing carries over), the read's last call (its trailing silence is played too), and
    /// how many takes to try (best one kept; nil = 1), and whether to read the sentence before as a lead-in (costs
    /// about half a take more plus speech recognition: only when playback is far enough ahead; nil = yes).
    public var pauseBefore: Double?
    public var flowReset: Bool?
    public var flowLast: Bool?
    public var takes: Int?
    public var leadIn: Bool?
    /// Nephis flow with her studio (NephisStudio): false = playback is short of audio, skip the studio for this call
    /// (her sound stays 44.1 kHz, just without the polish); nil = use it.
    public var studio: Bool?
    /// Nephis flow, raw text form (a pack whose chain says "text": "raw", NephisFlow.Chain.text): the call's text as
    /// written (the script's `delivery.raw` per sentence, else its text); nil = `text`. Only such a pack reads it.
    public var raw: String?
    /// Nephis flow: dialogue across the pause before this call (the script's, after the sentence before it): the same
    /// speaker goes on, another one replies, or dialogue turns into narration or back; nil = none known (the engine then
    /// reads it from the quotation marks). She takes her own pause there (NephisFlow.Chain.callPause).
    public var handover: NephisFlow.Handover?
    /// Nephis flow: the first call of the next chapter, read on in the same read (HybridSpeechEngine.append): her pause
    /// before it is the chapter break (NephisFlow.chapterPause); nil = none.
    public var chapterStart: Bool?
    /// Nephis flow: render at background priority (heat batch 1: playback has plenty banked, RenderPacer.relaxed), so the
    /// phone runs it on its efficient cores and clocks; nil = user-initiated, as always. The sound is the same.
    public var relaxed: Bool?
    /// Nephis flow with a dialogue pack (NephisDialogue.swift): false = the narrator pack reads the whole call (nil: its
    /// quoted dialogue goes to the dialogue pack). Without a dialogue pack these are never read.
    public var dialogue: Bool?
    /// The chapter's curly single quotes: "thought" (it quotes speech with double quotes) or "dialogue" (British style);
    /// nil = guessed from the call (QuoteRouter.Context).
    public var singleQuotes: String?
    /// The rest of the call's paragraph after it (nil: the call ends its paragraph), and whether the next paragraph opens
    /// with a quotation mark: a quotation left open at the call's end is speech only when one of them carries it on.
    public var restOfParagraph: String?
    public var nextOpensQuote: Bool?

    public init(text: String, emotion: String = "neutral", style: String? = nil, role: String = "narrator") {
        self.text = text
        self.emotion = emotion
        self.style = style
        self.role = role
    }
}

/// Which text Pocket TTS gets (StyleMapper.pocketText). `app`: the app's spoken form, ellipses turned into commas and
/// periods, "Hmm" into "Hm" (every voice, and every Nephis pack that doesn't ask otherwise). `raw`: the text as written,
/// for a Nephis pack whose chain says "text": "raw" (tachinovel-tts-lab Q1, 2026-10-12: read as written, her model lost
/// no last word and kept her timing after "..."; see src/core/narration/raw-text.ts for what the script leaves as is).
public enum PocketTextForm: String, Sendable, Codable, Equatable {
    case app
    case raw
}

public enum StyleMapper {
    /// Sound-event tags a line may carry ([laugh], [sigh], …: the lab's samples, pasted text); Pocket reads none, so
    /// they are removed before it reads.
    public static let soundTags = ["laugh", "chuckle", "sigh", "gasp", "cough", "sniff", "groan", "shush", "clear throat"]

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
    /// `form: .raw` (a Nephis pack that asks for the text as written): `rawPocketText` instead.
    public static func pocketText(_ text: String, form: PocketTextForm = .app) -> String {
        if form == .raw { return rawPocketText(text) }
        let dots = #"(?:\.\s?\.\s?\.|…)"#
        // "Hmm"/"Hmmm" come out erratic, sometimes almost silent (0.09–0.62 s voiced over 4 renders); "Hm" holds a
        // proper hum (0.66–0.81 s in 3 of 4). Measured 2026-10-07.
        var out = spokenNumbers(spokenCodes(joinBrokenWords(text))).replacingOccurrences(of: #"\b([Hh])m{2,}\b"#, with: "$1m", options: .regularExpression)
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

    /// Pocket's text in the raw form (Q1, tachinovel-tts-lab 2026-10-12, c7-1500: read as written she lost 0 of 147
    /// last words and never ran away, against 6 and 3 with the app's text; her pauses after "..." followed hers
    /// better). Kept as written: every ellipsis (as "...", never a comma or a period, a leading one too), "Hmm" and
    /// "Hmmm" (no "Hm"), and capitals: a word in capitals is spelled out only when it is one of the acronyms the app's
    /// text keeps in capitals (`keptCapitals`) or has two letters, which are exactly the capitals `spokenCodes` spells in
    /// the app's form, so "NPC" is still "N P C" and "OPEN IT", "KAI", "DID" stay words. Still done, as a book needs it:
    /// numbers in words, codes ("L0-49"), a word broken by "..." joined ("Damna... tion").
    static func rawPocketText(_ text: String) -> String {
        var out = text.replacingOccurrences(of: "…+", with: "...", options: .regularExpression)
            .replacingOccurrences(of: #"\.{3,}|\.(?: \.){2,}"#, with: "...", options: .regularExpression)
        out = spokenNumbers(spokenCodes(joinBrokenWords(out), acronymsOnly: true))
        out = out.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The capitals the app's text keeps (src/core/narration/delivery.ts ACRONYMS: nanoText lower-cases every other word
    /// of three capitals or more before `spokenCodes` sees it). The raw form keeps capitals as written, so it spells out
    /// only these among words of three or more.
    static let keptCapitals: Set<String> = [
        "HP", "MP", "SP", "XP", "EXP", "NPC", "PVP", "PVE", "RPG", "MMO", "MMORPG", "AI", "OK", "TV", "CEO", "FBI", "CIA", "USA", "UK",
        "EU", "UN", "DNA", "ID", "IQ", "GPS", "CPU", "GPU", "STR", "AGI", "DEX", "INT", "WIS", "VIT", "END", "LUK", "CHA", "DEF",
        "ATK", "SSS", "SS", "RIP", "LOL", "DIY", "ASAP", "NASA", "SWAT", "POV", "UFO", "ATM", "MVP", "AOE", "DPS", "DOT", "II",
        "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII",
    ]

    /// Capitals shouted as words, never spelled out ("NO!", "RUN"), and everyday short words.
    static let shoutedWords: Set<String> = [
        "I", "A", "OK", "NO", "YES", "GO", "NOW", "STOP", "RUN", "HELP", "WHAT", "WHY", "WHO", "HOW", "HEY", "OH", "AH",
        "UH", "UM", "HM", "OW", "OKAY", "DIE", "ME", "YOU", "HIM", "HER", "WE", "US", "NOT", "ALL", "GET", "OUT", "DOWN",
        "BACK", "MOVE", "KILL", "THE", "AND", "IS", "IT", "MY", "BE", "DO", "SO", "UP", "ON", "IN", "OF", "TO", "AT",
        "AN", "OR", "IF", "BY", "HE", "SHE", "THEY", "WAS", "ARE", "CAN", "WILL", "HIS", "ITS", "NEVER", "DONT",
        "WAIT", "LOOK", "COME", "HERE", "THERE", "THIS", "THAT", "GOD", "GODS", "DEAD", "FIRE", "HOLD", "FAST",
    ]

    /// Codes read the way people say them (Kasta, 2026-10-09: "APC" came out "aps", "L0-49" "low forty nine"):
    /// letters stuck to digits come apart ("L0" → "L 0"), a dash between digit groups becomes a space, and a short
    /// all-capitals word that isn't a shouted everyday word is spelled out ("APC" → "A P C"), unless the whole
    /// sentence is in capitals (shouting). The novel's Pronunciations entries still win: they reach this text first.
    /// `acronymsOnly` (the raw form, which keeps shouted capitals as written): a word of three capitals or more is
    /// spelled out only when it is in `keptCapitals`.
    public static func spokenCodes(_ text: String, acronymsOnly: Bool = false) -> String {
        var out = text
        let rules: [(String, String)] = [
            (#"(?<=\b[A-Za-z]{1,4})(?=\d)"#, " "), // "L0" → "L 0"
            (#"(?<=\d)(?=[A-Za-z]{1,4}\b)(?!(?:st|nd|rd|th)\b)"#, " "), // "49B" → "49 B" (not "3rd")
            (#"(?<=\d)\s?[-–]\s?(?=\d)"#, " "), // "0-49" → "0 49"
        ]
        for (pattern, template) in rules {
            out = out.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        let letters = out.filter(\.isLetter)
        guard !letters.isEmpty, Double(letters.filter(\.isUppercase).count) / Double(letters.count) < 0.6,
              let re = try? NSRegularExpression(pattern: #"\b[A-Z]{2,5}\b"#) else { return out }
        let ns = out as NSString
        var spelled = out as NSString
        for m in re.matches(in: out, range: NSRange(location: 0, length: ns.length)).reversed() {
            let word = ns.substring(with: m.range)
            // Shouted words, and sounds in capitals ("HMM", "AAAH", "SHH": a letter doubled) stay words.
            guard !shoutedWords.contains(word), word.range(of: #"(.)\1"#, options: .regularExpression) == nil else { continue }
            if acronymsOnly, word.count > 2, !keptCapitals.contains(word) { continue }
            spelled = spelled.replacingCharacters(in: m.range, with: word.map(String.init).joined(separator: " ")) as NSString
        }
        return spelled as String
    }

    /// Numbers in words: Pocket reads digits badly ("312 steps" came out "three or two steps" on the phone, Voice
    /// test 2026-10-09). Whole numbers (with or without thousands commas) and ordinals ("3rd"), below a billion.
    public static func spokenNumbers(_ text: String) -> String {
        guard let re = try? NSRegularExpression(pattern: #"(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(st|nd|rd|th)?(?!\d|[.,]\d)"#) else { return text }
        let cardinal = NumberFormatter()
        cardinal.locale = Locale(identifier: "en_US"); cardinal.numberStyle = .spellOut
        let ns = text as NSString
        var out = text as NSString
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed() {
            guard let n = Int(ns.substring(with: m.range(at: 1)).replacingOccurrences(of: ",", with: "")), n < 1_000_000_000,
                  var words = cardinal.string(from: NSNumber(value: n))?.replacingOccurrences(of: "-", with: " ") else { continue }
            if m.range(at: 2).location != NSNotFound { words = ordinalWords(words) }
            out = out.replacingCharacters(in: m.range, with: words) as NSString
        }
        return out as String
    }

    /// "twenty three" → "twenty third": the last word made ordinal (Foundation spells cardinals only).
    static func ordinalWords(_ words: String) -> String {
        var parts = words.split(separator: " ").map(String.init)
        guard let last = parts.last else { return words }
        let irregular = ["one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth", "nine": "ninth", "twelve": "twelfth"]
        parts[parts.count - 1] = irregular[last] ?? (last.hasSuffix("y") ? String(last.dropLast()) + "ieth" : last + "th")
        return parts.joined(separator: " ")
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
}
