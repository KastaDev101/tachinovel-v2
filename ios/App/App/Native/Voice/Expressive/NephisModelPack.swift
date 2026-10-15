//
//  NephisModelPack.swift — Nephis's trained voice (personal flavor): a ".tnmodel" made on the PC
//  (tachinovel-tts-lab coreml-swap/pack.py) holds Pocket TTS's iPhone models with weights fine-tuned on her
//  (Models/pocket-tts-coreml/v2.1/english/…, FluidAudio's cache layout) and her voice files for that model
//  (BuiltInVoices/pocket/nephis*.pocketvoice + speaker-projection.bin). It is an uncompressed tar, opened from
//  Files or the share sheet ("Open in TachiNovel", SceneDelegate) or dropped into the app's Documents folder
//  (Finder / Apple Devices file sharing). It unpacks into the pack library (several packs side by side, one active:
//  ExpressiveCore NephisPackLibrary; Settings › Voices › Voice packs switches and deletes) and Nephis reads with it
//  from her next load. Nothing in it is executed: CoreML models are data the system compiles, the rest is numbers.
//

import ExpressiveCore
import Foundation
import os

enum NephisModelPack {
    static let fileExtension = "tnmodel"
    static let didInstall = Notification.Name("TachiNovelNephisModelInstalled")
    private static let log = Logger(subsystem: "app.tachinovel", category: "voice-expressive")

    /// Every pack on this iPhone and the one she reads with (ExpressiveCore NephisPackLibrary: Application
    /// Support/NephisPacks). First use moves the single pack older builds kept (Application Support/NephisModel) in.
    static let library: NephisPackLibrary = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let lib = NephisPackLibrary(root: base.appendingPathComponent("NephisPacks", isDirectory: true))
        if lib.migrate(legacy: base.appendingPathComponent("NephisModel", isDirectory: true)) {
            log.info("expressive: Nephis model pack moved into the pack library")
        }
        try? FileManager.default.removeItem(at: base.appendingPathComponent("NephisModel.incoming", isDirectory: true))
        return lib
    }()

    /// The active pack's root (FluidAudio's models directory for her engine), or nil.
    static var active: URL? { library.activeDirectory }
    static var modelsDirectory: URL? { active }
    /// The active pack's studio (Models/nephis-studio: NephisBlueprint, NephisVocoder, studio.json), or nil.
    /// Used only while the pack's studio switch is on (Settings › Voices › Voice test's "Her studio"; on by default for
    /// every pack, `studioOn`): the studio makes her stream 44.1 kHz, and a read with it plays at that rate (SessionRate
    /// in HybridSpeechEngine.swift).
    static var studioDirectory: URL? {
        guard let root = active, studioOn else { return nil }
        let dir = root.appendingPathComponent("Models/nephis-studio", isDirectory: true)
        return FileManager.default.fileExists(atPath: dir.appendingPathComponent("studio.json").path) ? dir : nil
    }
    /// The studio switch for the active pack (ExpressiveCore NephisStudioSwitch, 2026-10-15): on unless the user switched
    /// it off for this pack since it was installed. Setting it records the user's choice for the active pack.
    static var studioOn: Bool {
        get { NephisStudioSwitch.isOn(pack: library.activeID, defaults: .standard) }
        set { NephisStudioSwitch.set(newValue, pack: library.activeID, defaults: .standard) }
    }
    /// The active pack's de-wind cleaner (Models/nephis-dewind: DewindNet.mlpackage, dewind.json), or nil. Used whenever
    /// the pack's chain asks for it ("dewind"), studio switch or not (ExpressiveCore NephisDewindModel.swift).
    static var dewindDirectory: URL? {
        guard let root = active else { return nil }
        let dir = root.appendingPathComponent(NephisDewindModel.folder, isDirectory: true)
        return FileManager.default.fileExists(atPath: dir.path) ? dir : nil
    }
    /// Her voice files for the active model (a BuiltInVoices-shaped folder), or nil.
    static var voicesDirectory: URL? { active?.appendingPathComponent("BuiltInVoices", isDirectory: true) }
    /// What the active pack says about itself (pack.json: name, made, checkpoint), for the Voice Lab.
    static var info: [String: Any]? { active.flatMap(NephisPackLibrary.info(in:)) }

    static func handles(_ url: URL) -> Bool { url.isFileURL && url.pathExtension.lowercased() == fileExtension }

    /// "Open in TachiNovel" or a pack found in Documents: unpack off the main thread, then add it to the library as the
    /// active pack. The UI hears about it through the voice-import event (same message banner).
    static func open(_ url: URL) {
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try install(from: url) }
            removeCopy(url, installed: (try? result.get()) != nil)
            DispatchQueue.main.async {
                switch result {
                case .success(let name):
                    ExpressiveService.shared.reloadNephisModel()
                    post(ok: true, message: "Nephis’s trained voice “\(name)” is installed. She uses it from her next sentence.")
                case .failure(let error):
                    log.error("expressive: Nephis model pack: \(error.localizedDescription, privacy: .public)")
                    post(ok: false, message: "That Nephis voice file couldn’t be installed: \(error.localizedDescription)")
                }
            }
        }
    }

    /// After "Open in TachiNovel": the copy iOS made of a file shared from another app (Documents/Inbox, tmp/…-Inbox:
    /// 350-500 MB per pack, kept for ever before 2026-10-13) goes either way; a pack in the app's own Documents folder
    /// goes once it is installed (as `installFromDocuments` does). A file opened in place anywhere else is the user's.
    private static func removeCopy(_ url: URL, installed: Bool) {
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let inDocuments = url.standardizedFileURL.deletingLastPathComponent().path == docs.standardizedFileURL.path
        guard StorageMap.isSystemInboxCopy(url, documents: docs, tmp: fm.temporaryDirectory) || (installed && inDocuments) else { return }
        do { try fm.removeItem(at: url) } catch {
            log.error("expressive: couldn’t remove the copy \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Storage (Settings › Storage › Voices & models, the Diagnostics folder's storage.json)

    /// Installs running now (any thread): their staging folder and source file aren't leftovers.
    private static let installLock = NSLock()
    private static let installCount = Box(0)
    static var installing: Bool {
        installLock.lock()
        defer { installLock.unlock() }
        return installCount.value > 0
    }

    private static func counted<T>(_ body: () throws -> T) rethrows -> T {
        installLock.lock()
        installCount.value += 1
        installLock.unlock()
        defer {
            installLock.lock()
            installCount.value -= 1
            installLock.unlock()
        }
        return try body()
    }

    static var storageLocations: StorageLocations {
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return StorageLocations(applicationSupport: fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0], documents: docs,
                                library: fm.urls(for: .libraryDirectory, in: .userDomainMask)[0], tmp: fm.temporaryDirectory,
                                container: docs.deletingLastPathComponent(), bundle: Bundle.main.bundleURL)
    }

    /// Bytes per category (a walk of the whole container: off the main thread).
    static func storageReport() -> StorageReport {
        StorageMap.scan(storageLocations, library: library, installing: installing)
    }

    /// Remove copies and unfinished unpacks (never a complete pack, a model, the reading app's store or a recording).
    static func cleanLeftovers() -> (removed: Int, bytes: Int64) {
        let result = StorageMap.clean(storageLocations, library: library, installing: installing)
        log.info("storage: removed \(result.removed) leftovers, \(result.bytes) bytes")
        return result
    }

    /// The Documents install in progress, and the files that failed this session (by name, size and date, so a fresh
    /// copy of a file is tried again but a broken one isn't retried at every return to the app). Main thread only.
    private static let documentsInstall = Box((running: false, failed: Set<String>()))

    /// A pack copied into Documents (file sharing): install it once, then remove the copy. Called at launch and whenever
    /// the app becomes active again (a pack copied in while it sat in the background), one install at a time. Main thread.
    static func installFromDocuments() {
        guard !documentsInstall.value.running else { return }
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: docs, includingPropertiesForKeys: keys) else { return }
        let failed = documentsInstall.value.failed
        guard let found = files.filter(handles).lazy.map({ ($0, documentsKey($0)) }).first(where: { !failed.contains($0.1) }) else { return }
        let (pack, key) = found
        documentsInstall.value.running = true
        DispatchQueue.global(qos: .utility).async {
            do {
                let name = try install(from: pack)
                try? FileManager.default.removeItem(at: pack)
                DispatchQueue.main.async {
                    documentsInstall.value.running = false
                    ExpressiveService.shared.reloadNephisModel()
                    post(ok: true, message: "Nephis’s trained voice “\(name)” is installed.")
                }
            } catch {
                log.error("expressive: Nephis model pack in Documents: \(error.localizedDescription, privacy: .public)")
                DispatchQueue.main.async {
                    documentsInstall.value.running = false
                    documentsInstall.value.failed.insert(key)
                }
            }
        }
    }

    /// A Documents file as name, size and date: the same file isn't tried twice in a session, a new copy is.
    private static func documentsKey(_ url: URL) -> String {
        let v = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        return "\(url.lastPathComponent)|\(v?.fileSize ?? -1)|\(v?.contentModificationDate?.timeIntervalSince1970 ?? 0)"
    }

    private static func post(ok: Bool, message: String) {
        NotificationCenter.default.post(name: VoiceImportInbox.didImport, object: nil, userInfo: ["ok": ok, "message": message, "id": NSNull()])
        NotificationCenter.default.post(name: didInstall, object: nil)
    }

    enum PackError: LocalizedError {
        case notAPack(String)
        var errorDescription: String? {
            switch self { case .notAPack(let why): return "it isn’t a Nephis model pack (\(why))" }
        }
    }

    /// Unpack `url` (a tar) into a fresh folder, check it, then add it to the library as the active pack (a pack with
    /// the same name and date replaces its old copy). Returns the pack's name.
    static func install(from url: URL) throws -> String {
        try counted { try unpackAndAdd(url) }
    }

    private static func unpackAndAdd(_ url: URL) throws -> String {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let staging = try library.stagingDirectory()
        defer { try? FileManager.default.removeItem(at: staging) }  // gone already when it was added
        try Tar.extract(url, into: staging)
        guard NephisPackLibrary.isComplete(staging) else { throw PackError.notAPack("files are missing") }
        let pack = try library.add(staged: staging, fallbackName: url.deletingPathExtension().lastPathComponent).pack
        let name = pack.name
        // A pack just installed has its studio on (an earlier off for an older copy of it goes).
        NephisStudioSwitch.installed(pack: pack.id, defaults: .standard)
        log.info("expressive: Nephis model pack \(name, privacy: .public) installed")
        return name
    }

    /// Settings › Voices › Voice packs: she reads with `id` from her next load (what installing one does).
    static func select(_ id: String) throws {
        let before = library.activeID
        try library.activate(id)
        if before != id { ExpressiveService.shared.reloadNephisModel() }
    }

    /// Settings › Voices › Voice packs: delete a pack; deleting hers switches her to the next one (or to Kyutai's
    /// released model when it was the last).
    static func delete(_ id: String) throws {
        let before = library.activeID
        if try library.delete(id) != before { ExpressiveService.shared.reloadNephisModel() }
    }
}

/// Just enough of tar (POSIX ustar, regular files and folders) to unpack a pack, streamed: never the whole file in
/// memory. Entry names are checked: no absolute paths, no "..".
enum Tar {
    static func extract(_ url: URL, into dir: URL) throws {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        let fm = FileManager.default
        while true {
            guard let header = try h.read(upToCount: 512), header.count == 512 else { break }
            if header.allSatisfy({ $0 == 0 }) { break }  // end of archive
            func field(_ at: Int, _ len: Int) -> String {
                let bytes = header[at..<(at + len)].prefix { $0 != 0 }
                return String(decoding: bytes, as: UTF8.self)
            }
            let prefix = field(345, 155)
            var name = field(0, 100)
            if !prefix.isEmpty { name = prefix + "/" + name }
            let size = Int(field(124, 12).trimmingCharacters(in: .whitespaces), radix: 8) ?? 0
            let type = header[156]
            guard !name.hasPrefix("/"), !name.split(separator: "/").contains("..") else {
                throw NephisModelPack.PackError.notAPack("a bad file name")
            }
            let target = dir.appendingPathComponent(name)
            if type == UInt8(ascii: "5") {
                try fm.createDirectory(at: target, withIntermediateDirectories: true)
            } else if type == UInt8(ascii: "0") || type == 0 {
                try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                fm.createFile(atPath: target.path, contents: nil)
                let out = try FileHandle(forWritingTo: target)
                var left = size
                while left > 0 {
                    guard let chunk = try h.read(upToCount: min(left, 1 << 20)), !chunk.isEmpty else {
                        try? out.close()
                        throw NephisModelPack.PackError.notAPack("it ends early")
                    }
                    try out.write(contentsOf: chunk)
                    left -= chunk.count
                }
                try out.close()
            } else {
                _ = try h.read(upToCount: size)  // links, extended headers: skipped
            }
            let pad = (512 - size % 512) % 512
            if pad > 0 { _ = try h.read(upToCount: pad) }
        }
    }
}
