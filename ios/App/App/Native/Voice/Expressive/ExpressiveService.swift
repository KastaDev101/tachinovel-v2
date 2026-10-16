//
//  ExpressiveService.swift — Nephis's voice (Pocket TTS, her flow engine; docs/expressive-tts.md).
//
//  The app's handle on the ExpressiveVoice package (main thread, like KokoroService):
//  - Model files: Kyutai's released Pocket TTS, downloaded on demand (More › Voices › Download Her Voice, Developer ›
//    Voice Models: Wi-Fi only, pinned revision + SHA-256 per file, ModelStore), kept out of backups, deletable; or her
//    trained model from an installed Nephis model pack (NephisModelPack). Never bundled.
//  - One engine loaded at a time; unloaded on a memory warning, after 3 minutes idle, or when it reloads (a new pack).
//  - Memory (crash plan 2026-10-12: build 321 was closed by iOS for memory during the Voice test): a release really
//    frees (the next load waits until the released engine has let go of its models and any load of it still running
//    has ended: `teardown`; a load released while it waited never starts); after a memory warning no expressive model
//    loads for a while (`memoryHold`: 60 s, doubling until she has read 5 minutes without one, as Kokoro does) and
//    Kokoro or the Apple voice reads meanwhile; Nephis doesn't load with less than ~700 MB free (her studio's models
//    load behind hers with their own check), which starts the same wait; the studio speed test runs alone
//    (`clearForStudioTest`) and she is warmed again after it.
//  - Crash containment: a CrashSentinel of its own (not Kokoro's), judged with the run journal (VoiceRun): only a
//    real crash of her model counts (her call in flight while the app was in use, no update, swipe-away or memory
//    kill). Two in a row switch Nephis off until "Turn Nephis back on" (Settings ›
//    Voices, the Voice test) or a new build of the app; every end with her call in flight is kept in plain words.
//  - Speed test: renders a sample without playing it and records load (cold/warm), time to first audio,
//    × real time per line, memory and thermal state.
//  Listen reads with her through HybridSpeechEngine (synthesizeFlow); Developer › Voice Models plays samples through
//  ExpressiveSpeechEngine, which falls back to Kokoro whenever she can't keep up.
//

import Darwin
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
    /// The loaded engine is Nephis's flow engine: calls must come in reading order (HybridSpeechEngine).
    private(set) var usesFlow = false
    private(set) var loadStates: [ExpressiveEngineID: LoadState] = [:]
    private(set) var lastLoad: [ExpressiveEngineID: (ms: Double, cold: Bool)] = [:]
    private var loadedThisLaunch: Set<ExpressiveEngineID> = []
    private var loadWaiters: [(Result<Void, Error>) -> Void] = []
    private var idleItem: DispatchWorkItem?
    private(set) var memoryWarnings = 0
    /// After a memory warning (or a load refused for lack of memory) no expressive model loads for a while: 60 s,
    /// doubling when it happens again (KokoroService's releasedForMemory + ReloadBackoff). `reloadItem` ends the wait.
    private var memoryHold = MemoryHold()
    private var reloadItem: DispatchWorkItem?
    /// The studio speed test runs alone: no expressive model loads meanwhile.
    private(set) var studioTestRunning = false
    /// The studio speed test's work while it runs (main thread), so the Voice test's Stop can cancel it
    /// (ExpressiveVoice.studioTestStop); `studioTestStopAsked`: Stop came before the work started (while the other
    /// models were still being released), so it is cancelled as soon as it starts.
    var studioTestTask: Task<Void, Never>?
    var studioTestStopAsked = false
    /// The engine released last, still letting go of its models (its load and calls ending): the next load waits for it.
    private var teardown: Task<Void, Never>?
    /// The load running (or done) for the engine loaded now: a release waits for it to end before freeing what it made
    /// (engines other than Nephis's can't stop a load midway).
    private var loadTask: Task<Void, Never>?
    /// Posted (main) when an expressive model may be used again: the memory wait ended, the studio test ended, a reload
    /// after the wait or her warm-up load finished (HybridSpeechEngine picks her up again).
    static let statusChanged = Notification.Name("tachinovel.expressiveStatusChanged")
    private(set) var speedTest: SpeedTest?
    private var speedTask: Task<Void, Never>?
    private let log = Logger(subsystem: "app.tachinovel", category: "voice-expressive")

    /// The Narrator voice for Pocket TTS (BuiltInVoices/pocket/), checked once (size, shape, sha256).
    /// Nephis's flow engine assets: her clip, her tense clip, Pocket TTS's speaker projection. nil = not shipped or
    /// not valid (she then reads with the plain Pocket engine).
    /// From an installed Nephis model pack (NephisModelPack: her trained model + her voice files for it) when there
    /// is one, else the shipped files with Kyutai's model. Cached; `reloadNephisModel()` drops it.
    var nephisFlowAssets: NephisFlowSynth.Assets? {
        if let cached = nephisFlowAssetsCache { return cached }
        let a = loadNephisFlowAssets()
        nephisFlowAssetsCache = .some(a)
        return a
    }
    private var nephisFlowAssetsCache: NephisFlowSynth.Assets??
    private func loadNephisFlowAssets() -> NephisFlowSynth.Assets? {
        let pack = NephisModelPack.voicesDirectory
        guard let dir = pack ?? Bundle.main.url(forResource: "BuiltInVoices", withExtension: nil),
              let calm = try? PocketVoice.load(builtInVoices: dir, name: PocketVoice.nephisName),
              let data = try? Data(contentsOf: dir.appendingPathComponent("\(PocketVoice.folder)/speaker-projection.bin")),
              let projection = NephisFlow.Projection(data: data) else {
            self.log.error("expressive: Nephis flow assets missing or invalid; plain Pocket engine")
            return nil
        }
        var moods: [String: PocketVoice] = [:]
        for mood in PocketVoice.nephisMoods {
            if let v = try? PocketVoice.load(builtInVoices: dir, name: "nephis-\(mood)") { moods[mood] = v }
        }
        if pack != nil { log.info("expressive: Nephis reads with her trained model pack (\(moods.count) moods)") }
        // The pack's chain settings (pack.json "chain": pauses, carry-over, her per-mood timing), tuned on the PC for
        // its model; anything it leaves out keeps the defaults.
        var chain = NephisFlow.Chain()
        if pack != nil, let c = NephisModelPack.info?["chain"], let d = try? JSONSerialization.data(withJSONObject: c),
           let decoded = try? JSONDecoder().decode(NephisFlow.Chain.self, from: d) {
            chain = decoded
        }
        return NephisFlowSynth.Assets(calm: calm, moods: moods, projection: projection,
                                      modelsDirectory: pack == nil ? nil : NephisModelPack.modelsDirectory, chain: chain,
                                      studioDirectory: pack == nil ? nil : NephisModelPack.studioDirectory,
                                      dewindDirectory: pack == nil ? nil : NephisModelPack.dewindDirectory,
                                      dialogue: loadNephisDialogue())
    }

    /// Her dialogue pack (pack role "dialogue", Developer › Voice Packs): its Pocket model folder, every style clip it
    /// carries (BuiltInVoices/pocket/*.pocketvoice, each checked like hers), its speaker projection and its chain. nil
    /// without one, or when its files don't pass: the narrator pack then reads everything, exactly as before.
    private func loadNephisDialogue() -> NephisFlowSynth.Dialogue? {
        guard let root = NephisModelPack.dialogueRoot else { return nil }
        let voices = root.appendingPathComponent("BuiltInVoices", isDirectory: true)
        guard let calm = try? PocketVoice.load(builtInVoices: voices, name: PocketVoice.nephisName),
              let data = try? Data(contentsOf: voices.appendingPathComponent("\(PocketVoice.folder)/speaker-projection.bin")),
              let projection = NephisFlow.Projection(data: data) else {
            log.error("expressive: Nephis dialogue pack files missing or invalid; the narrator pack reads the dialogue")
            return nil
        }
        var clips: [String: PocketVoice] = [:]
        let folder = voices.appendingPathComponent(PocketVoice.folder, isDirectory: true)
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [])
            .filter { $0.hasSuffix(".\(PocketVoice.fileExtension)") }.map { String($0.dropLast(PocketVoice.fileExtension.count + 1)) }
        // At most 40 clips (a pack carries ~20): each is checked against its manifest's sha256.
        for name in names.sorted().prefix(40) where name != PocketVoice.nephisName {
            do { clips[name] = try PocketVoice.load(builtInVoices: voices, name: name) } catch {
                log.error("expressive: dialogue clip \(name, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
        let info = NephisPackLibrary.info(in: root)
        var chain = NephisFlow.Chain()
        if let c = info?["chain"], let d = try? JSONSerialization.data(withJSONObject: c),
           let decoded = try? JSONDecoder().decode(NephisFlow.Chain.self, from: d) {
            chain = decoded
        }
        let name = (info?["name"] as? String) ?? "Dialogue pack"
        log.info("expressive: Nephis reads quoted dialogue with her dialogue pack \(name, privacy: .public) (\(clips.count) clips)")
        return NephisFlowSynth.Dialogue(name: name, modelsDirectory: root, calm: calm, clips: clips, projection: projection, chain: chain)
    }

    /// She has a dialogue pack (its assets loaded with hers): Listen sends the quote routing's hints with each call.
    var nephisDialogue: Bool { nephisFlowAssets?.dialogue != nil }

    /// Her EQ's top lift for the installed pack's decoder (nil: the shipped one).
    var nephisHighShelfDB: Double? { nephisFlowAssets?.chain.highShelfDB }
    /// Her EQ's gentler sibilance for the installed pack (nil: on).
    var nephisSoftSibilance: Bool? { nephisFlowAssets?.chain.softSibilance }

    /// A Nephis model pack was installed or removed, or her studio switched: forget her assets; a loaded Nephis engine
    /// reloads on next use.
    /// A Listen read keeps the rate it started at (SessionRate.forRead in HybridSpeechEngine.enqueue). When her reloaded
    /// engine will render at another rate (a pack with or without a studio, the studio switch), the read starts its
    /// sentence again at the new rate, as on a voice change (NarrationController.voiceSettingsChanged; its voiceKey
    /// carries the rate); otherwise every call at the other rate would be rejected and read again by Kokoro. A swap that
    /// leaves the rate as it was posts nothing, as before.
    func reloadNephisModel() {
        nephisFlowAssetsCache = nil
        studioBudgetState = nil
        if loadedID == .pocketTts, usesFlow { unload(reason: "new Nephis model") }
        if SessionRate.forRead(NarrationController.listenEngine()) != NarrationController.shared.speechEngine.sessionRate {
            NotificationCenter.default.post(name: VoiceSettings.changed, object: nil)
        }
    }
    /// Nephis (v2): her own file, one read for every line.
    lazy var pocketNephis: Result<PocketVoice, Error> = Result {
        guard let dir = Bundle.main.url(forResource: "BuiltInVoices", withExtension: nil) else {
            throw PocketVoice.Problem.missing("BuiltInVoices")
        }
        return try PocketVoice.load(builtInVoices: dir, name: PocketVoice.nephisName)
    }
    lazy var pocketNarrator: Result<PocketVoice, Error> = Result {
        guard let dir = Bundle.main.url(forResource: "BuiltInVoices", withExtension: nil) else {
            throw PocketVoice.Problem.missing("BuiltInVoices")
        }
        return try PocketVoice.narrator(builtInVoices: dir)
    }
    /// The Narrator's other reads by role: performed (dialogue, thoughts) and the moods. A missing or invalid file
    /// only means that read falls back (performed, then the Narrator).
    lazy var pocketReads: [String: PocketVoice] = {
        guard let dir = Bundle.main.url(forResource: "BuiltInVoices", withExtension: nil) else { return [:] }
        var out: [String: PocketVoice] = [:]
        for (role, file) in PocketVoice.reads {
            do { out[role] = try PocketVoice.load(builtInVoices: dir, name: file) } catch {
                self.log.error("expressive: pocket \(role, privacy: .public) voice: \(error.localizedDescription, privacy: .public)")
            }
        }
        return out
    }()
    /// The voice the loaded (or loading) engine was asked for (Pocket TTS: the shipped voice it reads with).
    private(set) var loadedVoiceRequest: String?
    private var loadingVoiceRequest: String?
    private var loadGeneration = 0

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let sentinel = CrashSentinel(directory: support.appendingPathComponent("TachiNovel/voice-expressive", isDirectory: true), name: "Nephis")
        self.sentinel = sentinel
        VoiceRun.shared.watch(sentinel)
        let check = sentinel.checkAtLaunch(VoiceRun.shared.journal)
        let modelStore = (try? ExpressiveEngines.modelsRoot()).map { ModelStore(root: $0) }
        store = modelStore
        if check.turnedBackOn { log.info("expressive: Nephis turned back on: a new build of the app") }
        if let note = check.note {
            // Her call was in flight when the last run ended: a crash of her model only if nothing else explains it.
            let line = RunEndWords.line(note, voice: "Nephis")
            if note.counted {
                log.error("expressive: \(line, privacy: .public) (\(note.context ?? "", privacy: .public))")
            } else {
                log.info("expressive: \(line, privacy: .public)")
            }
            VoiceRun.shared.postVoice(sentinel.offLine() ?? line, counted: note.counted, quiet: note.isQuiet)
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

    func isInstalled(_ id: ExpressiveEngineID) -> Bool {
        // Nephis with a model pack: the pack carries the whole Pocket model, so it counts without the download.
        if id == .pocketTts, VoiceSettings.shared.prefs.delivery.isNephis, NephisModelPack.modelsDirectory != nil { return true }
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
            let failure: String?
            do {
                try await store.install(model, wifiOnly: true) { p in
                    DispatchQueue.main.async { self?.downloads[id] = .downloading(p) }
                }
                failure = nil
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

    /// The voice `id` should load with now: the chosen shipped Pocket TTS voice (Narrator or Nephis); a change reloads
    /// the engine with it.
    /// For Nephis the key also names her narrator and dialogue packs and her studio switch (EngineLoadPlan.pocketRequest),
    /// so the same voice is reused and a real change reloads.
    private func voiceRequest(for id: ExpressiveEngineID) -> String? {
        switch id {
        case .pocketTts:
            let delivery = VoiceSettings.shared.prefs.delivery
            guard delivery.isNephis else { return delivery.pocketVoice }
            let library = NephisModelPack.library
            return EngineLoadPlan.pocketRequest(voice: delivery.pocketVoice, nephis: true, pack: library.activeID,
                                                dialogue: library.dialogueID, studio: NephisModelPack.studioDirectory != nil)
        }
    }

    /// Load `id` (unloading any other engine first) with the voice it should use. Completion on main.
    func ensureLoaded(_ id: ExpressiveEngineID, completion: @escaping (Result<Void, Error>) -> Void) {
        cancelIdleRelease()
        let request = voiceRequest(for: id)
        let ready = loadedID == id && loadState(id) == .ready && synth != nil
        let loading = loadedID == id && loadState(id) == .loading
        switch EngineLoadPlan.step(loadedReady: ready, loading: loading, loaded: loadedVoiceRequest,
                                   loadingRequest: loadingVoiceRequest, requested: request) {
        case .reuse:
            log.info("expressive: \(id.rawValue, privacy: .public) already loaded with this voice; reload skipped")
            return completion(.success(()))
        case .wait:
            loadWaiters.append(completion)
            return
        case .load(let reason):
            if ready || loading {
                log.notice("expressive: \(id.rawValue, privacy: .public) reload needed: \(reason, privacy: .public)")
                unload(reason: "switching voice")
            }
        }
        guard !crashDisabled else { return completion(.failure(ExpressiveError.disabled)) }
        // Resting after a memory warning, or the studio test running: fail at once, another voice reads meanwhile.
        if let block = loadBlock { return completion(.failure(block)) }
        guard isInstalled(id) else { return completion(.failure(ExpressiveEngineError.modelNotInstalled(id.title))) }
        // Pocket TTS reads with the Narrator voice; a voice file that fails its check is never used (Listen falls back).
        var pocketVoice: PocketVoice?
        let nephis = id == .pocketTts && VoiceSettings.shared.prefs.delivery.isNephis
        if id == .pocketTts {
            switch nephis ? pocketNephis : pocketNarrator {
            case .success(let v): pocketVoice = v
            case .failure(let error):
                log.error("expressive: pocket voice: \(error.localizedDescription, privacy: .public)")
                return completion(.failure(error))
            }
        }
        // Nephis reads as one continuous flow (NephisFlowSynth): carry-over, lead-ins, blended joins, best takes. Her
        // studio's models load in the background once she is up and go when memory runs low (it asks how much is free).
        // Her studio's load and every call it works on (speed, compute units, why it gave up or went off) go to the log
        // at notice level, so native.log in the Diagnostics folder keeps them (2026-10-13: a studio Voice test played
        // nothing and left no numbers).
        let flowAssets = nephis ? nephisFlowAssets : nil
        let studioLog = Logger(subsystem: "app.tachinovel", category: "voice-studio")
        // Her studio's speed is measured as it loads while nothing is saved for this pack (StudioBudget: a fresh pack's first
        // calls otherwise planned with a guess and skipped it, build 375).
        let pack = NephisModelPack.library.activeID
        let measured: (@Sendable (Double) -> Void)? = flowAssets?.studioDirectory != nil && Self.savedStudioSpeed(pack: pack) == nil
            ? { x in DispatchQueue.main.async { ExpressiveService.shared.studioMeasuredAtLoad(x, pack: pack) } } : nil
        let flow: (any ExpressiveSynthesizer)? = flowAssets.map {
            NephisFlowSynth(assets: $0, transcriber: NephisSpeech.transcriber(), freeMemoryMB: { ExpressiveService.freeMemoryMB() },
                            log: { studioLog.notice("\($0, privacy: .public)") }, studioMeasured: measured)
        }
        // What Nephis needs free to load (crash plan a4): Pocket's room; her studio's models load behind it, in the
        // background, with their own check (NephisFlowSynth.startStudioLoad).
        let need: NephisMemory.Need? = flowAssets == nil ? nil : .nephis
        let engine = flow ?? ExpressiveEngines.make(pocketVoice: pocketVoice, pocketReads: id == .pocketTts && !nephis ? pocketReads : [:])
        usesFlow = flow != nil
        if let flowSynth = flow as? NephisFlowSynth {
            // Word timings need speech recognition: ask once (the system prompt), then give it to the engine.
            NephisSpeech.requestAccess { ok in
                guard ok, let t = NephisSpeech.transcriber() else { return }
                Task { await flowSynth.setTranscriber(t) }
            }
        }
        if loadedID != nil { unload(reason: "switching engine") }
        loadedID = id
        synth = engine
        loadStates[id] = .loading
        loadingVoiceRequest = request
        loadGeneration += 1
        let generation = loadGeneration
        loadWaiters.append(completion)
        let cold = !loadedThisLaunch.contains(id)
        let sentinel = self.sentinel
        let voiceTag = request.map { " voice " + $0 } ?? ""
        let context = "load \(id.rawValue)\(voiceTag) \(ProcessInfo.processInfo.operatingSystemVersionString)"
        // The engine released before this one (a switch, a reload) first lets go of its models, and any load of it still
        // running ends: two never overlap.
        let released = teardown
        ExpressiveEngines.setOfflineMode(true)
        loadTask = Task.detached(priority: .userInitiated) { [weak self] in
            await released?.value
            // Released while it waited (the studio test, a memory warning, another voice): it never starts (crash plan a3).
            let current = await withCheckedContinuation { (go: CheckedContinuation<Bool, Never>) in
                DispatchQueue.main.async { go.resume(returning: self?.loadedID == id && self?.loadGeneration == generation) }
            }
            let result: Result<Double, Error>
            if !current {
                result = .failure(ExpressiveEngineError.released)
            } else if let need, let free = Self.freeMemoryMB(), NephisMemory.short(need, freeMB: free) {
                // Not enough memory left for her (crash plan a4): refused before anything loads; another voice reads.
                result = .failure(ExpressiveError.lowMemory(NephisMemory.refusal(need, freeMB: free)))
            } else {
                sentinel.begin(context)
                do { result = .success(try await engine.load()) } catch { result = .failure(error) }
                sentinel.end(success: (try? result.get()) != nil)
            }
            DispatchQueue.main.async {
                guard let self, self.loadedID == id, self.loadGeneration == generation else {
                    // Dropped while it loaded (crash plan a3): free what this load made now, not whenever the engine goes.
                    if case .success = result { Task.detached { await engine.unload() } }
                    return
                }
                let waiters = self.loadWaiters
                self.loadWaiters = []
                self.loadingVoiceRequest = nil
                switch result {
                case .success(let ms):
                    self.loadStates[id] = .ready
                    // What it loaded with: the next ensureLoaded with the same request reuses it (EngineLoadPlan).
                    self.loadedVoiceRequest = request
                    self.lastLoad[id] = (ms: ms, cold: cold)
                    self.loadedThisLaunch.insert(id)
                    waiters.forEach { $0(.success(())) }
                case .failure(ExpressiveError.lowMemory(let why)):
                    // Not a failure of her model: the same wait as after a memory warning, then she may load again
                    // (Settings and "Prepare for the drive" still count on her). Said in the Voice test report.
                    self.loadStates[id] = .unloaded
                    self.synth = nil
                    self.loadedID = nil
                    self.usesFlow = false
                    self.flowStats.memoryRefusals += 1
                    self.flowStats.lastMemoryRefusal = why
                    self.log.error("expressive: \(id.rawValue, privacy: .public) not loaded: \(why, privacy: .public)")
                    self.holdForMemory(id)
                    waiters.forEach { $0(.failure(ExpressiveError.lowMemory(why))) }
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
        usesFlow = false
        loadedID = nil
        loadStates[id] = .unloaded
        loadingVoiceRequest = nil
        loadedVoiceRequest = nil
        let waiters = loadWaiters
        loadWaiters = []
        waiters.forEach { $0(.failure(ExpressiveError.released(reason))) }
        // Her engine stops its load and calls and lets go of their models (crash plan a3). The other engines can't stop a
        // load: the one still running ends first, then what it installed goes too. The next load waits for all of it;
        // malloc then hands the freed pages back to iOS, as Kokoro's release does.
        let before = teardown
        let load = loadTask
        loadTask = nil
        teardown = Task.detached {
            if let flow = engine as? NephisFlowSynth { await flow.unloadAndWait() } else { await engine?.unload() }
            await load?.value
            await engine?.unload()
            _ = malloc_zone_pressure_relief(nil, 0)
            await before?.value
        }
    }

    /// Why no expressive model may load right now (the studio test running, the wait after a memory warning); nil when
    /// one may. ensureLoaded fails at once meanwhile, and Kokoro or the Apple voice reads.
    var loadBlock: ExpressiveError? {
        if studioTestRunning { return .busy }
        let left = memoryHold.remaining(at: Date())
        return left > 0 ? .resting(seconds: Int(left.rounded(.up))) : nil
    }

    /// Memory left before iOS closes the app (os_proc_available_memory), MB; nil where the system doesn't say (simulator).
    static func freeMemoryMB() -> Double? {
        let bytes = os_proc_available_memory()
        return bytes > 0 ? Double(bytes) / 1_048_576 : nil
    }

    /// `id` was released for memory (a warning, or a load refused for lack of it): no expressive model loads for a while
    /// (60 s, doubling), then it loads again if Listen still wants it and the read picks it up (statusChanged).
    private func holdForMemory(_ id: ExpressiveEngineID) {
        let wait = memoryHold.release(at: Date())
        log.info("expressive: \(id.rawValue, privacy: .public) released for memory; may load again in \(Int(wait)) s")
        reloadItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.reloadItem = nil
            self.memoryHold.lift()
            let notify = { NotificationCenter.default.post(name: Self.statusChanged, object: nil) }
            guard NarrationController.shared.wantsKokoro, NarrationController.listenEngine() == id, self.loadedID == nil else { return notify() }
            self.ensureLoaded(id) { _ in notify() }
        }
        reloadItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: item)
    }

    // MARK: - Studio speed test (runs alone: crash plan a1)

    /// Before the studio speed test: the speed test stops, any expressive model (Nephis) and Kokoro are released, and
    /// nothing loads them again until `studioTestEnded` (a Kokoro load asked for meanwhile waits for it; a Nephis-only
    /// read waits for her). `ready` (main) once their models are gone.
    func clearForStudioTest(_ ready: @escaping () -> Void) {
        studioTestRunning = true
        studioTestStopAsked = false
        cancelSpeedTest(reason: "stopped: the studio test")
        cancelIdleRelease()
        unload(reason: "studio test")
        let gone = teardown
        let done = MainBound(ready)
        KokoroService.shared.holdForStudioTest {
            Task.detached {
                await gone?.value
                DispatchQueue.main.async { done.value() }
            }
        }
    }

    /// After the studio test: Nephis loads again when she is Listen's voice (as at launch, so a read waiting for her and
    /// the listening test that follows start as Listen does, not cold), then Kokoro's loads asked for meanwhile; `done`
    /// (main) once she and her studio's models are up, or couldn't load.
    func studioTestEnded(_ done: @escaping () -> Void) {
        studioTestRunning = false
        studioTestTask = nil
        studioTestStopAsked = false
        warmNephis()
        NotificationCenter.default.post(name: Self.statusChanged, object: nil)
        whenSettled {
            KokoroService.shared.studioTestEnded()
            done()
        }
    }

    /// `done` (main) once the expressive load in progress and her studio's models loading behind it have ended (at once
    /// when nothing loads): the next big load (Kokoro's warm-up, the listening test) never overlaps them.
    func whenSettled(_ done: @escaping () -> Void) {
        let finish = MainBound(done)
        let settle: () -> Void = { [weak self] in
            guard let flow = self?.synth as? NephisFlowSynth else { return finish.value() }
            Task.detached {
                await flow.studioSettled()
                DispatchQueue.main.async { finish.value() }
            }
        }
        if let id = loadedID, loadState(id) == .loading { loadWaiters.append { _ in settle() } } else { settle() }
    }

    /// Nephis is the reader: load her model shortly after launch (the first load after an app update compiles it for
    /// this phone, which takes a while), so Listen starts with her voice instead of waiting. Released again after 3 idle
    /// minutes unless narration is using it by then.
    func warmNephis() {
        guard NarrationController.listenEngine() == .pocketTts, VoiceSettings.shared.prefs.delivery.isNephis, isInstalled(.pocketTts),
              !crashDisabled, loadedID == nil else { return }
        ensureLoaded(.pocketTts) { [weak self] result in
            // A read that waits for her without having asked for this load (after the studio test) picks her up.
            NotificationCenter.default.post(name: Self.statusChanged, object: nil)
            guard case .success = result, !NarrationController.shared.wantsKokoro else { return }
            self?.scheduleIdleRelease()
        }
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
        guard let id = loadedID else { return }
        memoryWarnings += 1
        // Not reloaded at once (Nephis was, and the app ran into iOS's limit again): wait, backing off (crash plan a4).
        // The wait starts before the release, so whoever waited for her load sees it (DrivePrep pauses, not fails).
        holdForMemory(id)
        unload(reason: "memory warning")
    }

    private func leftForeground() {
        // The speed test is a foreground measurement.
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

    /// Nephis's flow (Listen): `prepared` (on main) as soon as the call's latents are ready, so the next call can start
    /// generating while this one decodes; then `completion` (on main) with the audio. Calls must come in reading
    /// order and be prepared one at a time. `reported` (on main, before `completion`): the call's own report (the Voice
    /// speed test's stages).
    func synthesizeFlow(_ line: ExpressiveLine, prepared: @escaping () -> Void, reported: ((NephisFlowSynth.Report) -> Void)? = nil,
                        completion: @escaping (Result<ExpressiveAudio, Error>) -> Void) {
        guard loadedID == .pocketTts, loadState(.pocketTts) == .ready, let flow = synth as? NephisFlowSynth else {
            return completion(.failure(ExpressiveEngineError.notLoaded))
        }
        // Developer › Voice extras off: one plain take, no lead-in, no speech check, for every flow call (Listen, the Voice
        // speed test, audio downloads, the hand-off): they all pass here.
        var line = line
        NephisCallPlan.extras(&line, on: VoiceSettings.shared.prefs.delivery.extras)
        let call = line
        // Every call moves her read on: whoever made the last one knows it can go on from there (the hand-off's warm start).
        flowSequence += 1
        let sentinel = self.sentinel
        let context = "nephis \(call.text.count) chars \(ProcessInfo.processInfo.operatingSystemVersionString)"
        // Background priority while playback has plenty banked (ExpressiveLine.relaxed, RenderPacer.relaxed): the same
        // work on the efficient cores and clocks. The call's own tasks (generation, decode, studio, de-wind) inherit it.
        Task.detached(priority: call.relaxed == true ? TaskPriority.utility : TaskPriority.userInitiated) { [weak self] in
            sentinel.begin(context)
            let result: Result<ExpressiveAudio, Error>
            // This call's own report (the Voice test's log: studio used or why not, rate, mood, endings). Read from
            // `lastReport` afterwards, it could already be the next call's.
            let report: NephisFlowSynth.Report?
            do {
                let p = try await flow.prepare(call, seed: nil)
                DispatchQueue.main.async(execute: prepared)
                let decoded = try await flow.decodeReporting(p)
                result = .success(decoded.audio)
                report = decoded.report
            } catch {
                result = .failure(error)
                report = nil
            }
            sentinel.end(success: (try? result.get()) != nil)
            DispatchQueue.main.async {
                if let report {
                    self?.recordFlow(report)
                    reported?(report)
                }
                completion(result)
            }
        }
    }

    /// Nephis's flow in this session (Voice Lab report): what her calls cost, stage by stage.
    struct FlowStats {
        var calls = 0
        var takes = 0
        var leadIns = 0
        var listened = 0
        var audioMs = 0.0
        var totalMs = 0.0
        var renderMs = 0.0
        var analysisMs = 0.0
        var recognizeMs = 0.0
        var decodeMs = 0.0
        var last: NephisFlowSynth.Report?
        /// Voice test evidence for lines heard twice or cut short (HybridSpeechEngine counts them): calls that started
        /// her read afresh (each Listen starts one), calls that failed (their sentences are read again), sentences left
        /// without audio when a call's audio was cut into sentences (rendered again), and audio route changes that
        /// replayed the sentence playing from its start.
        var readRestarts = 0
        var failedCalls = 0
        var emptyPieces = 0
        var configReplays = 0
        /// Her studio, call by call (studio audit B7: which parts of a recording were her studio): calls in a studio
        /// read, those it rendered, why it skipped the others ("hurry", "heat", "failed", "empty"), the calls per sample
        /// rate and per mood, and the last `logLimit` calls one by one.
        var studioCalls = 0
        var studioUsed = 0
        var bypassReasons: [String: Int] = [:]
        var rates: [Int: Int] = [:]
        var moods: [String: Int] = [:]
        var log: [Call] = []
        /// How her pieces ended (A6): pieces read, those still above -40 dBFS when Pocket stopped (a hard cut), and
        /// the end guard's work in her studio's reads (endings it let fade out, latents it added, early end-of-speech
        /// signals it ignored; calls it was on for).
        var pieces = 0
        var piecesEndingAudible = 0
        var tailsExtended = 0
        var extraLatents = 0
        var earlyEos = 0
        var guardCalls = 0
        /// Loads of her model refused for lack of free memory (crash plan a4), and the last refusal in plain words.
        var memoryRefusals = 0
        var lastMemoryRefusal: String?
        /// Her studio's speed (2026-10-13: a studio Voice test played nothing): × real time of the last call it worked on
        /// and the slowest, the compute units its models were loaded with, and why it went off for the session (too slow).
        var studioLastX: Double?
        var studioSlowestX: Double?
        var studioUnits: String?
        var studioOff: String?
        /// Heat counters (heat batch 1): Mimi's latents decoded by the read's stream decoder, the analysis (scratch)
        /// decoder and the end guard's decoder; the de-wind cleaner's calls and time, split into its network's predictions,
        /// the network's inputs and outputs, and the signal processing; calls rendered at background priority.
        var streamLatents = 0
        var scratchLatents = 0
        var tailLatents = 0
        var dewindCalls = 0
        var dewindMs = 0.0
        var dewindPredictMs = 0.0
        var dewindIOMs = 0.0
        var dewindDSPMs = 0.0
        var relaxedCalls = 0
        /// The last call rendered at user-initiated priority (the extras rule: a relaxed call's pace says nothing).
        var lastUrgent: NephisFlowSynth.Report?
        /// Her dialogue pack (NephisDialogue.swift): calls with dialogue it read, its spans and pieces, the voice changes,
        /// its generation time, latents, characters and seconds of audio, its finishing time, the last level match, and why
        /// calls' dialogue read with the narrator pack instead ("loading", "memory").
        var dialogueCalls = 0
        var dialogueSpans = 0
        var dialoguePieces = 0
        var switches = 0
        var dialogueRenderMs = 0.0
        var dialogueLatents = 0
        var dialogueChars = 0
        var dialogueSeconds = 0.0
        var dialogueFinishMs = 0.0
        var dialogueMatchDB: Double?
        var dialogueNotes: [String: Int] = [:]

        static let logLimit = 400

        /// One call of the log: its number in this session, where it starts in her audio (seconds of her audio before
        /// it: roughly its place in the Voice test recording, give or take waits and other voices) and its report.
        struct Call {
            let n: Int
            let atMs: Double
            let report: NephisFlowSynth.Report
        }
    }

    private(set) var flowStats = FlowStats()
    /// Her flow calls made so far (main thread): a caller that made the last one can continue her read without a reset.
    private(set) var flowSequence = 0

    /// Her studio's speed for the active pack (StudioBudget: which Listen calls get the studio), kept over this app's life
    /// (a new read doesn't forget it) and saved per pack for the next launch (`studioSpeedKey`), which starts from it (half
    /// of it on a warm phone). Main thread; a pack change (reloadNephisModel) starts it afresh: from the pack's saved speed,
    /// else the speed measured as its studio loads, else a guess (25x with the fast phone vocoder, 8x otherwise).
    private var studioBudgetState: (pack: String?, budget: StudioBudget)?
    static let studioSpeedKey = "nephisStudioSpeedX"
    /// The speed measured as the active pack's studio loaded, this launch (the Voice speed test's report).
    private(set) var studioLoadX: (pack: String, x: Double)?

    /// The speed saved for `pack` in an earlier session (nil: none).
    static func savedStudioSpeed(pack: String?) -> Double? {
        guard let pack, let x = UserDefaults.standard.dictionary(forKey: studioSpeedKey)?[pack] as? Double, x.isFinite, x > 0 else { return nil }
        return x
    }

    /// Her studio's budget for the active pack (main thread).
    func studioBudget() -> StudioBudget {
        if let s = studioBudgetState { return s.budget }
        let pack = NephisModelPack.library.activeID
        let vocoder = NephisModelPack.studioDirectory.flatMap { try? NephisStudio.readConfig(in: $0) }?.vocoder_model
        let warm = ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.fair.rawValue
        let budget = StudioBudget(rememberedX: Self.savedStudioSpeed(pack: pack), fastVocoder: StudioBudget.isFastVocoder(vocoder), warm: warm)
        studioBudgetState = (pack, budget)
        return budget
    }

    /// A call her studio worked on, at `x` × real time: into the budget, and saved for the pack.
    private func recordStudioSpeed(_ x: Double) {
        var budget = studioBudget()
        budget.record(x)
        let pack = studioBudgetState?.pack
        studioBudgetState = (pack, budget)
        saveStudioSpeed(budget, pack: pack)
    }

    /// Her studio's speed measured as `pack`'s studio loaded (NephisFlowSynth, main thread): the budget starts from it,
    /// and it is saved, so the next launch starts from it without measuring again. Another pack active by now: ignored.
    func studioMeasuredAtLoad(_ x: Double, pack: String?) {
        guard let pack, pack == NephisModelPack.library.activeID else { return }
        var budget = studioBudget()
        guard studioBudgetState?.pack == pack else { return }
        budget.measuredAtLoad(x)
        studioBudgetState = (pack, budget)
        studioLoadX = (pack, x)
        saveStudioSpeed(budget, pack: pack)
    }

    private func saveStudioSpeed(_ budget: StudioBudget, pack: String?) {
        guard let pack, let measured = budget.measuredX else { return }
        var speeds = UserDefaults.standard.dictionary(forKey: Self.studioSpeedKey) ?? [:]
        speeds[pack] = measured
        UserDefaults.standard.set(speeds, forKey: Self.studioSpeedKey)
    }

    /// The speed StudioBudget plans with now and where it comes from, for the reports: {x, from, measuredAtLoadX}.
    func studioPlanJSON() -> [String: Any] {
        let b = studioBudget()
        let pack = studioBudgetState?.pack
        let load = studioLoadX.flatMap { $0.pack == pack ? Self.r2($0.x) : nil }
        return ["x": Self.r2(b.estimateX), "from": b.source.rawValue, "measuredAtLoadX": load ?? NSNull()]
    }

    func resetFlowStats() {
        flowStats = FlowStats()
    }

    /// One more of a Voice test counter (main thread, like recordFlow).
    func countEvidence(_ counter: WritableKeyPath<FlowStats, Int>) {
        flowStats[keyPath: counter] += 1
    }

    private func recordFlow(_ r: NephisFlowSynth.Report) {
        // Her model works again: once she has read 5 minutes since the last release for memory, the next one waits the
        // shortest time again (not on her first call after a reload: the wait could then never grow).
        memoryHold.worked(at: Date())
        flowStats.log.append(FlowStats.Call(n: flowStats.calls + 1, atMs: flowStats.audioMs, report: r))
        if flowStats.log.count > FlowStats.logLimit { flowStats.log.removeFirst(flowStats.log.count - FlowStats.logLimit) }
        // A call rendered at background priority runs slower on purpose: its studio speed says nothing about what the
        // phone can do, so it never lowers the speed StudioBudget plans with.
        if let x = r.studioX, !r.relaxed {
            flowStats.studioLastX = x
            flowStats.studioSlowestX = min(flowStats.studioSlowestX ?? x, x)
            recordStudioSpeed(x)
        }
        if let units = r.studioUnits { flowStats.studioUnits = units }
        if let off = r.studioOff { flowStats.studioOff = off }
        if r.studioRead {
            flowStats.studioCalls += 1
            if r.studioUsed {
                flowStats.studioUsed += 1
            } else {
                flowStats.bypassReasons[Self.reasonKey(r.bypassReason), default: 0] += 1
            }
        }
        flowStats.rates[r.sampleRate, default: 0] += 1
        flowStats.moods[r.mood, default: 0] += 1
        flowStats.pieces += r.pieces
        flowStats.piecesEndingAudible += r.piecesEndingAudible
        flowStats.tailsExtended += r.tailsExtended
        flowStats.extraLatents += r.extraLatents
        flowStats.earlyEos += r.earlyEos
        flowStats.guardCalls += r.endGuard ? 1 : 0
        flowStats.calls += 1
        flowStats.takes += r.takes
        flowStats.leadIns += r.leadIn ? 1 : 0
        flowStats.listened += r.listened ? 1 : 0
        flowStats.audioMs += r.audioMs
        flowStats.totalMs += r.totalMs
        flowStats.renderMs += r.renderMs
        flowStats.analysisMs += r.analysisMs
        flowStats.recognizeMs += r.recognizeMs
        flowStats.decodeMs += r.decodeMs
        flowStats.streamLatents += r.streamLatents
        flowStats.scratchLatents += r.scratchLatents
        flowStats.tailLatents += r.tailLatents
        flowStats.dewindCalls += r.dewindPasses > 0 ? 1 : 0
        flowStats.dewindMs += r.dewindMs
        flowStats.dewindPredictMs += r.dewindPredictMs
        flowStats.dewindIOMs += r.dewindIOMs
        flowStats.dewindDSPMs += r.dewindDSPMs
        flowStats.relaxedCalls += r.relaxed ? 1 : 0
        flowStats.dialogueCalls += r.dialogueSpans > 0 ? 1 : 0
        flowStats.dialogueSpans += r.dialogueSpans
        flowStats.dialoguePieces += r.dialoguePieces
        flowStats.switches += r.switches
        flowStats.dialogueRenderMs += r.dialogueRenderMs
        flowStats.dialogueLatents += r.dialogueLatents
        flowStats.dialogueChars += r.dialogueChars
        flowStats.dialogueSeconds += r.dialogueSeconds
        flowStats.dialogueFinishMs += r.dialogueFinishMs
        if let m = r.dialogueMatchDB { flowStats.dialogueMatchDB = m }
        if let note = r.dialogueNote { flowStats.dialogueNotes[Self.reasonKey(note), default: 0] += 1 }
        flowStats.last = r
        if !r.relaxed { flowStats.lastUrgent = r }
    }

    /// A studio bypass reason for counting, its word before any colon: "failed: <the error>" counts as "failed",
    /// "memory: 480 MB free" as "memory".
    private static func reasonKey(_ reason: String?) -> String {
        guard let reason else { return "unknown" }
        return String(reason.prefix { $0 != ":" })
    }

    /// Her studio on one call, in a word: her studio sound ("used"), Mimi's sound in a studio read ("bypassed", the
    /// reason says why), or a read without the studio ("off").
    private static func studioWord(_ r: NephisFlowSynth.Report) -> String {
        r.studioUsed ? "used" : r.studioRead ? "bypassed" : "off"
    }

    /// One call of the log, for the report.
    private static func callJSON(_ c: FlowStats.Call) -> [String: Any] {
        let r = c.report
        var out: [String: Any] = [
            "n": c.n, "atS": r1(c.atMs / 1000), "seconds": r1(r.audioMs / 1000), "engine": "nephis", "mood": r.mood, "rate": r.sampleRate,
            "studio": studioWord(r), "reason": r.bypassReason.map { String($0.prefix(160)) } ?? NSNull(),
            "pieces": r.pieces, "endedAudible": r.piecesEndingAudible, "tailsExtended": r.tailsExtended,
            // Her studio's work on the call (nil/0 when it never ran): × real time, where the time went, vocoder pieces.
            "studioX": r.studioX.map { r2($0) } ?? NSNull(), "blueprintMs": r1(r.studioBlueprintMs), "vocoderMs": r1(r.studioVocoderMs),
            "restMs": r1(r.studioRestMs), "studioPieces": r.studioPieces, "studioPiecesPlanned": r.studioPiecesPlanned,
            // Her mastering on the call (pack chain "master"): its preset and loudness gain; null when off.
            "master": r.masterPreset ?? NSNull(), "masterGainDB": r.masterGainDB.map { r1($0) } ?? NSNull(),
            // The pack's studio EQ on the call (chain "studioEQ"; her studio's calls only).
            "studioEQ": r.studioEQ,
            // The tuner's finishing on the call (chain "closeness", "breathAir", "room"; every call of hers when on).
            "closeness": r.closeness, "breathAir": r.breathAir, "room": r.room, "finishMs": r1(r.finishMs),
            // The de-wind cleaner on the call (chain "dewind"): its passes (0: it didn't run), time, and why not when asked.
            "dewind": r.dewindPasses, "dewindMs": r1(r.dewindMs), "dewindNote": r.dewindNote.map { String($0.prefix(160)) } ?? NSNull(),
        ]
        // Heat counters (heat batch 1): the call's work (takes, lead-in, recognition, Mimi's latents per decoder, the de-wind
        // cleaner's split) and whether it ran at background priority.
        out["takes"] = r.takes
        out["leadIn"] = r.leadIn
        out["listened"] = r.listened
        out["recognizeMs"] = r1(r.recognizeMs)
        out["latents"] = ["stream": r.streamLatents, "scratch": r.scratchLatents, "tail": r.tailLatents]
        out["dewindSplitMs"] = ["predict": r1(r.dewindPredictMs), "io": r1(r.dewindIOMs), "dsp": r1(r.dewindDSPMs)]
        out["relaxed"] = r.relaxed
        out["floorGuard"] = r.floorGuard
        // Her dialogue pack on the call: its spans, pieces and voice changes, its time and audio, its mood, clip, level
        // match and tempo; or why the narrator read the call's dialogue.
        if r.dialogueSpans > 0 || r.switches > 0 || r.dialogueNote != nil {
            out["dialogue"] = Self.dialogueJSON(r)
        }
        return out
    }

    /// One call's dialogue numbers for the report (callLog, the Voice speed test's calls).
    static func dialogueJSON(_ r: NephisFlowSynth.Report) -> [String: Any] {
        ["spans": r.dialogueSpans, "pieces": r.dialoguePieces, "switches": r.switches, "renderMs": r1(r.dialogueRenderMs),
         "latents": r.dialogueLatents, "chars": r.dialogueChars, "seconds": r2(r.dialogueSeconds), "finishMs": r1(r.dialogueFinishMs),
         "mood": r.dialogueMood ?? NSNull(), "clip": r.dialogueClip ?? NSNull(), "matchDB": r.dialogueMatchDB.map { r1($0) } ?? NSNull(),
         "tempo": r.dialogueTempo.map { r2($0) } ?? NSNull(), "note": r.dialogueNote.map { String($0.prefix(160)) } ?? NSNull()]
    }

    /// Her dialogue pack over the session: per voice, the pieces, generation time and audio; voice changes a minute of her
    /// audio; the last level match; why calls' dialogue read with the narrator instead.
    static func dialogueSummary(_ f: FlowStats) -> [String: Any] {
        let minutes = max(1e-9, f.audioMs / 60_000)
        let narratorPieces = max(0, f.pieces - f.dialoguePieces)
        return [
            "calls": f.dialogueCalls, "spans": f.dialogueSpans, "switches": f.switches,
            "switchesPerMinute": f.audioMs > 0 ? r2(Double(f.switches) / minutes) : 0,
            "narrator": ["pieces": narratorPieces, "renderMs": r1(max(0, f.renderMs - f.dialogueRenderMs)),
                         "seconds": r1(max(0, f.audioMs / 1000 - f.dialogueSeconds))] as [String: Any],
            "dialogue": ["pieces": f.dialoguePieces, "renderMs": r1(f.dialogueRenderMs), "seconds": r1(f.dialogueSeconds),
                         "latents": f.dialogueLatents, "chars": f.dialogueChars, "finishMs": r1(f.dialogueFinishMs),
                         // Seconds of her dialogue audio per second of its generation (× real time).
                         "renderX": f.dialogueRenderMs > 0 ? r2(f.dialogueSeconds * 1000 / f.dialogueRenderMs) as Any : NSNull() as Any] as [String: Any],
            "matchDB": f.dialogueMatchDB.map { r1($0) } ?? NSNull(), "narratorRead": f.dialogueNotes,
        ]
    }

    /// Her dialogue pack for the report: its name and role, whether its model is up (load time, free memory before and
    /// after it loaded) or why not. nil without one.
    func dialoguePackSnapshot(_ status: NephisFlowSynth.DialogueStatus?) -> Any {
        guard let root = NephisModelPack.dialogueRoot else { return NSNull() }
        let info = NephisPackLibrary.info(in: root)
        var out: [String: Any] = ["name": info?["name"] ?? NSNull(), "made": info?["made"] ?? NSNull(), "role": "dialogue",
                                  "weightsSha256": info?["weightsSha256"] ?? NSNull()]
        if let s = status {
            out["loaded"] = s.loaded
            out["loadMs"] = s.loadMs.map { Self.r1($0) } ?? NSNull()
            out["freeBeforeMB"] = s.freeBeforeMB.map { Self.r1($0) } ?? NSNull()
            out["freeAfterMB"] = s.freeAfterMB.map { Self.r1($0) } ?? NSNull()
            out["off"] = s.off ?? NSNull()
        }
        return out
    }

    /// Nephis's flow engine when it is the one loaded (main thread; its dialogue status is asked of it).
    var flowEngine: NephisFlowSynth? { synth as? NephisFlowSynth }

    /// "Turn Nephis back on": her model may be used again at once; a read going on picks her up from the sentence
    /// playing (NarrationController's voice key carries the switch), and her model loads now otherwise.
    func resetCrashes() {
        let wasOff = crashDisabled
        sentinel.reset()
        guard wasOff else { return }
        log.info("expressive: Nephis turned back on")
        NotificationCenter.default.post(name: VoiceSettings.changed, object: nil)
        warmNephis()
    }

    /// Her safety switch for the Voice test and Settings › Voices: switched off or not, why in plain words, and how
    /// the app last ended while her model worked.
    func crashSnapshot() -> [String: Any] {
        let crash = sentinel.current
        let lastEnd: Any = crash.lastEnd.map { note -> [String: Any] in
            ["kind": note.kind.rawValue, "counted": note.counted, "inFlight": note.inFlight,
             "at": note.at.map { ISO8601DateFormatter().string(from: $0) } ?? NSNull(), "line": sentinel.lastEndLine() ?? NSNull(),
             // What killed the process ("SIGABRT on the main thread"), when the app noted it.
             "signal": note.signal ?? NSNull()]
        } ?? NSNull()
        let app = VoiceRun.shared.journal.lastEnd
        return [
            "total": crash.total, "consecutive": crash.consecutive, "disabled": crash.disabled, "notCounted": crash.notCounted,
            "lastContext": crash.lastContext ?? NSNull(),
            "lastAt": crash.lastCrashAt.map { ISO8601DateFormatter().string(from: $0) } ?? NSNull(),
            "offLine": sentinel.offLine() ?? NSNull(),
            "lastEnd": lastEnd,
            // How the app's last run ended (whatever the voices did): one plain line.
            "appLastEnd": app.kind == .unknown ? NSNull() as Any : ["kind": app.kind.rawValue, "line": RunEndWords.line(app, voice: "Nephis")] as Any,
        ]
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
                "upstream": m.upstream, "repo": m.repo, "revision": m.revision, "bytes": m.totalBytes,
                "installed": isInstalled(id), "bytesOnDisk": store?.bytesOnDisk(m) ?? 0,
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
        // The active Nephis pack and its studio, for Settings › Voices › Voice test (one testing page).
        let pack: Any = NephisModelPack.active.map { root -> [String: Any] in
            let info = NephisPackLibrary.info(in: root)
            return ["name": info?["name"] ?? NSNull(), "made": info?["made"] ?? NSNull(),
                    "studio": FileManager.default.fileExists(atPath: root.appendingPathComponent("Models/nephis-studio/studio.json").path),
                    "studioOn": NephisModelPack.studioOn]
        } ?? NSNull()
        var out: [String: Any] = [
            "available": store != nil,
            "nephisPack": pack,
            "dialoguePack": dialoguePackSnapshot(nil),
            "engines": engines,
            "freeMB": free.map { Int($0 / 1_048_576) } ?? NSNull(),
            "memoryWarnings": memoryWarnings,
            "crashes": crashSnapshot(),
            "device": [
                "thermal": Self.thermalName(),
                "memoryMB": Self.r1(VoiceLab.memoryFootprintMB()),
                "availableMB": Self.r1(Double(os_proc_available_memory()) / 1_048_576),
                "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
                "os": ProcessInfo.processInfo.operatingSystemVersionString,
            ] as [String: Any],
            "kokoro": KokoroService.shared.statusText,
            "app": "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"))",
            "pocketVoice": VoiceSettings.shared.prefs.delivery.pocketVoice,
            "flow": flowSnapshot(),
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

    /// Nephis's flow numbers (NephisFlowSynth.Report summed): × real time end to end, and where the time goes.
    private func flowSnapshot() -> Any {
        let f = flowStats
        let evidence: [String: Any] = ["readRestarts": f.readRestarts, "failedCalls": f.failedCalls, "emptyPieces": f.emptyPieces,
                                       "configReplays": f.configReplays]
        // The rate Listen's read plays at: 24 kHz, or her studio's 44.1 kHz.
        let sessionRate = NarrationController.shared.speechEngine.sessionRate
        // Which text her pack reads: "app" (the app's spoken form) or "raw" (as written; pack.json chain "text"). The
        // loaded assets only: a report never loads them.
        let textForm = nephisFlowAssetsCache.flatMap { $0 }?.chain.text.rawValue ?? PocketTextForm.app.rawValue
        // Memory (crash plan a4): loads refused for lack of it (the last one in plain words), the wait after a memory
        // warning, the warnings this launch, and what is free now.
        let memory: [String: Any] = [
            "refusals": f.memoryRefusals, "lastRefusal": f.lastMemoryRefusal ?? NSNull(), "warnings": memoryWarnings,
            "restingSeconds": Int(memoryHold.remaining(at: Date()).rounded(.up)), "freeMB": Self.freeMemoryMB().map { Self.r1($0) } ?? NSNull(),
        ]
        // Her render pacing (heat plan 2026-10-13): cushion target, seconds generated vs played, duty cycle.
        let pacing = NarrationController.shared.speechEngine.pacingReport
        // Her pack's tone EQ after the studio (chain "eqAfterStudio"; loaded assets only, as textForm), and its own studio
        // EQ (chain "studioEQ").
        let eqAfterStudio = nephisFlowAssetsCache.flatMap { $0 }?.chain.eqAfterStudio ?? false
        let studioEQ = nephisFlowAssetsCache.flatMap { $0 }?.chain.studioEQ != nil
        guard f.calls > 0 else {
            return ["active": usesFlow, "calls": 0, "evidence": evidence, "sessionRate": sessionRate, "textForm": textForm, "memory": memory,
                    "pacing": pacing, "eqAfterStudio": eqAfterStudio, "studioEQ": studioEQ] as [String: Any]
        }
        let audio = max(1, f.audioMs)
        var out: [String: Any] = [
            "active": usesFlow, "calls": f.calls, "takes": f.takes, "leadIns": f.leadIns, "listened": f.listened,
            "evidence": evidence, "textForm": textForm, "memory": memory,
            "audioSeconds": Self.r1(f.audioMs / 1000),
            // Seconds of work per second of audio, stage by stage (render overlaps the analysis decode; the
            // stream decode overlaps the next call's render in Listen).
            "perAudioSecond": ["render": Self.r2(f.renderMs / audio), "analysis": Self.r2(f.analysisMs / audio),
                               "recognize": Self.r2(f.recognizeMs / audio), "decode": Self.r2(f.decodeMs / audio),
                               "call": Self.r2(f.totalMs / audio)],
            "renderX": f.renderMs > 0 ? Self.r2(f.audioMs / f.renderMs) : 0,
            "sessionRate": sessionRate, "pacing": pacing, "eqAfterStudio": eqAfterStudio, "studioEQ": studioEQ,
        ]
        // Her studio (B7): calls it rendered, why it skipped the others, the rates and moods, and every call in order
        // (`callLog`, to line up with the recording).
        // Its speed (× real time; Listen keeps it at StudioPace.minimum or gives up per call), the compute units its models
        // were loaded with, and why it went off for the session.
        let studio: [String: Any] = ["calls": f.studioCalls, "used": f.studioUsed, "bypassed": f.studioCalls - f.studioUsed,
                                     "reasons": f.bypassReasons, "lastX": f.studioLastX.map { Self.r2($0) } ?? NSNull(),
                                     "slowestX": f.studioSlowestX.map { Self.r2($0) } ?? NSNull(), "minimumX": StudioPace.minimum,
                                     "units": f.studioUnits ?? NSNull(), "off": f.studioOff ?? NSNull(),
                                     // The speed StudioBudget plans the next call with (which calls get the studio), and
                                     // where it comes from ("measured at load", "saved", "default", "measured on calls").
                                     "plannedX": Self.r2(studioBudget().estimateX), "plannedFrom": studioBudget().source.rawValue]
        out["studio"] = studio
        out["rates"] = Dictionary(uniqueKeysWithValues: f.rates.map { (String($0.key), $0.value) })
        out["moods"] = f.moods
        // How her pieces ended (A6): the goal is under 2 % still audible when Pocket stopped.
        let audiblePercent = f.pieces > 0 ? Self.r1(Double(f.piecesEndingAudible) * 100 / Double(f.pieces)) : 0
        let endings: [String: Any] = ["pieces": f.pieces, "endedAudible": f.piecesEndingAudible, "endedAudiblePercent": audiblePercent,
                                      "tailsExtended": f.tailsExtended, "extraLatents": f.extraLatents, "earlyEos": f.earlyEos,
                                      "guardCalls": f.guardCalls]
        out["endings"] = endings
        out["callLog"] = f.log.map(Self.callJSON)
        out["work"] = Self.workJSON(f)
        if NephisModelPack.dialogueRoot != nil { out["dialogue"] = Self.dialogueSummary(f) }
        // Breaks a listener heard in the last Listen session: waits for her, and sentences another voice read.
        if let s = NarrationController.shared.speechEngine.snapshot {
            out["listen"] = ["breaks": s.underruns, "breakSeconds": Self.r1(s.waitedSeconds), "otherVoiceSentences": s.appleSentences,
                             "fallbacks": Dictionary(uniqueKeysWithValues: s.fallbacks.map { ($0.key.rawValue, $0.value) })] as [String: Any]
        }
        if let r = f.last {
            var last: [String: Any] = ["takes": r.takes, "usable": r.usable, "leadIn": r.leadIn, "wordMatch": r.wordMatch.map { Self.r2($0) } ?? NSNull(),
                                       "jumpScore": r.jumpScore.map { Self.r2($0) } ?? NSNull(), "renderMs": Self.r1(r.renderMs),
                                       "analysisMs": Self.r1(r.analysisMs), "recognizeMs": Self.r1(r.recognizeMs), "decodeMs": Self.r1(r.decodeMs),
                                       "totalMs": Self.r1(r.totalMs), "audioMs": Self.r1(r.audioMs)]
            last["sampleRate"] = r.sampleRate
            last["mood"] = r.mood
            last["studio"] = Self.studioWord(r)
            if let reason = r.bypassReason { last["bypassReason"] = reason } else { last["bypassReason"] = NSNull() }
            out["last"] = last
        }
        return out
    }

    /// Where the work went in this session (heat batch 1): Mimi's latents per decoder against the latents played, the
    /// extras (takes, lead-ins, recognition), the de-wind cleaner's time split, and the calls at background priority.
    static func workJSON(_ f: FlowStats) -> [String: Any] {
        let played = max(1, f.streamLatents)
        let audio = max(1, f.audioMs)
        return [
            "calls": f.calls, "takes": f.takes, "leadIns": f.leadIns, "listened": f.listened, "recognizeMs": r1(f.recognizeMs),
            "latents": ["stream": f.streamLatents, "scratch": f.scratchLatents, "tail": f.tailLatents,
                        // Mimi's latents decoded per latent played (1.0 = only the sound played was decoded).
                        "perPlayed": r2(Double(f.streamLatents + f.scratchLatents + f.tailLatents) / Double(played))] as [String: Any],
            "dewind": ["calls": f.dewindCalls, "ms": r1(f.dewindMs), "predictMs": r1(f.dewindPredictMs), "ioMs": r1(f.dewindIOMs),
                       "dspMs": r1(f.dewindDSPMs), "perAudioSecond": r2(f.dewindMs / audio)] as [String: Any],
            "relaxedCalls": f.relaxedCalls,
        ]
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
    /// The studio speed test is running (it runs alone).
    case busy
    /// Released for memory a moment ago: it may load again in this many seconds.
    case resting(seconds: Int)
    /// Not enough free memory to load her, in plain words with the numbers (NephisMemory.refusal).
    case lowMemory(String)

    /// The wait after a memory warning (not the studio test, which a read waits out).
    var isMemoryRest: Bool {
        if case .resting = self { return true }
        return false
    }

    var errorDescription: String? {
        switch self {
        case .disabled: return "Nephis was switched off after crashing twice in a row. Turn her back on in Settings › Voices › Voice test."
        case .released(let why): return "The model was released (\(why))."
        case .busy: return "The studio test is running; her model loads after it."
        case .resting(let seconds): return "Her model was released to free memory; it may load again in \(seconds) s. Another voice reads meanwhile."
        case .lowMemory(let why): return why
        }
    }
}
