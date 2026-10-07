//
//  ImportedVoices.swift — the voices imported from .tnvoice files (VoicePack.swift), the chosen narrator
//  voice per engine, and the slot through which Chatterbox Nano reads a voice.
//
//  Layout (`root` = Application Support/TachiNovel/voices; small, user-made, so included in backups):
//    <root>/<engine>/<id>/voice.safetensors   the checked conditioning tensors
//    <root>/<engine>/<id>/preview.m4a         optional short sample made on the PC
//    <root>/<engine>/<id>/info.json           name, dates, SHA-256 of voice.safetensors
//    <root>/selection.json                    {"<engine>": "<id>"}: the narrator voice (absent = the app's default)
//  An id is "v" + the first 16 hex digits of the voice data's SHA-256, so importing the same voice twice
//  keeps one copy. Ids that come from the UI are checked against that pattern before any path is built.
//
//  Voices that ship in the app (BundledVoices): <app>/BuiltInVoices/*.tnvoice + voices.json (which one is the
//  default narrator voice). Same checks as an import, done the first time the list is needed (never at
//  launch) and again when a voice is loaded. Id = "b" + 16 hex digits of the SHA-256 of the file NAME, so a
//  re-tuned voice shipped under the same name keeps the user's choice. "builtin" is Chatterbox Nano's own
//  voice (voice-default.safetensors), always selectable.
//
//  ChatterboxVoiceSlot: FluidAudio 0.17.5's ChatterboxNanoManager has no way to pass a voice; it always
//  reads <models>/chatterbox-nano/tables/voice-default.safetensors while loading (into memory). To speak
//  with an imported voice the app puts that voice's file in the slot just for the load and puts the pinned
//  built-in file back right after (a backup of it is kept next to it, `voice-default.pinned`). If the app
//  dies mid-load, `restorePinned()` at launch and before every load repairs the slot, so the downloaded
//  model always looks exactly like the pinned one to ModelStore.
//

import Foundation

public struct ImportedVoice: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var engine: String
    public var engineVersion: Int
    /// When the voice was made (from the file, ISO 8601).
    public var createdAt: String
    /// When it was imported on this iPhone (ISO 8601).
    public var importedAt: String
    /// SHA-256 of voice.safetensors.
    public var sha256: String
    public var bytes: Int
    public var hasPreview: Bool
    public var madeFor: String?
    public var sourceFile: String?
    /// Nonverbal sounds and breaths kept with the voice (VoiceSnippets.swift).
    public var nonverbalCount: Int?
    public var breathCount: Int?
    /// SHA-256 of each folder manifest at import ("nonverbal/manifest.json" → hex), checked when loaded.
    public var extras: [String: String]?
}

public final class ImportedVoiceStore: Sendable {
    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    public static let infoName = "info.json"
    static let selectionName = "selection.json"

    /// "v" + 16 lowercase hex digits.
    public static func isValidID(_ id: String) -> Bool {
        id.utf8.count == 17 && id.hasPrefix("v") && id.utf8.dropFirst().allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    public static func id(forSHA256 sha: String) -> String { "v" + String(sha.prefix(16)) }

    private func engineDir(_ engine: String) -> URL { root.appendingPathComponent(engine, isDirectory: true) }

    public func directory(_ id: String, engine: String) throws -> URL {
        guard Self.isValidID(id), VoicePackEngine.find(engine) != nil else { throw VoicePackError.unsafeID(id) }
        return engineDir(engine).appendingPathComponent(id, isDirectory: true)
    }

    // MARK: - Listing

    /// Imported voices of one engine, oldest import first. Unreadable entries are skipped.
    public func list(engine: String) -> [ImportedVoice] {
        guard VoicePackEngine.find(engine) != nil else { return [] }
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: engineDir(engine).path) else { return [] }
        return names.filter(Self.isValidID).compactMap { voice($0, engine: engine) }.sorted { ($0.importedAt, $0.id) < ($1.importedAt, $1.id) }
    }

    public func voice(_ id: String, engine: String) -> ImportedVoice? {
        guard let dir = try? directory(id, engine: engine),
              let data = try? Data(contentsOf: dir.appendingPathComponent(Self.infoName)),
              let info = try? JSONDecoder().decode(ImportedVoice.self, from: data),
              info.id == id, info.engine == engine else { return nil }
        return info
    }

    // MARK: - Import / rename / delete

    /// Keep a checked voice (VoicePack.read). The same voice data imported again replaces the old copy and
    /// keeps its name; `replaced` says so.
    @discardableResult
    public func add(_ contents: VoicePackContents, sourceFile: String?, now: Date = Date()) throws -> (voice: ImportedVoice, replaced: Bool) {
        let engine = contents.manifest.engine.id
        let id = Self.id(forSHA256: contents.conditioningSHA256)
        let previous = voice(id, engine: engine)
        let fm = FileManager.default
        try fm.createDirectory(at: engineDir(engine), withIntermediateDirectories: true)
        let staging = engineDir(engine).appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: staging) }
        var extrasSHA: [String: String] = [:]
        for kind in SnippetKind.allCases {
            if let m = contents.extraFiles[kind.manifestPath] { extrasSHA[kind.manifestPath] = VoicePack.sha256Hex(m) }
        }
        let info = ImportedVoice(
            id: id, name: previous?.name ?? contents.manifest.name, engine: engine, engineVersion: contents.manifest.engine.engineVersion,
            createdAt: contents.manifest.createdAt, importedAt: previous?.importedAt ?? Self.iso(now), sha256: contents.conditioningSHA256,
            bytes: contents.conditioning.count, hasPreview: contents.preview != nil, madeFor: contents.manifest.madeFor,
            sourceFile: sourceFile.map { VoicePack.cleanName($0) },
            nonverbalCount: contents.extras.nonverbal.count, breathCount: contents.extras.breaths.count,
            extras: extrasSHA.isEmpty ? nil : extrasSHA
        )
        try contents.conditioning.write(to: staging.appendingPathComponent(VoicePackFormat.conditioningName), options: .atomic)
        if let preview = contents.preview {
            try preview.write(to: staging.appendingPathComponent(VoicePackFormat.previewName), options: .atomic)
        }
        // nonverbal/ and breaths/ as checked (names validated by VoicePack.read; checked again here before any path is built).
        for (path, body) in contents.extraFiles {
            guard VoicePackFormat.snippetEntry(path) != nil || SnippetKind.allCases.contains(where: { $0.manifestPath == path }) else {
                throw VoicePackError.unexpectedEntry(path)
            }
            let url = staging.appendingPathComponent(path)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try body.write(to: url, options: .atomic)
        }
        try Self.encode(info).write(to: staging.appendingPathComponent(Self.infoName), options: .atomic)
        let dest = try directory(id, engine: engine)
        if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
        try fm.moveItem(at: staging, to: dest)
        return (info, previous != nil)
    }

    @discardableResult
    public func rename(_ id: String, engine: String, to name: String) throws -> ImportedVoice {
        guard var info = voice(id, engine: engine) else { throw VoicePackError.notFound(id) }
        info.name = VoicePack.cleanName(name)
        try Self.encode(info).write(to: try directory(id, engine: engine).appendingPathComponent(Self.infoName), options: .atomic)
        return info
    }

    /// Delete a voice; if it was the narrator voice, the app's default voice is used again.
    public func delete(_ id: String, engine: String) throws {
        let dir = try directory(id, engine: engine)
        if FileManager.default.fileExists(atPath: dir.path) { try FileManager.default.removeItem(at: dir) }
        if selection(engine: engine) == id { try setSelection(nil, engine: engine) }
    }

    /// The voice's nonverbal sounds and breaths, read and checked again (folder manifests against their SHA-256 at
    /// import, then VoiceSnippets.read). `.none` for a voice without them.
    public func extras(_ id: String, engine: String) throws -> VoiceExtras {
        guard let info = voice(id, engine: engine) else { throw VoicePackError.notFound(id) }
        let dir = try directory(id, engine: engine)
        var found: [SnippetKind: [VoiceSnippet]] = [:]
        for kind in SnippetKind.allCases {
            guard let sha = info.extras?[kind.manifestPath] else { continue }
            let folder = dir.appendingPathComponent(kind.rawValue, isDirectory: true)
            guard let manifest = try? Data(contentsOf: folder.appendingPathComponent("manifest.json")), manifest.count <= VoicePackFormat.maxManifestBytes,
                  VoicePack.sha256Hex(manifest) == sha else { throw VoicePackError.checksum(kind.manifestPath) }
            let names = ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []).filter { $0 != "manifest.json" }
            guard names.count <= VoicePackFormat.maxSnippetsPerFolder else { throw VoicePackError.manifest("too many files in \(kind.rawValue)/") }
            var files: [String: [UInt8]] = [:]
            for name in names where VoiceSnippets.isSnippetFileName(name) {
                let url = folder.appendingPathComponent(name)
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                guard size <= VoicePackFormat.maxSnippetFileBytes else { throw VoicePackError.tooLarge(bytes: size, limit: VoicePackFormat.maxSnippetFileBytes) }
                files[name] = [UInt8](try Data(contentsOf: url))
            }
            found[kind] = try VoiceSnippets.read(kind, manifest: [UInt8](manifest), files: files)
        }
        return VoiceExtras(nonverbal: found[.nonverbal] ?? [], breaths: found[.breaths] ?? [])
    }

    public func previewURL(_ id: String, engine: String) -> URL? {
        guard let info = voice(id, engine: engine), info.hasPreview, let dir = try? directory(id, engine: engine) else { return nil }
        let url = dir.appendingPathComponent(VoicePackFormat.previewName)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// The voice data, checked again (it is about to be handed to the engine): present, unchanged since the
    /// import (SHA-256) and still exactly the tensors the engine expects.
    public func conditioning(_ id: String, engine: String) throws -> Data {
        guard let info = voice(id, engine: engine), let spec = VoicePackEngine.find(engine) else { throw VoicePackError.notFound(id) }
        let url = try directory(id, engine: engine).appendingPathComponent(VoicePackFormat.conditioningName)
        guard let data = try? Data(contentsOf: url) else { throw VoicePackError.notFound(id) }
        guard VoicePack.sha256Hex(data) == info.sha256 else { throw VoicePackError.checksum(VoicePackFormat.conditioningName) }
        try VoicePack.validateConditioning(data, engine: spec)
        return data
    }

    // MARK: - Narrator voice

    /// Chatterbox Nano's own voice (voice-default.safetensors), as a selection value.
    public static let engineVoice = "builtin"

    /// A value selection.json may hold: an imported voice, a voice that ships in the app, or the engine's own.
    public static func isSelectable(_ id: String) -> Bool {
        id == engineVoice || isValidID(id) || BundledVoices.isBundledID(id)
    }

    /// The chosen voice id for an engine, or nil for the app's default. The id may no longer exist (deleted
    /// files, a voice no longer shipped): callers fall back to the default voice and say so.
    public func selection(engine: String) -> String? {
        guard let data = try? Data(contentsOf: root.appendingPathComponent(Self.selectionName)),
              let map = try? JSONDecoder().decode([String: String].self, from: data),
              let id = map[engine], Self.isSelectable(id) else { return nil }
        return id
    }

    /// nil = the app's default voice. An imported voice must exist; whether a shipped ("b…") voice exists is
    /// the caller's check (BundledVoices).
    public func setSelection(_ id: String?, engine: String) throws {
        if let id {
            guard Self.isSelectable(id) else { throw VoicePackError.unsafeID(id) }
            if Self.isValidID(id), voice(id, engine: engine) == nil { throw VoicePackError.notFound(id) }
        }
        var map: [String: String] = [:]
        if let data = try? Data(contentsOf: root.appendingPathComponent(Self.selectionName)),
           let old = try? JSONDecoder().decode([String: String].self, from: data) {
            map = old.filter { VoicePackEngine.find($0.key) != nil && Self.isSelectable($0.value) }
        }
        map[engine] = id
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(map).write(to: root.appendingPathComponent(Self.selectionName), options: .atomic)
    }

    // MARK: - Helpers

    static func encode(_ info: ImportedVoice) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        return try encoder.encode(info)
    }

    static func iso(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: date)
    }
}

/// Voices that ship inside the app: `<directory>/*.tnvoice` plus `voices.json`
/// (`{"schemaVersion": 1, "default": "<file>.tnvoice" | null}`: the default narrator voice). Each file gets the
/// same checks as an import (VoicePack.read) the first time the list is needed, never at launch; a file that
/// fails is left out and listed in `problems`. A voice's data is read again (and checked again) only when it is
/// loaded or previewed.
public final class BundledVoices: @unchecked Sendable { // the scan cache is lock-protected
    public struct Entry: Sendable, Equatable {
        public let id: String
        public let fileName: String
        public let name: String
        public let engine: String
        public let createdAt: String
        public let hasPreview: Bool
        public let isDefault: Bool
        /// SHA-256 of the voice data (voice.safetensors) when it was listed.
        public let sha256: String
        public let nonverbalCount: Int
        public let breathCount: Int
    }

    public static let indexName = "voices.json"
    public let directory: URL?
    private let lock = NSLock()
    private var scanned: (entries: [Entry], problems: [String])?

    public init(directory: URL?) {
        self.directory = directory
    }

    /// "b" + 16 hex digits of the SHA-256 of the file name: stable when a voice is re-tuned under the same name.
    public static func id(forFileName name: String) -> String { "b" + String(VoicePack.sha256Hex(Array(name.utf8)).prefix(16)) }

    public static func isBundledID(_ id: String) -> Bool {
        id.utf8.count == 17 && id.hasPrefix("b") && id.utf8.dropFirst().allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    /// The valid shipped voices of every engine, the default first.
    public var entries: [Entry] { scan().entries }
    /// Shipped files that failed the checks (with why), and a voices.json default that isn't a valid voice.
    public var problems: [String] { scan().problems }

    public func entries(engine: String) -> [Entry] { entries.filter { $0.engine == engine } }
    public func defaultID(engine: String) -> String? { entries(engine: engine).first { $0.isDefault }?.id }
    public func entry(_ id: String) -> Entry? { entries.first { $0.id == id } }

    /// A shipped voice's checked parts, read again from the app (when it is loaded or previewed).
    public func contents(_ id: String) throws -> VoicePackContents {
        guard Self.isBundledID(id), let entry = entry(id), let directory else { throw VoicePackError.notFound(id) }
        let contents = try VoicePack.read(fileAt: directory.appendingPathComponent(entry.fileName))
        guard contents.conditioningSHA256 == entry.sha256 else { throw VoicePackError.checksum(entry.fileName) }
        return contents
    }

    /// A shipped voice's nonverbal sounds and breaths (read from the app and checked again).
    public func extras(_ id: String) throws -> VoiceExtras { try contents(id).extras }

    private func scan() -> (entries: [Entry], problems: [String]) {
        lock.lock()
        defer { lock.unlock() }
        if let scanned { return scanned }
        var entries: [Entry] = []
        var problems: [String] = []
        if let directory {
            let suffix = "." + VoicePackFormat.fileExtension
            let names = ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).filter { $0.lowercased().hasSuffix(suffix) }.sorted()
            var defaultName: String?
            if let data = try? Data(contentsOf: directory.appendingPathComponent(Self.indexName)),
               let index = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                defaultName = index["default"] as? String
            }
            for name in names {
                do {
                    let c = try VoicePack.read(fileAt: directory.appendingPathComponent(name))
                    entries.append(Entry(id: Self.id(forFileName: name), fileName: name, name: c.manifest.name, engine: c.manifest.engine.id,
                                         createdAt: c.manifest.createdAt, hasPreview: c.preview != nil, isDefault: name == defaultName,
                                         sha256: c.conditioningSHA256, nonverbalCount: c.extras.nonverbal.count, breathCount: c.extras.breaths.count))
                } catch {
                    problems.append("\(name): \(error.localizedDescription)")
                }
            }
            if let defaultName, !entries.contains(where: { $0.fileName == defaultName }) {
                problems.append("\(Self.indexName): the default “\(defaultName)” isn’t a valid voice")
            }
        }
        entries.sort { ($0.isDefault ? 0 : 1, $0.name) < ($1.isDefault ? 0 : 1, $1.name) }
        let result = (entries: entries, problems: problems)
        scanned = result
        return result
    }
}

/// An async mutex: `acquire()` waits (without blocking a thread) until the previous holder calls `release()`.
/// Used to run Chatterbox loads one at a time, since they share the voice slot.
public actor AsyncGate {
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init() {}

    public func acquire() async {
        if !busy {
            busy = true
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    public func release() {
        if waiters.isEmpty {
            busy = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}

public enum VoiceSlotError: Error, LocalizedError, Equatable {
    case builtInVoiceMissing

    public var errorDescription: String? {
        switch self {
        case .builtInVoiceMissing: return "Chatterbox Nano’s built-in voice file is damaged. Delete the model and download it again."
        }
    }
}

/// Where Chatterbox Nano (FluidAudio 0.17.5) reads its voice while loading; see the top of this file.
public struct ChatterboxVoiceSlot: Sendable {
    public let slotURL: URL
    public let backupURL: URL
    public let pinnedSHA256: String

    public static let slotPath = "tables/voice-default.safetensors"

    public init(engineDirectory: URL, pinnedSHA256: String) {
        slotURL = engineDirectory.appendingPathComponent(Self.slotPath)
        backupURL = engineDirectory.appendingPathComponent("tables/voice-default.pinned")
        self.pinnedSHA256 = pinnedSHA256
    }

    /// The slot of a pinned Chatterbox Nano install (nil if the lock has no voice-default file).
    public init?(model: PinnedEngineModel, store: ModelStore) {
        guard let file = model.files.first(where: { $0.path == Self.slotPath }) else { return nil }
        self.init(engineDirectory: store.directory(for: model), pinnedSHA256: file.sha256)
    }

    private func hash(_ url: URL) -> String? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try? ModelStore.sha256(of: url)
    }

    public var holdsBuiltInVoice: Bool { hash(slotURL) == pinnedSHA256 }

    /// Put the pinned built-in voice back in the slot (nothing to do if it is there). Nothing to do either
    /// when the model isn't downloaded at all.
    public func restorePinned() throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: slotURL.deletingLastPathComponent().path) else { return }
        if hash(slotURL) == pinnedSHA256 { return }
        guard hash(backupURL) == pinnedSHA256 else {
            // Neither copy is the pinned file: a partial download has no slot yet, which is fine; anything else is damage.
            if !fm.fileExists(atPath: slotURL.path) { return }
            throw VoiceSlotError.builtInVoiceMissing
        }
        try Data(contentsOf: backupURL).write(to: slotURL, options: .atomic)
    }

    /// Put an imported voice's data (already checked) in the slot, after making sure the pinned file is backed up.
    public func install(_ conditioning: Data) throws {
        if hash(backupURL) != pinnedSHA256 {
            guard hash(slotURL) == pinnedSHA256 else { throw VoiceSlotError.builtInVoiceMissing }
            try Data(contentsOf: slotURL).write(to: backupURL, options: .atomic)
        }
        try conditioning.write(to: slotURL, options: .atomic)
    }
}
