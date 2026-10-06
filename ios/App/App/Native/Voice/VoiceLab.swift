//
//  VoiceLab.swift — numbers for the hidden Voice Lab (Settings › About › tap the version 5 times) and the
//  simulator voice self-test.
//
//  Voice Lab: time to first audio, per-sentence real-time factor, model load (cold/warm), compute units
//  (configured per stage + what the device offers), memory, thermal state, fallbacks and crashes, so a
//  listening session on the phone can be reported with one "Copy report".
//
//  NarrationSelfTest: CI launches the Debug app in the simulator with `-tachiVoiceSelfTest 1`;
//  src/ui/native/voice-selftest.ts plays a synthetic chapter, injects a slow Kokoro to force the Apple
//  fallback, checks the highlight, and posts its findings here; this file adds what only native code sees
//  (audio actually rendered, scheduler counters) and writes Documents/voice-selftest.json, which
//  ci/ios-voice-selftest.sh reads from the simulator container.
//

import AVFoundation
import CoreML
import Foundation
import HDVoiceCore
import HDVoiceKokoro
import os
import UIKit

enum VoiceLab {
    static func snapshot() -> [String: Any] {
        let k = KokoroService.shared
        let prefs = VoiceSettings.shared.prefs
        let route = KokoroRoute.from(prefs.route)
        var d: [String: Any] = [
            "kokoro": [
                "bundled": k.isBundled,
                "status": k.statusText,
                "route": route.rawValue,
                "routeTitle": route.title,
                "ahead": prefs.clampedAhead,
                "lastLoadMs": k.lastLoadMs ?? NSNull(),
                "lastLoadCold": k.lastLoadCold,
                "memoryReleases": k.memoryReleases,
                "model": k.modelInfo,
                "stages": stageUnits(route),
            ] as [String: Any],
            "stats": k.stats.dictionary(),
            "device": device(),
            "crashes": crashes(k.sentinel.current),
            "placement": k.lastPlacement.map { ["stage": $0.stage, "configured": $0.configured, "ane": $0.neuralEngine, "cpu": $0.cpu, "gpu": $0.gpu,
                                                "error": $0.error ?? NSNull(), "summary": $0.summary] as [String: Any] },
            "routes": KokoroRoute.allCases.map { ["id": $0.rawValue, "title": $0.title, "gpu": $0.usesGPU] as [String: Any] },
            "car": [
                "nowPlaying": NowPlayingCenter.shared.snapshot(),
                "commands": RemoteCommandHub.shared.snapshot(),
                "carPlayTemplates": CarPlayFeature.templatesEnabled,
                "preparedBytes": DriveCache.shared.index.totalBytes,
                "preparedChapters": DriveCache.shared.index.chapters.count,
            ] as [String: Any],
        ]
        if let s = NarrationController.shared.speechEngine.snapshot {
            d["session"] = [
                "source": s.source.rawValue,
                "lastFallback": s.lastFallback?.rawValue ?? NSNull(),
                "underruns": s.underruns,
                "returnsToKokoro": s.returnsToKokoro,
                "kokoroSentences": s.kokoroSentences,
                "appleSentences": s.appleSentences,
                "fallbacks": Dictionary(uniqueKeysWithValues: s.fallbacks.map { ($0.key.rawValue, $0.value) }),
                "throttled": s.throttled,
            ] as [String: Any]
        }
        return d
    }

    private static func stageUnits(_ route: KokoroRoute) -> [String: String] {
        let u = route.computeUnits
        func name(_ c: MLComputeUnits) -> String {
            switch c {
            case .cpuOnly: return "CPU"
            case .cpuAndGPU: return "CPU+GPU"
            case .cpuAndNeuralEngine: return "CPU+ANE"
            case .all: return "all"
            @unknown default: return "?"
            }
        }
        return ["albert": name(u.albert), "postAlbert": name(u.postAlbert), "alignment": name(u.alignment), "prosody": name(u.prosody),
                "noise": name(u.noise), "vocoder": name(u.vocoder), "tail": name(u.tail)]
    }

    private static func device() -> [String: Any] {
        let p = ProcessInfo.processInfo
        let thermal: String
        switch p.thermalState {
        case .nominal: thermal = "nominal"
        case .fair: thermal = "fair"
        case .serious: thermal = "serious"
        case .critical: thermal = "critical"
        @unknown default: thermal = "unknown"
        }
        var sys = utsname()
        uname(&sys)
        let machine = withUnsafeBytes(of: &sys.machine) { raw in String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self) }
        let devices: [String] = MLModel.availableComputeDevices.map { dev in
            switch dev {
            case .cpu: return "CPU"
            case .gpu: return "GPU"
            case .neuralEngine(let ne): return "Neural Engine (\(ne.totalCoreCount) cores)"
            @unknown default: return "other"
            }
        }
        return [
            "model": machine,
            "os": p.operatingSystemVersionString,
            "thermal": thermal,
            "lowPower": p.isLowPowerModeEnabled,
            "memoryMB": (memoryFootprintMB() * 10).rounded() / 10,
            "availableMB": Double(os_proc_available_memory()) / 1_048_576,
            "computeDevices": devices,
            "battery": batteryLevel(),
        ]
    }

    private static func batteryLevel() -> Double {
        UIDevice.current.isBatteryMonitoringEnabled = true
        return Double(UIDevice.current.batteryLevel)
    }

    /// Physical footprint (what jetsam counts), in MB.
    static func memoryFootprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return kr == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
    }

    private static func crashes(_ r: CrashRecord) -> [String: Any] {
        [
            "total": r.total,
            "consecutive": r.consecutive,
            "disabled": r.disabled,
            "lastAt": r.lastCrashAt.map { ISO8601DateFormatter().string(from: $0) } ?? NSNull(),
            "lastContext": r.lastContext ?? NSNull(),
        ]
    }
}

/// Simulator voice self-test support (inactive unless launched with -tachiVoiceSelfTest).
final class NarrationSelfTest {
    static let shared = NarrationSelfTest()
    static var isActive: Bool {
        #if DEBUG
        return UserDefaults.standard.bool(forKey: "tachiVoiceSelfTest")
        #else
        return false
        #endif
    }

    private let lock = NSLock()
    /// A synthetic novel for the car phase (chapterPath → the narration.chapterText answer), registered by
    /// voice-selftest.ts; NarrationController and DrivePrep read it instead of asking the core.
    private var chapters: [String: [String: Any]] = [:]
    private var renderedFrames: Int = 0
    private var audibleFrames: Int = 0
    private var maxRMS: Float = 0

    /// Manual-rendering output (HybridSpeechEngine headless mode): count what was actually played.
    func observeOutput(_ buffer: AVAudioPCMBuffer) {
        guard let ch = buffer.floatChannelData?[0] else { return }
        let n = Int(buffer.frameLength)
        var acc: Float = 0
        for i in 0..<n { acc += ch[i] * ch[i] }
        let rms = n > 0 ? (acc / Float(n)).squareRoot() : 0
        lock.lock()
        renderedFrames += n
        if rms > 0.003 { audibleFrames += n }
        maxRMS = max(maxRMS, rms)
        lock.unlock()
    }

    /// Register the synthetic novel (self-test mode only; main thread).
    func register(chapters list: [[String: Any]]) {
        guard Self.isActive else { return }
        chapters = [:]
        for c in list {
            guard let path = c["chapterPath"] as? String else { continue }
            chapters[path] = c
        }
    }

    var hasChapters: Bool { !chapters.isEmpty }

    /// A registered chapter in the narration.chapterText shape, or nil.
    func chapterText(_ chapterPath: String) -> [String: Any]? { chapters[chapterPath] }

    /// The UI side's findings + native counters → Documents/voice-selftest.json.
    func writeReport(_ uiJson: String) -> URL? {
        var report: [String: Any] = [:]
        if let data = uiJson.data(using: .utf8), let ui = try? JSONSerialization.jsonObject(with: data) { report["ui"] = ui }
        lock.lock()
        report["output"] = ["renderedFrames": renderedFrames, "audibleFrames": audibleFrames, "maxRMS": maxRMS,
                            "manual": NarrationController.shared.speechEngine.manualOutput]
        lock.unlock()
        report["lab"] = VoiceLab.snapshot()
        guard let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) else { return nil }
        let url = docs.appendingPathComponent("voice-selftest.json")
        try? data.write(to: url, options: .atomic)
        return url
    }
}
