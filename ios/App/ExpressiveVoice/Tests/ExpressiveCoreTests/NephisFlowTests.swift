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

    func testLongPauseDecodesOnlyHerFadeOutAndLeadIn() {
        let q = [Float](repeating: 0, count: 32), w = [Float](repeating: 1, count: 32)
        // 6 silence latents after the last word, 4 before the next word: at 1.04 s (13 latents) only 3 + 2 are
        // decoded and 8 latents (0.64 s) are silence spliced in after the fade-out.
        let r = NephisFlow.joinPadded(tail: [[Float]](repeating: q, count: 6), next: [[Float]](repeating: q, count: 4) + [w, w], head: 4, pause: 1.04)
        XCTAssertEqual(r.padAt, 3)
        XCTAssertEqual(r.padSeconds, 8 * NephisFlow.latentSeconds, accuracy: 1e-9)
        XCTAssertEqual(r.latents.count, 3 + 2 + 2)
        XCTAssertEqual(r.latents.last, w, "the next word itself is untouched")
    }

    func testALongTrailingWordKeepsItsWholeFadeOut() {
        // Her fade-out is still audible for 6 latents (-40 .. -66), then quiet: all 7 are decoded, not just 3.
        XCTAssertEqual(NephisFlow.fadeOut([-40, -48, -55, -60, -63, -66, -75, -80, -85, -85]), 7)
        XCTAssertEqual(NephisFlow.fadeOut([-80, -85, -85]), NephisFlow.keepTail, "never under the minimum")
        XCTAssertEqual(NephisFlow.fadeOut([Double](repeating: -40, count: 20)), NephisFlow.maxTail, "never over the maximum")
        // A breath-in 3 latents before the word: those 3 and the quiet one before them.
        XCTAssertEqual(NephisFlow.leadIn([-85, -85, -85, -85, -60, -55, -50]), 4)
        let q = [Float](repeating: 0, count: 32)
        let r = NephisFlow.joinPadded(tail: [[Float]](repeating: q, count: 10), next: [[Float]](repeating: q, count: 4) + [q], head: 4, pause: 1.04,
                                      tailLevels: [-40, -48, -55, -60, -63, -66, -75, -80, -85, -85], headLevels: [-85, -85, -85, -85])
        XCTAssertEqual(r.padAt, 7)
        XCTAssertEqual(r.padSeconds, Double(13 - 7 - 2) * NephisFlow.latentSeconds, accuracy: 1e-9)
    }

    func testAFadeOutDecodedWithItsCallIsLeftOutOfTheNextJoin() {
        let q = [Float](repeating: 0, count: 32), w = [Float](repeating: 1, count: 32)
        let tail = (0..<10).map { lat(Float($0)) }
        let tailLevels: [Double] = [-40, -48, -55, -60, -63, -66, -75, -80, -85, -85]   // fade-out: 7 latents
        let next = [[Float]](repeating: q, count: 4) + [w, w]
        let headLevels: [Double] = [-85, -85, -85, -85]
        // A long pause: her 7 fade-out latents went out with the call before; the same stream follows, the pad first.
        let long = NephisFlow.joinPadded(tail: tail, next: next, head: 4, pause: 1.04, tailLevels: tailLevels, headLevels: headLevels)
        let longAfter = NephisFlow.joinPadded(tail: tail, next: next, head: 4, pause: 1.04, tailLevels: tailLevels, headLevels: headLevels, decoded: 7)
        XCTAssertEqual(longAfter.latents, Array(long.latents.dropFirst(7)))
        XCTAssertEqual(longAfter.padAt, 0)
        XCTAssertEqual(longAfter.padSeconds, long.padSeconds, accuracy: 1e-9)
        // Shorter pauses: the same join minus what was decoded (trims and blends never reach it).
        for pause in [0.4, 0.5] {
            let plain = NephisFlow.joinPadded(tail: tail, next: next, head: 4, pause: pause)
            let after = NephisFlow.joinPadded(tail: tail, next: next, head: 4, pause: pause, decoded: 2)
            XCTAssertEqual(after.latents, Array(plain.latents.dropFirst(2)), "pause \(pause)")
            XCTAssertEqual(after.padAt, plain.padAt.map { $0 - 2 }, "pause \(pause)")
        }
        // The whole tail already decoded and a short pause: nothing of it again, no blend into it; the pause takes the
        // rest from the silence before the next word.
        let all = NephisFlow.joinPadded(tail: Array(tail.prefix(4)), next: next, head: 4, pause: 0.4, decoded: 4)
        XCTAssertEqual(all.latents, [q, q, w, w])
        XCTAssertNil(all.padAt)
        // Default: nothing decoded before, exactly as without the parameter.
        XCTAssertEqual(NephisFlow.joinPadded(tail: tail, next: next, head: 4, pause: 0.4, decoded: 0).latents,
                       NephisFlow.joinPadded(tail: tail, next: next, head: 4, pause: 0.4).latents)
    }

    func testRespellingsAreWholeWordsKeepCapitalsAndPacksOverrideThem() throws {
        let chain = NephisFlow.Chain()
        XCTAssertEqual(chain.respelled("Bed. She bought a bag, then a bedroom."), "Bedd. She bawt a bagg, then a bedroom.")
        let pack = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"respell": {"Bag": "", "glance": "glanss"}}"#.utf8))
        XCTAssertEqual(pack.respelled("A bag and a glance in bed."), "A bag and a glanss in bedd.")
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
        XCTAssertNil(pack.highShelfDB, "no lift given: the shipped EQ")
        XCTAssertNil(pack.softSibilance)
        XCTAssertEqual(try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"softSibilance": false}"#.utf8)).softSibilance, false)
        let toned = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"moods": {"tender": {"sentence": 0.7, "trail": 0.5, "paragraph": 0.8, "gainDB": 0, "toneDB": -9}}}"#.utf8))
        XCTAssertEqual(toned.moods["tender"]?.toneDB, -4, "clamped")
        // A shelf lifts a 6 kHz tone and leaves 200 Hz alone.
        func level(_ hz: Double, _ db: Double) -> Float {
            var x = (0..<4800).map { Float(sin(2 * Double.pi * hz * Double($0) / 24000)) }
            NephisFlow.highShelf(&x, db: db)
            return x[2400...].map { abs($0) }.max() ?? 0
        }
        XCTAssertGreaterThan(level(6000, 3), 1.3)
        XCTAssertEqual(level(200, 3), 1, accuracy: 0.05)
        XCTAssertEqual(try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"highShelfDB": 4}"#.utf8)).highShelfDB, 4)
    }

    // MARK: - The pause before a call (Q6: inside a paragraph; #9: dialogue at her own pace)

    func testAMoodChangeInsideAParagraphGetsHerSentencePauseNotAParagraphs() {
        let chain = NephisFlow.Chain()
        // Narration read calm, then the same paragraph goes on tense (the script's 0.52 s there): her calm pause after
        // a sentence, not the 1.04 s after a paragraph.
        XCTAssertEqual(chain.callPause(pauseBefore: 0.52, after: "The hall went quiet.", mood: "calm", next: "Something moved."), 0.84)
        // Back from tense: her tense pause after a sentence.
        XCTAssertEqual(chain.callPause(pauseBefore: 0.52, after: "Something moved.", mood: "tense", next: "It was only the wind."), 0.58)
    }

    func testACallSplitAtTheLengthLimitGetsHerSentencePause() {
        let chain = NephisFlow.Chain()
        XCTAssertEqual(chain.callPause(pauseBefore: 0.48, after: "He kept talking about the old days.", mood: "wry", next: "Nobody listened."), 0.58)
    }

    func testTheFirstSentenceAloneAtAFastStartGetsHerSentencePause() {
        let chain = NephisFlow.Chain()
        // Listen with nothing buffered sends the first sentence alone; the rest of its paragraph follows inside it.
        XCTAssertEqual(chain.callPause(pauseBefore: 0.35, after: "The rain had stopped.", mood: "calm", next: "We walked on."), 0.84)
    }

    func testACallInsideAParagraphAfterATrailingOffGetsHerTrailPause() {
        let chain = NephisFlow.Chain()
        XCTAssertEqual(chain.callPause(pauseBefore: 0.62, after: "I waited...", mood: "calm", next: "Nobody came."), 0.9)
    }

    func testParagraphsSceneBreaksAndVoiceLabLinesKeepTheirPause() {
        let chain = NephisFlow.Chain()
        XCTAssertEqual(chain.callPause(pauseBefore: 0.92, after: "The hall went quiet.", mood: "calm", next: "Morning came."), 1.04, "a paragraph")
        XCTAssertEqual(chain.callPause(pauseBefore: 0.92, after: "They ran.", mood: "intense", next: "Morning came."), 0.54)
        XCTAssertEqual(chain.callPause(pauseBefore: 1.4, after: "The hall went quiet.", mood: "calm", next: "Morning came."), 1.4, "a scene break")
        XCTAssertEqual(chain.callPause(pauseBefore: 1.4, after: "“Go.”", mood: "calm", next: "“Now.”", handover: .reply), 1.4,
                       "a scene break even in dialogue")
        XCTAssertEqual(chain.callPause(pauseBefore: nil, after: "The hall went quiet.", mood: "calm", next: "Morning came."), 1.04,
                       "no pause from the app (the Voice Lab): as before")
        XCTAssertEqual(chain.callPause(pauseBefore: 0.5, after: nil, mood: nil, next: "Morning came."), 0.5, "a read's first call: as before")
        XCTAssertEqual(chain.callPause(pauseBefore: 0.92, after: "The hall went quiet.", mood: "unknown", next: "Morning came."), 0.92)
    }

    func testDialogueTakesHerOwnPauseFromTheScript() {
        let chain = NephisFlow.Chain()
        // A reply in a new quote paragraph (the script's exchange, ~0.58 s): 0.66, not 1.04 (before) or 0.84 (Q6 alone).
        XCTAssertEqual(chain.callPause(pauseBefore: 0.58, after: "“Are you coming?”", mood: "calm", next: "“Not yet.”", handover: .reply), 0.66)
        // Prepared for the drive with a longer pause there: still hers.
        XCTAssertEqual(chain.callPause(pauseBefore: 0.92, after: "“Are you coming?”", mood: "calm", next: "“Not yet.”", handover: .reply), 0.66)
        XCTAssertEqual(chain.callPause(pauseBefore: 0.45, after: "“Wait for me.", mood: "calm", next: "Please.”", handover: .sameSpeaker), 0.50)
        XCTAssertEqual(chain.callPause(pauseBefore: 0.65, after: "He sighed.", mood: "calm", next: "“Fine.”", handover: .narration), 0.66)
        // Never longer than her pause otherwise: intense stays quicker.
        XCTAssertEqual(chain.callPause(pauseBefore: 0.5, after: "“Run!”", mood: "intense", next: "“Now!”", handover: .reply), 0.46)
        // The script's handover wins over the quotation marks (these look like a reply).
        XCTAssertEqual(chain.callPause(pauseBefore: 0.92, after: "“Are you coming?”", mood: "calm", next: "“Not yet.”", handover: .sameSpeaker), 0.50)
        // Narration on both sides: no handover, her sentence pause.
        XCTAssertEqual(chain.callPause(pauseBefore: 0.5, after: "He sighed.", mood: "calm", next: "She left."), 0.84)
        XCTAssertEqual(NephisFlow.Handover(script: "exchange"), .reply)
        XCTAssertEqual(NephisFlow.Handover(script: "sameSpeaker"), .sameSpeaker)
        XCTAssertEqual(NephisFlow.Handover(script: "switch"), .narration)
        XCTAssertNil(NephisFlow.Handover(script: "paragraph"))
    }

    func testWithoutTheScriptTheQuotationMarksTellTheHandover() {
        XCTAssertEqual(NephisFlow.handover(after: "“Are you coming?”", before: "“Not yet.”"), .reply)
        XCTAssertEqual(NephisFlow.handover(after: "\"Are you coming?\"", before: "\"Not yet.\""), .reply)
        XCTAssertEqual(NephisFlow.handover(after: "“We should leave before the storm.", before: "“The road floods.”"), .sameSpeaker,
                       "a quote paragraph left open: the same speaker goes on")
        XCTAssertEqual(NephisFlow.handover(after: "He sighed.", before: "“Fine.”"), .narration)
        XCTAssertEqual(NephisFlow.handover(after: "“Fine.”", before: "He sighed."), .narration)
        XCTAssertEqual(NephisFlow.handover(after: "“Fine,” he said.", before: "“Go.”"), .narration)
        XCTAssertNil(NephisFlow.handover(after: "He sighed.", before: "She left."))
        XCTAssertNil(NephisFlow.handover(after: "“We should leave before", before: "the storm.”"), "unsure: no change")
        let chain = NephisFlow.Chain()
        XCTAssertEqual(chain.callPause(pauseBefore: 0.58, after: "“Are you coming?”", mood: "calm", next: "“Not yet.”"), 0.66)
        XCTAssertEqual(chain.callPause(pauseBefore: 0.45, after: "“We should leave.", mood: "calm", next: "“Now.”"), 0.50)
        XCTAssertEqual(chain.callPause(pauseBefore: 0.62, after: "“We should leave before", mood: "calm", next: "the storm.”"), 0.84,
                       "unsure: her sentence pause (Q6)")
    }

    func testAPackCanTuneHerDialoguePausesPerMood() throws {
        let pack = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"""
            {"dialogueGaps": {"reply": 9, "bogus": 0.3},
             "moods": {"tender": {"sentence": 0.7, "trail": 0.48, "paragraph": 0.78, "gainDB": 0, "dialogue": {"reply": 0.72, "narration": 0.01}}}}
            """#.utf8))
        XCTAssertEqual(pack.dialogueGaps["reply"], 2, "clamped")
        XCTAssertNil(pack.dialogueGaps["bogus"], "names it doesn't know are dropped")
        XCTAssertEqual(pack.dialogueGaps["sameSpeaker"], 0.50, "the ones it leaves out keep hers")
        XCTAssertEqual(pack.moods["tender"]?.dialogue?["narration"], 0.1, "clamped")
        // A mood's own value is used as given, even above her sentence pause.
        XCTAssertEqual(pack.callPause(pauseBefore: 0.58, after: "“Stay.”", mood: "tender", next: "“I will.”", handover: .reply), 0.72)
        // Calm has none: the chain's reply gap (2 s here) never makes the pause longer than her sentence pause.
        XCTAssertEqual(pack.callPause(pauseBefore: 0.58, after: "“Stay.”", mood: "calm", next: "“I will.”", handover: .reply), 0.84)
        XCTAssertNil(NephisFlow.Chain().moods["calm"]?.dialogue, "her moods carry none: the chain's gaps")
    }

    func testAPackCanAskForTheTextAsWritten() throws {
        let v42 = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"carryFrames": 12}"#.utf8))
        XCTAssertEqual(v42.text, .app, "no \"text\": the app's text, as every pack before")
        XCTAssertEqual(NephisFlow.Chain().text, .app)
        let raw = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"text": "raw"}"#.utf8))
        XCTAssertEqual(raw.text, .raw)
        XCTAssertEqual(try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"text": "phonemes"}"#.utf8)).text, .app, "a form this version doesn't know")
        XCTAssertEqual(try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"text": 3, "carryFrames": 20}"#.utf8)).carryFrames, 20,
                       "a wrong type doesn't cost the pack its other settings")

        var line = ExpressiveLine(text: "Hm, you came back, Nooow. She bought a bag.")
        line.raw = "Hmmm... you came back... NOOOW! She bought a bag."
        // The app's form: exactly what NephisFlowSynth read before.
        XCTAssertEqual(v42.pocketText(for: line), v42.respelled(StyleMapper.pocketText(StyleMapper.plainText(line.text))))
        XCTAssertEqual(v42.pocketText(for: line), "Hm, you came back, Nooow. She bawt a bagg.")
        // As written; her respellings still apply.
        XCTAssertEqual(raw.pocketText(for: line), "Hmmm... you came back... NOOOW! She bawt a bagg.")
        // A call without the raw text (a Voice Lab line): its text, in the raw form.
        XCTAssertEqual(raw.pocketText(for: ExpressiveLine(text: "Wait… [sigh] really?")), "Wait... really?")
    }

    func testHerTrailPauseFollowsAnEllipsisInTheRawForm() {
        let chain = NephisFlow.Chain()
        XCTAssertEqual(chain.gap(after: "I waited...", mood: "sad"), 0.56)
        XCTAssertEqual(chain.gap(after: "\"Ready, set...\"", mood: "playful"), 0.51, "before a closing quote too")
        XCTAssertEqual(chain.gap(after: "Ready, set…”", mood: "calm"), 0.9)
        XCTAssertEqual(chain.gap(after: "I waited.", mood: "sad"), 0.68)
        XCTAssertEqual(chain.gap(after: "\"Ready, set.\"", mood: "playful"), 0.48)
        XCTAssertEqual(chain.gap(after: "They waited:\"", mood: "calm"), 0.84, "a colon counts at the very end only, as before")
        XCTAssertEqual(chain.gap(after: "I waited...", mood: nil), chain.ellipsisGap)
        // The app's form leaves no ellipsis at a piece's end: there her trail never followed one.
        XCTAssertEqual(chain.gap(after: StyleMapper.pocketText("I waited..."), mood: "sad"), 0.68)
    }

    func testALeadInIsTheLastSentenceAndAnEllipsisDoesNotEndOne() {
        XCTAssertEqual(NephisFlow.lastSentence("The rain stopped. She waited."), "She waited.")
        XCTAssertEqual(NephisFlow.lastSentence("The rain stopped. I waited... and waited... and you never... came."),
                       "I waited... and waited... and you never... came.")
        XCTAssertEqual(NephisFlow.lastSentence("\"Run!\" she said. \"Now?!\" Yes."), "Yes.")
        XCTAssertEqual(NephisFlow.lastSentence("No end here"), "No end here")
        XCTAssertEqual(NephisFlow.lastSentence("Wait.. what is this? Go\nnow."), "Go now.")
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
