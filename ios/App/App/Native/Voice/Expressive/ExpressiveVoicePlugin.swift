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
    ]

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
            ExpressiveLabPlayer.shared.play(primary: primary, sample: sample, lines: lines)
            call.resolve(Self.status())
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            ExpressiveLabPlayer.shared.stop()
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
            ExpressiveService.shared.startSpeedTest(engine: id, sample: sample, lines: lines)
            call.resolve(Self.status())
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
