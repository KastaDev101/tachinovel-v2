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
}
