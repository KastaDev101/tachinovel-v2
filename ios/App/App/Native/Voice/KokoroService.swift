//
//  KokoroService.swift — the app's handle on the bundled Kokoro model (main thread).
//
//  - Finds the model in the app bundle (KokoroModels/, see tools/fetch-voices.ts) and owns the shared
//    KokoroRuntime (HDVoiceKokoro).
//  - Load / release with a main-thread status mirror that HybridSpeechEngine and the plugin read
//    synchronously; status changes are posted as `statusChanged`.
//  - Crash containment around every synthesis call (CrashSentinel): Core ML on iOS 26.4+ can crash inside
//    Apple's BNNS runtime; two crashes in a row turn Kokoro off until the user turns it back on.
//  - Memory pressure releases the model (the Apple voice covers), reloaded later with back-off; an idle
//    model is released a few minutes after narration stops.
//  - Warm-up: the first launch of a build loads the model and renders one word in the background, so the
//    Neural Engine compile (tens of seconds, once per install/update) doesn't happen on the first Listen.
//

import AVFoundation
import Foundation
import HDVoiceCore
import HDVoiceKokoro
import os
import UIKit

final class KokoroService {
    static let shared = KokoroService()
    static let statusChanged = Notification.Name("tachinovel.kokoroStatusChanged")

    enum Status: Equatable {
        case unloaded
        case loading
        case ready
        /// Missing from the bundle, failed to load, turned off after crashes, or released under memory pressure.
        case unavailable(String)
    }

    private(set) var status: Status = .unloaded {
        didSet { if status != oldValue { NotificationCenter.default.post(name: Self.statusChanged, object: nil) } }
    }
    let modelsDirectory: URL?
    let runtime: KokoroRuntime?
    let sentinel: CrashSentinel
    /// Per-sentence numbers for the Voice Lab.
    var stats = SynthesisStats()
    private(set) var lastLoadMs: Double?
    private(set) var lastLoadCold = false
    private(set) var lastError: String?
    private(set) var memoryReleases = 0
    private var backoff = ReloadBackoff()
    private var reloadItem: DispatchWorkItem?
    private var idleItem: DispatchWorkItem?
    private var releasedForMemory = false
    private let log = Logger(subsystem: "app.tachinovel", category: "voice")

    /// model-info.json written by tools/fetch-voices.ts (revision, voices, size).
    let modelInfo: [String: Any]

    private init() {
        let dir = Bundle.main.url(forResource: "KokoroModels", withExtension: nil)
        // TODO(asset packs): an App Store build may deliver the model as an Apple-hosted Background Assets
        // pack instead of bundling it (docs/tts-v2.md §4). It would live under Application Support; resolve
        // that location here (falling back to the bundle) and pass it to KokoroRuntime. Not built now.
        modelsDirectory = dir
        runtime = dir.map { KokoroRuntime(modelsDirectory: $0) }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        sentinel = CrashSentinel(directory: support.appendingPathComponent("TachiNovel/voice", isDirectory: true))
        if let dir, let data = try? Data(contentsOf: dir.appendingPathComponent("model-info.json")),
           let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            modelInfo = info
        } else {
            modelInfo = [:]
        }
    }

    /// Call once at launch (AppDelegate).
    func start() {
        if sentinel.checkAtLaunch() {
            log.error("voice: the previous run crashed during Kokoro synthesis (\(self.sentinel.current.lastContext ?? "", privacy: .public))")
        }
        if runtime == nil { status = .unavailable("Kokoro isn't included in this build") }
        else if sentinel.current.disabled { status = .unavailable("Turned off after crashing twice") }
        NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
            self?.memoryWarning()
        }
        scheduleWarmUp()
    }

    var isBundled: Bool { runtime != nil }
    var crashDisabled: Bool { sentinel.current.disabled }

    /// Kokoro may be used right now (enabled, bundled, not turned off after crashes).
    var usable: Bool {
        runtime != nil && VoiceSettings.shared.prefs.kokoroEnabled && !sentinel.current.disabled
    }

    var route: KokoroRoute { KokoroRoute.from(VoiceSettings.shared.prefs.route) }

    // MARK: - Load / release

    /// Start loading if needed. Completion on main with the resulting status.
    func ensureLoaded(_ completion: ((Status) -> Void)? = nil) {
        cancelIdleRelease()
        guard let runtime, usable else {
            if runtime != nil, !usable, status != .loading { status = sentinel.current.disabled ? .unavailable("Turned off after crashing twice") : .unavailable("Kokoro is turned off") }
            completion?(status)
            return
        }
        if status == .ready || releasedForMemory {
            completion?(status)
            return
        }
        let wasLoading = status == .loading
        status = .loading
        let route = self.route
        Task.detached(priority: .userInitiated) {
            let failure: String?
            do {
                try await runtime.load(route: route)
                failure = nil
            } catch {
                failure = error.localizedDescription
            }
            let load = await runtime.lastLoad
            DispatchQueue.main.async {
                if let failure {
                    self.lastError = failure
                    self.status = .unavailable(failure)
                    self.log.error("voice: Kokoro failed to load: \(failure, privacy: .public)")
                } else {
                    if !wasLoading, let load {
                        self.lastLoadMs = load.ms
                        self.lastLoadCold = load.first
                        self.stats.recordLoad(ms: load.ms, cold: load.first)
                    }
                    self.status = .ready
                }
                completion?(self.status)
            }
        }
    }

    /// Settings changed (route, enabled, crash reset): drop the loaded model so the next use reloads.
    func settingsChanged() {
        guard let runtime else { return }
        Task.detached { await runtime.release() }
        releasedForMemory = false
        status = usable ? .unloaded : .unavailable(sentinel.current.disabled ? "Turned off after crashing twice" : "Kokoro is turned off")
    }

    /// The user turned Kokoro back on after it was disabled by crashes.
    func resetCrashes() {
        sentinel.reset()
        settingsChanged()
    }

    /// Narration stopped: keep the model a few minutes (a quick resume is instant), then free the memory.
    func scheduleIdleRelease(after seconds: TimeInterval = 300) {
        cancelIdleRelease()
        let item = DispatchWorkItem { [weak self] in self?.releaseNow(reason: "idle") }
        idleItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    }

    func cancelIdleRelease() {
        idleItem?.cancel()
        idleItem = nil
    }

    private func releaseNow(reason: String) {
        dropWarm()
        guard let runtime, status == .ready || status == .loading else { return }
        log.info("voice: releasing the Kokoro model (\(reason, privacy: .public))")
        Task.detached { await runtime.release() }
        status = .unloaded
    }

    private func memoryWarning() {
        guard runtime != nil, status == .ready || status == .loading else { return }
        memoryReleases += 1
        releaseNow(reason: "memory warning")
        releasedForMemory = true
        status = .unavailable("Released under memory pressure")
        // Reload later (only if something still wants Kokoro then), backing off if it keeps happening.
        let delay = backoff.nextDelay()
        reloadItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.releasedForMemory = false
            self.status = .unloaded
            if NarrationController.shared.wantsKokoro { self.ensureLoaded() }
        }
        reloadItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    // MARK: - Synthesis

    // MARK: - Warm sentences (the next chapter's first ones, rendered while this chapter ends)

    private var warm: [String: KokoroAudio] = [:]
    private var warmOrder: [String] = []
    private var warming = false

    private static func warmKey(text: String, runs: [SpeechRun]?, voice: String, speed: Float) -> String {
        let r = (runs ?? []).map { run -> String in
            switch run {
            case .text(let t): return "t:\(t)"
            case .phonemes(let p): return "p:\(p)"
            }
        }
        return "\(voice)|\(speed)|\(text)|\(r.joined(separator: "\u{1F}"))"
    }

    /// Render a sentence ahead into a small cache that `synthesize` answers from (no-op while another
    /// warm-up runs, or before the model is ready). Completion on main.
    func prewarm(text: String, runs: [SpeechRun]?, voice: String, speed: Float, completion: @escaping () -> Void) {
        let key = Self.warmKey(text: text, runs: runs, voice: voice, speed: speed)
        guard warm[key] == nil, !warming, status == .ready else { return completion() }
        warming = true
        render(text: text, runs: runs, voice: voice, speed: speed) { result in
            self.warming = false
            if case .success(let audio) = result {
                self.warm[key] = audio
                self.warmOrder.append(key)
                while self.warmOrder.count > 4 { self.warm[self.warmOrder.removeFirst()] = nil }
            }
            completion()
        }
    }

    private func dropWarm() {
        warm.removeAll()
        warmOrder.removeAll()
    }

    /// One sentence, off the main thread; the result is delivered on main. Wrapped in the crash sentinel.
    /// Sentences rendered ahead by `prewarm` come back at once.
    func synthesize(text: String, runs: [SpeechRun]?, voice: String, speed: Float, completion: @escaping (Result<KokoroAudio, Error>) -> Void) {
        let key = Self.warmKey(text: text, runs: runs, voice: voice, speed: speed)
        if let hit = warm.removeValue(forKey: key) {
            warmOrder.removeAll { $0 == key }
            return DispatchQueue.main.async { completion(.success(hit)) }
        }
        render(text: text, runs: runs, voice: voice, speed: speed, completion: completion)
    }

    /// Narrator mode: a sentence read in parts by different voices (nil voice = `voice`), joined with a short
    /// gap. Fails if a part fails (the engine then reads the whole sentence with the fallback). Completion on main.
    func synthesize(parts: [NarratorPart], voice: String, speed: Float, completion: @escaping (Result<KokoroAudio, Error>) -> Void) {
        var collected: [[Float]] = []
        var synthMs = 0.0
        var sampleRate = 24_000
        func step(_ i: Int) {
            guard i < parts.count else {
                let gap = NarratorPlan.partGap / Double(max(0.5, speed))
                let joined = PCM.joinParts(collected, sampleRate: sampleRate, gap: gap)
                return completion(.success(KokoroAudio(samples: joined, sampleRate: sampleRate, synthMs: synthMs)))
            }
            let part = parts[i]
            synthesize(text: part.text, runs: part.runs, voice: part.voice ?? voice, speed: speed) { result in
                switch result {
                case .failure(let error):
                    completion(.failure(error))
                case .success(let audio):
                    collected.append(audio.samples)
                    synthMs += audio.synthMs
                    sampleRate = audio.sampleRate
                    step(i + 1)
                }
            }
        }
        step(0)
    }

    private func render(text: String, runs: [SpeechRun]?, voice: String, speed: Float, completion: @escaping (Result<KokoroAudio, Error>) -> Void) {
        guard let runtime else { return completion(.failure(KokoroRuntimeError.notLoaded)) }
        let sentinel = self.sentinel
        let context = "\(voice) \(route.rawValue) \(text.count) chars \(ProcessInfo.processInfo.operatingSystemVersionString)"
        Task.detached(priority: .userInitiated) {
            sentinel.begin(context)
            let result: Result<KokoroAudio, Error>
            do { result = .success(try await runtime.synthesize(text: text, runs: runs, voice: voice, speed: speed)) } catch { result = .failure(error) }
            if case .success = result { sentinel.end(success: true) } else { sentinel.end(success: false) }
            DispatchQueue.main.async {
                if case .success = result { self.backoff.reset() }
                completion(result)
            }
        }
    }

    // MARK: - Samples

    private var samplePlayer: AVAudioPlayer?

    /// Speak a short sample with a Kokoro voice (Settings › Voices ▶, pronunciation test with `runs`).
    /// Completion: ms until it started, or an error.
    func playSample(voice: String, text: String, runs: [SpeechRun]? = nil, completion: @escaping (Result<Double, Error>) -> Void) {
        let t0 = Date()
        ensureLoaded { status in
            guard status == .ready else {
                return completion(.failure(KokoroRuntimeError.modelMissing(self.statusText)))
            }
            self.synthesize(text: text, runs: runs, voice: voice, speed: 1) { result in
                switch result {
                case .failure(let e): completion(.failure(e))
                case .success(let audio):
                    do {
                        NarrationController.shared.activateForSample()
                        let p = try AVAudioPlayer(data: WAV.pcm16(audio.samples, sampleRate: audio.sampleRate))
                        self.samplePlayer = p
                        p.play()
                        completion(.success(Date().timeIntervalSince(t0) * 1000))
                    } catch {
                        completion(.failure(error))
                    }
                }
            }
        }
    }

    func stopSample() {
        samplePlayer?.stop()
        samplePlayer = nil
    }

    var statusText: String {
        switch status {
        case .unloaded: return "not loaded"
        case .loading: return "loading"
        case .ready: return "ready"
        case .unavailable(let why): return why
        }
    }

    // MARK: - Placement (Voice Lab)

    /// Where Core ML runs each stage on this device with the current route (MLComputePlan), last result.
    private(set) var lastPlacement: [StagePlacement] = []

    func analyzePlacement(completion: @escaping ([StagePlacement]) -> Void) {
        guard let dir = modelsDirectory else { return completion([]) }
        let route = self.route
        Task.detached(priority: .utility) {
            let result = await KokoroPlacement.analyze(modelsDirectory: dir, route: route)
            DispatchQueue.main.async {
                self.lastPlacement = result
                completion(result)
            }
        }
    }

    // MARK: - Warm-up

    private func scheduleWarmUp() {
        // The simulator self-test warms the model itself (and must not compete with the first boot). The UI
        // tests (TACHI_UITEST_BACKUP) drive the UI on the simulator's CPU, where the one-time Core ML compile
        // would compete with every tap; they don't measure Kokoro.
        let uiTest = ProcessInfo.processInfo.environment["TACHI_UITEST_BACKUP"].map { !$0.isEmpty } ?? false
        guard usable, !NarrationSelfTest.isActive, !uiTest else { return }
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        let key = "tachinovel.kokoroWarm.\(build)"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        // After the UI is up and the core has booted; low priority, the Apple voice covers if Listen comes first.
        // Load only (Core ML compiles the stages for the Neural Engine here, the slow part): no synthesis,
        // so the known iOS 26 Core ML crash can never hit right after launch, only while listening.
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
            guard self.usable, self.status == .unloaded else { return }
            self.ensureLoaded { status in
                guard status == .ready else { return }
                UserDefaults.standard.set(true, forKey: key)
                // Don't hold the model for nothing: release unless narration started meanwhile.
                if !NarrationController.shared.wantsKokoro { self.scheduleIdleRelease(after: 30) }
            }
        }
    }
}
