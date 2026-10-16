//
//  NarrationAudioStore.swift — chapter audio on this iPhone (audio downloads part 1, 2026-10-16): Application
//  Support/NarrationAudio (excluded from backups), one folder per novel with each chapter's AAC .m4a and its timestamp
//  manifest (NarrationManifest.swift, with `render`: the voice key, the director's delivery, the calls), index.json
//  (HDVoiceCore NarrationAudioIndex, schema 2) and work/ (chapters being rendered: ChapterAudioRenderer).
//
//  The voice that reads now has a key (NarrationVoiceKey: her narrator and dialogue packs, her studio, the packs' chains
//  and delivery settings, the novel's pronunciation lexicon, the renderer version). Only audio with that key plays
//  (Kasta, 2026-10-15): audio of an older version of the voice is deleted and its chapter queued again (while charging);
//  another voice's audio (Kokoro's while Nephis reads) is kept but not played. The lexicon part is the core's
//  `narration.lexicon.get` for the novel, asked again before a file plays.
//
//  Kinds: downloads stay until deleted ("Delete audio after listening", off by default, deletes them once heard);
//  "Prepare for the drive" audio goes after listening and is capped (DrivePrepPolicy.defaultCapBytes). The first launch
//  moves the drive folder (Application Support/DriveAudio, schema 1) in. Main thread.
//

import ExpressiveCore
import Foundation
import HDVoiceCore
import os

final class NarrationAudioStore: @unchecked Sendable {
    static let shared = NarrationAudioStore()
    static let changed = Notification.Name("tachinovel.narrationAudioChanged")
    private static let deleteAfterKey = "tachinovel.audio.deleteAfterListening"

    let folder: URL
    var workRoot: URL { folder.appendingPathComponent("work", isDirectory: true) }
    private(set) var index: NarrationAudioIndex
    /// Each novel's pronunciation lexicon (hash), as last asked of the core.
    private var lexicons: [String: String] = [:]
    private var lexiconWaiters: [String: [(String?) -> Void]] = [:]
    /// The voice (without a novel's lexicon) the last sweep checked against.
    private var lastSwept = ""
    private let log = Logger(subsystem: "app.tachinovel", category: "audio")

    /// "Delete audio after listening" for downloads (Kasta's decision: off by default). Drive audio always goes.
    static var deleteAfterListening: Bool {
        get { UserDefaults.standard.bool(forKey: deleteAfterKey) }
        set { UserDefaults.standard.set(newValue, forKey: deleteAfterKey) }
    }

    private static let autoDownloadKey = "tachinovel.audio.autoDownload"
    /// Settings › Downloads › "Include Audio in Auto-Download" (off by default): the chapters v1's auto-download keeps get
    /// audio too, made only while charging (DrivePrep.register).
    static var autoDownloadAudio: Bool {
        get { UserDefaults.standard.bool(forKey: autoDownloadKey) }
        set { UserDefaults.standard.set(newValue, forKey: autoDownloadKey) }
    }

    private init() {
        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? fm.temporaryDirectory
        var dir = support.appendingPathComponent("NarrationAudio", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        folder = dir
        if let data = try? Data(contentsOf: dir.appendingPathComponent("index.json")),
           let idx = try? JSONDecoder().decode(NarrationAudioIndex.self, from: data), idx.schemaVersion == NarrationAudioIndex.schema {
            index = idx
        } else {
            index = NarrationAudioIndex()
        }
        migrateDriveFolder(support.appendingPathComponent("DriveAudio", isDirectory: true))
        prune()
    }

    func url(_ relative: String) -> URL { folder.appendingPathComponent(relative) }

    func novelFolder(_ novelKey: String) -> URL {
        let dir = folder.appendingPathComponent(NarrationAudioIndex.folder(novelKey: novelKey), isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func workFolder(novelKey: String, chapterPath: String) -> URL {
        workRoot.appendingPathComponent(NarrationAudioIndex.workFolder(novelKey: novelKey, chapterPath: chapterPath), isDirectory: true)
    }

    /// The chapter's audio with its files present (any voice).
    func entry(novelKey: String, chapterPath: String) -> NarrationAudioEntry? {
        guard let e = index.find(novelKey: novelKey, chapterPath: chapterPath) else { return nil }
        let fm = FileManager.default
        guard fm.fileExists(atPath: url(e.audioFile).path), fm.fileExists(atPath: url(e.manifestFile).path) else { return nil }
        return e
    }

    // MARK: - The voice that reads now

    /// Nephis is the chosen reader (her audio is the current voice even while her model can't run: crashed, resting),
    /// else Kokoro.
    static var nephisReads: Bool {
        guard VoiceSettings.shared.prefs.delivery.isNephis, NarrationController.listenEngine() == .pocketTts else { return false }
        // Her model on this iPhone at all (not downloaded: Kokoro reads, and renders).
        return ExpressiveService.shared.isInstalled(.pocketTts)
    }

    /// Her part of the key: her packs, her studio, their chains and the delivery settings that change her sound.
    static func nephisParts() -> (narrator: String, dialogue: String, studio: Bool, chain: String) {
        let info = NephisModelPack.info
        let sha = (info?["weightsSha256"] as? String).map { String($0.prefix(12)) } ?? "shipped"
        let narrator = "\(sha)|\((info?["made"] as? String) ?? "")"
        let dialogueInfo = NephisModelPack.dialogueInfo
        let dialogue = dialogueInfo.map { d in
            (d["weightsSha256"] as? String).map { String($0.prefix(12)) } ?? ((d["made"] as? String) ?? "pack")
        } ?? "none"
        let studio = SessionRate.forRead(.pocketTts) == SessionRate.studio
        let d = VoiceSettings.shared.prefs.delivery
        let settings: [String: Any] = [
            "natural": d.natural, "director": d.director, "moods": d.moods, "performed": d.performed, "unit": d.unit,
            "systemChime": d.systemChime, "systemTone": d.systemTone, "studioSound": d.studioSound, "pocketVoice": d.pocketVoice,
        ]
        let chain = NarrationAudioHash.json(["narrator": info?["chain"] ?? "none", "dialogue": dialogueInfo?["chain"] ?? "none",
                                             "settings": settings] as [String: Any])
        return (narrator, dialogue, studio, chain)
    }

    /// The key for `novelKey` with its lexicon hash `lexicon`.
    static func key(novelKey: String, lexicon: String) -> NarrationVoiceKey {
        if nephisReads {
            let p = nephisParts()
            return NarrationVoiceKey(family: .nephis, narrator: p.narrator, dialogue: p.dialogue, studio: p.studio, chain: p.chain, lexicon: lexicon)
        }
        let prefs = VoiceSettings.shared.prefs
        let voice = prefs.preparedVoice(forNovel: novelKey)
        return NarrationVoiceKey(family: .kokoro, narrator: voice, chain: NarrationAudioHash.fnv(voice), lexicon: lexicon)
    }

    /// The key now, from the lexicon last asked (nil: not asked yet).
    func currentKey(novelKey: String) -> NarrationVoiceKey? {
        lexicons[novelKey].map { Self.key(novelKey: novelKey, lexicon: $0) }
    }

    /// The key now, asking the core for the novel's lexicon first (at most `timeout` seconds; then the last one known).
    func withCurrentKey(novelKey: String, timeout: Double = 1.5, _ done: @escaping (NarrationVoiceKey?) -> Void) {
        let answered = Box(false)
        let finish = MainBound({ [weak self] in
            guard !answered.value else { return }
            answered.value = true
            done(self?.currentKey(novelKey: novelKey))
        })
        refreshLexicon(novelKey: novelKey) { _ in finish.value() }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish.value() }
    }

    /// Asks the core for the novel's pronunciation lexicon (global + the novel's) and keeps its hash.
    func refreshLexicon(novelKey: String, _ done: @escaping (String?) -> Void) {
        if lexiconWaiters[novelKey] != nil {
            lexiconWaiters[novelKey]?.append(done)
            return
        }
        lexiconWaiters[novelKey] = [done]
        let deliver = MainBound({ [weak self] (hash: String?) in
            guard let self else { return }
            if let hash { self.lexicons[novelKey] = hash }
            let waiters = self.lexiconWaiters.removeValue(forKey: novelKey) ?? []
            for w in waiters { w(hash ?? self.lexicons[novelKey]) }
        })
        CoreHost.shared.request("narration.lexicon.get", args: ["novelKey": novelKey]) { ok, result in
            let hash: String? = ok ? NarrationAudioHash.json(result ?? NSNull()) : nil
            DispatchQueue.main.async { deliver.value(hash) }
        }
    }

    // MARK: - What plays

    /// The chapter's audio if it is in the voice that reads now (lexicon as last asked). Synchronous.
    func playable(novelKey: String, chapterPath: String) -> NarrationAudioEntry? {
        guard let e = entry(novelKey: novelKey, chapterPath: chapterPath) else { return nil }
        return NarrationAudioFreshness.of(stored: e.voice, current: currentKey(novelKey: novelKey)) == .fresh ? e : nil
    }

    /// The chapter's audio if it is in the voice that reads now, the lexicon asked again first; audio of an older version
    /// of the voice is deleted and the chapter queued again (while charging). On main; at once when there is no audio.
    func playable(novelKey: String, chapterPath: String, _ done: @escaping (NarrationAudioEntry?) -> Void) {
        guard entry(novelKey: novelKey, chapterPath: chapterPath) != nil else { return done(nil) }
        withCurrentKey(novelKey: novelKey) { [weak self] key in
            guard let self, let e = self.entry(novelKey: novelKey, chapterPath: chapterPath) else { return done(nil) }
            switch NarrationAudioFreshness.of(stored: e.voice, current: key) {
            case .fresh:
                done(e)
            case .stale:
                self.log.notice("audio: \(chapterPath, privacy: .public) was made with an older voice: read live, queued to render again")
                self.replaceStale([e])
                done(nil)
            case .other:
                done(nil)
            }
        }
    }

    /// Audio of an older version of the voice: never played, and its chapters queued again (DrivePrep, while charging);
    /// the new render replaces the file (Kasta: "deleted (or replaced)"). Kept until then, so a setting switched back for a
    /// comparison makes it current again instead of losing it.
    func replaceStale(_ entries: [NarrationAudioEntry]) {
        guard !entries.isEmpty else { return }
        DrivePrep.shared.requeue(entries)
    }

    /// Every novel's audio checked against the voice now (each novel's lexicon asked first): stale audio queued to be
    /// rendered again. Not while a pack is being installed. `force` false: only when the voice (without the lexicon)
    /// changed since the last sweep.
    func sweep(force: Bool = false) {
        let novels = Set(index.entries.map(\.novelKey))
        guard !novels.isEmpty, !NephisModelPack.installing else { return }
        let voiceNow = Self.key(novelKey: "", lexicon: "").text
        guard force || voiceNow != lastSwept else { return }
        lastSwept = voiceNow
        for novel in novels {
            refreshLexicon(novelKey: novel) { [weak self] hash in
                guard let self, hash != nil else { return }
                self.replaceStale(self.index.stale { $0 == novel ? self.currentKey(novelKey: novel) : nil })
            }
        }
    }

    // MARK: - Writing

    /// Record a finished chapter: replaced files go (unless the same files), and drive audio is trimmed to its cap
    /// (never `keep`).
    func add(_ e: NarrationAudioEntry, keep: Set<String> = []) {
        if let old = index.upsert(e) { deleteFiles([old], keeping: [e.audioFile, e.manifestFile]) }
        deleteFiles(index.trimDrive(toBytes: DrivePrepPolicy.defaultCapBytes, keep: keep.union([e.id])))
        save()
    }

    /// Listened to the end: drive audio goes; a download goes only with "Delete audio after listening" on.
    func listened(novelKey: String, chapterPath: String) {
        guard let e = index.find(novelKey: novelKey, chapterPath: chapterPath) else { return }
        guard e.kind == .drive || Self.deleteAfterListening else { return }
        remove(novelKey: novelKey, chapterPath: chapterPath)
    }

    func remove(novelKey: String, chapterPath: String) {
        let gone = index.remove(novelKey: novelKey, chapterPath: chapterPath)
        guard !gone.isEmpty else { return }
        deleteFiles(gone)
        save()
    }

    /// One novel's audio (or everything with nil), of one kind or both.
    func remove(novelKey: String?, kind: NarrationAudioKind? = nil) {
        deleteFiles(novelKey.map { index.removeNovel($0, kind: kind) } ?? index.removeAll(kind: kind))
        save()
    }

    /// A chapter's work folder (an interrupted render) goes.
    func removeWork(novelKey: String, chapterPath: String) {
        try? FileManager.default.removeItem(at: workFolder(novelKey: novelKey, chapterPath: chapterPath))
    }

    /// Bytes of chapters being rendered (work folders).
    var workBytes: Int {
        let fm = FileManager.default
        guard let e = fm.enumerator(at: workRoot, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total = 0
        for case let u as URL in e { total += (try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0 }
        return total
    }

    func entries(novelKey: String?, kind: NarrationAudioKind? = nil) -> [[String: Any]] {
        let list = (novelKey.map { index.entries(novelKey: $0) } ?? index.entries).filter { kind == nil || $0.kind == kind }
        // One key per novel (the voice's parts read the packs' files).
        var keys: [String: NarrationVoiceKey?] = [:]
        return list.map { e in
            let current: NarrationVoiceKey?
            if let known = keys[e.novelKey] {
                current = known
            } else {
                current = currentKey(novelKey: e.novelKey)
                keys[e.novelKey] = .some(current)
            }
            let fresh = NarrationAudioFreshness.of(stored: e.voice, current: current)
            var d: [String: Any] = ["novelKey": e.novelKey, "chapterPath": e.chapterPath, "title": e.title, "voice": e.voice, "kind": e.kind.rawValue,
                                    "bytes": e.bytes, "durationSec": (e.durationMs / 1000).rounded(), "createdAt": e.createdAt,
                                    "fresh": current == nil ? NSNull() as Any : (fresh == .fresh) as Any]
            if let name = e.novelName, !name.isEmpty { d["novelName"] = name }
            return d
        }
    }

    /// The director's delivery stored with a chapter's audio (its manifest's render.delivery), if any.
    func delivery(novelKey: String, chapterPath: String) -> [String: Any]? {
        guard let e = index.find(novelKey: novelKey, chapterPath: chapterPath),
              let data = try? Data(contentsOf: url(e.manifestFile)),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return (obj["render"] as? [String: Any])?["delivery"] as? [String: Any]
    }

    private func deleteFiles(_ list: [NarrationAudioEntry], keeping: Set<String> = []) {
        for e in list {
            for f in [e.audioFile, e.manifestFile] where !keeping.contains(f) { try? FileManager.default.removeItem(at: url(f)) }
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(index) { try? data.write(to: folder.appendingPathComponent("index.json"), options: .atomic) }
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }

    // MARK: - Housekeeping

    /// The drive folder of older builds (schema 1): its files move into the novels' folders as drive audio (their keys
    /// stay: an older voice's audio is then replaced by the next sweep); the folder goes.
    private func migrateDriveFolder(_ old: URL) {
        let fm = FileManager.default
        guard fm.fileExists(atPath: old.path) else { return }
        if let data = try? Data(contentsOf: old.appendingPathComponent("index.json")),
           let v1 = try? JSONDecoder().decode(DriveCacheIndex.self, from: data) {
            let (moved, moves) = NarrationAudioIndex.migrate(v1)
            for (from, to) in moves {
                let target = url(to)
                try? fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? fm.removeItem(at: target)
                try? fm.moveItem(at: old.appendingPathComponent(from), to: target)
            }
            for e in moved.entries where index.find(novelKey: e.novelKey, chapterPath: e.chapterPath) == nil { index.upsert(e) }
            log.notice("audio: moved \(moved.entries.count) prepared chapters from the drive folder")
        }
        try? fm.removeItem(at: old)
        if let data = try? JSONEncoder().encode(index) { try? data.write(to: folder.appendingPathComponent("index.json"), options: .atomic) }
    }

    /// Entries whose files are gone are dropped; files no entry refers to (an interrupted encode) are deleted. The work
    /// folder is left for the renderer (it resumes or clears its own chapters).
    private func prune() {
        let fm = FileManager.default
        let before = index.entries.count
        index.entries.removeAll { !fm.fileExists(atPath: url($0.audioFile).path) || !fm.fileExists(atPath: url($0.manifestFile).path) }
        let known = Set(index.entries.flatMap { [$0.audioFile, $0.manifestFile] })
        for dir in (try? fm.contentsOfDirectory(atPath: folder.path)) ?? [] where dir.hasPrefix("n") {
            let names = (try? fm.contentsOfDirectory(atPath: url(dir).path)) ?? []
            for name in names where !known.contains("\(dir)/\(name)") { try? fm.removeItem(at: url("\(dir)/\(name)")) }
            if names.allSatisfy({ !known.contains("\(dir)/\($0)") }) { try? fm.removeItem(at: url(dir)) }
        }
        if index.entries.count != before, let data = try? JSONEncoder().encode(index) {
            try? data.write(to: folder.appendingPathComponent("index.json"), options: .atomic)
        }
    }
}
