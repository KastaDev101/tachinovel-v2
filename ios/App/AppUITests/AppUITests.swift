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
        checkControlsLabeled("Library")

        // 2. Restore the sample backup like a user: More › Backup & Restore › the backup › Restore… › Merge.
        try step("restore") {
            let backupRow = element(containing: "tachinovel-backup-2026-10-01-0900")
            try tapTab("More", until: element(label: "Backup & Restore"))
            checkControlsLabeled("More")
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
            checkControlsLabeled("Settings")
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
            checkControlsLabeled("Reader with the mini player")
        }

        // Reported at the end so one run shows every screen's findings (the flow stops at a failure).
        let unlabeled = unlabeledControls.keys.sorted().flatMap { unlabeledControls[$0] ?? [] }
        attachTree(if: !unlabeled.isEmpty)
        XCTAssertTrue(unlabeled.isEmpty, "controls without a VoiceOver label:\n\(unlabeled.joined(separator: "\n"))")
    }

    /// Native-only surfaces with real taps (docs/ui-tests.md). Runs after testRestoreReadAndListen
    /// (alphabetical order), which restores the sample backup it uses.
    func testSystemSheetsAndListenControls() throws {
        try nativeSurfaces()
    }

    private func readChapterOne() throws {
        let novel = element(beginning: "Alpha Story")
        let resume = element(beginning: "Resume")
        let text = element(containing: "Nobody answered")
        try tapTab("Library", until: novel)
        try tap(novel, "\"Alpha Story…\"", timeout: 30, until: resume)
        try require(resume, "the Resume button", timeout: 60)
        shot("05-novel")
        checkControlsLabeled("Novel")
        try tap(resume, "\"Resume…\"", until: text)
        try require(text, "chapter 1 text", timeout: 60)
        // First time in the reader: v1 shows its one-time Reading Tips sheet.
        let gotIt = element(label: "Got It")
        if gotIt.waitForExistence(timeout: 10) {
            shot("06-reader-tips")
            try tap(gotIt, "\"Got It\"", untilGone: true)
        }
        shot("07-reader")
        checkControlsLabeled("Reader")
    }

    // MARK: - Accessibility

    /// Findings per screen (a repeated step replaces its screen's entry).
    private var unlabeledControls: [String: [String]] = [:]

    /// Every control on screen has a VoiceOver label (WebKit's accessibility tree for the web UI, UIKit's
    /// for native views), so VoiceOver never announces a bare "button". One snapshot of the whole app per
    /// screen, which stays fast with long web lists. tests/shell/a11y.shell.ts checks the same on the PC.
    private func checkControlsLabeled(_ screen: String) {
        guard let root = try? app.snapshot() else {
            unlabeledControls[screen] = ["\(screen): no accessibility snapshot"]
            return
        }
        let named: Set<XCUIElement.ElementType> = [.button, .link, .switch, .checkBox, .slider, .stepper, .segmentedControl, .tab]
        let fields: Set<XCUIElement.ElementType> = [.textField, .secureTextField, .searchField, .textView]
        let screenFrame = app.frame
        var checked = 0
        var found: [String] = []
        func visit(_ e: XCUIElementSnapshot) {
            let isField = fields.contains(e.elementType)
            if named.contains(e.elementType) || isField, !e.frame.isEmpty, screenFrame.intersects(e.frame) {
                checked += 1
                let label = e.label.trimmingCharacters(in: .whitespacesAndNewlines)
                let placeholder = e.placeholderValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if label.isEmpty, !(isField && !placeholder.isEmpty) {
                    found.append("\(screen): element type \(e.elementType.rawValue), id \"\(e.identifier)\", at \(e.frame.integral)")
                }
            }
            e.children.forEach(visit)
        }
        visit(root)
        if checked == 0 { found.append("\(screen): no controls in the accessibility tree") }
        unlabeledControls[screen] = found
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

// MARK: - Native surfaces (testSystemSheetsAndListenControls)

extension AppUITests {
    private func nativeSurfaces() throws {
        try require(web, "the app's web view", timeout: 120)
        let novel = element(beginning: "Alpha Story")
        try step("library") {
            let skip = element(label: "Skip")
            if try appears(skip, timeout: 15) { try tap(skip, "\"Skip\"", untilGone: true) }
            try require(novel, "the restored sample novel (run after testRestoreReadAndListen)", timeout: 15)
        }
        try documentPicker()
        try step("share sheet") {
            try toMoreRoot()
            try tapTab("Library", until: novel)
            try tap(novel, "\"Alpha Story…\"", timeout: 30, until: element(beginning: "Resume"))
            try shareSheet()
        }
        try step("reader settings") { try readerSettings() }
        try step("listen and the car player") { try listenControls() }
        XCTAssertEqual(app.state, .runningForeground, "the app should still be running")
    }

    /// More › Backup & Restore › Restore from Files…: the picker's Cancel, then the picker swiped down.
    private func documentPicker() throws {
        let restoreFromFiles = element(label: "Restore from Files…")
        let pickerCancel = app.buttons["Cancel"]
        try step("document picker: Cancel") {
            try toBackupAndRestore(until: restoreFromFiles)
            try tapOnce(restoreFromFiles, "\"Restore from Files…\"", timeout: 30)
            requireSystem(pickerCancel, "the document picker", timeout: 30)
            shot("10-document-picker")
            tapSystem(pickerCancel, "the document picker's Cancel")
            XCTAssertTrue(waitUntilGone(pickerCancel, timeout: 15), "Cancel should close the document picker")
        }
        try step("document picker: swipe down") {
            try toBackupAndRestore(until: restoreFromFiles)
            try tapOnce(restoreFromFiles, "\"Restore from Files…\"", timeout: 30)
            requireSystem(pickerCancel, "the document picker (second time)", timeout: 30)
            swipeDownSheet()
            XCTAssertTrue(waitUntilGone(pickerCancel, timeout: 15), "a swipe down should close the document picker")
            // No delegate call for a swipe: the app must still answer, or no popup appears again (the backup's
            // action sheet is next). Taps during the dismissal animation are dropped: wait, tap again if needed.
            Thread.sleep(forTimeInterval: 1.5)
            let backupRow = element(containing: "tachinovel-backup-2026-10-01-0900")
            try tapOnce(backupRow, "the sample backup", timeout: 30)
            if try !waitForNative("Restore…", timeout: 10) {
                print("UITEST-RETRY tap the sample backup: no action sheet after 10 s")
                try tapOnce(backupRow, "the sample backup", timeout: 10)
            }
            guard try waitForNative("Restore…", timeout: 20) else {
                attachTree(if: true)
                shot("failed-action-sheet-after-swipe")
                return XCTFail("The backup's action sheet did not appear after the swiped-away document picker (popup queue stuck)")
            }
            shot("11-action-sheet-after-swipe")
            dismissActionSheet()
            XCTAssertTrue(waitUntilGone(nativeButton("Restore…"), timeout: 10), "the action sheet should close")
            // Both taps may have registered: a second sheet follows the first.
            if try waitForNative("Restore…", timeout: 3) { dismissActionSheet() }
        }
    }

    /// Novel page › Share › close it: Close, or a tap outside (iOS 26 shows a popover without Close).
    private func shareSheet() throws {
        try tapOnce(element(label: "Share"), "\"Share\"", timeout: 20)
        let sheet = app.otherElements["ActivityListView"]
        requireSystem(sheet, "the share sheet", timeout: 20)
        shot("12-share-sheet")
        let close = app.buttons["Close"]
        let outside = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
        if close.exists { tapSystem(close, "the share sheet's Close") } else { outside.tap() }
        XCTAssertTrue(waitUntilGone(sheet, timeout: 15), "the share sheet should close")
        try require(element(beginning: "Resume"), "the novel page after the share sheet", timeout: 15)
    }

    /// Into the reader at chapter 1 from the novel page, or from the tab bar after a page reload.
    private func toReader() throws {
        let text = element(containing: "Nobody answered")
        if text.exists { return }
        let resume = element(beginning: "Resume")
        if !resume.exists {
            let novel = element(beginning: "Alpha Story")
            try tapTab("Library", until: novel)
            try tap(novel, "\"Alpha Story…\"", timeout: 30, until: resume)
        }
        try tap(resume, "\"Resume…\"", until: text)
    }

    /// Reader › Appearance: the Brightness slider and Keep screen awake (both call native code).
    private func readerSettings() throws {
        try toReader()
        let gotIt = element(label: "Got It")
        if gotIt.waitForExistence(timeout: 5) { try tap(gotIt, "\"Got It\"", untilGone: true) }
        let appearance = element(label: "Appearance")
        if !appearance.waitForExistence(timeout: 5) { web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() } // bars back
        let brightness = web.sliders["Brightness"]
        try tap(appearance, "\"Appearance\"", timeout: 15, until: brightness)
        // A web range input can't be adjust()ed: drag its thumb from 60 % (the default) to 30 %.
        brightness.coordinate(withNormalizedOffset: CGVector(dx: 0.58, dy: 0.5))
            .press(forDuration: 0.2, thenDragTo: brightness.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)))
        let keepAwake = element(label: "Keep screen awake")
        let sheetLow = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        let sheetHigh = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        for _ in 0..<4 where !keepAwake.isHittable { sheetLow.press(forDuration: 0.05, thenDragTo: sheetHigh) } // lower in the sheet
        try tapOnce(keepAwake, "\"Keep screen awake\"", timeout: 10)
        shot("13-reader-settings")
        // Close the sheet: its Close (shown once it is dragged to full height), or a tap on the page above it.
        let closeSheet = element(label: "Close"), above = web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
        if closeSheet.exists { try tapOnce(closeSheet, "the Appearance sheet's Close", timeout: 5) } else { above.tap() }
        XCTAssertTrue(waitUntilGone(brightness, timeout: 10), "the Appearance sheet should close")
    }

    /// Listen: the mini player's Pause/Play, the car player's controls and Close, then Stop.
    private func listenControls() throws {
        try toReader()
        let (pause, play) = (element(label: "Pause"), element(label: "Play"))
        if !pause.exists, !play.exists {
            // "Listen from here" is in the reader's bottom bar: a tap in the middle of the page shows the bars.
            let listen = element(label: "Listen from here")
            if !(listen.waitForExistence(timeout: 10) && listen.isHittable) {
                web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            }
            try tapOnce(listen, "\"Listen from here\"", timeout: 30)
        }
        try require(pause, "the mini player's Pause", timeout: 45)
        for label in ["Pause", "Play", "Pause"] { // ends paused: the short demo chapter can't finish meanwhile
            try tapOnce(element(label: label), "the mini player's \(label)", timeout: 15)
        }
        try require(play, "Play after Pause", timeout: 15)
        try tap(element(label: "Open the Listen player"), "the reader's Player", until: element(label: "Forward 15 seconds"))
        // Stay inside the car player's dialog (the reader under it has its own "Next chapter").
        let car = web.otherElements["Car player"].exists ? web.otherElements["Car player"] : web
        shot("14-car-player")
        for control in ["1.25×", "Play", "Pause", "Back 15 seconds", "Forward 15 seconds"] { // Forward last: it can end the demo chapter
            try tapOnce(inside(car, label: control), "the car player's \(control)", timeout: 15)
        }
        let next = inside(car, label: "Next chapter") // only while narration is still on (chapter 3 is locked)
        if next.waitForExistence(timeout: 3) { try tapOnce(next, "the car player's Next chapter", timeout: 5) }
        try tap(inside(car, label: "Close"), "the car player's Close", timeout: 10, untilGone: true)
        let stop = element(label: "Stop") // gone already if narration ended
        if stop.waitForExistence(timeout: 5) { try tap(stop, "the mini player's Stop", timeout: 15, untilGone: true) }
    }

    private func toBackupAndRestore(until row: XCUIElement) throws {
        if row.exists { return }
        try toMoreRoot()
        try tap(element(label: "Backup & Restore"), "\"Backup & Restore\"", until: row)
    }

    private func inside(_ root: XCUIElement, label: String) -> XCUIElement {
        root.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// A system sheet's element, without checkPage (under a sheet the page may be hidden from accessibility).
    private func requireSystem(_ e: XCUIElement, _ what: String, timeout: TimeInterval) {
        if e.waitForExistence(timeout: timeout) { return }
        attachTree(if: true)
        shot("failed-waiting-for-\(what.filter { $0.isLetter || $0.isNumber })")
        XCTFail("Timed out after \(Int(timeout)) s waiting for \(what)")
    }

    /// A system sheet's button, once it has settled.
    private func tapSystem(_ e: XCUIElement, _ what: String) {
        requireSystem(e, what, timeout: 10)
        if let frame = settledFrame(e), !e.isHittable {
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX, dy: frame.midY)).tap()
        } else {
            e.tap()
        }
    }

    /// Closes an action sheet: Cancel, or a tap outside (iOS 26 shows a compact menu without Cancel).
    private func dismissActionSheet() {
        let cancel = app.sheets.buttons["Cancel"]
        let outside = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
        if cancel.waitForExistence(timeout: 2) { cancel.tap() } else { outside.tap() }
    }

    /// A swipe down from the top of a page sheet (document picker).
    private func swipeDownSheet() {
        let window = app.windows.firstMatch
        let bottom = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95))
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
            .press(forDuration: 0.05, thenDragTo: bottom, withVelocity: .fast, thenHoldForDuration: 0)
    }
}
