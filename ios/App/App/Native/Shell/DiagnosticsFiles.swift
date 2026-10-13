//
//  DiagnosticsFiles.swift — the Diagnostics folder's file work, off the main thread (DiagnosticsFolder.swift decides
//  when): log tails, the app's os_log lines, coordinated writes with a time limit, the mirror of logs/ and problem
//  reports kept on the iPhone until they are copied.
//

import ExpressiveCore
import Foundation
import OSLog

/// Runs its body once, whichever caller comes first (a reply or its time limit).
final class OnceGate: @unchecked Sendable {  // @unchecked: `done` is guarded by `lock`
    private let lock = NSLock()
    private var done = false

    func run(_ body: () -> Void) {
        lock.lock()
        let first = !done
        done = true
        lock.unlock()
        if first { body() }
    }
}

/// File work off the main thread. Only Sendable values (URLs, Data, String) go in.
enum DiagnosticsFiles {
    static let queue = DispatchQueue(label: "app.tachinovel.diagnostics-folder", qos: .utility)
    static let logTailBytes = 512 * 1024
    static let reportLogBytes = 64 * 1024
    static let maxExtraFileBytes = 2 * 1024 * 1024
    /// A file provider that doesn't answer (iCloud Drive stuck) must not hold the queue for ever.
    static let coordinationTimeout: TimeInterval = 20
    /// Problem reports kept on the iPhone (logs/reports/<time>/), the newest first.
    static let keptReports = 10

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

    /// Coordinated write (the folder usually belongs to a file provider: iCloud Drive), given up after
    /// `coordinationTimeout` (NSUserCancelledError: DiagnosticsPolicy reads it as "iCloud Drive didn't answer").
    static func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let coordinator = NSFileCoordinator()
        let held = Box(coordinator)
        let limit = DispatchWorkItem { held.value.cancel() }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + coordinationTimeout, execute: limit)
        defer { limit.cancel() }
        var coordinationError: NSError?
        var writeError: Error?
        coordinator.coordinate(writingItemAt: url, options: .forReplacing, error: &coordinationError) { target in
            do { try data.write(to: target, options: .atomic) } catch { writeError = error }
        }
        if let error = coordinationError ?? writeError { throw error }
    }

    private static func fileValues(_ url: URL) -> (size: Int, modified: Date?)? {
        guard let v = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]), let size = v.fileSize else { return nil }
        return (size, v.contentModificationDate)
    }

    /// The app's own os_log lines (Logger, subsystem app.tachinovel) from the last `minutes`: the native voice engine's
    /// reasons ("gave unusable audio", studio skipped, memory holds) never reach logs/app.log, so a read that played
    /// nothing without crashing is explained in the folder too (Kasta 2026-10-12). Nil if the store can't be read.
    static func nativeLog(minutes: Double = 60) -> Data? {
        guard let store = try? OSLogStore(scope: .currentProcessIdentifier) else { return nil }
        let since = store.position(date: Date().addingTimeInterval(-minutes * 60))
        let mine = NSPredicate(format: "subsystem == %@", "app.tachinovel")
        guard let entries = try? store.getEntries(at: since, matching: mine) else { return nil }
        let clock = DateFormatter()
        clock.dateFormat = "HH:mm:ss.SSS"
        var text = ""
        for case let entry as OSLogEntryLog in entries {
            text += "\(clock.string(from: entry.date)) [\(entry.category)] \(entry.composedMessage)\n"
        }
        guard !text.isEmpty else { return nil }
        return Data(Data(text.utf8).suffix(logTailBytes))
    }

    /// Mirror the device's logs/ into `root` (logs as tails, other files when new or changed since `lastSuccess`), plus
    /// extras. A file that fails doesn't stop the others; the first error is thrown at the end.
    static func mirror(root: URL, local: URL, extras: [String: Data], lastSuccess: Date?) throws {
        let accessing = root.startAccessingSecurityScopedResource()
        defer { if accessing { root.stopAccessingSecurityScopedResource() } }
        var firstError: Error?
        func attempt(_ body: () throws -> Void) {
            do { try body() } catch { if firstError == nil { firstError = error } }
        }
        let logs = local.appendingPathComponent("logs", isDirectory: true)
        for name in ["app.log", "app.1.log"] {
            if let data = tail(logs.appendingPathComponent(name), max: logTailBytes) {
                attempt { try write(data, to: root.appendingPathComponent(name)) }
            }
        }
        if let native = nativeLog() { attempt { try write(native, to: root.appendingPathComponent("native.log")) } }
        // Everything else under logs/ (voice-beat.log, MetricKit reports, problem reports, …): small files, copied when
        // new or changed.
        let fm = FileManager.default
        if let walker = fm.enumerator(at: logs, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey, .contentModificationDateKey]) {
            for case let file as URL in walker {
                let name = file.lastPathComponent
                guard name != "app.log", name != "app.1.log", !name.hasPrefix("."),
                      (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true,
                      let source = fileValues(file), source.size <= maxExtraFileBytes else { continue }
                let relative = file.path.replacingOccurrences(of: logs.path + "/", with: "")
                let target = root.appendingPathComponent(relative)
                guard DiagnosticsPolicy.shouldCopy(sourceSize: source.size, sourceModified: source.modified,
                                                   targetSize: fileValues(target)?.size, lastSuccess: lastSuccess) else { continue }
                if let data = try? Data(contentsOf: file) { attempt { try write(data, to: target) } }
            }
        }
        for (name, data) in extras.sorted(by: { $0.key < $1.key }) { attempt { try write(data, to: root.appendingPathComponent(name)) } }
        if let firstError { throw firstError }
    }

    /// A problem report kept on the iPhone first (logs/reports/<stamp>/: report.json, screen.jpg, app-log-tail.txt,
    /// native-log.txt); the mirror copies it over. Older reports beyond `keptReports` are removed.
    static func saveReportLocally(local: URL, folder: String, report: Data, screenshot: Data?) throws {
        let reports = local.appendingPathComponent("logs/reports", isDirectory: true)
        let dir = reports.appendingPathComponent(folder, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try report.write(to: dir.appendingPathComponent("report.json"), options: .atomic)
        if let screenshot { try screenshot.write(to: dir.appendingPathComponent("screen.jpg"), options: .atomic) }
        if let log = tail(local.appendingPathComponent("logs/app.log"), max: reportLogBytes) {
            try log.write(to: dir.appendingPathComponent("app-log-tail.txt"), options: .atomic)
        }
        if let native = nativeLog(minutes: 30) { try native.write(to: dir.appendingPathComponent("native-log.txt"), options: .atomic) }
        let old = ((try? FileManager.default.contentsOfDirectory(atPath: reports.path)) ?? []).filter { !$0.hasPrefix(".") }.sorted(by: >)
        for name in old.dropFirst(keptReports) { try? FileManager.default.removeItem(at: reports.appendingPathComponent(name, isDirectory: true)) }
    }

    /// `body` once the core has written its buffered log lines to logs/app.log, or after `timeout` if it doesn't answer.
    static func afterCoreFlush(timeout: TimeInterval, _ body: @escaping @Sendable () -> Void) {
        let gate = OnceGate()
        CoreHost.shared.request("app.background") { @Sendable _, _ in gate.run(body) }
        queue.asyncAfter(deadline: .now() + timeout) { gate.run(body) }
    }
}
