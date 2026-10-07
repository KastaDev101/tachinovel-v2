//
//  VoiceImport.swift — imported voices (personal flavor, docs/voice-import.md): ".tnvoice" files opened
//  from Files or the share sheet ("Open in TachiNovel", SceneDelegate) and the preview player (imported and
//  shipped voices).
//
//  An opened file may sit in another app's container, in iCloud Drive (opened in place, security-scoped) or
//  in Documents/Inbox (a copy iOS made for us, which Files would show). It is copied into a temporary
//  folder first (coordinated read, size-capped), then checked and kept by ExpressiveService.importVoice
//  (ExpressiveCore VoicePack: nothing in the file is ever executed); the UI hears about it through the
//  plugin's "voiceImport" event, retained until a listener consumes it (a cold start opens the app first).
//

import AVFoundation
import ExpressiveCore
import Foundation
import os

enum VoiceImportInbox {
    static let didImport = Notification.Name("TachiNovelVoiceImportFinished")
    private static let log = Logger(subsystem: "app.tachinovel", category: "voice-expressive")

    static func handles(_ url: URL) -> Bool {
        url.isFileURL && url.pathExtension.lowercased() == VoicePackFormat.fileExtension
    }

    /// Temporary folder for files on their way in (removed after each import).
    static func directory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("voice-import", isDirectory: true)
    }

    /// "Open in TachiNovel": copy the file in, import it, tell the UI. Main thread.
    static func open(_ url: URL) {
        guard ExpressiveService.voiceImportEnabled else {
            log.info("expressive: ignored an opened voice file (voice import is not part of this build)")
            return
        }
        let name = url.lastPathComponent
        DispatchQueue.global(qos: .userInitiated).async {
            let copied = copyIn(url)
            DispatchQueue.main.async {
                switch copied {
                case .failure(let error):
                    post(ok: false, message: error.localizedDescription, id: nil)
                case .success(let local):
                    ExpressiveService.shared.importVoice(from: local, sourceName: name) { result in
                        try? FileManager.default.removeItem(at: local)
                        switch result {
                        case .success(let r):
                            let verb = r.replaced ? "is already on this iPhone (updated)" : "imported"
                            post(ok: true, message: "“\(r.voice.name)” \(verb). Tap Use to make it the narrator voice.", id: r.voice.id)
                        case .failure(let error):
                            post(ok: false, message: error.localizedDescription, id: nil)
                        }
                    }
                }
            }
        }
    }

    private static func post(ok: Bool, message: String, id: String?) {
        if !ok { log.error("expressive: voice import failed: \(message, privacy: .public)") }
        NotificationCenter.default.post(name: didImport, object: nil, userInfo: ["ok": ok, "message": message, "id": id ?? NSNull()])
    }

    /// A private copy of an opened file: security-scoped access, coordinated read, size cap before copying.
    static func copyIn(_ url: URL) -> Result<URL, Error> {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let fm = FileManager.default
        let dir = directory()
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent("\(UUID().uuidString).\(VoicePackFormat.fileExtension)")
        var result: Result<URL, Error> = .failure(VoicePackError.notAVoiceFile("it couldn’t be read"))
        var coordinationError: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: .withoutChanges, error: &coordinationError) { readable in
            do {
                let size = (try? readable.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                guard size <= VoicePackFormat.maxFileBytes else { throw VoicePackError.tooLarge(bytes: size, limit: VoicePackFormat.maxFileBytes) }
                try fm.copyItem(at: readable, to: dest)
                result = .success(dest)
            } catch {
                result = .failure(error)
            }
        }
        if let coordinationError { result = .failure(coordinationError) }
        // A copy iOS made in our Documents/Inbox ("Copy to TachiNovel"): Files shows that folder, so tidy it up.
        if let documents = fm.urls(for: .documentDirectory, in: .userDomainMask).first,
           url.standardizedFileURL.path.hasPrefix(documents.appendingPathComponent("Inbox").standardizedFileURL.path + "/") {
            try? fm.removeItem(at: url)
        }
        return result
    }
}

/// Plays a voice's preview.m4a (made on the PC): an imported voice's file, or a shipped voice's bytes.
final class VoicePreviewPlayer: NSObject, AVAudioPlayerDelegate {
    enum Source {
        case file(URL)
        case data(Data)
    }

    static let shared = VoicePreviewPlayer()
    private var player: AVAudioPlayer?

    func play(_ source: Source) throws {
        stop()
        let p: AVAudioPlayer
        switch source {
        case .file(let url): p = try AVAudioPlayer(contentsOf: url)
        case .data(let data): p = try AVAudioPlayer(data: data, fileTypeHint: AVFileType.m4a.rawValue)
        }
        p.delegate = self
        guard p.duration > 0, p.duration < 120 else { throw VoicePackError.damaged("the preview isn’t playable audio") }
        p.prepareToPlay()
        guard p.play() else { throw VoicePackError.damaged("the preview couldn’t be played") }
        player = p
    }

    func stop() {
        player?.stop()
        player = nil
    }

    // AVAudioPlayer calls its delegate on the main thread.
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        if self.player === player { self.player = nil }
    }
}
