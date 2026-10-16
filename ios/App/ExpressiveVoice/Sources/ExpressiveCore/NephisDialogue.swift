//
//  NephisDialogue.swift — Nephis reads narration with her narrator pack and quoted dialogue with her dialogue pack
//  (Kasta, 2026-10-15: one model can't do calm narration and expressive dialogue well, so a second model of the same
//  base was fine-tuned on Her's expressive dialogue takes; both must sound like the same woman). The platform-free
//  parts, unit-tested on the Mac (NephisDialogueTests); NephisFlowSynth runs them:
//
//  - NephisVoiceRole: a pack is a narrator pack or a dialogue pack (pack.json "role", a user's assignment overrides:
//    NephisPackLibrary). Without a dialogue pack every call reads exactly as before.
//  - QuoteRouter: a call's text cut into narration and dialogue spans by its quotation marks: straight and curly double
//    quotes, curly single quotes when the chapter quotes speech with them (never an apostrophe), dialogue tags inside a
//    quote pair ("Come here," she whispered, "now." = dialogue / narration / dialogue), a quotation that runs on into
//    the next paragraph, stray quotes (narration, as before), thoughts (narration unless the pack opts in), a lone short
//    interjection inside narration (the narrator reads it: a voice change for one word costs more than it gives).
//  - Laughter and the dialogue comma beat: written laughter picks the pack's laugh clip; a dialogue span cut at its
//    commas and dashes so the mood's clause pause goes between them (Kasta: the dialogue voice runs through commas).
//  - NephisVoiceMix: one call's audio from two finishing chains (narrator, dialogue), each region from its own voice, an
//    equal-power crossfade of a few ms at each switch (they fall in pauses, where both are near silence).
//  - NephisLoudnessMatch: the dialogue voice's level matched to the narrator's (active RMS per call, slowly smoothed).
//

import Foundation

/// Which part of a read a pack speaks (pack.json "role"; a user's assignment in Developer › Voice Packs overrides it).
public enum NephisVoiceRole: String, Sendable, Codable, Equatable, CaseIterable {
    case narrator
    case dialogue

    /// pack.json's "role": "dialogue" makes a dialogue pack; anything else (absent, unknown) a narrator pack.
    public init(packInfo: [String: Any]?) {
        self = (packInfo?["role"] as? String)?.lowercased() == Self.dialogue.rawValue ? .dialogue : .narrator
    }
}

// MARK: - Quote routing

public enum QuoteRouter {
    /// What curly single quotes mean in the chapter (src/core/narration/narrator.ts SingleQuoteStyle): a chapter that
    /// quotes speech with double quotes uses them for thoughts ('Curse it...'), one without double quotes for speech
    /// (British style).
    public enum SingleQuotes: String, Sendable, Equatable, Codable {
        case thought
        case dialogue

        /// The chapter's style from its texts (narrator.ts singleQuoteStyle): any double quotation mark → thoughts.
        public static func of(_ texts: [String]) -> SingleQuotes {
            texts.contains { $0.contains { QuoteRouter.isDoubleMark($0) } } ? .thought : .dialogue
        }
    }

    /// One stretch of a call: narration (read by the narrator pack, as written, quotes and all) or dialogue (read by the
    /// dialogue pack, without its quotation marks).
    public struct Span: Equatable, Sendable {
        public var text: String
        public var dialogue: Bool
        public init(text: String, dialogue: Bool) {
            self.text = text
            self.dialogue = dialogue
        }
    }

    /// A quotation left open at the end of a call, carried into the next call of the same paragraph.
    public struct State: Equatable, Sendable {
        public var open: Family?
        public init(open: Family? = nil) {
            self.open = open
        }
    }

    /// Quotation mark families: double (“ ” " « » 「 」, mixed freely as sloppy texts do) and curly single (‘ ’).
    public enum Family: String, Sendable, Equatable {
        case double
        case single
    }

    /// What the router knows around the call (the app's hints; nil = unknown: a lone line, the Voice Lab).
    public struct Context: Equatable, Sendable {
        /// The chapter's curly single quotes; nil: speech when the call has no double quotes, else thoughts.
        public var singleQuotes: SingleQuotes?
        /// The rest of the paragraph after this call (nil: the call ends its paragraph, or unknown).
        public var restOfParagraph: String?
        /// The next paragraph opens with a quotation mark (a quotation that runs on across a paragraph break reopens
        /// there); nil = unknown.
        public var nextOpensQuote: Bool?
        /// The pack reads thoughts in single quotes as dialogue (chain "thoughts": true).
        public var thoughtsAsDialogue: Bool
        /// Keep a short interjection with written laughter as dialogue (the pack has a laugh clip).
        public var keepLaughter: Bool

        public init(singleQuotes: SingleQuotes? = nil, restOfParagraph: String? = nil, nextOpensQuote: Bool? = nil,
                    thoughtsAsDialogue: Bool = false, keepLaughter: Bool = false) {
            self.singleQuotes = singleQuotes
            self.restOfParagraph = restOfParagraph
            self.nextOpensQuote = nextOpensQuote
            self.thoughtsAsDialogue = thoughtsAsDialogue
            self.keepLaughter = keepLaughter
        }
    }

    /// A lone dialogue span this short inside narration is read by the narrator (words, letters), when the call has at
    /// least `asideNarrationWords` words of narration around it.
    public static let interjectionWords = 2
    public static let interjectionLetters = 14
    public static let asideNarrationWords = 3

    static func isDoubleMark(_ c: Character) -> Bool { "“”\"«»「」„‟".contains(c) }
    static func isDoubleOpener(_ c: Character) -> Bool { "“\"«「„‟".contains(c) }
    static func isDoubleCloser(_ c: Character) -> Bool { "”\"»」".contains(c) }

    /// The text opens with a quotation mark (after spaces): a paragraph that continues the quotation before it.
    public static func opensQuote(_ text: String) -> Bool {
        guard let c = text.first(where: { !$0.isWhitespace }) else { return false }
        return isDoubleOpener(c) || c == "‘"
    }

    /// A curly ‘ that opens a quotation: at a word's start, before text.
    static func opensSingle(_ chars: [Character], _ i: Int) -> Bool {
        guard chars[i] == "‘", i + 1 < chars.count, !chars[i + 1].isWhitespace else { return false }
        return i == 0 || chars[i - 1].isWhitespace || "([{“\"—–-".contains(chars[i - 1])
    }

    /// A curly ’ that closes a quotation: after text, before a space, punctuation or the end; never an apostrophe
    /// inside a word ("don’t") or a plural possessive before a lower-case word ("the boys’ room").
    static func closesSingle(_ chars: [Character], _ i: Int) -> Bool {
        guard chars[i] == "’", i > 0, !chars[i - 1].isWhitespace else { return false }
        guard i + 1 < chars.count else { return true }
        let next = chars[i + 1]
        if next.isLetter || next.isNumber { return false }
        if chars[i - 1] == "s" || chars[i - 1] == "S", next.isWhitespace, i + 2 < chars.count, chars[i + 2].isLowercase { return false }
        return next.isWhitespace || ",.;:!?—–)…”\"".contains(next)
    }

    /// A stretch of the call's characters: `source` (with its quotation marks) and, for dialogue, `inner` (without).
    struct Piece {
        var source: Range<Int>
        var inner: Range<Int>
        var dialogue: Bool
        /// Part of a quotation that runs on from the call before or into the next one (never an aside).
        var carried = false
    }

    /// The call's spans, narration and dialogue in reading order. `state` carries a quotation left open to the next call
    /// of the same paragraph (a fresh read starts with `State()`). A call without dialogue comes back as one narration
    /// span holding the text exactly as given.
    public static func split(_ text: String, state: inout State, context: Context = Context()) -> [Span] {
        let chars = Array(text)
        let hasDouble = chars.contains(where: isDoubleMark)
        let singles: Bool
        switch context.singleQuotes {
        case .dialogue: singles = true
        case .thought: singles = context.thoughtsAsDialogue
        case nil: singles = !hasDouble || context.thoughtsAsDialogue
        }
        var pieces: [Piece] = []
        var open = state.open
        if open == .single, !singles { open = nil }
        let startedOpen = open != nil
        var start = 0
        var openAt = 0
        func add(_ source: Range<Int>, inner: Range<Int>? = nil, dialogue: Bool) {
            guard !source.isEmpty else { return }
            pieces.append(Piece(source: source, inner: inner ?? source, dialogue: dialogue))
        }
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if let family = open {
                let closes = family == .double ? isDoubleCloser(c) : closesSingle(chars, i)
                if closes {
                    add(openAt..<(i + 1), inner: start..<i, dialogue: true)
                    open = nil
                    start = i + 1
                } else if family == .double, c == "“" || c == "«" || c == "「" {
                    // A new opening mark while one is open: the one before was never closed; it ends here.
                    add(openAt..<i, inner: start..<i, dialogue: true)
                    openAt = i
                    start = i + 1
                }
            } else if isDoubleOpener(c) {
                add(start..<i, dialogue: false)
                open = .double
                openAt = i
                start = i + 1
            } else if singles, opensSingle(chars, i) {
                add(start..<i, dialogue: false)
                open = .single
                openAt = i
                start = i + 1
            }
            i += 1
        }
        state.open = nil
        if let family = open {
            // A quotation still open where the call ends: speech when it closes later in the paragraph or runs on into a
            // next paragraph that reopens it; otherwise a stray mark, read as narration (as before).
            let rest = context.restOfParagraph
            let closesLater = rest.map { closes(family, in: $0, singles: singles) } ?? false
            if closesLater || context.nextOpensQuote == true {
                add(openAt..<chars.count, inner: start..<chars.count, dialogue: true)
                if !pieces.isEmpty { pieces[pieces.count - 1].carried = true }
                if rest != nil { state.open = family }
            } else {
                add(openAt..<chars.count, dialogue: false)
            }
        } else {
            add(start..<chars.count, dialogue: false)
        }
        if startedOpen, let first = pieces.indices.first, pieces[first].dialogue { pieces[first].carried = true }
        return spans(chars, pieces: pieces, context: context, whole: text)
    }

    /// The first quotation mark of `family` in `text` closes a quotation (the rest of the paragraph after a call).
    static func closes(_ family: Family, in text: String, singles: Bool) -> Bool {
        let chars = Array(text)
        for i in chars.indices {
            switch family {
            case .double:
                if isDoubleCloser(chars[i]) { return true }
                if chars[i] == "“" { return false }
            case .single:
                if closesSingle(chars, i) { return true }
                if singles, opensSingle(chars, i) { return false }
            }
        }
        return false
    }

    static func letters(_ s: some StringProtocol) -> Int { s.reduce(0) { $0 + ($1.isLetter || $1.isNumber ? 1 : 0) } }
    static func words(_ s: some StringProtocol) -> Int {
        s.split(whereSeparator: \.isWhitespace).filter { letters($0) > 0 }.count
    }

    /// The pieces tidied into spans: dialogue without letters becomes narration, a lone short interjection inside
    /// narration too, neighbouring narration joins into one, empty stretches go.
    static func spans(_ chars: [Character], pieces raw: [Piece], context: Context, whole: String) -> [Span] {
        var pieces = raw.map { p -> Piece in
            var q = p
            if q.dialogue, letters(String(chars[q.inner])) == 0 { q.dialogue = false }
            return q
        }
        let dialogue = pieces.indices.filter { pieces[$0].dialogue }
        if dialogue.count == 1, let k = dialogue.first {
            let said = String(chars[pieces[k].inner])
            let around = pieces.indices.filter { !pieces[$0].dialogue }.reduce(0) { $0 + words(String(chars[pieces[$1].source])) }
            let short = words(said) <= interjectionWords && letters(said) <= interjectionLetters
            if short, !pieces[k].carried, around >= asideNarrationWords, !(context.keepLaughter && laughs(said)) { pieces[k].dialogue = false }
        }
        guard pieces.contains(where: \.dialogue) else { return [Span(text: whole, dialogue: false)] }
        var out: [Span] = []
        var narration: Range<Int>?
        func flush() {
            guard let r = narration else { return }
            narration = nil
            var t = String(chars[r]).trimmingCharacters(in: .whitespacesAndNewlines)
            // Punctuation right after a closing quote ("Hello", she said) belongs to the words before it: "Hello," then
            // ends mid-sentence (a comma's beat), and the narration doesn't start with a comma.
            if let last = out.indices.last {
                while let f = t.first, ",;:.!?".contains(f) {
                    out[last].text.append(f)
                    t = String(t.dropFirst()).trimmingCharacters(in: .whitespaces)
                }
            }
            if letters(t) > 0 { out.append(Span(text: t, dialogue: false)) }
        }
        for p in pieces {
            if p.dialogue {
                flush()
                let t = String(chars[p.inner]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { out.append(Span(text: t, dialogue: true)) }
            } else {
                narration = narration.map { $0.lowerBound..<p.source.upperBound } ?? p.source
            }
        }
        flush()
        return out
    }

    // MARK: - Laughter

    /// Written laughter: "Ha!", "Haha", "Hahaha", "Heh", "Hehe", "Pfft", "Ahaha", "Bwahaha", "Tee-hee" (any case).
    public static func laughs(_ text: String) -> Bool {
        text.range(of: laughPattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static let laughPattern = #"\b(?:(?:bwa|a)?ha(?:ha)+h?|hah+a*|ha(?=[!,.?…])|heh(?:eh)*|hehe+|pf+t+|tee-?hee)\b"#

    // MARK: - The dialogue comma beat

    /// A dialogue span cut after each comma, semicolon and dash that has words on both sides (chain
    /// "dialogueCommaBeat": the mood's `clause` pause goes between the pieces). "1,000", "well-known" and an ellipsis stay
    /// whole; a piece without letters joins the one before.
    public static func commaBeats(_ text: String) -> [String] {
        let chars = Array(text)
        var cuts: [Int] = []
        for i in chars.indices {
            let c = chars[i]
            let next = i + 1 < chars.count ? chars[i + 1] : nil
            let cut: Bool
            switch c {
            case ",", ";": cut = next?.isWhitespace == true
            case "—", "–": cut = next != nil && !(next.map { "—–".contains($0) } ?? false)
            case "-": cut = i > 0 && chars[i - 1] == "-" && next != nil && next != "-"
            default: cut = false
            }
            if cut { cuts.append(i + 1) }
        }
        var out: [String] = []
        var from = 0
        for at in cuts + [chars.count] where at > from {
            let piece = String(chars[from..<at]).trimmingCharacters(in: .whitespaces)
            from = at
            guard !piece.isEmpty else { continue }
            if let last = out.last, letters(piece) == 0 || letters(last) == 0 {
                // Punctuation alone ("—" opening the line, a lone "...") joins its neighbour without a space after a dash.
                let glue = last.last.map { "—–-".contains($0) } == true || piece.first.map { $0.isPunctuation } == true ? "" : " "
                out[out.count - 1] = last + glue + piece
            } else {
                out.append(piece)
            }
        }
        return out.isEmpty ? [text] : out
    }
}

// MARK: - Mixing the two voices

public enum NephisVoiceMix {
    /// A voice change in a call's audio: from sample `at` on, `voice` speaks (0 the narrator, 1 the dialogue pack).
    public struct Switch: Equatable, Sendable {
        public var at: Int
        public var voice: Int
        public init(at: Int, voice: Int) {
            self.at = at
            self.voice = voice
        }
    }

    /// The equal-power crossfade at a switch (seconds): the switch sits in a pause, so this only smooths the tails.
    public static let fadeSeconds = 0.005

    /// The weight of voice 1 at every sample (0…1): `first` from the start, then each switch's voice, the change spread
    /// over `fade` samples centred on it.
    public static func weights(count: Int, first: Int, switches: [Switch], fade: Int) -> [Float] {
        var w = [Float](repeating: first == 1 ? 1 : 0, count: max(0, count))
        guard count > 0 else { return w }
        let sorted = switches.sorted { $0.at < $1.at }
        var voice = first
        for (k, s) in sorted.enumerated() where s.voice != voice {
            let half = max(0, fade / 2)
            let lo = max(0, s.at - half)
            let next = k + 1 < sorted.count ? sorted[k + 1].at : count
            let target: Float = s.voice == 1 ? 1 : 0
            let from: Float = voice == 1 ? 1 : 0
            let span = max(1, min(count, s.at + half) - lo)
            for i in lo..<min(count, next) {
                let t = min(1, Float(i - lo + 1) / Float(span))
                w[i] = from + (target - from) * t
            }
            voice = s.voice
        }
        return w
    }

    /// The last sample voice 1 is heard at, plus the fade (its chain need not run past it); nil when it never speaks.
    public static func lastSample(of voice: Int, count: Int, first: Int, switches: [Switch], fade: Int) -> Int? {
        var current = first
        var end: Int?
        for s in switches.sorted(by: { $0.at < $1.at }) where s.voice != current {
            if current == voice { end = min(count, s.at + fade) }
            current = s.voice
        }
        if current == voice { end = count }
        return end.map { max(0, min(count, $0)) }
    }

    /// `a` (voice 0) and `b` (voice 1) into one by `weights` (voice 1's share), equal power: cos and sin of the share's
    /// quarter turn. `b` may be shorter than `a` (its chain stopped after voice 1's last region and its fade): voice 1's
    /// share is 0 there.
    public static func mix(_ a: [Float], _ b: [Float], weights w: [Float]) -> [Float] {
        var out = a
        for i in out.indices {
            let x = i < w.count ? w[i] : 0
            if x <= 0 { continue }
            let bv = i < b.count ? b[i] : 0
            if x >= 1 { out[i] = bv; continue }
            let angle = Double(x) * Double.pi / 2
            out[i] = Float(Double(a[i]) * cos(angle) + Double(bv) * sin(angle))
        }
        return out
    }
}

/// The dialogue voice brought to the narrator's level (Kasta's hand-off: both must sound like one woman in one room):
/// each call's active level per voice (10 ms frames above `activeDB`, their mean power), slowly smoothed over the read;
/// the dialogue spans get the difference (at most ±`maxDB`) before their finishing. The mood's own level change
/// (chain moods gainDB) still comes on top, so a shout stays louder than narration.
public struct NephisLoudnessMatch: Equatable, Sendable {
    public static let activeDB = -45.0
    public static let maxDB = 6.0
    /// Share of the way a call with `fullSeconds` of active speech moves the smoothed level (less for less speech).
    public static let share = 0.3
    public static let fullSeconds = 3.0
    /// Speech a voice needs before its level counts (seconds, over the read).
    public static let minimumSeconds = 0.5

    public private(set) var levels: [Double?] = [nil, nil]
    public private(set) var seconds: [Double] = [0, 0]

    public init() {}

    /// The active level of `x` (dB) and how much of it is active (seconds); nil when none of it is.
    public static func activeLevel(_ x: ArraySlice<Float>, sampleRate: Int) -> (db: Double, seconds: Double)? {
        let n = max(1, sampleRate / 100)
        var total = 0.0
        var frames = 0
        var i = x.startIndex
        while i + n <= x.endIndex {
            var acc = 0.0
            for k in i..<(i + n) { acc += Double(x[k]) * Double(x[k]) }
            let p = acc / Double(n)
            if 10 * log10(max(p, 1e-12)) > activeDB {
                total += p
                frames += 1
            }
            i += n
        }
        guard frames > 0 else { return nil }
        return (10 * log10(total / Double(frames)), Double(frames) * 0.01)
    }

    /// The active level over several stretches of `x` (a voice's regions in a call), as one: nil when none is active.
    public static func activeLevel(_ x: [Float], ranges: [Range<Int>], sampleRate: Int) -> (db: Double, seconds: Double)? {
        var power = 0.0
        var seconds = 0.0
        for r in ranges {
            let lo = max(0, r.lowerBound), hi = min(x.count, r.upperBound)
            guard lo < hi, let level = activeLevel(x[lo..<hi], sampleRate: sampleRate) else { continue }
            power += pow(10, level.db / 10) * level.seconds
            seconds += level.seconds
        }
        return seconds > 0 ? (10 * log10(power / seconds), seconds) : nil
    }

    /// One call's audio of `voice` (0 narrator, 1 dialogue).
    public mutating func observe(voice: Int, level: (db: Double, seconds: Double)?) {
        guard levels.indices.contains(voice), let level, level.db.isFinite else { return }
        seconds[voice] += level.seconds
        guard let old = levels[voice] else {
            levels[voice] = level.db
            return
        }
        let k = Self.share * min(1, level.seconds / Self.fullSeconds)
        levels[voice] = old + (level.db - old) * k
    }

    /// The gain for the dialogue spans (dB): the narrator's level minus the dialogue's, once both have spoken enough.
    public var dialogueGainDB: Double {
        guard let n = levels[0], let d = levels[1], seconds[0] >= Self.minimumSeconds, seconds[1] >= Self.minimumSeconds else { return 0 }
        return min(Self.maxDB, max(-Self.maxDB, n - d))
    }
}

// MARK: - Where the voices change in a call

extension NephisVoiceMix {
    /// A voice change in a call's latent stream (NephisFlowSynth.prepare): from latent `latent` on, `voice` speaks.
    /// `inPad`: a pause of true silence is spliced in at that latent (NephisFlow.insertSilence): the change goes in its
    /// middle, else exactly at the latent (the middle of the join's quiet latents).
    public struct LatentSwitch: Equatable, Sendable {
        public var latent: Int
        public var voice: Int
        public var inPad: Bool
        public init(latent: Int, voice: Int, inPad: Bool) {
            self.latent = latent
            self.voice = voice
            self.inPad = inPad
        }
    }

    /// The switches as sample positions at `perLatent` samples a latent: before the pauses go in (`pads` empty), or in
    /// the audio with `pads` spliced in (each `Int(seconds · sampleRate)` samples at its latent, as insertSilence does).
    public static func samples(_ switches: [LatentSwitch], perLatent: Int, pads: [(at: Int, seconds: Double)] = [], sampleRate: Int) -> [Switch] {
        switches.map { s in
            var at = s.latent * perLatent
            for pad in pads {
                let n = max(0, Int(pad.seconds * Double(sampleRate)))
                if pad.at < s.latent { at += n } else if pad.at == s.latent, s.inPad { at += n / 2 }
            }
            return Switch(at: at, voice: s.voice)
        }
    }

    /// The call cut into regions of one voice each: (range, voice) in order, empty ones left out.
    public static func regions(count: Int, first: Int, switches: [Switch]) -> [(range: Range<Int>, voice: Int)] {
        var out: [(range: Range<Int>, voice: Int)] = []
        var from = 0
        var voice = first
        for s in switches.sorted(by: { $0.at < $1.at }) where s.voice != voice {
            let at = min(count, max(from, s.at))
            if at > from { out.append((from..<at, voice)) }
            from = at
            voice = s.voice
        }
        if count > from { out.append((from..<count, voice)) }
        return out
    }

    /// `x` with every region of `voice` time-stretched to `tempo` (NephisTempo, pitch kept), and the switches where they
    /// now fall. A tempo that changes nothing returns both as they are.
    public static func stretch(_ x: [Float], first: Int, switches: [Switch], voice: Int, tempo: Double, sampleRate: Int) -> (samples: [Float], switches: [Switch]) {
        guard NephisTempo.changes(tempo) else { return (x, switches) }
        var out: [Float] = []
        out.reserveCapacity(x.count)
        var moved: [Switch] = []
        for (k, r) in regions(count: x.count, first: first, switches: switches).enumerated() {
            if k > 0 { moved.append(Switch(at: out.count, voice: r.voice)) }
            let part = Array(x[r.range])
            out += r.voice == voice ? NephisTempo.stretch(part, tempo: tempo, sampleRate: sampleRate) : part
        }
        return (out, moved)
    }
}

// MARK: - Her dialogue clips

/// Which of the dialogue pack's style clips a dialogue span reads with (its BuiltInVoices/pocket/<name>.pocketvoice).
public enum DialogueClips {
    /// The dialogue pack's own clip names start with this ("nephis-dlg-smug"); its mood clips are "nephis-<mood>" as in
    /// a narrator pack.
    public static let prefix = "nephis-dlg-"
    /// The mood name a pack lists its laugh clip under (chain moods.laugh.clip), and the clip's default file name.
    public static let laugh = "laugh"

    /// The director's mood for the dialogue pack: one of its 12 moods as it is ("calm" for "narrator" / "performed").
    public static func mood(role: String) -> String {
        NephisFlow.herMoods[role] != nil ? role : "calm"
    }

    /// The pack's laugh clip: chain moods.laugh.clip, else "nephis-dlg-laugh", when the pack has the file; nil = none.
    public static func laughClip(chain: NephisFlow.Chain, available: Set<String>) -> String? {
        if let named = chain.moods[laugh]?.clip, available.contains(named) { return named }
        return available.contains(prefix + laugh) ? prefix + laugh : nil
    }

    /// The clip for a dialogue span in `mood`: its laugh clip when the span laughs and the pack has one; else the mood's
    /// `clip` (chain moods[mood].clip), "nephis-dlg-<mood>", "nephis-<mood>", in that order, the first the pack has; nil =
    /// the pack's calm clip (nephis.pocketvoice).
    public static func pick(mood: String, laughing: Bool, chain: NephisFlow.Chain, available: Set<String>) -> String? {
        if laughing, let l = laughClip(chain: chain, available: available) { return l }
        let candidates = [chain.moods[mood]?.clip, prefix + mood, "nephis-\(mood)"].compactMap { $0 }
        return candidates.first(where: available.contains)
    }
}

extension NephisFlow.Chain {
    /// Her pause where dialogue hands over (`kind`) after `piece` in `mood`: the mood's own `dialogue` value as given, else
    /// her pause after the piece (`gap`) but never longer than the chain's `dialogueGaps` value (callPause's rule).
    public func handoverPause(after piece: String, mood: String?, kind: NephisFlow.Handover) -> Double {
        if let own = mood.flatMap({ moods[$0]?.dialogue?[kind.rawValue] }) { return own }
        let pause = gap(after: piece, mood: mood)
        return dialogueGaps[kind.rawValue].map { min(pause, $0) } ?? pause
    }
}
