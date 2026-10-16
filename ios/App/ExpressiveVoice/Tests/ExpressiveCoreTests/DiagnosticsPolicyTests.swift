//
//  DiagnosticsPolicyTests.swift — the Diagnostics folder's schedule and failure words (DiagnosticsPolicy.swift): a copy
//  right away at launch, every 10 minutes while a voice works and every five otherwise; a changed log is copied even at
//  the same size; a folder the app can't reach any more reads "disconnected", a busy iCloud Drive only "failing".
//

import ExpressiveCore
import Foundation
import XCTest

final class DiagnosticsPolicyTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_791_000_000)

    func testSchedule() {
        XCTAssertTrue(DiagnosticsPolicy.isDue(now: t0, lastAttempt: nil, busy: false), "first copy at launch")
        XCTAssertFalse(DiagnosticsPolicy.isDue(now: t0.addingTimeInterval(60), lastAttempt: t0, busy: true))
        XCTAssertFalse(DiagnosticsPolicy.isDue(now: t0.addingTimeInterval(9 * 60), lastAttempt: t0, busy: true), "listening: every 10 minutes")
        XCTAssertTrue(DiagnosticsPolicy.isDue(now: t0.addingTimeInterval(10 * 60), lastAttempt: t0, busy: true))
        XCTAssertFalse(DiagnosticsPolicy.isDue(now: t0.addingTimeInterval(120), lastAttempt: t0, busy: false))
        XCTAssertTrue(DiagnosticsPolicy.isDue(now: t0.addingTimeInterval(300), lastAttempt: t0, busy: false))
    }

    func testWhichLogsAreCopied() {
        XCTAssertTrue(DiagnosticsPolicy.shouldCopy(sourceSize: 10, sourceModified: t0, targetSize: nil, lastSuccess: t0), "not in the folder yet")
        XCTAssertTrue(DiagnosticsPolicy.shouldCopy(sourceSize: 10, sourceModified: t0, targetSize: 9, lastSuccess: t0), "another size")
        XCTAssertTrue(DiagnosticsPolicy.shouldCopy(sourceSize: 10, sourceModified: t0.addingTimeInterval(5), targetSize: 10, lastSuccess: t0),
                      "voice-beat.log trimmed back to the same size still changed")
        XCTAssertFalse(DiagnosticsPolicy.shouldCopy(sourceSize: 10, sourceModified: t0, targetSize: 10, lastSuccess: t0.addingTimeInterval(5)))
        XCTAssertTrue(DiagnosticsPolicy.shouldCopy(sourceSize: 10, sourceModified: t0, targetSize: 10, lastSuccess: nil), "first copy this run")
    }

    func testFailureWords() {
        let denied = NSError(domain: NSCocoaErrorDomain, code: NSFileWriteNoPermissionError)
        XCTAssertEqual(DiagnosticsPolicy.classify(denied).state, "disconnected")
        let gone = NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError,
                           userInfo: [NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: Int(ENOENT))])
        XCTAssertEqual(DiagnosticsPolicy.classify(gone), .disconnected("The folder isn’t there any more"))
        XCTAssertEqual(DiagnosticsPolicy.classify(NSError(domain: NSPOSIXErrorDomain, code: Int(EACCES))).state, "disconnected")
        XCTAssertEqual(DiagnosticsPolicy.classify(NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)).state, "failing")
        XCTAssertEqual(DiagnosticsPolicy.classify(NSError(domain: NSCocoaErrorDomain, code: NSFileWriteOutOfSpaceError)),
                       .failing("The iPhone is full"))
        XCTAssertEqual(DiagnosticsPolicy.Health.ok.problem, nil)
        XCTAssertEqual(DiagnosticsPolicy.Health.off.state, "off")
    }
}
