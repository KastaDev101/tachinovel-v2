import HDVoiceCore
import XCTest

/// The AI director's answers kept across new reads of a chapter (DirectorCache.swift, heat batch 1).
final class DirectorCacheTests: XCTestCase {
    func testMoodsAndSensesComeBackForTheSameSentenceInItsContext() {
        var c = DirectorCache()
        XCTAssertNil(c.mood("She stopped breathing.", before: "The door opened."))
        c.store(mood: "tense", text: "She stopped breathing.", before: "The door opened.")
        XCTAssertEqual(c.mood("She stopped breathing.", before: "The door opened."), "tense")
        // A read that starts at this sentence (a seek) doesn't know the one before: its text alone.
        XCTAssertEqual(c.mood("She stopped breathing.", before: nil), "tense")
        // In another context the latest answer for the text stands in.
        XCTAssertEqual(c.mood("She stopped breathing.", before: "Elsewhere."), "tense")
        XCTAssertNil(c.senses("He will read it.", before: nil), "never asked")
        c.store(senses: ["read": "reed"], text: "He will read it.", before: "Then:")
        XCTAssertEqual(c.senses("He will read it.", before: "Then:"), ["read": "reed"])
        c.store(senses: ["read": ""], text: "He read it.", before: nil)
        XCTAssertEqual(c.senses("He read it.", before: "Yesterday."), ["read": ""], "as written: an answer too")
    }

    func testABriefServesLaterStartsInTheSameChapterWithItsPartOffset() {
        var c = DirectorCache()
        let chapter = (0..<130).map { "Sentence \($0)." }
        let end = DirectorCache.chapterEnd(chapter)
        XCTAssertEqual(end, DirectorCache.chapterEnd(Array(chapter[70...])), "a later start ends the same way")
        c.store(brief: "Part 1 of 3: …", end: end, sentences: 130)
        let later = c.brief(end: end, sentences: 60)
        XCTAssertEqual(later?.text, "Part 1 of 3: …")
        XCTAssertEqual(later?.offset, 70, "the new read starts 70 sentences into the brief's")
        XCTAssertNil(c.brief(end: end, sentences: 140), "a read from earlier in the chapter than the brief covers asks again")
        XCTAssertNil(c.brief(end: "another chapter", sentences: 10))
        // A brief of less of the chapter never replaces one of more.
        c.store(brief: "shorter", end: end, sentences: 60)
        XCTAssertEqual(c.brief(end: end, sentences: 60)?.text, "Part 1 of 3: …")
    }

    func testItStaysBounded() {
        var c = DirectorCache()
        for i in 0..<(DirectorCache.limit + 10) { c.store(mood: "calm", text: "S\(i)", before: nil) }
        XCTAssertNil(c.mood("S0", before: nil), "started over past the limit")
        XCTAssertEqual(c.mood("S\(DirectorCache.limit + 9)", before: nil), "calm")
    }
}
