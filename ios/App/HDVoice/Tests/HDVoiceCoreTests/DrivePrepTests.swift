import XCTest
@testable import HDVoiceCore

final class DrivePrepPolicyTests: XCTestCase {
    private func cond(charging: Bool = false, wifi: Bool = false, lowPower: Bool = false, hot: Bool = false, live: Bool = false) -> DriveConditions {
        DriveConditions(charging: charging, wifi: wifi, lowPower: lowPower, thermalThrottled: hot, liveNarration: live)
    }

    func testOnDemandRunsAnywhere() {
        XCTAssertEqual(DrivePrepPolicy.gate(.now, cond()), .run)
        XCTAssertEqual(DrivePrepPolicy.gate(.now, cond(lowPower: true)), .run)
    }

    func testChargingOrWifi() {
        XCTAssertEqual(DrivePrepPolicy.gate(.chargingOrWifi, cond()).reason, "Waiting for charging or Wi-Fi")
        XCTAssertEqual(DrivePrepPolicy.gate(.chargingOrWifi, cond(charging: true)), .run)
        XCTAssertEqual(DrivePrepPolicy.gate(.chargingOrWifi, cond(wifi: true)), .run)
        XCTAssertNotNil(DrivePrepPolicy.gate(.chargingOrWifi, cond(wifi: true, lowPower: true)).reason, "Low Power Mode on battery waits")
        XCTAssertEqual(DrivePrepPolicy.gate(.chargingOrWifi, cond(charging: true, lowPower: true)), .run)
    }

    func testLiveNarrationAndHeatAlwaysWait() {
        XCTAssertNotNil(DrivePrepPolicy.gate(.now, cond(live: true)).reason)
        XCTAssertNotNil(DrivePrepPolicy.gate(.now, cond(hot: true)).reason)
        XCTAssertNotNil(DrivePrepPolicy.gate(.chargingOrWifi, cond(charging: true, hot: true)).reason)
    }
}

final class DriveCacheIndexTests: XCTestCase {
    private func entry(_ novel: String, _ chapter: String, bytes: Int, at: Double, voice: String = "af_heart") -> PreparedChapter {
        PreparedChapter(novelKey: novel, chapterPath: chapter, title: chapter, voice: voice, audioFile: "\(chapter).m4a",
                        manifestFile: "\(chapter).json", bytes: bytes, durationMs: 60_000, sentences: 10, createdAt: at)
    }

    func testFindUpsertAndVoiceMatch() {
        var idx = DriveCacheIndex()
        XCTAssertNil(idx.upsert(entry("a:n", "c1", bytes: 100, at: 1)))
        XCTAssertNotNil(idx.find(novelKey: "a:n", chapterPath: "c1"))
        XCTAssertNotNil(idx.find(novelKey: "a:n", chapterPath: "c1", voice: "af_heart"))
        XCTAssertNil(idx.find(novelKey: "a:n", chapterPath: "c1", voice: "bm_george"), "another voice: not usable")
        let old = idx.upsert(entry("a:n", "c1", bytes: 300, at: 2, voice: "bm_george"))
        XCTAssertEqual(old?.bytes, 100, "the replaced entry comes back so its files can be deleted")
        XCTAssertEqual(idx.chapters.count, 1)
        XCTAssertEqual(idx.totalBytes, 300)
    }

    func testPerNovelUsageAndRemoval() {
        var idx = DriveCacheIndex()
        idx.upsert(entry("a:n", "c1", bytes: 100, at: 1))
        idx.upsert(entry("a:n", "c2", bytes: 200, at: 2))
        idx.upsert(entry("b:m", "c1", bytes: 50, at: 3))
        XCTAssertEqual(idx.bytes(novelKey: "a:n"), 300)
        XCTAssertEqual(idx.chapters(novelKey: "b:m").count, 1)
        XCTAssertEqual(idx.remove(novelKey: "a:n", chapterPath: "c1").count, 1, "evicted after listening")
        XCTAssertEqual(idx.removeNovel("a:n").map(\.chapterPath), ["c2"])
        XCTAssertEqual(idx.totalBytes, 50)
        XCTAssertEqual(idx.removeAll().count, 1)
        XCTAssertTrue(idx.chapters.isEmpty)
    }

    func testTrimDropsOldestButNeverTheRequestInProgress() {
        var idx = DriveCacheIndex()
        idx.upsert(entry("a:n", "c1", bytes: 100, at: 1))
        idx.upsert(entry("a:n", "c2", bytes: 100, at: 2))
        idx.upsert(entry("b:m", "c1", bytes: 100, at: 3))
        let keep: Set = [DriveCacheIndex.id(novelKey: "a:n", chapterPath: "c1")]
        let removed = idx.trim(toBytes: 150, keep: keep)
        XCTAssertEqual(removed.map(\.id), [DriveCacheIndex.id(novelKey: "a:n", chapterPath: "c2"), DriveCacheIndex.id(novelKey: "b:m", chapterPath: "c1")])
        XCTAssertEqual(idx.totalBytes, 100)
        XCTAssertTrue(idx.trim(toBytes: 1000).isEmpty)
    }

    func testIndexRoundTripsThroughJSON() throws {
        var idx = DriveCacheIndex()
        idx.upsert(entry("a:n", "c1", bytes: 100, at: 1))
        let data = try JSONEncoder().encode(idx)
        XCTAssertEqual(try JSONDecoder().decode(DriveCacheIndex.self, from: data), idx)
    }
}

final class DriveJobTests: XCTestCase {
    func testWalksChaptersUntilTheCountOrTheEnd() {
        var job = DriveJob(pluginId: "src", novelPath: "n", novelName: "Novel", coverUrl: nil, count: 3, when: .now, voice: "af_heart", createdAt: 0)
        XCTAssertEqual(job.novelKey, "src:n")
        XCTAssertEqual(job.remaining, 3)
        job.completed("c1", title: "One", next: "c2")
        job.completed("c1", title: "One", next: "c2")
        XCTAssertEqual(job.done, ["c1"], "idempotent")
        XCTAssertEqual(job.cursor, "c2")
        job.completed("c2", title: "Two", next: "c3")
        job.completed("c3", title: "Three", next: "c4")
        XCTAssertTrue(job.finished)
        XCTAssertEqual(job.remaining, 0)

        var short = DriveJob(pluginId: "src", novelPath: "n", novelName: "Novel", coverUrl: nil, count: 10, when: .now, voice: "af_heart", createdAt: 0)
        short.completed("c9", title: "Last", next: nil)
        XCTAssertTrue(short.finished, "no next chapter (or a locked one) ends the request")
    }

    func testFailuresStopAfterThreeInARow() {
        var job = DriveJob(pluginId: "s", novelPath: "n", novelName: "N", coverUrl: nil, count: 99, when: .chargingOrWifi, voice: "af_heart", createdAt: 0)
        XCTAssertEqual(job.count, 50, "clamped")
        job.failed("offline")
        job.failed("offline")
        XCTAssertFalse(job.finished)
        job.completed("c1", title: "One", next: "c2")
        XCTAssertEqual(job.failures, 0, "a success resets the count")
        for _ in 0..<DriveJob.maxFailures { job.failed("offline") }
        XCTAssertTrue(job.finished)
        XCTAssertEqual(job.lastError, "offline")
    }
}

final class NarrationManifestTests: XCTestCase {
    func testWrittenManifestReadsBack() throws {
        let segs = [
            NarrationTiming.Segment(id: 0, block: 0, start: 0, end: 12, t0: 0, t1: 1.5, hash: 77, paragraph: 0),
            NarrationTiming.Segment(id: 1, block: 2, start: 0, end: 30, t0: 1.5, t1: 4.25, hash: 99, paragraph: 1),
        ]
        let timing = NarrationTiming(segments: segs, duration: 4.25, nextChapterPath: "c2", nextTitle: "Two", prevChapterPath: "c0", prevTitle: "Zero")
        let src = NarrationTiming.Source(pluginId: "src", novelPath: "n", chapterPath: "c1", title: "One", voice: "af_heart", audioFile: "a.m4a")
        let json = String(data: timing.manifestJSON(source: src), encoding: .utf8) ?? ""
        let back = try XCTUnwrap(NarrationTiming(json: json))
        XCTAssertEqual(back.segments, segs)
        XCTAssertEqual(back.duration, 4.25, accuracy: 0.001)
        XCTAssertEqual(back.nextChapterPath, "c2")
        XCTAssertEqual(back.nextTitle, "Two")
        XCTAssertEqual(back.prevChapterPath, "c0")
        XCTAssertEqual(back.prevTitle, "Zero")
        XCTAssertEqual(back.segmentIndex(at: 2), 1)
        XCTAssertNil(back.segmentIndex(at: -1))
        XCTAssertEqual(back.time(forParagraph: 1), 1.5)
        XCTAssertEqual(back.time(forBlock: 1), 1.5)
    }

    func testPCManifestWithoutV2FieldsStillParses() {
        let json = #"{"kind":"tachinovel.narration","audio":{"offsetMs":1000,"durationMs":5000},"chapter":{},"segments":[[3,1,0,9,1000,2000]]}"#
        let t = NarrationTiming(json: json)
        XCTAssertEqual(t?.offset, 1)
        XCTAssertEqual(t?.segments.first?.hash, nil)
        XCTAssertEqual(t?.segments.first?.paragraph, nil)
        XCTAssertEqual(t?.time(forParagraph: 1), 1, "falls back to the block")
        XCTAssertNil(NarrationTiming(json: #"{"kind":"other"}"#))
    }
}
