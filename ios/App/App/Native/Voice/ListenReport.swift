//
//  ListenReport.swift — the automatic listening report (overnight queue #2, heat batch 1, 2026-10-15). At the end of each
//  Listen session (Stop; the read ending, or a pause, idle for 2 minutes; a pause and the app left) a small JSON goes to
//  the Diagnostics folder as listen-<date>-<time>.json (logs/ on the iPhone, which the folder's mirror copies): how long
//  she was heard, the voice and pack, her calls and what they did (her studio used or skipped and why, the de-wind
//  cleaner, takes, lead-ins, speech checks, Mimi's work), breaks, time to first audio, heat at the start, at its worst and
//  at the end, Low Power Mode, the battery used, × real time and errors. No audio and no text of the book.
//
//  Main thread: VoiceRun (playing, stopped, the app left, its heartbeat) and HybridSpeechEngine (first audio, breaks)
//  report to it; her calls' numbers are the session's change in ExpressiveService.flowStats.
//

import ExpressiveCore
import ExpressiveEngines
import Foundation
import os
import UIKit

final class ListenReport {
    static let shared = ListenReport()
    /// Not playing for this long ends the session (the read ended, or a long pause).
    static let idleSeconds: TimeInterval = 120
    /// A session shorter than this (Play, then Stop at once) leaves no report.
    static let minimumSeconds: TimeInterval = 10
    /// Reports kept in logs/ (the newest).
    static let kept = 30

    private struct Session {
        let started: Date
        var playingSince: Date?
        var playedSeconds = 0.0
        var firstAudioMs: Double?
        var breaks = 0
        var breakSeconds = 0.0
        let thermalStart: Int
        var thermalMax: Int
        let lowPowerStart: Bool
        var lowPowerSeen: Bool
        let batteryStart: Float?
        let chargingStart: Bool
        var voices: Set<String> = []
        /// Her numbers when the session began (the report is the change since).
        let stats: ExpressiveService.FlowStats
    }

    private var session: Session?
    private var idleItem: DispatchWorkItem?
    private let log = Logger(subsystem: "app.tachinovel", category: "voice")

    // MARK: - What happens

    /// Listen started or stopped playing (loading the next chapter counts as playing).
    func playing(_ now: Bool) {
        let t = Date()
        if now {
            idleItem?.cancel()
            idleItem = nil
            if session == nil { begin(at: t) }
            if session?.playingSince == nil { session?.playingSince = t }
            note()
        } else if var s = session, let since = s.playingSince {
            s.playedSeconds += max(0, t.timeIntervalSince(since))
            s.playingSince = nil
            session = s
            let item = DispatchWorkItem { [weak self] in self?.end("idle \(Int(Self.idleSeconds / 60)) minutes") }
            idleItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.idleSeconds, execute: item)
        }
    }

    /// Stop (the user, the sleep timer, a remote command).
    func stopped() {
        end("stopped")
    }

    /// The app went to the background: a session not playing ends now (iOS may suspend the app before its idle wait).
    func leftApp() {
        guard let s = session, s.playingSince == nil else { return }
        end("paused, app left")
    }

    /// The read's first audio, `ms` after it was asked for (the first of the session counts).
    func firstAudio(ms: Double) {
        guard session != nil, session?.firstAudioMs == nil else { return }
        session?.firstAudioMs = ms
    }

    /// Playback waited for audio for `seconds` (a break the listener heard).
    func breakEnded(seconds: Double) {
        guard session != nil else { return }
        session?.breaks += 1
        session?.breakSeconds += max(0, seconds)
    }

    /// VoiceRun's heartbeat (every 10 s while a voice works): the heat at its worst, the voice reading.
    func beat() {
        note()
    }

    // MARK: - The session

    private func begin(at t: Date) {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        let level = device.batteryLevel
        let info = ProcessInfo.processInfo
        session = Session(started: t, thermalStart: info.thermalState.rawValue, thermalMax: info.thermalState.rawValue,
                          lowPowerStart: info.isLowPowerModeEnabled, lowPowerSeen: info.isLowPowerModeEnabled,
                          batteryStart: level >= 0 ? level : nil,
                          chargingStart: device.batteryState == .charging || device.batteryState == .full,
                          stats: ExpressiveService.shared.flowStats)
    }

    private func note() {
        guard session != nil else { return }
        let info = ProcessInfo.processInfo
        session?.thermalMax = max(session?.thermalMax ?? 0, info.thermalState.rawValue)
        if info.isLowPowerModeEnabled { session?.lowPowerSeen = true }
        if let voice = NarrationController.shared.runLabels.voice { session?.voices.insert(voice) }
    }

    private func end(_ reason: String) {
        idleItem?.cancel()
        idleItem = nil
        guard var s = session else { return }
        session = nil
        let t = Date()
        if let since = s.playingSince { s.playedSeconds += max(0, t.timeIntervalSince(since)) }
        guard s.playedSeconds >= Self.minimumSeconds else { return }
        let report = Self.json(s, reason: reason, ended: t, now: ExpressiveService.shared.flowStats)
        guard JSONSerialization.isValidJSONObject(report),
              let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) else {
            log.error("listen report: couldn’t be written as JSON")
            return
        }
        let name = "listen-\(Self.stamp(s.started)).json"
        let logs = CoreHost.shared.localAppDir.appendingPathComponent("logs", isDirectory: true)
        let log = self.log
        // Written under a background task (a session that ends as the app leaves), then copied to the folder.
        let task = UIApplication.shared.beginBackgroundTask(withName: "listen-report")
        DiagnosticsFiles.queue.async {
            do {
                try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
                try data.write(to: logs.appendingPathComponent(name), options: .atomic)
                Self.prune(logs)
            } catch {
                log.error("listen report: \(error.localizedDescription, privacy: .public)")
            }
            Task { @MainActor in
                DiagnosticsFolder.shared.mirror(force: true) {
                    Task { @MainActor in if task != .invalid { UIApplication.shared.endBackgroundTask(task) } }
                }
            }
        }
        log.notice("listen report: \(name, privacy: .public) (\(Int(s.playedSeconds)) s heard, \(reason, privacy: .public))")
    }

    /// Keeps the newest `kept` listening reports in logs/.
    private static func prune(_ logs: URL) {
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: logs.path)) ?? [])
            .filter { $0.hasPrefix("listen-") && $0.hasSuffix(".json") }.sorted(by: >)
        for name in names.dropFirst(kept) { try? FileManager.default.removeItem(at: logs.appendingPathComponent(name)) }
    }

    /// "2026-10-15-213005" (local time).
    static func stamp(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd-HHmmss"
        return f.string(from: date)
    }

    // MARK: - The report

    private static let heat = ["nominal", "fair", "serious", "critical"]
    private static func heatWord(_ v: Int) -> String { heat.indices.contains(v) ? heat[v] : "unknown" }
    private static func r1(_ x: Double) -> Double { (x * 10).rounded() / 10 }
    private static func r2(_ x: Double) -> Double { (x * 100).rounded() / 100 }

    private static func json(_ s: Session, reason: String, ended: Date, now f: ExpressiveService.FlowStats) -> [String: Any] {
        // Her numbers in this session: the change since it began (from zero if the Voice test reset them meanwhile).
        let b = f.calls >= s.stats.calls ? s.stats : ExpressiveService.FlowStats()
        let calls = f.calls - b.calls
        let audioMs = max(0, f.audioMs - b.audioMs)
        let totalMs = max(0, f.totalMs - b.totalMs)
        var reasons: [String: Int] = [:]
        for (k, n) in f.bypassReasons {
            let d = n - (b.bypassReasons[k] ?? 0)
            if d > 0 { reasons[k] = d }
        }
        let studioCalls = f.studioCalls - b.studioCalls
        let studioUsed = f.studioUsed - b.studioUsed
        let stream = f.streamLatents - b.streamLatents
        let decoded = stream + (f.scratchLatents - b.scratchLatents) + (f.tailLatents - b.tailLatents)
        var out: [String: Any] = ["kind": "listen-report", "version": 1]
        let iso = ISO8601DateFormatter()
        out["at"] = iso.string(from: s.started)
        out["ended"] = iso.string(from: ended)
        out["endedBy"] = reason
        let bundle = Bundle.main.infoDictionary
        out["app"] = "\(bundle?["CFBundleShortVersionString"] as? String ?? "?") (\(bundle?["CFBundleVersion"] as? String ?? "?"))"
        out["listenedSeconds"] = r1(s.playedSeconds)
        out["sessionSeconds"] = r1(ended.timeIntervalSince(s.started))
        out["voices"] = s.voices.sorted()
        let info = NephisModelPack.info ?? [:]
        out["pack"] = NephisModelPack.active.map { root -> [String: Any] in
            ["id": root.lastPathComponent, "name": info["name"] ?? NSNull(), "weightsSha256": info["weightsSha256"] ?? NSNull()]
        } ?? NSNull()
        // Her calls (Nephis's flow engine; 0 when another voice read).
        out["calls"] = calls
        out["audioSeconds"] = r1(audioMs / 1000)
        out["timesRealTime"] = totalMs > 0 ? r2(audioMs / totalMs) as Any : NSNull()
        out["takes"] = f.takes - b.takes
        out["leadIns"] = f.leadIns - b.leadIns
        out["speechChecks"] = f.listened - b.listened
        out["recognizeMs"] = r1(max(0, f.recognizeMs - b.recognizeMs))
        out["backgroundPriorityCalls"] = f.relaxedCalls - b.relaxedCalls
        out["studio"] = ["calls": studioCalls, "used": studioUsed, "skipped": max(0, studioCalls - studioUsed), "reasons": reasons,
                         "offForSession": f.studioOff ?? NSNull()] as [String: Any]
        out["dewind"] = ["calls": f.dewindCalls - b.dewindCalls, "ms": r1(max(0, f.dewindMs - b.dewindMs)),
                         "predictMs": r1(max(0, f.dewindPredictMs - b.dewindPredictMs)), "ioMs": r1(max(0, f.dewindIOMs - b.dewindIOMs)),
                         "dspMs": r1(max(0, f.dewindDSPMs - b.dewindDSPMs))]
        out["mimiLatents"] = ["stream": stream, "scratch": f.scratchLatents - b.scratchLatents, "tail": f.tailLatents - b.tailLatents,
                              "perPlayed": stream > 0 ? r2(Double(decoded) / Double(stream)) as Any : NSNull()] as [String: Any]
        out["breaks"] = s.breaks
        out["breakSeconds"] = r1(s.breakSeconds)
        out["firstAudioMs"] = s.firstAudioMs.map { $0.rounded() } ?? NSNull()
        let thermalEnd = ProcessInfo.processInfo.thermalState.rawValue
        out["thermal"] = ["start": heatWord(s.thermalStart), "max": heatWord(max(s.thermalMax, thermalEnd)), "end": heatWord(thermalEnd)]
        out["lowPowerMode"] = s.lowPowerSeen || ProcessInfo.processInfo.isLowPowerModeEnabled
        let device = UIDevice.current
        let level = device.batteryLevel
        let charging = s.chargingStart || device.batteryState == .charging || device.batteryState == .full
        var battery: [String: Any] = ["charging": charging]
        if let start = s.batteryStart, level >= 0 {
            battery["startPercent"] = Int((start * 100).rounded())
            battery["endPercent"] = Int((level * 100).rounded())
            // Used per hour heard, when it ran on the battery long enough to say (iOS reports whole percents).
            if !charging, s.playedSeconds >= 600 { battery["percentPerHour"] = r1(Double(start - level) * 100 / (s.playedSeconds / 3600)) }
        }
        out["battery"] = battery
        out["errors"] = ["failedCalls": f.failedCalls - b.failedCalls, "readRestarts": f.readRestarts - b.readRestarts,
                         "emptyPieces": f.emptyPieces - b.emptyPieces, "memoryRefusals": f.memoryRefusals - b.memoryRefusals,
                         "lastMemoryRefusal": f.memoryRefusals > b.memoryRefusals ? (f.lastMemoryRefusal ?? "") as Any : NSNull()] as [String: Any]
        return out
    }
}
