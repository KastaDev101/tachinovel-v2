//
//  ExpressiveVoicePlugin.swift — Capacitor plugin "ExpressiveVoice" (JS: src/ui/native/expressive-lab.ts).
//  EXPERIMENTAL, Voice Lab only (Settings › About › tap the version 5 times › Experimental engines).
//
//  status                         engines (size, license, installed, download/load state), device, crashes,
//                                 the current lab session and speed test
//  download / cancelDownload      {engine}: pinned model files, Wi-Fi only (ExpressiveService)
//  remove                         {engine}: delete the model files
//  play                           {engine: id | "kokoro", sample, lines: [{text, emotion, style?, role}]}
//  stop
//  speedTest / cancelSpeedTest    {engine, sample, lines}: render without playing, measure
//  unload                         free the loaded model now
//  resetCrashes                   turn the experimental engines back on after the crash protection tripped
//
//  Imported voices (personal flavor, docs/voice-import.md; status() carries them as `voices`):
//  importVoice                    Files picker for a .tnvoice → checked and kept → {voice, replaced, status} or
//                                 {cancelled}; an invalid file is rejected with the reason (code INVALID_VOICE)
//  selectVoice                    {id | null}: Chatterbox Nano's narrator voice (null = built-in), kept across launches
//  renameVoice / deleteVoice      {id, name} / {id}
//  playVoiceSample                {id | null}: the file's preview, else Chatterbox Nano reads a line in that voice
//  event "voiceImport"            {ok, message, id?}: a .tnvoice opened with "Open in TachiNovel" (SceneDelegate)
//

import Capacitor
import ExpressiveCore
import Foundation

@objc(ExpressiveVoicePlugin)
public class ExpressiveVoicePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ExpressiveVoicePlugin"
    public let jsName = "ExpressiveVoice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speedTest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelSpeedTest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetCrashes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "renameVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playVoiceSample", returnType: CAPPluginReturnPromise),
    ]

    /// A line for hearing a voice that came without a preview.
    static let voiceSampleLine = "The rain had stopped by the time we reached the old bridge, and for a moment the whole city held its breath."

    /// The plugin lives as long as the bridge; the observer holds it weakly.
    private var importObserver: NSObjectProtocol?

    override public func load() {
        // "Open in TachiNovel": the result reaches the UI even if it isn't listening yet (cold start).
        importObserver = NotificationCenter.default.addObserver(forName: VoiceImportInbox.didImport, object: nil, queue: .main) { [weak self] note in
            var data: [String: Any] = [:]
            for (key, value) in note.userInfo ?? [:] {
                if let key = key as? String { data[key] = value }
            }
            self?.notifyListeners("voiceImport", data: data, retainUntilConsumed: true)
        }
    }

    private static func status() -> [String: Any] {
        var d = ExpressiveService.shared.snapshot()
        d["session"] = ExpressiveLabPlayer.shared.snapshot()
        return d
    }

    private func engine(_ call: CAPPluginCall) -> ExpressiveEngineID? {
        guard let raw = call.getString("engine"), let id = ExpressiveEngineID(rawValue: raw), id.pinned?.inApp == true else {
            call.reject("Unknown engine", "INVALID_ARGS")
            return nil
        }
        return id
    }

    private func parseLines(_ call: CAPPluginCall) -> [ExpressiveLine] {
        (call.getArray("lines") ?? []).compactMap { v in
            guard let o = v as? JSObject, let text = o["text"] as? String,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return ExpressiveLine(text: String(text.prefix(2_000)), emotion: o["emotion"] as? String ?? "neutral",
                                  style: o["style"] as? String, role: o["role"] as? String ?? "narrator")
        }.prefix(200).map { $0 }
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(Self.status()) }
    }

    @objc func download(_ call: CAPPluginCall) {
        guard let id = engine(call) else { return }
        DispatchQueue.main.async {
            ExpressiveService.shared.download(id)
            call.resolve(Self.status())
        }
    }

    @objc func cancelDownload(_ call: CAPPluginCall) {
        guard let id = engine(call) else { return }
        DispatchQueue.main.async {
            ExpressiveService.shared.cancelDownload(id)
            call.resolve(Self.status())
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let id = engine(call) else { return }
        DispatchQueue.main.async {
            if ExpressiveLabPlayer.shared.engine.primary == id { ExpressiveLabPlayer.shared.stop() }
            do {
                try ExpressiveService.shared.remove(id)
                call.resolve(Self.status())
            } catch {
                call.reject(error.localizedDescription, "IO_ERROR")
            }
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        let raw = call.getString("engine") ?? "kokoro"
        let primary = ExpressiveEngineID(rawValue: raw)
        guard raw == "kokoro" || primary?.pinned?.inApp == true else { return call.reject("Unknown engine", "INVALID_ARGS") }
        let lines = parseLines(call)
        guard !lines.isEmpty else { return call.reject("No text", "INVALID_ARGS") }
        let sample = call.getString("sample") ?? "custom"
        DispatchQueue.main.async {
            ExpressiveService.shared.cancelSpeedTest(reason: "stopped: playback started")
            VoicePreviewPlayer.shared.stop()
            ExpressiveService.shared.sampleVoice = nil // samples use the narrator voice
            ExpressiveLabPlayer.shared.play(primary: primary, sample: sample, lines: lines)
            call.resolve(Self.status())
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            ExpressiveLabPlayer.shared.stop()
            VoicePreviewPlayer.shared.stop()
            call.resolve(Self.status())
        }
    }

    @objc func speedTest(_ call: CAPPluginCall) {
        guard let id = engine(call) else { return }
        let lines = parseLines(call)
        guard !lines.isEmpty else { return call.reject("No text", "INVALID_ARGS") }
        let sample = call.getString("sample") ?? "custom"
        DispatchQueue.main.async {
            ExpressiveLabPlayer.shared.stop()
            VoicePreviewPlayer.shared.stop()
            ExpressiveService.shared.sampleVoice = nil
            ExpressiveService.shared.startSpeedTest(engine: id, sample: sample, lines: lines)
            call.resolve(Self.status())
        }
    }

    // MARK: - Imported voices

    /// A voice id from JS: an imported voice that exists, or nil (built-in) when `id` is null or absent.
    private func voiceID(_ call: CAPPluginCall, allowBuiltIn: Bool) -> String?? {
        guard let raw = call.getString("id") else {
            if allowBuiltIn { return .some(nil) }
            call.reject("No voice", "INVALID_ARGS")
            return nil
        }
        guard ImportedVoiceStore.isValidID(raw), ExpressiveService.shared.voiceList.contains(where: { $0.id == raw }) else {
            call.reject("That voice isn’t on this iPhone any more.", "NOT_FOUND")
            return nil
        }
        return .some(raw)
    }

    @objc func importVoice(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard ExpressiveService.voiceImportEnabled else { return call.reject("Importing voices isn’t part of this build.", "UNAVAILABLE") }
            let inbox = VoiceImportInbox.directory()
            NativeUI.shared.pickFile(types: [VoicePackFormat.typeIdentifier, VoicePackFormat.fileExtension], destDir: inbox.path) { path in
                guard let path else { return call.resolve(["cancelled": true, "status": Self.status()]) }
                let url = URL(fileURLWithPath: path)
                ExpressiveService.shared.importVoice(from: url, sourceName: url.lastPathComponent) { result in
                    try? FileManager.default.removeItem(at: url)
                    switch result {
                    case .success(let r):
                        call.resolve(["voice": ExpressiveService.voiceJSON(r.voice), "replaced": r.replaced, "status": Self.status()])
                    case .failure(let error):
                        call.reject(error.localizedDescription, "INVALID_VOICE")
                    }
                }
            }
        }
    }

    @objc func selectVoice(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = self.voiceID(call, allowBuiltIn: true) else { return }
            do {
                if ExpressiveLabPlayer.shared.engine.primary == .chatterboxNano { ExpressiveLabPlayer.shared.stop() }
                try ExpressiveService.shared.selectVoice(id)
                call.resolve(Self.status())
            } catch {
                call.reject(error.localizedDescription, "IO_ERROR")
            }
        }
    }

    @objc func renameVoice(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = self.voiceID(call, allowBuiltIn: false), let voice = id else { return }
            let name = call.getString("name") ?? ""
            guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return call.reject("Type a name.", "INVALID_ARGS") }
            do {
                try ExpressiveService.shared.renameVoice(voice, to: String(name.prefix(200)))
                call.resolve(Self.status())
            } catch {
                call.reject(error.localizedDescription, "IO_ERROR")
            }
        }
    }

    @objc func deleteVoice(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = self.voiceID(call, allowBuiltIn: false), let voice = id else { return }
            do {
                if ExpressiveLabPlayer.shared.engine.primary == .chatterboxNano { ExpressiveLabPlayer.shared.stop() }
                VoicePreviewPlayer.shared.stop()
                try ExpressiveService.shared.deleteVoice(voice)
                call.resolve(Self.status())
            } catch {
                call.reject(error.localizedDescription, "IO_ERROR")
            }
        }
    }

    @objc func playVoiceSample(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = self.voiceID(call, allowBuiltIn: true) else { return }
            ExpressiveService.shared.cancelSpeedTest(reason: "stopped: playback started")
            ExpressiveLabPlayer.shared.stop()
            VoicePreviewPlayer.shared.stop()
            // The preview made on the PC plays at once and needs no model.
            if let id, let url = ExpressiveService.shared.previewURL(id) {
                NarrationController.shared.activateForSample()
                do {
                    try VoicePreviewPlayer.shared.play(url)
                    var out = Self.status()
                    out["played"] = "preview"
                    return call.resolve(out)
                } catch {
                    return call.reject("Couldn’t play the preview: \(error.localizedDescription)", "PLAYBACK")
                }
            }
            // Otherwise Chatterbox Nano reads a line in that voice (Kokoro fills in while it loads, as in every lab sample).
            guard ExpressiveService.shared.isInstalled(.chatterboxNano) else {
                return call.reject("Download Chatterbox Nano below to hear this voice (it came without a preview).", "NO_MODEL")
            }
            ExpressiveService.shared.sampleVoice = id ?? ExpressiveService.builtInVoice
            ExpressiveLabPlayer.shared.play(primary: .chatterboxNano, sample: "voice", lines: [ExpressiveLine(text: Self.voiceSampleLine)])
            var out = Self.status()
            out["played"] = "chatterbox-nano"
            call.resolve(out)
        }
    }

    @objc func cancelSpeedTest(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            ExpressiveService.shared.cancelSpeedTest()
            call.resolve(Self.status())
        }
    }

    @objc func unload(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            ExpressiveLabPlayer.shared.stop()
            ExpressiveService.shared.unload(reason: "Voice Lab")
            call.resolve(Self.status())
        }
    }

    @objc func resetCrashes(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            ExpressiveService.shared.resetCrashes()
            call.resolve(Self.status())
        }
    }
}
