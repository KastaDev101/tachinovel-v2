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
        let off = NarratorSettings(dialogueVoice: "am_michael")
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
        XCTAssertEqual(NarratorPlan.pause(for: mixed, settings: s), 0.52, accuracy: 1e-9)
        XCTAssertEqual(NarratorPlan.rate(1, for: mixed, settings: s), 1.028, accuracy: 1e-6)
        s.pacing = false
        s.jitter = false
        XCTAssertEqual(NarratorPlan.pause(for: mixed, settings: s), 0.7, accuracy: 1e-9)
        XCTAssertEqual(NarratorPlan.rate(1, for: mixed, settings: s), 1)
        let wild = NarratorSentence(text: "x", runs: nil, pauseMs: 320, rate: 1.4)
        XCTAssertEqual(NarratorPlan.rate(1, for: wild, settings: .all(dialogueVoice: nil)), 1.03, accuracy: 1e-6, "clamped")
    }

    func testSettingsPersistAndDeletingAMixClearsIt() throws {
        var p = VoicePreferences()
        XCTAssertFalse(p.narrator.enabled, "off by default")
        let mix = try p.saveCustomVoice(id: nil, name: "Gruff", a: "am_fenrir", b: "am_michael", percent: 30)
        p.narrator = .all(dialogueVoice: mix.id, secondDialogueVoice: "bf_emma", roomTone: true)
        let back = try JSONDecoder().decode(VoicePreferences.self, from: JSONEncoder().encode(p))
        XCTAssertEqual(back.narrator, p.narrator)
        let quoted = NarratorSentence(text: "\"Go.\"", runs: nil, quoted: true, pauseMs: 320)
        XCTAssertEqual(p.narratorParts(for: quoted)?.first?.voice, "am_fenrir+am_michael@30", "a mix speaks as its blend")
        try p.deleteCustomVoice(id: mix.id)
        XCTAssertNil(p.narrator.dialogueVoice)
        XCTAssertEqual(p.narrator.secondDialogueVoice, "bf_emma")
        let old = try JSONDecoder().decode(VoicePreferences.self, from: Data(#"{"defaultVoice":"af_heart","narrator":{"enabled":true}}"#.utf8))
        XCTAssertEqual(old.narrator, NarratorSettings(enabled: true), "missing narrator keys take their defaults")
    }
}
