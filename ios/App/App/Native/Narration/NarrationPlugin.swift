//
//  NarrationPlugin.swift — Capacitor plugin "Narration" (JS API: src/ui/native/narration.ts).
//

import AVFoundation
import Capacitor
import Foundation

@objc(NarrationPlugin)
public class NarrationPlugin: CAPPlugin, CAPBridgedPlugin {
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
    ]

    private var n: NarrationController { NarrationController.shared }

    override public func load() {
        DispatchQueue.main.async {
            self.n.onState = { [weak self] s in self?.notifyListeners("state", data: s) }
            self.n.onProgress = { [weak self] p in self?.notifyListeners("progress", data: p) }
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
        let raw = call.getArray("paragraphs")
        let preferAudio = call.getString("engine") != "speech"
        // PC-narrated audio for this chapter wins over the system voice (unless the caller asks for speech).
        let audioChapter = preferAudio ? AudioLibrary.shared.chapter(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath) : nil
        DispatchQueue.main.async {
            self.n.autoContinue = autoContinue
            if let audioChapter {
                self.n.playAudio(audioChapter, startParagraph: startParagraph, startTime: nil, coverUrl: coverUrl)
            } else if let raw {
                let paragraphs: [NarrationController.Paragraph] = raw.compactMap { v in
                    guard let o = v as? JSObject else { return nil }
                    let text = (o["text"] as? String) ?? ""
                    return NarrationController.Paragraph(index: (o["index"] as? NSNumber)?.intValue ?? 0, text: text, sentences: nil,
                                                         scene: NarrationText.isSceneBreak(text))
                }
                let ch = NarrationController.Chapter(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath,
                                                     novelName: novelName, chapterName: chapterName, coverUrl: coverUrl,
                                                     paragraphs: paragraphs, nextPath: nil, nextName: nil)
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

    /// Audio mode: jump to a chapter time (seconds).
    @objc func seek(_ call: CAPPluginCall) {
        let seconds = call.getDouble("seconds") ?? 0
        onMain(call) { $0.seekAudio(toChapterTime: seconds) }
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

    private func onMain(_ call: CAPPluginCall, _ fn: @escaping (NarrationController) -> Void) {
        DispatchQueue.main.async {
            fn(self.n)
            call.resolve()
        }
    }
}
