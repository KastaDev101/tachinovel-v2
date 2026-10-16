import HDVoiceCore
import XCTest

/// Nephis's render pacing (heat plan 2026-10-13): renders stop at the cushion and start again below the refill line.
final class RenderPacerTests: XCTestCase {
    func testHoldsAtTheCushionAndResumesOnlyBelowTheRefillLine() {
        var p = RenderPacer()
        XCTAssertFalse(p.hold(buffered: 30, thermal: 0, now: 1))
        XCTAssertFalse(p.hold(buffered: 89.9, thermal: 0, now: 2))
        XCTAssertTrue(p.hold(buffered: 90, thermal: 0, now: 3), "the cushion met: her renders stop")
        // Hysteresis: a sentence played (the bank just under the cushion) is not a reason to render again.
        XCTAssertTrue(p.hold(buffered: 80, thermal: 0, now: 13))
        XCTAssertTrue(p.hold(buffered: 60, thermal: 0, now: 33))
        XCTAssertFalse(p.hold(buffered: 59.9, thermal: 0, now: 34), "below cushion - refill: she renders again")
        XCTAssertEqual(p.holds, 1)
        XCTAssertEqual(p.heldSeconds, 31, accuracy: 1e-9)
        // And keeps rendering until the cushion is met again.
        XCTAssertFalse(p.hold(buffered: 70, thermal: 0, now: 40))
        XCTAssertTrue(p.hold(buffered: 91, thermal: 0, now: 45))
        XCTAssertEqual(p.holds, 2)
    }

    func testAWarmPhoneKeepsASmallerCushion() {
        XCTAssertEqual(RenderPacer.target(thermal: 0), 90)
        XCTAssertEqual(RenderPacer.target(thermal: 1), 60, "from fair heat on")
        XCTAssertEqual(RenderPacer.target(thermal: 2), 60)
        XCTAssertEqual(RenderPacer.resumeBelow(thermal: 0), 60)
        XCTAssertEqual(RenderPacer.resumeBelow(thermal: 1), 40)
        var p = RenderPacer()
        XCTAssertFalse(p.hold(buffered: 70, thermal: 0, now: 1))
        XCTAssertTrue(p.hold(buffered: 70, thermal: 1, now: 2), "the phone warmed: 70 s banked is already enough")
        XCTAssertEqual(p.lastTarget, 60)
        // Cooling down while holding: the larger cushion's refill line applies at once (70 s is over it: still held).
        XCTAssertTrue(p.hold(buffered: 70, thermal: 0, now: 3))
        XCTAssertFalse(p.hold(buffered: 59, thermal: 0, now: 4))
    }

    func testRecheckFollowsPlaybackWithinBounds() {
        XCTAssertEqual(RenderPacer.recheck(buffered: 62, thermal: 0), 2, accuracy: 1e-9)
        XCTAssertEqual(RenderPacer.recheck(buffered: 90, thermal: 0), 5, "never later than 5 s")
        XCTAssertEqual(RenderPacer.recheck(buffered: 50, thermal: 0), 0.5, "never sooner than 0.5 s")
    }

    func testBackgroundPriorityOnlyWithPlentyBankedWithHysteresis() {
        XCTAssertFalse(RenderPacer.relaxed(was: false, buffered: 0))
        XCTAssertFalse(RenderPacer.relaxed(was: false, buffered: 30), "at 30 s still user-initiated")
        XCTAssertTrue(RenderPacer.relaxed(was: false, buffered: 30.5), "over 30 s banked: background priority")
        XCTAssertTrue(RenderPacer.relaxed(was: true, buffered: 20), "stays relaxed down to 15 s")
        XCTAssertTrue(RenderPacer.relaxed(was: true, buffered: 15))
        XCTAssertFalse(RenderPacer.relaxed(was: true, buffered: 14.9), "under 15 s: user-initiated again")
        XCTAssertFalse(RenderPacer.relaxed(was: false, buffered: 20), "and stays so until over 30 s again")
    }

    func testReleaseStopsAHoldAtOnce() {
        var p = RenderPacer()
        XCTAssertTrue(p.hold(buffered: 100, thermal: 0, now: 0))
        p.release(now: 4)
        XCTAssertFalse(p.holding)
        XCTAssertEqual(p.held(at: 10), 4, accuracy: 1e-9)
    }

    func testDutyCycleCountsOverlappingCallsOnce() {
        var p = RenderPacer()
        p.callStarted(now: 0)
        p.callStarted(now: 1)               // the next call generates while the first decodes
        p.callEnded(now: 2, audioSeconds: 10)
        p.callEnded(now: 3, audioSeconds: 12)
        XCTAssertEqual(p.busySeconds, 3, accuracy: 1e-9)
        XCTAssertEqual(p.generatedSeconds, 22, accuracy: 1e-9)
        XCTAssertEqual(p.dutyCycle(at: 12), 0.25, accuracy: 1e-9)
        p.callStarted(now: 20)
        XCTAssertEqual(p.busy(at: 22), 5, accuracy: 1e-9, "a call in flight counts so far")
        p.played(seconds: 7.5)
        XCTAssertEqual(p.playedSeconds, 7.5)
        XCTAssertEqual(RenderPacer().dutyCycle(at: 0), 0)
        // An end without a start (a call from before the read) still counts its audio, never negative busy time.
        var q = RenderPacer()
        q.callEnded(now: 5, audioSeconds: 4)
        XCTAssertEqual(q.generatedSeconds, 4)
        XCTAssertEqual(q.busySeconds, 0)
    }
}
