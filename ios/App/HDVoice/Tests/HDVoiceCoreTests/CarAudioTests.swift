import XCTest
@testable import HDVoiceCore

final class RemoteCommandMapTests: XCTestCase {
    private let playing = RemoteContext(playing: true, elapsed: 30, hasPreviousChapter: true)

    func testCarButtonsChooseTrackOrSkipButtons() {
        let chapters = RemoteCommandMap.enabled(.chapters)
        XCTAssertTrue(chapters.nextTrack && chapters.previousTrack)
        XCTAssertFalse(chapters.skipForward || chapters.skipBackward, "skip buttons would take the side slots")
        let skip = RemoteCommandMap.enabled(.skip15)
        XCTAssertTrue(skip.skipForward && skip.skipBackward)
        XCTAssertFalse(skip.nextTrack || skip.previousTrack)
        for e in [chapters, skip] {
            XCTAssertTrue(e.changePlaybackPosition, "scrubbing works for every source")
            XCTAssertTrue(e.changePlaybackRate)
        }
    }

    func testPlayPauseAndToggle() {
        XCTAssertEqual(RemoteCommandMap.action(for: .play, in: playing), .resume)
        XCTAssertEqual(RemoteCommandMap.action(for: .pause, in: playing), .pause)
        XCTAssertEqual(RemoteCommandMap.action(for: .togglePlayPause, in: playing), .pause)
        let paused = RemoteContext(playing: false, elapsed: 30, hasPreviousChapter: true)
        XCTAssertEqual(RemoteCommandMap.action(for: .togglePlayPause, in: paused), .resume)
    }

    func testTrackButtonsAreChapters() {
        XCTAssertEqual(RemoteCommandMap.action(for: .nextTrack, in: playing), .nextChapter)
        XCTAssertEqual(RemoteCommandMap.action(for: .previousTrack, in: playing), .restartChapter, "30 s in: back to the start")
        let atStart = RemoteContext(playing: true, elapsed: 2, hasPreviousChapter: true)
        XCTAssertEqual(RemoteCommandMap.action(for: .previousTrack, in: atStart), .previousChapter)
        let first = RemoteContext(playing: true, elapsed: 2, hasPreviousChapter: false)
        XCTAssertEqual(RemoteCommandMap.action(for: .previousTrack, in: first), .restartChapter)
    }

    func testSkipsSeekFifteenSecondsAndScrubbingIsAbsolute() {
        XCTAssertEqual(RemoteCommandMap.action(for: .skipForward(15), in: playing), .seekBy(15))
        XCTAssertEqual(RemoteCommandMap.action(for: .skipBackward(15), in: playing), .seekBy(-15))
        XCTAssertEqual(RemoteCommandMap.action(for: .skipForward(0), in: playing), .seekBy(RemoteCommandMap.skipInterval))
        XCTAssertEqual(RemoteCommandMap.action(for: .changePlaybackPosition(123.5), in: playing), .seekTo(123.5))
        XCTAssertEqual(RemoteCommandMap.action(for: .changePlaybackPosition(-3), in: playing), .seekTo(0))
        XCTAssertEqual(RemoteCommandMap.action(for: .changePlaybackRate(3), in: playing), .setRate(2))
        XCTAssertEqual(RemoteCommandMap.action(for: .changePlaybackRate(1.25), in: playing), .setRate(1.25))
    }

    func testCommandsByName() {
        XCTAssertEqual(RemoteCommand.named("nextTrack", value: nil), .nextTrack)
        XCTAssertEqual(RemoteCommand.named("skipBackward", value: nil), .skipBackward(15))
        XCTAssertEqual(RemoteCommand.named("changePlaybackPosition", value: 42), .changePlaybackPosition(42))
        XCTAssertNil(RemoteCommand.named("changePlaybackPosition", value: nil))
        XCTAssertNil(RemoteCommand.named("eject", value: nil))
        for c: RemoteCommand in [.play, .pause, .togglePlayPause, .nextTrack, .previousTrack, .skipForward(15), .skipBackward(15),
                                 .changePlaybackPosition(5), .changePlaybackRate(1.5)] {
            XCTAssertEqual(RemoteCommand.named(c.name, value: 15)?.name, c.name)
        }
    }
}

final class ChapterTimelineTests: XCTestCase {
    private func timeline(_ chars: [Int], pause: Double = 0.5) -> ChapterTimeline {
        ChapterTimeline(chars.map { ChapterTimeline.Sentence(characters: $0, pause: pause) })
    }

    func testEstimateFromTextBeforeAnythingIsSpoken() {
        let t = timeline([145, 290, 145])
        // 580 characters at 14.5/s = 40 s of speech + 3 pauses.
        XCTAssertEqual(t.duration, 40 + 1.5, accuracy: 0.001)
        XCTAssertEqual(t.start(of: 0), 0)
        XCTAssertEqual(t.start(of: 1), 10.5, accuracy: 0.001)
        XCTAssertEqual(t.start(of: 99), t.duration, "past the end clamps to the length")
    }

    func testMeasurementsRefineTheSpeedSmoothly() {
        var t = timeline(Array(repeating: 145, count: 20))
        let before = t.duration
        // The voice is slower than assumed: 145 characters took 14 s instead of 10.
        t.record(0, seconds: 14)
        XCTAssertEqual(t.speaking(0), 14)
        XCTAssertGreaterThan(t.duration, before)
        XCTAssertLessThan(t.charactersPerSecond, ChapterTimeline.priorCharactersPerSecond)
        XCTAssertGreaterThan(t.charactersPerSecond, 145.0 / 14, "one sentence doesn't override the prior entirely")
        for i in 1..<10 { t.record(i, seconds: 14) }
        XCTAssertEqual(t.charactersPerSecond, 145.0 / 14, accuracy: 0.9, "enough evidence converges on the real speed")
        t.record(3, seconds: .nan)
        t.record(99, seconds: 3)
        XCTAssertEqual(t.speaking(3), 14, "bad measurements are ignored")
    }

    func testIndexAtTimeForSeeking() {
        let t = timeline([145, 145, 145], pause: 0)
        XCTAssertEqual(t.index(at: 0), 0)
        XCTAssertEqual(t.index(at: 9.9), 0)
        XCTAssertEqual(t.index(at: 10), 1)
        XCTAssertEqual(t.index(at: 25), 2)
        XCTAssertEqual(t.index(at: 1000), 2)
        XCTAssertEqual(t.index(at: -5), 0)
        XCTAssertEqual(timeline([]).index(at: 3), 0)
        XCTAssertEqual(timeline([]).duration, 0)
    }
}

final class NowPlayingSmootherTests: XCTestCase {
    func testSmallDriftKeepsTheShownTimeAndLength() {
        var s = NowPlayingSmoother()
        let a = s.next(elapsed: 10, duration: 600, rate: 1, now: 100, jump: true)
        XCTAssertEqual(a.elapsed, 10)
        // 5 s later the system shows 15; the model says 15.8 and the length moved by 3 s: keep both.
        let b = s.next(elapsed: 15.8, duration: 603, rate: 1, now: 105)
        XCTAssertEqual(b.elapsed, 15, accuracy: 0.0001)
        XCTAssertEqual(b.duration, 600)
    }

    func testRealChangesShow() {
        var s = NowPlayingSmoother()
        _ = s.next(elapsed: 10, duration: 600, rate: 1, now: 100, jump: true)
        let drift = s.next(elapsed: 30, duration: 700, rate: 1, now: 105)
        XCTAssertEqual(drift.elapsed, 30, "more than the tolerance off: corrected")
        XCTAssertEqual(drift.duration, 700, "the length moved by more than a step")
        let seek = s.next(elapsed: 31, duration: 700, rate: 1, now: 105, jump: true)
        XCTAssertEqual(seek.elapsed, 31, "a seek shows exactly")
    }

    func testPauseFreezesAndRateScalesTheClock() {
        var s = NowPlayingSmoother()
        _ = s.next(elapsed: 10, duration: 600, rate: 1.5, now: 0, jump: true)
        let paused = s.next(elapsed: 25, duration: 600, rate: 0, now: 10)
        XCTAssertEqual(paused.elapsed, 25, accuracy: 0.0001, "10 s at 1.5× = 15 s of chapter")
        let later = s.next(elapsed: 25, duration: 600, rate: 0, now: 100)
        XCTAssertEqual(later.elapsed, 25, "paused: the time stands still")
        XCTAssertEqual(later.rate, 0)
    }

    func testLengthNeverShorterThanTheTimeShown() {
        var s = NowPlayingSmoother()
        let out = s.next(elapsed: 50, duration: 40, rate: 1, now: 0, jump: true)
        XCTAssertEqual(out.duration, 50)
        let nan = s.next(elapsed: .nan, duration: .infinity, rate: .nan, now: 1, jump: true)
        XCTAssertEqual(nan.elapsed, 0)
        XCTAssertEqual(nan.rate, 0)
    }
}

final class NowPlayingMetadataTests: XCTestCase {
    func testFieldsAreTheSameForEverySource() {
        var s = NowPlayingSmoother()
        let shown = s.next(elapsed: 12, duration: 900, rate: 1.25, now: 0, jump: true)
        let m = NowPlayingMetadata.make(chapter: " Chapter 12: The Bridge ", novel: "Shadow Slave", shown: shown)
        XCTAssertEqual(m.title, "Chapter 12: The Bridge")
        XCTAssertEqual(m.artist, "Shadow Slave")
        XCTAssertEqual(m.album, "TachiNovel")
        XCTAssertEqual(m.duration, 900)
        XCTAssertEqual(m.elapsed, 12)
        XCTAssertEqual(m.rate, 1.25)
        XCTAssertEqual(m.defaultRate, 1)
        let empty = NowPlayingMetadata.make(chapter: "", novel: " ", shown: shown)
        XCTAssertEqual(empty.title, "Chapter")
        XCTAssertEqual(empty.artist, "TachiNovel")
    }
}

final class CarButtonsPreferenceTests: XCTestCase {
    func testDefaultsToChaptersAndSurvivesOlderSettings() throws {
        XCTAssertEqual(VoicePreferences().carButtonsChoice, .chapters)
        let old = try JSONDecoder().decode(VoicePreferences.self, from: Data(#"{"defaultVoice":"bm_george"}"#.utf8))
        XCTAssertEqual(old.carButtonsChoice, .chapters, "settings written before the option existed")
        XCTAssertEqual(old.defaultVoice, "bm_george")
        var p = VoicePreferences()
        p.carButtons = CarButtons.skip15.rawValue
        let back = try JSONDecoder().decode(VoicePreferences.self, from: JSONEncoder().encode(p))
        XCTAssertEqual(back.carButtonsChoice, .skip15)
        p.carButtons = "eject"
        XCTAssertEqual(p.carButtonsChoice, .chapters)
    }
}
