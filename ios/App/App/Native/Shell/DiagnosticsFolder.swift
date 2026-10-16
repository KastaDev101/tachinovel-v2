//
//  DiagnosticsFolder.swift — the phone QA loop (opt-in). The user picks a folder once in More › About ›
//  Diagnostics › Diagnostics Folder (for example iCloud Drive › TachiNovel-Diagnostics; kept as a security-scoped
//  bookmark, so no iCloud entitlement is needed). Then the device log (logs/app.log, app.1.log), everything else
//  under logs/ (voice-beat.log, MetricKit crash and hang reports, saved problem reports, …), the app's own os_log
//  lines (native.log), the Voice Lab numbers, the UI's short event trail, a status file and a storage map
//  (storage.json, at most every half hour) are copied into that folder, where iCloud syncs them to the PC:
//   - at launch, every five minutes while the app runs and every 10 minutes while a voice works (Listen, a Voice test,
//     Drive prep: heat batch 1, every minute before), right after a voice stops working (the end of a Voice test or a drive), when the app goes to the
//     background or is closed, and on "Copy Diagnostics Now" (DiagnosticsPolicy in ExpressiveCore decides);
//   - "Report a Problem" (the row's menu, or shaking the phone) keeps logs/reports/<time>/ on the iPhone (what the
//     user typed, a screenshot, the log tails, the versions and the current route) and copies it over, so a report
//     made while the folder doesn't work arrives once it does.
//  Kasta 2026-10-13, nothing arrived for a morning: the copy waited on the web page, which sleeps while the app is in
//  the background (the copy at backgrounding and every copy during Listen in the car never finished); there was no
//  copy at launch; and a failed copy (a link broken by a reinstall, iCloud Drive not answering) was only an os_log
//  line. Now the page is asked with a 2 s limit (the last answer is used in the background), the core's log flush
//  with a 3 s limit, each coordinated write with a 20 s limit, and every outcome is kept: the row, the menu and a
//  toast say "Disconnected — tap to reconnect" when the folder can't be reached any more.
//  Everything is small and rate-limited; reading data beyond novel titles and routes never leaves the app.
//  The web side is src/ui/native/qa-folder.ts; the plugin is DiagFolderPlugin.swift.
//

@preconcurrency import Capacitor
import ExpressiveCore
import OSLog
import UIKit
import UniformTypeIdentifiers
import WebKit

@MainActor
final class DiagnosticsFolder: NSObject, UIDocumentPickerDelegate {
    static let shared = DiagnosticsFolder()
    private static let bookmarkKey = "tachinovel.diagnosticsFolderBookmark"
    private static let nameKey = "tachinovel.diagnosticsFolderName"
    private static let successKey = "tachinovel.diagnosticsFolderLastSuccess"
    private static let stateKey = "tachinovel.diagnosticsFolderState"
    private static let problemKey = "tachinovel.diagnosticsFolderProblem"
    /// Why iCloud doesn't take the files (UploadCheck); since when copies sit un-uploaded (a problem after `uploadPatience`).
    private static let uploadKey = "tachinovel.diagnosticsFolderUpload"
    private static let pendingKey = "tachinovel.diagnosticsFolderPendingSince"
    private static let uploadPatience: TimeInterval = 20 * 60
    private static let reportInterval: TimeInterval = 30
    private static let tickInterval: TimeInterval = 15

    private enum Link {
        case unlinked
        case ok(URL)
        case broken(String)
    }

    private weak var webView: WKWebView?
    private var lastAttempt: Date?
    private var lastStorage: Date?
    private var lastReport: Date?
    private var copying = false
    private var again = false
    private var waiting: [@Sendable () -> Void] = []
    private var wasWorking = false
    private var started = false
    private var page = (trail: "[]", route: "null")
    private var pickDone: ((Bool) -> Void)?
    private var pickFinished: (() -> Void)?
    private var backgroundTask = UIBackgroundTaskIdentifier.invalid

    // MARK: Setup

    func start(webView: WKWebView?) {
        self.webView = webView
        guard !started else { return }
        started = true
        let timer = Timer(timeInterval: Self.tickInterval, repeats: true) { _ in
            Task { @MainActor in DiagnosticsFolder.shared.tick() }
        }
        timer.tolerance = 5
        RunLoop.main.add(timer, forMode: .common)
        let nc = NotificationCenter.default
        _ = nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in await DiagnosticsFolder.shared.refreshPage() }
        }
        _ = nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in DiagnosticsFolder.shared.mirrorInBackground() }
        }
        _ = nc.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in DiagnosticsFolder.shared.mirrorInBackground() }
        }
        // At launch, once the page has had a moment to load its trail.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            Task { @MainActor in DiagnosticsFolder.shared.mirror(force: true) }
        }
    }

    /// Every 15 s: a copy when one is due, and right after a voice stops working (a Voice test or a drive ended).
    private func tick() {
        let working = VoiceRun.shared.working
        let stopped = wasWorking && !working
        wasWorking = working
        let quiet = lastAttempt.map { Date().timeIntervalSince($0) >= 15 } ?? true
        if stopped, quiet { return mirror(force: true) }
        if DiagnosticsPolicy.isDue(now: Date(), lastAttempt: lastAttempt, busy: working) { mirror(force: false) }
    }

    // MARK: Folder

    private func resolveLink() -> Link {
        guard let data = UserDefaults.standard.data(forKey: Self.bookmarkKey) else { return .unlinked }
        var stale = false
        do {
            let url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            // A bookmark follows the folder itself: one moved to Recently Deleted, or gone, still resolves (2026-10-15).
            if url.path.contains("/.Trash/") { return .broken("The folder is in Recently Deleted") }
            if (try? url.checkResourceIsReachable()) != true { return .broken("The folder can’t be found any more (moved or deleted?)") }
            if stale {
                do {
                    let fresh = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
                    UserDefaults.standard.set(fresh, forKey: Self.bookmarkKey)
                    UserDefaults.standard.set(url.lastPathComponent, forKey: Self.nameKey)
                } catch {
                    return .broken("The link to the folder is out of date (\(error.localizedDescription))")
                }
            }
            return .ok(url)
        } catch {
            return .broken("The link to the folder broke (\(error.localizedDescription)): this happens after some reinstalls, "
                + "or when the folder was moved or deleted")
        }
    }

    /// The linked folder, when the link still works.
    var folderURL: URL? {
        if case .ok(let url) = resolveLink() { return url }
        return nil
    }

    private var lastSuccess: Date? {
        get {
            let t = UserDefaults.standard.double(forKey: Self.successKey)
            return t > 0 ? Date(timeIntervalSince1970: t) : nil
        }
        set { UserDefaults.standard.set(newValue?.timeIntervalSince1970 ?? 0, forKey: Self.successKey) }
    }

    /// How the folder is doing (kept across launches, so a failure before a relaunch still shows).
    private var health: DiagnosticsPolicy.Health {
        switch resolveLink() {
        case .unlinked: return .off
        case .broken(let why): return .disconnected(why)
        case .ok:
            let d = UserDefaults.standard
            let why = d.string(forKey: Self.problemKey) ?? ""
            switch d.string(forKey: Self.stateKey) {
            case "disconnected": return .disconnected(why)
            case "failing": return .failing(why)
            default: return .ok
            }
        }
    }

    private func forgetUpload() {
        UserDefaults.standard.removeObject(forKey: Self.uploadKey)
        UserDefaults.standard.removeObject(forKey: Self.pendingKey)
    }

    private func record(_ h: DiagnosticsPolicy.Health) {
        let d = UserDefaults.standard
        d.set(h.state, forKey: Self.stateKey)
        d.set(h.problem, forKey: Self.problemKey)
    }

    private var folderName: String? { folderURL?.lastPathComponent ?? UserDefaults.standard.string(forKey: Self.nameKey) }

    /// Why iCloud doesn't take the folder's files, in words; nil while it does (or nothing is linked).
    var uploadProblem: String? {
        guard isLinked else { return nil }
        return UserDefaults.standard.string(forKey: Self.uploadKey)
    }

    /// Whether a link was made (it may be broken: `folderURL` is nil then).
    var isLinked: Bool { UserDefaults.standard.data(forKey: Self.bookmarkKey) != nil }

    /// "iCloud Drive › TachiNovel-Diagnostics", or the folder's name alone when its place is unknown.
    private var folderPlace: String? {
        guard let url = folderURL else { return folderName }
        return DiagnosticsFiles.place(url).map { "\($0) › \(url.lastPathComponent)" } ?? url.lastPathComponent
    }

    func statusDict() -> [String: Any] {
        let h = health
        return [
            "upload": uploadProblem.map { $0 as Any } ?? NSNull(),
            "place": folderPlace.map { $0 as Any } ?? NSNull(),
            "linked": isLinked,
            "name": folderName.map { $0 as Any } ?? NSNull(),
            "lastMirror": lastSuccess.map { $0.timeIntervalSince1970 * 1000 as Any } ?? NSNull(),
            "state": h.state,
            "problem": h.problem.map { $0 as Any } ?? NSNull(),
        ]
    }

    private func pickFolder(done: @escaping (Bool) -> Void) {
        PresentationQueue.shared.enqueue({ host, finished in
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.pickDone = done
            self.pickFinished = finished
            host.present(picker, animated: true)
            return picker
        }, cancel: { done(false) })
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        var ok = false
        if let url = urls.first {
            let accessing = url.startAccessingSecurityScopedResource()
            if let data = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                UserDefaults.standard.set(data, forKey: Self.bookmarkKey)
                UserDefaults.standard.set(url.lastPathComponent, forKey: Self.nameKey)
                forgetUpload()
                record(.ok)
                ok = true
            }
            if accessing { url.stopAccessingSecurityScopedResource() }
        }
        finishPick(ok)
        if ok { mirror(force: true) }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finishPick(false)
    }

    private func finishPick(_ ok: Bool) {
        let done = pickDone
        let finished = pickFinished
        pickDone = nil
        pickFinished = nil
        done?(ok)
        finished?()
    }

}

@MainActor
extension DiagnosticsFolder {
    // MARK: Menu (More › About › Diagnostics › Diagnostics Folder)

    private func clock(_ date: Date) -> String {
        let f = DateFormatter()
        f.doesRelativeDateFormatting = true
        f.dateStyle = .short
        f.timeStyle = .short
        return f.string(from: date)
    }

    private func menuMessage() -> String {
        let name = folderPlace.map { "“\($0)”" } ?? "the folder"
        let last = lastSuccess.map { " Last copy that worked: \(clock($0))." } ?? ""
        let upload = uploadProblem.map { " But \($0): the PC won’t see them until that’s fixed (Settings › your name › iCloud)." } ?? ""
        switch health {
        case .off:
            return "Pick a folder, for example iCloud Drive › TachiNovel-Diagnostics. The app log, crash reports and problem reports "
                + "are copied there at launch, every few minutes, when Listen or a Voice test stops and when you leave the app."
        case .ok:
            return "Logs, crash reports and problem reports go to \(name).\(last)\(upload)"
        case .disconnected(let why):
            return "Disconnected: \(why). Choose \(name) again to reconnect; reports saved meanwhile are kept on the iPhone and copied then.\(last)"
        case .failing(let why):
            return "The last copy to \(name) didn’t work: \(why). The app tries again every few minutes.\(last)"
        }
    }

    func showMenu(done: @escaping () -> Void) {
        let h = health
        let linked = UserDefaults.standard.data(forKey: Self.bookmarkKey) != nil
        let message = menuMessage()
        PresentationQueue.shared.enqueue({ host, finished in
            let sheet = UIAlertController(title: "Diagnostics Folder", message: message, preferredStyle: .actionSheet)
            func after(_ action: @escaping () -> Void) -> (UIAlertAction) -> Void {
                { _ in
                    finished()
                    action()
                }
            }
            // Pick the folder again whenever something is wrong: a broken link, failing copies, iCloud not uploading.
            let trouble = h != .ok || self.uploadProblem != nil
            if linked, trouble {
                sheet.addAction(UIAlertAction(title: "Reconnect Folder…", style: .default, handler: after { self.pickFolder { _ in done() } }))
            }
            // Files shows iCloud's own state on each file (a cloud with an arrow: waiting to upload).
            if let files = self.filesURL {
                sheet.addAction(UIAlertAction(title: "Open in Files", style: .default, handler: after {
                    UIApplication.shared.open(files)
                    done()
                }))
            }
            if linked {
                sheet.addAction(UIAlertAction(title: "Report a Problem…", style: .default, handler: after { self.report(done: done) }))
                if h != .off, !h.isDisconnected {
                    sheet.addAction(UIAlertAction(title: "Copy Diagnostics Now", style: .default, handler: after {
                        self.mirror(force: true) {
                            Task { @MainActor in DiagnosticsFolder.shared.sayHowItWent(success: "Copied to the folder on this iPhone.") }
                        }
                        done()
                    }))
                    if !trouble {
                        sheet.addAction(UIAlertAction(title: "Change Folder…", style: .default, handler: after { self.pickFolder { _ in done() } }))
                    }
                }
                sheet.addAction(UIAlertAction(title: "Stop Sharing", style: .destructive, handler: after {
                    UserDefaults.standard.removeObject(forKey: Self.bookmarkKey)
                    UserDefaults.standard.removeObject(forKey: Self.nameKey)
                    self.forgetUpload()
                    self.record(.off)
                    done()
                }))
            } else {
                sheet.addAction(UIAlertAction(title: "Choose Folder…", style: .default, handler: after { self.pickFolder { _ in done() } }))
            }
            sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel, handler: after(done)))
            if let pop = sheet.popoverPresentationController {
                pop.sourceView = host.view
                pop.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 0, height: 0)
            }
            host.present(sheet, animated: true)
            return sheet
        }, cancel: done)
    }

    /// After a copy the user asked for: what happened, with Reconnect when the folder can't be reached.
    private func sayHowItWent(success: String?) {
        let h = health
        if h == .ok, success == nil { return }
        let title = h == .ok ? "Diagnostics Folder" : (h.isDisconnected ? "Diagnostics Folder Disconnected" : "Couldn’t Copy")
        let message = h == .ok ? (success ?? "") + (uploadProblem.map { " But \($0)." } ?? "") : menuMessage()
        PresentationQueue.shared.enqueue({ host, finished in
            let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
            if h.isDisconnected {
                alert.addAction(UIAlertAction(title: "Reconnect…", style: .default) { _ in
                    finished()
                    self.pickFolder { _ in }
                })
            }
            alert.addAction(UIAlertAction(title: "OK", style: .cancel) { _ in finished() })
            host.present(alert, animated: true)
            return alert
        }, cancel: {})
    }

    // MARK: Mirror

    private func appInfo() -> [String: Any] {
        let bundle = Bundle.main.infoDictionary ?? [:]
        let device = UIDevice.current
        return [
            "app": bundle["CFBundleShortVersionString"] as? String ?? "?",
            "build": bundle["CFBundleVersion"] as? String ?? "?",
            "ios": device.systemVersion,
            "model": device.model,
            "at": ISO8601DateFormatter().string(from: Date()),
        ]
    }

    /// The UI's trail and current screen (localStorage, written by qa-folder.ts and recovery.ts). The page sleeps while
    /// the app is in the background (its answer would never come): then, or after 2 s, the last answer is used.
    private func pageState() async -> (trail: String, route: String) {
        guard UIApplication.shared.applicationState == .active else { return page }
        await refreshPage()
        return page
    }

    private func refreshPage() async {
        guard let webView else { return }
        let js = "JSON.stringify({trail: localStorage.getItem('tachinovel.v2.trail'), route: localStorage.getItem('tachinovel.v2.screen')})"
        let answer = PageAnswer()
        ask(webView, js, answer)
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            answer.finish(nil)
        }
        let text = await answer.value()
        guard let text, let obj = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return }
        page = ((obj["trail"] as? String) ?? "[]", (obj["route"] as? String) ?? "null")
    }

    /// The completion-handler call from a synchronous function (in an async one the compiler asks for the async variant,
    /// which can't be given a time limit).
    private func ask(_ webView: WKWebView, _ js: String, _ answer: PageAnswer) {
        webView.evaluateJavaScript(js) { value, _ in answer.finish(value as? String) }
    }

    /// Copy now (`force`) or when due. `completion` runs once the copy is over (whatever happened; `health` says).
    func mirror(force: Bool, completion: (@Sendable () -> Void)? = nil) {
        guard case .ok(let root) = resolveLink() else {
            completion?()
            return
        }
        if copying {
            if force { again = true }
            if let completion { waiting.append(completion) }
            return
        }
        if !force, !DiagnosticsPolicy.isDue(now: Date(), lastAttempt: lastAttempt, busy: VoiceRun.shared.working) {
            completion?()
            return
        }
        copying = true
        lastAttempt = Date()
        // storage.json walks the whole container: every half hour, or 5 minutes apart when asked for (backgrounding, a report).
        let withStorage = lastStorage.map { Date().timeIntervalSince($0) >= (force ? 5 * 60 : DiagnosticsPolicy.storageInterval) } ?? true
        if withStorage { lastStorage = Date() }
        let since = lastSuccess
        let folderState = health.state
        Task { @MainActor in
            let page = await self.pageState()
            var status = self.appInfo()
            status["route"] = page.route
            status["folder"] = folderState
            status["lastCopy"] = since.map { ISO8601DateFormatter().string(from: $0) as Any } ?? NSNull()
            status["voiceWorking"] = VoiceRun.shared.working
            let statusData = (try? JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys])) ?? Data()
            let trailData = Data(page.trail.utf8)
            // Voice Lab numbers (Kokoro load times, real-time factor, fallbacks: VoiceLab.swift).
            let lab = VoiceLab.snapshot()
            let labData = JSONSerialization.isValidJSONObject(lab)
                ? ((try? JSONSerialization.data(withJSONObject: lab, options: [.prettyPrinted, .sortedKeys])) ?? Data()) : Data()
            let local = CoreHost.shared.localAppDir
            let log = CoreHost.shared.log
            // The core's buffered log lines go to logs/app.log first (like backgrounding), unless it doesn't answer.
            DiagnosticsFiles.afterCoreFlush(timeout: 3) {
                DiagnosticsFiles.queue.async {
                    var extras = ["trail.json": trailData, "status.json": statusData, "voice-lab.json": labData]
                    if withStorage, let storage = try? JSONSerialization.data(withJSONObject: NephisModelPack.storageReport().json(),
                                                                                options: [.prettyPrinted, .sortedKeys]) {
                        extras["storage.json"] = storage
                    }
                    let outcome: DiagnosticsPolicy.Health
                    var upload = UploadCheck.fine
                    do {
                        upload = try DiagnosticsFiles.mirror(root: root, local: local, extras: extras, lastSuccess: since)
                        outcome = .ok
                    } catch {
                        outcome = DiagnosticsPolicy.classify(error)
                        log.error("Diagnostics folder: \(error.localizedDescription, privacy: .public)")
                    }
                    Task { @MainActor in
                        DiagnosticsFolder.shared.copied(outcome, upload: upload)
                        completion?()
                    }
                }
            }
        }
    }

    private func copied(_ outcome: DiagnosticsPolicy.Health, upload: UploadCheck) {
        copying = false
        if outcome == .ok { lastSuccess = Date() }
        record(outcome)
        if outcome == .ok { noteUpload(upload) }
        let done = waiting
        waiting = []
        if again {
            again = false
            mirror(force: true) { for d in done { d() } }
        } else {
            for d in done { d() }
        }
    }

    /// How iCloud did with the copy before. Pending for `uploadPatience` is a problem too.
    private func noteUpload(_ upload: UploadCheck) {
        let d = UserDefaults.standard
        switch upload {
        case .fine:
            d.removeObject(forKey: Self.pendingKey)
            d.removeObject(forKey: Self.uploadKey)
        case .problem(let why):
            d.set(why, forKey: Self.uploadKey)
        case .pending:
            let since = d.double(forKey: Self.pendingKey)
            if since == 0 { return d.set(Date().timeIntervalSince1970, forKey: Self.pendingKey) }
            guard Date().timeIntervalSince1970 - since >= Self.uploadPatience else { return }
            let when = clock(Date(timeIntervalSince1970: since))
            d.set("iCloud hasn’t uploaded the copies since \(when) (iCloud storage full, or no network?)", forKey: Self.uploadKey)
        }
    }

    /// The folder in the Files app.
    private var filesURL: URL? {
        guard let path = folderURL?.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        return URL(string: "shareddocuments://" + path)
    }

    /// Backgrounding or closing: copy now, under a background task so iOS doesn't suspend the copy halfway.
    private func mirrorInBackground() {
        guard folderURL != nil, backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "diagnostics-folder") {
            Task { @MainActor in DiagnosticsFolder.shared.endBackgroundTask() }
        }
        mirror(force: true) {
            Task { @MainActor in DiagnosticsFolder.shared.endBackgroundTask() }
        }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    // MARK: Report a problem

    /// Shake: only when a folder is linked (otherwise iOS's own shake behavior stays).
    func reportFromShake() {
        guard UserDefaults.standard.data(forKey: Self.bookmarkKey) != nil else { return }
        report(done: {})
    }

    func report(done: @escaping () -> Void) {
        guard UserDefaults.standard.data(forKey: Self.bookmarkKey) != nil else { return done() }
        if let last = lastReport, Date().timeIntervalSince(last) < Self.reportInterval { return done() }
        // The screen as it is now, before the prompt covers it.
        var screenshot: Data?
        if let window = webView?.window {
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
            }
            screenshot = image.jpegData(compressionQuality: 0.5)
        }
        let shot = screenshot
        PresentationQueue.shared.enqueue({ host, finished in
            let alert = UIAlertController(
                title: "Report a Problem",
                message: "What happened? A screenshot, the recent log and the current screen are saved with it.",
                preferredStyle: .alert)
            alert.addTextField { field in
                field.placeholder = "Describe the problem"
                field.autocapitalizationType = .sentences
            }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
                finished()
                done()
            })
            alert.addAction(UIAlertAction(title: "Save", style: .default) { [weak alert] _ in
                let text = alert?.textFields?.first?.text ?? ""
                finished()
                self.saveReport(description: text, screenshot: shot)
                done()
            })
            host.present(alert, animated: true)
            return alert
        }, cancel: done)
    }

    private func saveReport(description: String, screenshot: Data?) {
        lastReport = Date()
        let stamp: String = {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "yyyy-MM-dd-HHmmss"
            return f.string(from: Date())
        }()
        Task { @MainActor in
            let page = await self.pageState()
            var info = self.appInfo()
            info["description"] = description
            info["route"] = page.route
            info["trail"] = page.trail
            info["folder"] = self.health.state
            let report = (try? JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys])) ?? Data()
            let local = CoreHost.shared.localAppDir
            let log = CoreHost.shared.log
            DiagnosticsFiles.afterCoreFlush(timeout: 3) {
                DiagnosticsFiles.queue.async {
                    do {
                        try DiagnosticsFiles.saveReportLocally(local: local, folder: stamp, report: report, screenshot: screenshot)
                        log.info("Diagnostics folder: problem report \(stamp, privacy: .public) saved")
                    } catch {
                        log.error("Diagnostics folder: report failed: \(error.localizedDescription, privacy: .public)")
                    }
                    Task { @MainActor in
                        DiagnosticsFolder.shared.mirror(force: true) {
                            Task { @MainActor in DiagnosticsFolder.shared.sayHowItWent(success: nil) }
                        }
                    }
                }
            }
        }
    }
}

private extension DiagnosticsPolicy.Health {
    var isDisconnected: Bool {
        if case .disconnected = self { return true }
        return false
    }
}
