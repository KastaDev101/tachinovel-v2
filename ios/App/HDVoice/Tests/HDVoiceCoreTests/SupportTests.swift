import XCTest
@testable import HDVoiceCore

final class PCMTests: XCTestCase {
    func testTrimKeepsMarginsAndDropsSilence() {
        let sr = 1000
        let samples: [Float] = Array(repeating: 0, count: 300) + Array(repeating: 0.5, count: 100) + Array(repeating: 0, count: 300)
        let out = PCM.trimSilence(samples, sampleRate: sr, keepLead: 0.02, keepTail: 0.04)
        XCTAssertEqual(out.count, 20 + 100 + 40)
        XCTAssertEqual(out[20], 0.5)
        XCTAssertEqual(PCM.trimSilence(Array(repeating: 0, count: 50), sampleRate: sr), [])
    }

    func testFadesStartAndEndAtZero() {
        var s: [Float] = Array(repeating: 1, count: 100)
        PCM.applyFades(&s, sampleRate: 1000, fadeIn: 0.01, fadeOut: 0.01)
        XCTAssertEqual(s.first, 0)
        XCTAssertEqual(s.last, 0)
        XCTAssertEqual(s[50], 1)
    }

    func testPrepareSentenceAppendsPauseAndNeverClips() {
        var loud = LoudnessMatcher(target: 0.1)
        let tone: [Float] = (0..<2400).map { Float(sin(Double($0) * 0.05)) * 0.02 }
        let out = PCM.prepareSentence(tone, sampleRate: 24000, pause: 0.5, loudness: &loud)
        XCTAssertEqual(out.count, tone.count + 12000, "trimmed nothing (no silence), + 0.5 s pause")
        XCTAssertLessThanOrEqual(PCM.peak(out), 0.97)
        XCTAssertGreaterThan(PCM.rms(Array(out.prefix(2400))), PCM.rms(tone), "quiet speech is brought up")
        XCTAssertTrue(out.suffix(12000).allSatisfy { $0 == 0 })
    }

    func testLoudnessIsSlowAndClamped() {
        var m = LoudnessMatcher(target: 0.1, minGain: 0.5, maxGain: 4, smoothing: 0.2)
        let quiet: [Float] = Array(repeating: 0.01, count: 100)
        XCTAssertEqual(m.gain(for: quiet), 4, "clamped to maxGain")
        let normal: [Float] = Array(repeating: 0.1, count: 100)
        let g = m.gain(for: normal)
        XCTAssertGreaterThan(g, 1, "running RMS moves slowly toward the new level")
        XCTAssertEqual(m.gain(for: Array(repeating: 0, count: 10)), 1, "silence untouched")
        var hot = LoudnessMatcher(target: 0.5)
        XCTAssertLessThanOrEqual(hot.gain(for: [0.9, -0.9]) * 0.9, 0.9701, "peak limited")
    }

    func testSilenceFrames() {
        XCTAssertEqual(PCM.silenceFrames(seconds: 0.32, sampleRate: 24000), 7680)
        XCTAssertEqual(PCM.silenceFrames(seconds: -1, sampleRate: 24000), 0)
        XCTAssertEqual(PCM.silenceFrames(seconds: .nan, sampleRate: 24000), 0)
    }
}

final class VoicePreferencesTests: XCTestCase {
    func testPerNovelVoiceWithGlobalDefault() {
        var p = VoicePreferences()
        XCTAssertEqual(p.voice(forNovel: "src:novel"), "af_heart")
        p.defaultVoice = "bm_george"
        XCTAssertEqual(p.voice(forNovel: "src:novel"), "bm_george")
        p.setVoice("af_bella", forNovel: "src:novel")
        XCTAssertEqual(p.voice(forNovel: "src:novel"), "af_bella")
        XCTAssertEqual(p.voice(forNovel: "src:other"), "bm_george")
        p.setVoice("bm_george", forNovel: "src:novel")
        XCTAssertNil(p.novelVoices["src:novel"], "choosing the default clears the override")
        p.novelVoices["src:x"] = "zz_gone"
        XCTAssertEqual(p.voice(forNovel: "src:x"), "bm_george", "unknown voice ids fall back")
        p.defaultVoice = "nope"
        XCTAssertEqual(p.voice(forNovel: nil), "af_heart")
    }

    func testDefaultsAndTolerantDecoding() throws {
        let p = try JSONDecoder().decode(VoicePreferences.self, from: Data(#"{"defaultVoice":"bf_emma"}"#.utf8))
        XCTAssertEqual(p.defaultVoice, "bf_emma")
        XCTAssertTrue(p.kokoroEnabled)
        XCTAssertFalse(p.usePCAudio, "PC audio is an advanced, opt-in setting")
        XCTAssertEqual(KokoroRoute.from(p.route), .backgroundSafe)
        XCTAssertEqual(p.clampedAhead, 3)
        let round = try JSONDecoder().decode(VoicePreferences.self, from: try JSONEncoder().encode(p))
        XCTAssertEqual(round, p)
    }

    func testCatalogHasSixVoicesAndTheDefault() {
        XCTAssertEqual(VoiceCatalog.voices.count, 6)
        XCTAssertNotNil(VoiceCatalog.voice(VoiceCatalog.defaultVoiceId))
        XCTAssertEqual(Set(VoiceCatalog.ids).count, 6)
        XCTAssertFalse(KokoroRoute.backgroundSafe.usesGPU)
    }
}

final class AppleVoiceRankingTests: XCTestCase {
    private func v(_ id: String, _ lang: String, _ q: AppleVoiceCandidate.Quality, _ g: AppleVoiceCandidate.Gender, novelty: Bool = false, personal: Bool = false) -> AppleVoiceCandidate {
        AppleVoiceCandidate(identifier: id, name: id, language: lang, quality: q, gender: g, isNovelty: novelty, isPersonal: personal)
    }

    func testQualityFirstThenGenderThenAccent() {
        let all = [
            v("samantha", "en-US", .standard, .female),
            v("ava-premium", "en-US", .premium, .female),
            v("zoe-enhanced", "en-US", .enhanced, .female),
            v("daniel-premium", "en-GB", .premium, .male),
            v("bells", "en-US", .premium, .unspecified, novelty: true),
            v("me", "en-US", .premium, .female, personal: true),
            v("thomas", "fr-FR", .premium, .male),
        ]
        let heart = VoiceCatalog.voice("af_heart")
        XCTAssertEqual(AppleVoiceRanking.pick(all, for: heart)?.voice.identifier, "ava-premium")
        XCTAssertEqual(AppleVoiceRanking.pick(all, for: VoiceCatalog.voice("bm_george"))?.voice.identifier, "daniel-premium")
        XCTAssertEqual(AppleVoiceRanking.pick(all, for: heart)?.onlyStandardInstalled, false)
    }

    func testOnlyDefaultVoicesShowTheHint() {
        let pick = AppleVoiceRanking.pick([v("samantha", "en-US", .standard, .female), v("daniel", "en-GB", .standard, .male)], for: VoiceCatalog.voice("bm_george"))
        XCTAssertEqual(pick?.voice.identifier, "daniel")
        XCTAssertEqual(pick?.onlyStandardInstalled, true)
        XCTAssertNil(AppleVoiceRanking.pick([v("thomas", "fr-FR", .premium, .male)], for: nil))
    }
}

final class CrashSentinelTests: XCTestCase {
    private func tempDir() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("hdvoice-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func testCleanRunsAreNotCrashes() {
        let dir = tempDir()
        let s = CrashSentinel(directory: dir)
        s.begin("af_heart")
        s.end(success: true)
        XCTAssertFalse(CrashSentinel(directory: dir).checkAtLaunch())
    }

    func testTwoCrashesInARowDisableKokoroUntilReset() {
        let dir = tempDir()
        CrashSentinel(directory: dir).begin("af_heart ane-cpu 120 chars") // process "dies" here
        let second = CrashSentinel(directory: dir)
        XCTAssertTrue(second.checkAtLaunch())
        XCTAssertEqual(second.current.consecutive, 1)
        XCTAssertFalse(second.current.disabled)
        second.begin("af_heart ane-cpu 80 chars") // dies again
        let third = CrashSentinel(directory: dir)
        XCTAssertTrue(third.checkAtLaunch())
        XCTAssertEqual(third.current.consecutive, 2)
        XCTAssertTrue(third.current.disabled)
        XCTAssertEqual(third.current.lastContext, "af_heart ane-cpu 80 chars")
        third.reset()
        let fourth = CrashSentinel(directory: dir)
        XCTAssertFalse(fourth.current.disabled)
        XCTAssertEqual(fourth.current.total, 2)
    }

    func testASuccessBreaksTheStreak() {
        let dir = tempDir()
        CrashSentinel(directory: dir).begin("x")
        let s = CrashSentinel(directory: dir)
        XCTAssertTrue(s.checkAtLaunch())
        s.begin("y")
        s.end(success: true)
        XCTAssertEqual(CrashSentinel(directory: dir).current.consecutive, 0)
    }
}

final class PhonemeJoinerTests: XCTestCase {
    func testOverridesSpliceWithOriginalSpacing() {
        XCTAssertEqual(PhonemeJoiner.join([(.phonemes("nˈɛfɪs"), "nˈɛfɪs"), (.text(", wait!"), ", wˈAt!")]), "nˈɛfɪs, wˈAt!")
        XCTAssertEqual(PhonemeJoiner.join([(.text("I saw "), "ˈI sˈɔ"), (.phonemes("nˈɛfɪs"), "nˈɛfɪs"), (.text(" today."), "tədˈA.")]), "ˈI sˈɔ nˈɛfɪs tədˈA.")
        XCTAssertEqual(PhonemeJoiner.join([(.phonemes("nˈɛfɪs"), "nˈɛfɪs"), (.text("'s blade"), "z blˈAd")]), "nˈɛfɪsz blˈAd")
        XCTAssertEqual(PhonemeJoiner.join([(.text("  "), ""), (.phonemes("tˈɪsk"), "tˈɪsk")]), "tˈɪsk")
    }

    func testSilentRunsAndLimits() {
        XCTAssertTrue(PhonemeJoiner.isSilent(", … "))
        XCTAssertFalse(PhonemeJoiner.isSilent("a"))
        XCTAssertEqual(PhonemeJoiner.punctuationOnly(", … !"), ",…!")
        XCTAssertTrue(PhonemeJoiner.fits(String(repeating: "a", count: 510)))
        XCTAssertFalse(PhonemeJoiner.fits(String(repeating: "a", count: 511)))
    }
}

final class StatsAndPolicyTests: XCTestCase {
    func testRealtimeFactorsAndAggregates() {
        var s = SynthesisStats(keep: 2)
        s.record(SentenceStat(index: 0, characters: 50, synthMs: 200, audioMs: 4000, voice: "af_heart"))
        s.record(SentenceStat(index: 1, characters: 50, synthMs: 400, audioMs: 4000, voice: "af_heart"))
        s.record(SentenceStat(index: 2, characters: 50, synthMs: 100, audioMs: 2000, voice: "af_heart"))
        XCTAssertEqual(s.sentences.count, 2, "keeps the last N")
        XCTAssertEqual(s.totalSentences, 3)
        XCTAssertEqual(s.aggregateTimesRealtime, 10000.0 / 700.0, accuracy: 0.001)
        XCTAssertEqual(s.sentences.last?.rtf ?? 0, 0.05, accuracy: 0.0001)
        XCTAssertEqual(s.sentences.last?.timesRealtime ?? 0, 20, accuracy: 0.0001)
        XCTAssertNotNil(s.dictionary()["p50X"])
    }

    func testThermalAndBackoff() {
        XCTAssertFalse(ThermalPolicy.throttled(rawState: 1))
        XCTAssertTrue(ThermalPolicy.throttled(rawState: 2))
        XCTAssertTrue(ThermalPolicy.throttled(rawState: 3))
        var b = ReloadBackoff(base: 60, cap: 300)
        XCTAssertEqual(b.nextDelay(), 60)
        XCTAssertEqual(b.nextDelay(), 120)
        XCTAssertEqual(b.nextDelay(), 240)
        XCTAssertEqual(b.nextDelay(), 300)
        b.reset()
        XCTAssertEqual(b.nextDelay(), 60)
    }
}

final class WAVTests: XCTestCase {
    func testHeaderAndSamples() {
        let d = WAV.pcm16([0, 1, -1, .nan], sampleRate: 24000)
        XCTAssertEqual(d.count, 44 + 8)
        XCTAssertEqual(String(decoding: d.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: d[8..<12], as: UTF8.self), "WAVE")
        let rate = d[24..<28].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        XCTAssertEqual(UInt32(littleEndian: rate), 24000)
        let s1 = d[46..<48].withUnsafeBytes { $0.loadUnaligned(as: Int16.self) }
        XCTAssertEqual(Int16(littleEndian: s1), 32767)
        let s3 = d[50..<52].withUnsafeBytes { $0.loadUnaligned(as: Int16.self) }
        XCTAssertEqual(Int16(littleEndian: s3), 0, "NaN is written as silence")
    }
}
