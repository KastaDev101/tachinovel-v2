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
//  Hardened against the CI simulator (docs/ui-tests.md "Flakiness"):
//   - a tap waits until its element stops moving (push animations): the same frame twice in a row with
//     its center on screen, then a tap by element (at that fresh frame's center if XCUITest calls the
//     element not hittable);
//   - taps that are safe to repeat check that they worked (the next element appears, or the tapped one
//     goes away) and tap again from a fresh snapshot if not;
//   - when the web view loses its page after showing it (the WebContent process ended; the app reloads
//     it and rebuilds its screen stack), the test waits for the reload, keeps screenshots and the
//     accessibility tree, prints "UITEST-WEB-RECOVERED" for the CI log, goes back to the tab bar and
//     starts the current step over.
//

import XCTest

/// The web view lost its page and reloaded it: the running step starts over.
private struct WebContentReset: Error {
    let step: String
}

final class AppUITests: XCTestCase {
    private var app: XCUIApplication!
    private var web: XCUIElement { app.webViews.firstMatch }
    /// Set once the page has shown content: before that, a blank web view is just the first load.
    private var pageSeen = false
    private var currentStep = "launch"

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
        // Not `require`: the web view exists long before its page has content (pageSeen stays false).
        if !web.waitForExistence(timeout: 120) {
            attachTree(if: true)
            return XCTFail("Timed out after 120 s waiting for the app's web view")
        }

        // 1. First launch: onboarding.
        try step("onboarding") {
            try tap(element(label: "Skip"), "\"Skip\"", timeout: 90, untilGone: true)
        }
        shot("01-library-first-launch")

        // 2. Restore the sample backup like a user: More › Backup & Restore › the backup › Restore… › Merge.
        try step("restore") {
            let backupRow = element(containing: "tachinovel-backup-2026-10-01-0900")
            try tapTab("More", until: element(label: "Backup & Restore"))
            try tap(element(label: "Backup & Restore"), "\"Backup & Restore\"", until: backupRow)
            try tap(backupRow, "the sample backup", timeout: 30, until: app.buttons["Restore…"])
            try tapNative("Restore…", until: element(label: "Merge"))
            shot("02-restore-sheet")
            try tap(element(label: "Merge"), "\"Merge\"")
            // The backup lists the demo source: confirm reinstalling it from its site. (When the step runs
            // again after a page reload, the source is already installed and the app doesn't ask.)
            let restored = element(containing: "Restored 1 novel")
            if try waitForNative("Install", or: restored, timeout: 30) { try tapNative("Install") }
            try require(restored, "the restore confirmation", timeout: 60)
        }
        shot("03-restored")

        // 3. Settings.
        try step("settings") {
            try toMoreRoot()
            try tap(element(label: "General"), "\"General\"", until: element(label: "Back to More"))
            shot("04-settings")
            try tap(element(label: "Back to More"), "\"Back to More\"", untilGone: true)
        }

        // 4. Open the novel from the library, read chapter 1 where the backup left off, and listen (Kokoro, or
        //    the system voice while Kokoro loads). One step: after a page reload it all starts over.
        try step("read and listen") {
            try readChapterOne()
            let pause = element(label: "Pause")
            let play = element(label: "Play")
            // "Listen" is in the reader's bottom bar, which a tap in the middle of the page shows if it hid.
            let listen = element(label: "Listen from here")
            if !listen.waitForExistence(timeout: 10) || settledFrame(listen, timeout: 2) == nil {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            }
            try tap(listen, "\"Listen from here\"", timeout: 30)
            let started = try appears(pause, timeout: 45) || play.exists
            attachTree(if: !started)
            XCTAssertTrue(started, "the narration mini player should show Pause/Play after Listen")
            shot("08-listening")
        }
    }

    private func readChapterOne() throws {
        let novel = element(beginning: "Alpha Story")
        let resume = element(beginning: "Resume")
        let text = element(containing: "Nobody answered")
        try tapTab("Library", until: novel)
        try tap(novel, "\"Alpha Story…\"", timeout: 30, until: resume)
        try require(resume, "the Resume button", timeout: 60)
        shot("05-novel")
        try tap(resume, "\"Resume…\"", until: text)
        try require(text, "chapter 1 text", timeout: 60)
        // First time in the reader: v1 shows its one-time Reading Tips sheet.
        let gotIt = element(label: "Got It")
        if gotIt.waitForExistence(timeout: 10) {
            shot("06-reader-tips")
            try tap(gotIt, "\"Got It\"", untilGone: true)
        }
        shot("07-reader")
    }

    // MARK: - Steps and page reloads

    /// Runs `body`; when the web view reloaded its page meanwhile, runs `body` again (up to `attempts`).
    private func step(_ name: String, attempts: Int = 3, _ body: () throws -> Void) throws {
        for attempt in 1...attempts {
            currentStep = name
            do {
                try body()
                return
            } catch let reset as WebContentReset where attempt < attempts {
                XCTContext.runActivity(named: "Page reloaded during \"\(reset.step)\": step \"\(name)\" again") { _ in }
                // A reload before onboarding was saved shows it again.
                let skip = element(label: "Skip")
                if skip.waitForExistence(timeout: 5) { try tap(skip, "\"Skip\"", untilGone: true) }
                try backToTabs()
            }
        }
    }

    /// After a reload the app rebuilds its screen stack (src/ui/native/recovery.ts), but steps start from
    /// the tab bar: go back until it shows (a tap in the middle shows the reader's hidden bars first).
    private func backToTabs() throws {
        let screen = app.frame
        let back = web.descendants(matching: .any).matching(NSPredicate(format: "label == 'Back' OR label BEGINSWITH 'Back to '")).firstMatch
        let tabBar = web.descendants(matching: .any).matching(NSPredicate(format: "label == 'Library'"))
        for _ in 0..<8 {
            let tabShows = tabBar.allElementsBoundByIndex.contains { (try? $0.snapshot().frame.midY).map { $0 > screen.height * 0.7 } ?? false }
            if tabShows, !back.exists { return }
            if back.waitForExistence(timeout: 3) {
                try tapOnce(back, "the back button", timeout: 5)
                Thread.sleep(forTimeInterval: 0.8) // the pop animation
            } else if !tabShows {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            } else {
                return
            }
        }
    }

    /// No text a person could read in the web view (scroll bars don't count): the page is gone.
    private func webIsBlank() -> Bool {
        guard let root = try? web.snapshot() else { return false }
        var labeled = false
        func visit(_ s: XCUIElementSnapshot) {
            if labeled { return }
            let label = s.label.trimmingCharacters(in: .whitespacesAndNewlines)
            if !label.isEmpty, !label.localizedCaseInsensitiveContains("scroll bar") { labeled = true }
            s.children.forEach(visit)
        }
        visit(root)
        return !labeled
    }

    /// Throws WebContentReset when the page went blank after it had been seen (after waiting for the reload).
    private func checkPage() throws {
        guard pageSeen, webIsBlank() else { return }
        let started = Date()
        let tag = currentStep.filter { $0.isLetter }
        shot("blank-web-view-\(tag)")
        attachTree(if: true)
        while Date().timeIntervalSince(started) < 150 {
            if !webIsBlank() {
                print("UITEST-WEB-RECOVERED step=\"\(currentStep)\" after=\(Int(Date().timeIntervalSince(started)))s")
                shot("recovered-web-view-\(tag)")
                throw WebContentReset(step: currentStep)
            }
            Thread.sleep(forTimeInterval: 1)
        }
        print("UITEST-WEB-BLANK step=\"\(currentStep)\" (no reload within 150 s)")
        XCTFail("The web view went blank during \"\(currentStep)\" and did not reload its page within 150 s")
        throw WebContentReset(step: currentStep)
    }

    /// waitForExistence that notices when the page went away meanwhile.
    private func appears(_ e: XCUIElement, timeout: TimeInterval) throws -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if e.waitForExistence(timeout: min(2, max(0.1, deadline.timeIntervalSinceNow))) {
                pageSeen = true
                return true
            }
            try checkPage()
        } while Date() < deadline
        return false
    }

    private func require(_ e: XCUIElement, _ what: String, timeout: TimeInterval) throws {
        if try appears(e, timeout: timeout) { return }
        attachTree(if: true)
        shot("failed-waiting-for-\(what.filter { $0.isLetter || $0.isNumber })")
        XCTFail("Timed out after \(Int(timeout)) s waiting for \(what)")
    }

    // MARK: - Taps

    /// The element's frame once it stops moving: the same frame twice, 150 ms apart, its center on screen.
    private func settledFrame(_ e: XCUIElement, timeout: TimeInterval = 10) -> CGRect? {
        let screen = app.frame
        let deadline = Date().addingTimeInterval(timeout)
        var last: CGRect?
        while Date() < deadline {
            if let f = try? e.snapshot().frame, !f.isEmpty, screen.contains(CGPoint(x: f.midX, y: f.midY)) {
                if let last, abs(last.minX - f.minX) < 0.5, abs(last.minY - f.minY) < 0.5, abs(last.width - f.width) < 0.5 {
                    return f
                }
                last = f
            } else {
                last = nil
            }
            Thread.sleep(forTimeInterval: 0.15)
        }
        return nil
    }

    /// One tap once the element has settled: by element, or at its fresh frame's center when XCUITest
    /// calls it not hittable.
    private func tapOnce(_ e: XCUIElement, _ what: String, timeout: TimeInterval) throws {
        try require(e, what, timeout: timeout)
        guard let frame = settledFrame(e) else {
            try checkPage()
            attachTree(if: true)
            return XCTFail("\(what) never stopped moving, or stayed off screen")
        }
        if e.exists, e.isHittable {
            e.tap()
        } else {
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX, dy: frame.midY)).tap()
        }
    }

    /// Taps `e`. With `until` (or `untilGone`) the tap must show its effect, else it is repeated from a
    /// fresh snapshot (3 tries). Only for taps that are safe to repeat (navigation, dismissing).
    private func tap(_ e: XCUIElement, _ what: String, timeout: TimeInterval = 20, until next: XCUIElement? = nil,
                     untilGone: Bool = false) throws {
        for attempt in 1...3 {
            try tapOnce(e, what, timeout: timeout)
            if let next {
                if try appears(next, timeout: 10) { return }
            } else if untilGone {
                if waitUntilGone(e, timeout: 10) { return }
                try checkPage()
            } else {
                return
            }
            print("UITEST-RETRY tap \(what): attempt \(attempt) had no effect")
        }
        attachTree(if: true)
        XCTFail("Tapping \(what) 3 times had no effect")
    }

    /// A tab bar item: the lowest element with that label in the bottom of the screen ("Library" is also
    /// a More row).
    private func tapTab(_ name: String, until next: XCUIElement) throws {
        let matches = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name))
        try require(matches.firstMatch, "the \(name) tab", timeout: 20)
        let screen = app.frame
        let tabs = matches.allElementsBoundByIndex.compactMap { el -> (XCUIElement, CGRect)? in
            guard let f = try? el.snapshot().frame, f.midY > screen.height * 0.7 else { return nil }
            return (el, f)
        }
        let tab = tabs.max { $0.1.minY < $1.1.minY }?.0 ?? matches.firstMatch
        try tap(tab, "the \(name) tab", until: next)
    }

    /// To the More screen: back from one of its sub-screens, or through the tab bar.
    private func toMoreRoot() throws {
        let back = element(label: "Back to More")
        if back.waitForExistence(timeout: 2) {
            try tap(back, "\"Back to More\"", untilGone: true)
        } else {
            try tapTab("More", until: element(label: "General"))
        }
    }

    /// A button in a native action sheet or alert (UIAlertController).
    private func nativeButton(_ title: String) -> XCUIElement {
        for button in [app.sheets.buttons[title], app.alerts.buttons[title]] where button.exists { return button }
        return app.buttons[title]
    }

    /// True when the native button shows up, false when `other` does first (or neither within `timeout`).
    private func waitForNative(_ title: String, or other: XCUIElement? = nil, timeout: TimeInterval) throws -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.sheets.buttons[title].exists || app.alerts.buttons[title].exists || app.buttons[title].exists { return true }
            if other?.exists == true { return false }
            try checkPage()
            Thread.sleep(forTimeInterval: 0.5)
        }
        return false
    }

    /// Taps a native sheet or alert button once its slide-in has finished.
    private func tapNative(_ title: String, timeout: TimeInterval = 20, until next: XCUIElement? = nil) throws {
        guard try waitForNative(title, timeout: timeout) else {
            attachTree(if: true)
            shot("failed-waiting-for-native\(title.filter { $0.isLetter })")
            return XCTFail("Timed out after \(Int(timeout)) s waiting for native button \"\(title)\"")
        }
        try tap(nativeButton(title), "native button \"\(title)\"", timeout: 5, until: next)
    }

    // MARK: - Queries and evidence

    private func element(label: String) -> XCUIElement {
        web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func element(beginning prefix: String) -> XCUIElement {
        web.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func element(containing text: String) -> XCUIElement {
        web.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text)).firstMatch
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
