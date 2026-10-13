//
//  VoiceRun.swift — the app's side of the run journal (HDVoiceCore RunJournal): how this run is going, so the next
//  launch can tell a crash of a voice's model from the app being closed.
//
//  - Started first thing at launch (AppDelegate), before the voices' crash sentinels check the last run. It installs
//    the fatal-signal handler (HDVoiceCore CrashSignals), so the next launch knows whether the process crashed (and how:
//    a memory fault off the main thread is how her model crashes, a Swift trap or abort() is an app bug) or was killed.
//  - Notes foreground/background, narration playing or not (NarrationController), memory warnings, and the clean
//    ends: applicationWillTerminate (swiped away while running), the app's window disconnected with nothing working,
//    put in the background with no voice working.
//  - A heartbeat every 10 s while a voice works (narration playing, or a model call in flight): the chapter, who reads,
//    the phone's heat, memory used and left.
//  - The last run's end in plain words goes to Settings › Diagnostics (the core's log) when it was unexpected while the
//    app was in use; a voice's own verdict (its call in flight) is posted by its service (`postVoice`).
//

import Foundation
import HDVoiceCore
import os
import UIKit

/// Main-thread confined: started from AppDelegate; its observers and timer run on main, and NarrationController (main)
/// reports to it.
final class VoiceRun: @unchecked Sendable {
    static let shared = VoiceRun()
    static let heartbeatSeconds: TimeInterval = 10

    let journal: RunJournal
    private var sentinels: [CrashSentinel] = []
    private var foreground = true
    private var playing = false
    private var voicePosted = false
    private var observers: [NSObjectProtocol] = []
    private var timer: Timer?
    private let log = Logger(subsystem: "app.tachinovel", category: "voice")

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let info = Bundle.main.infoDictionary ?? [:]
        // The bundle's container folder (…/Bundle/Application/<UUID>/App.app) is new with every install, update and
        // AltStore refresh: a different one means the app was reinstalled, never that it crashed.
        let identity = RunIdentity(version: info["CFBundleShortVersionString"] as? String ?? "?",
                                   build: info["CFBundleVersion"] as? String ?? "?",
                                   install: Bundle.main.bundleURL.deletingLastPathComponent().lastPathComponent)
        journal = RunJournal(directory: support.appendingPathComponent("TachiNovel/voice-run", isDirectory: true), identity: identity)
    }

    /// Once, at launch: this run's record begins (the last run's stays readable in `journal.previous`).
    func start(foreground: Bool) {
        guard observers.isEmpty else { return }
        self.foreground = foreground
        journal.start(foreground: foreground, watch: CrashSignals.install)
        let last = journal.lastEnd
        let line = RunEndWords.line(last, voice: "the voice")
        log.info("run: last run \(last.kind.rawValue, privacy: .public): \(line, privacy: .public)")
        // Worth a line in Settings › Diagnostics: an end while in use that the app can't explain. Said a little later,
        // and only when no voice said it first (a voice whose call was in flight posts its own verdict at its launch
        // check; Nephis's service starts within the first seconds).
        let inUse = last.foreground == true || last.playing == true
        if [.appError, .fault, .stopped, .unexpected].contains(last.kind) || (last.kind == .memory && inUse) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
                guard let self, !self.voicePosted else { return }
                Self.post(line, level: "warn")
            }
        }
        observe(UIApplication.didEnterBackgroundNotification) { run, _ in run.setForeground(false) }
        observe(UIApplication.willEnterForegroundNotification) { run, _ in run.setForeground(true) }
        observe(UIApplication.didBecomeActiveNotification) { run, _ in run.setForeground(true) }
        observe(UIApplication.willTerminateNotification) { run, _ in run.journal.closed(.closed) }
        observe(UIApplication.didReceiveMemoryWarningNotification) { run, _ in run.journal.memoryWarning() }
        observe(UIScene.didDisconnectNotification) { run, note in
            // The app's own window; CarPlay's scene coming and going says nothing about the app. iOS also disconnects
            // the window of an app playing in the background (locked phone, CarPlay only) while it goes on working:
            // only an idle app's window closing is a clean end.
            let scene = note.object as? UIScene
            let isAppWindow = MainActor.assumeIsolated { scene?.session.role == .windowApplication }
            if isAppWindow, !run.playing, !run.busy { run.journal.closed(.windowClosed) }
        }
        let t = Timer(timeInterval: Self.heartbeatSeconds, repeats: true) { [weak self] _ in self?.tick() }
        t.tolerance = 2
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    /// A voice's crash sentinel, for the heartbeat's "call in flight" and the background-idle check.
    func watch(_ sentinel: CrashSentinel) {
        if !sentinels.contains(where: { $0 === sentinel }) { sentinels.append(sentinel) }
    }

    /// NarrationController's status changed (playing = playing or loading its next chapter).
    func narrationChanged(playing now: Bool) {
        guard now != playing else { return }
        playing = now
        journal.setPlaying(now)
        if now { beat() } else { idleCheck() }
    }

    /// Narration was stopped (the user, the sleep timer, a remote command).
    func narrationStopped() {
        journal.stopped()
    }

    /// A voice's verdict on the last run (its call was in flight), as a line in Settings › Diagnostics.
    func postVoice(_ line: String, counted: Bool, quiet: Bool) {
        voicePosted = true
        Self.post(line, level: counted ? "error" : quiet ? "info" : "warn")
    }

    /// The last run's end in plain words, as a line in Settings › Diagnostics (the core's log).
    private static func post(_ line: String, level: String) {
        CoreHost.shared.request("diagnostics.voiceEnd", args: ["message": line, "level": level])
    }

    private func observe(_ name: Notification.Name, _ body: @escaping @Sendable (VoiceRun, Notification) -> Void) {
        let token = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
            guard let self else { return }
            body(self, note)
        }
        observers.append(token)
    }

    private func setForeground(_ now: Bool) {
        foreground = now
        journal.setForeground(now)
        if !now { idleCheck() }
    }

    private var busy: Bool { sentinels.contains { $0.inFlight } }

    /// In the background with nothing playing and no model call running: iOS may close the app from here, no crash.
    private func idleCheck() {
        guard !foreground, !playing, !busy else { return }
        journal.idleInBackground()
    }

    private func tick() {
        // A call that was still running when the app went to the background has returned since: idle there now.
        guard playing || busy else { return idleCheck() }
        beat()
    }

    private func beat() {
        let labels: (chapter: String?, voice: String?) = playing ? NarrationController.shared.runLabels : (nil, nil)
        let footprint = VoiceLab.memoryFootprintMB()
        let busyNames = sentinels.filter { $0.inFlight }.map(\.name)
        journal.beat(RunHeartbeat(at: Date(), chapter: labels.chapter, voice: labels.voice, thermal: ExpressiveService.thermalName(),
                                  memoryMB: footprint >= 0 ? (footprint * 10).rounded() / 10 : nil, availableMB: Self.availableMB(),
                                  busy: busyNames, foreground: foreground, playing: playing))
        Self.appendBeatLine(memoryMB: footprint, availableMB: Self.availableMB(), voice: labels.voice, chapter: labels.chapter,
                            busy: busyNames, playing: playing, foreground: foreground)
    }

    /// The heartbeat as one line in logs/voice-beat.log, which survives a memory kill (the process's own os_log doesn't)
    /// and is mirrored to the Diagnostics folder: what memory did, second by second, before iOS closed the app.
    /// Kept under ~256 KB (the older half is dropped).
    private static func appendBeatLine(memoryMB: Double, availableMB: Double?, voice: String?, chapter: String?,
                                       busy: [String], playing: Bool, foreground: Bool) {
        let logs = CoreHost.shared.localAppDir.appendingPathComponent("logs", isDirectory: true)
        let url = logs.appendingPathComponent("voice-beat.log")
        let clock = DateFormatter()
        clock.dateFormat = "HH:mm:ss"
        let line = "\(clock.string(from: Date())) mem \(Int(memoryMB)) MB free \(availableMB.map { String(Int($0)) } ?? "?") MB"
            + " thermal \(ExpressiveService.thermalName()) voice \(voice ?? "-") playing \(playing) fg \(foreground)"
            + " busy \(busy.joined(separator: ",")) chapter \(chapter ?? "-")\n"
        let fm = FileManager.default
        try? fm.createDirectory(at: logs, withIntermediateDirectories: true)
        if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 256 * 1024,
           let data = try? Data(contentsOf: url) {
            try? Data(data.suffix(128 * 1024)).write(to: url, options: .atomic)
        }
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(line.utf8))
        } else {
            try? Data(line.utf8).write(to: url)
        }
    }

    /// Memory left before iOS's limit for the app, MB (nil where the system doesn't say).
    static func availableMB() -> Double? {
        let bytes = os_proc_available_memory()
        return bytes > 0 ? (Double(bytes) / 1_048_576).rounded() : nil
    }
}
