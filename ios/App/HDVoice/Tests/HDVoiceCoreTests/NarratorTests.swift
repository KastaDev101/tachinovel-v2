import XCTest
@testable import HDVoiceCore

final class NarratorTests: XCTestCase {
    let mixed = NarratorSentence(
        text: "\"Run,\" she said. \"Now!\"", runs: nil,
        parts: [.init(dialogue: true, text: "\"Run,\"", runs: nil), .init(dialogue: false, text: "she said.", runs: nil),
                .init(dialogue: true, text: "\"Now!\"", runs: [.phonemes("nˈW")])],
        pauseMs: 700, pacedMs: 520, rate: 1.028)

    func resolve(_ id: String) -> String? { VoiceCatalog.voice(id) != nil ? id : nil }

    func testOffChangesNothing() {
        let off = NarratorSettings(enabled: false, dialogueVoice: "am_michael")
        XCTAssertNil(NarratorPlan.parts(for: mixed, settings: off, resolve: resolve))
        XCTAssertEqual(NarratorPlan.pause(for: mixed, settings: off), 0.7, accuracy: 1e-9)
        XCTAssertEqual(NarratorPlan.rate(1.25, for: mixed, settings: off), 1.25)
        XCTAssertFalse(off.usesPolish)
        XCTAssertFalse(NarratorSettings(enabled: true, polish: true, roomTone: false).usesRoomTone)
    }

    func testDialogueVoiceForQuotedPartsOnly() throws {
        let on = NarratorSettings.all(dialogueVoice: "am_michael")
        let parts = try XCTUnwrap(NarratorPlan.parts(for: mixed, settings: on, resolve: resolve))
        XCTAssertEqual(parts.map(\.voice), ["am_michael", nil, "am_michael"])
        XCTAssertEqual(parts.last?.runs, [.phonemes("nˈW")])
        let quoted = NarratorSentence(text: "\"Why not?\"", runs: nil, quoted: true, pauseMs: 700)
        XCTAssertEqual(NarratorPlan.parts(for: quoted, settings: on, resolve: resolve), [NarratorPart(text: "\"Why not?\"", runs: nil, voice: "am_michael")])
        let narration = NarratorSentence(text: "The rain fell.", runs: nil, pauseMs: 320)
        XCTAssertNil(NarratorPlan.parts(for: narration, settings: on, resolve: resolve))
        // No dialogue voice, or one that no longer exists: one piece.
        XCTAssertNil(NarratorPlan.parts(for: quoted, settings: .all(dialogueVoice: nil), resolve: resolve))
        XCTAssertNil(NarratorPlan.parts(for: quoted, settings: .all(dialogueVoice: "mix_gone"), resolve: resolve))
    }

    func testSecondSpeaker() {
        let on = NarratorSettings.all(dialogueVoice: "am_michael", secondDialogueVoice: "bf_emma")
        let a = NarratorSentence(text: "\"Ready?\"", runs: nil, quoted: true, speaker: 0, pauseMs: 700)
        let b = NarratorSentence(text: "\"Always.\"", runs: nil, quoted: true, speaker: 1, pauseMs: 700)
        XCTAssertEqual(NarratorPlan.parts(for: a, settings: on, resolve: resolve)?.first?.voice, "am_michael")
        XCTAssertEqual(NarratorPlan.parts(for: b, settings: on, resolve: resolve)?.first?.voice, "bf_emma")
        let single = NarratorSettings.all(dialogueVoice: "am_michael")
        XCTAssertEqual(NarratorPlan.parts(for: b, settings: single, resolve: resolve)?.first?.voice, "am_michael", "one dialogue voice for both")
    }

    func testPacingAndJitterSwitches() {
        var s = NarratorSettings.all(dialogueVoice: nil)
        s.pacingStyle = "natural" // `mixed` carries the natural pause only
        XCTAssertEqual(NarratorPlan.pause(for: mixed, settings: s), 0.52, accuracy: 1e-9)
        XCTAssertEqual(NarratorPlan.rate(1, for: mixed, settings: s), 1.028, accuracy: 1e-6)
        s.pacing = false
        s.jitter = false
        XCTAssertEqual(NarratorPlan.pause(for: mixed, settings: s), 0.7, accuracy: 1e-9)
        XCTAssertEqual(NarratorPlan.rate(1, for: mixed, settings: s), 1)
        let wild = NarratorSentence(text: "x", runs: nil, pauseMs: 320, rate: 1.4)
        XCTAssertEqual(NarratorPlan.rate(1, for: wild, settings: .all(dialogueVoice: nil)), 1.03, accuracy: 1e-6, "clamped")
    }

    func testPhraseBreaksSplitNarrationIntoPhrasesWithTheirPauses() {
        let s = NarratorSentence(text: "He waited for hours but nobody came.", runs: nil, pauseMs: 320,
                                 phrases: [.init(text: "He waited for hours", pauseMs: 105), .init(text: "but nobody came.", pauseMs: 0)])
        let on = NarratorSettings(enabled: true)
        XCTAssertEqual(on.phraseBreaks, "clauses", "Kasta's pick is the default")
        let parts = NarratorPlan.parts(for: s, settings: on) { $0 }
        XCTAssertEqual(parts?.map(\.text), ["He waited for hours", "but nobody came."])
        XCTAssertEqual(parts?.map(\.pauseAfter), [0.105, 0])
        XCTAssertEqual(parts?.compactMap(\.voice), [], "the narrator's voice")
        XCTAssertNil(NarratorPlan.parts(for: s, settings: NarratorSettings(enabled: true, phraseBreaks: "off")) { $0 })
        XCTAssertNil(NarratorPlan.parts(for: s, settings: NarratorSettings(enabled: false)) { $0 })
        let withRuns = NarratorSentence(text: s.text, runs: [.phonemes("x")], pauseMs: 320, phrases: s.phrases)
        XCTAssertNil(NarratorPlan.parts(for: withRuns, settings: on) { $0 }, "phoneme runs can't be split by text")
    }

    func testDefaultsAreKastasPicks() throws {
        let d = NarratorSettings()
        XCTAssertTrue(d.enabled)
        XCTAssertNil(d.dialogueVoice, "one narrator voice")
        XCTAssertNil(d.secondDialogueVoice)
        XCTAssertTrue(d.pacing)
        XCTAssertEqual(d.pacingStyle, "relaxed")
        XCTAssertEqual(d.phraseBreaks, "clauses")
        XCTAssertFalse(d.jitter)
        XCTAssertTrue(d.polish)
        XCTAssertEqual(d.compressorRatio, 1.5)
        XCTAssertFalse(d.roomTone)
        XCTAssertEqual(VoicePreferences().narrator, d)
        // Settings saved before these defaults (no version, e.g. narrator mode off with jitter on) become them.
        let before = try JSONDecoder().decode(NarratorSettings.self, from: Data(#"{"enabled":false,"jitter":true,"pacing":true}"#.utf8))
        XCTAssertEqual(before, d)
        // Choices saved with the current version are kept.
        var mine = d
        mine.enabled = false
        mine.pacingStyle = "natural"
        mine.compressorRatio = 2
        XCTAssertEqual(try JSONDecoder().decode(NarratorSettings.self, from: JSONEncoder().encode(mine)), mine)
        XCTAssertEqual(NarratorSettings(compressorRatio: 9).compressorRatio, 4, "clamped")
        XCTAssertEqual(NarratorSettings(pacingStyle: "weird").pacingStyle, "relaxed")
    }

    func testRelaxedAndNaturalPacing() {
        let s = NarratorSentence(text: "The bridge held.", runs: nil, pauseMs: 700, pacedMs: 820, relaxedMs: 1200)
        XCTAssertEqual(NarratorPlan.pause(for: s, settings: NarratorSettings()), 1.2, accuracy: 1e-9, "relaxed by default")
        XCTAssertEqual(NarratorPlan.pause(for: s, settings: NarratorSettings(pacingStyle: "natural")), 0.82, accuracy: 1e-9)
        XCTAssertEqual(NarratorPlan.pause(for: s, settings: NarratorSettings(pacing: false)), 0.7, accuracy: 1e-9)
        let same = NarratorSentence(text: "Chapter One", runs: nil, pauseMs: 1300)
        XCTAssertEqual(NarratorPlan.pause(for: same, settings: NarratorSettings()), 1.3, accuracy: 1e-9, "titles unchanged")
    }

    func testSettingsPersistAndDeletingAMixClearsIt() throws {
        var p = VoicePreferences()
        XCTAssertTrue(p.narrator.enabled, "on by default (Kasta's pick)")
        let mix = try p.saveCustomVoice(id: nil, name: "Gruff", a: "am_fenrir", b: "am_michael", percent: 30)
        p.narrator = .all(dialogueVoice: mix.id, secondDialogueVoice: "bf_emma", roomTone: true)
        let back = try JSONDecoder().decode(VoicePreferences.self, from: JSONEncoder().encode(p))
        XCTAssertEqual(back.narrator, p.narrator)
        let quoted = NarratorSentence(text: "\"Go.\"", runs: nil, quoted: true, pauseMs: 320)
        XCTAssertEqual(p.narratorParts(for: quoted)?.first?.voice, "am_fenrir+am_michael@30", "a mix speaks as its blend")
        try p.deleteCustomVoice(id: mix.id)
        XCTAssertNil(p.narrator.dialogueVoice)
        XCTAssertEqual(p.narrator.secondDialogueVoice, "bf_emma")
        let old = try JSONDecoder().decode(VoicePreferences.self, from: Data(#"{"defaultVoice":"af_heart","narrator":{"version":2,"enabled":true}}"#.utf8))
        XCTAssertEqual(old.narrator, NarratorSettings(enabled: true), "missing narrator keys take their defaults")
    }
}
