import HDVoiceCore
import XCTest

final class SceneMoodTests: XCTestCase {
    func testReadsFollowTheModelWithTheScriptsRules() {
        // 0 narration, 1 narration, 2 thought, 3 narration, 4 system, 5 dialogue; 6 not read yet.
        let moods: [Int: String] = [0: "tense", 1: "tense", 2: "intense", 3: "tense", 4: "tense", 5: "playful"]
        let speaks: (Int) -> Bool = { $0 == 2 || $0 == 5 }
        let system: (Int) -> Bool = { $0 == 4 }
        let read = { (i: Int) in SceneMood.read(at: i, moods: moods, speaks: speaks, system: system) }
        XCTAssertEqual(read(0), .some("tense"), "narration with an agreeing neighbour")
        XCTAssertEqual(read(1), .some("tense"))
        XCTAssertEqual(read(2), .some("tense"), "a shouted thought reads tense")
        XCTAssertEqual(read(3), .some(nil), "lone tense narration (dialogue and a system line around it) stays calm")
        XCTAssertEqual(read(4), String??.none, "system messages keep the script's read")
        XCTAssertEqual(read(5), .some("performed"), "playful dialogue is performed")
        XCTAssertEqual(read(6), String??.none, "not read yet: the script decides")
    }

    func testNephisReadsEveryMoodOfHerOwn() {
        // 0 wry narration alone, 1 dread narration, 2 dread narration, 3 awe narration alone, 4 playful dialogue,
        // 5 calm dialogue, 6 dread narration for the Narrator.
        let moods: [Int: String] = [0: "wry", 1: "dread", 2: "dread", 3: "awe", 4: "playful", 5: "calm"]
        let speaks: (Int) -> Bool = { $0 == 4 || $0 == 5 }
        let none: (Int) -> Bool = { _ in false }
        let nephis = { (i: Int) in SceneMood.read(at: i, moods: moods, speaks: speaks, system: none, allMoods: true) }
        XCTAssertEqual(nephis(0), .some("wry"), "a dry aside stands alone (a joke is often one line)")
        XCTAssertEqual(nephis(1), .some("dread"), "her own dread read, with an agreeing neighbour")
        XCTAssertEqual(nephis(3), .some(nil), "other moods in narration still need a neighbour (no flicker)")
        XCTAssertEqual(nephis(4), .some("playful"), "dialogue takes its mood")
        XCTAssertEqual(nephis(5), .some(nil), "calm dialogue stays calm: she has no separate performed voice")
        let narrator = SceneMood.read(at: 1, moods: moods, speaks: speaks, system: none)
        XCTAssertEqual(narrator, .some("tense"), "the Narrator reads dread as tense")
    }
}
