//
//  DrivePrep.swift — "Prepare for the drive": a novel's next chapters rendered with Kokoro into local audio
//  files ahead of time, so playback in the car never waits on synthesis or the network.
//
//  - DriveCache: the prepared files (Application Support/DriveAudio, excluded from backups): one AAC .m4a
//    per chapter + its timestamp manifest (the same format as PC-narrated audio, NarrationManifest.swift),
//    so prepared chapters play through NarrationController's audio path with sentence highlighting.
//    Evicted after listening, capped at DrivePrepPolicy.defaultCapBytes (oldest first).
//  - DrivePrep: the requests (DriveJob, persisted) and the runner: one sentence at a time, never while
//    Kokoro reads aloud or the phone is hot, and for "when charging or on Wi-Fi" only then. Runs in the
//    foreground, alongside prepared playback in the background, and in a BGProcessingTask.
//  - ChapterRenderer: one chapter's sentence script → Kokoro → PCM post-processing → AAC + manifest.
//  The decisions (policy, index, job walk) are platform-free in HDVoiceCore/DrivePrep.swift. Main thread.
//

@preconcurrency import AVFoundation
@preconcurrency import BackgroundTasks
import Foundation
import HDVoiceCore
import HDVoiceKokoro
import Network
import os
import UIKit

enum DriveError: Error, LocalizedError {
    case interrupted(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .interrupted(let why), .failed(let why): return why
        }
    }
}

// MARK: - Prepared files

/// Main-thread confined (DrivePrep and the controller use it on main).
final class DriveCache: @unchecked Sendable {
    static let shared = DriveCache()
    static let changed = Notification.Name("tachinovel.driveCacheChanged")

    let folder: URL
    private(set) var index: DriveCacheIndex

    private init() {
        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? fm.temporaryDirectory
        var dir = support.appendingPathComponent("DriveAudio", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        folder = dir
        if let data = try? Data(contentsOf: dir.appendingPathComponent("index.json")),
           let idx = try? JSONDecoder().decode(DriveCacheIndex.self, from: data), idx.schemaVersion == DriveCacheIndex.schema {
            index = idx
        } else {
            index = DriveCacheIndex()
        }
        prune()
    }

    func url(_ file: String) -> URL { folder.appendingPathComponent(file) }

    /// A playable prepared chapter made with `voice` (its files present).
    func prepared(novelKey: String, chapterPath: String, voice: String) -> PreparedChapter? {
        guard let c = index.find(novelKey: novelKey, chapterPath: chapterPath, voice: voice) else { return nil }
        let fm = FileManager.default
        guard fm.fileExists(atPath: url(c.audioFile).path), fm.fileExists(atPath: url(c.manifestFile).path) else { return nil }
        return c
    }

    /// Record a finished chapter; replaced files go, and the cap trims the oldest (never `keep`).
    func add(_ c: PreparedChapter, keep: Set<String>) {
        if let old = index.upsert(c), old.audioFile != c.audioFile { deleteFiles([old]) }
        deleteFiles(index.trim(toBytes: DrivePrepPolicy.defaultCapBytes, keep: keep.union([c.id])))
        save()
    }

    /// Listened to the end: the prepared audio isn't needed any more.
    func evictAfterListening(novelKey: String, chapterPath: String) {
        let gone = index.remove(novelKey: novelKey, chapterPath: chapterPath)
        guard !gone.isEmpty else { return }
        deleteFiles(gone)
        save()
    }

    /// Remove one novel's prepared audio, or everything (nil).
    func remove(novelKey: String?) {
        deleteFiles(novelKey.map { index.removeNovel($0) } ?? index.removeAll())
        save()
    }

    func entries(novelKey: String?) -> [[String: Any]] {
        let list = novelKey.map { index.chapters(novelKey: $0) } ?? index.chapters
        return list.map { c in
            ["novelKey": c.novelKey, "chapterPath": c.chapterPath, "title": c.title, "voice": c.voice, "bytes": c.bytes,
             "durationSec": (c.durationMs / 1000).rounded(), "createdAt": c.createdAt] as [String: Any]
        }
    }

    private func deleteFiles(_ cs: [PreparedChapter]) {
        for c in cs {
            try? FileManager.default.removeItem(at: url(c.audioFile))
            try? FileManager.default.removeItem(at: url(c.manifestFile))
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(index) { try? data.write(to: folder.appendingPathComponent("index.json"), options: .atomic) }
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }

    /// Entries whose files are gone are dropped; files no entry refers to (an interrupted render) are deleted.
    private func prune() {
        let fm = FileManager.default
        let before = index.chapters.count
        index.chapters.removeAll { !fm.fileExists(atPath: url($0.audioFile).path) || !fm.fileExists(atPath: url($0.manifestFile).path) }
        let known = Set(index.chapters.flatMap { [$0.audioFile, $0.manifestFile] } + ["index.json"])
        for name in (try? fm.contentsOfDirectory(atPath: folder.path)) ?? [] where !known.contains(name) {
            try? fm.removeItem(at: url(name))
        }
        if index.chapters.count != before, let data = try? JSONEncoder().encode(index) {
            try? data.write(to: folder.appendingPathComponent("index.json"), options: .atomic)
        }
    }
}

// MARK: - One chapter → audio file

/// Renders a chapter's sentence script with Kokoro into `<stem>.m4a` (AAC-LC, mono 24 kHz, 32 kbps,
/// ~14 MB per hour) and `<stem>.json` (timestamp manifest). Main thread; file writes on a serial queue.
/// Driven on main; only the audio file is touched on its writer queue (`io`), one write at a time.
final class ChapterRenderer: @unchecked Sendable {
    struct Output {
        let audioFile: String
        let manifestFile: String
        let bytes: Int
        let durationMs: Double
        let sentences: Int
    }

    private let chapter: NarrationController.Chapter
    private let items: [NarrationController.ScriptItem]
    private let voice: String
    /// Narrator mode at render time: dialogue voices, pacing, jitter and polish, as live narration has them.
    private let narrator: NarratorSettings
    private var polish: NarrationPolish?
    private let folder: URL
    private let stem: String
    private let io = DispatchQueue(label: "app.tachinovel.drive-writer")
    private var file: AVAudioFile?
    private var writeError: Error?
    private let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)
    private var frames: Int = 0
    private var sampleRate = 24_000
    private var segments: [NarrationTiming.Segment] = []
    private var loudness = LoudnessMatcher()
    private var next = 0
    private var retried = false
    private var stopReason: String?
    private var completion: ((Result<Output, Error>) -> Void)?

    /// Asked between sentences: a reason to stop now (cancelled, live narration started, the phone is hot…).
    var shouldStop: (() -> String?)?
    /// Sentences done / total.
    var onProgress: ((Int, Int) -> Void)?

    init(chapter: NarrationController.Chapter, items: [NarrationController.ScriptItem], voice: String, narrator: NarratorSettings = NarratorSettings(),
         folder: URL) {
        self.chapter = chapter
        self.items = items
        self.voice = voice
        self.narrator = narrator
        polish = narrator.usesPolish ? NarrationPolish(sampleRate: 24_000, roomTone: narrator.usesRoomTone, compressorRatio: narrator.compressorRatio) : nil
        self.folder = folder
        stem = "\(Int(Date().timeIntervalSince1970 * 1000))-\(UInt32.random(in: 0...UInt32.max))"
    }

    func start(_ completion: @escaping (Result<Output, Error>) -> Void) {
        self.completion = completion
        let url = folder.appendingPathComponent("\(stem).m4a")
        io.async {
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 24_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32_000,
            ]
            do {
                let f = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
                DispatchQueue.main.async {
                    self.file = f
                    self.step()
                }
            } catch {
                DispatchQueue.main.async { self.finish(.failure(DriveError.failed("Couldn't create the audio file: \(error.localizedDescription)"))) }
            }
        }
    }

    /// Stop after the sentence in progress.
    func stop(_ reason: String) { stopReason = reason }

    private func step() {
        if let why = stopReason ?? shouldStop?() { return finish(.failure(DriveError.interrupted(why))) }
        guard next < items.count else { return finalize() }
        let item = items[next]
        let sentence = item.narrator
        let speed = NarratorPlan.rate(1, for: sentence, settings: narrator)
        let prefs = VoiceSettings.shared.prefs
        let handle: (Result<KokoroAudio, Error>) -> Void = { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let audio):
                self.append(item, audio)
                self.retried = false
                self.next += 1
                self.onProgress?(self.next, self.items.count)
                self.step()
            case .failure(let error):
                // One retry (a reload after a memory warning, a transient error); then the chapter fails.
                guard !self.retried else { return self.finish(.failure(DriveError.failed("Kokoro couldn't read a sentence: \(error.localizedDescription)"))) }
                self.retried = true
                KokoroService.shared.ensureLoaded { _ in self.step() }
            }
        }
        if let parts = NarratorPlan.parts(for: sentence, settings: narrator, resolve: { prefs.engineVoice($0) }) {
            KokoroService.shared.synthesize(parts: parts, voice: voice, speed: speed, completion: handle)
        } else {
            KokoroService.shared.synthesize(text: item.text, runs: item.runs, voice: voice, speed: speed, completion: handle)
        }
    }

    private func append(_ item: NarrationController.ScriptItem, _ audio: KokoroAudio) {
        sampleRate = audio.sampleRate
        let pause = NarratorPlan.pause(for: item.narrator, settings: narrator)
        let out: [Float]
        if var p = polish, p.sampleRate == audio.sampleRate {
            out = p.prepareSentence(audio.samples, pause: pause)
            polish = p
        } else {
            out = PCM.prepareSentence(audio.samples, sampleRate: audio.sampleRate, pause: pause, loudness: &loudness)
        }
        let speech = max(0, out.count - PCM.silenceFrames(seconds: pause, sampleRate: audio.sampleRate))
        let sr = Double(max(1, audio.sampleRate))
        let t0 = Double(frames) / sr
        segments.append(NarrationTiming.Segment(id: item.id, block: item.block, start: item.start, end: item.end,
                                                t0: t0, t1: t0 + Double(speech) / sr, hash: item.hash, paragraph: item.paragraph))
        frames += out.count
        guard !out.isEmpty, let format, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(out.count)),
              let ch = buf.floatChannelData?[0] else { return }
        out.withUnsafeBufferPointer { src in
            if let base = src.baseAddress { ch.update(from: base, count: out.count) }
        }
        buf.frameLength = AVAudioFrameCount(out.count)
        io.async {
            guard self.writeError == nil, let f = self.file else { return }
            do { try f.write(from: buf) } catch { self.writeError = error }
        }
    }

    private func finalize() {
        let audioName = "\(stem).m4a"
        let manifestName = "\(stem).json"
        let durationMs = Double(frames) * 1000 / Double(max(1, sampleRate))
        io.async {
            self.file = nil // closes (finishes) the file
            let failure = self.writeError
            let bytes = ((try? FileManager.default.attributesOfItem(atPath: self.folder.appendingPathComponent(audioName).path))?[.size] as? NSNumber)?.intValue ?? 0
            DispatchQueue.main.async {
                if let failure { return self.finish(.failure(DriveError.failed("Couldn't write the audio: \(failure.localizedDescription)"))) }
                let timing = NarrationTiming(segments: self.segments, duration: durationMs / 1000,
                                             nextChapterPath: self.chapter.nextPath, nextTitle: self.chapter.nextName,
                                             prevChapterPath: self.chapter.prevPath, prevTitle: self.chapter.prevName)
                let source = NarrationTiming.Source(pluginId: self.chapter.pluginId, novelPath: self.chapter.novelPath, chapterPath: self.chapter.chapterPath,
                                                    title: self.chapter.chapterName, voice: self.voice, audioFile: audioName)
                do {
                    try timing.manifestJSON(source: source).write(to: self.folder.appendingPathComponent(manifestName), options: .atomic)
                } catch {
                    return self.finish(.failure(DriveError.failed("Couldn't write the manifest: \(error.localizedDescription)")))
                }
                self.finish(.success(Output(audioFile: audioName, manifestFile: manifestName, bytes: bytes, durationMs: durationMs, sentences: self.items.count)))
            }
        }
    }

    private func finish(_ result: Result<Output, Error>) {
        guard let done = completion else { return }
        completion = nil
        if case .failure = result {
            let stem = self.stem
            let folder = self.folder
            io.async {
                self.file = nil
                try? FileManager.default.removeItem(at: folder.appendingPathComponent("\(stem).m4a"))
                try? FileManager.default.removeItem(at: folder.appendingPathComponent("\(stem).json"))
            }
        }
        done(result)
    }
}

// MARK: - Requests and the runner

/// Main-thread confined: requests, the runner and the system callbacks all hop to main.
final class DrivePrep: @unchecked Sendable {
    static let shared = DrivePrep()
    static let taskId = "app.tachinovel.drive-prep"
    static let changed = Notification.Name("tachinovel.drivePrepChanged")
    private static let jobsKey = "tachinovel.driveJobs"

    private(set) var jobs: [DriveJob] = []
    private var renderer: ChapterRenderer?
    private var runningKey: String?
    /// The chapter being rendered: sentences done of all.
    private struct Current {
        let chapterPath: String
        let title: String
        let sentence: Int
        let sentences: Int
    }

    private var current: Current?
    private var waiting: [String: String] = [:]
    private var wifi = false
    private let monitor = NWPathMonitor()
    private var started = false
    private var bgTask: BGProcessingTask?
    private var appTask: UIBackgroundTaskIdentifier = .invalid
    private var retryItem: DispatchWorkItem?
    /// novelKey → uptime before which a failed request isn't retried.
    private var retryAfter: [String: Double] = [:]
    /// Kokoro was loaded for preparing: release it once preparing goes idle (unless narration uses it).
    private var usedKokoro = false
    private var lastNotify = 0.0
    private var observers: [NSObjectProtocol] = []
    private let log = Logger(subsystem: "app.tachinovel", category: "drive")

    private init() {}

    /// Call from application(_:didFinishLaunchingWithOptions:), before launch finishes.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: nil) { task in
            guard let task = task as? BGProcessingTask else { return task.setTaskCompleted(success: false) }
            DispatchQueue.main.async { DrivePrep.shared.runInBackground(task) }
        }
    }

    func start() {
        guard !started else { return }
        started = true
        jobs = Self.loadJobs()
        MainThread.run { UIDevice.current.isBatteryMonitoringEnabled = true }
        monitor.pathUpdateHandler = { [weak self] path in
            let wifi = path.status == .satisfied && (path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet))
            DispatchQueue.main.async { [weak self] in
                guard let self, self.wifi != wifi else { return }
                self.wifi = wifi
                self.kick()
            }
        }
        monitor.start(queue: DispatchQueue(label: "app.tachinovel.drive-network"))
        let nc = NotificationCenter.default
        for name in [UIDevice.batteryStateDidChangeNotification, Notification.Name.NSProcessInfoPowerStateDidChange,
                     ProcessInfo.thermalStateDidChangeNotification, UIApplication.didBecomeActiveNotification, KokoroService.statusChanged] {
            observers.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.kick() })
        }
        kick()
    }

    // MARK: Requests

    /// "Prepare for the drive": the next `count` chapters from `startChapterPath` (default: where listening
    /// would resume). Replaces the novel's earlier request.
    func request(pluginId: String, novelPath: String, novelName: String, coverUrl: String?, count: Int, when: DrivePrepWhen, startChapterPath: String?) {
        start()
        let voice = VoiceSettings.shared.prefs.voice(forNovel: VoiceSettings.novelKey(pluginId: pluginId, novelPath: novelPath))
        var job = DriveJob(pluginId: pluginId, novelPath: novelPath, novelName: novelName, coverUrl: coverUrl, count: count, when: when,
                           voice: voice, createdAt: Date().timeIntervalSince1970)
        job.cursor = startChapterPath
        if runningKey == job.novelKey { renderer?.stop("Replaced by a new request") }
        jobs.removeAll { $0.novelKey == job.novelKey }
        jobs.append(job)
        save()
        kick()
    }

    func cancel(novelKey: String) {
        if runningKey == novelKey { renderer?.stop("Cancelled") }
        jobs.removeAll { $0.novelKey == novelKey }
        save()
        kick()
    }

    /// Narration started or stopped (live Kokoro has priority over preparing).
    func narrationChanged() {
        guard started else { return }
        if renderer != nil, let job = jobs.first(where: { $0.novelKey == runningKey }), let why = stopReason(job) {
            renderer?.stop(why)
        } else if renderer == nil {
            kick()
        }
    }

    // MARK: Status (UI)

    func status(novelKey: String?) -> [String: Any] {
        let cache = DriveCache.shared
        let list = jobs.filter { novelKey == nil || $0.novelKey == novelKey }.map { j -> [String: Any] in
            var d: [String: Any] = ["novelKey": j.novelKey, "pluginId": j.pluginId, "novelPath": j.novelPath, "novelName": j.novelName,
                                    "count": j.count, "when": j.when.rawValue, "done": j.done.count, "titles": j.titles, "voice": j.voice,
                                    "state": state(of: j)]
            if let r = waiting[j.novelKey] { d["reason"] = r }
            if let e = j.lastError { d["error"] = e }
            if runningKey == j.novelKey, let c = current {
                d["current"] = ["chapterPath": c.chapterPath, "title": c.title, "sentence": c.sentence, "sentences": c.sentences] as [String: Any]
            }
            return d
        }
        return [
            "jobs": list,
            "prepared": cache.entries(novelKey: novelKey),
            "bytes": novelKey.map { cache.index.bytes(novelKey: $0) } ?? cache.index.totalBytes,
            "totalBytes": cache.index.totalBytes,
            "capBytes": DrivePrepPolicy.defaultCapBytes,
        ]
    }

    private func state(of j: DriveJob) -> String {
        if runningKey == j.novelKey { return "running" }
        if j.finished { return j.failures >= DriveJob.maxFailures ? "failed" : "done" }
        return waiting[j.novelKey] != nil ? "waiting" : "queued"
    }

    // MARK: Runner

    private func conditions() -> DriveConditions {
        let battery = MainThread.run { UIDevice.current.batteryState }
        let n = NarrationController.shared
        return DriveConditions(charging: battery == .charging || battery == .full, wifi: wifi,
                               lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled,
                               thermalThrottled: ThermalPolicy.throttled(rawState: ProcessInfo.processInfo.thermalState.rawValue),
                               liveNarration: n.speaksLive)
    }

    private func stopReason(_ job: DriveJob) -> String? {
        guard jobs.contains(where: { $0.novelKey == job.novelKey }) else { return "Cancelled" }
        return DrivePrepPolicy.gate(job.when, conditions()).reason
    }

    /// Start the next runnable request, if nothing runs.
    func kick() {
        guard started, renderer == nil, runningKey == nil else { return }
        retryItem?.cancel()
        retryItem = nil
        guard jobs.contains(where: { !$0.finished }) else {
            waiting = [:]
            releaseKokoroIfIdle()
            return endBackgroundWork()
        }
        let c = conditions()
        let now = ProcessInfo.processInfo.systemUptime
        waiting = [:]
        var nextRetry: Double?
        for job in jobs where !job.finished {
            if let t = retryAfter[job.novelKey], t > now {
                waiting[job.novelKey] = "Trying again shortly"
                nextRetry = min(nextRetry ?? t, t)
                continue
            }
            switch DrivePrepPolicy.gate(job.when, c) {
            case .run:
                return run(job)
            case .wait(let reason):
                waiting[job.novelKey] = reason
            }
        }
        if let t = nextRetry {
            let item = DispatchWorkItem { [weak self] in self?.kick() }
            retryItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + max(1, t - now), execute: item)
        }
        notify(force: true)
        if jobs.contains(where: { !$0.finished }) { scheduleBackground() }
        releaseKokoroIfIdle()
        endBackgroundWork()
    }

    private func releaseKokoroIfIdle() {
        guard usedKokoro, !NarrationController.shared.wantsKokoro else { return }
        usedKokoro = false
        KokoroService.shared.scheduleIdleRelease(after: 60)
    }

    private func run(_ job: DriveJob) {
        runningKey = job.novelKey
        beginBackgroundWork()
        notify(force: true)
        if let cursor = job.cursor { return render(job, chapterPath: cursor) }
        guard job.done.isEmpty else {
            update(job.novelKey) { $0.finished = true }
            return done()
        }
        // Start where listening would resume (the core knows the last chapter and paragraph).
        CoreHost.shared.request("narration.resumePoint", args: ["pluginId": job.pluginId, "novelPath": job.novelPath]) { ok, result in
            let path = ok ? (result as? [String: Any])?["chapterPath"] as? String : nil
            DispatchQueue.main.async {
                guard let path else {
                    self.update(job.novelKey) { j in
                        j.lastError = "Read a chapter of this novel first"
                        j.finished = true
                        j.failures = DriveJob.maxFailures
                    }
                    return self.done()
                }
                self.update(job.novelKey) { $0.cursor = path }
                self.render(job, chapterPath: path)
            }
        }
    }

    private func render(_ job: DriveJob, chapterPath: String) {
        NarrationController.shared.chapterForPreparing(pluginId: job.pluginId, novelPath: job.novelPath, chapterPath: chapterPath,
                                                       novelName: job.novelName, coverUrl: job.coverUrl) { ch in
            guard self.runningKey == job.novelKey else { return self.done() }
            guard let ch, let script = ch.script, !script.isEmpty else { return self.failed(job, "Couldn't load \(chapterPath)") }
            if DriveCache.shared.prepared(novelKey: job.novelKey, chapterPath: chapterPath, voice: VoiceSettings.shared.prefs.preparedVoice(voice: job.voice)) != nil {
                return self.completed(job, chapterPath: chapterPath, title: ch.chapterName, next: ch.nextPath)
            }
            KokoroService.shared.ensureLoaded { status in
                guard status == .ready else { return self.failed(job, "Kokoro isn't available (\(KokoroService.shared.statusText))") }
                self.usedKokoro = true
                // Filed under the voice plus narrator mode's settings now (what playback will look for).
                let prefs = VoiceSettings.shared.prefs
                let key = prefs.preparedVoice(voice: job.voice)
                let r = ChapterRenderer(chapter: ch, items: script, voice: job.voice, narrator: prefs.narrator, folder: DriveCache.shared.folder)
                r.shouldStop = { [weak self] in self?.stopReason(job) }
                r.onProgress = { [weak self] i, n in
                    self?.current = Current(chapterPath: chapterPath, title: ch.chapterName, sentence: i, sentences: n)
                    self?.notify(force: false)
                }
                self.renderer = r
                self.current = Current(chapterPath: chapterPath, title: ch.chapterName, sentence: 0, sentences: script.count)
                self.log.info("drive: preparing \(chapterPath, privacy: .public) (\(script.count) sentences)")
                r.start { result in
                    self.renderer = nil
                    self.current = nil
                    switch result {
                    case .success(let out):
                        let entry = PreparedChapter(novelKey: job.novelKey, chapterPath: chapterPath, title: ch.chapterName, voice: key,
                                                    audioFile: out.audioFile, manifestFile: out.manifestFile, bytes: out.bytes,
                                                    durationMs: out.durationMs, sentences: out.sentences, createdAt: Date().timeIntervalSince1970)
                        let keep = Set((self.jobs.first { $0.novelKey == job.novelKey }?.done ?? []).map { DriveCacheIndex.id(novelKey: job.novelKey, chapterPath: $0) })
                        DriveCache.shared.add(entry, keep: keep)
                        self.completed(job, chapterPath: chapterPath, title: ch.chapterName, next: ch.nextPath)
                    case .failure(let error):
                        if let e = error as? DriveError, case .interrupted(let why) = e {
                            self.log.info("drive: paused (\(why, privacy: .public))")
                            self.done()
                        } else {
                            self.failed(job, error.localizedDescription)
                        }
                    }
                }
            }
        }
    }

    private func completed(_ job: DriveJob, chapterPath: String, title: String, next: String?) {
        retryAfter[job.novelKey] = nil
        update(job.novelKey) { $0.completed(chapterPath, title: title, next: next) }
        done()
    }

    private func failed(_ job: DriveJob, _ message: String) {
        log.error("drive: \(message, privacy: .public)")
        update(job.novelKey) { $0.failed(message) }
        // Try again in a minute (offline, a source hiccup); three failures in a row end the request.
        retryAfter[job.novelKey] = ProcessInfo.processInfo.systemUptime + 60
        done()
    }

    private func done() {
        runningKey = nil
        renderer = nil
        current = nil
        kick()
    }

    private func update(_ key: String, _ change: (inout DriveJob) -> Void) {
        guard let i = jobs.firstIndex(where: { $0.novelKey == key }) else { return }
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

    // MARK: Background time

    /// Finishing the chapter in progress when the app goes to the background (prepared playback keeps the
    /// app running anyway; otherwise this buys ~30 s, then the BGProcessingTask continues later).
    private func beginBackgroundWork() {
        guard appTask == .invalid, bgTask == nil else { return }
        appTask = MainThread.run {
            UIApplication.shared.beginBackgroundTask(withName: "drive-prep") { [weak self] in
                self?.renderer?.stop("Continuing later")
                self?.endBackgroundWork()
            }
        }
    }

    private func endBackgroundWork() {
        if appTask != .invalid {
            let task = appTask
            MainThread.run { UIApplication.shared.endBackgroundTask(task) }
            appTask = .invalid
        }
        if let task = bgTask, renderer == nil, runningKey == nil {
            bgTask = nil
            task.setTaskCompleted(success: !jobs.contains { !$0.finished })
            if jobs.contains(where: { !$0.finished }) { scheduleBackground() }
        }
    }

    private func scheduleBackground() {
        let req = BGProcessingTaskRequest(identifier: Self.taskId)
        req.requiresNetworkConnectivity = true
        req.requiresExternalPower = jobs.filter { !$0.finished }.allSatisfy { $0.when == .chargingOrWifi }
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do { try BGTaskScheduler.shared.submit(req) } catch { log.info("drive: background task not scheduled: \(error.localizedDescription, privacy: .public)") }
    }

    private func runInBackground(_ task: BGProcessingTask) {
        bgTask = task
        task.expirationHandler = { [weak self] in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.renderer?.stop("Continuing later")
                if let t = self.bgTask {
                    self.bgTask = nil
                    t.setTaskCompleted(success: false)
                    self.scheduleBackground()
                }
            }
        }
        CoreHost.shared.start(launchReason: "drive-prep")
        start()
        kick()
    }
}
