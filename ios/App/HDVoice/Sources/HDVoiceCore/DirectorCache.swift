//
//  DirectorCache.swift — the AI director's answers, kept across new reads of a chapter (heat batch 1, 2026-10-15).
//
//  A seek, a restart for a voice change or Listen started again from the sentence it stopped at is a new read of the same
//  chapter (NarrationController enqueues from the sentence playing to the chapter's last one), and every new read asked
//  the on-device model again: the chapter's brief (one model call per 60 sentences) and the moods and senses of each
//  window of sentences ahead. Kept here instead:
//    - moods and senses per sentence, keyed by the sentence and the one before it (its context); a read's first
//      sentence, whose sentence before isn't in the read, by its text alone;
//    - the brief by the chapter's end (its last sentences: every read of a chapter ends there) with the number of
//      sentences it was made for, so a later start in the chapter reuses it with the right part numbers.
//  Bounded: past `limit` sentences (or `briefLimit` briefs) it starts over. Main thread (HybridSpeechEngine).
//

import Foundation

public struct DirectorCache: Sendable, Equatable {
    /// Entries kept (moods and senses each; a sentence takes one or two) before the cache starts over.
    public static let limit = 4_000
    /// Chapter briefs kept before they start over.
    public static let briefLimit = 8
    /// Sentences at a chapter's end that name it.
    public static let endSentences = 3

    private var moods: [String: String] = [:]
    private var senses: [String: [String: String]] = [:]
    private var briefs: [String: Brief] = [:]

    struct Brief: Sendable, Equatable {
        let sentences: Int
        let text: String
    }

    public init() {}

    /// A sentence with its context (the sentence before it in the chapter; nil at a read's first sentence: its text
    /// alone).
    static func key(_ text: String, before: String?) -> String {
        before.map { $0 + "\u{1}" + text } ?? "\u{2}" + text
    }

    /// The director's mood for `text` (after `before`), if it read it.
    public func mood(_ text: String, before: String?) -> String? {
        moods[Self.key(text, before: before)] ?? moods[Self.key(text, before: nil)]
    }

    public mutating func store(mood: String, text: String, before: String?) {
        if moods.count >= Self.limit { moods = [:] }
        moods[Self.key(text, before: before)] = mood
        moods[Self.key(text, before: nil)] = mood
    }

    /// How to say the homographs of `text` (word: respelling, "" = as written), if the director was asked.
    public func senses(_ text: String, before: String?) -> [String: String]? {
        senses[Self.key(text, before: before)] ?? senses[Self.key(text, before: nil)]
    }

    public mutating func store(senses answer: [String: String], text: String, before: String?) {
        if senses.count >= Self.limit { senses = [:] }
        senses[Self.key(text, before: before)] = answer
        senses[Self.key(text, before: nil)] = answer
    }

    /// The name of a read's chapter: its last sentences (every read of a chapter runs to its end).
    public static func chapterEnd(_ sentences: [String]) -> String {
        sentences.suffix(endSentences).joined(separator: "\u{1}")
    }

    /// The brief made for a read of the chapter ending with `end`, usable for a read of `sentences` sentences: one made
    /// for at least as many (a read starting there or before). `offset`: sentences between that read's start and this
    /// one's, for the part numbers (SceneReader.briefPart).
    public func brief(end: String, sentences: Int) -> (text: String, offset: Int)? {
        guard let b = briefs[end], b.sentences >= sentences else { return nil }
        return (b.text, b.sentences - sentences)
    }

    public mutating func store(brief: String, end: String, sentences: Int) {
        if let old = briefs[end], old.sentences > sentences { return }  // a brief of more of the chapter stays
        if briefs.count >= Self.briefLimit, briefs[end] == nil { briefs = [:] }
        briefs[end] = Brief(sentences: sentences, text: brief)
    }
}
