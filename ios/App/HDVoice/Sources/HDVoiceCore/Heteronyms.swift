//
//  Heteronyms.swift — words spelled the same but said differently: "she had read it" (red) / "I like to read" (reed),
//  "lead pipes" / "lead the way", "the wind" / "wind the clock", "close to" / "close the door", "they live" /
//  "live music", "a minute" / "minute details" (Kasta, 2026-10-13: "something that tells our voice how to pronounce
//  words that are spelled the same but said differently").
//
//  Kokoro's lexicon has one pronunciation per word (misaki's DEFAULT: "read" is always "reed", "live" always "lyve"),
//  and Nephis's Pocket voice picks the sense from the spelling more than from the sentence. So each sentence is read
//  here first, on the phone, with no model: the table (HeteronymTable.swift: word → variants → ordered rules) is
//  checked against the words around the heteronym, the sentence's tense and, only when a rule gets that far, Apple's
//  part-of-speech tagger (NaturalLanguage NLTagger, .lexicalClass). Microseconds for a sentence without one of the
//  words; the tagger once per sentence that needs it.
//
//  What each voice gets:
//    Kokoro   the words it would say wrong as phoneme runs (SpeechRun.phonemes), the rest of the sentence as text
//             (`kokoroRuns`; KokoroService applies it to every sentence it renders).
//    Pocket   respellings in the text she reads ("reed", "led", "wynd"; `pocketText`). The on-device AI's senses
//             (SceneReader, when Apple Intelligence is on) decide where the rules only guessed.
//
//  The rules are tested on a sentence corpus (tests/fixtures/heteronyms-corpus.json): here by HeteronymsTests (CI,
//  macOS, with the real tagger) and on the PC by tests/heteronyms.test.ts (the same rules, without the tagger).
//

import Foundation
#if canImport(NaturalLanguage)
import NaturalLanguage
#endif

/// Parts of speech for words of a text: lowercased NaturalLanguage lexical classes ("noun", "verb", "adjective",
/// "adverb", "pronoun", "determiner", "preposition", "particle", "number", …), one per range; nil where unknown.
public protocol HeteronymTagging: Sendable {
    func lexicalClasses(of text: String, at words: [Range<String.Index>]) -> [String?]
}

public enum Heteronyms {
    /// One way to say a word.
    public struct Variant: Decodable, Sendable, Equatable {
        /// Kokoro (misaki) phonemes.
        public let kokoro: String
        /// A respelling Nephis's Pocket voice says right; nil = she reads the word as written for this sense.
        public let pocket: String?
    }

    /// What decided a word.
    public enum Decision: String, Sendable {
        /// A rule on the words around it (or the sentence's words).
        case rule
        /// A guess from the sentence's tense or a likely subject.
        case guess
        /// A rule that used the part-of-speech tagger.
        case tag
        /// No rule matched: the word's default.
        case fallback
    }

    /// A heteronym in a text and how to say it.
    public struct Resolution: Equatable, Sendable {
        public let range: Range<String.Index>
        /// The word, lowercased.
        public let word: String
        /// The variant's name in the table ("red", "reed", "noun", "verb", …).
        public let variant: String
        public let kokoro: String
        public let pocket: String?
        public let decidedBy: Decision
        /// Kokoro says something else by itself: this word needs its phonemes.
        public let differsForKokoro: Bool
        /// Decided by a rule on the words around it (not a guess, the tagger or the default).
        public var confident: Bool { decidedBy == .rule }
    }

    /// The built-in table, read once.
    public static let table: Table = {
        do { return try Table(json: tableJSON) } catch { return Table.empty }
    }()

    /// Apple's tagger where the platform has it.
    public static var defaultTagger: (any HeteronymTagging)? {
        #if canImport(NaturalLanguage)
        return LexicalClassTagger.shared
        #else
        return nil
        #endif
    }

    /// The heteronyms of `text` and how to say each, in text order.
    public static func resolve(_ text: String, tagger: (any HeteronymTagging)? = defaultTagger) -> [Resolution] {
        table.resolve(text, tagger: tagger)
    }

    /// `text` for Pocket: heteronyms respelled the way she says the sense right (a capital kept). `overrides` (word →
    /// respelling, "" = as written) are the on-device AI's senses; they win where the rules only guessed.
    public static func pocketText(_ text: String, overrides: [String: String] = [:], tagger: (any HeteronymTagging)? = defaultTagger) -> String {
        let found = resolve(text, tagger: tagger)
        guard !found.isEmpty else { return text }
        var out = ""
        var cursor = text.startIndex
        for r in found {
            let choice: String?
            if !r.confident, let o = overrides[r.word] { choice = o } else { choice = r.pocket }
            guard let said = choice, !said.isEmpty else { continue }
            out += text[cursor..<r.range.lowerBound]
            out += matchCase(String(text[r.range]), said)
            cursor = r.range.upperBound
        }
        out += text[cursor...]
        return out
    }

    /// Kokoro's input for a sentence: `runs` (the pronunciation lexicon's text/phoneme runs, nil = plain `text`) with
    /// the heteronyms Kokoro would say wrong cut out of the text runs as phoneme runs. nil when there are no runs
    /// either way (plain text, as before).
    public static func kokoroRuns(text: String, runs: [SpeechRun]?, tagger: (any HeteronymTagging)? = defaultTagger) -> [SpeechRun]? {
        guard let runs else { return split(text, tagger: tagger) }
        var changed = false
        var out: [SpeechRun] = []
        for run in runs {
            if case .text(let t) = run, let pieces = split(t, tagger: tagger) {
                out += pieces
                changed = true
            } else {
                out.append(run)
            }
        }
        return changed ? out : runs
    }

    /// `text` as text runs around phoneme runs for the heteronyms Kokoro would say wrong; nil when there are none.
    static func split(_ text: String, tagger: (any HeteronymTagging)?) -> [SpeechRun]? {
        let picks = resolve(text, tagger: tagger).filter(\.differsForKokoro)
        guard !picks.isEmpty else { return nil }
        var out: [SpeechRun] = []
        var cursor = text.startIndex
        for r in picks {
            if cursor < r.range.lowerBound { out.append(.text(String(text[cursor..<r.range.lowerBound]))) }
            out.append(.phonemes(r.kokoro))
            cursor = r.range.upperBound
        }
        if cursor < text.endIndex { out.append(.text(String(text[cursor...]))) }
        return out
    }

    /// `said` with the case of `written`: all capitals stay capitals ("READ" → "REED"), a capital first letter stays.
    static func matchCase(_ written: String, _ said: String) -> String {
        if written.count > 1, written == written.uppercased(), written != written.lowercased() { return said.uppercased() }
        if written.first?.isUppercase == true { return said.prefix(1).uppercased() + said.dropFirst() }
        return said
    }
}

// MARK: - The table

extension Heteronyms {
    struct TableError: Error, CustomStringConvertible {
        let description: String
    }

    /// One rule as written in the table.
    struct RuleJSON: Decodable {
        var say: String?
        var use: String?
        var prev, prev2, prevRaw, next, next2, notPrev, notPrev2, notNext, has, hasNot: [String]?
        var tag, prevTag, nextTag: [String]?
        var tense: String?
        var capital, upper, guess: Bool?
    }

    struct EntryJSON: Decodable {
        var variants: [String: Variant]
        var `default`: String
        var kokoroSays: String?
        var kokoroSaysCapital: String?
        var rules: [RuleJSON]
    }

    struct TableJSON: Decodable {
        var version: Int
        var sets: [String: [String]]
        var templates: [String: [RuleJSON]]
        var words: [String: EntryJSON]
    }

    /// A rule with its sets expanded.
    struct Rule: Sendable {
        let say: String
        let prev, prev2, prevRaw, next, next2, notPrev, notPrev2, notNext, has, hasNot: Set<String>?
        let tag, prevTag, nextTag: Set<String>?
        let tense: String?
        let capital, upper, guess: Bool
        var usesTags: Bool { tag != nil || prevTag != nil || nextTag != nil }
    }

    struct Entry: Sendable {
        let variants: [String: Variant]
        let fallback: String
        let kokoroSays: String?
        let kokoroSaysCapital: String?
        let rules: [Rule]
    }

    /// The table, compiled: shared sets expanded, templates spliced, every variant checked.
    public struct Table: Sendable {
        let entries: [String: Entry]
        let pronounS, adverbs, lyWords, pastWords, presentWords, notPast: Set<String>

        static let empty = Table(entries: [:], pronounS: [], adverbs: [], lyWords: [], pastWords: [], presentWords: [], notPast: [])

        init(entries: [String: Entry], pronounS: Set<String>, adverbs: Set<String>, lyWords: Set<String>, pastWords: Set<String>,
             presentWords: Set<String>, notPast: Set<String>) {
            self.entries = entries
            self.pronounS = pronounS
            self.adverbs = adverbs
            self.lyWords = lyWords
            self.pastWords = pastWords
            self.presentWords = presentWords
            self.notPast = notPast
        }

        /// The words the table knows, sorted.
        public var words: [String] { entries.keys.sorted() }

        public init(json: String) throws {
            let raw = try JSONDecoder().decode(TableJSON.self, from: Data(json.utf8))
            func expand(_ list: [String], _ seen: Set<String> = []) throws -> Set<String> {
                var out = Set<String>()
                for item in list {
                    guard item.hasPrefix("@") else { out.insert(item); continue }
                    let name = String(item.dropFirst())
                    guard let members = raw.sets[name] else { throw TableError(description: "unknown set \(item)") }
                    guard !seen.contains(name) else { throw TableError(description: "set \(item) includes itself") }
                    out.formUnion(try expand(members, seen.union([name])))
                }
                return out
            }
            func expandOptional(_ list: [String]?) throws -> Set<String>? { try list.map { try expand($0) } }
            func flatten(_ rules: [RuleJSON], _ depth: Int = 0) throws -> [RuleJSON] {
                guard depth < 4 else { throw TableError(description: "templates nested too deep") }
                return try rules.flatMap { r -> [RuleJSON] in
                    guard let use = r.use else { return [r] }
                    guard let t = raw.templates[use] else { throw TableError(description: "unknown template \(use)") }
                    return try flatten(t, depth + 1)
                }
            }
            var entries: [String: Entry] = [:]
            for (word, e) in raw.words {
                guard e.variants[e.default] != nil else { throw TableError(description: "\(word): default \(e.default) is not a variant") }
                for says in [e.kokoroSays, e.kokoroSaysCapital].compactMap({ $0 }) where e.variants[says] == nil {
                    throw TableError(description: "\(word): kokoroSays \(says) is not a variant")
                }
                let rules = try flatten(e.rules).map { r -> Rule in
                    guard let say = r.say, e.variants[say] != nil else { throw TableError(description: "\(word): rule says \(r.say ?? "nothing")") }
                    return try Rule(say: say, prev: expandOptional(r.prev), prev2: expandOptional(r.prev2), prevRaw: expandOptional(r.prevRaw),
                                    next: expandOptional(r.next), next2: expandOptional(r.next2), notPrev: expandOptional(r.notPrev),
                                    notPrev2: expandOptional(r.notPrev2), notNext: expandOptional(r.notNext), has: expandOptional(r.has),
                                    hasNot: expandOptional(r.hasNot), tag: r.tag.map { Set($0) }, prevTag: r.prevTag.map { Set($0) },
                                    nextTag: r.nextTag.map { Set($0) }, tense: r.tense, capital: r.capital ?? false, upper: r.upper ?? false,
                                    guess: r.guess ?? false)
                }
                entries[word] = Entry(variants: e.variants, fallback: e.default, kokoroSays: e.kokoroSays, kokoroSaysCapital: e.kokoroSaysCapital,
                                      rules: rules)
            }
            let pronounS = try expand(["@pronounS"])
            let adverbs = try expand(["@adverbs"])
            let lyWords = try expand(["@lyWords"])
            let pastWords = try expand(["@pastWords"])
            let presentWords = try expand(["@presentWords"])
            let notPast = try expand(["@notPast"])
            self.init(entries: entries, pronounS: pronounS, adverbs: adverbs, lyWords: lyWords, pastWords: pastWords, presentWords: presentWords,
                      notPast: notPast)
        }
    }
}

// MARK: - Reading a sentence

extension Heteronyms {
    /// A word of the text (letters and digits, with inner apostrophes: "don't", "ship's").
    struct Token {
        let range: Range<String.Index>
        /// Lowercased, curly apostrophes made straight.
        let word: String
        let capitalized: Bool
        /// Punctuation (anything but spaces or a single hyphen) between this word and the one before, or the text's start.
        let breakBefore: Bool
        /// Joined to the word before by a hyphen ("well-read").
        let hyphenBefore: Bool
        /// Which sentence of the text (a . ! ? … in between starts the next).
        let sentence: Int
    }

    static func tokenize(_ text: String) -> [Token] {
        var tokens: [Token] = []
        var gapStart = text.startIndex
        var sentence = 0
        var i = text.startIndex
        let isWordChar: (Character) -> Bool = { $0.isLetter || $0.isNumber }
        while i < text.endIndex {
            guard isWordChar(text[i]) else {
                i = text.index(after: i)
                continue
            }
            let start = i
            var end = text.index(after: i)
            while end < text.endIndex {
                let c = text[end]
                if isWordChar(c) {
                    end = text.index(after: end)
                    continue
                }
                if c == "'" || c == "\u{2019}" {
                    let after = text.index(after: end)
                    if after < text.endIndex, isWordChar(text[after]) {
                        end = text.index(after: after)
                        continue
                    }
                }
                break
            }
            let gap = text[gapStart..<start]
            let first = tokens.isEmpty
            if !first, gap.contains(where: { ".!?…".contains($0) }) { sentence += 1 }
            let word = String(text[start..<end]).lowercased().replacingOccurrences(of: "\u{2019}", with: "'")
            tokens.append(Token(range: start..<end, word: word, capitalized: text[start].isUppercase,
                                breakBefore: first || (gap != "-" && gap.contains { !$0.isWhitespace }),
                                hyphenBefore: !first && gap == "-", sentence: sentence))
            gapStart = end
            i = end
        }
        return tokens
    }
}

extension Heteronyms.Table {
    static let clitics: Set<String> = ["'ve", "'d", "'ll", "'re", "'m"]

    /// `word` is in `set`: itself, its clitic ("i've" → "'ve"; "'s" only after a pronoun: "it's"), or "$possessive"
    /// for a noun's "'s".
    func member(_ word: String, _ set: Set<String>) -> Bool {
        if set.contains(word) { return true }
        if word.hasPrefix("$") { return false }
        if word.hasSuffix("'s") {
            return pronounS.contains(String(word.dropLast(2))) ? set.contains("'s") : set.contains("$possessive")
        }
        if let a = word.lastIndex(of: "'"), a > word.startIndex {
            let clitic = String(word[a...])
            return Self.clitics.contains(clitic) && set.contains(clitic)
        }
        return false
    }

    func isAdverb(_ word: String) -> Bool {
        adverbs.contains(word) || (word.count >= 5 && word.hasSuffix("ly") && !lyWords.contains(word))
    }

    /// The sentence's tense from its other words (past: was, had, -ed, ago…; present: is, do, every, now…); nil = even.
    func tense(of words: [String]) -> String? {
        var past = 0
        var present = 0
        for w in words {
            if member(w, pastWords) || (w.count >= 4 && w.hasSuffix("ed") && !notPast.contains(w)) { past += 1 }
            if member(w, presentWords) { present += 1 }
        }
        return past > present ? "past" : present > past ? "present" : nil
    }

    func resolve(_ text: String, tagger: (any HeteronymTagging)?) -> [Heteronyms.Resolution] {
        let tokens = Heteronyms.tokenize(text)
        guard tokens.contains(where: { entries[$0.word] != nil }) else { return [] }
        var tags: [String?]?
        func tag(_ k: Int) -> String? {
            guard k >= 0, let tagger else { return nil }
            if tags == nil { tags = tagger.lexicalClasses(of: text, at: tokens.map(\.range)) }
            guard let known = tags, k < known.count else { return nil }
            return known[k]
        }
        // The word before `i`, adverbs skipped; -1 = the clause starts there.
        func prevIndex(_ i: Int) -> Int {
            if tokens[i].breakBefore { return -1 }
            var j = i - 1
            while j >= 0, isAdverb(tokens[j].word) {
                if tokens[j].breakBefore { return -1 }
                j -= 1
            }
            return j
        }
        var out: [Heteronyms.Resolution] = []
        for i in tokens.indices {
            guard let entry = entries[tokens[i].word] else { continue }
            // Part of a hyphenated compound ("close-up", "live-action"): the compound's own reading.
            if i + 1 < tokens.count, tokens[i + 1].hyphenBefore { continue }
            let p = prevIndex(i)
            let p2 = p < 0 ? -1 : prevIndex(p)
            let n = i + 1 < tokens.count && !tokens[i + 1].breakBefore ? i + 1 : -1
            let n2 = n < 0 || n + 1 >= tokens.count || tokens[n + 1].breakBefore ? -1 : n + 1
            let prev = p < 0 ? "$start" : tokens[p].word
            let prev2 = p2 < 0 ? "$start" : tokens[p2].word
            let prevRaw = tokens[i].breakBefore ? "$start" : tokens[i - 1].word
            let next = n < 0 ? "$end" : tokens[n].word
            let next2 = n2 < 0 ? "$end" : tokens[n2].word
            let same = tokens.indices.filter { $0 != i && tokens[$0].sentence == tokens[i].sentence }.map { tokens[$0].word }
            var sentenceTense: String?
            var tenseKnown = false
            let capitalized = tokens[i].capitalized
            var say = entry.fallback
            var decided = Heteronyms.Decision.fallback
            for r in entry.rules {
                if let s = r.prev, !member(prev, s) { continue }
                if let s = r.prev2, !member(prev2, s) { continue }
                if let s = r.prevRaw, !member(prevRaw, s) { continue }
                if let s = r.next, !member(next, s) { continue }
                if let s = r.next2, !member(next2, s) { continue }
                if let s = r.notPrev, member(prev, s) { continue }
                if let s = r.notPrev2, member(prev2, s) { continue }
                if let s = r.notNext, member(next, s) { continue }
                if let s = r.has, !same.contains(where: { member($0, s) }) { continue }
                if let s = r.hasNot, same.contains(where: { member($0, s) }) { continue }
                if r.capital, !(capitalized && prev != "$start" && prevRaw != "$start") { continue }
                if r.upper, !capitalized { continue }
                if let t = r.tense {
                    if !tenseKnown {
                        sentenceTense = tense(of: same)
                        tenseKnown = true
                    }
                    guard sentenceTense == t else { continue }
                }
                if let s = r.tag { guard let t = tag(i), s.contains(t) else { continue } }
                if let s = r.prevTag { guard let t = tag(p), s.contains(t) else { continue } }
                if let s = r.nextTag { guard let t = tag(n), s.contains(t) else { continue } }
                say = r.say
                decided = r.usesTags ? .tag : r.guess ? .guess : .rule
                break
            }
            guard let variant = entry.variants[say] else { continue }
            let kokoroSays = capitalized ? (entry.kokoroSaysCapital ?? entry.kokoroSays) : entry.kokoroSays
            out.append(Heteronyms.Resolution(range: tokens[i].range, word: tokens[i].word, variant: say, kokoro: variant.kokoro,
                                             pocket: variant.pocket, decidedBy: decided, differsForKokoro: kokoroSays != say))
        }
        return out
    }
}

// MARK: - Apple's tagger

#if canImport(NaturalLanguage)
/// NLTagger's lexical classes (English), one tagger shared behind a lock (NLTagger isn't thread-safe).
public final class LexicalClassTagger: HeteronymTagging, @unchecked Sendable {
    public static let shared = LexicalClassTagger()
    private let lock = NSLock()
    private let tagger = NLTagger(tagSchemes: [.lexicalClass])

    public func lexicalClasses(of text: String, at words: [Range<String.Index>]) -> [String?] {
        lock.lock()
        defer { lock.unlock() }
        tagger.string = text
        tagger.setLanguage(.english, range: text.startIndex..<text.endIndex)
        return words.map { r in
            let (tag, _) = tagger.tag(at: r.lowerBound, unit: .word, scheme: .lexicalClass)
            return tag?.rawValue.lowercased()
        }
    }
}
#endif
