//
//  ModelStore.swift — download an experimental engine's model files (pinned revision + SHA-256), check
//  them, delete them.
//
//  - Only the files in PinnedModels (generated from ios/expressive-models.lock.json) are fetched, from
//    `huggingface.co/<repo>/resolve/<commit>/<path>`; each one is hashed after download and rejected on a
//    size or SHA-256 mismatch. Nothing else is ever downloaded (FluidAudio's own downloader stays off:
//    the app and the benchmark keep `ModelHub.offlineMode` on).
//  - Files land in `<root>/<folder>/<path>`, `root` being FluidAudio's TTS model cache, where its
//    managers look; the folder is excluded from iCloud/iTunes backups (these are 0.4–1.4 GB).
//  - Resumable: verified files are recorded in `<folder>/.tachinovel-model.json` and skipped next time.
//  - Wi-Fi only on request (`allowsCellularAccess`/`allowsExpensiveNetworkAccess` off): on cellular the
//    download fails with `.wifiRequired` instead of using mobile data.
//

import CryptoKit
import Foundation

public enum ModelDownloadError: Error, LocalizedError, Equatable {
    case wifiRequired
    case notEnoughSpace(neededMB: Int, freeMB: Int)
    case http(file: String, status: Int)
    case checksum(file: String)
    case size(file: String, expected: Int64, got: Int64)
    case network(String)
    case unsafePath(String)
    case cancelled

    public var errorDescription: String? {
        switch self {
        case .wifiRequired: return "Connect to Wi-Fi to download this model (mobile data is not used)."
        case let .notEnoughSpace(needed, free): return "Not enough free space: \(needed) MB needed, \(free) MB free."
        case let .http(file, status): return "Download failed (HTTP \(status)) for \(file)."
        case let .checksum(file): return "Checksum mismatch for \(file): the download was corrupted or the file changed. Try again."
        case let .size(file, expected, got): return "Size mismatch for \(file): expected \(expected) bytes, got \(got)."
        case let .network(why): return "Network error: \(why)"
        case let .unsafePath(path): return "Refusing an unsafe model path: \(path)"
        case .cancelled: return "Download cancelled."
        }
    }
}

public struct DownloadProgress: Sendable, Equatable {
    public var bytesDone: Int64
    public var bytesTotal: Int64
    public var filesDone: Int
    public var filesTotal: Int
    public var currentFile: String

    public init(bytesDone: Int64, bytesTotal: Int64, filesDone: Int, filesTotal: Int, currentFile: String) {
        self.bytesDone = bytesDone
        self.bytesTotal = bytesTotal
        self.filesDone = filesDone
        self.filesTotal = filesTotal
        self.currentFile = currentFile
    }

    public var fraction: Double { bytesTotal > 0 ? min(1, Double(bytesDone) / Double(bytesTotal)) : 0 }
}

/// What has been downloaded and verified in an engine folder (`<folder>/.tachinovel-model.json`).
public struct InstallRecord: Codable, Equatable, Sendable {
    public var revision: String
    /// path → SHA-256 of the verified file
    public var verified: [String: String]

    public init(revision: String, verified: [String: String]) {
        self.revision = revision
        self.verified = verified
    }
}

public final class ModelStore: Sendable {
    /// FluidAudio's TTS model cache (`TtsCacheDirectory/Models`).
    public let root: URL
    public static let recordName = ".tachinovel-model.json"

    public init(root: URL) {
        self.root = root
    }

    public func directory(for model: PinnedEngineModel) -> URL {
        root.appendingPathComponent(model.folder, isDirectory: true)
    }

    private func recordURL(_ model: PinnedEngineModel) -> URL {
        directory(for: model).appendingPathComponent(Self.recordName)
    }

    public func readRecord(_ model: PinnedEngineModel) -> InstallRecord? {
        guard let data = try? Data(contentsOf: recordURL(model)) else { return nil }
        return try? JSONDecoder().decode(InstallRecord.self, from: data)
    }

    private func writeRecord(_ record: InstallRecord, _ model: PinnedEngineModel) throws {
        let data = try JSONEncoder().encode(record)
        try data.write(to: recordURL(model), options: .atomic)
    }

    private func fileSize(_ url: URL) -> Int64? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let n = attrs[.size] as? NSNumber else { return nil }
        return n.int64Value
    }

    /// Every pinned file is present, verified at this revision and has the expected size.
    public func isInstalled(_ model: PinnedEngineModel) -> Bool {
        guard let record = readRecord(model), record.revision == model.revision else { return false }
        let dir = directory(for: model)
        return model.files.allSatisfy { f in
            record.verified[f.path] == f.sha256 && fileSize(dir.appendingPathComponent(f.path)) == f.size
        }
    }

    /// Bytes of this engine's pinned files currently on disk (complete or not).
    public func bytesOnDisk(_ model: PinnedEngineModel) -> Int64 {
        let dir = directory(for: model)
        return model.files.reduce(0) { $0 + (fileSize(dir.appendingPathComponent($1.path)) ?? 0) }
    }

    /// Delete the engine's whole folder (models + record).
    public func remove(_ model: PinnedEngineModel) throws {
        let dir = directory(for: model)
        if FileManager.default.fileExists(atPath: dir.path) { try FileManager.default.removeItem(at: dir) }
    }

    public func freeBytes() -> Int64? {
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let values = try? root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage
    }

    /// Download what is missing, verify everything, record it. Cancel the calling Task to stop.
    public func install(_ model: PinnedEngineModel, wifiOnly: Bool,
                        progress: @escaping @Sendable (DownloadProgress) -> Void) async throws {
        for f in model.files where !PinnedModels.isSafeRelativePath(f.path) { throw ModelDownloadError.unsafePath(f.path) }
        let fm = FileManager.default
        let dir = directory(for: model)
        var record = readRecord(model) ?? InstallRecord(revision: model.revision, verified: [:])
        if record.revision != model.revision {
            // Another revision was installed: start over (never mix files of two revisions).
            try? fm.removeItem(at: dir)
            record = InstallRecord(revision: model.revision, verified: [:])
        }
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        Self.excludeFromBackup(dir)

        let done = model.files.filter { record.verified[$0.path] == $0.sha256 && fileSize(dir.appendingPathComponent($0.path)) == $0.size }
        let doneSet = Set(done.map(\.path))
        let todo = model.files.filter { !doneSet.contains($0.path) }
        let missingBytes = todo.reduce(Int64(0)) { $0 + $1.size }
        if let free = freeBytes(), free < missingBytes + 200 * 1_048_576 {
            throw ModelDownloadError.notEnoughSpace(neededMB: Int((missingBytes + 200 * 1_048_576) / 1_048_576), freeMB: Int(free / 1_048_576))
        }

        var state = DownloadProgress(bytesDone: done.reduce(0) { $0 + $1.size }, bytesTotal: model.totalBytes,
                                     filesDone: done.count, filesTotal: model.files.count, currentFile: "")
        progress(state)
        let fetcher = FileFetcher(wifiOnly: wifiOnly)
        defer { fetcher.invalidate() }
        for f in todo {
            try Task.checkCancellation()
            guard let url = model.remoteURL(for: f) else { throw ModelDownloadError.unsafePath(f.path) }
            let dest = dir.appendingPathComponent(f.path)
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            let part = dest.appendingPathExtension("part")
            try? fm.removeItem(at: part)
            state.currentFile = f.path
            let base = state.bytesDone
            let snapshot = state
            try await fetcher.fetch(url, to: part) { written in
                var s = snapshot
                s.bytesDone = base + min(written, f.size)
                progress(s)
            }
            let got = fileSize(part) ?? -1
            guard got == f.size else {
                try? fm.removeItem(at: part)
                throw ModelDownloadError.size(file: f.path, expected: f.size, got: got)
            }
            guard try Self.sha256(of: part) == f.sha256 else {
                try? fm.removeItem(at: part)
                throw ModelDownloadError.checksum(file: f.path)
            }
            if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
            try fm.moveItem(at: part, to: dest)
            record.verified[f.path] = f.sha256
            try writeRecord(record, model)
            state.bytesDone = base + f.size
            state.filesDone += 1
            progress(state)
        }
        state.currentFile = ""
        progress(state)
    }

    /// Re-hash every installed file (slow: reads the whole model). Paths that don't match.
    public func verifyAll(_ model: PinnedEngineModel) -> [String] {
        let dir = directory(for: model)
        return model.files.compactMap { f in
            let url = dir.appendingPathComponent(f.path)
            guard fileSize(url) == f.size, (try? Self.sha256(of: url)) == f.sha256 else { return f.path }
            return nil
        }
    }

    public static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        var finished = false
        while !finished {
            try autoreleasepool {
                let chunk = try handle.read(upToCount: 4 << 20) ?? Data()
                if chunk.isEmpty { finished = true } else { hasher.update(data: chunk) }
            }
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func excludeFromBackup(_ url: URL) {
        var u = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? u.setResourceValues(values)
    }
}

/// One URLSession download task at a time, with byte progress, bridged to async/await.
final class FileFetcher: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var session: URLSession?
    private var continuation: CheckedContinuation<Void, Error>?
    private var destination: URL?
    private var moveError: Error?
    private var status = 0
    private var onBytes: ((Int64) -> Void)?
    private var lastReported: Int64 = 0

    init(wifiOnly: Bool) {
        super.init()
        let config = URLSessionConfiguration.default
        config.allowsCellularAccess = !wifiOnly
        config.allowsExpensiveNetworkAccess = !wifiOnly
        config.allowsConstrainedNetworkAccess = !wifiOnly
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 3 * 60 * 60
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    func invalidate() {
        lock.lock()
        let s = session
        session = nil
        lock.unlock()
        s?.invalidateAndCancel()
    }

    func fetch(_ url: URL, to destination: URL, onBytes: @escaping (Int64) -> Void) async throws {
        lock.lock()
        guard let session else {
            lock.unlock()
            throw ModelDownloadError.cancelled
        }
        lock.unlock()
        let task = session.downloadTask(with: url)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                lock.lock()
                self.continuation = c
                self.destination = destination
                self.moveError = nil
                self.status = 0
                self.onBytes = onBytes
                self.lastReported = 0
                lock.unlock()
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        // Report at most once per MiB (and at the end): progress goes to the main thread.
        lock.lock()
        let due = totalBytesWritten - lastReported >= 1_048_576 || totalBytesWritten == totalBytesExpectedToWrite
        if due { lastReported = totalBytesWritten }
        let cb = due ? onBytes : nil
        lock.unlock()
        cb?(totalBytesWritten)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The temporary file is deleted when this returns: move it now.
        lock.lock()
        let dest = destination
        lock.unlock()
        let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        var failure: Error?
        if let dest, code == 200 {
            do {
                if FileManager.default.fileExists(atPath: dest.path) { try FileManager.default.removeItem(at: dest) }
                try FileManager.default.moveItem(at: location, to: dest)
            } catch {
                failure = error
            }
        }
        lock.lock()
        status = code
        moveError = failure
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let c = continuation
        continuation = nil
        let code = status
        let moveFailure = moveError
        let file = destination?.lastPathComponent ?? "?"
        lock.unlock()
        guard let c else { return }
        if let error {
            c.resume(throwing: Self.map(error))
        } else if code != 200 {
            c.resume(throwing: ModelDownloadError.http(file: file, status: code))
        } else if let moveFailure {
            c.resume(throwing: ModelDownloadError.network("could not store \(file): \(moveFailure.localizedDescription)"))
        } else {
            c.resume()
        }
    }

    static func map(_ error: Error) -> Error {
        guard let e = error as? URLError else { return ModelDownloadError.network(error.localizedDescription) }
        if e.code == .cancelled { return ModelDownloadError.cancelled }
        if let reason = e.networkUnavailableReason, reason == .cellular || reason == .expensive || reason == .constrained {
            return ModelDownloadError.wifiRequired
        }
        return ModelDownloadError.network(e.localizedDescription)
    }
}
