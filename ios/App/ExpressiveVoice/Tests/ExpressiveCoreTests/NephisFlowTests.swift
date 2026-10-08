import ExpressiveCore
import XCTest

final class NephisFlowTests: XCTestCase {
    private func lat(_ v: Float) -> [Float] { [Float](repeating: v, count: NephisFlow.latentDim) }

    func testJoinTrimsTheSilenceToThePauseAndBlendsWhereTheyMeet() {
        let tail = (0..<12).map { _ in lat(1) }                       // 0.96 s of silence after the last word
        let next = (0..<8).map { _ in lat(5) } + (0..<10).map { _ in lat(9) }   // 0.64 s of silence, then a word
        let out = NephisFlow.join(tail: tail, next: next, head: 8, pause: 0.85)
        // 0.85 s of pause = 11 latents between the last word and the next word.
        XCTAssertEqual(out.count - 10, 11)
        XCTAssertEqual(Array(out.suffix(10)), (0..<10).map { _ in lat(9) }, "the next word is untouched")
        // The blend: values strictly between the two silences, rising — no jump from 1 straight to 5.
        let firsts = out.prefix(11).map { $0[0] }
        XCTAssertTrue(firsts.contains { $0 > 1 && $0 < 5 })
        XCTAssertEqual(firsts, firsts.sorted())
    }

    func testALongerPauseMorphsInsteadOfRepeating() {
        let tail = (0..<3).map { _ in lat(0) }
        let next = (0..<3).map { _ in lat(6) } + [lat(9)]
        let out = NephisFlow.join(tail: tail, next: next, head: 3, pause: 1.2)
        XCTAssertEqual(out.count - 1, 15, "1.2 s = 15 latents of pause")
        let pause = out.prefix(15).map { $0[0] }
        XCTAssertEqual(Set(pause).count, pause.count, "no latent repeated")
        XCTAssertEqual(pause, pause.sorted())
    }

    func testLeadInCutWaitsForRealSilence() {
        // "…the dark water." then "Sunny lingered…": recognition says "water" ends at 1.0 s, but the word's sound
        // goes on to 1.2 s; silence 1.2–1.6 s; "Sunny" at 1.6 s.
        let words = [NephisFlow.Word(start: 0, end: 0.2, text: " the"), NephisFlow.Word(start: 0.2, end: 0.5, text: " cold"),
                     NephisFlow.Word(start: 0.5, end: 0.7, text: " dark"), NephisFlow.Word(start: 0.7, end: 1.0, text: " water."),
                     NephisFlow.Word(start: 1.6, end: 2.0, text: " Sunny")]
        var levels = [Double](repeating: -20, count: 30)
        for k in 15..<20 { levels[k] = -60 }
        let cut = NephisFlow.leadInCut(words: words, lead: "the cold dark water.", piece: "Sunny lingered only", levels: levels)
        XCTAssertEqual(cut, 15)
        XCTAssertNil(NephisFlow.leadInCut(words: words, lead: "the cold dark water.", piece: "Then the cloth", levels: levels), "wrong next word: unusable")
        var noGap = levels
        for k in 15..<20 { noGap[k] = -20 }
        XCTAssertNil(NephisFlow.leadInCut(words: words, lead: "the cold dark water.", piece: "Sunny lingered", levels: noGap), "no silence: unusable")
    }

    func testWordMatchCatchesASlur() {
        let said = "He could see the vague contours of a human body desiccated in shortened stature"
            .split(separator: " ").enumerated().map { NephisFlow.Word(start: Double($0.offset), end: Double($0.offset) + 0.5, text: String($0.element)) }
        let m = NephisFlow.wordMatch(said, text: "He could see the vague contours of a human body, desiccated and short in stature.")
        XCTAssertLessThan(m, 0.98)
        let exact = "It was feminine and small".split(separator: " ").enumerated().map { NephisFlow.Word(start: Double($0.offset), end: 0, text: String($0.element)) }
        XCTAssertEqual(NephisFlow.wordMatch(exact, text: "It was feminine and small."), 1, accuracy: 1e-9)
    }

    func testOpeningDropStopsAtTheDipBeforeTheFirstWord() {
        let levels: [Double] = [-34, -33, -36, -40, -59, -64, -50, -25, -15, -14]
        XCTAssertEqual(NephisFlow.openingDrop(levels), 5)
        XCTAssertEqual(NephisFlow.openingDrop([-15, -14, -13]), 0, "a read that starts with the word keeps everything")
    }

    func testALoneClickInAPauseIsSmoothedAway() {
        var latents = (0..<9).map { lat(Float($0)) }
        var levels: [Double] = [-60, -62, -61, -42, -60, -61, -63, -60, -61]
        XCTAssertEqual(NephisFlow.cleanClicks(&latents, levels: &levels, from: 0, to: 9), 1)
        XCTAssertEqual(latents[3][0], (2 + 4) / 2, accuracy: 1e-6)
    }

    func testProjectionMatchesTheFormula() {
        var floats = [Float](repeating: 0, count: NephisFlow.embeddingDim * NephisFlow.latentDim + 2 * NephisFlow.latentDim)
        floats[0] = 2                                            // weights[0][0]
        for j in 0..<NephisFlow.latentDim { floats[NephisFlow.embeddingDim * NephisFlow.latentDim + j] = 3 }      // std
        for j in 0..<NephisFlow.latentDim { floats[NephisFlow.embeddingDim * NephisFlow.latentDim + NephisFlow.latentDim + j] = 1 } // mean
        let data = floats.withUnsafeBufferPointer { Data(buffer: $0) }
        let p = NephisFlow.Projection(data: data)
        XCTAssertNotNil(p)
        let c = p?.condition([lat(0.5)]) ?? []
        XCTAssertEqual(c.count, NephisFlow.embeddingDim)
        XCTAssertEqual(c[0], 2 * (0.5 * 3 + 1), accuracy: 1e-5)
        XCTAssertNil(NephisFlow.Projection(data: Data(count: 12)))
    }

    func testThePromptFitsFluidAudiosLimit() {
        let clip = [Float](repeating: 1, count: 94 * NephisFlow.embeddingDim)
        let carry = [Float](repeating: 2, count: 80 * NephisFlow.embeddingDim)
        let p = NephisFlow.prompt(clip: clip, previousClip: nil, carry: carry)
        XCTAssertEqual(p.count, 125)
        XCTAssertEqual(p.frames.first, 1)
        XCTAssertEqual(p.frames.last, 2)
        let blended = NephisFlow.prompt(clip: clip, previousClip: [Float](repeating: 3, count: 63 * NephisFlow.embeddingDim), carry: [])
        XCTAssertEqual(blended.count, NephisFlow.clipFrames)
        XCTAssertEqual(blended.frames.first, 3, "a mood change starts with the previous mood's clip")
    }
}
