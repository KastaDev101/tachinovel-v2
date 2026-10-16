//
//  NephisCallPlanTests.swift — one plan for Listen, the Voice speed test and audio downloads (NephisCallPlan.swift):
//  the speed test's calls are exactly the calls Listen makes for the same sentences (pipeline parity), and they match
//  what the speed test asked for before the plan existed; grouping, the line's fields, the dialogue hints and the budget.
//

@testable import ExpressiveCore
import Foundation
import XCTest

final class NephisCallPlanTests: XCTestCase {
    private typealias S = NephisCallPlan.Sentence
    /// The app's spoken form without HDVoiceCore's heteronyms (identity here; the app passes Heteronyms.pocketText).
    private let spoken: (String, [String: String]) -> String = { t, _ in t }

    /// The calls a whole read makes, each issued with `buffered(k)` seconds ahead (Listen's and the speed test's loop).
    private func plan(_ s: [S], dialogue: Bool = false, buffered: (Int) -> Double = { _ in 30 }) -> [NephisCallPlan.Call] {
        var out: [NephisCallPlan.Call] = []
        var i = 0
        let style = NephisCallPlan.quoteStyle(s.map(\.text))
        while i < s.count {
            let ahead = buffered(out.count)
            let members = NephisCallPlan.group(from: i, count: s.count, limit: NephisCallPlan.limit(first: s[i], buffered: ahead)) { s[$0] }
            let call = NephisCallPlan.call(members: members, count: s.count, at: { s[$0] },
                                           context: .init(reset: out.isEmpty, dialogue: dialogue, singleQuotes: style), spoken: spoken)
            out.append(call)
            i = (members.last ?? i) + 1
        }
        return out
    }

    /// Listen's sentences for the passage, as the app maps its speech segments (NephisRenderPipeline.sentence): the script
    /// gives the director's text, the raw form, a temperature and the read; for plain narration those are the defaults.
    private func listenSentences(_ list: [NephisSpeedTest.Sentence]) -> [S] {
        list.indices.map { i in
            let ends = i == list.count - 1 || list[i + 1].paragraph != list[i].paragraph
            return S(text: list[i].text, say: list[i].text, raw: nil, temperature: 0.7, read: nil,
                     pauseAfter: ends ? NephisSpeedTest.paragraphPause : NephisSpeedTest.sentencePause)
        }
    }

    // MARK: - Pipeline parity

    func testTheSpeedTestMakesExactlyListensCalls() {
        for dialogue in [false, true] {
            let passage = NephisSpeedTest.sentences(NephisSpeedTest.passageFor(dialogue: dialogue))
            // A fast start (little buffered for the first two calls), then plenty.
            let ahead: (Int) -> Double = { $0 < 2 ? 1 : 40 }
            let speed = plan(NephisSpeedTest.planSentences(passage), dialogue: dialogue, buffered: ahead)
            let listen = plan(listenSentences(passage), dialogue: dialogue, buffered: ahead)
            XCTAssertEqual(speed, listen, "dialogue: \(dialogue)")
            XCTAssertFalse(speed.isEmpty)
        }
    }

    func testThePlanAsksWhatTheSpeedTestAskedBefore() {
        // The speed test's own construction before the shared plan (VoiceSpeedTest.issueNext, build 372).
        let passage = NephisSpeedTest.sentences(NephisSpeedTest.passage)
        let calls = plan(NephisSpeedTest.planSentences(passage), buffered: { $0 == 0 ? 0 : 30 })
        var i = 0
        for (k, call) in calls.enumerated() {
            let limit = k == 0 ? passage[i].text.count : ExpressiveEngineID.pocketTts.maxCharactersPerCall
            let range = NephisSpeedTest.group(passage, from: i, limit: limit)
            XCTAssertEqual(call.members, Array(range))
            let text = StyleMapper.plainText(passage[range].map(\.text).joined(separator: " "))
            XCTAssertEqual(call.line.text, text)
            XCTAssertEqual(call.line.raw, text)
            XCTAssertEqual(call.line.role, "narrator")
            XCTAssertEqual(call.line.temperature ?? 0, 0.7, accuracy: 1e-6)
            XCTAssertEqual(call.line.pauseBefore, NephisSpeedTest.pauseBefore(passage, at: i))
            XCTAssertEqual(call.line.flowReset, k == 0)
            XCTAssertEqual(call.line.flowLast, range.upperBound >= passage.count)
            XCTAssertNil(call.line.handover)
            i = range.upperBound
        }
        XCTAssertEqual(i, passage.count)
    }

    func testTheDialoguePassageGetsListensQuoteHints() {
        let passage = NephisSpeedTest.sentences(NephisSpeedTest.passageFor(dialogue: true))
        XCTAssertEqual(NephisCallPlan.quoteStyle(passage.map(\.text)), .thought)
        let calls = plan(NephisSpeedTest.planSentences(passage), dialogue: true)
        for call in calls {
            XCTAssertEqual(call.line.singleQuotes, "thought")
            XCTAssertNotNil(call.line.nextOpensQuote)
        }
        // The last call has nothing after it.
        XCTAssertEqual(calls.last?.line.nextOpensQuote, false)
        XCTAssertNil(calls.last?.line.restOfParagraph)
        // Some call switches voices (the shopkeeper's quote).
        XCTAssertTrue(calls.contains { $0.switches > 0 })
    }

    // MARK: - Grouping

    func testAGroupStaysInItsParagraphAndRead() {
        let s = [S(text: "One.", pauseAfter: 0.4), S(text: "Two.", pauseAfter: 0.9), S(text: "Three.", pauseAfter: 0.4),
                 S(text: "Four.", read: "tense", pauseAfter: 0.4), S(text: "Five.", read: "tense", pauseAfter: 0.4)]
        XCTAssertEqual(NephisCallPlan.group(from: 0, count: 5, limit: 400) { s[$0] }, [0, 1])
        XCTAssertEqual(NephisCallPlan.group(from: 2, count: 5, limit: 400) { s[$0] }, [2])
        XCTAssertEqual(NephisCallPlan.group(from: 3, count: 5, limit: 400) { s[$0] }, [3, 4])
        XCTAssertEqual(NephisCallPlan.group(from: 0, count: 5, limit: 400, canCut: false) { s[$0] }, [0])
        XCTAssertEqual(NephisCallPlan.group(from: 5, count: 5, limit: 400) { s[$0] }, [])
    }

    func testASplitSentenceStaysInOneCallUpToTwiceTheLimit() {
        let long = String(repeating: "a", count: 300)
        let s = [S(text: long + " and", pauseAfter: 0.1), S(text: long + ".", pauseAfter: 0.4), S(text: "Next.", pauseAfter: 0.4)]
        XCTAssertEqual(NephisCallPlan.group(from: 0, count: 3, limit: 400) { s[$0] }, [0, 1])
        XCTAssertTrue(NephisCallPlan.endsMidSentence("and so"))
        XCTAssertFalse(NephisCallPlan.endsMidSentence("He left.\u{201D}"))
    }

    func testNoCallCrossesIntoAnAppendedChapter() {
        let s = [S(text: "End.", pauseAfter: 0.4), S(text: "Start.", pauseAfter: 0.4, chapterStart: true)]
        XCTAssertEqual(NephisCallPlan.group(from: 0, count: 2, limit: 400) { s[$0] }, [0])
        let call = NephisCallPlan.call(members: [1], count: 2, at: { s[$0] }, context: .init(reset: false), spoken: spoken)
        XCTAssertEqual(call.line.chapterStart, true)
        XCTAssertNil(call.line.handover)
    }

    // MARK: - The line

    func testTheLineCarriesListensFields() {
        let s = [S(text: "“Go.”", pauseAfter: 0.5, handoverAfter: "exchange"),
                 S(text: "He went", say: "He went…", raw: "He went...", temperature: 0.5, pauseAfter: 0.3),
                 S(text: "Far away.", temperature: 0.9, pauseAfter: 1.2, senses: ["lead": "led"])]
        var seen: [[String: String]] = []
        let call = NephisCallPlan.call(members: [1, 2], count: 3, at: { s[$0] }, context: .init(reset: false, continuesIntoNext: true),
                                       spoken: { t, senses in seen.append(senses); return t.uppercased() })
        XCTAssertEqual(call.line.text, "HE WENT… FAR AWAY.")
        XCTAssertEqual(call.line.raw, "HE WENT... FAR AWAY.")
        // Letter-weighted: "He went…" (8) at 0.5, "Far away." (9) at 0.9.
        XCTAssertEqual(call.line.temperature ?? 0, Float((8 * 0.5 + 9 * 0.9) / 17), accuracy: 1e-5)
        XCTAssertEqual(call.line.pauseBefore, 0.5)
        XCTAssertEqual(call.line.handover, .reply)
        XCTAssertEqual(call.line.flowReset, false)
        // Another chapter follows: not the read's last call.
        XCTAssertEqual(call.line.flowLast, false)
        XCTAssertTrue(seen.contains(["lead": "led"]))
        let last = NephisCallPlan.call(members: [2], count: 3, at: { s[$0] }, context: .init(reset: true), spoken: spoken)
        XCTAssertEqual(last.line.flowLast, true)
        XCTAssertEqual(last.line.flowReset, true)
        // The pause before is kept in a narrator's range.
        XCTAssertEqual(NephisCallPlan.pauseBefore(S(text: "x", pauseAfter: 3)), 1.4)
        XCTAssertEqual(NephisCallPlan.pauseBefore(S(text: "x", pauseAfter: 0.05)), 0.35)
        XCTAssertNil(NephisCallPlan.call(members: [0], count: 3, at: { s[$0] }, context: .init(reset: true), spoken: spoken).line.pauseBefore)
    }

    func testAReadChangeIsSeen() {
        let s = [S(text: "Calm.", pauseAfter: 0.9), S(text: "Run!", read: "tense", pauseAfter: 0.9)]
        let call = NephisCallPlan.call(members: [1], count: 2, at: { s[$0] }, context: .init(reset: false), spoken: spoken)
        XCTAssertTrue(call.readChange)
        XCTAssertEqual(call.line.role, "tense")
    }

    // MARK: - Budget

    func testTheBudgetIsListens() {
        XCTAssertEqual(NephisCallPlan.budget(buffered: 200, readChange: true, switches: 0, warm: true, lastUrgentX: nil).takes, 1)
        XCTAssertEqual(NephisCallPlan.budget(buffered: 200, readChange: false, switches: 0, warm: false, lastUrgentX: 1.2).leadIn, false)
        XCTAssertEqual(NephisCallPlan.budget(buffered: 200, readChange: false, switches: 0, warm: false, lastUrgentX: 3).takes, 2)
        XCTAssertEqual(NephisCallPlan.budget(buffered: 30, readChange: false, switches: 0, warm: false, lastUrgentX: nil).leadIn, true)
        // Two voice changes count a second less buffered: under the lead-in's 25 s.
        XCTAssertEqual(NephisCallPlan.budget(buffered: 25.5, readChange: false, switches: 2, warm: false, lastUrgentX: nil).leadIn, false)
        XCTAssertEqual(NephisCallPlan.flowBudget(ahead: 40, readChange: true).takes, 2)
        XCTAssertEqual(NephisCallPlan.flowBudget(ahead: 10, readChange: true).takes, 1)
    }

    func testVoiceExtrasOffMeansOnePlainTakeAndNoSpeechCheckAtAnyBuffer() {
        // Developer › Voice extras off (2026-10-16): whatever the budget allowed, one take, no lead-in, no recognition.
        for buffered in [0.0, 10, 30, 60, 200] {
            for readChange in [false, true] {
                let budget = NephisCallPlan.budget(buffered: buffered, readChange: readChange, switches: 0, warm: false, lastUrgentX: nil)
                var line = ExpressiveLine(text: "x")
                line.takes = budget.takes
                line.leadIn = budget.leadIn
                var on = line
                NephisCallPlan.extras(&on, on: true)
                XCTAssertEqual(on, line, "on: the call as its budget made it")
                NephisCallPlan.extras(&line, on: false)
                XCTAssertEqual(line.takes, 1)
                XCTAssertEqual(line.leadIn, false)
                XCTAssertFalse(NephisCallPlan.recognizes(takes: line.takes ?? 1, leadIn: line.leadIn == true, transcriber: true))
            }
        }
        // An audio download (a lead-in, two takes with Best of 2) too.
        var download = ExpressiveLine(text: "x")
        NephisCallPlan.download(&download, bestOfTwo: true)
        NephisCallPlan.extras(&download, on: false)
        XCTAssertEqual(download.takes, 1)
        XCTAssertEqual(download.leadIn, false)
        XCTAssertNil(download.studio, "her studio is not an extra")
        // On: recognition only where it can change something, as before.
        XCTAssertTrue(NephisCallPlan.recognizes(takes: 1, leadIn: true, transcriber: true))
        XCTAssertTrue(NephisCallPlan.recognizes(takes: 2, leadIn: false, transcriber: true))
        XCTAssertFalse(NephisCallPlan.recognizes(takes: 1, leadIn: false, transcriber: true))
        XCTAssertFalse(NephisCallPlan.recognizes(takes: 2, leadIn: true, transcriber: false))
    }

    func testADownloadCallHasNoTimeLimitAndOneTake() {
        var line = ExpressiveLine(text: "x")
        line.studio = false
        NephisCallPlan.download(&line, bestOfTwo: false)
        XCTAssertEqual(line.takes, 1)
        XCTAssertNil(line.studio)
        XCTAssertEqual(line.relaxed, true)
        XCTAssertEqual(line.leadIn, true)
        NephisCallPlan.download(&line, bestOfTwo: true)
        XCTAssertEqual(line.takes, 2)
    }
}
