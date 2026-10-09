//
//  NephisModelPack.swift — Nephis's trained voice (personal flavor): a ".tnmodel" made on the PC
//  (tachinovel-tts-lab coreml-swap/pack.py) holds Pocket TTS's iPhone models with weights fine-tuned on her
//  (Models/pocket-tts-coreml/v2.1/english/…, FluidAudio's cache layout) and her voice files for that model
//  (BuiltInVoices/pocket/nephis*.pocketvoice + speaker-projection.bin). It is an uncompressed tar, opened from
//  Files or the share sheet ("Open in TachiNovel", SceneDelegate) or dropped into the app's Documents folder
//  (Finder / Apple Devices file sharing). It unpacks into Application Support and Nephis reads with it from her
//  next load. Nothing in it is executed: CoreML models are data the system compiles, the rest is numbers.
//

import ExpressiveCore
import Foundation
import os

enum NephisModelPack {
    static let fileExtension = "tnmodel"
    static let didInstall = Notification.Name("TachiNovelNephisModelInstalled")
    private static let log = Logger(subsystem: "app.tachinovel", category: "voice-expressive")
    private static let language = "Models/pocket-tts-coreml/v2.1/english"

    /// Files a pack must hold (relative to its root) before it replaces anything.
    static let required = [
        "\(language)/cond_prefill_ane.mlmodelc/model.mil", "\(language)/cond_prefill_ane.mlmodelc/weights/weight.bin",
        "\(language)/flowlm_step_ane.mlmodelc/model.mil", "\(language)/flowlm_step_ane.mlmodelc/weights/weight.bin",
        "\(language)/flow_decoder_fused.mlmodelc/model.mil", "\(language)/flow_decoder_fused.mlmodelc/weights/weight.bin",
        "\(language)/mimi_decoder.mlmodelc/model.mil",
        "\(language)/constants_bin/bos_emb.bin", "\(language)/constants_bin/bos_before_voice.bin",
        "\(language)/constants_bin/text_embed_table.bin", "\(language)/constants_bin/tokenizer.model",
        "BuiltInVoices/pocket/nephis.pocketvoice", "BuiltInVoices/pocket/nephis.json",
        "BuiltInVoices/pocket/speaker-projection.bin", "BuiltInVoices/pocket/speaker-projection.json",
    ]

    static var root: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("NephisModel", isDirectory: true)
    }

    static func complete(_ dir: URL) -> Bool {
        required.allSatisfy { FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path) }
    }

    /// The installed pack's root (FluidAudio's models directory for her engine), or nil.
    static var modelsDirectory: URL? { complete(root) ? root : nil }
    /// Her voice files for the installed model (a BuiltInVoices-shaped folder), or nil.
    static var voicesDirectory: URL? { complete(root) ? root.appendingPathComponent("BuiltInVoices", isDirectory: true) : nil }
    /// What the pack says about itself (pack.json: name, made, checkpoint), for the Voice Lab.
    static var info: [String: Any]? {
        guard complete(root), let d = try? Data(contentsOf: root.appendingPathComponent("pack.json")) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }

    static func handles(_ url: URL) -> Bool { url.isFileURL && url.pathExtension.lowercased() == fileExtension }

    /// "Open in TachiNovel" or a pack found in Documents: unpack off the main thread, then swap it in. The UI hears
    /// about it through the voice-import event (same message banner).
    static func open(_ url: URL) {
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try install(from: url) }
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

    /// A pack copied into Documents (file sharing): install it once, then remove the copy. Called at launch.
    static func installFromDocuments() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        guard let files = try? FileManager.default.contentsOfDirectory(at: docs, includingPropertiesForKeys: nil),
              let pack = files.first(where: handles) else { return }
        DispatchQueue.global(qos: .utility).async {
            do {
                let name = try install(from: pack)
                try? FileManager.default.removeItem(at: pack)
                DispatchQueue.main.async {
                    ExpressiveService.shared.reloadNephisModel()
                    post(ok: true, message: "Nephis’s trained voice “\(name)” is installed.")
                }
            } catch {
                log.error("expressive: Nephis model pack in Documents: \(error.localizedDescription, privacy: .public)")
            }
        }
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

    /// Unpack `url` (a tar) into a fresh folder, check it, then replace the installed pack. Returns the pack's name.
    static func install(from url: URL) throws -> String {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let fm = FileManager.default
        let staging = root.deletingLastPathComponent().appendingPathComponent("NephisModel.incoming", isDirectory: true)
        try? fm.removeItem(at: staging)
        try fm.createDirectory(at: staging, withIntermediateDirectories: true)
        do {
            try Tar.extract(url, into: staging)
            guard complete(staging) else { throw PackError.notAPack("files are missing") }
            try? fm.removeItem(at: root)
            try fm.moveItem(at: staging, to: root)
        } catch {
            try? fm.removeItem(at: staging)
            throw error
        }
        var noBackup = URLResourceValues()
        noBackup.isExcludedFromBackup = true  // ~330 MB, rebuilt from the PC any time
        var r = root
        try? r.setResourceValues(noBackup)
        let name = (info?["name"] as? String) ?? url.deletingPathExtension().lastPathComponent
        log.info("expressive: Nephis model pack \(name, privacy: .public) installed")
        return name
    }

    /// Remove the installed pack: she reads with Kyutai's released model again.
    static func remove() {
        try? FileManager.default.removeItem(at: root)
        ExpressiveService.shared.reloadNephisModel()
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
