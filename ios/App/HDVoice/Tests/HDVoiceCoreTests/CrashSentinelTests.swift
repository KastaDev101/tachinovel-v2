import XCTest
@testable import HDVoiceCore

/// The crash sentinel with the run journal: only a real crash of a voice's model counts (a memory fault off the main
/// thread with its call in flight); app bugs, swipe-aways, updates and refreshes, restarts, and iOS closing the app for
/// memory, in the background or for a hang never do.
final class CrashSentinelTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!
    private let v57 = RunIdentity(version: "2.0.0", build: "57", install: "A")

    private func tempDir() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("hdvoice-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private func at(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    /// 2026-10-09 at h:m:s UTC.
    private func t(_ h: Int, _ m: Int, _ s: Int = 0) -> Date { at(String(format: "2026-10-09T%02d:%02d:%02dZ", h, m, s)) }

    /// The phone's boot in these tests (the same all along unless a test restarts the phone).
    private var boot: Date { t(9, 0) }

    private func heartbeat(_ at: Date, chapter: String? = "Chapter 1026 - The Pass", thermal: String = "fair", availableMB: Double? = 2_000,
                           foreground: Bool = true, playing: Bool = true) -> RunHeartbeat {
        RunHeartbeat(at: at, chapter: chapter, voice: "Nephis", thermal: thermal, memoryMB: 1_100, availableMB: availableMB, busy: ["Nephis"],
                     foreground: foreground, playing: playing)
    }

    /// One launch of the app: its journal (holding the last run's record) and Nephis's sentinel, checked as at launch.
    private struct Launch {
        let journal: RunJournal
        let nephis: CrashSentinel
        let check: CrashSentinel.LaunchCheck
        var note: RunEndNote? { check.note }
    }

    /// `signals`: the fatal-signal handler watches this run, as in the app (not installed here: a test notes the signal
    /// its run dies of with `dies`); false: it couldn't be installed (the old rule).
    private func launch(_ dir: URL, _ identity: RunIdentity? = nil, foreground: Bool = true, booted: Date? = nil, signals: Bool = true,
                        at now: Date) -> Launch {
        // As in the app: the journal starts this run's record (VoiceRun, AppDelegate), then the voice checks.
        let journal = RunJournal(directory: dir.appendingPathComponent("run"), identity: identity ?? v57, booted: booted ?? boot)
        let watch: ((Int32) -> Bool)? = signals ? { _ in true } : nil
        journal.start(foreground: foreground, now: now, watch: watch)
        let nephis = CrashSentinel(directory: dir.appendingPathComponent("voice"), name: "Nephis")
        let check = nephis.checkAtLaunch(journal, now: now)
        return Launch(journal: journal, nephis: nephis, check: check)
    }

    /// The run's process dies of `signo`: the line the signal handler writes (SIGSEGV off the main thread: how a crash
    /// inside Core ML ends the app).
    private func dies(_ run: Launch, of signo: Int32 = SIGSEGV, at: Date, mainThread: Bool = false) {
        run.journal.noteSignal(signo, at: at, mainThread: mainThread)
    }

    private func words(_ note: RunEndNote?) -> String? {
        note.map { RunEndWords.line($0, voice: "Nephis", now: t(20, 0), timeZone: utc) }
    }

    // MARK: - Real crashes still count

    func testCleanRunsAreNotCrashes() {
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.nephis.begin("nephis 120 chars", now: t(14, 1))
        first.nephis.end(success: true)
        let next = launch(dir, at: t(15, 0))
        XCTAssertNil(next.note)
        XCTAssertEqual(next.nephis.current.consecutive, 0)
        XCTAssertFalse(next.nephis.inFlight)
    }

    func testTwoCrashesOfHerModelInARowStillSwitchNephisOffUntilTurnedBackOn() {
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.journal.beat(heartbeat(t(14, 31, 55)))
        first.nephis.begin("nephis 120 chars", now: t(14, 32))
        dies(first, at: t(14, 32, 3)) // a memory fault inside Core ML, off the main thread
        let second = launch(dir, at: t(14, 40))
        XCTAssertEqual(second.note?.kind, .crashed)
        XCTAssertEqual(second.note?.counted, true)
        XCTAssertEqual(second.note?.signal, "SIGSEGV off the main thread")
        XCTAssertEqual(words(second.note), "Nephis crashed at 2:32 PM, chapter 1026, phone warm.")
        XCTAssertEqual(second.nephis.current.consecutive, 1)
        XCTAssertFalse(second.nephis.current.disabled)

        second.nephis.begin("nephis 80 chars", now: t(14, 45)) // dies again, in the foreground (not playing: a sample)
        dies(second, of: SIGBUS, at: t(14, 45, 2))
        let third = launch(dir, at: t(14, 50))
        XCTAssertEqual(third.note?.counted, true)
        XCTAssertEqual(third.nephis.current.consecutive, 2)
        XCTAssertTrue(third.nephis.current.disabled)
        XCTAssertEqual(third.nephis.current.lastContext, "nephis 80 chars")
        XCTAssertEqual(third.nephis.current.lastCrashAt, t(14, 45, 2))
        XCTAssertEqual(third.nephis.offLine(now: t(20, 0), timeZone: utc), "Nephis was switched off after crashing twice in a row, last at 2:45 PM.")

        // A relaunch of the same build keeps her off; "Turn Nephis back on" turns her on and keeps the count.
        let fourth = launch(dir, at: t(15, 0))
        XCTAssertTrue(fourth.nephis.current.disabled)
        XCTAssertFalse(fourth.check.turnedBackOn)
        fourth.nephis.reset()
        let fifth = launch(dir, at: t(15, 10))
        XCTAssertFalse(fifth.nephis.current.disabled)
        XCTAssertEqual(fifth.nephis.current.total, 2)
        XCTAssertNil(fifth.nephis.offLine())
    }

    func testASuccessBreaksTheStreak() {
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.nephis.begin("x", now: t(14, 1))
        dies(first, at: t(14, 1, 5))
        let s = launch(dir, at: t(14, 10))
        XCTAssertEqual(s.nephis.current.consecutive, 1)
        s.nephis.begin("y", now: t(14, 11))
        s.nephis.end(success: true)
        XCTAssertEqual(launch(dir, at: t(14, 20)).nephis.current.consecutive, 0)
    }

    func testABackgroundCrashWhilePlayingStillCounts() {
        // Reading in the car with the phone locked: her model crashed.
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.journal.setForeground(false, now: t(14, 2))
        first.journal.beat(heartbeat(t(14, 31, 55), foreground: false))
        first.nephis.begin("nephis 100 chars", now: t(14, 32))
        dies(first, at: t(14, 32, 1))
        let next = launch(dir, foreground: false, at: t(14, 40))
        XCTAssertEqual(next.note?.kind, .crashed)
        XCTAssertEqual(next.note?.counted, true)
    }

    func testAWindowClosedEarlierInTheDriveDoesNotExcuseHerCrash() {
        // Locked phone in the car: iOS disconnected the app's window at 2:00 PM while narration went on; her model
        // crashed at 2:32 PM.
        let dir = tempDir()
        let first = launch(dir, at: t(13, 55))
        first.journal.setPlaying(true, now: t(13, 56))
        first.journal.setForeground(false, now: t(13, 58))
        first.journal.closed(.windowClosed, now: t(14, 0))
        first.journal.beat(heartbeat(t(14, 31, 55), foreground: false))
        XCTAssertNil(first.journal.current?.end) // working again: the soft end no longer applies
        first.nephis.begin("nephis 100 chars", now: t(14, 32))
        dies(first, at: t(14, 32, 4))
        let next = launch(dir, foreground: false, at: t(14, 40))
        XCTAssertEqual(next.note?.kind, .crashed)
        XCTAssertEqual(next.note?.counted, true)
        XCTAssertEqual(words(next.note), "Nephis crashed at 2:32 PM, chapter 1026, phone warm.")
    }

    func testASoftEndNeverExcusesWorkThatCameAfterIt() {
        // Without the signal handler (the old rule): her window closed before her call began, no heartbeat since. The
        // call in flight while playing can't be explained by the closed window: it counts.
        let dir = tempDir()
        let first = launch(dir, signals: false, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.journal.closed(.windowClosed, now: t(14, 2))
        first.nephis.begin("nephis 100 chars", now: t(14, 2, 5))
        let next = launch(dir, signals: false, at: t(14, 40))
        XCTAssertEqual(next.note?.kind, .crashed)
        XCTAssertEqual(next.note?.counted, true)
    }

    func testAMemoryWarningTheAppLivedThroughDoesNotExplainALaterEnd() {
        // Playing with the phone locked: a warning at 2:02 PM (her model was released and loaded again), heartbeats
        // until 2:31 PM, then her model crashed. It counts.
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.journal.setForeground(false, now: t(14, 1, 30))
        first.journal.memoryWarning(now: t(14, 2))
        first.journal.beat(heartbeat(t(14, 31, 55), foreground: false))
        first.nephis.begin("nephis 100 chars", now: t(14, 32))
        dies(first, at: t(14, 32, 2))
        let crashed = launch(dir, foreground: false, at: t(14, 40))
        XCTAssertEqual(crashed.note?.kind, .crashed)
        XCTAssertEqual(crashed.note?.counted, true)

        // The same drive ending without a crash signal: not counted, and not put down to that early warning.
        crashed.journal.setPlaying(true, now: t(14, 41))
        crashed.journal.setForeground(false, now: t(14, 42))
        crashed.journal.memoryWarning(now: t(14, 43))
        crashed.journal.beat(heartbeat(t(15, 11, 55), foreground: false))
        crashed.nephis.begin("nephis 100 chars", now: t(15, 12))
        let stopped = launch(dir, foreground: false, at: t(15, 20))
        XCTAssertEqual(stopped.note?.kind, .stopped)
        XCTAssertEqual(stopped.note?.counted, false)
    }

    func testOverlappingCallsKeepTheMarkerUntilTheLastOneReturns() {
        // Nephis's next call starts while the one before decodes; the first one returning must not clear the marker.
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.nephis.begin("call 1", now: t(14, 1))
        first.nephis.begin("call 2", now: t(14, 1, 2))
        first.nephis.end(success: true)
        XCTAssertTrue(first.nephis.inFlight)
        dies(first, at: t(14, 1, 3))
        let next = launch(dir, at: t(14, 10)) // call 2 was running when the process died
        XCTAssertEqual(next.note?.context, "call 2")
        XCTAssertEqual(next.note?.counted, true)
    }

    func testWithoutTheSignalHandlerTheOldRuleStillCounts() {
        // The handler couldn't be installed: her call in flight while in use, nothing else to explain it, counts.
        let dir = tempDir()
        let first = launch(dir, signals: false, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.nephis.begin("nephis 120 chars", now: t(14, 32))
        let next = launch(dir, at: t(14, 40))
        XCTAssertEqual(next.note?.kind, .crashed)
        XCTAssertEqual(next.note?.counted, true)
    }

    // MARK: - App bugs and kills are never her crash

    func testTheOct9AppBugNeverSwitchesNephisOff() {
        // Build 288, Oct 9: 14 s after launch, with her model loading, a Swift exclusivity fatalError on the main thread
        // (HybridSpeechEngine.leaveNephisOnly) aborted the app: SIGABRT. Twice in a row must not switch her off.
        let dir = tempDir()
        var now = t(10, 50, 59)
        var run = launch(dir, at: now)
        for clock in ["10:51 AM", "11:01 AM"] {
            run.nephis.begin("load pocketTts", now: now.addingTimeInterval(5))
            dies(run, of: SIGABRT, at: now.addingTimeInterval(14), mainThread: true)
            now = now.addingTimeInterval(600)
            run = launch(dir, at: now)
            XCTAssertEqual(run.note?.kind, .appError)
            XCTAssertEqual(run.note?.counted, false)
            XCTAssertEqual(run.note?.signal, "SIGABRT on the main thread")
            XCTAssertEqual(words(run.note), "The app crashed at \(clock) (an app bug). Not counted against Nephis.")
        }
        XCTAssertEqual(run.nephis.current.consecutive, 0)
        XCTAssertFalse(run.nephis.current.disabled)
        XCTAssertEqual(run.nephis.current.notCounted, 2)
    }

    func testASwiftTrapOrAFaultOnTheMainThreadIsTheAppsNotHers() {
        let dir = tempDir()
        var now = t(14, 0)
        var run = launch(dir, at: now)
        let ends: [(Int32, Bool, String)] = [
            (SIGTRAP, false, "SIGTRAP off the main thread"), (SIGILL, false, "SIGILL off the main thread"),
            (SIGSEGV, true, "SIGSEGV on the main thread"), (SIGBUS, true, "SIGBUS on the main thread"),
        ]
        for (signo, mainThread, summary) in ends {
            run.journal.setPlaying(true, now: now.addingTimeInterval(1))
            run.nephis.begin("nephis 90 chars", now: now.addingTimeInterval(60))
            dies(run, of: signo, at: now.addingTimeInterval(61), mainThread: mainThread)
            now = now.addingTimeInterval(600)
            run = launch(dir, at: now)
            XCTAssertEqual(run.note?.kind, .appError, summary)
            XCTAssertEqual(run.note?.counted, false, summary)
            XCTAssertEqual(run.note?.signal, summary)
        }
        XCTAssertEqual(run.nephis.current.consecutive, 0)
        XCTAssertFalse(run.nephis.current.disabled)
    }

    func testAnEndWithoutACrashSignalNeverCounts() {
        // Reading in the foreground, her call in flight, and the process was killed without a crash signal: the
        // watchdog (a hang), iOS's memory or CPU limits. Twice in a row.
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.journal.beat(heartbeat(t(14, 31, 55)))
        first.nephis.begin("nephis 120 chars", now: t(14, 32))
        let second = launch(dir, at: t(14, 40))
        XCTAssertEqual(second.note?.kind, .stopped)
        XCTAssertEqual(second.note?.counted, false)
        XCTAssertNil(second.note?.signal)
        XCTAssertEqual(words(second.note), "The app was closed without crashing at 2:32 PM, chapter 1026, phone warm (by iOS, or swiped away). Not counted against Nephis.")
        second.journal.setPlaying(true, now: t(14, 41))
        second.nephis.begin("nephis 80 chars", now: t(14, 45))
        let third = launch(dir, at: t(14, 50))
        XCTAssertEqual(third.note?.kind, .stopped)
        XCTAssertEqual(third.nephis.current.consecutive, 0)
        XCTAssertFalse(third.nephis.current.disabled)
    }

    func testASuspendedAppStillMarkedPlayingNeverCounts() {
        // A phone call came in while narration loaded its chapter: still "playing" for the journal when iOS suspended
        // the app with her call frozen mid-way; later it was swiped away. No crash signal: never counted.
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.journal.setForeground(false, now: t(14, 2))
        first.journal.beat(heartbeat(t(14, 2), foreground: false))
        first.nephis.begin("nephis 100 chars", now: t(14, 2, 5))
        let next = launch(dir, at: t(16, 0))
        XCTAssertEqual(next.note?.kind, .stopped)
        XCTAssertEqual(next.note?.counted, false)
    }

    func testAPhoneRestartNeverCounts() {
        // The battery died in the car while she read (or the phone restarted): the next launch is on a later boot.
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.journal.setForeground(false, now: t(14, 2))
        first.journal.beat(heartbeat(t(14, 31, 55), foreground: false))
        first.nephis.begin("nephis 100 chars", now: t(14, 32))
        let next = launch(dir, booted: t(15, 10), at: t(15, 12))
        XCTAssertEqual(next.note?.kind, .restarted)
        XCTAssertEqual(next.note?.counted, false)
        XCTAssertEqual(words(next.note), "The phone restarted or ran out of power after 2:32 PM. Not counted against Nephis.")

        // The boot time moving a few seconds (a clock fix) is no restart.
        next.journal.setPlaying(true, now: t(15, 13))
        next.nephis.begin("nephis 100 chars", now: t(15, 20))
        let same = launch(dir, booted: t(15, 10, 20), at: t(15, 30))
        XCTAssertEqual(same.note?.kind, .stopped)

        // A crash noted before a restart still counts.
        same.journal.setPlaying(true, now: t(15, 31))
        same.nephis.begin("nephis 100 chars", now: t(15, 40))
        dies(same, at: t(15, 40, 2))
        let afterCrash = launch(dir, booted: t(16, 0), at: t(16, 5))
        XCTAssertEqual(afterCrash.note?.kind, .crashed)
        XCTAssertEqual(afterCrash.note?.counted, true)
    }

    func testTheSignalFileNamesItsRun() {
        let run = "2026-10-09T14:00:00Z"
        XCTAssertEqual(RunSignal.parse("\(run)\n\(SIGSEGV) 1791555123 0\n\(SIGABRT) 1791555124 1\n", run: run),
                       RunSignal(number: SIGSEGV, at: Date(timeIntervalSince1970: 1_791_555_123), mainThread: false))
        XCTAssertEqual(RunSignal.parse("\(run)\n\(SIGABRT) 1791555124 1\n", run: run)?.summary, "SIGABRT on the main thread")
        XCTAssertNil(RunSignal.parse("2026-10-09T13:00:00Z\n\(SIGSEGV) 1791555123 0\n", run: run)) // another run's
        XCTAssertNil(RunSignal.parse("\(run)\n", run: run)) // stamped, nothing noted
        XCTAssertNil(RunSignal.parse("\(run)\n\(SIGSEGV) 17915", run: run)) // cut off mid-line
        XCTAssertNil(RunSignal.parse("", run: run))
    }

    // MARK: - Never a crash

    func testSwipeAwayNeverCounts() {
        // Swiped away three times while she was reading mid-call: applicationWillTerminate each time.
        let dir = tempDir()
        var now = t(14, 0)
        for _ in 0..<3 {
            let run = launch(dir, at: now)
            run.journal.setPlaying(true, now: now.addingTimeInterval(5))
            run.nephis.begin("nephis 90 chars", now: now.addingTimeInterval(60))
            run.journal.closed(.closed, now: now.addingTimeInterval(61))
            now = now.addingTimeInterval(600)
        }
        let last = launch(dir, at: now)
        XCTAssertEqual(last.note?.kind, .closed)
        XCTAssertEqual(last.note?.counted, false)
        XCTAssertFalse(last.nephis.current.disabled)
        XCTAssertEqual(last.nephis.current.consecutive, 0)
        XCTAssertEqual(last.nephis.current.notCounted, 3)
        XCTAssertEqual(last.nephis.current.history.count, 3)
        XCTAssertEqual(words(last.note), "The app was closed at 2:21 PM (swiped away, or closed by iOS). Not counted against Nephis.")
    }

    func testWindowClosedNeverCounts() {
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.nephis.begin("nephis 90 chars", now: t(14, 5))
        first.journal.closed(.windowClosed, now: t(14, 5, 1))
        let next = launch(dir, at: t(14, 10))
        XCTAssertEqual(next.note?.kind, .windowClosed)
        XCTAssertEqual(next.note?.counted, false)
    }

    func testSwipeAwayOfASuspendedAppNeverCounts() {
        // Paused and put in the background; a call was frozen mid-way when iOS suspended the app; later it was
        // swiped away (or closed by iOS) without a word.
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.journal.setPlaying(false, now: t(14, 30))
        first.nephis.begin("nephis 70 chars", now: t(14, 30, 1))
        first.journal.setForeground(false, now: t(14, 30, 2))
        let next = launch(dir, at: t(16, 0))
        XCTAssertEqual(next.note?.kind, .background)
        XCTAssertEqual(next.note?.counted, false)

        // Nothing working when it went to the background (the app noted it was idle there), then woken in the
        // background to load her model and closed by iOS mid-load: her call began after the idle mark, so it isn't
        // "with no voice working".
        next.journal.setPlaying(true, now: t(16, 1))
        next.journal.setPlaying(false, now: t(16, 20))
        next.journal.setForeground(false, now: t(16, 21))
        next.journal.idleInBackground(now: t(16, 21))
        next.nephis.begin("a warm-up load", now: t(16, 25))
        let third = launch(dir, at: t(18, 0))
        XCTAssertEqual(third.note?.kind, .background)
        XCTAssertEqual(third.note?.counted, false)
        XCTAssertEqual(words(third.note), "Closed by iOS in the background at 4:25 PM. Not counted against Nephis.")
        XCTAssertEqual(third.nephis.current.consecutive, 0)
        // How the app ended (no call): idle in the background, closed by iOS some time later.
        XCTAssertEqual(third.journal.lastEnd.kind, .backgroundIdle)
        XCTAssertEqual(words(third.journal.lastEnd), "Closed by iOS in the background after 4:21 PM, with no voice working.")
    }

    func testUpdateOrAltStoreRefreshNeverCounts() {
        // Reading in the foreground, her call in flight, when AltStore refreshed the app (a reinstall: same build, new
        // install folder), and again when an update was installed (new build).
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.nephis.begin("nephis 100 chars", now: t(14, 32))
        let refreshed = launch(dir, RunIdentity(version: "2.0.0", build: "57", install: "B"), at: t(14, 40))
        XCTAssertEqual(refreshed.note?.kind, .updated)
        XCTAssertEqual(refreshed.note?.counted, false)
        XCTAssertEqual(words(refreshed.note), "The app was updated, reinstalled or refreshed (AltStore) after 2:32 PM. Not counted against Nephis.")

        refreshed.journal.setPlaying(true, now: t(14, 41))
        refreshed.nephis.begin("nephis 100 chars", now: t(14, 50))
        let updated = launch(dir, RunIdentity(version: "2.0.1", build: "58", install: "C"), at: t(15, 0))
        XCTAssertEqual(updated.note?.kind, .updated)
        XCTAssertEqual(updated.note?.build, "2.0.0 (57)")
        XCTAssertEqual(updated.nephis.current.consecutive, 0)
        XCTAssertFalse(updated.nephis.current.disabled)
        XCTAssertEqual(updated.nephis.current.total, 0)
    }

    func testVersionChangeResetsTheStreakAndTurnsNephisBackOn() {
        let dir = tempDir()
        // Two real crashes on build 57 switch her off.
        for (minute, context) in [(0, "a"), (10, "b")] {
            let run = launch(dir, at: t(14, minute))
            run.nephis.begin(context, now: t(14, minute + 1))
            dies(run, at: t(14, minute + 1, 2))
        }
        let off = launch(dir, at: t(14, 20))
        XCTAssertTrue(off.nephis.current.disabled)
        // An AltStore refresh of the same build is no new build: she stays off.
        let refreshed = launch(dir, RunIdentity(version: "2.0.0", build: "57", install: "B"), at: t(14, 30))
        XCTAssertTrue(refreshed.nephis.current.disabled)
        XCTAssertFalse(refreshed.check.turnedBackOn)
        // A new build starts over: back on, streak cleared, the crash count kept.
        let v58 = RunIdentity(version: "2.0.1", build: "58", install: "C")
        let updated = launch(dir, v58, at: t(15, 0))
        XCTAssertTrue(updated.check.turnedBackOn)
        XCTAssertFalse(updated.nephis.current.disabled)
        XCTAssertEqual(updated.nephis.current.consecutive, 0)
        XCTAssertEqual(updated.nephis.current.total, 2)
        XCTAssertEqual(updated.nephis.current.build, "2.0.1 (58)")
        // One crash before the update and one after it are no streak.
        updated.nephis.begin("c", now: t(15, 1))
        dies(updated, at: t(15, 1, 2))
        let next = launch(dir, v58, at: t(15, 10))
        XCTAssertEqual(next.nephis.current.consecutive, 1)
        XCTAssertFalse(next.nephis.current.disabled)
        XCTAssertFalse(next.check.turnedBackOn)
    }

    func testBackgroundMemoryKillNeverCounts() {
        // Reading in the car with the phone locked: a memory warning, then iOS closed the app during her call. Twice.
        let dir = tempDir()
        var run = launch(dir, at: t(14, 0))
        for (hour, clock) in [(14, "2:32 PM"), (15, "3:32 PM")] {
            run.journal.setPlaying(true, now: t(hour, 0, 5))
            run.journal.setForeground(false, now: t(hour, 10))
            run.journal.memoryWarning(now: t(hour, 31))
            run.journal.beat(heartbeat(t(hour, 31, 55), foreground: false))
            run.nephis.begin("nephis 100 chars", now: t(hour, 32))
            run = launch(dir, at: t(hour, 40))
            XCTAssertEqual(run.note?.kind, .memory)
            XCTAssertEqual(run.note?.counted, false)
            XCTAssertEqual(words(run.note), "Closed in the background for memory at \(clock), chapter 1026, phone warm. Not counted against Nephis.")
        }
        XCTAssertFalse(run.nephis.current.disabled)
        XCTAssertEqual(run.nephis.current.consecutive, 0)
        XCTAssertEqual(run.nephis.current.notCounted, 2)
    }

    func testAMemoryWarningAnyTimeAfterASuspendedAppWentToTheBackgroundPointsAtMemory() {
        // Nothing playing in the background (a voice working for the drive): a warning ten minutes before the end.
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.journal.setForeground(false, now: t(14, 2))
        first.journal.memoryWarning(now: t(14, 20))
        first.journal.beat(heartbeat(t(14, 29, 55), foreground: false, playing: false))
        first.nephis.begin("nephis", now: t(14, 30))
        XCTAssertEqual(launch(dir, foreground: false, at: t(14, 40)).note?.kind, .memory)
    }

    func testLittleMemoryLeftAtTheLastHeartbeatIsAMemoryKill() {
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.journal.beat(heartbeat(t(14, 31, 55), thermal: "serious", availableMB: 120))
        first.nephis.begin("nephis 100 chars", now: t(14, 32))
        let next = launch(dir, at: t(14, 40))
        XCTAssertEqual(next.note?.kind, .memory)
        XCTAssertEqual(next.note?.counted, false)
        XCTAssertEqual(words(next.note), "Closed by iOS for memory at 2:32 PM, chapter 1026, phone hot. Not counted against Nephis.")
    }

    func testAnOldMemoryWarningInTheForegroundDoesNotExcuseACrash() {
        // Without the signal handler (the old rule): a warning half an hour before the end says nothing about it.
        let dir = tempDir()
        let first = launch(dir, signals: false, at: t(14, 0))
        first.journal.memoryWarning(now: t(14, 1))
        first.journal.setPlaying(true, now: t(14, 2))
        first.journal.beat(heartbeat(t(14, 29, 55)))
        first.nephis.begin("nephis", now: t(14, 30))
        XCTAssertEqual(launch(dir, at: t(14, 40)).note?.kind, .crashed)
    }

    func testNoRecordOfTheLastRunIsNeverCounted() {
        // The first launch with this check: a marker (plain text) left by the build before, no journal yet.
        let dir = tempDir()
        let voice = dir.appendingPathComponent("voice")
        try? FileManager.default.createDirectory(at: voice, withIntermediateDirectories: true)
        try? Data("af_heart ane-cpu 120 chars".utf8).write(to: voice.appendingPathComponent("kokoro-inflight.txt"))
        let run = launch(dir, at: t(14, 0))
        XCTAssertEqual(run.note?.kind, .unknown)
        XCTAssertEqual(run.note?.counted, false)
        XCTAssertEqual(run.note?.context, "af_heart ane-cpu 120 chars")
        XCTAssertEqual(run.nephis.current.consecutive, 0)
        XCTAssertEqual(words(run.note), "The app closed without a record of how. Not counted against Nephis.")
    }

    func testAMarkerFromALaunchWhoseCheckNeverRanIsNeverCounted() {
        // Her call in flight when run 1 ended; run 2 died in the foreground before her service ever started (its check
        // never ran), so at run 3 her marker is run 1's and run 2's record says nothing about it.
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.nephis.begin("nephis 100 chars", now: t(14, 32))
        dies(first, at: t(14, 32, 1))
        RunJournal(directory: dir.appendingPathComponent("run"), identity: v57, booted: boot).start(foreground: true, now: t(14, 40))
        let third = launch(dir, at: t(14, 50))
        XCTAssertEqual(third.note?.kind, .unknown)
        XCTAssertEqual(third.note?.counted, false)
        XCTAssertEqual(third.note?.context, "nephis 100 chars")
        XCTAssertEqual(third.nephis.current.consecutive, 0)
        XCTAssertEqual(words(third.note), "The app closed at 2:32 PM without a record of how. Not counted against Nephis.")
    }

    func testRecordsFromOlderBuildsStillDecodeAndANewBuildTurnsTheVoiceBackOn() throws {
        let dir = tempDir()
        let voice = dir.appendingPathComponent("voice")
        try FileManager.default.createDirectory(at: voice, withIntermediateDirectories: true)
        let old = #"{"consecutive":2,"total":5,"disabled":true,"lastContext":"x","lastCrashAt":"2026-10-01T10:00:00Z"}"#
        try Data(old.utf8).write(to: voice.appendingPathComponent("kokoro-crashes.json"))
        let s = CrashSentinel(directory: voice, name: "Nephis")
        XCTAssertTrue(s.current.disabled)
        XCTAssertEqual(s.current.total, 5)
        XCTAssertEqual(s.current.notCounted, 0)
        XCTAssertEqual(s.current.history, [])
        // Switched off by the old rule (any two markers): this build is new to the record, so she gets her chance.
        let journal = RunJournal(directory: dir.appendingPathComponent("run"), identity: v57, booted: boot)
        XCTAssertTrue(s.checkAtLaunch(journal, now: t(14, 0)).turnedBackOn)
        XCTAssertFalse(s.current.disabled)
        XCTAssertEqual(s.current.total, 5)
    }

    // MARK: - The journal

    func testSoftCleanEndsAreUndoneByUseAndClosedIsFinal() {
        let j = RunJournal(directory: tempDir(), identity: v57, booted: boot)
        j.closed(.windowClosed, now: t(14, 0)) // before start: nothing to write
        XCTAssertNil(j.current)
        j.start(foreground: true, now: t(14, 0))
        j.setForeground(false, now: t(14, 1))
        j.idleInBackground(now: t(14, 1))
        XCTAssertEqual(j.current?.end, .backgroundIdle)
        j.setForeground(true, now: t(14, 2))
        XCTAssertNil(j.current?.end)
        j.setForeground(false, now: t(14, 3))
        j.idleInBackground(now: t(14, 3))
        j.setPlaying(true, now: t(14, 4)) // the lock screen's play
        XCTAssertNil(j.current?.end)
        j.idleInBackground(now: t(14, 5)) // playing: not idle
        XCTAssertNil(j.current?.end)
        j.closed(.windowClosed, now: t(14, 6))
        XCTAssertEqual(j.current?.end, .windowClosed)
        j.setForeground(true, now: t(14, 7))
        XCTAssertNil(j.current?.end)
        // A heartbeat while working undoes it too (narration going on after iOS disconnected the window); one with
        // nothing working doesn't.
        j.closed(.windowClosed, now: t(14, 7, 10))
        j.beat(RunHeartbeat(at: t(14, 7, 20), foreground: false, playing: false))
        XCTAssertEqual(j.current?.end, .windowClosed)
        j.beat(heartbeat(t(14, 7, 30), foreground: false))
        XCTAssertNil(j.current?.end)
        j.closed(.closed, now: t(14, 8))
        j.beat(heartbeat(t(14, 8, 30)))
        j.setPlaying(false, now: t(14, 9))
        j.setForeground(false, now: t(14, 9))
        j.closed(.windowClosed, now: t(14, 9))
        XCTAssertEqual(j.current?.end, .closed)
        XCTAssertEqual(j.current?.endAt, t(14, 8))
        XCTAssertEqual(j.current?.updatedAt, t(14, 9))
    }

    func testTheAppLevelViewWithoutAMarker() {
        let dir = tempDir()
        let first = launch(dir, at: t(14, 0))
        first.journal.setPlaying(true, now: t(14, 1))
        first.journal.beat(heartbeat(t(14, 31, 55), thermal: "nominal"))
        // Died between her calls without a crash signal: nothing against her.
        let next = launch(dir, at: t(14, 40))
        XCTAssertNil(next.note)
        let app = next.journal.lastEnd
        XCTAssertEqual(app.kind, .stopped)
        XCTAssertFalse(app.counted)
        XCTAssertEqual(words(app), "The app was closed without crashing at 2:31 PM, chapter 1026, phone cool (by iOS, or swiped away).")
        // A memory fault off the main thread with no call of hers in flight: a crash, not hers.
        dies(next, at: t(14, 45, 7))
        let crashed = launch(dir, at: t(15, 0))
        XCTAssertNil(crashed.note)
        XCTAssertEqual(crashed.journal.lastEnd.kind, .fault)
        XCTAssertEqual(words(crashed.journal.lastEnd), "The app crashed at 2:45 PM.")
        // A Swift trap is the app's own bug.
        dies(crashed, of: SIGTRAP, at: t(15, 5))
        let trapped = launch(dir, at: t(15, 10))
        XCTAssertEqual(trapped.journal.lastEnd.kind, .appError)
        XCTAssertEqual(words(trapped.journal.lastEnd), "The app crashed at 3:05 PM (an app bug).")
        // Idle in the foreground, nothing playing: only the last sign of life is known (and the signal file now names
        // the run after the crash).
        let idle = launch(dir, at: t(15, 15)).journal.lastEnd
        XCTAssertEqual(idle.kind, .stopped)
        XCTAssertEqual(words(idle), "The app was closed without crashing after 3:10 PM (by iOS, or swiped away).")
        // Without the signal handler an end while in use can't be told apart from a crash.
        let unwatched = launch(dir, signals: false, at: t(15, 20))
        unwatched.journal.setPlaying(true, now: t(15, 21))
        let old = launch(dir, at: t(15, 30)).journal.lastEnd
        XCTAssertEqual(old.kind, .unexpected)
        XCTAssertEqual(words(old), "The app closed unexpectedly at 3:21 PM.")
    }

    // MARK: - Plain words

    func testPlainWordsUseTheTwelveHourClock() {
        let now = at("2026-10-12T20:00:00Z")
        XCTAssertEqual(RunEndWords.time(at("2026-10-12T14:32:00Z"), now: now, timeZone: utc), "2:32 PM")
        XCTAssertEqual(RunEndWords.time(at("2026-10-12T00:05:00Z"), now: now, timeZone: utc), "12:05 AM")
        XCTAssertEqual(RunEndWords.time(at("2026-10-12T12:00:00Z"), now: now, timeZone: utc), "12:00 PM")
        XCTAssertEqual(RunEndWords.time(at("2026-10-11T23:59:00Z"), now: now, timeZone: utc), "11:59 PM yesterday")
        XCTAssertEqual(RunEndWords.time(at("2026-10-09T14:32:00Z"), now: now, timeZone: utc), "2:32 PM on Oct 9")
        // The phone's own clock: the same moment in California.
        XCTAssertEqual(RunEndWords.time(at("2026-10-12T14:32:00Z"), now: now, timeZone: TimeZone(identifier: "America/Los_Angeles")!), "7:32 AM")
    }

    func testChapterAndHeatInWords() {
        XCTAssertEqual(RunEndWords.chapter("Chapter 1026 - The Pass"), "chapter 1026")
        XCTAssertEqual(RunEndWords.chapter("Ch. 12.00"), "chapter 12")
        XCTAssertEqual(RunEndWords.chapter("ch 7.5: Interlude"), "chapter 7.5")
        XCTAssertEqual(RunEndWords.chapter("1026: The Pass"), "chapter 1026")
        XCTAssertEqual(RunEndWords.chapter("The Lantern Road"), "“The Lantern Road”")
        XCTAssertEqual(RunEndWords.chapter(String(repeating: "a", count: 50)), "“\(String(repeating: "a", count: 39))…”")
        XCTAssertNil(RunEndWords.chapter("  "))
        XCTAssertNil(RunEndWords.chapter(nil))
        XCTAssertEqual(["nominal", "fair", "serious", "critical"].compactMap { RunEndWords.heat($0) }, ["phone cool", "phone warm", "phone hot", "phone very hot"])
        XCTAssertNil(RunEndWords.heat("unknown"))
        XCTAssertEqual(RunEndWords.details(heartbeat(t(14, 0), chapter: nil, thermal: "critical")), ["phone very hot"])
        XCTAssertEqual(RunEndWords.details(nil), [])
    }
}
