import XCTest
@testable import HDVoiceCore

/// "Download with audio" part 1 (NarrationAudio.swift): voice keys and the stale rule, the index and its migration from
/// the drive folder, list requests, the resumable render's checkpoint, when rendering may run, and the estimates.
final class NarrationVoiceKeyTests: XCTestCase {
    private func key(_ chain: String = "c1", lexicon: String = "l1", studio: Bool = true, dialogue: String = "none") -> NarrationVoiceKey {
        NarrationVoiceKey(family: .nephis, narrator: "abc|2026-10-15", dialogue: dialogue, studio: studio, chain: chain, lexicon: lexicon)
    }

    func testTheKeyNamesEveryPartOfTheVoice() {
        let k = key()
        XCTAssertEqual(k.text, "nephis|r\(NarrationVoiceKey.rendererVersion)|n:abc|2026-10-15|d:none|s:1|c:c1|l:l1")
        for other in [key("c2"), key(lexicon: "l2"), key(studio: false), key(dialogue: "dlg")] {
            XCTAssertNotEqual(other.text, k.text)
        }
        var newer = k
        newer.renderer += 1
        XCTAssertNotEqual(newer.text, k.text)
    }

    func testOnlyTheCurrentVoicePlays() {
        let now = key()
        XCTAssertEqual(NarrationAudioFreshness.of(stored: now.text, current: now), .fresh)
        // Her audio from an older pack, chain, lexicon or renderer: stale (deleted and rendered again).
        XCTAssertEqual(NarrationAudioFreshness.of(stored: key("old").text, current: now), .stale)
        // The drive folder's keys from older builds are hers too.
        XCTAssertEqual(NarrationAudioFreshness.of(stored: "nephis|0123456789ab|2026-10-01|studio", current: now), .stale)
        // Another voice's audio is neither played nor deleted.
        XCTAssertEqual(NarrationAudioFreshness.of(stored: "af_heart|narrator", current: now), .other)
        let kokoro = NarrationVoiceKey(family: .kokoro, narrator: "af_heart", chain: "x", lexicon: "l1")
        XCTAssertEqual(NarrationAudioFreshness.of(stored: now.text, current: kokoro), .other)
        // The current voice not known yet (her pack loading, the lexicon not asked): kept, not played.
        XCTAssertEqual(NarrationAudioFreshness.of(stored: now.text, current: nil), .other)
    }

    func testHashesIgnoreKeyOrder() {
        XCTAssertEqual(NarrationAudioHash.json(["b": 1, "a": [1, 2]] as [String: Any]), NarrationAudioHash.json(["a": [1, 2], "b": 1] as [String: Any]))
        XCTAssertNotEqual(NarrationAudioHash.json(["a": 1]), NarrationAudioHash.json(["a": 2]))
        XCTAssertEqual(NarrationAudioHash.json(nil), "none")
        XCTAssertEqual(NarrationAudioHash.fnv("x"), NarrationAudioHash.fnv("x"))
        XCTAssertNotEqual(NarrationAudioHash.fnv("x"), NarrationAudioHash.fnv("y"))
    }
}

final class NarrationAudioIndexTests: XCTestCase {
    private func entry(_ novel: String, _ chapter: String, kind: NarrationAudioKind = .download, bytes: Int = 10, at: Double = 0,
                       voice: String = "nephis|r1|x") -> NarrationAudioEntry {
        NarrationAudioEntry(novelKey: novel, chapterPath: chapter, title: chapter, kind: kind, voice: voice, audioFile: "\(chapter).m4a",
                            manifestFile: "\(chapter).json", bytes: bytes, durationMs: 1000, sentences: 3, createdAt: at)
    }

    func testOnlyDriveAudioIsCapped() {
        var idx = NarrationAudioIndex()
        idx.upsert(entry("a:n", "d1", kind: .drive, bytes: 400, at: 1))
        idx.upsert(entry("a:n", "x1", kind: .download, bytes: 900, at: 0))
        idx.upsert(entry("a:n", "d2", kind: .drive, bytes: 400, at: 2))
        let removed = idx.trimDrive(toBytes: 500)
        XCTAssertEqual(removed.map(\.chapterPath), ["d1"])
        XCTAssertNotNil(idx.find(novelKey: "a:n", chapterPath: "x1"), "a download is never trimmed")
        XCTAssertEqual(idx.trimDrive(toBytes: 500, keep: [NarrationAudioIndex.id(novelKey: "a:n", chapterPath: "d2")]).count, 0)
    }

    func testADriveRequestNeverTurnsADownloadIntoDriveAudio() {
        var idx = NarrationAudioIndex()
        idx.upsert(entry("a:n", "c1", kind: .download))
        let old = idx.upsert(entry("a:n", "c1", kind: .drive, voice: "nephis|r1|y"))
        XCTAssertEqual(old?.voice, "nephis|r1|x")
        XCTAssertEqual(idx.find(novelKey: "a:n", chapterPath: "c1")?.kind, .download)
        XCTAssertEqual(idx.find(novelKey: "a:n", chapterPath: "c1")?.voice, "nephis|r1|y")
    }

    func testRemovingByNovelAndKind() {
        var idx = NarrationAudioIndex()
        idx.upsert(entry("a:n", "c1", kind: .download))
        idx.upsert(entry("a:n", "c2", kind: .drive))
        idx.upsert(entry("b:m", "c1"))
        XCTAssertEqual(idx.removeNovel("a:n", kind: .drive).map(\.chapterPath), ["c2"])
        XCTAssertEqual(idx.entries(novelKey: "a:n").count, 1)
        XCTAssertEqual(idx.removeAll().count, 2)
        XCTAssertEqual(idx.totalBytes, 0)
    }

    func testStaleEntriesAreThoseOfAnOlderVersionOfTheCurrentVoice() {
        var idx = NarrationAudioIndex()
        let current = NarrationVoiceKey(family: .nephis, narrator: "p", chain: "c", lexicon: "l")
        idx.upsert(entry("a:n", "fresh", voice: current.text))
        idx.upsert(entry("a:n", "old", voice: "nephis|r0|n:p"))
        idx.upsert(entry("a:n", "kokoro", voice: "af_heart"))
        idx.upsert(entry("b:m", "unknown", voice: "nephis|r0|n:p"))
        let stale = idx.stale { $0 == "a:n" ? current : nil }
        XCTAssertEqual(stale.map(\.chapterPath), ["old"])
    }

    func testTheDriveFolderMigratesAsDriveAudio() throws {
        var old = DriveCacheIndex()
        old.upsert(PreparedChapter(novelKey: "src:novel", chapterPath: "ch/1", title: "One", voice: "nephis|abc|made|studio",
                                   audioFile: "123-4.m4a", manifestFile: "123-4.json", bytes: 5_000, durationMs: 60_000, sentences: 40, createdAt: 7))
        let (idx, moves) = NarrationAudioIndex.migrate(old)
        let e = try XCTUnwrap(idx.find(novelKey: "src:novel", chapterPath: "ch/1"))
        XCTAssertEqual(e.kind, .drive)
        XCTAssertEqual(e.voice, "nephis|abc|made|studio")
        XCTAssertEqual(e.source.pluginId, "src")
        XCTAssertEqual(e.source.novelPath, "novel")
        XCTAssertEqual(e.bytes, 5_000)
        XCTAssertEqual(e.audioFile, "\(NarrationAudioIndex.folder(novelKey: "src:novel"))/\(NarrationAudioIndex.stem(chapterPath: "ch/1")).m4a")
        XCTAssertEqual(moves.map { $0.from }, ["123-4.m4a", "123-4.json"])
        XCTAssertEqual(moves.map { $0.to }, [e.audioFile, e.manifestFile])
        // Names are safe file names (no "/" from chapter paths), and the index round-trips.
        XCTAssertFalse(NarrationAudioIndex.stem(chapterPath: "ch/1").contains("/"))
        let data = try JSONEncoder().encode(idx)
        XCTAssertEqual(try JSONDecoder().decode(NarrationAudioIndex.self, from: data), idx)
        XCTAssertEqual(idx.schemaVersion, 2)
    }
}

final class AudioJobTests: XCTestCase {
    func testAListRequestRendersItsChaptersInOrder() {
        var job = DriveJob(pluginId: "s", novelPath: "n", novelName: "N", coverUrl: nil, chapters: ["c1", "c2", "c1", ""], kind: .download,
                           when: .charging, voice: "v", createdAt: 0)
        XCTAssertEqual(job.list, ["c1", "c2"])
        XCTAssertEqual(job.count, 2)
        XCTAssertEqual(job.cursor, "c1")
        XCTAssertEqual(job.key, "s:n\u{1F}download")
        job.completed("c1", title: "One", next: "c9")
        XCTAssertEqual(job.cursor, "c2", "a list goes on with its own next chapter, not the novel's")
        job.completed("c2", title: "Two", next: nil)
        XCTAssertTrue(job.finished)
        job.add(["c3"])
        XCTAssertFalse(job.finished)
        XCTAssertEqual(job.cursor, "c3")
        job.skipped("c3")
        XCTAssertTrue(job.finished)
        XCTAssertEqual(job.remaining, 0)
        // A chapter whose audio was made with an older voice is rendered again.
        job.redo(["c1"])
        XCTAssertFalse(job.finished)
        XCTAssertEqual(job.cursor, "c1")
        XCTAssertEqual(job.done, ["c2"])
        XCTAssertEqual(job.titles, ["Two"])
    }

    func testOlderSavedRequestsStillLoad() throws {
        let old = #"{"pluginId":"s","novelPath":"n","novelName":"N","count":3,"when":"now","voice":"v","createdAt":1,"done":[],"titles":[],"failures":0,"finished":false}"#
        let job = try JSONDecoder().decode(DriveJob.self, from: Data(old.utf8))
        XCTAssertEqual(job.audioKind, .drive)
        XCTAssertNil(job.list)
        XCTAssertFalse(job.isPaused)
    }

    func testWhileChargingWaitsForCharging() {
        let c = DriveConditions(charging: false, wifi: true, lowPower: false, thermalThrottled: false, liveNarration: false)
        XCTAssertEqual(DrivePrepPolicy.gate(.charging, c).reason, "Waiting for charging")
    }
}

final class RenderCheckpointTests: XCTestCase {
    private func call(_ first: Int, _ count: Int, ends: Bool) -> RenderCheckpoint.Call {
        RenderCheckpoint.Call(first: first, count: count, frames: Array(repeating: 100, count: count), endsParagraph: ends, file: "call-\(first).pcm")
    }

    func testAnInterruptedRenderGoesOnFromItsLastParagraph() {
        var cp = RenderCheckpoint(novelKey: "a:n", chapterPath: "c", voice: "v", textHash: "t", sampleRate: 100, sentences: 10)
        cp.calls = [call(0, 1, ends: false), call(1, 2, ends: true), call(3, 2, ends: false), call(5, 1, ends: false)]
        XCTAssertEqual(cp.next, 6)
        let dropped = cp.rollBackToParagraph()
        XCTAssertEqual(dropped.map(\.first), [3, 5])
        XCTAssertEqual(cp.next, 3, "a fresh read at the paragraph's start")
        XCTAssertFalse(cp.done)
        // Nothing ended a paragraph yet: from the start.
        var early = RenderCheckpoint(novelKey: "a:n", chapterPath: "c", voice: "v", textHash: "t", sampleRate: 100, sentences: 10)
        early.calls = [call(0, 1, ends: false)]
        XCTAssertEqual(early.rollBackToParagraph().count, 1)
        XCTAssertEqual(early.next, 0)
    }

    func testTimesComeFromTheRealCuts() {
        var cp = RenderCheckpoint(novelKey: "a:n", chapterPath: "c", voice: "v", textHash: "t", sampleRate: 100, sentences: 3)
        cp.calls = [RenderCheckpoint.Call(first: 0, count: 2, frames: [150, 50], endsParagraph: true, file: "a"),
                    RenderCheckpoint.Call(first: 2, count: 1, frames: [300], endsParagraph: true, file: "b")]
        let t = cp.times()
        XCTAssertEqual(t.map { $0.t0 }, [0, 1.5, 2])
        XCTAssertEqual(t.map { $0.t1 }, [1.5, 2, 5])
        XCTAssertEqual(cp.seconds, 5)
        XCTAssertTrue(cp.done)
    }

    func testACheckpointOnlyFitsTheSameVoiceAndText() throws {
        let cp = RenderCheckpoint(novelKey: "a:n", chapterPath: "c", voice: "v", textHash: "t", sampleRate: 44_100, sentences: 10)
        XCTAssertTrue(cp.matches(voice: "v", textHash: "t", sampleRate: 44_100, sentences: 10))
        XCTAssertFalse(cp.matches(voice: "v2", textHash: "t", sampleRate: 44_100, sentences: 10))
        XCTAssertFalse(cp.matches(voice: "v", textHash: "t2", sampleRate: 44_100, sentences: 10))
        XCTAssertFalse(cp.matches(voice: "v", textHash: "t", sampleRate: 24_000, sentences: 10))
        let data = try JSONEncoder().encode(cp)
        XCTAssertEqual(try JSONDecoder().decode(RenderCheckpoint.self, from: data), cp)
    }
}

final class AudioRenderPolicyTests: XCTestCase {
    private func c(charging: Bool = true, wifi: Bool = true, online: Bool = true, lowPower: Bool = false, live: Bool = false,
                   sinceLive: Double? = nil, handoff: Bool = false, blocked: String? = nil) -> AudioRenderConditions {
        AudioRenderConditions(charging: charging, wifi: wifi, online: online, lowPower: lowPower, live: live, sinceLive: sinceLive,
                              handoff: handoff, voiceBlocked: blocked)
    }

    func testLiveReadingAlwaysWinsAndThirtySecondsAfter() {
        XCTAssertEqual(AudioRenderPolicy.gate(.now, c(live: true), heatOK: true, needsText: false).reason, "Paused while you listen")
        XCTAssertNotNil(AudioRenderPolicy.gate(.now, c(sinceLive: 10), heatOK: true, needsText: false).reason)
        XCTAssertEqual(AudioRenderPolicy.gate(.now, c(sinceLive: 31), heatOK: true, needsText: false), .run)
        XCTAssertNotNil(AudioRenderPolicy.gate(.now, c(handoff: true), heatOK: true, needsText: false).reason)
    }

    func testChargingLowPowerAndTheNetwork() {
        XCTAssertEqual(AudioRenderPolicy.gate(.charging, c(charging: false), heatOK: true, needsText: false).reason, "Waiting for charging")
        XCTAssertEqual(AudioRenderPolicy.gate(.now, c(charging: false, lowPower: true), heatOK: true, needsText: false).reason,
                       "Waiting: Low Power Mode is on")
        XCTAssertEqual(AudioRenderPolicy.gate(.now, c(charging: true, lowPower: true), heatOK: true, needsText: false), .run)
        // The network only matters when the chapter's text isn't saved yet.
        XCTAssertEqual(AudioRenderPolicy.gate(.now, c(online: false), heatOK: true, needsText: false), .run)
        XCTAssertEqual(AudioRenderPolicy.gate(.now, c(online: false), heatOK: true, needsText: true).reason, "Waiting for the internet")
        XCTAssertNotNil(AudioRenderPolicy.gate(.now, c(), heatOK: false, needsText: false).reason)
        XCTAssertEqual(AudioRenderPolicy.gate(.now, c(blocked: "Her voice is resting"), heatOK: true, needsText: false).reason, "Her voice is resting")
    }

    func testSeriousHeatPausesUntilTwoMinutesCool() {
        var g = HeatGate()
        XCTAssertTrue(g.update(thermal: 1, now: 0))
        XCTAssertFalse(g.update(thermal: 2, now: 10))
        XCTAssertFalse(g.update(thermal: 1, now: 20))
        XCTAssertEqual(g.remaining(now: 80) ?? -1, 60, accuracy: 1e-9)
        XCTAssertFalse(g.update(thermal: 0, now: 100))
        // Hot again: the two minutes start over.
        XCTAssertFalse(g.update(thermal: 3, now: 130))
        XCTAssertFalse(g.update(thermal: 1, now: 140))
        XCTAssertFalse(g.update(thermal: 1, now: 259))
        XCTAssertTrue(g.update(thermal: 1, now: 260))
        XCTAssertFalse(g.paused)
    }
}

final class NarrationAudioEstimateTests: XCTestCase {
    func testMegabytesMinutesAndRenderTime() {
        XCTAssertEqual(NarrationAudioEstimate.megabytesPerMinute(bitRate: 128_000), 0.96, accuracy: 1e-9)
        let e = NarrationAudioEstimate.estimate(chapters: 2, averageMinutes: 15, speedX: 2)
        XCTAssertEqual(e.minutes, 30, accuracy: 1e-9)
        XCTAssertEqual(e.megabytes, 28.8, accuracy: 1e-9)
        XCTAssertEqual(e.renderMinutes, 15, accuracy: 1e-9)
        let fromText = NarrationAudioEstimate.estimate(chapters: 1, characters: 14 * 600)
        XCTAssertEqual(fromText.minutes, 10, accuracy: 1e-9)
        XCTAssertEqual(fromText.renderMinutes, 10, accuracy: 1e-9, "unknown speed: real time")
        XCTAssertEqual(NarrationAudioEstimate.estimate(chapters: 1, bitRate: 32_000).megabytes, 12 * 0.24, accuracy: 1e-9)
        XCTAssertEqual(NarrationAudioEstimate.blend(nil, 3), 3)
        XCTAssertEqual(NarrationAudioEstimate.blend(2, 4, weight: 0.5), 3)
        XCTAssertEqual(NarrationAudioEstimate.blend(2, .nan), 2)
    }
}

final class NarrationManifestRenderTests: XCTestCase {
    func testTheManifestCarriesItsRateAndRenderRecord() throws {
        let timing = NarrationTiming(segments: [NarrationTiming.Segment(id: 0, block: 0, start: 0, end: 5, t0: 0, t1: 1, paragraph: 0),
                                                NarrationTiming.Segment(id: 1, block: 0, start: 6, end: 9, t0: 1, t1: 2, paragraph: 0),
                                                NarrationTiming.Segment(id: 2, block: 1, start: 0, end: 9, t0: 2, t1: 3, paragraph: 1)],
                                     duration: 3)
        let src = NarrationTiming.Source(pluginId: "s", novelPath: "n", chapterPath: "c", title: "C", voice: "nephis|r1", audioFile: "c.m4a")
        let data = timing.manifestJSON(source: src, sampleRate: 44_100, engine: ("nephis", "Pocket TTS + studio"),
                                       render: ["voiceKey": "nephis|r1", "delivery": ["moods": ["0": "calm"]]])
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual((obj["audio"] as? [String: Any])?["sampleRate"] as? Int, 44_100)
        XCTAssertEqual((obj["engine"] as? [String: Any])?["name"] as? String, "nephis")
        XCTAssertEqual((obj["render"] as? [String: Any])?["voiceKey"] as? String, "nephis|r1")
        let back = try XCTUnwrap(NarrationTiming(json: String(decoding: data, as: UTF8.self)))
        XCTAssertEqual(back.time(forParagraph: 0, sentence: 1), 1)
        XCTAssertEqual(back.time(forParagraph: 0, sentence: 5), 0, "past its last sentence: the paragraph's start")
        XCTAssertEqual(back.time(forParagraph: 1, sentence: 0), 2)
        XCTAssertNil(back.time(forParagraph: 4, sentence: 0))
    }
}
