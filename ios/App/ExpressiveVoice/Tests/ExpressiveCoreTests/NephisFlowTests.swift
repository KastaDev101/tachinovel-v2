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

    func testLeadingNoiseDropsAnUhButNeverAWord() {
        // "uh" (-34 dB) for 3 latents, a dip, then speech at -20 dB.
        var levels = [-60.0, -34, -33, -35, -55, -58] + [Double](repeating: -20, count: 12)
        XCTAssertEqual(NephisFlow.leadingNoise(levels), 5)
        // A real first word as loud as the speech after it ("I … think"): kept.
        levels = [-60.0, -21, -20, -22, -55, -58] + [Double](repeating: -20, count: 12)
        XCTAssertEqual(NephisFlow.leadingNoise(levels), 0)
        // Silence straight into speech: nothing to drop.
        XCTAssertEqual(NephisFlow.leadingNoise([-60, -60, -60] + [Double](repeating: -20, count: 12)), 0)
    }

    func testCleanTailQuietsAMumbleAfterTheLastWordDiedAway() {
        // Word until 9, end of text at 8, rings out to 11, quiet 12-15 (320 ms), a mumble 16-18, quiet again.
        var levels = [Double](repeating: -20, count: 10) + [-30, -45, -55, -58, -57, -59, -38, -36, -40, -57, -60]
        var latents = levels.indices.map { lat(Float($0)) }
        let n = NephisFlow.cleanTail(&latents, levels: &levels, endOfText: 8)
        XCTAssertEqual(n, 3)
        XCTAssertEqual(latents[16], lat(15))
        XCTAssertEqual(latents[18], lat(15))
        XCTAssertEqual(latents[9], lat(9), "the word itself is untouched")
        // Never quiet after the end: nothing is touched.
        var loud = [Double](repeating: -25, count: 12)
        var l2 = loud.indices.map { lat(Float($0)) }
        XCTAssertEqual(NephisFlow.cleanTail(&l2, levels: &loud, endOfText: 4), 0)
    }

    func testLongPausesAreSilenceNotDecodedQuietLatents() {
        let q = [Float](repeating: 0, count: 32)
        // A 1.04 s pause from 2 tail + 2 head silence latents (1 blended): 13 wanted, 3 decoded as a bridge, the rest silence.
        let r = NephisFlow.joinPadded(tail: [q, q], next: [q, q] + [[Float]](repeating: [Float](repeating: 1, count: 32), count: 5), head: 2, pause: 1.04)
        XCTAssertNotNil(r.padAt)
        XCTAssertEqual(r.padSeconds, Double(13 - 3 - 3) * NephisFlow.latentSeconds, accuracy: 1e-9)  // 3 already there, 3 bridge
        XCTAssertEqual(NephisFlow.join(tail: [q, q], next: [q, q], head: 2, pause: 0.2).count, NephisFlow.joinPadded(tail: [q, q], next: [q, q], head: 2, pause: 0.2).latents.count)
        let audio = [Float](repeating: 0.5, count: 4 * NephisFlow.samplesPerLatent)
        let out = NephisFlow.insertSilence(audio, pads: [(at: 2, seconds: 0.5)])
        XCTAssertEqual(out.count, audio.count + NephisFlow.sampleRate / 2)
        XCTAssertEqual(out[2 * NephisFlow.samplesPerLatent + 100], 0)
        XCTAssertEqual(out[0], 0.5)
    }

    func testChainUsesHerPausesPerMoodAndPacksOverrideThem() throws {
        let chain = NephisFlow.Chain()
        XCTAssertEqual(chain.gap(after: "They ran.", mood: "intense"), 0.46)
        XCTAssertEqual(chain.gap(after: "They waited:", mood: "calm"), 0.9)
        XCTAssertEqual(chain.gap(after: "They ran.", mood: "unknown"), chain.pieceGap)
        let pack = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"moods": {"intense": {"sentence": 0.3, "trail": 0.3, "paragraph": 9, "gainDB": 2}}}"#.utf8))
        XCTAssertEqual(pack.moods["intense"]?.sentence, 0.3)
        XCTAssertEqual(pack.moods["intense"]?.paragraph, 3, "clamped")
        XCTAssertEqual(pack.moods["calm"], NephisFlow.herMoods["calm"], "moods the pack leaves out keep hers")
    }

    func testCleanTailKeepsALastSyllableAfterAShortDip() {
        // The end-of-text estimate is early (6) and the last word dips quiet for 2 latents (a stop) before its
        // final syllable at 12-13: that syllable is speech, not a mumble.
        var levels = [Double](repeating: -20, count: 10) + [-55, -56, -24, -26, -50, -57, -58, -59, -60]
        var latents = levels.indices.map { lat(Float($0)) }
        XCTAssertEqual(NephisFlow.cleanTail(&latents, levels: &levels, endOfText: 6), 0)
        XCTAssertEqual(latents[12], lat(12))
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
