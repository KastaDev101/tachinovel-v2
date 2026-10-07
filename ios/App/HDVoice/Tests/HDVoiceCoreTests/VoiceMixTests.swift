import XCTest
@testable import HDVoiceCore

final class VoiceMixTests: XCTestCase {
    func testBlendStringRoundTripAndValidation() throws {
        let b = try XCTUnwrap(VoiceBlend(a: "af_heart", b: "bf_emma", percent: 35))
        XCTAssertEqual(b.spec, "af_heart+bf_emma@35")
        XCTAssertEqual(VoiceBlend.parse(b.spec), b)
        XCTAssertEqual(b.t, 0.35, accuracy: 1e-6)
        XCTAssertEqual(b.dominant, "af_heart")
        XCTAssertEqual(VoiceBlend(a: "af_heart", b: "bf_emma", percent: 51)?.dominant, "bf_emma")
        XCTAssertEqual(VoiceBlend(a: "af_heart", b: "bf_emma", percent: 50)?.dominant, "af_heart", "a tie goes to the first voice")

        XCTAssertNil(VoiceBlend(a: "af_heart", b: "af_heart", percent: 50), "one voice is not a mix")
        XCTAssertNil(VoiceBlend(a: "af_heart", b: "zz_nobody", percent: 50))
        XCTAssertNil(VoiceBlend(a: "af_heart", b: "bf_emma", percent: 0), "the ends are plain voices")
        XCTAssertNil(VoiceBlend(a: "af_heart", b: "bf_emma", percent: 100))
        for bad in ["af_heart", "", "af_heart+bf_emma", "af_heart+bf_emma@", "af_heart+bf_emma@x", "+@5", "af_heart@5+bf_emma", "mix_0011aabb"] {
            XCTAssertNil(VoiceBlend.parse(bad), bad)
        }
        XCTAssertEqual(VoiceBlend.percent(34.6), 35)
        XCTAssertEqual(VoiceBlend.percent(-3), 0)
        XCTAssertEqual(VoiceBlend.percent(250), 100)
        XCTAssertEqual(VoiceBlend.percent(.nan), 50)
    }

    func testMixInterpolatesAndIsExactAtTheEnds() {
        let a: [Float] = [0, 1, -2, 4]
        let b: [Float] = [10, 1, 2, -4]
        XCTAssertEqual(VoiceBlend.mix(a, b, t: 0), a, "t = 0 is exactly the first voice")
        XCTAssertEqual(VoiceBlend.mix(a, b, t: 1), b, "t = 1 is exactly the second voice")
        XCTAssertEqual(VoiceBlend.mix(a, b, t: 0.25), [2.5, 1, -1, 2])
        // A full-size pack (510 × 256) stays the same size.
        let big = [Float](repeating: 1, count: 510 * 256)
        XCTAssertEqual(VoiceBlend.mix(big, big, t: 0.5).count, 510 * 256)
    }

    func testSaveEditDeleteMixesAndWhereTheyAreUsed() throws {
        var p = VoicePreferences()
        let mix = try p.saveCustomVoice(id: nil, name: "  Warm\nnarrator ", a: "af_heart", b: "am_michael", percent: 40)
        XCTAssertTrue(CustomVoice.isCustomId(mix.id))
        XCTAssertEqual(mix.name, "Warm narrator", "trimmed, one line")
        XCTAssertTrue(p.isChoice(mix.id))
        XCTAssertEqual(p.engineVoice(mix.id), "af_heart+am_michael@40")
        XCTAssertEqual(p.displayName(mix.id), "Warm narrator")
        XCTAssertEqual(p.displayName("af_heart+am_michael@40"), "Warm narrator", "a saved blend shows its name")
        XCTAssertEqual(p.displayName("af_heart+bf_emma@35"), "Heart + Emma (35 %)")

        // Used as the default and for one novel: the engine gets the blend, the UI gets the mix id.
        p.defaultVoice = mix.id
        XCTAssertEqual(p.voice(forNovel: nil), "af_heart+am_michael@40")
        XCTAssertEqual(p.choice(forNovel: nil), mix.id)
        p.setVoice("bf_emma", forNovel: "src:a")
        p.setVoice(mix.id, forNovel: "src:b")
        XCTAssertNil(p.novelVoices["src:b"], "choosing the default clears the override")
        p.defaultVoice = "af_heart"
        p.setVoice(mix.id, forNovel: "src:b")
        XCTAssertEqual(p.voice(forNovel: "src:b"), "af_heart+am_michael@40")

        // Edit: same id, new blend.
        let edited = try p.saveCustomVoice(id: mix.id, name: "Warmer", a: "af_heart", b: "am_michael", percent: 25)
        XCTAssertEqual(edited.id, mix.id)
        XCTAssertEqual(p.customVoices.count, 1)
        XCTAssertEqual(p.voice(forNovel: "src:b"), "af_heart+am_michael@25")

        // Slider at an end: the mix speaks as that one voice.
        try p.saveCustomVoice(id: mix.id, name: "Warmer", a: "af_heart", b: "am_michael", percent: 100)
        XCTAssertEqual(p.voice(forNovel: "src:b"), "am_michael")

        // Delete: novels using it fall back to the default.
        try p.deleteCustomVoice(id: mix.id)
        XCTAssertTrue(p.customVoices.isEmpty)
        XCTAssertNil(p.novelVoices["src:b"])
        XCTAssertEqual(p.novelVoices["src:a"], "bf_emma", "other novels keep their voice")
        XCTAssertEqual(p.voice(forNovel: "src:b"), "af_heart")
        XCTAssertThrowsError(try p.deleteCustomVoice(id: mix.id)) { XCTAssertEqual($0 as? CustomVoiceError, .notFound) }
    }

    func testDeletingTheDefaultMixGoesBackToHeart() throws {
        var p = VoicePreferences()
        let mix = try p.saveCustomVoice(id: nil, name: "Duo", a: "bf_emma", b: "bm_george", percent: 50)
        p.defaultVoice = mix.id
        try p.deleteCustomVoice(id: mix.id)
        XCTAssertEqual(p.defaultVoice, VoiceCatalog.defaultVoiceId)
    }

    func testSaveRejectsBadInput() {
        var p = VoicePreferences()
        XCTAssertThrowsError(try p.saveCustomVoice(id: nil, name: "x", a: "af_heart", b: "af_heart", percent: 50)) {
            XCTAssertEqual($0 as? CustomVoiceError, .sameVoice)
        }
        XCTAssertThrowsError(try p.saveCustomVoice(id: nil, name: "x", a: "af_heart", b: "nobody", percent: 50)) {
            XCTAssertEqual($0 as? CustomVoiceError, .unknownVoice("nobody"))
        }
        XCTAssertThrowsError(try p.saveCustomVoice(id: nil, name: " \n ", a: "af_heart", b: "bf_emma", percent: 50)) {
            XCTAssertEqual($0 as? CustomVoiceError, .emptyName)
        }
        XCTAssertThrowsError(try p.saveCustomVoice(id: "mix_00000000", name: "x", a: "af_heart", b: "bf_emma", percent: 50)) {
            XCTAssertEqual($0 as? CustomVoiceError, .notFound)
        }
        let long = String(repeating: "n", count: 90)
        XCTAssertEqual((try? p.saveCustomVoice(id: nil, name: long, a: "af_heart", b: "bf_emma", percent: 50))?.name.count, CustomVoice.maxNameLength)
        for i in 1..<CustomVoice.maxCount { _ = try? p.saveCustomVoice(id: nil, name: "m\(i)", a: "af_heart", b: "bf_emma", percent: 50) }
        XCTAssertEqual(p.customVoices.count, CustomVoice.maxCount)
        XCTAssertThrowsError(try p.saveCustomVoice(id: nil, name: "one more", a: "af_heart", b: "bf_emma", percent: 50)) {
            XCTAssertEqual($0 as? CustomVoiceError, .tooMany)
        }
        XCTAssertEqual(Set(p.customVoices.map(\.id)).count, CustomVoice.maxCount, "ids are unique")
    }

    func testMixesPersistAndOlderSettingsHaveNone() throws {
        var p = VoicePreferences()
        let mix = try p.saveCustomVoice(id: nil, name: "Duo", a: "bf_emma", b: "bm_george", percent: 30)
        p.setVoice(mix.id, forNovel: "src:n")
        let back = try JSONDecoder().decode(VoicePreferences.self, from: JSONEncoder().encode(p))
        XCTAssertEqual(back, p)
        XCTAssertEqual(back.voice(forNovel: "src:n"), "bf_emma+bm_george@30")
        let old = try JSONDecoder().decode(VoicePreferences.self, from: Data(#"{"defaultVoice":"bm_george"}"#.utf8))
        XCTAssertTrue(old.customVoices.isEmpty)
        // A broken mix (e.g. a voice that no longer exists) is not a choice; novels using it fall back.
        let broken = try JSONDecoder().decode(VoicePreferences.self, from: Data(
            #"{"defaultVoice":"mix_dead0000","novelVoices":{"src:x":"mix_dead0000"},"customVoices":[{"id":"mix_dead0000","name":"Gone","a":"af_gone","b":"bf_emma","percent":40}]}"#.utf8))
        XCTAssertFalse(broken.isChoice("mix_dead0000"))
        XCTAssertEqual(broken.voice(forNovel: "src:x"), VoiceCatalog.defaultVoiceId)
    }

    func testBaseVoiceForTheAppleFallback() {
        XCTAssertEqual(VoiceCatalog.baseVoice("bm_george")?.id, "bm_george")
        XCTAssertEqual(VoiceCatalog.baseVoice("af_heart+bm_george@80")?.id, "bm_george", "the voice heard most")
        XCTAssertNil(VoiceCatalog.baseVoice("mix_00000000"), "mix ids resolve through VoicePreferences first")
        XCTAssertNil(VoiceCatalog.baseVoice(nil))
    }

    func testPhonemeChunksFitAndBreakAtPunctuation() {
        XCTAssertEqual(PhonemeJoiner.chunks("  hˈɛlO.  "), ["hˈɛlO."])
        XCTAssertEqual(PhonemeJoiner.chunks("   "), [])
        // Two sentences of 300 scalars each: cut after the first full stop.
        let s1 = String(repeating: "a", count: 150) + " " + String(repeating: "b", count: 148) + "."
        let s2 = String(repeating: "c", count: 299) + "!"
        let pieces = PhonemeJoiner.chunks(s1 + " " + s2)
        XCTAssertEqual(pieces, [s1, s2])
        // No punctuation: cut at the last space before the limit.
        let words = Array(repeating: "wɜːd", count: 200).joined(separator: " ")
        let wp = PhonemeJoiner.chunks(words, limit: 100)
        XCTAssertTrue(wp.allSatisfy { $0.unicodeScalars.count <= 100 && !$0.hasPrefix(" ") && !$0.hasSuffix(" ") })
        XCTAssertEqual(wp.joined(separator: " "), words, "nothing lost")
        // One endless "word": hard cuts at the limit.
        let blob = String(repeating: "x", count: 1200)
        XCTAssertEqual(PhonemeJoiner.chunks(blob).map { $0.unicodeScalars.count }, [510, 510, 180])
        // A comma when there is no stronger break; never a tiny first piece.
        let early = "ab. " + String(repeating: "d", count: 300) + ", " + String(repeating: "e", count: 300)
        let ep = PhonemeJoiner.chunks(early)
        XCTAssertEqual(ep.first?.last, ",", "the full stop 3 scalars in is too early to cut at")
        // Combining marks count as their own scalars (Kokoro counts scalars).
        let nasal = String(repeating: "ɑ̃", count: 300)
        XCTAssertTrue(PhonemeJoiner.chunks(nasal).allSatisfy { $0.unicodeScalars.count <= 510 })
    }
}
