//
//  ExpressiveService.swift — EXPERIMENTAL expressive voices (docs/expressive-tts.md), Voice Lab only.
//
//  The app's handle on the ExpressiveVoice package (main thread, like KokoroService):
//  - Model files: downloaded on demand in the Voice Lab (Wi-Fi only, pinned revision + SHA-256 per file,
//    ModelStore), kept out of backups, deletable. Never bundled.
//  - One engine loaded at a time (they are 0.7–1.4 GB); unloaded on a memory warning, after 3 minutes idle,
//    or when another engine is loaded.
//  - Crash containment: a CrashSentinel of its own (not Kokoro's); two crashes in a row inside an
//    experimental engine turn the experimental engines off until "Turn back on" in the Voice Lab.
//  - Speed test: renders a sample without playing it and records load (cold/warm), time to first audio,
//    × real time per line, memory and thermal state.
//  Narration (NarrationController) never uses these engines; the Voice Lab plays them through
//  ExpressiveSpeechEngine, which falls back to Kokoro whenever an expressive engine can't keep up.
//

import ExpressiveCore
import ExpressiveEngines
import Foundation
import HDVoiceCore
import os
import UIKit

final class ExpressiveService {
    static let shared = ExpressiveService()

    enum DownloadState {
        case idle
        case downloading(DownloadProgress)
        case failed(String)
    }

    enum LoadState: Equatable {
        case unloaded
        case loading
        case ready
        case failed(String)
    }

    struct SpeedTest {
        var engine: ExpressiveEngineID
        var sample: String
        var running = true
        var total: Int
        var loadMs: Double?
        var coldLoad = false
        var rows: [[String: Any]] = []
        var synthMs = 0.0
        var audioMs = 0.0
        var xs: [Double] = []
        var memoryBeforeMB = 0.0
        var memoryLoadedMB = 0.0
        var memoryMaxMB = 0.0
        var thermalStart = ""
        var thermalEnd = ""
        var error: String?
    }

    let store: ModelStore?
    let sentinel: CrashSentinel
    private(set) var downloads: [ExpressiveEngineID: DownloadState] = [:]
    private var downloadTasks: [ExpressiveEngineID: Task<Void, Never>] = [:]
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    private(set) var loadedID: ExpressiveEngineID?
    private var synth: (any ExpressiveSynthesizer)?
    private(set) var loadStates: [ExpressiveEngineID: LoadState] = [:]
    private(set) var lastLoad: [ExpressiveEngineID: (ms: Double, cold: Bool)] = [:]
    private var loadedThisLaunch: Set<ExpressiveEngineID> = []
    private var loadWaiters: [(Result<Void, Error>) -> Void] = []
    private var idleItem: DispatchWorkItem?
    private(set) var memoryWarnings = 0
    private(set) var speedTest: SpeedTest?
    private var speedTask: Task<Void, Never>?
    private let log = Logger(subsystem: "app.tachinovel", category: "voice-expressive")

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let sentinel = CrashSentinel(directory: support.appendingPathComponent("TachiNovel/voice-expressive", isDirectory: true))
        self.sentinel = sentinel
        let crashed = sentinel.checkAtLaunch()
        store = (try? ExpressiveEngines.modelsRoot()).map { ModelStore(root: $0) }
        if crashed {
            let context = sentinel.current.lastContext ?? ""
            log.error("expressive: the previous run crashed inside an experimental engine (\(context, privacy: .public))")
        }
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
            self?.memoryWarning()
        }
        nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.leftForeground()
        }
    }

    var crashDisabled: Bool { sentinel.current.disabled }

    static func supported(_ id: ExpressiveEngineID) -> Bool {
        if id.needsIOS18 {
            if #available(iOS 18.0, *) { return true }
            return false
        }
        return true
    }

    func isInstalled(_ id: ExpressiveEngineID) -> Bool {
        guard let store, let m = id.pinned else { return false }
        return store.isInstalled(m)
    }

    func loadState(_ id: ExpressiveEngineID) -> LoadState { loadStates[id] ?? .unloaded }

    // MARK: - Download

    func download(_ id: ExpressiveEngineID) {
        guard let store, let model = id.pinned, downloadTasks[id] == nil else { return }
        downloads[id] = .downloading(DownloadProgress(bytesDone: 0, bytesTotal: model.totalBytes, filesDone: 0, filesTotal: model.files.count, currentFile: ""))
        beginBackgroundTime()
        let task = Task.detached(priority: .utility) { [weak self] in
            var failure: String?
            do {
                try await store.install(model, wifiOnly: true) { p in
                    DispatchQueue.main.async { self?.downloads[id] = .downloading(p) }
                }
            } catch is CancellationError {
                failure = ModelDownloadError.cancelled.localizedDescription
            } catch {
                failure = error.localizedDescription
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.downloadTasks[id] = nil
                self.downloads[id] = failure.map { DownloadState.failed($0) } ?? .idle
                if let failure { self.log.error("expressive: download of \(id.rawValue, privacy: .public) failed: \(failure, privacy: .public)") }
                if self.downloadTasks.isEmpty { self.endBackgroundTime() }
            }
        }
        downloadTasks[id] = task
    }

    func cancelDownload(_ id: ExpressiveEngineID) {
        downloadTasks[id]?.cancel()
    }

    func remove(_ id: ExpressiveEngineID) throws {
        guard let store, let model = id.pinned else { return }
        cancelDownload(id)
        if loadedID == id { unload(reason: "deleted") }
        try store.remove(model)
        downloads[id] = .idle
        loadStates[id] = .unloaded
    }

    private func beginBackgroundTime() {
        guard backgroundTask == .invalid else { return }
        // A few extra minutes if the user leaves the Voice Lab mid-download (the download stops after that).
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "expressive-model-download") { [weak self] in
            self?.endBackgroundTime()
        }
    }

    private func endBackgroundTime() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    // MARK: - Load / unload

    /// Load `id` (unloading any other engine first). Completion on main.
    func ensureLoaded(_ id: ExpressiveEngineID, completion: @escaping (Result<Void, Error>) -> Void) {
        cancelIdleRelease()
        if loadedID == id, loadState(id) == .ready, synth != nil { return completion(.success(())) }
        if loadedID == id, loadState(id) == .loading {
            loadWaiters.append(completion)
            return
        }
        guard !crashDisabled else { return completion(.failure(ExpressiveError.disabled)) }
        guard Self.supported(id) else { return completion(.failure(ExpressiveEngineError.unsupportedOS(id.title))) }
        guard isInstalled(id) else { return completion(.failure(ExpressiveEngineError.modelNotInstalled(id.title))) }
        guard let engine = ExpressiveEngines.make(id) else { return completion(.failure(ExpressiveEngineError.unsupportedOS(id.title))) }
        if loadedID != nil { unload(reason: "switching engine") }
        loadedID = id
        synth = engine
        loadStates[id] = .loading
        loadWaiters.append(completion)
        let cold = !loadedThisLaunch.contains(id)
        let sentinel = self.sentinel
        let context = "load \(id.rawValue) \(ProcessInfo.processInfo.operatingSystemVersionString)"
        ExpressiveEngines.setOfflineMode(true)
        Task.detached(priority: .userInitiated) { [weak self] in
            sentinel.begin(context)
            let result: Result<Double, Error>
            do { result = .success(try await engine.load()) } catch { result = .failure(error) }
            sentinel.end(success: (try? result.get()) != nil)
            DispatchQueue.main.async {
                guard let self, self.loadedID == id else { return }
                let waiters = self.loadWaiters
                self.loadWaiters = []
                switch result {
                case .success(let ms):
                    self.loadStates[id] = .ready
                    self.lastLoad[id] = (ms: ms, cold: cold)
                    self.loadedThisLaunch.insert(id)
                    waiters.forEach { $0(.success(())) }
                case .failure(let error):
                    self.loadStates[id] = .failed(error.localizedDescription)
                    self.synth = nil
                    self.loadedID = nil
                    self.log.error("expressive: \(id.rawValue, privacy: .public) failed to load: \(error.localizedDescription, privacy: .public)")
                    waiters.forEach { $0(.failure(error)) }
                }
            }
        }
    }

    func unload(reason: String) {
        guard let id = loadedID else { return }
        log.info("expressive: unloading \(id.rawValue, privacy: .public) (\(reason, privacy: .public))")
        let engine = synth
        synth = nil
        loadedID = nil
        loadStates[id] = .unloaded
        let waiters = loadWaiters
        loadWaiters = []
        waiters.forEach { $0(.failure(ExpressiveError.released(reason))) }
        Task.detached { await engine?.unload() }
    }

    func scheduleIdleRelease(after seconds: TimeInterval = 180) {
        cancelIdleRelease()
        let item = DispatchWorkItem { [weak self] in self?.unload(reason: "idle") }
        idleItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    }

    private func cancelIdleRelease() {
        idleItem?.cancel()
        idleItem = nil
    }

    private func memoryWarning() {
        guard loadedID != nil else { return }
        memoryWarnings += 1
        unload(reason: "memory warning")
    }

    private func leftForeground() {
        // GPU engines can't run in the background; the speed test is a foreground measurement.
        if speedTest?.running == true { cancelSpeedTest(reason: "stopped: the app left the foreground") }
    }

    // MARK: - Synthesis

    /// One line with the loaded engine, off the main thread; completion on main. Wrapped in the crash sentinel.
    func synthesize(_ line: ExpressiveLine, engine id: ExpressiveEngineID, seed: UInt64? = nil,
                    completion: @escaping (Result<ExpressiveAudio, Error>) -> Void) {
        guard loadedID == id, loadState(id) == .ready, let engine = synth else { return completion(.failure(ExpressiveEngineError.notLoaded)) }
        let sentinel = self.sentinel
        let context = "\(id.rawValue) \(line.text.count) chars \(ProcessInfo.processInfo.operatingSystemVersionString)"
        Task.detached(priority: .userInitiated) {
            sentinel.begin(context)
            let result: Result<ExpressiveAudio, Error>
            do { result = .success(try await engine.synthesize(line, seed: seed)) } catch { result = .failure(error) }
            sentinel.end(success: (try? result.get()) != nil)
            DispatchQueue.main.async { completion(result) }
        }
    }

    func resetCrashes() {
        sentinel.reset()
    }

    // MARK: - Speed test (render only, no playback)

    func startSpeedTest(engine id: ExpressiveEngineID, sample: String, lines: [ExpressiveLine]) {
        guard speedTest?.running != true, !lines.isEmpty else { return }
        NarrationController.shared.activateForSample() // pauses narration: one model at a time on the GPU/ANE
        var test = SpeedTest(engine: id, sample: sample, total: lines.count)
        test.memoryBeforeMB = VoiceLab.memoryFootprintMB()
        test.thermalStart = Self.thermalName()
        speedTest = test
        let wasLoaded = loadedID == id && loadState(id) == .ready
        ensureLoaded(id) { [weak self] result in
            guard let self, self.speedTest?.running == true else { return }
            switch result {
            case .failure(let error):
                self.finishSpeedTest(error: error.localizedDescription)
            case .success:
                if !wasLoaded, let l = self.lastLoad[id] {
                    self.speedTest?.loadMs = l.ms
                    self.speedTest?.coldLoad = l.cold
                }
                self.speedTest?.memoryLoadedMB = VoiceLab.memoryFootprintMB()
                self.speedTestLine(0, lines: lines)
            }
        }
    }

    private func speedTestLine(_ i: Int, lines: [ExpressiveLine]) {
        guard var test = speedTest, test.running else { return }
        guard i < lines.count else { return finishSpeedTest(error: nil) }
        synthesize(lines[i], engine: test.engine, seed: UInt64(42 + i)) { [weak self] result in
            guard let self, self.speedTest?.running == true else { return }
            switch result {
            case .failure(let error):
                test.rows.append(["i": i, "error": error.localizedDescription])
                self.speedTest = test
                if let e = error as? ExpressiveEngineError, case .notLoaded = e {
                    return self.finishSpeedTest(error: "the model was released (\(error.localizedDescription))")
                }
            case .success(let audio):
                test.rows.append(["i": i, "chars": lines[i].text.count, "synthMs": Self.r1(audio.synthMs), "firstAudioMs": Self.r1(audio.firstAudioMs),
                                  "audioMs": Self.r1(audio.durationMs), "x": Self.r2(audio.timesRealtime), "chunks": audio.chunks])
                test.synthMs += audio.synthMs
                test.audioMs += audio.durationMs
                test.xs.append(audio.timesRealtime)
                test.memoryMaxMB = max(test.memoryMaxMB, VoiceLab.memoryFootprintMB())
                self.speedTest = test
            }
            self.speedTestLine(i + 1, lines: lines)
        }
    }

    private func finishSpeedTest(error: String?) {
        guard speedTest != nil else { return }
        speedTest?.running = false
        speedTest?.error = error
        speedTest?.thermalEnd = Self.thermalName()
        scheduleIdleRelease()
    }

    func cancelSpeedTest(reason: String = "cancelled") {
        guard speedTest?.running == true else { return }
        finishSpeedTest(error: reason)
    }

    // MARK: - Snapshot (Voice Lab)

    func snapshot() -> [String: Any] {
        let free = store?.freeBytes()
        let engines: [[String: Any]] = ExpressiveEngineID.allCases.compactMap { id in
            guard let m = id.pinned, m.inApp else { return nil }
            var d: [String: Any] = [
                "id": id.rawValue, "title": id.title, "blurb": id.blurb, "license": m.license, "licenseUrl": m.licenseURL,
                "upstream": m.upstream, "repo": m.repo, "revision": m.revision, "bytes": m.totalBytes, "gpu": id.usesGPU,
                "supported": Self.supported(id), "installed": isInstalled(id), "bytesOnDisk": store?.bytesOnDisk(m) ?? 0,
            ]
            switch downloads[id] ?? .idle {
            case .idle: d["download"] = ["state": "idle"]
            case .downloading(let p):
                d["download"] = ["state": "downloading", "fraction": p.fraction, "filesDone": p.filesDone, "filesTotal": p.filesTotal,
                                 "bytesDone": p.bytesDone] as [String: Any]
            case .failed(let why): d["download"] = ["state": "failed", "error": why]
            }
            switch loadState(id) {
            case .unloaded: d["load"] = ["state": "unloaded"]
            case .loading: d["load"] = ["state": "loading"]
            case .ready: d["load"] = ["state": "ready"]
            case .failed(let why): d["load"] = ["state": "failed", "error": why]
            }
            if let l = lastLoad[id] { d["lastLoadMs"] = Self.r1(l.ms); d["lastLoadCold"] = l.cold }
            return d
        }
        let crash = sentinel.current
        var out: [String: Any] = [
            "available": store != nil,
            "engines": engines,
            "freeMB": free.map { Int($0 / 1_048_576) } ?? NSNull(),
            "memoryWarnings": memoryWarnings,
            "crashes": ["total": crash.total, "consecutive": crash.consecutive, "disabled": crash.disabled,
                        "lastContext": crash.lastContext ?? NSNull(),
                        "lastAt": crash.lastCrashAt.map { ISO8601DateFormatter().string(from: $0) } ?? NSNull()] as [String: Any],
            "device": [
                "thermal": Self.thermalName(),
                "memoryMB": Self.r1(VoiceLab.memoryFootprintMB()),
                "availableMB": Self.r1(Double(os_proc_available_memory()) / 1_048_576),
                "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
                "os": ProcessInfo.processInfo.operatingSystemVersionString,
            ] as [String: Any],
            "kokoro": KokoroService.shared.statusText,
        ]
        if let t = speedTest {
            let sorted = t.xs.sorted()
            func pct(_ p: Double) -> Double { sorted.isEmpty ? 0 : sorted[Int((Double(sorted.count - 1) * p).rounded())] }
            let firstRow = t.rows.first { $0["firstAudioMs"] != nil }
            out["speedTest"] = [
                "engine": t.engine.rawValue, "title": t.engine.title, "sample": t.sample, "running": t.running, "done": t.rows.count, "total": t.total,
                "loadMs": t.loadMs.map { Self.r1($0) } ?? NSNull(), "coldLoad": t.coldLoad,
                "firstAudioMs": firstRow?["firstAudioMs"] ?? NSNull(),
                "aggregateX": t.synthMs > 0 ? Self.r2(t.audioMs / t.synthMs) : 0, "p50X": Self.r2(pct(0.5)), "p10X": Self.r2(pct(0.1)),
                "audioSeconds": Self.r1(t.audioMs / 1000), "rows": t.rows,
                "memoryMB": ["before": Self.r1(t.memoryBeforeMB), "loaded": Self.r1(t.memoryLoadedMB), "max": Self.r1(t.memoryMaxMB)],
                "thermal": ["start": t.thermalStart, "end": t.thermalEnd.isEmpty ? Self.thermalName() : t.thermalEnd],
                "error": t.error ?? NSNull(),
            ] as [String: Any]
        }
        return out
    }

    static func thermalName() -> String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }

    static func r1(_ x: Double) -> Double { (x * 10).rounded() / 10 }
    static func r2(_ x: Double) -> Double { (x * 100).rounded() / 100 }
}

enum ExpressiveError: Error, LocalizedError {
    case disabled
    case released(String)

    var errorDescription: String? {
        switch self {
        case .disabled: return "Experimental engines were turned off after crashing twice. Turn them back on in the Voice Lab."
        case .released(let why): return "The model was released (\(why))."
        }
    }
}
