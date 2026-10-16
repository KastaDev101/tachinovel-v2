//
//  NephisCallPlan.swift — one plan for every Nephis flow call (audio downloads part 1, 2026-10-16).
//
//  Listen (HybridSpeechEngine), the Voice speed test and audio downloads (ChapterAudioRenderer) all build their calls
//  here, so a downloaded chapter, the speed test's passage and live Listen ask her engine for exactly the same thing:
//    - which sentences go in one call (`group`: one paragraph at most, one read, up to the per-call limit; a sentence
//      the script split mid-way stays whole);
//    - the call's ExpressiveLine (`line`): the director's shaped text with heteronyms resolved (the caller's `spoken`,
//      HDVoiceCore Heteronyms.pocketText), the text as written for a "raw" pack, the letter-weighted temperature, the
//      pause before it, the dialogue handover across that pause, a fresh read or a continued one, the read's last call,
//      and her dialogue pack's quote-routing hints (with the voice changes the call will make);
//    - what extras a live call may afford (`budget`: takes and the lead-in from the audio buffered ahead).
//  What differs between the callers is only their situation (how much is buffered, the phone's heat), passed in.
//  Platform-free and unit-tested (NephisCallPlanTests: Listen's and the speed test's sentences give identical calls).
//

import Foundation

public enum NephisCallPlan {
    /// One sentence as her calls see it.
    public struct Sentence: Equatable, Sendable {
        /// The script's sentence (Kokoro's text): quote style, mid-sentence splits.
        public var text: String
        /// What she reads: the director's shaped text, else `text`.
        public var say: String
        /// As written, for a pack reading the raw form (the script's `raw`); nil = `text`.
        public var raw: String?
        /// The director's temperature for it (0.7 when none).
        public var temperature: Float
        /// Her read for it (a mood, or nil for the calm narrator): calls never mix two reads.
        public var read: String?
        /// The pause after it (seconds, the script's natural pause; ≥ `paragraphPause` ends a paragraph).
        public var pauseAfter: Double
        /// Dialogue across the pause after it (the script's handover name: "sameSpeaker", "exchange", "switch").
        public var handoverAfter: String?
        /// The first sentence of a chapter appended to the read (Listen's next chapter): calls never cross into it.
        public var chapterStart: Bool
        /// How to say its homographs (the director's senses: word → respelling, "" = as written).
        public var senses: [String: String]

        public init(text: String, say: String? = nil, raw: String? = nil, temperature: Float = 0.7, read: String? = nil, pauseAfter: Double,
                    handoverAfter: String? = nil, chapterStart: Bool = false, senses: [String: String] = [:]) {
            self.text = text
            self.say = say ?? text
            self.raw = raw
            self.temperature = temperature
            self.read = read
            self.pauseAfter = pauseAfter
            self.handoverAfter = handoverAfter
            self.chapterStart = chapterStart
            self.senses = senses
        }
    }

    /// A pause this long or longer ends a paragraph (the script's paragraph and scene pauses).
    public static let paragraphPause = 0.7
    /// Listen sends one sentence per call while less than this much audio (seconds) is buffered ahead: her voice starts
    /// sooner. Then whole paragraphs.
    public static let fastStartBelow = 4.0
    /// Pocket TTS's per-call limit (characters).
    public static let callLimit = 400
    /// Seconds of buffered audio a voice change is counted as costing when a call's extras are budgeted.
    public static let switchCost = 0.5
    /// Audio buffered ahead from which a call reads the sentence before it again as a lead-in.
    public static let leadInAhead = 25.0

    /// The pause before a call: the script's pause after the sentence before it, kept in a narrator's range (a beat
    /// between sentences, a breath between paragraphs, a held moment after "…").
    public static func pauseBefore(_ before: Sentence) -> Double {
        min(1.4, max(0.35, before.pauseAfter))
    }

    /// The script split a very long sentence here (no sentence mark, closing quote or bracket at its end).
    public static func endsMidSentence(_ text: String) -> Bool {
        guard let last = text.trimmingCharacters(in: .whitespacesAndNewlines).last else { return false }
        return !".!?…\"'”’)]】".contains(last)
    }

    /// The per-call character limit for a call starting now: one sentence while little is buffered (Listen's fast start),
    /// else Pocket's limit.
    public static func limit(first: Sentence, buffered: Double) -> Int {
        buffered < fastStartBelow ? first.say.count : callLimit
    }

    /// The sentences of the call starting at `i` (of `count`): `i`, then each next one in the same paragraph with the same
    /// read, while the text stays within `limit` (a sentence the script split mid-way may take it up to twice that, so a
    /// call never ends inside a sentence). Never into an appended chapter. `canCut` false (no natural delivery to cut the
    /// call back into sentences): one sentence per call.
    public static func group(from i: Int, count: Int, limit: Int, canCut: Bool = true, at s: (Int) -> Sentence) -> [Int] {
        guard i >= 0, i < count else { return [] }
        guard canCut else { return [i] }
        var out = [i]
        var prev = s(i)
        var total = prev.say.count
        var j = i + 1
        while j < count {
            let next = s(j)
            guard !next.chapterStart, prev.pauseAfter < paragraphPause, prev.read == next.read else { break }
            let length = next.say.count
            guard total + 1 + length <= limit || (endsMidSentence(prev.text) && total + 1 + length <= 2 * limit) else { break }
            total += 1 + length
            out.append(j)
            prev = next
            j += 1
        }
        return out
    }

    /// Around a call ending at sentence `last`: the rest of its paragraph (nil: the call ends it) and whether the next
    /// paragraph opens with a quotation mark (a quotation running on across the break), for her dialogue pack.
    public static func dialogueHints(after last: Int, count: Int, at s: (Int) -> Sentence) -> (rest: String?, nextOpens: Bool) {
        var rest: [String] = []
        var j = last + 1
        while j < count, !s(j).chapterStart, s(j - 1).pauseAfter < paragraphPause {
            rest.append(s(j).say)
            j += 1
        }
        let next = j < count && !s(j).chapterStart ? QuoteRouter.opensQuote(s(j).say) : false
        return (rest.isEmpty ? nil : rest.joined(separator: " "), next)
    }

    /// The single-quote style of the chapter running from `start` to `end` (worked out once per chapter by the caller).
    public static func quoteStyle(_ texts: [String]) -> QuoteRouter.SingleQuotes {
        QuoteRouter.SingleQuotes.of(texts)
    }

    /// Voice changes inside a call's text with her dialogue pack (QuoteRouter's spans; the narrator reads at its start).
    public static func voiceChanges(_ text: String, context: QuoteRouter.Context) -> Int {
        var state = QuoteRouter.State()
        var changes = 0
        var dialogue = false
        for span in QuoteRouter.split(text, state: &state, context: context) where span.dialogue != dialogue {
            changes += 1
            dialogue = span.dialogue
        }
        return changes
    }

    /// The caller's situation for one call.
    public struct Context: Equatable, Sendable {
        /// The call starts her read afresh (a new read, a seek, after a failure or another user of her engine).
        public var reset: Bool
        /// Another chapter follows the last sentence in the same read: her last call keeps its trailing silence.
        public var continuesIntoNext: Bool
        /// Her dialogue pack is in use (quote routing hints are sent).
        public var dialogue: Bool
        /// The chapter's single-quote style (`quoteStyle`).
        public var singleQuotes: QuoteRouter.SingleQuotes

        public init(reset: Bool, continuesIntoNext: Bool = false, dialogue: Bool = false, singleQuotes: QuoteRouter.SingleQuotes = .thought) {
            self.reset = reset
            self.continuesIntoNext = continuesIntoNext
            self.dialogue = dialogue
            self.singleQuotes = singleQuotes
        }
    }

    /// A planned call: its line (without the budget: takes, lead-in, studio, priority are the caller's), the voice changes
    /// it makes (its budget counts them) and whether its read differs from the sentence before it.
    public struct Call: Equatable, Sendable {
        public var members: [Int]
        public var line: ExpressiveLine
        public var switches: Int
        public var readChange: Bool
    }

    /// The call for `members` (consecutive sentences from `group`, possibly fewer when the caller's window cut it short).
    /// `spoken`: the text she is given for a sentence (heteronyms resolved with its senses; HDVoiceCore
    /// Heteronyms.pocketText in the app; StyleMapper.plainText is applied before it).
    public static func call(members: [Int], count: Int, at s: (Int) -> Sentence, context: Context,
                            spoken: (String, [String: String]) -> String) -> Call {
        guard let i = members.first, let last = members.last else {
            return Call(members: [], line: ExpressiveLine(text: ""), switches: 0, readChange: false)
        }
        let sentences = members.map(s)
        let first = sentences[0]
        let text = sentences.map { spoken(StyleMapper.plainText($0.say), $0.senses) }.joined(separator: " ")
        var line = ExpressiveLine(text: text, role: first.read ?? "narrator")
        // One temperature per call: the letter-weighted mean of the director's.
        let weights = sentences.map { Float(max(1, $0.say.count)) }
        line.temperature = zip(sentences.map(\.temperature), weights).reduce(0) { $0 + $1.0 * $1.1 } / max(1, weights.reduce(0, +))
        line.raw = sentences.map { spoken(StyleMapper.plainText($0.raw ?? $0.text), $0.senses) }.joined(separator: " ")
        let before: Sentence? = i > 0 ? s(i - 1) : nil
        line.pauseBefore = before.map { Self.pauseBefore($0) }
        // Dialogue across that pause: she takes her own pause there. An appended chapter's first call gets the chapter
        // break instead.
        line.handover = !first.chapterStart ? before?.handoverAfter.flatMap(NephisFlow.Handover.init(script:)) : nil
        if first.chapterStart { line.chapterStart = true }
        line.flowReset = context.reset
        line.flowLast = last == count - 1 && !context.continuesIntoNext
        var switches = 0
        if context.dialogue {
            let hints = dialogueHints(after: last, count: count, at: s)
            line.singleQuotes = context.singleQuotes.rawValue
            line.restOfParagraph = hints.rest
            line.nextOpensQuote = hints.nextOpens
            switches = voiceChanges(text, context: QuoteRouter.Context(singleQuotes: context.singleQuotes, restOfParagraph: hints.rest,
                                                                      nextOpensQuote: hints.nextOpens))
        }
        let readChange = before.map { $0.read != first.read } ?? false
        return Call(members: members, line: line, switches: switches, readChange: readChange)
    }

    /// What a live call may cost, from the audio buffered ahead of playback: the lightest call on a warm phone (fair heat
    /// or more) or after a call under 1.5× real time (`lastUrgentX`: the last call rendered at user-initiated priority);
    /// otherwise `flowBudget` with each voice change counted as `switchCost` seconds less buffered.
    public static func budget(buffered: Double, readChange: Bool, switches: Int, warm: Bool, lastUrgentX: Double?) -> (takes: Int, leadIn: Bool) {
        if warm { return (1, false) }
        if let x = lastUrgentX, x < 1.5 { return (1, false) }
        return flowBudget(ahead: buffered - switchCost * Double(switches), readChange: readChange)
    }

    /// One plain take when little is buffered, a lead-in from `leadInAhead`, a second take only once more than two and a
    /// half minutes are banked, and one more at a change of read (where jumps happen). At most 2 takes.
    public static func flowBudget(ahead: Double, readChange: Bool) -> (takes: Int, leadIn: Bool) {
        let base = ahead > 150 ? 2 : 1
        return (min(2, base + (readChange && ahead > 35 ? 1 : 0)), ahead >= leadInAhead)
    }

    /// An audio download's call (rendered ahead, never played as it renders): her studio with no time limit (`studio`
    /// nil: it never gives up for pace), one take (two with Developer › "Best of 2 Takes"), the lead-in Listen's calls
    /// get once it is going, background priority (the same sound, less heat).
    public static func download(_ line: inout ExpressiveLine, bestOfTwo: Bool) {
        line.takes = bestOfTwo ? 2 : 1
        line.leadIn = true
        line.studio = nil
        line.relaxed = true
    }
}

extension NephisSpeedTest {
    /// The passage's sentences as her calls see them: calm narration, a paragraph's pause after a paragraph's last
    /// sentence and a sentence's pause inside one (the pauses `pauseBefore` gives). Its calls go through NephisCallPlan
    /// exactly like Listen's.
    public static func planSentences(_ list: [Sentence]) -> [NephisCallPlan.Sentence] {
        list.indices.map { i in
            let last = i == list.count - 1 || list[i + 1].paragraph != list[i].paragraph
            return NephisCallPlan.Sentence(text: list[i].text, pauseAfter: last ? paragraphPause : sentencePause)
        }
    }
}
