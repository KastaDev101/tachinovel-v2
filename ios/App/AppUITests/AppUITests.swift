//
//  AppUITests.swift — end-to-end UI test on the iOS Simulator (run by ci/ios-ui-tests.sh, job
//  "ios-ui-tests"): first launch → onboarding → restore the synthetic sample backup from Settings ›
//  Backup & Restore → Settings → open the novel → read chapter 1 → Listen with the Apple voice.
//
//  The web UI is reached through accessibility (visible labels and aria-labels), native sheets and
//  alerts directly. Fixtures (tools/ui-fixtures.ts) are synthetic: the demo site at
//  https://novels.example.test/, served on the CI machine. Screenshots are kept as attachments and
//  exported as the "ui-test-screenshots" artifact; on a failure the accessibility tree is attached too.
//

import XCTest

final class AppUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let backup = env["TACHI_UITEST_BACKUP"], !backup.isEmpty else {
            throw XCTSkip("TACHI_UITEST_BACKUP is not set: run through ci/ios-ui-tests.sh")
        }
        app = XCUIApplication()
        // Debug builds place this backup where Backup & Restore lists backups (CoreHost.installUITestBackup).
        app.launchEnvironment["TACHI_UITEST_BACKUP"] = backup
        app.launch()
    }

    func testRestoreReadAndListen() throws {
        let web = app.webViews.firstMatch
        require(web, "the app's web view", timeout: 120)

        // 1. First launch: onboarding.
        tapUntilGone(web, label: "Skip", timeout: 90)
        shot("01-library-first-launch")

        // 2. Restore the sample backup like a user: More › Backup & Restore › the backup › Restore… › Merge.
        tapTab(web, "More")
        tap(web, label: "Backup & Restore")
        tap(web, containing: "tachinovel-backup-2026-10-01-0900", timeout: 30)
        tapNative("Restore…")
        shot("02-restore-sheet")
        tap(web, label: "Merge")
        // The backup lists the demo source: confirm reinstalling it from its site.
        tapNative("Install", timeout: 30)
        require(element(web, containing: "Restored 1 novel"), "the restore confirmation", timeout: 60)
        shot("03-restored")

        // 3. Settings.
        tap(web, label: "Back to More")
        tap(web, label: "General")
        shot("04-settings")
        tap(web, label: "Back to More")

        // 4. Open the novel from the library and read chapter 1 where the backup left off.
        tapTab(web, "Library")
        tap(web, beginning: "Alpha Story", timeout: 30)
        require(element(web, beginning: "Resume"), "the Resume button", timeout: 60)
        shot("05-novel")
        tap(web, beginning: "Resume")
        require(element(web, containing: "Nobody answered"), "chapter 1 text", timeout: 60)
        // First time in the reader: v1 shows its one-time Reading Tips sheet.
        let gotIt = element(web, label: "Got It")
        if gotIt.waitForExistence(timeout: 10) {
            shot("06-reader-tips")
            gotIt.tap()
            XCTAssertTrue(waitUntilGone(gotIt, timeout: 10), "the Reading Tips sheet should close")
        }
        shot("07-reader")

        // 5. Listen (Kokoro, or the system voice while Kokoro loads). "Listen" is in the reader's bottom
        //    bar, which a tap in the middle of the page shows if it has hidden itself.
        let listen = element(web, label: "Listen from here")
        if !(listen.waitForExistence(timeout: 10) && listen.isHittable) {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        tap(web, label: "Listen from here", timeout: 30)
        let pause = element(web, label: "Pause")
        let play = element(web, label: "Play")
        let started = pause.waitForExistence(timeout: 45) || play.exists
        attachTree(if: !started)
        XCTAssertTrue(started, "the narration mini player should show Pause/Play after Listen")
        shot("08-listening")
    }

    // MARK: - Helpers

    private func element(_ root: XCUIElement, label: String) -> XCUIElement {
        root.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func element(_ root: XCUIElement, beginning prefix: String) -> XCUIElement {
        root.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func element(_ root: XCUIElement, containing text: String) -> XCUIElement {
        root.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text)).firstMatch
    }

    private func tap(_ root: XCUIElement, label: String, timeout: TimeInterval = 20) {
        let e = element(root, label: label)
        require(e, "\"\(label)\"", timeout: timeout)
        waitUntilHittable(e)
        e.tap()
    }

    private func tap(_ root: XCUIElement, beginning prefix: String, timeout: TimeInterval = 20) {
        let e = element(root, beginning: prefix)
        require(e, "\"\(prefix)…\"", timeout: timeout)
        waitUntilHittable(e)
        e.tap()
    }

    private func tap(_ root: XCUIElement, containing text: String, timeout: TimeInterval = 20) {
        let e = element(root, containing: text)
        require(e, "\"…\(text)…\"", timeout: timeout)
        waitUntilHittable(e)
        e.tap()
    }

    /// Tap until the element goes away (a tap during a sheet's entrance animation can be swallowed).
    private func tapUntilGone(_ root: XCUIElement, label: String, timeout: TimeInterval = 20) {
        let e = element(root, label: label)
        require(e, "\"\(label)\"", timeout: timeout)
        for _ in 0..<3 {
            waitUntilHittable(e)
            if e.isHittable { e.tap() }
            if waitUntilGone(e, timeout: 5) { return }
        }
        XCTAssertTrue(waitUntilGone(e, timeout: 5), "\"\(label)\" should go away after tapping it")
    }

    /// A pushed screen slides in and a loading page re-lays out: an element can exist before it can be tapped.
    private func waitUntilHittable(_ e: XCUIElement, timeout: TimeInterval = 15) {
        let deadline = Date().addingTimeInterval(timeout)
        while !e.isHittable, Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
    }

    /// A tab bar item: the lowest element on screen with that label ("Library" is also a More row).
    private func tapTab(_ root: XCUIElement, _ name: String, timeout: TimeInterval = 20) {
        let matches = root.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name))
        require(matches.firstMatch, "the \(name) tab", timeout: timeout)
        // Right after a sheet closes or a screen slides, the tab bar can exist before it can be tapped.
        var lowest: XCUIElement?
        let deadline = Date().addingTimeInterval(15)
        repeat {
            lowest = matches.allElementsBoundByIndex.filter { $0.isHittable }.max { $0.frame.minY < $1.frame.minY }
            if lowest == nil { RunLoop.current.run(until: Date().addingTimeInterval(0.25)) }
        } while lowest == nil && Date() < deadline
        (lowest ?? matches.firstMatch).tap()
    }

    /// A button in a native action sheet or alert (UIAlertController).
    private func tapNative(_ title: String, timeout: TimeInterval = 20) {
        let inSheet = app.sheets.buttons[title]
        let inAlert = app.alerts.buttons[title]
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if inSheet.exists { return inSheet.tap() }
            if inAlert.exists { return inAlert.tap() }
            _ = app.buttons[title].waitForExistence(timeout: 0.5)
        }
        let anywhere = app.buttons[title]
        require(anywhere, "native button \"\(title)\"", timeout: 1)
        anywhere.tap()
    }

    private func require(_ e: XCUIElement, _ what: String, timeout: TimeInterval) {
        if e.waitForExistence(timeout: timeout) { return }
        attachTree(if: true)
        shot("failed-waiting-for-\(what.filter { $0.isLetter || $0.isNumber })")
        XCTFail("Timed out after \(Int(timeout)) s waiting for \(what)")
    }

    private func waitUntilGone(_ e: XCUIElement, timeout: TimeInterval) -> Bool {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: e)
        return XCTWaiter().wait(for: [gone], timeout: timeout) == .completed
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attachTree(if condition: Bool) {
        guard condition else { return }
        let attachment = XCTAttachment(string: app.debugDescription)
        attachment.name = "accessibility-tree"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
