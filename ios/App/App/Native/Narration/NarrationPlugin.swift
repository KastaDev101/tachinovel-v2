//
//  NarrationPlugin.swift — Capacitor plugin "Narration" (JS API: src/ui/native/narration.ts).
//

import AVFoundation
@preconcurrency import Capacitor
import Foundation
import HDVoiceCore
import HDVoiceKokoro
import MediaPlayer

/// Capacitor calls arrive on its plugin queue; every method hops to the main thread before touching state,
/// and the listeners it registers run on main, so the plugin is effectively main-thread confined.
@objc(NarrationPlugin)
public class NarrationPlugin: CAPPlugin, CAPBridgedPlugin, @unchecked Sendable {
    public let identifier = "NarrationPlugin"
    public let jsName = "Narration"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "skip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setOptions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPersonalVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playNovel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "audioFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickAudioFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlinkAudioFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "audioLibrary", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "audioTiming", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVoiceSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sampleVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSample", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveCustomVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteCustomVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceLab", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVoiceLab", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selfTestReport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voicePlacement", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareDrive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelDrive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "driveStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearDrive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "nowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remoteCommand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selfTestChapters", returnType: CAPPluginReturnPromise),
    ]

    private var n: NarrationController { NarrationController.shared }

    private var driveObservers: [NSObjectProtocol] = []

    override public func load() {
        DispatchQueue.main.async {
            self.n.onState = { [weak self] s in self?.notifyListeners("state", data: s) }
            self.n.onProgress = { [weak self] p in self?.notifyListeners("progress", data: p) }
            // "Prepare for the drive" progress and storage (all novels; the UI filters).
            for name in [DrivePrep.changed, DriveCache.changed] {
                self.driveObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.notifyListeners("drive", data: DrivePrep.shared.status(novelKey: nil))
                })
            }
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        guard let pluginId = call.getString("pluginId"), let novelPath = call.getString("novelPath"),
              let chapterPath = call.getString("chapterPath") else {
            return call.reject("pluginId, novelPath and chapterPath are required", "INVALID_ARGS")
        }
        let novelName = call.getString("novelName") ?? ""
        let chapterName = call.getString("chapterName") ?? chapterPath
        let start = call.getObject("start") ?? [:]
        let startParagraph = (start["paragraph"] as? NSNumber)?.intValue ?? 0
        let startSentence = (start["sentence"] as? NSNumber)?.intValue ?? 0
        let autoContinue = call.getBool("autoContinue", true)
        let coverUrl = call.getString("coverUrl")
        // Voice Lab A/B: "on" / "off" overrides narrator mode for this play (the saved pieces either way).
        let narratorOverride: Bool? = call.getString("narrator").flatMap { $0 == "on" ? true : $0 == "off" ? false : nil }
        let raw = call.getArray("paragraphs")
        let script = NarrationController.ScriptItem.parse(call.getObject("script"))
        // PC-narrated audio for this chapter (only with Settings › Voices › Advanced › "Use PC audio when
        // available", off by default) wins over speech, unless the caller asks for speech.
        let preferAudio = call.getString("engine") != "speech" && VoiceSettings.shared.prefs.usePCAudio
        let audioChapter = preferAudio ? AudioLibrary.shared.chapter(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath) : nil
        DispatchQueue.main.async {
            self.n.autoContinue = autoContinue
            self.n.narratorOverride = narratorOverride
            if let audioChapter {
                self.n.playAudio(audioChapter, startParagraph: startParagraph, startTime: nil, coverUrl: coverUrl)
            } else if raw != nil || script != nil {
                let paragraphs: [NarrationController.Paragraph] = (raw ?? []).compactMap { v in
                    guard let o = v as? JSObject else { return nil }
                    let text = (o["text"] as? String) ?? ""
                    return NarrationController.Paragraph(index: (o["index"] as? NSNumber)?.intValue ?? 0, text: text, sentences: nil,
                                                         scene: NarrationText.isSceneBreak(text))
                }
                let ch = NarrationController.Chapter(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath,
                                                     novelName: novelName, chapterName: chapterName, coverUrl: coverUrl,
                                                     paragraphs: paragraphs, nextPath: nil, nextName: nil, script: script)
                self.n.play(ch, startParagraph: startParagraph, startSentence: startSentence)
            } else {
                self.n.playFromCore(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath, novelName: novelName, startParagraph: startParagraph)
            }
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) { onMain(call) { $0.pause() } }
    @objc func resume(_ call: CAPPluginCall) { onMain(call) { $0.resume() } }
    @objc func stop(_ call: CAPPluginCall) { onMain(call) { $0.stop() } }

    @objc func skip(_ call: CAPPluginCall) {
        let unit = call.getString("unit") ?? "sentence"
        let count = call.getInt("count") ?? 1
        onMain(call) { $0.skip(unit: unit, count: count) }
    }

    @objc func setOptions(_ call: CAPPluginCall) {
        let rate = call.getFloat("rate")
        let pitch = call.getFloat("pitch")
        let voiceId = call.getString("voiceId")
        let paragraphPause = call.getDouble("paragraphPause")
        let scenePause = call.getDouble("scenePause")
        let sleep = call.getDouble("sleepMinutes")
        let lexicon: [NarrationText.LexiconEntry]? = call.getArray("lexicon")?.compactMap { v in
            guard let o = v as? JSObject, let g = o["grapheme"] as? String, !g.isEmpty else { return nil }
            return NarrationText.LexiconEntry(grapheme: g, ipa: o["ipa"] as? String, say: o["say"] as? String)
        }
        onMain(call) { n in
            if let voiceId { n.voiceIdentifier = voiceId }
            if let pitch { n.pitch = pitch }
            if let paragraphPause { n.paragraphPause = paragraphPause }
            if let scenePause { n.scenePause = scenePause }
            if let lexicon { n.lexicon = lexicon }
            if let sleep { n.setSleepTimer(minutes: sleep) }
            if let rate { n.applyRate(rate) }
        }
    }

    @objc func voices(_ call: CAPPluginCall) {
        let list: [[String: Any]] = AVSpeechSynthesisVoice.speechVoices().map { v in
            var quality = "default"
            if v.quality == .enhanced { quality = "enhanced" }
            if v.quality == .premium { quality = "premium" } // iOS 16+
            let personal = v.voiceTraits.contains(.isPersonalVoice) // iOS 17+ (deployment target)
            return ["id": v.identifier, "name": v.name, "language": v.language, "quality": quality, "personal": personal, "engine": "system"]
        }
        call.resolve(["voices": list])
    }

    @objc func requestPersonalVoice(_ call: CAPPluginCall) {
        // iOS 17+ API; the deployment target is 17, so no availability check is needed.
        AVSpeechSynthesizer.requestPersonalVoiceAuthorization { status in
            let s: String
            switch status {
            case .authorized: s = "authorized"
            case .denied: s = "denied"
            case .unsupported: s = "unsupported"
            default: s = "notDetermined"
            }
            call.resolve(["status": s])
        }
    }

    @objc func state(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(self.n.stateDict()) }
    }

    /// Jump to a chapter time (seconds at 1×): exact for audio, to the sentence for speech.
    @objc func seek(_ call: CAPPluginCall) {
        let seconds = call.getDouble("seconds") ?? 0
        onMain(call) { $0.perform(.seekTo(seconds)) }
    }

    /// Continue a novel where reading/listening stopped: narrated audio first, else the system voice.
    @objc func playNovel(_ call: CAPPluginCall) {
        guard let pluginId = call.getString("pluginId"), let novelPath = call.getString("novelPath") else {
            return call.reject("pluginId and novelPath are required", "INVALID_ARGS")
        }
        let name = call.getString("novelName") ?? ""
        let cover = call.getString("coverUrl")
        onMain(call) { $0.playNovel(pluginId: pluginId, novelPath: novelPath, novelName: name, coverUrl: cover) }
    }

    // MARK: PC-narrated audio folder

    @objc func audioFolder(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            let name = AudioLibrary.shared.folderName
            call.resolve(["linked": name != nil, "name": name ?? NSNull()])
        }
    }

    @objc func pickAudioFolder(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            AudioLibrary.shared.pickFolder { result in
                switch result {
                case .success(let name): call.resolve(["linked": true, "name": name])
                case .failure(let error):
                    if case AudioLibrary.AudioError.cancelled = error { call.resolve(["linked": AudioLibrary.shared.folderName != nil, "cancelled": true]) } else {
                        call.reject(error.localizedDescription, "AUDIO_FOLDER")
                    }
                }
            }
        }
    }

    @objc func unlinkAudioFolder(_ call: CAPPluginCall) {
        AudioLibrary.shared.unlink()
        call.resolve(["linked": false])
    }

    /// Novels with narrated chapters in the linked folder.
    @objc func audioLibrary(_ call: CAPPluginCall) {
        let refresh = call.getBool("refresh", false)
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let novels = try AudioLibrary.shared.scan(refresh: refresh)
                let out: [[String: Any]] = novels.map { nv in
                    [
                        "key": nv.key, "pluginId": nv.pluginId, "novelPath": nv.novelPath, "name": nv.name,
                        "chapters": nv.chapters.map { c in
                            ["chapterPath": c.chapterPath, "title": c.title, "number": c.number.isFinite && c.number < 1e12 ? c.number : NSNull(),
                             "hasTiming": c.timingURL != nil] as [String: Any]
                        },
                        "saved": NarrationController.savedPosition(novelKey: nv.key).map { ["chapterPath": $0.chapterPath, "seconds": $0.seconds] as [String: Any] } ?? NSNull(),
                    ]
                }
                call.resolve(["linked": true, "novels": out])
            } catch AudioLibrary.AudioError.notLinked {
                call.resolve(["linked": false, "novels": [] as [Any]])
            } catch {
                call.reject(error.localizedDescription, "AUDIO_FOLDER")
            }
        }
    }

    /// The sentence-timestamp manifest (JSON text) of a narrated chapter, for highlighting in the reader.
    @objc func audioTiming(_ call: CAPPluginCall) {
        guard let pluginId = call.getString("pluginId"), let novelPath = call.getString("novelPath"),
              let chapterPath = call.getString("chapterPath") else {
            return call.reject("pluginId, novelPath and chapterPath are required", "INVALID_ARGS")
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let ac = AudioLibrary.shared.chapter(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath)
            let json = ac.flatMap { AudioLibrary.shared.timingJSON($0) }
            call.resolve(["hasAudio": ac != nil, "json": json ?? NSNull()])
        }
    }

    // MARK: Voices (Kokoro on device + Apple fallback)

    /// Voice settings for Settings › Voices and the Listen player. Optional pluginId/novelPath add that
    /// novel's own choice.
    @objc func voiceSettings(_ call: CAPPluginCall) {
        let pluginId = call.getString("pluginId")
        let novelPath = call.getString("novelPath")
        DispatchQueue.main.async {
            let prefs = VoiceSettings.shared.prefs
            let k = KokoroService.shared
            var out: [String: Any] = [
                "voices": VoiceCatalog.voices.map { v in
                    ["id": v.id, "name": v.name, "language": v.language, "gender": v.gender.rawValue, "blurb": v.blurb,
                     "grade": v.grade, "gradeRank": v.gradeRank] as [String: Any]
                },
                "customVoices": prefs.customVoices.map { m in
                    ["id": m.id, "name": m.name, "a": m.a, "b": m.b, "percent": m.percent] as [String: Any]
                },
                "defaultVoice": prefs.choice(forNovel: nil),
                "kokoroEnabled": prefs.kokoroEnabled,
                "usePCAudio": prefs.usePCAudio,
                "carButtons": prefs.carButtonsChoice.rawValue,
                "speed": prefs.speed,
                "volume": prefs.volume,
                "speedPresets": SpeechSpeed.presets,
                "narrator": [
                    "enabled": prefs.narrator.enabled,
                    "dialogueVoice": prefs.narrator.dialogueVoice.flatMap { prefs.isChoice($0) ? $0 : nil } ?? NSNull(),
                    "secondDialogueVoice": prefs.narrator.secondDialogueVoice.flatMap { prefs.isChoice($0) ? $0 : nil } ?? NSNull(),
                    "pacing": prefs.narrator.pacing,
                    "jitter": prefs.narrator.jitter,
                    "polish": prefs.narrator.polish,
                    "roomTone": prefs.narrator.roomTone,
                    "phraseBreaks": prefs.narrator.phraseBreaks,
                    "pacingStyle": prefs.narrator.pacingStyle,
                ] as [String: Any],
                "delivery": [
                    "listenEngine": prefs.delivery.listenEngine ?? NSNull(),
                    "natural": prefs.delivery.natural,
                    "performed": prefs.delivery.performed,
                    "moods": prefs.delivery.moods,
                    "breaths": prefs.delivery.breaths,
                    "studioSound": prefs.delivery.studioSound,
                    "systemChime": prefs.delivery.systemChime,
                    "systemTone": prefs.delivery.systemTone,
                ] as [String: Any],
                "kokoro": [
                    "bundled": k.isBundled,
                    "status": k.statusText,
                    "ready": k.status == .ready,
                    "crashDisabled": k.crashDisabled,
                    "crashes": k.sentinel.current.total,
                    "revision": k.modelInfo["revision"] ?? NSNull(),
                    "bytes": k.modelInfo["bytes"] ?? NSNull(),
                ] as [String: Any],
                "apple": VoiceSettings.appleSummary(kokoroVoice: prefs.voice(forNovel: nil)),
            ]
            if let pluginId, let novelPath {
                let key = VoiceSettings.novelKey(pluginId: pluginId, novelPath: novelPath)
                out["novelVoice"] = prefs.novelVoices[key] ?? NSNull()
                out["effectiveVoice"] = prefs.choice(forNovel: key)
            }
            call.resolve(out)
        }
    }

    @objc func setVoiceSettings(_ call: CAPPluginCall) {
        let defaultVoice = call.getString("defaultVoice")
        let usePCAudio = call.getBool("usePCAudio")
        let kokoroEnabled = call.getBool("kokoroEnabled")
        let carButtons = call.getString("carButtons").flatMap { CarButtons(rawValue: $0) }
        let speed = call.getDouble("speed")
        let volume = call.getDouble("volume")
        DispatchQueue.main.async {
            let novel = call.getObject("novel")
            let narrator = call.getObject("narrator")
            let delivery = call.getObject("delivery")
            let before = VoiceSettings.shared.prefs
            VoiceSettings.shared.update { p in
                if let carButtons { p.carButtons = carButtons.rawValue }
                if let speed { p.speed = SpeechSpeed.clamp(speed) }
                if let volume { p.volume = VoiceVolume.clamp(volume) }
                if let defaultVoice, p.isChoice(defaultVoice) { p.defaultVoice = defaultVoice }
                if let novel, let pid = novel["pluginId"] as? String, let path = novel["novelPath"] as? String {
                    p.setVoice(novel["voice"] as? String, forNovel: VoiceSettings.novelKey(pluginId: pid, novelPath: path))
                }
                if let usePCAudio { p.usePCAudio = usePCAudio }
                if let kokoroEnabled { p.kokoroEnabled = kokoroEnabled }
                if let narrator {
                    // Narrator mode: only the keys sent change; a voice of null (or unknown) means none.
                    var n = p.narrator
                    if let v = narrator["enabled"] as? Bool { n.enabled = v }
                    if narrator.keys.contains("dialogueVoice") { n.dialogueVoice = (narrator["dialogueVoice"] as? String).flatMap { p.isChoice($0) ? $0 : nil } }
                    if narrator.keys.contains("secondDialogueVoice") {
                        n.secondDialogueVoice = (narrator["secondDialogueVoice"] as? String).flatMap { p.isChoice($0) ? $0 : nil }
                    }
                    if let v = narrator["pacing"] as? Bool { n.pacing = v }
                    if let v = narrator["jitter"] as? Bool { n.jitter = v }
                    if let v = narrator["polish"] as? Bool { n.polish = v }
                    if let v = narrator["roomTone"] as? Bool { n.roomTone = v }
                    if let v = narrator["phraseBreaks"] as? String { n.phraseBreaks = v == "off" ? "off" : "clauses" }
                    if let v = narrator["pacingStyle"] as? String { n.pacingStyle = v == "natural" ? "natural" : "relaxed" }
                    p.narrator = n
                }
                if let delivery {
                    // The narrator voice: only the keys sent change; listenEngine null = Kokoro.
                    var d = p.delivery
                    if delivery.keys.contains("listenEngine") {
                        d.listenEngine = (delivery["listenEngine"] as? String).flatMap { DeliverySettings.listenEngines.contains($0) ? $0 : nil }
                    }
                    if let v = delivery["natural"] as? Bool { d.natural = v }
                    if let v = delivery["performed"] as? Bool { d.performed = v }
                    if let v = delivery["moods"] as? Bool { d.moods = v }
                    if let v = delivery["breaths"] as? Bool { d.breaths = v }
                    if let v = delivery["studioSound"] as? Bool { d.studioSound = v }
                    if let v = delivery["systemChime"] as? Bool { d.systemChime = v }
                    if let v = delivery["systemTone"] as? Bool { d.systemTone = v }
                    p.delivery = d
                }
            }
            if kokoroEnabled == true, KokoroService.shared.crashDisabled { KokoroService.shared.resetCrashes() }
            if VoiceSettings.shared.prefs.kokoroEnabled != before.kokoroEnabled { KokoroService.shared.settingsChanged() }
            call.resolve()
        }
    }

    private let appleSampler = AVSpeechSynthesizer()

    /// ▶ sample: a Kokoro voice id, a mix id, a blend ("af_heart+bf_emma@35", the mixer's audition), or
    /// "apple" for the fallback voice. Resolves once audio starts.
    @objc func sampleVoice(_ call: CAPPluginCall) {
        let voice = call.getString("voice") ?? VoiceCatalog.defaultVoiceId
        let text = call.getString("text") ?? "The rain had stopped by the time we reached the old bridge, and for a moment the whole city held its breath."
        let runs: [SpeechRun]? = call.getArray("runs")?.compactMap { v in
            guard let o = v as? JSObject else { return nil }
            if let p = o["p"] as? String { return SpeechRun.phonemes(p) }
            if let t = o["t"] as? String { return SpeechRun.text(t) }
            return nil
        }
        DispatchQueue.main.async {
            KokoroService.shared.stopSample()
            if self.appleSampler.isSpeaking { self.appleSampler.stopSpeaking(at: .immediate) }
            if voice == "apple" {
                NarrationController.shared.activateForSample()
                let u = AVSpeechUtterance(string: text)
                u.voice = VoiceSettings.appleVoice(explicit: nil, kokoroVoice: VoiceSettings.shared.prefs.voice(forNovel: nil))
                u.rate = VoiceSettings.avRate(1)
                self.appleSampler.usesApplicationAudioSession = true
                self.appleSampler.speak(u)
                return call.resolve(["ms": 0, "source": "apple"])
            }
            guard let engineVoice = VoiceSettings.shared.prefs.engineVoice(voice) else { return call.reject("Unknown voice \(voice)", "INVALID_ARGS") }
            KokoroService.shared.playSample(voice: engineVoice, text: text, runs: runs?.isEmpty == false ? runs : nil) { result in
                switch result {
                case .success(let ms): call.resolve(["ms": ms, "source": "kokoro"])
                case .failure(let e): call.reject(e.localizedDescription, "VOICE_UNAVAILABLE")
                }
            }
        }
    }

    /// Voice mixer: save a new mix ({name, a, b, percent}) or change one ({id, …}). Resolves {mix}.
    @objc func saveCustomVoice(_ call: CAPPluginCall) {
        let id = call.getString("id")
        let name = call.getString("name") ?? ""
        guard let a = call.getString("a"), let b = call.getString("b") else { return call.reject("a and b are required", "INVALID_ARGS") }
        let percent = VoiceBlend.percent(call.getDouble("percent") ?? 50)
        DispatchQueue.main.async {
            var saved: CustomVoice?
            var failure: Error?
            VoiceSettings.shared.update { p in
                do { saved = try p.saveCustomVoice(id: id, name: name, a: a, b: b, percent: percent) } catch { failure = error }
            }
            guard let mix = saved else { return call.reject(failure?.localizedDescription ?? "Couldn't save the mix", "INVALID_ARGS") }
            call.resolve(["mix": ["id": mix.id, "name": mix.name, "a": mix.a, "b": mix.b, "percent": mix.percent] as [String: Any]])
        }
    }

    /// Voice mixer: delete a mix ({id}); the default and novels using it go back to Heart / the default.
    @objc func deleteCustomVoice(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("id is required", "INVALID_ARGS") }
        DispatchQueue.main.async {
            var failure: Error?
            VoiceSettings.shared.update { p in
                do { try p.deleteCustomVoice(id: id) } catch { failure = error }
            }
            if let failure { return call.reject(failure.localizedDescription, "INVALID_ARGS") }
            call.resolve()
        }
    }

    @objc func stopSample(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            KokoroService.shared.stopSample()
            if self.appleSampler.isSpeaking { self.appleSampler.stopSpeaking(at: .immediate) }
            call.resolve()
        }
    }

    @objc func voiceLab(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(VoiceLab.snapshot()) }
    }

    /// Voice Lab controls: compute route, render-ahead, reset counters; test injection (debug/self-test).
    @objc func setVoiceLab(_ call: CAPPluginCall) {
        let route = call.getString("route")
        let ahead = call.getInt("ahead")
        let reset = call.getBool("resetStats") ?? false
        DispatchQueue.main.async {
            let inject = call.getObject("inject")
            let before = VoiceSettings.shared.prefs
            VoiceSettings.shared.update { p in
                if let route, KokoroRoute(rawValue: route) != nil { p.route = route }
                if let ahead { p.ahead = min(3, max(2, ahead)) }
            }
            if VoiceSettings.shared.prefs.route != before.route { KokoroService.shared.settingsChanged() }
            if reset { KokoroService.shared.stats.reset() }
            #if DEBUG
            if let inject, let runtime = KokoroService.shared.runtime {
                let delay = ((inject["delayMs"] as? NSNumber)?.doubleValue ?? 0) / 1000
                let fail = (inject["fail"] as? Bool) ?? false
                Task.detached { await runtime.setInjection(delay: delay, fail: fail) }
            }
            #else
            _ = inject
            #endif
            call.resolve(VoiceLab.snapshot())
        }
    }

    /// Voice Lab: where Core ML runs each Kokoro stage on this device (MLComputePlan, no synthesis).
    @objc func voicePlacement(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            KokoroService.shared.analyzePlacement { result in
                call.resolve(["stages": result.map { p in
                    ["stage": p.stage, "configured": p.configured, "ane": p.neuralEngine, "cpu": p.cpu, "gpu": p.gpu,
                     "error": p.error ?? NSNull(), "summary": p.summary] as [String: Any]
                }])
            }
        }
    }

    // MARK: In the car

    /// "Prepare for the drive": render the next `chapters` chapters with Kokoro into local audio.
    @objc func prepareDrive(_ call: CAPPluginCall) {
        guard let pluginId = call.getString("pluginId"), let novelPath = call.getString("novelPath") else {
            return call.reject("pluginId and novelPath are required", "INVALID_ARGS")
        }
        let name = call.getString("novelName") ?? ""
        let cover = call.getString("coverUrl")
        let count = call.getInt("chapters") ?? 3
        let when = DrivePrepWhen(rawValue: call.getString("when") ?? "") ?? .chargingOrWifi
        let start = call.getString("startChapterPath")
        DispatchQueue.main.async {
            DrivePrep.shared.request(pluginId: pluginId, novelPath: novelPath, novelName: name, coverUrl: cover, count: count, when: when, startChapterPath: start)
            call.resolve(DrivePrep.shared.status(novelKey: VoiceSettings.novelKey(pluginId: pluginId, novelPath: novelPath)))
        }
    }

    @objc func cancelDrive(_ call: CAPPluginCall) {
        guard let pluginId = call.getString("pluginId"), let novelPath = call.getString("novelPath") else {
            return call.reject("pluginId and novelPath are required", "INVALID_ARGS")
        }
        DispatchQueue.main.async {
            DrivePrep.shared.cancel(novelKey: VoiceSettings.novelKey(pluginId: pluginId, novelPath: novelPath))
            call.resolve()
        }
    }

    /// Requests, progress and prepared chapters: one novel (pluginId + novelPath) or all.
    @objc func driveStatus(_ call: CAPPluginCall) {
        let key = call.getString("pluginId").flatMap { p in call.getString("novelPath").map { VoiceSettings.novelKey(pluginId: p, novelPath: $0) } }
        DispatchQueue.main.async { call.resolve(DrivePrep.shared.status(novelKey: key)) }
    }

    /// Delete prepared audio (one novel, or all) and stop its request.
    @objc func clearDrive(_ call: CAPPluginCall) {
        let key = call.getString("pluginId").flatMap { p in call.getString("novelPath").map { VoiceSettings.novelKey(pluginId: p, novelPath: $0) } }
        DispatchQueue.main.async {
            if let key { DrivePrep.shared.cancel(novelKey: key) } else { DrivePrep.shared.jobs.forEach { DrivePrep.shared.cancel(novelKey: $0.novelKey) } }
            DriveCache.shared.remove(novelKey: key)
            call.resolve(DrivePrep.shared.status(novelKey: key))
        }
    }

    /// What the lock screen and the car show now, and which remote commands are offered.
    @objc func nowPlaying(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["info": NowPlayingCenter.shared.snapshot(), "commands": RemoteCommandHub.shared.snapshot(),
                          "state": self.n.stateDict(), "carPlayTemplates": CarPlayFeature.templatesEnabled,
                          "chapterGapsMs": self.n.chapterGapsMs])
        }
    }

    /// Simulator self-test: send a remote command through the same handler MPRemoteCommandCenter calls.
    @objc func remoteCommand(_ call: CAPPluginCall) {
        guard NarrationSelfTest.isActive else { return call.reject("self-test only", "UNAVAILABLE") }
        guard let command = RemoteCommand.named(call.getString("command") ?? "", value: call.getDouble("value")) else {
            return call.reject("unknown command", "INVALID_ARGS")
        }
        DispatchQueue.main.async {
            let status = RemoteCommandHub.shared.handle(command)
            call.resolve(["handled": status == .success])
        }
    }

    /// Simulator self-test: a synthetic multi-chapter novel ({chapterPath, title, paragraphs, script, next?, prev?}).
    @objc func selfTestChapters(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let list = (call.getArray("chapters") ?? []).compactMap { $0 as? [String: Any] }
            guard NarrationSelfTest.isActive else { return call.reject("self-test only", "UNAVAILABLE") }
            NarrationSelfTest.shared.register(chapters: list)
            call.resolve(["chapters": list.count])
        }
    }

    /// Simulator voice self-test: the UI's findings, merged with native counters into a JSON file.
    @objc func selfTestReport(_ call: CAPPluginCall) {
        let json = call.getString("json") ?? "{}"
        DispatchQueue.main.async {
            guard NarrationSelfTest.isActive else { return call.reject("not in self-test mode", "UNAVAILABLE") }
            let url = NarrationSelfTest.shared.writeReport(json)
            call.resolve(["path": url?.path ?? NSNull()])
        }
    }

    private func onMain(_ call: CAPPluginCall, _ fn: @escaping (NarrationController) -> Void) {
        let work = MainBound(fn)
        DispatchQueue.main.async {
            work.value(self.n)
            call.resolve()
        }
    }
}
