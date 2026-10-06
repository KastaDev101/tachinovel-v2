//
//  DiagnosticsFolder.swift — the phone QA loop (opt-in). The user picks a folder once in More › About ›
//  Diagnostics › Diagnostics Folder (for example iCloud Drive › TachiNovel-Builds › diagnostics; kept as a
//  security-scoped bookmark, so no iCloud entitlement is needed). Then:
//   - every few minutes while the app is open, and when it goes to the background, the device log
//     (logs/app.log, app.1.log), everything else under logs/ (MetricKit crash and hang reports, …), the
//     UI's short event trail and a status file are mirrored into that folder, where iCloud syncs them to
//     the PC;
//   - "Report a Problem" (the row's menu, or shaking the phone) writes reports/<time>/ with what the user
//     typed, a screenshot of the screen, the log tail, the versions and the current route.
//  Everything is small and rate-limited; reading data beyond novel titles and routes never leaves the app.
//  The web side is src/ui/native/qa-folder.ts.
//

import Capacitor
import UIKit
import UniformTypeIdentifiers
import WebKit

/// File work off the main thread. Only Sendable values (URLs, Data, String) go in.
enum DiagnosticsFiles {
    static let queue = DispatchQueue(label: "app.tachinovel.diagnostics-folder", qos: .utility)
    static let logTailBytes = 512 * 1024
    static let reportLogBytes = 64 * 1024
    static let maxExtraFileBytes = 2 * 1024 * 1024

    /// The last `max` bytes of a file, starting at a line boundary; nil if unreadable.
    static func tail(_ url: URL, max: Int) -> Data? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > UInt64(max) ? size - UInt64(max) : 0
        do { try handle.seek(toOffset: start) } catch { return nil }
        guard var data = try? handle.readToEnd() else { return nil }
        if start > 0, let newline = data.firstIndex(of: 0x0A) {
            data = data.subdata(in: data.index(after: newline)..<data.endIndex)
        }
        return data
    }

    /// Coordinated write: the folder usually belongs to a file provider (iCloud Drive).
    static func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var coordinationError: NSError?
        var writeError: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordinationError) { target in
            do { try data.write(to: target, options: .atomic) } catch { writeError = error }
        }
        if let error = coordinationError ?? writeError { throw error }
    }

    private static func fileSize(_ url: URL) -> Int? {
        (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
    }

    /// Mirror the device's logs/ into `root` (logs as tails, other files when new or changed), plus extras.
    static func mirror(root: URL, local: URL, extras: [String: Data]) throws {
        let accessing = root.startAccessingSecurityScopedResource()
        defer { if accessing { root.stopAccessingSecurityScopedResource() } }
        let logs = local.appendingPathComponent("logs", isDirectory: true)
        for name in ["app.log", "app.1.log"] {
            if let data = tail(logs.appendingPathComponent(name), max: logTailBytes) {
                try write(data, to: root.appendingPathComponent(name))
            }
        }
        // Everything else under logs/ (MetricKit reports, …): small files, copied when new or changed.
        let fm = FileManager.default
        if let walker = fm.enumerator(at: logs, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) {
            for case let file as URL in walker {
                let name = file.lastPathComponent
                guard name != "app.log", name != "app.1.log", !name.hasPrefix("."),
                      (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true,
                      let size = fileSize(file), size <= maxExtraFileBytes else { continue }
                let relative = file.path.replacingOccurrences(of: logs.path + "/", with: "")
                let target = root.appendingPathComponent(relative)
                if fileSize(target) == size { continue }
                if let data = try? Data(contentsOf: file) { try write(data, to: target) }
            }
        }
        for (name, data) in extras { try write(data, to: root.appendingPathComponent(name)) }
    }

    /// reports/<stamp>/: report.json, screen.jpg, app-log-tail.txt.
    static func writeReport(root: URL, folder: String, report: Data, screenshot: Data?, local: URL) throws {
        let accessing = root.startAccessingSecurityScopedResource()
        defer { if accessing { root.stopAccessingSecurityScopedResource() } }
        let dir = root.appendingPathComponent("reports", isDirectory: true).appendingPathComponent(folder, isDirectory: true)
        try write(report, to: dir.appendingPathComponent("report.json"))
        if let screenshot { try write(screenshot, to: dir.appendingPathComponent("screen.jpg")) }
        if let log = tail(local.appendingPathComponent("logs/app.log"), max: reportLogBytes) {
            try write(log, to: dir.appendingPathComponent("app-log-tail.txt"))
        }
    }
}

@MainActor
final class DiagnosticsFolder: NSObject, UIDocumentPickerDelegate {
    static let shared = DiagnosticsFolder()
    private static let bookmarkKey = "tachinovel.diagnosticsFolderBookmark"
    private static let mirrorInterval: TimeInterval = 5 * 60
    private static let reportInterval: TimeInterval = 30

    private weak var webView: WKWebView?
    private var lastMirror: Date?
    private var lastReport: Date?
    private var started = false
    private var pickDone: ((Bool) -> Void)?
    private var pickFinished: (() -> Void)?
    private var backgroundTask = UIBackgroundTaskIdentifier.invalid

    // MARK: Setup

    func start(webView: WKWebView?) {
        self.webView = webView
        guard !started else { return }
        started = true
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
            Task { @MainActor in DiagnosticsFolder.shared.mirror(force: false) }
        }
        _ = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in DiagnosticsFolder.shared.mirrorInBackground() }
        }
    }

    // MARK: Folder

    /// The linked folder (bookmark), or nil. A stale bookmark is refreshed.
    var folderURL: URL? {
        guard let data = UserDefaults.standard.data(forKey: Self.bookmarkKey) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        if stale {
            let accessing = url.startAccessingSecurityScopedResource()
            if let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                UserDefaults.standard.set(fresh, forKey: Self.bookmarkKey)
            }
            if accessing { url.stopAccessingSecurityScopedResource() }
        }
        return url
    }

    func statusDict() -> [String: Any] {
        let url = folderURL
        return [
            "linked": url != nil,
            "name": url?.lastPathComponent ?? NSNull(),
            "lastMirror": lastMirror.map { $0.timeIntervalSince1970 * 1000 } ?? NSNull(),
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

    // MARK: Menu (More › About › Diagnostics › Diagnostics Folder)

    func showMenu(done: @escaping () -> Void) {
        let linked = folderURL
        PresentationQueue.shared.enqueue({ host, finished in
            let message = linked.map { "Logs, crash reports and problem reports go to “\($0.lastPathComponent)”." }
                ?? "Pick a folder, for example iCloud Drive › TachiNovel-Builds › diagnostics. The app log, crash reports and problem reports are copied there every few minutes."
            let sheet = UIAlertController(title: "Diagnostics Folder", message: message, preferredStyle: .actionSheet)
            func after(_ action: @escaping () -> Void) -> (UIAlertAction) -> Void {
                { _ in
                    finished()
                    action()
                }
            }
            if linked != nil {
                sheet.addAction(UIAlertAction(title: "Report a Problem…", style: .default, handler: after { self.report(done: done) }))
                sheet.addAction(UIAlertAction(title: "Copy Diagnostics Now", style: .default, handler: after {
                    self.mirror(force: true)
                    done()
                }))
                sheet.addAction(UIAlertAction(title: "Change Folder…", style: .default, handler: after { self.pickFolder { _ in done() } }))
                sheet.addAction(UIAlertAction(title: "Stop Sharing", style: .destructive, handler: after {
                    UserDefaults.standard.removeObject(forKey: Self.bookmarkKey)
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

    /// The UI's trail and current screen (localStorage, written by qa-folder.ts and recovery.ts).
    private func pageState() async -> (trail: String, route: String) {
        guard let webView else { return ("[]", "null") }
        let js = "JSON.stringify({trail: localStorage.getItem('tachinovel.v2.trail'), route: localStorage.getItem('tachinovel.v2.screen')})"
        let result = try? await webView.evaluateJavaScript(js)
        guard let text = result as? String,
              let obj = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return ("[]", "null") }
        return ((obj["trail"] as? String) ?? "[]", (obj["route"] as? String) ?? "null")
    }

    func mirror(force: Bool, completion: (@Sendable () -> Void)? = nil) {
        guard let root = folderURL else { completion?(); return }
        if !force, let last = lastMirror, Date().timeIntervalSince(last) < Self.mirrorInterval { completion?(); return }
        lastMirror = Date()
        Task { @MainActor in
            let page = await self.pageState()
            var status = self.appInfo()
            status["route"] = page.route
            let statusData = (try? JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys])) ?? Data()
            let trailData = Data(page.trail.utf8)
            let local = CoreHost.shared.localAppDir
            let log = CoreHost.shared.log
            // The core's buffered log lines go to logs/app.log first (like backgrounding).
            CoreHost.shared.request("app.background") { @Sendable _, _ in
                DiagnosticsFiles.queue.async {
                    do {
                        try DiagnosticsFiles.mirror(root: root, local: local, extras: ["trail.json": trailData, "status.json": statusData])
                    } catch {
                        log.error("Diagnostics folder: \(error.localizedDescription, privacy: .public)")
                    }
                    completion?()
                }
            }
        }
    }

    /// Backgrounding: copy now, under a background task so iOS doesn't suspend the copy halfway.
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
        guard folderURL != nil else { return }
        report(done: {})
    }

    func report(done: @escaping () -> Void) {
        guard let root = folderURL else { return done() }
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
            let alert = UIAlertController(title: "Report a Problem", message: "What happened? A screenshot, the recent log and the current screen are saved with it.", preferredStyle: .alert)
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
                self.saveReport(root: root, description: text, screenshot: shot)
                done()
            })
            host.present(alert, animated: true)
            return alert
        }, cancel: done)
    }

    private func saveReport(root: URL, description: String, screenshot: Data?) {
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
            let report = (try? JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys])) ?? Data()
            let local = CoreHost.shared.localAppDir
            let log = CoreHost.shared.log
            CoreHost.shared.request("app.background") { @Sendable _, _ in
                DiagnosticsFiles.queue.async {
                    do {
                        try DiagnosticsFiles.writeReport(root: root, folder: stamp, report: report, screenshot: screenshot, local: local)
                        log.info("Diagnostics folder: problem report \(stamp, privacy: .public) saved")
                    } catch {
                        log.error("Diagnostics folder: report failed: \(error.localizedDescription, privacy: .public)")
                    }
                }
            }
            self.mirror(force: true)
        }
    }
}

/// JS: `DiagFolder` (src/ui/native/qa-folder.ts).
public class DiagFolderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DiagFolderPlugin"
    public let jsName = "DiagFolder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "menu", returnType: CAPPluginReturnPromise),
    ]

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated { call.resolve(DiagnosticsFolder.shared.statusDict()) }
        }
    }

    @objc func menu(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                DiagnosticsFolder.shared.showMenu { call.resolve(DiagnosticsFolder.shared.statusDict()) }
            }
        }
    }
}
