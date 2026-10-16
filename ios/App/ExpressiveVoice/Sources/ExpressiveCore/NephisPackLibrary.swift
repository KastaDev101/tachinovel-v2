//
//  NephisPackLibrary.swift — the Nephis model packs kept on this iPhone (".tnmodel" files made on the PC,
//  unpacked by the app's NephisModelPack.swift) and which one she reads with.
//
//  Layout (`root` = Application Support/NephisPacks; 350-500 MB per pack, rebuilt from the PC any time, so
//  excluded from backups):
//    <root>/<id>/…                    one unpacked pack: FluidAudio's models folder layout, her voice files, pack.json
//    <root>/<id>/library-entry.json   {name, addedAt}: what the list shows when pack.json has no name, and its order
//    <root>/active.json               {"id": "<id>"}: the pack she reads with (absent: none, the shipped model)
//    <root>/dialogue.json             {"id": "<id>"}: the pack she reads quoted dialogue with (absent: none; the narrator
//                                     pack reads everything, as before 2026-10-15)
//    <root>/roles.json                {"<id>": "narrator"|"dialogue"}: the user's role for a pack (Developer › Voice
//                                     Packs), over pack.json's "role"
//    <root>/.incoming-<uuid>          a pack being unpacked; leftovers of a killed app are removed by `migrate`
//  An id is "p" + the first 16 hex digits of the SHA-256 of the pack's name and pack.json's "made", so a pack with
//  the same name and date opened again replaces its old copy. Ids from the UI are checked against that pattern
//  before any path is built.
//  Until 2026-10-13 the app kept one pack, at Application Support/NephisModel: `migrate` moves it in (a rename on the
//  same volume: nothing is copied or downloaded again) and makes it the active pack.
//

import CryptoKit
import Foundation

public struct NephisPack: Equatable, Sendable {
    public var id: String
    public var name: String
    /// pack.json's "made" (the date it was made on the PC), if it says.
    public var made: String?
    /// It carries her studio (Models/nephis-studio/studio.json).
    public var studio: Bool
    /// Size on disk.
    public var bytes: Int64
    /// When it was added on this iPhone (ISO 8601).
    public var addedAt: String
    /// What it reads: narration (the active pack) or quoted dialogue (the dialogue pack); pack.json's "role" unless the
    /// user assigned another.
    public var role: NephisVoiceRole = .narrator
}

public enum NephisPackError: Error, LocalizedError, Equatable {
    case incomplete
    case unknownPack(String)

    public var errorDescription: String? {
        switch self {
        case .incomplete: return "it isn’t a Nephis model pack (files are missing)"
        case .unknownPack(let id): return "the voice pack “\(id.prefix(40))” isn’t on this iPhone any more"
        }
    }
}

/// Every call reads and writes the folder; `lock` keeps an install (background) and a tap in Settings (main) apart.
public final class NephisPackLibrary: @unchecked Sendable {  // @unchecked: its only state is `root` and the lock
    public let root: URL
    private let lock = NSLock()

    public init(root: URL) {
        self.root = root
    }

    private static let language = "Models/pocket-tts/v2.1/english"  // FluidAudio's folder for Repo.pocketTts
    static let activeName = "active.json"
    static let dialogueName = "dialogue.json"
    static let rolesName = "roles.json"
    static let entryName = "library-entry.json"
    static let stagingPrefix = ".incoming-"

    /// Files a pack must hold (relative to its root) before it is kept.
    public static let required = [
        "\(language)/cond_prefill_ane.mlmodelc/model.mil", "\(language)/cond_prefill_ane.mlmodelc/weights/weight.bin",
        "\(language)/flowlm_step_ane.mlmodelc/model.mil", "\(language)/flowlm_step_ane.mlmodelc/weights/weight.bin",
        "\(language)/flow_decoder_fused.mlmodelc/model.mil", "\(language)/flow_decoder_fused.mlmodelc/weights/weight.bin",
        "\(language)/mimi_decoder.mlmodelc/model.mil",
        "\(language)/constants_bin/bos_emb.bin", "\(language)/constants_bin/bos_before_voice.bin",
        "\(language)/constants_bin/text_embed_table.bin", "\(language)/constants_bin/tokenizer.model",
        "BuiltInVoices/pocket/nephis.pocketvoice", "BuiltInVoices/pocket/nephis.json",
        "BuiltInVoices/pocket/speaker-projection.bin", "BuiltInVoices/pocket/speaker-projection.json",
    ]

    public static func isComplete(_ dir: URL) -> Bool {
        required.allSatisfy { FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path) }
    }

    /// What a pack says about itself (pack.json: name, made, checkpoint, chain, …).
    public static func info(in dir: URL) -> [String: Any]? {
        guard let d = try? Data(contentsOf: dir.appendingPathComponent("pack.json")) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }

    /// "p" + 16 lowercase hex digits.
    public static func isValidID(_ id: String) -> Bool {
        id.utf8.count == 17 && id.hasPrefix("p") && id.utf8.dropFirst().allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    public static func id(name: String, made: String?) -> String {
        let hex = SHA256.hash(data: Data("\(name)\n\(made ?? "")".utf8)).map { String(format: "%02x", $0) }.joined()
        return "p" + String(hex.prefix(16))
    }

    public func directory(_ id: String) throws -> URL {
        guard Self.isValidID(id) else { throw NephisPackError.unknownPack(id) }
        return root.appendingPathComponent(id, isDirectory: true)
    }

    // MARK: - Reading

    /// The pack she reads with, when it is there and complete.
    public var activeID: String? {
        lock.lock()
        defer { lock.unlock() }
        return activeUnlocked()
    }

    /// The active pack's folder (FluidAudio's models directory for her engine), or nil.
    public var activeDirectory: URL? { activeID.flatMap { try? directory($0) } }

    /// The pack she reads quoted dialogue with, when it is there, complete and a dialogue pack (nil: the narrator pack
    /// reads everything, exactly as before).
    public var dialogueID: String? {
        lock.lock()
        defer { lock.unlock() }
        return dialogueUnlocked()
    }

    public var dialogueDirectory: URL? { dialogueID.flatMap { try? directory($0) } }

    /// A pack's role: the user's assignment, else pack.json's "role", else narrator.
    public func role(of id: String) -> NephisVoiceRole {
        lock.lock()
        defer { lock.unlock() }
        return roleUnlocked(id)
    }

    /// Every complete pack, the most recently added first.
    public func list() -> [NephisPack] {
        lock.lock()
        defer { lock.unlock() }
        return listUnlocked()
    }

    public var totalBytes: Int64 { list().reduce(0) { $0 + $1.bytes } }

    private func activeUnlocked() -> String? {
        guard let id = activeNameUnlocked(), let dir = try? directory(id), Self.isComplete(dir), roleUnlocked(id) == .narrator else { return nil }
        return id
    }

    private func dialogueUnlocked() -> String? {
        guard let id = idUnlocked(Self.dialogueName), let dir = try? directory(id), Self.isComplete(dir), roleUnlocked(id) == .dialogue else { return nil }
        return id
    }

    private func roleUnlocked(_ id: String) -> NephisVoiceRole {
        if let assigned = rolesUnlocked()[id].flatMap(NephisVoiceRole.init(rawValue:)) { return assigned }
        guard let dir = try? directory(id) else { return .narrator }
        return NephisVoiceRole(packInfo: Self.info(in: dir))
    }

    /// The user's role assignments (roles.json), by pack id.
    private func rolesUnlocked() -> [String: String] {
        guard let d = try? Data(contentsOf: root.appendingPathComponent(Self.rolesName)),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: String] else { return [:] }
        return o
    }

    private func writeRoles(_ roles: [String: String]) throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: roles, options: [.sortedKeys]).write(to: root.appendingPathComponent(Self.rolesName), options: .atomic)
    }

    private func listUnlocked() -> [NephisPack] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        return names.filter(Self.isValidID).compactMap(packUnlocked).sorted { ($0.addedAt, $0.id) > ($1.addedAt, $1.id) }
    }

    private func packUnlocked(_ id: String) -> NephisPack? {
        guard let dir = try? directory(id), Self.isComplete(dir) else { return nil }
        let info = Self.info(in: dir)
        let entry = (try? Data(contentsOf: dir.appendingPathComponent(Self.entryName)))
            .flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
        let name = Self.nonEmpty(info?["name"]) ?? Self.nonEmpty(entry?["name"]) ?? "Unnamed pack"
        let studio = FileManager.default.fileExists(atPath: dir.appendingPathComponent("Models/nephis-studio/studio.json").path)
        return NephisPack(id: id, name: name, made: Self.nonEmpty(info?["made"]), studio: studio, bytes: Self.size(of: dir),
                          addedAt: Self.nonEmpty(entry?["addedAt"]) ?? "", role: roleUnlocked(id))
    }

    // MARK: - Adding, switching, deleting

    /// A new empty folder to unpack a pack into (inside `root`, so `add` is a rename).
    public func stagingDirectory() throws -> URL {
        let dir = root.appendingPathComponent(Self.stagingPrefix + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Keep the unpacked pack in `staged` (moved, not copied) and make it the active pack, or for a dialogue pack (its
    /// role: pack.json's "role", or the user's for an older copy) the dialogue pack; the narrator pack stays as it was. A
    /// pack with the same name and date replaces the old copy (`replaced`). `fallbackName` (the file's name) names a pack
    /// whose pack.json doesn't.
    @discardableResult
    public func add(staged: URL, fallbackName: String, now: Date = Date()) throws -> (pack: NephisPack, replaced: Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard Self.isComplete(staged) else { throw NephisPackError.incomplete }
        let info = Self.info(in: staged)
        let name = Self.nonEmpty(info?["name"]) ?? fallbackName
        let id = Self.id(name: name, made: Self.nonEmpty(info?["made"]))
        let dest = try directory(id)
        try writeJSON(["name": name, "addedAt": Self.iso(now)], to: staged.appendingPathComponent(Self.entryName))
        let fm = FileManager.default
        let replaced = fm.fileExists(atPath: dest.path)
        if replaced {
            // The old copy stays until the new one is in place.
            let old = root.appendingPathComponent(Self.stagingPrefix + "old-" + UUID().uuidString, isDirectory: true)
            try fm.moveItem(at: dest, to: old)
            do { try fm.moveItem(at: staged, to: dest) } catch {
                try? fm.moveItem(at: old, to: dest)
                throw error
            }
            try? fm.removeItem(at: old)
        } else {
            try fm.moveItem(at: staged, to: dest)
        }
        Self.excludeFromBackup(dest)
        if roleUnlocked(id) == .dialogue {
            try writeID(id, to: Self.dialogueName)
            // It replaced the narrator pack's own copy (the same name and date, now a dialogue pack): the next narrator.
            if activeNameUnlocked() == id { try writeActive(nextUnlocked(.narrator, besides: id)) }
        } else {
            try writeActive(id)
            if idUnlocked(Self.dialogueName) == id { try writeID(nextUnlocked(.dialogue, besides: id), to: Self.dialogueName) }
        }
        guard let pack = packUnlocked(id) else { throw NephisPackError.incomplete }
        return (pack, replaced)
    }

    /// Make `id` the pack she reads with; nil: none (the shipped model). A dialogue pack becomes the dialogue pack instead.
    public func activate(_ id: String?) throws {
        lock.lock()
        defer { lock.unlock() }
        if let id {
            guard packUnlocked(id) != nil else { throw NephisPackError.unknownPack(id) }
            if roleUnlocked(id) == .dialogue { return try writeID(id, to: Self.dialogueName) }
        }
        try writeActive(id)
    }

    /// Make `id` the pack she reads quoted dialogue with; nil: none (the narrator pack reads everything).
    public func activateDialogue(_ id: String?) throws {
        lock.lock()
        defer { lock.unlock() }
        if let id { guard packUnlocked(id) != nil, roleUnlocked(id) == .dialogue else { throw NephisPackError.unknownPack(id) } }
        try writeID(id, to: Self.dialogueName)
    }

    /// The user's role for a pack (over pack.json's). A pack that becomes a dialogue pack stops being the narrator (the
    /// next narrator pack reads, or the shipped model) and becomes the dialogue pack when there is none; one that becomes a
    /// narrator pack stops being the dialogue pack (the next dialogue pack, or none) and becomes the narrator when none is.
    public func setRole(_ id: String, _ role: NephisVoiceRole) throws {
        lock.lock()
        defer { lock.unlock() }
        guard packUnlocked(id) != nil else { throw NephisPackError.unknownPack(id) }
        var roles = rolesUnlocked()
        roles[id] = role.rawValue
        try writeRoles(roles)
        switch role {
        case .dialogue:
            if activeNameUnlocked() == id { try writeActive(nextUnlocked(.narrator, besides: id)) }
            if dialogueUnlocked() == nil { try writeID(id, to: Self.dialogueName) }
        case .narrator:
            if idUnlocked(Self.dialogueName) == id { try writeID(nextUnlocked(.dialogue, besides: id), to: Self.dialogueName) }
            if activeUnlocked() == nil { try writeActive(id) }
        }
    }

    /// Delete a pack. Deleting the active one makes the next narrator pack in the list active (none when it was the
    /// last); deleting the dialogue pack makes the next dialogue pack it (or none). Returns the active pack's id afterwards.
    @discardableResult
    public func delete(_ id: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        let dir = try directory(id)
        if activeUnlocked() == id { try writeActive(nextUnlocked(.narrator, besides: id)) }
        if dialogueUnlocked() == id { try writeID(nextUnlocked(.dialogue, besides: id), to: Self.dialogueName) }
        if FileManager.default.fileExists(atPath: dir.path) { try FileManager.default.removeItem(at: dir) }
        var roles = rolesUnlocked()
        if roles.removeValue(forKey: id) != nil { try? writeRoles(roles) }
        return activeUnlocked()
    }

    /// The first pack in the list with `role`, other than `id`.
    private func nextUnlocked(_ role: NephisVoiceRole, besides id: String) -> String? {
        listUnlocked().first { $0.id != id && $0.role == role }?.id
    }

    /// At launch, before anything else uses the library: remove unpacks a killed app left behind, and move the single
    /// pack older builds kept (`legacy`, Application Support/NephisModel) into the library, active unless another pack
    /// already is. An incomplete legacy folder is left alone (it was never used). True when a pack was moved in.
    @discardableResult
    public func migrate(legacy: URL, now: Date = Date()) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let fm = FileManager.default
        for name in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] where name.hasPrefix(Self.stagingPrefix) {
            try? fm.removeItem(at: root.appendingPathComponent(name, isDirectory: true))
        }
        guard fm.fileExists(atPath: legacy.path), Self.isComplete(legacy) else { return false }
        let info = Self.info(in: legacy)
        let name = Self.nonEmpty(info?["name"]) ?? "Nephis"
        let id = Self.id(name: name, made: Self.nonEmpty(info?["made"]))
        guard let dest = try? directory(id) else { return false }
        do {
            try fm.createDirectory(at: root, withIntermediateDirectories: true)
            if fm.fileExists(atPath: dest.path) {
                try fm.removeItem(at: legacy)  // the same pack is in the library already
            } else {
                try fm.moveItem(at: legacy, to: dest)
                try writeJSON(["name": name, "addedAt": Self.iso(now)], to: dest.appendingPathComponent(Self.entryName))
                Self.excludeFromBackup(dest)
            }
            if activeUnlocked() == nil, roleUnlocked(id) == .narrator { try writeActive(id) }
            return true
        } catch {
            return false
        }
    }

    /// Folders in the library that hold no usable pack: unpacks left behind (`.incoming-…`, also removed at launch by
    /// `migrate`) and pack folders missing files. Never the folder active.json names. Call only while nothing installs.
    public func leftoverFolders() -> [URL] {
        lock.lock()
        defer { lock.unlock() }
        let active = activeNameUnlocked()
        let dialogue = idUnlocked(Self.dialogueName)
        return ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).compactMap { name in
            let url = root.appendingPathComponent(name, isDirectory: true)
            if name.hasPrefix(Self.stagingPrefix) { return url }
            guard Self.isValidID(name), name != active, name != dialogue, !Self.isComplete(url) else { return nil }
            return url
        }
    }

    /// Paths (standardized) a clean-up must never touch: every complete pack and the one active.json names.
    public func protectedFolders() -> Set<String> {
        lock.lock()
        defer { lock.unlock() }
        var out = Set(listUnlocked().map { root.appendingPathComponent($0.id, isDirectory: true).standardizedFileURL.path })
        for id in [activeNameUnlocked(), idUnlocked(Self.dialogueName)].compactMap({ $0 }) {
            out.insert(root.appendingPathComponent(id, isDirectory: true).standardizedFileURL.path)
        }
        return out
    }

    /// The id active.json names, complete or not.
    private func activeNameUnlocked() -> String? { idUnlocked(Self.activeName) }

    /// The id a {"id"} file names (active.json, dialogue.json), complete or not.
    private func idUnlocked(_ file: String) -> String? {
        guard let d = try? Data(contentsOf: root.appendingPathComponent(file)),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
        return o["id"] as? String
    }

    // MARK: - Helpers

    private func writeActive(_ id: String?) throws {
        try writeID(id, to: Self.activeName)
    }

    /// {"id": id} into `file` (nil: the file goes).
    private func writeID(_ id: String?, to file: String) throws {
        let url = root.appendingPathComponent(file)
        guard let id else {
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            return
        }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try writeJSON(["id": id], to: url)
    }

    private func writeJSON(_ o: [String: String], to url: URL) throws {
        try JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]).write(to: url, options: .atomic)
    }

    private static func nonEmpty(_ v: Any?) -> String? {
        guard let s = v as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return s
    }

    static func size(of dir: URL) -> Int64 {
        let keys: [URLResourceKey] = [.totalFileAllocatedSizeKey, .fileAllocatedSizeKey, .isRegularFileKey]
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: keys) else { return 0 }
        var total: Int64 = 0
        for case let url as URL in e {
            guard let v = try? url.resourceValues(forKeys: Set(keys)), v.isRegularFile == true else { continue }
            total += Int64(v.totalFileAllocatedSize ?? v.fileAllocatedSize ?? 0)
        }
        return total
    }

    private static func excludeFromBackup(_ dir: URL) {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var d = dir
        try? d.setResourceValues(values)
    }

    private static func iso(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }
}
