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
//  resetCrashes                   "Turn Nephis back on" (and the experimental engines) after the crash protection
//                                 tripped; status().crashes says why in plain words (offLine, lastEnd, appLastEnd)
//
//  Imported voices (personal flavor, docs/voice-import.md; status() carries them as `voices`):
//  importVoice                    Files picker for a .tnvoice → checked and kept → {voice, replaced, status} or
//                                 {cancelled}; an invalid file is rejected with the reason (code INVALID_VOICE)
//  selectVoice                    {id | null}: Chatterbox Nano's narrator voice, kept across launches: an imported
//                                 or shipped voice's id, "builtin" (Chatterbox's own voice), null = the default
//  renameVoice / deleteVoice      {id, name} / {id}: imported voices only (shipped ones can't be changed)
//  playVoiceSample                {id | null}: the voice's preview, else Chatterbox Nano reads a line in that voice
//  event "voiceImport"            {ok, message, id?}: a .tnvoice opened with "Open in TachiNovel" (SceneDelegate)
//
//  Nephis model packs (personal flavor, NephisModelPack.swift; Settings › Voices › Voice packs). Each answers
//  {packs: [{id, name, made, studio, bytes, active}], active, totalBytes}:
//  nephisPacks                    the packs on this iPhone, the most recently added first
//  selectNephisPack               {id}: she reads with it from her next sentence (what installing one does)
//  deleteNephisPack               {id}: deleting hers switches her to the next pack in the list, or to none
//

import Capacitor
import Darwin
import ExpressiveEngines
import ExpressiveCore
import Foundation
import HDVoiceCore

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
        CAPPluginMethod(name: "resetStats", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recordStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recordStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "renameVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playVoiceSample", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "studioTest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "studioEnable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "nephisPacks", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectNephisPack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteNephisPack", returnType: CAPPluginReturnPromise),
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

    // MARK: - Imported and shipped voices

    /// A voice id from JS that exists: "builtin" (Chatterbox's own voice), a shipped voice or an imported one;
    /// `.some(nil)` (the default voice) when `id` is null or absent and `anyVoice`. Only imported voices when
    /// `anyVoice` is false (rename, delete). Rejects the call and returns nil otherwise.
    private func voiceID(_ call: CAPPluginCall, anyVoice: Bool) -> String?? {
        let svc = ExpressiveService.shared
        guard let raw = call.getString("id") else {
            if anyVoice { return .some(nil) }
            call.reject("No voice", "INVALID_ARGS")
            return nil
        }
        if !anyVoice, raw == ExpressiveService.builtInVoice || BundledVoices.isBundledID(raw) {
            call.reject("Voices that come with TachiNovel can’t be renamed or deleted.", "INVALID_ARGS")
            return nil
        }
        guard ImportedVoiceStore.isSelectable(raw), svc.voiceExists(raw) else {
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
            guard let id = self.voiceID(call, anyVoice: true) else { return }
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
            guard let id = self.voiceID(call, anyVoice: false), let voice = id else { return }
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
            guard let id = self.voiceID(call, anyVoice: false), let voice = id else { return }
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
            guard let id = self.voiceID(call, anyVoice: true) else { return }
            ExpressiveService.shared.cancelSpeedTest(reason: "stopped: playback started")
            ExpressiveLabPlayer.shared.stop()
            VoicePreviewPlayer.shared.stop()
            // The preview made on the PC plays at once and needs no model.
            let svc = ExpressiveService.shared
            let target = id ?? svc.defaultVoice
            let preview = svc.previewURL(target).map { VoicePreviewPlayer.Source.file($0) } ?? svc.shippedPreview(target).map { VoicePreviewPlayer.Source.data($0) }
            if let preview {
                NarrationController.shared.activateForSample()
                do {
                    try VoicePreviewPlayer.shared.play(preview)
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
            svc.sampleVoice = target
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

    // MARK: - Her studio (NephisStudio.swift, 2026-10-11 scaffold)

    /// Settings › Voices › Voice test (studio speed test): loads the installed pack's studio (compiling it on first use), renders 10 s of
    /// stand-in input twice (the first warms it up) and reports the second: × real time per step, and the thermal
    /// state before and after. Stand-in input (noise and random sketch) costs the same as speech, so only the speed
    /// is meaningful, not the sound.
    /// It runs alone (crash plan a1: build 321 was closed by iOS for memory here, its studio loaded on top of Nephis):
    /// the lab player and narration stop, Nephis and Kokoro are released and the test waits until their models are gone;
    /// with less than ~1,000 MB free it refuses and says how much is free. Inside her crash sentinel (a kill during it is
    /// noted); `memory`: used and free MB at each step (start, loaded, each render, released). The studio is freed
    /// before the result goes back, and Nephis is warmed again first when she is Listen's voice (the listening test then
    /// starts as Listen does). `placement: true`: only where Core ML runs each model (MLComputePlan), on its own. One at a
    /// time: a second one while one runs is refused (`busy`).
    @objc func studioTest(_ call: CAPPluginCall) {
        guard let dir = NephisModelPack.active?.appendingPathComponent("Models/nephis-studio", isDirectory: true),
              FileManager.default.fileExists(atPath: dir.appendingPathComponent("studio.json").path) else {
            return call.resolve(["ran": false, "error": "The installed Nephis pack has no studio (Models/nephis-studio)."])
        }
        let placementOnly = call.getBool("placement") ?? false
        DispatchQueue.main.async {
            guard !ExpressiveService.shared.studioTestRunning else {
                return call.resolve(["ran": false, "busy": true, "error": "The studio test is already running."])
            }
            ExpressiveLabPlayer.shared.stop()
            VoicePreviewPlayer.shared.stop()
            if NarrationController.shared.status == .playing { NarrationController.shared.pause() }
            let sentinel = ExpressiveService.shared.sentinel
            ExpressiveService.shared.clearForStudioTest {
                Task.detached(priority: .userInitiated) {
                    let out = await Self.runStudioTest(dir: dir, placementOnly: placementOnly, sentinel: sentinel)
                    DispatchQueue.main.async {
                        ExpressiveService.shared.studioTestEnded { call.resolve(out) }
                    }
                }
            }
        }
    }

    /// The studio test itself, once nothing else holds a model (studioTest).
    private static func runStudioTest(dir: URL, placementOnly: Bool, sentinel: CrashSentinel) async -> [String: Any] {
        var memory: [[String: Any]] = []
        func note(_ step: String) {
            let free = ExpressiveService.freeMemoryMB()
            memory.append(["step": step, "usedMB": ExpressiveService.r1(VoiceLab.memoryFootprintMB()),
                           "freeMB": free.map { ExpressiveService.r1($0) } ?? NSNull()])
        }
        note("start")
        if let free = ExpressiveService.freeMemoryMB(), NephisMemory.short(.studioTest, freeMB: free) {
            return ["ran": false, "refused": true, "error": NephisMemory.refusal(.studioTest, freeMB: free), "memory": memory]
        }
        let system = ProcessInfo.processInfo.operatingSystemVersionString
        if placementOnly {
            sentinel.begin("studio placement \(system)")
            let placement = await NephisStudio.placement(in: dir)
            sentinel.end(success: true)
            note("placement")
            return ["placementOnly": true, "placement": placement, "memory": memory]
        }
        let thermalBefore = ProcessInfo.processInfo.thermalState.rawValue
        var out: [String: Any]
        var ok = false
        sentinel.begin("studio test \(system)")
        do {
            let t0 = Date()
            // The test's own studio lives in this block only: freed before the result goes back.
            if let studio = try await NephisStudio.load(from: dir) {
                let loadMs = Date().timeIntervalSince(t0) * 1000
                note("loaded")
                let seconds = 10
                var rng = SystemRandomNumberGenerator()
                let pcm = (0..<(NephisStudio.inputRate * seconds)).map { _ in Float.random(in: -0.05...0.05, using: &rng) }
                let latents = (0..<(seconds * 25 / 2)).map { _ in (0..<32).map { _ in Float.random(in: -1...1, using: &rng) } }
                _ = try await studio.render(pcm24: pcm, latents: latents)
                note("render 1")
                _ = try await studio.render(pcm24: pcm, latents: latents)
                note("render 2")
                let r = await studio.lastReport
                out = ["ran": true, "loadMs": loadMs, "audioSeconds": r.audioMs / 1000, "resampleMs": r.resampleMs,
                       "blueprintMs": r.blueprintMs, "refinerMs": r.refinerMs, "vocoderMs": r.vocoderMs, "restMs": r.restMs, "bypassed": r.bypassed,
                       "timesRealTime": r.timesRealTime]
                ok = true
            } else {
                out = ["ran": false, "error": "studio.json is missing."]
            }
        } catch {
            out = ["ran": false, "error": "\(error)"]
        }
        sentinel.end(success: ok)
        _ = malloc_zone_pressure_relief(nil, 0)
        note("released")
        out["memory"] = memory
        out["thermalBefore"] = thermalBefore
        out["thermalAfter"] = ProcessInfo.processInfo.thermalState.rawValue
        out["enabled"] = UserDefaults.standard.bool(forKey: "nephisStudio")
        return out
    }

    /// Settings › Voices › Voice test › Her studio switch (on/off): her stream becomes 44.1 kHz from her next load. A read
    /// plays at one rate (SessionRate), so a Listen read in progress starts its sentence again at the new one (as a
    /// voice change does; reloadNephisModel asks for it, as it does for a pack swap); otherwise its next calls would come
    /// at the other rate and go to Kokoro.
    @objc func studioEnable(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            UserDefaults.standard.set(on, forKey: "nephisStudio")
            ExpressiveService.shared.reloadNephisModel()
            call.resolve(["enabled": on])
        }
    }

    // MARK: - Her model packs

    private static func packs() -> [String: Any] {
        let library = NephisModelPack.library
        let active = library.activeID
        let packs = library.list()
        return [
            "packs": packs.map { p -> [String: Any] in
                ["id": p.id, "name": p.name, "made": p.made.map { $0 as Any } ?? NSNull(), "studio": p.studio,
                 "bytes": Int(p.bytes), "active": p.id == active]
            },
            "active": active.map { $0 as Any } ?? NSNull(),
            "totalBytes": Int(packs.reduce(Int64(0)) { $0 + $1.bytes }),
        ]
    }

    @objc func nephisPacks(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(Self.packs()) }
    }

    @objc func selectNephisPack(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("No pack", "INVALID_ARGS") }
        DispatchQueue.main.async {
            do {
                try NephisModelPack.select(id)
                call.resolve(Self.packs())
            } catch {
                call.reject(error.localizedDescription, "IO_ERROR")
            }
        }
    }

    @objc func deleteNephisPack(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("No pack", "INVALID_ARGS") }
        DispatchQueue.main.async {
            do {
                try NephisModelPack.delete(id)
                call.resolve(Self.packs())
            } catch {
                call.reject(error.localizedDescription, "IO_ERROR")
            }
        }
    }

    /// Settings › Voices › Voice test: start counting Nephis's calls afresh (the report then covers the test only).
    @objc func resetStats(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            ExpressiveService.shared.resetFlowStats()
            call.resolve(Self.status())
        }
    }

    /// Voice test recording: Documents/voice-test.wav (also visible in Files › On My iPhone › TachiNovel).
    static var recordingURL: URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.appendingPathComponent("voice-test.wav")
    }

    /// The running recording is 32-bit float (main thread, like the recording itself).
    private var recordingFloat32 = false

    /// {float32?}: 16-bit WAV, or 32-bit float (the exact samples that played, for measuring on the PC).
    @objc func recordStart(_ call: CAPPluginCall) {
        let float32 = call.getBool("float32") ?? false
        DispatchQueue.main.async {
            guard let url = Self.recordingURL else { return call.resolve(["recording": false]) }
            self.recordingFloat32 = float32
            NarrationController.shared.speechEngine.startRecording(to: url, float32: float32)
            call.resolve(["recording": true, "float32": float32])
        }
    }

    /// {saved, bytes, sampleRate, float32}: the WAV is at the rate of the read it holds (a read at another rate starts it
    /// again: HybridSpeechEngine.useRate).
    @objc func recordStop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let engine = NarrationController.shared.speechEngine
            let url = engine.stopRecording()
            let bytes = url.flatMap { (try? FileManager.default.attributesOfItem(atPath: $0.path))?[.size] as? NSNumber }?.intValue ?? 0
            call.resolve(["saved": url != nil && bytes > 44, "bytes": bytes, "sampleRate": engine.sessionRate, "float32": self.recordingFloat32])
        }
    }

    /// The share sheet with the last recording (Save to Files › iCloud Drive reaches the PC).
    @objc func shareRecording(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = Self.recordingURL, FileManager.default.fileExists(atPath: url.path) else {
                return call.reject("No recording yet: run the test first.")
            }
            NativeUI.shared.share([url]) { call.resolve() }
        }
    }

    @objc func resetCrashes(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            ExpressiveService.shared.resetCrashes()
            call.resolve(Self.status())
        }
    }
}
