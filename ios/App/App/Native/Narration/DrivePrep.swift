//
//  DrivePrep.swift — the queue that renders chapters into audio on this iPhone: "Prepare for the drive" (the next N
//  chapters, deleted after listening) and audio downloads (chosen chapters, kept), plus the chapters whose audio was made
//  with an older voice (rendered again while charging). Audio downloads part 1 (2026-10-16): Nephis renders through the
//  one pipeline Listen plays (ChapterAudioRenderer), resumable, with the director worked out first; Kokoro when she isn't
//  the reader. Files: NarrationAudioStore. Decisions (when it may run, the index, the jobs, estimates): HDVoiceCore
//  NarrationAudio.swift and DrivePrep.swift.
//
//  When it runs (AudioRenderPolicy): live reading always wins (it yields at the next call boundary when Listen or the
//  Voice speed test starts, and goes on 30 s after they stop); serious heat pauses it until two minutes at fair or below;
//  Low Power Mode on battery waits; "while charging" / "charging or Wi-Fi" as asked; the network only for a chapter whose
//  text isn't saved yet; never while a downloaded chapter hands over to live reading. In the foreground, alongside
//  downloaded playback in the background, and in a BGProcessingTask (external power when every request waits for it,
//  network only when a chapter's text is still to fetch). Main thread.
//

@preconcurrency import BackgroundTasks
import ExpressiveCore
import Foundation
import HDVoiceCore
import Network
import os
import UIKit

/// Main-thread confined: requests, the runner and the system callbacks all hop to main.
final class DrivePrep: @unchecked Sendable {
    static let shared = DrivePrep()
    static let taskId = "app.tachinovel.drive-prep"
    static let changed = Notification.Name("tachinovel.drivePrepChanged")
    private static let jobsKey = "tachinovel.driveJobs"
    private static let speedKey = "tachinovel.audio.speedX"

    private(set) var jobs: [DriveJob] = []
    private var nephis: ChapterAudioRenderer?
    private var kokoro: KokoroChapterRenderer?
    /// The request being worked on (DriveJob.key).
    private var runningKey: String?
    private struct Current {
        let chapterPath: String
        let title: String
        var progress: ChapterAudioProgress
    }

    private var current: Current?
    private var waiting: [String: String] = [:]
    private var wifi = false
    private var online = true
    private let monitor = NWPathMonitor()
    private var started = false
    private var bgTask: BGProcessingTask?
    private var appTask: UIBackgroundTaskIdentifier = .invalid
    private var retryItem: DispatchWorkItem?
    /// Request key → uptime before which a failed request isn't retried.
    private var retryAfter: [String: Double] = [:]
    private var usedKokoro = false
    private var usedNephis = false
    private var lastNotify = 0.0
    private var observers: [NSObjectProtocol] = []
    private var heat = HeatGate()
    /// Live speech now, and when it last stopped (uptime).
    private var live = false
    private var liveEnded: Double?
    private let log = Logger(subsystem: "app.tachinovel", category: "drive")
    private var store: NarrationAudioStore { NarrationAudioStore.shared }

    /// Her measured render speed for downloads (audio seconds per wall second, a moving average): the estimates' render time.
    private(set) var speedX: Double? {
        get { UserDefaults.standard.object(forKey: Self.speedKey) as? Double }
        set { UserDefaults.standard.set(newValue, forKey: Self.speedKey) }
    }

    private init() {}

    /// Call from application(_:didFinishLaunchingWithOptions:), before launch finishes.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: nil) { task in
            guard let task = task as? BGProcessingTask else { return task.setTaskCompleted(success: false) }
            let carried = MainBound(task)
            DispatchQueue.main.async { DrivePrep.shared.runInBackground(carried.value) }
        }
    }

    func start() {
        guard !started else { return }
        started = true
        jobs = Self.loadJobs()
        MainThread.run { UIDevice.current.isBatteryMonitoringEnabled = true }
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            let wifi = online && (path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet))
            DispatchQueue.main.async { [weak self] in
                guard let self, self.wifi != wifi || self.online != online else { return }
                self.wifi = wifi
                self.online = online
                self.kick()
            }
        }
        monitor.start(queue: DispatchQueue(label: "app.tachinovel.drive-network"))
        let nc = NotificationCenter.default
        for name in [UIDevice.batteryStateDidChangeNotification, Notification.Name.NSProcessInfoPowerStateDidChange,
                     ProcessInfo.thermalStateDidChangeNotification, UIApplication.didBecomeActiveNotification, KokoroService.statusChanged,
                     ExpressiveService.statusChanged] {
            observers.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.kick() })
        }
        // A voice change (a new pack, her studio, delivery settings): audio of the older voice is queued again (a moment
        // later, once: a slider sends many changes).
        for name in [VoiceSettings.changed, NephisModelPack.didInstall, ExpressiveService.statusChanged] {
            observers.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.sweepSoon() })
        }
        kick()
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { NarrationAudioStore.shared.sweep(force: true) }
    }

    private var sweepItem: DispatchWorkItem?

    private func sweepSoon() {
        sweepItem?.cancel()
        let item = DispatchWorkItem { NarrationAudioStore.shared.sweep() }
        sweepItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: item)
    }

    // MARK: - Requests

    /// "Prepare for the drive": the next `count` chapters from `startChapterPath` (default: where listening would resume).
    /// Replaces the novel's earlier drive request.
    func request(pluginId: String, novelPath: String, novelName: String, coverUrl: String?, count: Int, when: DrivePrepWhen, startChapterPath: String?) {
        start()
        let voice = VoiceSettings.shared.prefs.voice(forNovel: VoiceSettings.novelKey(pluginId: pluginId, novelPath: novelPath))
        var job = DriveJob(pluginId: pluginId, novelPath: novelPath, novelName: novelName, coverUrl: coverUrl, count: count, when: when,
                           voice: voice, createdAt: Date().timeIntervalSince1970)
        job.cursor = startChapterPath
        replace(job)
    }

    /// Audio downloads: these chapters of a novel, in order (merged into its download request; chapters done before are
    /// rendered again only if their audio is gone or older).
    func enqueue(pluginId: String, novelPath: String, novelName: String, coverUrl: String?, chapters: [String], when: DrivePrepWhen) {
        start()
        let novelKey = VoiceSettings.novelKey(pluginId: pluginId, novelPath: novelPath)
        let key = "\(novelKey)\u{1F}\(NarrationAudioKind.download.rawValue)"
        if let i = jobs.firstIndex(where: { $0.key == key }) {
            jobs[i].redo(chapters.filter { store.playable(novelKey: novelKey, chapterPath: $0) == nil })
            jobs[i].when = when
            jobs[i].paused = nil
            if !novelName.isEmpty { jobs[i].novelName = novelName }
            if let coverUrl { jobs[i].coverUrl = coverUrl }
            retryAfter[key] = nil
            save()
            return kick()
        }
        let voice = VoiceSettings.shared.prefs.voice(forNovel: novelKey)
        replace(DriveJob(pluginId: pluginId, novelPath: novelPath, novelName: novelName, coverUrl: coverUrl, chapters: chapters, kind: .download,
                         when: when, voice: voice, createdAt: Date().timeIntervalSince1970))
    }

    private func replace(_ job: DriveJob) {
        if runningKey == job.key { stopRunning("Replaced by a new request") }
        jobs.removeAll { $0.key == job.key }
        jobs.append(job)
        retryAfter[job.key] = nil
        save()
        kick()
    }

    /// Audio made with an older voice: its chapters rendered again (while charging), into the request of its kind. A drive
    /// request still walking its chapters is left to finish its walk.
    func requeue(_ entries: [NarrationAudioEntry]) {
        start()
        var changed = false
        for e in entries {
            let key = "\(e.novelKey)\u{1F}\(e.kind.rawValue)"
            if let i = jobs.firstIndex(where: { $0.key == key }) {
                if jobs[i].list != nil {
                    let before = jobs[i]
                    jobs[i].redo([e.chapterPath])
                    changed = changed || jobs[i] != before
                    continue
                }
                guard jobs[i].finished else { continue }
                jobs.remove(at: i)
            }
            let src = e.source
            let voice = VoiceSettings.shared.prefs.voice(forNovel: e.novelKey)
            jobs.append(DriveJob(pluginId: src.pluginId, novelPath: src.novelPath, novelName: e.novelName ?? "", coverUrl: nil,
                                 chapters: [e.chapterPath], kind: e.kind, when: .charging, voice: voice, createdAt: Date().timeIntervalSince1970))
            changed = true
        }
        guard changed else { return }
        log.notice("drive: \(entries.count) chapter(s) made with an older voice queued to render again")
        save()
        kick()
    }

    /// The novel's requests (of one kind, or both): paused, going on, or dropped.
    func pause(novelKey: String, kind: NarrationAudioKind?) { setPaused(novelKey: novelKey, kind: kind, true) }
    func resume(novelKey: String, kind: NarrationAudioKind?) { setPaused(novelKey: novelKey, kind: kind, false) }

    private func setPaused(novelKey: String, kind: NarrationAudioKind?, _ paused: Bool) {
        start()
        for i in jobs.indices where jobs[i].novelKey == novelKey && (kind == nil || jobs[i].audioKind == kind) {
            jobs[i].paused = paused ? true : nil
            if paused, runningKey == jobs[i].key { stopRunning("Paused") }
        }
        save()
        kick()
    }

    func cancel(novelKey: String, kind: NarrationAudioKind? = nil) {
        let gone = jobs.filter { $0.novelKey == novelKey && (kind == nil || $0.audioKind == kind) }
        for j in gone {
            if runningKey == j.key { stopRunning("Cancelled") }
            // The chapter it was working on keeps no half-made audio.
            if let c = j.cursor { store.removeWork(novelKey: j.novelKey, chapterPath: c) }
        }
        jobs.removeAll { j in gone.contains { $0.key == j.key } }
        save()
        kick()
    }

    /// Narration started or stopped: live speech always wins (the render stops after the call in progress) and the queue
    /// goes on 30 s after it ends.
    func narrationChanged() {
        guard started else { return }
        let now = NarrationController.shared.speaksLive || VoiceSpeedTest.shared.running
        if now != live {
            live = now
            if !now { liveEnded = ProcessInfo.processInfo.systemUptime }
        }
        if now || NarrationController.shared.handoffActive {
            stopRunning(now ? "Paused while you listen" : "Paused while the next chapter gets ready")
        } else if nephis == nil, kokoro == nil {
            kick()
        }
    }

    private func stopRunning(_ why: String) {
        nephis?.stop(why)
        kokoro?.stop(why)
    }

    // MARK: - Status

    /// "Prepare for the drive" (the sheet): its requests and audio only.
    func status(novelKey: String?) -> [String: Any] {
        let drive = store.entries(novelKey: novelKey, kind: .drive)
        return [
            "jobs": jobInfos(novelKey: novelKey, kind: .drive),
            "prepared": drive,
            "bytes": drive.reduce(0) { $0 + (($1["bytes"] as? Int) ?? 0) },
            "totalBytes": store.index.bytes(kind: .drive),
            "capBytes": DrivePrepPolicy.defaultCapBytes,
        ]
    }

    /// Audio downloads (the bridge's audio.status): every request and every chapter's audio, the storage, the settings and
    /// the render speed.
    func audioStatus(novelKey: String?) -> [String: Any] {
        let entries = store.entries(novelKey: novelKey)
        return [
            "jobs": jobInfos(novelKey: novelKey, kind: nil),
            "audio": entries,
            "bytes": entries.reduce(0) { $0 + (($1["bytes"] as? Int) ?? 0) },
            "totalBytes": store.index.totalBytes,
            "downloadBytes": store.index.bytes(kind: .download),
            "driveBytes": store.index.bytes(kind: .drive),
            "workBytes": store.workBytes,
            "capBytes": DrivePrepPolicy.defaultCapBytes,
            "deleteAfterListening": NarrationAudioStore.deleteAfterListening,
            "bestOfTwo": DeveloperOptions.snapshot["bestOfTwo"] == true,
            "speedX": speedX.map { ($0 * 100).rounded() / 100 as Any } ?? NSNull(),
            "voice": NarrationAudioStore.nephisReads ? "nephis" : "kokoro",
        ]
    }

    private func jobInfos(novelKey: String?, kind: NarrationAudioKind?) -> [[String: Any]] {
        jobs.filter { (novelKey == nil || $0.novelKey == novelKey) && (kind == nil || $0.audioKind == kind) }.map { j -> [String: Any] in
            var d: [String: Any] = ["key": j.key, "novelKey": j.novelKey, "pluginId": j.pluginId, "novelPath": j.novelPath, "novelName": j.novelName,
                                    "kind": j.audioKind.rawValue, "count": j.count, "when": j.when.rawValue, "done": j.done.count, "titles": j.titles,
                                    "voice": j.voice, "state": state(of: j), "paused": j.isPaused]
            if let list = j.list { d["chapters"] = list }
            if let r = waiting[j.key] { d["reason"] = r }
            if let e = j.lastError { d["error"] = e }
            if runningKey == j.key, let c = current {
                d["current"] = ["chapterPath": c.chapterPath, "title": c.title, "sentence": c.progress.sentence, "sentences": c.progress.sentences,
                                "calls": c.progress.calls, "seconds": (c.progress.seconds * 10).rounded() / 10, "step": c.progress.step] as [String: Any]
            }
            return d
        }
    }

    private func state(of j: DriveJob) -> String {
        if runningKey == j.key { return "running" }
        if j.finished { return j.failures >= DriveJob.maxFailures ? "failed" : "done" }
        if j.isPaused { return "paused" }
        return waiting[j.key] != nil ? "waiting" : "queued"
    }

    /// Minutes, megabytes and render time for `chapters` chapters of a novel (`characters` of text when known).
    func estimate(novelKey: String?, chapters: Int, characters: Int?) -> [String: Any] {
        let known = novelKey.map { store.index.entries(novelKey: $0) } ?? store.index.entries
        let average = known.isEmpty ? nil : known.reduce(0) { $0 + $1.durationMs } / Double(known.count) / 60_000
        let studio = NarrationAudioStore.nephisReads && SessionRate.forRead(.pocketTts) == SessionRate.studio
        let bitRate = studio ? NarrationAudioEstimate.studioBitRate : NarrationAudioEstimate.plainBitRate
        let e = NarrationAudioEstimate.estimate(chapters: chapters, characters: characters, averageMinutes: average, bitRate: bitRate, speedX: speedX)
        let r1 = { (x: Double) in (x * 10).rounded() / 10 }
        return ["minutes": r1(e.minutes), "megabytes": r1(e.megabytes), "renderMinutes": r1(e.renderMinutes), "bitRate": bitRate,
                "megabytesPerMinute": NarrationAudioEstimate.megabytesPerMinute(bitRate: bitRate), "speedX": speedX.map { $0 as Any } ?? NSNull(),
                "measured": speedX != nil]
    }

    // MARK: - Runner

    private func conditions() -> AudioRenderConditions {
        let battery = MainThread.run { UIDevice.current.batteryState }
        let now = ProcessInfo.processInfo.systemUptime
        return AudioRenderConditions(charging: battery == .charging || battery == .full, wifi: wifi, online: online,
                                     lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled, live: live,
                                     sinceLive: liveEnded.map { now - $0 }, handoff: NarrationController.shared.handoffActive,
                                     voiceBlocked: voiceBlocked())
    }

    /// Her voice can't render now (the chosen reader is Nephis): why, in plain words.
    private func voiceBlocked() -> String? {
        let svc = ExpressiveService.shared
        if svc.studioTestRunning { return "Paused for the studio test" }
        guard NarrationAudioStore.nephisReads else { return nil }
        if !NarrationController.preparesNephis {
            return svc.crashDisabled ? "Waiting: Nephis is switched off after crashing" : "Waiting for Nephis to be ready"
        }
        if let block = svc.loadBlock { return "Waiting for Nephis (\(block.localizedDescription))" }
        return nil
    }

    /// Her next chapter's text is saved (no network needed to render it).
    private func hasText(_ job: DriveJob) -> Bool {
        guard let c = job.cursor else { return false }
        return FileManager.default.fileExists(atPath: store.workFolder(novelKey: job.novelKey, chapterPath: c).appendingPathComponent("chapter.json").path)
    }

    private func stopReason(_ job: DriveJob) -> String? {
        guard let j = jobs.first(where: { $0.key == job.key }), !j.finished else { return "Cancelled" }
        if j.isPaused { return "Paused" }
        let heatOK = heat.update(thermal: ProcessInfo.processInfo.thermalState.rawValue, now: ProcessInfo.processInfo.systemUptime)
        return AudioRenderPolicy.gate(j.when, conditions(), heatOK: heatOK, needsText: false).reason
    }

    /// Start the next request that may run, if nothing runs; otherwise say why each waits and look again when it may.
    func kick() {
        guard started, nephis == nil, kokoro == nil, runningKey == nil else { return }
        retryItem?.cancel()
        retryItem = nil
        let open = jobs.filter { !$0.finished }
        guard !open.isEmpty else {
            waiting = [:]
            releaseIfIdle()
            notify(force: true)
            return endBackgroundWork()
        }
        let now = ProcessInfo.processInfo.systemUptime
        let c = conditions()
        let heatOK = heat.update(thermal: ProcessInfo.processInfo.thermalState.rawValue, now: now)
        waiting = [:]
        var look: Double?
        for job in open {
            if job.isPaused {
                waiting[job.key] = "Paused"
                continue
            }
            if let t = retryAfter[job.key], t > now {
                waiting[job.key] = "Trying again shortly"
                look = min(look ?? .infinity, t - now)
                continue
            }
            switch AudioRenderPolicy.gate(job.when, c, heatOK: heatOK, needsText: !hasText(job)) {
            case .run:
                return run(job)
            case .wait(let reason):
                waiting[job.key] = reason
            }
        }
        // Waits that end on their own: the 30 s after live speech, two minutes cool.
        if let since = c.sinceLive, since < AudioRenderPolicy.afterLive { look = min(look ?? .infinity, AudioRenderPolicy.afterLive - since + 0.5) }
        if let left = heat.remaining(now: now) { look = min(look ?? .infinity, left + 1) }
        if let t = look {
            let item = DispatchWorkItem { [weak self] in self?.kick() }
            retryItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + max(1, t), execute: item)
        }
        notify(force: true)
        if open.contains(where: { !$0.isPaused }) { scheduleBackground() }
        releaseIfIdle()
        endBackgroundWork()
    }

    /// The voices loaded for rendering go once the queue is idle (unless narration uses them).
    private func releaseIfIdle() {
        if usedKokoro, !NarrationController.shared.wantsKokoro {
            usedKokoro = false
            KokoroService.shared.scheduleIdleRelease(after: 60)
        }
        if usedNephis, !NarrationController.shared.wantsKokoro {
            usedNephis = false
            ExpressiveService.shared.scheduleIdleRelease()
        }
    }

    private func run(_ job: DriveJob) {
        runningKey = job.key
        beginBackgroundWork()
        notify(force: true)
        if let cursor = job.cursor { return render(job, chapterPath: cursor) }
        guard job.list == nil, job.done.isEmpty else {
            update(job.key) { $0.finished = true }
            return done()
        }
        // Start where listening would resume (the core knows the last chapter and paragraph).
        CoreHost.shared.request("narration.resumePoint", args: ["pluginId": job.pluginId, "novelPath": job.novelPath]) { ok, result in
            let path = ok ? (result as? [String: Any])?["chapterPath"] as? String : nil
            DispatchQueue.main.async {
                guard let path else {
                    self.update(job.key) { j in
                        j.lastError = "Read a chapter of this novel first"
                        j.finished = true
                        j.failures = DriveJob.maxFailures
                    }
                    return self.done()
                }
                self.update(job.key) { $0.cursor = path }
                self.render(job, chapterPath: path)
            }
        }
    }

    /// A chapter's text for rendering: saved in its work folder (the core's answer) so an interrupted render goes on
    /// without the network, else fetched and saved.
    private func loadChapter(_ job: DriveJob, _ path: String, completion: @escaping (NarrationController.Chapter?) -> Void) {
        let dir = store.workFolder(novelKey: job.novelKey, chapterPath: path)
        let file = dir.appendingPathComponent("chapter.json")
        let make = { (raw: [String: Any]) in
            NarrationController.chapter(fromCore: raw, pluginId: job.pluginId, novelPath: job.novelPath, chapterPath: path, novelName: job.novelName,
                                        coverUrl: job.coverUrl)
        }
        if let data = try? Data(contentsOf: file), let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            return completion(make(raw))
        }
        NarrationController.shared.chapterText(pluginId: job.pluginId, novelPath: job.novelPath, chapterPath: path) { raw in
            guard let raw else { return completion(nil) }
            if JSONSerialization.isValidJSONObject(raw), let data = try? JSONSerialization.data(withJSONObject: raw) {
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try? data.write(to: file, options: .atomic)
            }
            completion(make(raw))
        }
    }

    private func render(_ job: DriveJob, chapterPath: String) {
        loadChapter(job, chapterPath) { ch in
            guard self.runningKey == job.key else { return self.done() }
            guard let ch, let script = ch.script, !script.isEmpty else { return self.failed(job, "Couldn't load \(chapterPath)") }
            self.store.withCurrentKey(novelKey: job.novelKey) { key in
                guard self.runningKey == job.key else { return self.done() }
                guard let key else { return self.failed(job, "Couldn't read the novel's pronunciations") }
                // Already in the voice that reads now: nothing to render.
                if let e = self.store.entry(novelKey: job.novelKey, chapterPath: chapterPath), e.voice == key.text {
                    self.store.removeWork(novelKey: job.novelKey, chapterPath: chapterPath)
                    return self.completed(job, chapterPath: chapterPath, title: ch.chapterName, next: ch.nextPath)
                }
                self.current = Current(chapterPath: chapterPath, title: ch.chapterName,
                                       progress: ChapterAudioProgress(sentence: 0, sentences: script.count, calls: 0, seconds: 0, step: "director"))
                self.notify(force: true)
                if key.family == .nephis {
                    self.renderNephis(job, ch, script, key)
                } else {
                    self.renderKokoro(job, ch, script, key)
                }
            }
        }
    }

    private func renderNephis(_ job: DriveJob, _ ch: NarrationController.Chapter, _ script: [NarrationController.ScriptItem], _ key: NarrationVoiceKey) {
        let svc = ExpressiveService.shared
        usedNephis = true
        svc.ensureLoaded(.pocketTts) { result in
            if case .failure(let error) = result {
                // Resting after a memory warning (or too little memory, or the studio test): the request waits, uncounted.
                if let block = svc.loadBlock { return self.rest(job, block) }
                return self.failed(job, "Nephis isn't available (\(error.localizedDescription))")
            }
            // Her studio's and dialogue pack's models load behind hers: every call of the chapter gets them.
            svc.whenSettled {
                guard self.runningKey == job.key else { return self.done() }
                if let why = self.stopReason(job) {
                    self.log.info("drive: paused (\(why, privacy: .public))")
                    return self.done()
                }
                self.delivery(job, ch.chapterPath, script) { delivery in
                    guard self.runningKey == job.key, let delivery else { return self.done() }
                    let bestOfTwo = DeveloperOptions.snapshot["bestOfTwo"] == true
                    let r = ChapterAudioRenderer(chapter: ch, items: script, novelKey: job.novelKey, voice: key, delivery: delivery, bestOfTwo: bestOfTwo)
                    r.shouldStop = { [weak self] in self?.stopReason(job) }
                    r.onProgress = { [weak self] p in
                        self?.current?.progress = p
                        self?.notify(force: false)
                    }
                    self.nephis = r
                    self.log.info("drive: rendering \(ch.chapterPath, privacy: .public) with Nephis (\(script.count) sentences)")
                    r.start { result in
                        self.nephis = nil
                        self.finished(job, ch, key, result, textHash: r.textHash)
                    }
                }
            }
        }
    }

    /// The chapter's director (ChapterDirector), saved in its work folder so a resumed render keeps the same moods.
    private func delivery(_ job: DriveJob, _ path: String, _ script: [NarrationController.ScriptItem],
                          completion: @escaping (ChapterDirector.Delivery?) -> Void) {
        let file = store.workFolder(novelKey: job.novelKey, chapterPath: path).appendingPathComponent("delivery.json")
        let hashes = script.map { NarrationAudioHash.fnv($0.text) }
        if let data = try? Data(contentsOf: file), let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let saved = ChapterDirector.Delivery(json: obj), saved.hashes == hashes {
            return completion(saved)
        }
        ChapterDirector.run(script, stop: { [weak self] in self?.stopReason(job) != nil }) { delivery in
            if let delivery, let data = try? JSONSerialization.data(withJSONObject: delivery.json) {
                try? data.write(to: file, options: .atomic)
            }
            completion(delivery)
        }
    }

    private func renderKokoro(_ job: DriveJob, _ ch: NarrationController.Chapter, _ script: [NarrationController.ScriptItem], _ key: NarrationVoiceKey) {
        KokoroService.shared.ensureLoaded { status in
            guard self.runningKey == job.key else { return self.done() }
            guard status == .ready else { return self.failed(job, "Kokoro isn't available (\(KokoroService.shared.statusText))") }
            self.usedKokoro = true
            let r = KokoroChapterRenderer(chapter: ch, items: script, novelKey: job.novelKey, voice: job.voice, key: key,
                                          narrator: VoiceSettings.shared.prefs.narrator)
            r.shouldStop = { [weak self] in self?.stopReason(job) }
            r.onProgress = { [weak self] p in
                self?.current?.progress = p
                self?.notify(force: false)
            }
            self.kokoro = r
            r.start { result in
                self.kokoro = nil
                self.finished(job, ch, key, result, textHash: nil)
            }
        }
    }

    private func finished(_ job: DriveJob, _ ch: NarrationController.Chapter, _ key: NarrationVoiceKey, _ result: Result<ChapterAudioOutput, Error>,
                          textHash: String?) {
        current = nil
        switch result {
        case .success(let out):
            let entry = NarrationAudioEntry(novelKey: job.novelKey, chapterPath: ch.chapterPath, title: ch.chapterName, kind: job.audioKind, voice: key.text,
                                            audioFile: out.audioFile, manifestFile: out.manifestFile, bytes: out.bytes, durationMs: out.durationMs,
                                            sentences: out.sentences, createdAt: Date().timeIntervalSince1970, textHash: textHash, novelName: job.novelName)
            let done = jobs.first { $0.key == job.key }?.done ?? []
            store.add(entry, keep: Set(done.map { NarrationAudioIndex.id(novelKey: job.novelKey, chapterPath: $0) }))
            if key.family == .nephis, out.renderSeconds > 1 {
                speedX = NarrationAudioEstimate.blend(speedX, out.durationMs / 1000 / out.renderSeconds)
            }
            log.notice("drive: \(ch.chapterPath, privacy: .public) ready: \(Int(out.durationMs / 1000)) s, \(out.bytes / 1000) KB\(out.incomplete > 0 ? ", \(out.incomplete) call(s) without her studio" : "", privacy: .public)")
            completed(job, chapterPath: ch.chapterPath, title: ch.chapterName, next: ch.nextPath)
        case .failure(let error):
            if let e = error as? DriveError, case .interrupted(let why) = e {
                log.info("drive: paused (\(why, privacy: .public))")
                done()
            } else {
                failed(job, error.localizedDescription)
            }
        }
    }

    private func completed(_ job: DriveJob, chapterPath: String, title: String, next: String?) {
        retryAfter[job.key] = nil
        update(job.key) { $0.completed(chapterPath, title: title, next: next) }
        done()
    }

    /// Her model can't load for a while (`block`): the request tries again once it may, without counting a failure.
    private func rest(_ job: DriveJob, _ block: ExpressiveError) {
        var seconds = 10.0
        if case .resting(let left) = block { seconds = Double(left) + 1 }
        log.info("drive: waiting for Nephis (\(block.localizedDescription, privacy: .public))")
        retryAfter[job.key] = ProcessInfo.processInfo.systemUptime + seconds
        done()
    }

    private func failed(_ job: DriveJob, _ message: String) {
        log.error("drive: \(message, privacy: .public)")
        current = nil
        update(job.key) { $0.failed(message) }
        // Try again in a minute (offline, a source hiccup); three failures in a row end the request.
        retryAfter[job.key] = ProcessInfo.processInfo.systemUptime + 60
        done()
    }

    private func done() {
        runningKey = nil
        nephis = nil
        kokoro = nil
        current = nil
        kick()
    }

    private func update(_ key: String, _ change: (inout DriveJob) -> Void) {
        guard let i = jobs.firstIndex(where: { $0.key == key }) else { return }
        change(&jobs[i])
        save()
    }

    private func save() {
        if let data = try? JSONEncoder().encode(jobs) { UserDefaults.standard.set(data, forKey: Self.jobsKey) }
        notify(force: true)
    }

    private static func loadJobs() -> [DriveJob] {
        guard let data = UserDefaults.standard.data(forKey: jobsKey), let list = try? JSONDecoder().decode([DriveJob].self, from: data) else { return [] }
        // Finished requests are kept a few days for the status line, then forgotten.
        let cutoff = Date().timeIntervalSince1970 - 3 * 86_400
        return list.filter { !$0.finished || $0.createdAt > cutoff }
    }

    private func notify(force: Bool) {
        let now = ProcessInfo.processInfo.systemUptime
        guard force || now - lastNotify > 0.5 else { return }
        lastNotify = now
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }

    // MARK: - Background time

    /// Finishing the call in progress when the app goes to the background (downloaded playback keeps the app running
    /// anyway; otherwise this buys ~30 s, then the BGProcessingTask goes on later from the last paragraph).
    private func beginBackgroundWork() {
        guard appTask == .invalid, bgTask == nil else { return }
        appTask = MainThread.run {
            UIApplication.shared.beginBackgroundTask(withName: "drive-prep") { [weak self] in
                DispatchQueue.main.async { [weak self] in
                    self?.stopRunning("Continuing later")
                    self?.endBackgroundWork()
                }
            }
        }
    }

    private func endBackgroundWork() {
        if appTask != .invalid {
            let task = appTask
            MainThread.run { UIApplication.shared.endBackgroundTask(task) }
            appTask = .invalid
        }
        if let task = bgTask, nephis == nil, kokoro == nil, runningKey == nil {
            bgTask = nil
            let open = jobs.contains { !$0.finished && !$0.isPaused }
            task.setTaskCompleted(success: !open)
            if open { scheduleBackground() }
        }
    }

    private func scheduleBackground() {
        let open = jobs.filter { !$0.finished && !$0.isPaused }
        guard !open.isEmpty else { return }
        let req = BGProcessingTaskRequest(identifier: Self.taskId)
        // The network only when a chapter's text still has to be fetched; external power when every request waits for it.
        req.requiresNetworkConnectivity = open.contains { !hasText($0) }
        req.requiresExternalPower = open.allSatisfy { $0.when != .now }
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do { try BGTaskScheduler.shared.submit(req) } catch { log.info("drive: background task not scheduled: \(error.localizedDescription, privacy: .public)") }
    }

    private func runInBackground(_ task: BGProcessingTask) {
        bgTask = task
        let carried = MainBound(task)
        task.expirationHandler = { [weak self] in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.stopRunning("Continuing later")
                if self.bgTask === carried.value {
                    self.bgTask = nil
                    carried.value.setTaskCompleted(success: false)
                    self.scheduleBackground()
                }
            }
        }
        CoreHost.shared.start(launchReason: "drive-prep")
        start()
        kick()
    }
}
