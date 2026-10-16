//
//  NephisDialogueTests.swift — her narrator pack and her dialogue pack in one read (NephisDialogue.swift): the quote
//  routing on novel-style lines (tags inside a quote pair, quotations that run on, stray marks, thoughts, apostrophes,
//  short interjections), laughter, the dialogue comma beat, the clips per mood, where the voices change in a call and
//  how the two finishing chains are mixed, the level match, and the dialogue pack's chain fields (absent = as before).
//  The routing's expectations were checked against a line-for-line Python port of QuoteRouter on the PC.
//

@testable import ExpressiveCore
import Foundation
import XCTest

final class NephisDialogueTests: XCTestCase {
    private typealias Span = QuoteRouter.Span

    private func route(_ text: String, _ context: QuoteRouter.Context = .init()) -> [Span] {
        var state = QuoteRouter.State()
        return QuoteRouter.split(text, state: &state, context: context)
    }

    private func d(_ text: String) -> Span { Span(text: text, dialogue: true) }
    private func n(_ text: String) -> Span { Span(text: text, dialogue: false) }

    // MARK: - Quote routing

    func testATagInsideAQuotePairIsNarrationBetweenTwoDialogueSpans() {
        XCTAssertEqual(route("“Come here,” she whispered, “now.”"), [d("Come here,"), n("she whispered,"), d("now.")])
        XCTAssertEqual(route("\"Run,\" he said. \"Now!\""), [d("Run,"), n("he said."), d("Now!")])
        XCTAssertEqual(route("“We’ll see,” said the boys’ mother, “won’t we?”"), [d("We’ll see,"), n("said the boys’ mother,"), d("won’t we?")])
        XCTAssertEqual(route("“I can’t believe it,” she said. “The boys’ room is empty.”"),
                       [d("I can’t believe it,"), n("she said."), d("The boys’ room is empty.")])
    }

    func testPunctuationAfterAClosingQuoteGoesWithTheWordsBeforeIt() {
        XCTAssertEqual(route("“Hello”, she said."), [d("Hello,"), n("she said.")])
    }

    func testACallWithoutDialogueIsOneNarrationSpanExactlyAsGiven() {
        XCTAssertEqual(route("She said nothing."), [n("She said nothing.")])
        XCTAssertEqual(route("It was 3 o’clock when the rock’n’roll began."), [n("It was 3 o’clock when the rock’n’roll began.")])
        XCTAssertEqual(route("“…”"), [n("“…”")], "a quote without words is no dialogue")
    }

    func testALoneShortInterjectionInsideNarrationStaysWithTheNarrator() {
        XCTAssertEqual(route("He looked up. “Oh.” Then he left the room without a word."),
                       [n("He looked up. “Oh.” Then he left the room without a word.")])
        XCTAssertEqual(route("The sign read “Closed”."), [n("The sign read “Closed”.")], "scare quotes are narration")
        // Written laughter keeps the dialogue voice when the pack has a laugh clip.
        let line = "“Ha!” He slapped the table hard enough to rattle the cups."
        XCTAssertEqual(route(line), [n(line)])
        XCTAssertEqual(route(line, .init(keepLaughter: true)), [d("Ha!"), n("He slapped the table hard enough to rattle the cups.")])
        // A paragraph that is only the interjection is dialogue, and so are two of them.
        XCTAssertEqual(route("“No.”"), [d("No.")])
        XCTAssertEqual(route("“Yes.” “No.”"), [d("Yes."), d("No.")])
    }

    func testAStrayQuoteFallsBackToNarration() {
        XCTAssertEqual(route("He said “hello and then left."), [n("He said “hello and then left.")])
        XCTAssertEqual(route("and the rest.” He laughed."), [n("and the rest.” He laughed.")], "a closing mark with nothing open")
    }

    func testAQuotationThatRunsOnIntoTheNextParagraphIsDialogue() {
        // The next paragraph reopens the quotation (novel convention): the open part is speech.
        XCTAssertEqual(route("He said “hello and then left.", .init(nextOpensQuote: true)), [n("He said"), d("hello and then left.")])
        XCTAssertEqual(route("“The march was long, and the men were tired.", .init(nextOpensQuote: true)),
                       [d("The march was long, and the men were tired.")])
    }

    func testAQuotationSplitAcrossTwoCallsOfAParagraphCarriesOn() {
        var state = QuoteRouter.State()
        let first = QuoteRouter.split("Mara laughed into her scarf. “Ha!", state: &state,
                                      context: .init(restOfParagraph: "You could have warned me, you know, before I paid for it.”"))
        XCTAssertEqual(first, [n("Mara laughed into her scarf."), d("Ha!")], "carried on: never an aside")
        XCTAssertEqual(state.open, .double)
        let second = QuoteRouter.split("You could have warned me, you know, before I paid for it.” She grinned.", state: &state)
        XCTAssertEqual(second, [d("You could have warned me, you know, before I paid for it."), n("She grinned.")])
        XCTAssertNil(state.open)
        // The rest of the paragraph never closes it: a stray mark after all.
        var stray = QuoteRouter.State()
        XCTAssertEqual(QuoteRouter.split("He said “hello and then", state: &stray, context: .init(restOfParagraph: "left the room.")),
                       [n("He said “hello and then")])
        XCTAssertNil(stray.open)
    }

    func testSingleQuotesAreThoughtsInADoubleQuotedChapterUnlessThePackOptsIn() {
        let thought = "‘Curse it,’ Sunny thought."
        XCTAssertEqual(route(thought, .init(singleQuotes: .thought)), [n(thought)])
        XCTAssertEqual(route(thought, .init(singleQuotes: .thought, thoughtsAsDialogue: true)), [d("Curse it,"), n("Sunny thought.")])
        // British style: single quotes are speech, apostrophes stay words.
        XCTAssertEqual(route("‘Come here,’ she said, ‘and sit.’", .init(singleQuotes: .dialogue)), [d("Come here,"), n("she said,"), d("and sit.")])
        XCTAssertEqual(route("‘It’s the boys’ turn now,’ she said.", .init(singleQuotes: .dialogue)), [d("It’s the boys’ turn now,"), n("she said.")])
        // Unknown style: speech when the call has no double quotes, thoughts when it has.
        XCTAssertEqual(route("‘Fine,’ she said."), [d("Fine,"), n("she said.")])
        XCTAssertEqual(route("“Fine, have it your way,” she said. ‘Liar,’ he thought."),
                       [d("Fine, have it your way,"), n("she said. ‘Liar,’ he thought.")])
        XCTAssertEqual(QuoteRouter.SingleQuotes.of(["He ran.", "“Stop!” she cried."]), .thought)
        XCTAssertEqual(QuoteRouter.SingleQuotes.of(["He ran.", "‘Stop!’ she cried."]), .dialogue)
    }

    func testOpensQuoteSeesAParagraphThatReopensAQuotation() {
        XCTAssertTrue(QuoteRouter.opensQuote("  “And another thing,” he went on."))
        XCTAssertTrue(QuoteRouter.opensQuote("\"Yes.\""))
        XCTAssertTrue(QuoteRouter.opensQuote("‘Yes.’"))
        XCTAssertFalse(QuoteRouter.opensQuote("He went on."))
        XCTAssertFalse(QuoteRouter.opensQuote(""))
    }

    // MARK: - Laughter and the comma beat

    func testWrittenLaughterIsFoundAndWordsAreNot() {
        for t in ["Ha!", "Haha", "Hahaha, no.", "Heh.", "Hehe", "Pfft.", "Ahaha!", "Bwahaha!", "Tee-hee", "Hah.", "Ha, I knew it."] {
            XCTAssertTrue(QuoteRouter.laughs(t), t)
        }
        for t in ["Have", "Hat", "harm", "Ha", "what", "aha moment", "Haaaa"] {
            XCTAssertFalse(QuoteRouter.laughs(t), t)
        }
    }

    func testTheCommaBeatCutsAtCommasAndDashesNeverInsideAWordOrNumber() {
        XCTAssertEqual(QuoteRouter.commaBeats("Wait, I’m not—listen, please."), ["Wait,", "I’m not—", "listen,", "please."])
        XCTAssertEqual(QuoteRouter.commaBeats("Yes, sir."), ["Yes,", "sir."])
        XCTAssertEqual(QuoteRouter.commaBeats("—and then, nothing."), ["—and then,", "nothing."])
        XCTAssertEqual(QuoteRouter.commaBeats("1,000 coins, no more"), ["1,000 coins,", "no more"])
        XCTAssertEqual(QuoteRouter.commaBeats("Well-known -- or not."), ["Well-known --", "or not."])
        XCTAssertEqual(QuoteRouter.commaBeats("Oh, no, no, no!"), ["Oh,", "no,", "no,", "no!"])
        XCTAssertEqual(QuoteRouter.commaBeats("Stay."), ["Stay."])
    }

    // MARK: - Her dialogue clips

    func testEachMoodReadsWithItsClipAndLaughterWithTheLaughClip() throws {
        let chain = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"moods": {"wry": {"clip": "nephis-dlg-smug"}}}"#.utf8))
        let have: Set<String> = ["nephis-dlg-smug", "nephis-tense", "nephis-dlg-laugh", "nephis-dlg-cold"]
        XCTAssertEqual(DialogueClips.pick(mood: "wry", laughing: false, chain: chain, available: have), "nephis-dlg-smug")
        XCTAssertEqual(DialogueClips.pick(mood: "cold", laughing: false, chain: chain, available: have), "nephis-dlg-cold")
        XCTAssertEqual(DialogueClips.pick(mood: "tense", laughing: false, chain: chain, available: have), "nephis-tense")
        XCTAssertNil(DialogueClips.pick(mood: "awe", laughing: false, chain: chain, available: have), "none: the pack's calm clip")
        XCTAssertEqual(DialogueClips.pick(mood: "wry", laughing: true, chain: chain, available: have), "nephis-dlg-laugh")
        XCTAssertEqual(DialogueClips.pick(mood: "wry", laughing: true, chain: chain, available: ["nephis-dlg-smug"]), "nephis-dlg-smug",
                       "no laugh clip: the mood's")
        let named = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"moods": {"laugh": {"clip": "nephis-dlg-giggle"}}}"#.utf8))
        XCTAssertEqual(DialogueClips.laughClip(chain: named, available: ["nephis-dlg-giggle", "nephis-dlg-laugh"]), "nephis-dlg-giggle")
        XCTAssertEqual(DialogueClips.mood(role: "performed"), "calm")
        XCTAssertEqual(DialogueClips.mood(role: "dread"), "dread")
    }

    // MARK: - The chain fields of a dialogue pack

    func testADialoguePacksChainFieldsAndPartialMoods() throws {
        let chain = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"""
            {"dialogueCommaBeat": true, "thoughts": true, "loudnessMatch": false,
             "eqGroups": {"hushed": {"gainDB": -2, "sections": [{"type": "lowShelf", "hz": 200, "q": 0.7, "db": 2}]}},
             "studioEQ": {"gainDB": 1, "sections": []},
             "floorGuard": {"amount": 0.4},
             "moods": {"hushed": {"clip": "nephis-dlg-secret", "clause": 0.33, "tempo": 0.9, "eqGroup": "hushed"},
                       "playful": {"sentence": 0.56, "clause": 0.21, "tempo": 1.4},
                       "laugh": {"clip": "nephis-dlg-laugh"}}}
            """#.utf8))
        XCTAssertTrue(chain.dialogueCommaBeat)
        XCTAssertTrue(chain.thoughtsAsDialogue)
        XCTAssertFalse(chain.loudnessMatch)
        XCTAssertEqual(chain.floorGuard?.amount, 0.4)
        let hushed = try XCTUnwrap(chain.moods["hushed"])
        XCTAssertEqual(hushed.sentence, NephisFlow.herMoods["hushed"]?.sentence, "what an entry leaves out keeps the mood's")
        XCTAssertEqual(hushed.clip, "nephis-dlg-secret")
        XCTAssertEqual(chain.clausePause(mood: "hushed"), 0.33)
        XCTAssertEqual(chain.clausePause(mood: "calm"), chain.clauseGap)
        XCTAssertEqual(chain.gap(after: "Wait,", mood: "hushed"), 0.33, "a mid-sentence piece gets the mood's clause")
        XCTAssertEqual(chain.tempo(mood: "hushed"), 0.9)
        XCTAssertEqual(chain.tempo(mood: "playful"), 1.15, "clamped")
        XCTAssertEqual(chain.tempo(mood: "calm"), 1)
        XCTAssertEqual(chain.moods["playful"]?.sentence, 0.56)
        XCTAssertEqual(chain.moods["laugh"]?.sentence, NephisFlow.herMoods["calm"]?.sentence, "a new mood starts from calm")
        XCTAssertEqual(chain.studioEQ(for: "hushed")?.gainDB, -2)
        XCTAssertEqual(chain.studioEQ(for: "calm")?.gainDB, 1, "no group: the pack's studio EQ")
        // Her hand-over pause: the chain's dialogue gap caps her sentence pause, a mood's own value wins.
        XCTAssertEqual(chain.handoverPause(after: "she said.", mood: "calm", kind: .narration), 0.66)
        XCTAssertEqual(chain.handoverPause(after: "she said.", mood: "hushed", kind: .narration), 0.5)
    }

    func testANarratorPacksChainReadsExactlyAsBefore() throws {
        // Pack 22's mood entries (complete): every value as the old decoder made it, nothing new set.
        let chain = try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"""
            {"moods": {"wry": {"sentence": 0.58, "trail": 0.42, "paragraph": 0.66, "gainDB": 0.7, "toneDB": 0.4},
                       "dread": {"sentence": 0.64, "trail": 0.52, "paragraph": 0.62, "gainDB": -2.5, "toneDB": 1.8}},
             "clipFrames": 113, "text": "raw"}
            """#.utf8))
        XCTAssertEqual(chain.moods["wry"], NephisFlow.Chain.Mood(sentence: 0.58, trail: 0.42, paragraph: 0.66, gainDB: 0.7, toneDB: 0.4))
        XCTAssertEqual(chain.moods["dread"], NephisFlow.Chain.Mood(sentence: 0.64, trail: 0.52, paragraph: 0.62, gainDB: -2.5, toneDB: 1.8))
        XCTAssertEqual(chain.moods["calm"], NephisFlow.herMoods["calm"])
        XCTAssertFalse(chain.dialogueCommaBeat)
        XCTAssertFalse(chain.thoughtsAsDialogue)
        XCTAssertTrue(chain.loudnessMatch)
        XCTAssertNil(chain.floorGuard)
        XCTAssertNil(chain.eqGroups)
        XCTAssertEqual(chain.gap(after: "and then,", mood: "wry"), chain.clauseGap)
        XCTAssertEqual(chain.tempo(mood: "wry"), 1)
        // A new field this version can't read never breaks a pack.
        XCTAssertNoThrow(try JSONDecoder().decode(NephisFlow.Chain.self, from: Data(#"{"moods": {"calm": {"clip": 3, "tempo": "x"}}, "eqGroups": 4}"#.utf8)))
    }

    // MARK: - Mixing the two voices

    func testTheMixWeightsRampEqualPowerAtEachSwitch() {
        typealias S = NephisVoiceMix.Switch
        XCTAssertEqual(NephisVoiceMix.weights(count: 10, first: 0, switches: [S(at: 5, voice: 1)], fade: 2), [0, 0, 0, 0, 0.5, 1, 1, 1, 1, 1])
        XCTAssertEqual(NephisVoiceMix.weights(count: 6, first: 1, switches: [S(at: 3, voice: 0)], fade: 0), [1, 1, 1, 0, 0, 0])
        XCTAssertEqual(NephisVoiceMix.weights(count: 4, first: 0, switches: [S(at: 2, voice: 0)], fade: 2), [0, 0, 0, 0], "no change")
        let out = NephisVoiceMix.mix([1, 1, 1, 1], [2, 2, 2], weights: [0, 0.5, 1, 1])
        XCTAssertEqual(out[0], 1)
        XCTAssertEqual(out[1], Float(cos(Double.pi / 4) + 2 * sin(Double.pi / 4)), accuracy: 1e-5)
        XCTAssertEqual(out[2], 2)
        XCTAssertEqual(out[3], 0, "past the dialogue chain's end it is silent there")
        let both = [S(at: 5, voice: 1), S(at: 8, voice: 0)]
        XCTAssertEqual(NephisVoiceMix.lastSample(of: 1, count: 20, first: 0, switches: both, fade: 2), 10)
        XCTAssertEqual(NephisVoiceMix.lastSample(of: 1, count: 20, first: 0, switches: [S(at: 5, voice: 1)], fade: 2), 20)
        XCTAssertNil(NephisVoiceMix.lastSample(of: 1, count: 20, first: 0, switches: [], fade: 2))
        let regions = NephisVoiceMix.regions(count: 10, first: 0, switches: both)
        XCTAssertEqual(regions.map { $0.range }, [0..<5, 5..<8, 8..<10])
        XCTAssertEqual(regions.map { $0.voice }, [0, 1, 0])
    }

    func testSwitchesSitInTheMiddleOfTheirPauseOnceThePadsAreIn() {
        let pads: [(at: Int, seconds: Double)] = [(at: 1, seconds: 0.5), (at: 3, seconds: 1)]
        let s = NephisVoiceMix.samples([.init(latent: 3, voice: 1, inPad: true), .init(latent: 5, voice: 0, inPad: false)],
                                       perLatent: 10, pads: pads, sampleRate: 10)
        XCTAssertEqual(s, [.init(at: 30 + 5 + 5, voice: 1), .init(at: 50 + 5 + 10, voice: 0)])
        XCTAssertEqual(NephisVoiceMix.samples([.init(latent: 3, voice: 1, inPad: true)], perLatent: 10, sampleRate: 10), [.init(at: 30, voice: 1)])
    }

    func testOnlyTheDialogueRegionsChangeTempo() {
        let rate = 24_000
        let x = (0..<(3 * rate)).map { Float(0.3 * sin(2 * Double.pi * 200 * Double($0) / Double(rate))) }
        let switches = [NephisVoiceMix.Switch(at: rate, voice: 1), NephisVoiceMix.Switch(at: 2 * rate, voice: 0)]
        let same = NephisVoiceMix.stretch(x, first: 0, switches: switches, voice: 1, tempo: 1, sampleRate: rate)
        XCTAssertEqual(same.samples, x)
        XCTAssertEqual(same.switches, switches)
        let faster = NephisVoiceMix.stretch(x, first: 0, switches: switches, voice: 1, tempo: 1.1, sampleRate: rate)
        let region = Int((Double(rate) / 1.1).rounded())
        XCTAssertEqual(faster.samples.count, 2 * rate + region)
        XCTAssertEqual(faster.switches, [.init(at: rate, voice: 1), .init(at: rate + region, voice: 0)])
        XCTAssertEqual(Array(faster.samples.prefix(rate)), Array(x.prefix(rate)), "the narrator's region is untouched")
    }

    // MARK: - The level match

    func testTheDialogueLevelFollowsTheNarratorsSlowly() {
        let rate = 24_000
        let sine = (0..<rate).map { Float(0.1 * sin(2 * Double.pi * 300 * Double($0) / Double(rate))) }
        let level = NephisLoudnessMatch.activeLevel(sine[...], sampleRate: rate)
        XCTAssertEqual(level?.db ?? 0, 20 * log10(0.1 / 2.0.squareRoot()), accuracy: 0.1)
        XCTAssertEqual(level?.seconds ?? 0, 1, accuracy: 0.02)
        XCTAssertNil(NephisLoudnessMatch.activeLevel([Float](repeating: 0, count: rate)[...], sampleRate: rate))
        let two = NephisLoudnessMatch.activeLevel(sine + [Float](repeating: 0, count: rate) + sine, ranges: [0..<rate, rate..<(3 * rate)], sampleRate: rate)
        XCTAssertEqual(two?.seconds ?? 0, 2, accuracy: 0.03)
        XCTAssertEqual(two?.db ?? 0, level?.db ?? 1, accuracy: 0.1)

        var match = NephisLoudnessMatch()
        match.observe(voice: 0, level: (-20, 0.3))
        match.observe(voice: 1, level: (-24, 0.3))
        XCTAssertEqual(match.dialogueGainDB, 0, "not enough speech yet")
        match.observe(voice: 0, level: (-20, 3))
        match.observe(voice: 1, level: (-24, 3))
        XCTAssertEqual(match.dialogueGainDB, 4, accuracy: 1e-9)
        match.observe(voice: 1, level: (-22, 3))
        XCTAssertEqual(match.dialogueGainDB, 3.4, accuracy: 1e-9, "a share of the way, not at once")
        var loud = NephisLoudnessMatch()
        loud.observe(voice: 0, level: (-10, 3))
        loud.observe(voice: 1, level: (-30, 3))
        XCTAssertEqual(loud.dialogueGainDB, NephisLoudnessMatch.maxDB, "capped")
    }

    // MARK: - Pack roles

    func testAPackIsADialoguePackOnlyWhenItSaysSo() {
        XCTAssertEqual(NephisVoiceRole(packInfo: ["role": "dialogue"]), .dialogue)
        XCTAssertEqual(NephisVoiceRole(packInfo: ["role": "Dialogue"]), .dialogue)
        XCTAssertEqual(NephisVoiceRole(packInfo: ["role": "narrator"]), .narrator)
        XCTAssertEqual(NephisVoiceRole(packInfo: ["role": 3]), .narrator)
        XCTAssertEqual(NephisVoiceRole(packInfo: nil), .narrator)
    }

    func testTheSpeedTestPassageIsUnchangedWithoutADialoguePack() {
        XCTAssertEqual(NephisSpeedTest.passageFor(dialogue: false), NephisSpeedTest.passage)
        XCTAssertEqual(NephisSpeedTest.passageFor(dialogue: true), NephisSpeedTest.passage + NephisSpeedTest.dialoguePassage)
        var state = QuoteRouter.State()
        let spans = QuoteRouter.split(NephisSpeedTest.dialoguePassage[0], state: &state, context: .init(singleQuotes: .thought))
        XCTAssertEqual(spans.map(\.dialogue), [true, false, true])
    }
}
