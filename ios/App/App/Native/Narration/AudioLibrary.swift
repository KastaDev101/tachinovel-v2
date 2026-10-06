//
//  AudioLibrary.swift — the PC narrator's audio, read straight from iCloud Drive.
//
//  The narrator (tachinovel-narrator) writes:
//    iCloud Drive/TachiNovel Audio/<Novel>/NNNN - Title.m4a   chapter audio (or .m4b bundles)
//                                          NNNN - Title.json  sentence timestamps (v1 experiments/tts/manifest.ts)
//                                          manifest.json      per novel: key "<pluginId>:<novelPath>",
//                                                             chapters { chapterPath: {status, file, timing, number, title} }
//
//  The user links the "TachiNovel Audio" folder ONCE with the document picker; we keep a bookmark to it.
//  A folder picked by the user stays readable through the bookmark without any iCloud entitlement, so
//  this works in the free-Apple-ID sideload build. Evicted iCloud files are downloaded on demand.
//

import Foundation
import UIKit
import UniformTypeIdentifiers

struct AudioChapter {
    let novelKey: String
    let pluginId: String
    let novelPath: String
    let novelName: String
    let chapterPath: String
    let number: Double
    let title: String
    /// Audio file (absolute), and the timestamp manifest next to it, if any.
    let audioURL: URL
    let timingURL: URL?
}

struct AudioNovel {
    let key: String
    let pluginId: String
    let novelPath: String
    let name: String
    /// Ordered by chapter number.
    let chapters: [AudioChapter]
}

final class AudioLibrary: NSObject, UIDocumentPickerDelegate {
    static let shared = AudioLibrary()

    private static let bookmarkKey = "tachinovel.audioFolderBookmark"
    private var root: URL?
    private var accessing = false
    private var novels: [String: AudioNovel] = [:]
    private var scannedAt: Date?
    private var pickCompletion: ((Result<String, Error>) -> Void)?
    private var pickFinished: (() -> Void)?
    private let lock = NSLock()

    enum AudioError: LocalizedError {
        case notLinked, cancelled, unreadable(String), notDownloaded(String)
        var errorDescription: String? {
            switch self {
            case .notLinked: return "No audio folder linked yet"
            case .cancelled: return "cancelled"
            case .unreadable(let m): return m
            case .notDownloaded(let f): return "Couldn't download \(f) from iCloud Drive"
            }
        }
    }

    // MARK: - Folder link

    /// The linked folder's display name, or nil.
    var folderName: String? { resolveRoot()?.lastPathComponent }

    /// Document picker for a folder (main thread). Saves a bookmark and rescans.
    func pickFolder(completion: @escaping (Result<String, Error>) -> Void) {
        let answer = Once(completion)
        PresentationQueue.shared.enqueue({ [self] host, finished in
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            pickCompletion = { answer.call($0) }
            pickFinished = finished
            host.present(picker, animated: true)
            return picker
        }, cancel: { answer.call(.failure(AudioError.cancelled)) })
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return finishPick(.failure(AudioError.cancelled)) }
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            UserDefaults.standard.set(data, forKey: Self.bookmarkKey)
            lock.lock()
            if accessing, let old = root { old.stopAccessingSecurityScopedResource() }
            root = nil
            accessing = false
            novels = [:]
            scannedAt = nil
            lock.unlock()
            finishPick(.success(url.lastPathComponent))
        } catch {
            finishPick(.failure(AudioError.unreadable("Couldn't keep access to that folder: \(error.localizedDescription)")))
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finishPick(.failure(AudioError.cancelled)) }

    private func finishPick(_ r: Result<String, Error>) {
        let c = pickCompletion
        let f = pickFinished
        pickCompletion = nil
        pickFinished = nil
        c?(r)
        f?()
    }

    func unlink() {
        lock.lock()
        if accessing, let old = root { old.stopAccessingSecurityScopedResource() }
        root = nil
        accessing = false
        novels = [:]
        lock.unlock()
        UserDefaults.standard.removeObject(forKey: Self.bookmarkKey)
    }

    /// The linked folder with security-scoped access started (kept for the app's lifetime).
    private func resolveRoot() -> URL? {
        lock.lock()
        defer { lock.unlock() }
        if let root { return root }
        guard let data = UserDefaults.standard.data(forKey: Self.bookmarkKey) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        accessing = url.startAccessingSecurityScopedResource()
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            UserDefaults.standard.set(fresh, forKey: Self.bookmarkKey)
        }
        root = url
        return url
    }

    // MARK: - Index

    /// All novels with narrated chapters (cached; `refresh` rescans the folder). Any thread; blocking IO.
    func scan(refresh: Bool = false) throws -> [AudioNovel] {
        lock.lock()
        if !refresh, scannedAt != nil {
            let cached = Array(novels.values)
            lock.unlock()
            return cached.sorted { $0.name < $1.name }
        }
        lock.unlock()
        guard let root = resolveRoot() else { throw AudioError.notLinked }
        let fm = FileManager.default
        var found: [String: AudioNovel] = [:]
        let dirs = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])) ?? []
        for dir in dirs where (try? dir.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
            guard let novel = readNovel(dir) else { continue }
            found[novel.key] = novel
        }
        lock.lock()
        novels = found
        scannedAt = Date()
        lock.unlock()
        return found.values.sorted { $0.name < $1.name }
    }

    func novel(_ key: String) -> AudioNovel? {
        if (try? scan()) == nil { return nil }
        lock.lock()
        defer { lock.unlock() }
        return novels[key]
    }

    func chapter(pluginId: String, novelPath: String, chapterPath: String) -> AudioChapter? {
        novel("\(pluginId):\(novelPath)")?.chapters.first { $0.chapterPath == chapterPath }
    }

    /// The chapter to resume at: this one if narrated, else the first narrated chapter after it.
    func chapter(atOrAfter chapterPath: String, in novel: AudioNovel, number: Double?) -> AudioChapter? {
        if let exact = novel.chapters.first(where: { $0.chapterPath == chapterPath }) { return exact }
        guard let n = number else { return novel.chapters.first }
        return novel.chapters.first { $0.number > n }
    }

    private func readNovel(_ dir: URL) -> AudioNovel? {
        let manifestURL = dir.appendingPathComponent("manifest.json")
        guard let data = readCoordinated(manifestURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let key = obj["key"] as? String, let colon = key.firstIndex(of: ":") else { return nil }
        let pluginId = String(key[..<colon])
        let novelPath = String(key[key.index(after: colon)...])
        let name = obj["novel"] as? String ?? dir.lastPathComponent
        var chapters: [AudioChapter] = []
        for (chapterPath, raw) in obj["chapters"] as? [String: Any] ?? [:] {
            guard let rec = raw as? [String: Any], rec["status"] as? String == "done",
                  let file = rec["file"] as? String, !file.contains("/") else { continue }
            let audio = dir.appendingPathComponent(file)
            guard Self.exists(audio) else { continue } // listened to and removed ("taken")
            let timing = (rec["timing"] as? String).flatMap { t -> URL? in
                guard !t.contains("/") else { return nil }
                let u = dir.appendingPathComponent(t)
                return Self.exists(u) ? u : nil
            }
            let number = Double(rec["number"] as? String ?? "") ?? Double.greatestFiniteMagnitude
            chapters.append(AudioChapter(novelKey: key, pluginId: pluginId, novelPath: novelPath, novelName: name,
                                         chapterPath: chapterPath, number: number, title: rec["title"] as? String ?? chapterPath,
                                         audioURL: audio, timingURL: timing))
        }
        guard !chapters.isEmpty else { return nil }
        chapters.sort { $0.number < $1.number }
        return AudioNovel(key: key, pluginId: pluginId, novelPath: novelPath, name: name, chapters: chapters)
    }

    // MARK: - Files

    /// A file or its evicted iCloud placeholder (".name.icloud") exists.
    static func exists(_ url: URL) -> Bool {
        let fm = FileManager.default
        if fm.fileExists(atPath: url.path) { return true }
        let ph = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
        return fm.fileExists(atPath: ph.path)
    }

    /// Read a (small) file through NSFileCoordinator, which downloads evicted iCloud files first.
    func readCoordinated(_ url: URL) -> Data? {
        var result: Data?
        var error: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &error) { readURL in
            result = try? Data(contentsOf: readURL)
        }
        return result
    }

    func timingJSON(_ chapter: AudioChapter) -> String? {
        guard let url = chapter.timingURL, let data = readCoordinated(url) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Make sure the audio file is local (iCloud may have evicted it). Blocking; call off the main thread.
    func ensureDownloaded(_ url: URL, timeout: TimeInterval = 120) throws {
        let fm = FileManager.default
        var u = url
        func ready() -> Bool {
            u.removeAllCachedResourceValues()
            let v = try? u.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
            if v?.isUbiquitousItem != true { return fm.fileExists(atPath: url.path) }
            return v?.ubiquitousItemDownloadingStatus == .current
        }
        if ready() { return }
        try? fm.startDownloadingUbiquitousItem(at: url)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            if ready() { return }
        }
        // Last resort: a coordinated read also forces the download.
        var err: NSError?
        var ok = false
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &err) { _ in ok = true }
        if !ok || !fm.fileExists(atPath: url.path) { throw AudioError.notDownloaded(url.lastPathComponent) }
    }
}

/// Decoded narration timestamp manifest (v1 experiments/tts/manifest.ts, schema 1).
struct NarrationTiming {
    struct Segment {
        let id: Int
        let block: Int
        let start: Int
        let end: Int
        let t0: Double // seconds, chapter time
        let t1: Double
    }

    let segments: [Segment]
    /// Chapter start inside the audio file (bundles), seconds.
    let offset: Double
    let duration: Double
    let nextChapterPath: String?
    let nextTitle: String?

    init?(json: String) {
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any],
              obj["kind"] as? String == "tachinovel.narration" else { return nil }
        let audio = obj["audio"] as? [String: Any] ?? [:]
        offset = ((audio["offsetMs"] as? NSNumber)?.doubleValue ?? 0) / 1000
        duration = ((audio["durationMs"] as? NSNumber)?.doubleValue ?? 0) / 1000
        let chapter = obj["chapter"] as? [String: Any] ?? [:]
        let next = chapter["next"] as? [String: Any]
        nextChapterPath = next?["chapterPath"] as? String
        nextTitle = next?["title"] as? String
        var segs: [Segment] = []
        for raw in obj["segments"] as? [[Any]] ?? [] {
            let n = raw.compactMap { ($0 as? NSNumber)?.doubleValue }
            guard n.count >= 6 else { continue }
            segs.append(Segment(id: Int(n[0]), block: Int(n[1]), start: Int(n[2]), end: Int(n[3]), t0: n[4] / 1000, t1: n[5] / 1000))
        }
        segments = segs.sorted { $0.t0 < $1.t0 }
    }

    /// Segment playing at chapter time `t` (the last one starting at or before it), or nil before the first.
    func segmentIndex(at t: Double) -> Int? {
        var lo = 0
        var hi = segments.count - 1
        var ans: Int?
        while lo <= hi {
            let mid = (lo + hi) / 2
            if segments[mid].t0 <= t {
                ans = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return ans
    }

    /// Chapter time of the first segment in `block` or after it ("listen from this paragraph").
    func time(forBlock block: Int) -> Double? {
        segments.first { $0.block >= block }?.t0
    }
}
