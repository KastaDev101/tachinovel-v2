//
//  StorageMap.swift — what TachiNovel keeps on this iPhone, by category, and the leftovers it can clean up
//  (Settings › Storage › Voices & models, and storage.json in the Diagnostics folder).
//
//  The app container (`StorageLocations`):
//    Library/Application Support/NephisPacks/<id>      her model packs (one active; NephisPackLibrary)
//    Library/Application Support/NephisPacks/.incoming-*  an unpack in progress, or a killed one's leftover
//    Library/Application Support/NephisModel(.incoming) the single pack builds before 2026-10-13 kept (moved in by
//                                                      NephisPackLibrary.migrate; an incomplete one stayed for ever)
//    Library/Application Support/fluidaudio/Models/…   downloaded voice models (Pocket TTS released model; Kokoro's
//                                                      G2P in kokoro/); a pack is read in place, never copied here.
//                                                      chatterbox-nano/ and neutts-2e/: models of the voices removed
//                                                      on 2026-10-16, never read again (a leftover)
//    Library/Application Support/NarrationAudio        chapter audio: downloads and drive prep (NarrationAudioStore;
//                                                      DriveAudio of older builds moves in at first launch)
//    Library/Application Support/TachiNovel            the reading app's store (covers, cache, downloads, logs),
//                                                      web updates (ota/), and voices/: .tnvoice voices imported for
//                                                      Chatterbox Nano by older builds, never read again (a leftover)
//    Documents/voice-test.wav, voice-selftest.json     the last Voice test's recording and report
//    Documents/*.tnmodel                               a pack dropped in with file sharing (removed once installed)
//    Documents/Inbox, tmp/<bundle id>-Inbox            copies iOS makes of a file shared from another app
//                                                      (AirDrop, Mail, the share sheet): 350-500 MB per pack, which
//                                                      nothing removed before 2026-10-13
//  Leftovers are only ever copies, unfinished unpacks and what only the removed voices read: never a complete pack (the
//  active one least of all), a model in use, the reading app's store or the recording.
//

import Foundation

public struct StorageLocations: Sendable {
    public var applicationSupport: URL
    public var documents: URL
    public var library: URL
    public var tmp: URL
    /// The container's root (Documents' parent): everything the app keeps.
    public var container: URL
    /// The app itself (it carries the Kokoro voices), or nil.
    public var bundle: URL?

    public init(applicationSupport: URL, documents: URL, library: URL, tmp: URL, container: URL, bundle: URL?) {
        self.applicationSupport = applicationSupport
        self.documents = documents
        self.library = library
        self.tmp = tmp
        self.container = container
        self.bundle = bundle
    }

    public var packs: URL { applicationSupport.appendingPathComponent("NephisPacks", isDirectory: true) }
    public var legacyPack: URL { applicationSupport.appendingPathComponent("NephisModel", isDirectory: true) }
    public var legacyStaging: URL { applicationSupport.appendingPathComponent("NephisModel.incoming", isDirectory: true) }
    public var models: URL { applicationSupport.appendingPathComponent("fluidaudio/Models", isDirectory: true) }
    public var appStore: URL { applicationSupport.appendingPathComponent("TachiNovel", isDirectory: true) }
}

public struct StorageEntry: Equatable, Sendable {
    public var key: String
    public var label: String
    public var note: String
    public var bytes: Int64
    public var count: Int
    /// A copy or unfinished unpack that "Clean up" removes.
    public var leftover: Bool

    public init(key: String, label: String, note: String, bytes: Int64, count: Int = 0, leftover: Bool = false) {
        self.key = key
        self.label = label
        self.note = note
        self.bytes = bytes
        self.count = count
        self.leftover = leftover
    }
}

public struct StorageReport: Equatable, Sendable {
    public var entries: [StorageEntry]
    /// Everything in the container (the entries add up to this).
    public var totalBytes: Int64
    /// The app itself (not counted in `totalBytes`).
    public var appBytes: Int64
    public var leftoverBytes: Int64 { entries.filter(\.leftover).reduce(0) { $0 + $1.bytes } }

    public func json() -> [String: Any] {
        [
            "entries": entries.map { e -> [String: Any] in
                ["key": e.key, "label": e.label, "note": e.note, "bytes": Int(e.bytes), "count": e.count, "leftover": e.leftover]
            },
            "totalBytes": Int(totalBytes),
            "appBytes": Int(appBytes),
            "leftoverBytes": Int(leftoverBytes),
        ]
    }
}

public enum StorageMap {
    /// Pack files iOS may have copied in (a .tnvoice from an older build's voice import too).
    static let packExtensions: Set<String> = ["tnmodel", "tnvoice"]
    static let modelLabels: [String: String] = [
        "pocket-tts": "Pocket TTS (Kyutai’s released model, used when no pack is)",
    ]
    /// Model folders of the voices removed on 2026-10-16 (Chatterbox Nano, NeuTTS-2E): nothing reads them any more.
    static let removedModels: [String: String] = ["chatterbox-nano": "Chatterbox Nano", "neutts-2e": "NeuTTS-2E"]

    /// A copy iOS made for "Open in TachiNovel" from another app: Documents/Inbox/… or tmp/<anything>-Inbox/….
    public static func isSystemInboxCopy(_ url: URL, documents: URL, tmp: URL) -> Bool {
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        let inbox = documents.appendingPathComponent("Inbox", isDirectory: true).standardizedFileURL.resolvingSymlinksInPath().path + "/"
        if path.hasPrefix(inbox) { return true }
        let tmpPath = tmp.standardizedFileURL.resolvingSymlinksInPath().path + "/"
        guard path.hasPrefix(tmpPath) else { return false }
        let first = path.dropFirst(tmpPath.count).split(separator: "/").first.map(String.init) ?? ""
        return first.hasSuffix("-Inbox")
    }

    /// Pack and voice files iOS copied in for us and nothing removed.
    static func inboxCopies(_ loc: StorageLocations) -> [URL] {
        var dirs = [loc.documents.appendingPathComponent("Inbox", isDirectory: true)]
        let tmpNames = (try? FileManager.default.contentsOfDirectory(atPath: loc.tmp.path)) ?? []
        dirs += tmpNames.filter { $0.hasSuffix("-Inbox") }.map { loc.tmp.appendingPathComponent($0, isDirectory: true) }
        return dirs.flatMap { dir in
            ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
                .filter { packExtensions.contains($0.pathExtension.lowercased()) }
        }
    }

    /// .tnmodel files at the top of Documents (file sharing): installed and removed at launch and on return to the app;
    /// one still there when nothing is installing didn't install.
    static func documentPacks(_ loc: StorageLocations) -> [URL] {
        ((try? FileManager.default.contentsOfDirectory(at: loc.documents, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension.lowercased() == "tnmodel" }
    }

    static func legacyLeftovers(_ loc: StorageLocations) -> [URL] {
        // NephisPackLibrary.migrate moves a complete NephisModel in at launch; whatever is still there is an unfinished
        // unpack of an old build (never used).
        [loc.legacyPack, loc.legacyStaging].filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// What only the removed voices read: their downloaded models, and the .tnvoice voices imported for Chatterbox Nano.
    static func removedVoiceLeftovers(_ loc: StorageLocations) -> [URL] {
        let models = removedModels.keys.sorted().map { loc.models.appendingPathComponent($0, isDirectory: true) }
        return (models + [importedVoices(loc)]).filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    static func importedVoices(_ loc: StorageLocations) -> URL { loc.appStore.appendingPathComponent("voices", isDirectory: true) }

    static func tempLeftovers(_ loc: StorageLocations) -> [URL] {
        [loc.tmp.appendingPathComponent("voice-import", isDirectory: true)].filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// Everything "Clean up" removes. `installing`: a pack is being unpacked right now (its staging folder and the file
    /// it comes from are not leftovers yet).
    public static func leftovers(_ loc: StorageLocations, library: NephisPackLibrary, installing: Bool) -> [URL] {
        var out = legacyLeftovers(loc) + removedVoiceLeftovers(loc)
        if !installing {
            out += library.leftoverFolders() + inboxCopies(loc) + documentPacks(loc) + tempLeftovers(loc)
        }
        return out
    }

    /// Remove the leftovers. Returns how many and the bytes freed.
    @discardableResult
    public static func clean(_ loc: StorageLocations, library: NephisPackLibrary, installing: Bool) -> (removed: Int, bytes: Int64) {
        var removed = 0
        var bytes: Int64 = 0
        let protected = library.protectedFolders()
        for url in leftovers(loc, library: library, installing: installing) where !protected.contains(url.standardizedFileURL.path) {
            let size = sizeOf(url)
            if (try? FileManager.default.removeItem(at: url)) != nil {
                removed += 1
                bytes += size
            }
        }
        return (removed, bytes)
    }

    public static func scan(_ loc: StorageLocations, library: NephisPackLibrary, installing: Bool) -> StorageReport {
        var entries: [StorageEntry] = []
        func add(_ key: String, _ label: String, _ note: String, _ urls: [URL], leftover: Bool = false) {
            entries.append(StorageEntry(key: key, label: label, note: note, bytes: urls.reduce(0) { $0 + sizeOf($1) },
                                        count: urls.count, leftover: leftover))
        }
        let packs = library.list()
        let active = library.activeID
        let packURL = { (id: String) in loc.packs.appendingPathComponent(id, isDirectory: true) }
        add("packActive", "Nephis voice pack in use", packs.first { $0.id == active }?.name ?? "None: the voice the app came with",
            packs.filter { $0.id == active }.map { packURL($0.id) })
        let others = packs.filter { $0.id != active }
        add("packsOther", "Other voice packs", others.isEmpty ? "None" : others.map(\.name).joined(separator: ", "), others.map { packURL($0.id) })

        // Downloaded models (FluidAudio's folder), one entry for the Pocket model, one for the rest (the removed voices'
        // models are leftovers, below).
        let modelDirs = ((try? FileManager.default.contentsOfDirectory(at: loc.models, includingPropertiesForKeys: nil)) ?? [])
        let pocket = modelDirs.filter { $0.lastPathComponent == "pocket-tts" }
        add("modelPocket", "Pocket TTS model", modelLabels["pocket-tts"] ?? "", pocket)
        let rest = modelDirs.filter { $0.lastPathComponent != "pocket-tts" && removedModels[$0.lastPathComponent] == nil }
        add("modelsOther", "Other voice models", rest.isEmpty ? "None downloaded"
            : rest.map { modelLabels[$0.lastPathComponent] ?? $0.lastPathComponent }.joined(separator: ", "), rest)

        add("drive", "Chapter audio", "Audio downloads and chapters ready for the car, in her voice",
            ["NarrationAudio", "DriveAudio"].map { loc.applicationSupport.appendingPathComponent($0, isDirectory: true) }
                .filter { FileManager.default.fileExists(atPath: $0.path) })
        let voices = importedVoices(loc)
        let ota = loc.appStore.appendingPathComponent("ota", isDirectory: true)
        add("webUpdates", "App updates over the air", "The newest web update and the one before", [ota])
        let store = max(0, sizeOf(loc.appStore) - sizeOf(voices) - sizeOf(ota))
        entries.append(StorageEntry(key: "reading", label: "Reading data", note: "Library, covers, chapter cache, downloads, logs", bytes: store))
        let recordings = ["voice-test.wav", "voice-selftest.json"].map { loc.documents.appendingPathComponent($0) }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
        add("recordings", "Voice test recording", "The last Voice test (Files › On My iPhone › TachiNovel)", recordings)
        add("caches", "System caches", "Covers, web pages, compiled models; iOS empties these when space runs low",
            [loc.library.appendingPathComponent("Caches", isDirectory: true)])

        add("leftoverInbox", "Copies of shared files", "Copies iOS made when a pack or voice was shared to the app",
            installing ? [] : inboxCopies(loc), leftover: true)
        add("leftoverDocuments", "Pack files that didn’t install", ".tnmodel files left in Documents",
            installing ? [] : documentPacks(loc), leftover: true)
        add("leftoverUnpacks", "Unfinished unpacks", "A pack install that was stopped part way",
            (installing ? [] : library.leftoverFolders()) + legacyLeftovers(loc), leftover: true)
        add("leftoverTemp", "Temporary import files", "", installing ? [] : tempLeftovers(loc), leftover: true)
        let removedModelDirs = modelDirs.filter { removedModels[$0.lastPathComponent] != nil }
        add("leftoverRemovedModels", "Models of removed voices",
            removedModelDirs.compactMap { removedModels[$0.lastPathComponent] }.sorted().joined(separator: ", ") + " (no longer used)",
            removedModelDirs, leftover: true)
        add("leftoverImportedVoices", "Imported voices", "Voices for Chatterbox Nano (.tnvoice), no longer used",
            [voices].filter { FileManager.default.fileExists(atPath: $0.path) }, leftover: true)

        // Documents beyond the above: the synced store when there is no iCloud (backups, library), anything put there.
        // (Pack files there while an install runs are counted under Other.)
        let docsPrefix = loc.documents.standardizedFileURL.path + "/"
        let inDocuments = recordings + documentPacks(loc) + inboxCopies(loc).filter { $0.standardizedFileURL.path.hasPrefix(docsPrefix) }
        let documents = max(0, sizeOf(loc.documents) - inDocuments.reduce(Int64(0)) { $0 + sizeOf($1) })
        entries.append(StorageEntry(key: "documents", label: "Your files", note: "Files › On My iPhone › TachiNovel (backups, library when there’s no iCloud)",
                                    bytes: documents))

        let total = sizeOf(loc.container)
        let known = entries.reduce(Int64(0)) { $0 + $1.bytes }
        entries.append(StorageEntry(key: "other", label: "Other", note: "Settings, web storage, temporary files", bytes: max(0, total - known)))
        return StorageReport(entries: entries, totalBytes: max(total, known), appBytes: loc.bundle.map(sizeOf) ?? 0)
    }

    /// Bytes on disk of a file or a folder (allocated size, like Settings › General › iPhone Storage).
    public static func sizeOf(_ url: URL) -> Int64 {
        let keys: [URLResourceKey] = [.totalFileAllocatedSizeKey, .fileAllocatedSizeKey, .isRegularFileKey, .isDirectoryKey]
        guard let top = try? url.resourceValues(forKeys: Set(keys)) else { return 0 }
        if top.isDirectory != true { return Int64(top.totalFileAllocatedSize ?? top.fileAllocatedSize ?? 0) }
        guard let walker = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys) else { return 0 }
        var total: Int64 = 0
        for case let file as URL in walker {
            guard let v = try? file.resourceValues(forKeys: Set(keys)), v.isRegularFile == true else { continue }
            total += Int64(v.totalFileAllocatedSize ?? v.fileAllocatedSize ?? 0)
        }
        return total
    }
}
