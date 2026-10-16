import Foundation
@testable import HDVoiceCore
import XCTest

/// Heteronyms: the table, the sentence corpus (tests/fixtures/heteronyms-corpus.json, shared with
/// tests/heteronyms.test.ts), and what Kokoro and Pocket get.
final class HeteronymsTests: XCTestCase {
    struct Sample: Decodable {
        let word: String
        let say: String
        let text: String
        let nth: Int?
        /// Needs Apple's part-of-speech tagger.
        let tagger: Bool?
    }

    /// The repo's corpus, found from this file (the package sits at ios/App/HDVoice).
    static func corpus() throws -> [Sample] {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        let data = try Data(contentsOf: url.appendingPathComponent("tests/fixtures/heteronyms-corpus.json"))
        return try JSONDecoder().decode([Sample].self, from: data)
    }

    /// Answers from a fixed word → tag list, counting how often it is asked.
    final class StubTagger: HeteronymTagging, @unchecked Sendable {
        let tags: [String: String]
        private(set) var calls = 0
        init(_ tags: [String: String] = [:]) { self.tags = tags }
        func lexicalClasses(of text: String, at words: [Range<String.Index>]) -> [String?] {
            calls += 1
            return words.map { tags[text[$0].lowercased()] }
        }
    }

    func say(_ text: String, _ word: String, nth: Int = 0, tagger: (any HeteronymTagging)? = nil) -> String? {
        let found = Heteronyms.resolve(text, tagger: tagger).filter { $0.word == word }
        return nth < found.count ? found[nth].variant : nil
    }

    func testTheBuiltInTableReads() throws {
        let table = try Heteronyms.Table(json: Heteronyms.tableJSON)
        for w in ["read", "lead", "live", "tear", "wind", "bow", "close", "use", "record", "present", "object", "content", "minute",
                  "wound", "desert", "refuse", "permit", "project", "produce", "row", "bass", "dove", "sow", "polish", "separate",
                  "estimate", "moderate", "invalid", "does"] {
            XCTAssertTrue(table.words.contains(w), w)
        }
        XCTAssertEqual(Heteronyms.table.words, table.words, "the shared table is the built-in one")
    }

    func testABrokenTableIsRejected() {
        let missingVariant = #"{"version":1,"sets":{},"templates":{},"words":{"x":{"default":"a","variants":{"a":{"kokoro":"ˈA"}},"rules":[{"say":"b"}]}}}"#
        XCTAssertThrowsError(try Heteronyms.Table(json: missingVariant))
        let missingSet = #"{"version":1,"sets":{},"templates":{},"words":{"x":{"default":"a","variants":{"a":{"kokoro":"ˈA"}},"rules":[{"say":"a","prev":["@nope"]}]}}}"#
        XCTAssertThrowsError(try Heteronyms.Table(json: missingSet))
    }

    func testTheCorpusByTheRulesAlone() throws {
        let samples = try Self.corpus().filter { $0.tagger != true }
        XCTAssertGreaterThanOrEqual(samples.count, 40)
        let misses = samples.filter { say($0.text, $0.word, nth: $0.nth ?? 0) != $0.say }
            .map { "\($0.word): wanted \($0.say), got \(say($0.text, $0.word, nth: $0.nth ?? 0) ?? "nothing"): \($0.text)" }
        XCTAssertEqual(misses, [])
    }

    #if canImport(NaturalLanguage)
    func testTheCorpusWithApplesTagger() throws {
        let samples = try Self.corpus()
        let tagger = LexicalClassTagger.shared
        let misses = samples.filter { say($0.text, $0.word, nth: $0.nth ?? 0, tagger: tagger) != $0.say }
        for m in misses { print("heteronym miss with NLTagger: \(m.word) wanted \(m.say): \(m.text)") }
        // The tagger only decides what the word rules leave open; it may disagree on a few.
        XCTAssertGreaterThanOrEqual(Double(samples.count - misses.count) / Double(samples.count), 0.95, "\(misses.count) misses")
    }
    #endif

    func testTheTaggerIsOnlyAskedWhenARuleNeedsIt() {
        let tagger = StubTagger()
        XCTAssertEqual(say("She had read the letter.", "read", tagger: tagger), "red")
        XCTAssertEqual(say("Nothing to see here.", "read", tagger: tagger), nil)
        XCTAssertEqual(tagger.calls, 0)
        // "close" after a noun at the clause's end: only the tagger knows ("the portal close" = shut).
        let verb = StubTagger(["close": "verb"])
        XCTAssertEqual(say("She watched the portal close.", "close", tagger: verb), "klohz")
        XCTAssertEqual(verb.calls, 1)
        XCTAssertEqual(Heteronyms.resolve("She watched the portal close.", tagger: verb).first?.decidedBy, .tag)
    }

    func testKokoroGetsPhonemesOnlyWhereItWouldBeWrong() {
        XCTAssertEqual(Heteronyms.kokoroRuns(text: "She had read the letter.", runs: nil, tagger: nil),
                       [.text("She had "), .phonemes("ɹˈɛd"), .text(" the letter.")])
        XCTAssertNil(Heteronyms.kokoroRuns(text: "I like to read.", runs: nil, tagger: nil), "reed is what Kokoro says anyway")
        XCTAssertNil(Heteronyms.kokoroRuns(text: "No heteronyms here.", runs: nil, tagger: nil))
        XCTAssertEqual(Heteronyms.kokoroRuns(text: "They live here.", runs: nil, tagger: nil), [.text("They "), .phonemes("lˈɪv"), .text(" here.")])
        // The pronunciation lexicon's runs keep their phonemes; heteronyms in their text runs are cut out.
        let lexicon: [SpeechRun] = [.phonemes("nˈɛfɪs"), .text(" had read it.")]
        XCTAssertEqual(Heteronyms.kokoroRuns(text: "Nephis had read it.", runs: lexicon, tagger: nil),
                       [.phonemes("nˈɛfɪs"), .text(" had "), .phonemes("ɹˈɛd"), .text(" it.")])
        let untouched: [SpeechRun] = [.phonemes("nˈɛfɪs"), .text(" smiled.")]
        XCTAssertEqual(Heteronyms.kokoroRuns(text: "Nephis smiled.", runs: untouched, tagger: nil), untouched)
        // A capital changes what Kokoro says by itself ("Polish" is the nation in its lexicon).
        XCTAssertEqual(Heteronyms.kokoroRuns(text: "Polish the silver.", runs: nil, tagger: nil), [.phonemes("pˈɑlɪʃ"), .text(" the silver.")])
        XCTAssertNil(Heteronyms.kokoroRuns(text: "He spoke Polish.", runs: nil, tagger: nil))
    }

    func testPocketGetsRespellings() {
        XCTAssertEqual(Heteronyms.pocketText("Lead pipes rusted in the walls.", tagger: nil), "Led pipes rusted in the walls.")
        XCTAssertEqual(Heteronyms.pocketText("I like to read.", tagger: nil), "I like to reed.")
        XCTAssertEqual(Heteronyms.pocketText("She had read it.", tagger: nil), "She had read it.", "red: she says it as written")
        XCTAssertEqual(Heteronyms.pocketText("WIND THE CLOCK!", tagger: nil), "WYND THE CLOCK!")
        XCTAssertEqual(Heteronyms.pocketText("Stay close, then close the door.", tagger: nil), "Stay klohss, then klohz the door.")
    }

    func testTheAIsSenseWinsOnlyWhereTheRulesGuessed() {
        // No rule for a bare "The lead.": the default (leed) is a guess, so the AI's "led" is used.
        XCTAssertEqual(Heteronyms.pocketText("The lead.", overrides: ["lead": "led"], tagger: nil), "The led.")
        // "to read" is grammar: the rule stands.
        XCTAssertEqual(Heteronyms.pocketText("I like to read.", overrides: ["read": ""], tagger: nil), "I like to reed.")
        // "" = as written.
        XCTAssertEqual(Heteronyms.pocketText("They read in silence.", overrides: ["read": "reed"], tagger: nil), "They reed in silence.")
        XCTAssertEqual(Heteronyms.pocketText("The lead.", overrides: ["lead": ""], tagger: nil), "The lead.")
    }

    func testCompoundsContractionsAndCurlyApostrophes() {
        XCTAssertTrue(Heteronyms.resolve("A close-up of the live-action scene.", tagger: nil).isEmpty)
        XCTAssertEqual(say("He was a well-read man.", "read"), "red")
        XCTAssertEqual(say("I\u{2019}ve read it.", "read"), "red")
        XCTAssertEqual(say("She\u{2019}ll read it.", "read"), "reed")
        XCTAssertEqual(say("The ship's bow cut the waves.", "bow"), "bau")
        let found = Heteronyms.resolve("Read it, she said; she read it twice.", tagger: nil).map(\.variant)
        XCTAssertEqual(found, ["reed", "red"])
    }
}
