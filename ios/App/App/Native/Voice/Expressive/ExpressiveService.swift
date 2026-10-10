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
//  - Imported voices (personal flavor; docs/voice-import.md): .tnvoice files made on the PC are checked
//    (ExpressiveCore VoicePack) and kept in Application Support/TachiNovel/voices (ImportedVoiceStore). The
//    chosen narrator voice is what Chatterbox Nano loads instead of its built-in voice (ChatterboxVoiceSlot);
//    a missing or invalid file at load time falls back to the built-in voice and says so (`voiceNote`).
//    Kokoro and Apple voice settings are separate and never touched.
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
    /// The loaded engine is Nephis's flow engine: calls must come in reading order (HybridSpeechEngine).
    private(set) var usesFlow = false
    private(set) var loadStates: [ExpressiveEngineID: LoadState] = [:]
    private(set) var lastLoad: [ExpressiveEngineID: (ms: Double, cold: Bool)] = [:]
    private var loadedThisLaunch: Set<ExpressiveEngineID> = []
    private var loadWaiters: [(Result<Void, Error>) -> Void] = []
    private var idleItem: DispatchWorkItem?
    private(set) var memoryWarnings = 0
    private(set) var speedTest: SpeedTest?
    private var speedTask: Task<Void, Never>?
    private let log = Logger(subsystem: "app.tachinovel", category: "voice-expressive")

    // Imported voices (Chatterbox Nano only for now; VoicePackEngine.all lists what can be imported).
    let voices: ImportedVoiceStore
    /// Voices that ship in the app (BuiltInVoices/), checked on first use; one of them can be the default.
    let bundled = BundledVoices(directory: Bundle.main.url(forResource: "BuiltInVoices", withExtension: nil))
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
                                      modelsDirectory: pack == nil ? nil : NephisModelPack.modelsDirectory, chain: chain)
    }

    /// Her EQ's top lift for the installed pack's decoder (nil: the shipped one).
    var nephisHighShelfDB: Double? { nephisFlowAssets?.chain.highShelfDB }
    /// Her EQ's gentler sibilance for the installed pack (nil: on).
    var nephisSoftSibilance: Bool? { nephisFlowAssets?.chain.softSibilance }

    /// A Nephis model pack was installed or removed: forget her assets; a loaded Nephis engine reloads on next use.
    func reloadNephisModel() {
        nephisFlowAssetsCache = nil
        if loadedID == .pocketTts, usesFlow { unload(reason: "new Nephis model") }
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
    let chatterboxSlot: ChatterboxVoiceSlot?
    /// The chosen narrator voice for Chatterbox Nano: an imported ("v…") or shipped ("b…") voice's id, or
    /// "builtin" for Chatterbox's own voice; nil = the default voice.
    private(set) var selectedVoice: String?
    /// The Voice Lab's ▶ on one voice: load with this voice instead of the narrator voice.
    var sampleVoice: String?
    /// What the loaded Chatterbox Nano was asked for and what it really uses ("builtin" or an id).
    private(set) var loadedVoiceRequest: String?
    private(set) var loadedVoiceUsed: String?
    private var loggedBundleProblems = false
    private var loadingVoiceRequest: String?
    private var loadGeneration = 0
    /// Why the last load fell back to the built-in voice (shown in the Voice Lab), nil when it didn't.
    private(set) var voiceNote: String?
    private(set) var voiceList: [ImportedVoice] = []
    static let builtInVoice = "builtin"
    /// One Chatterbox load at a time: the voice slot is shared (install → load → restore).
    static let slotGate = AsyncGate()

    /// Voice import is part of the personal flavor only (the embedded web bundle says which flavor this is).
    static let voiceImportEnabled: Bool = {
        let url = WebBundle.embeddedRoot.appendingPathComponent("build-info.json")
        guard let data = try? Data(contentsOf: url), let info = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        return info["flavor"] as? String == "personal"
    }()

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let sentinel = CrashSentinel(directory: support.appendingPathComponent("TachiNovel/voice-expressive", isDirectory: true))
        self.sentinel = sentinel
        let crashed = sentinel.checkAtLaunch()
        let modelStore = (try? ExpressiveEngines.modelsRoot()).map { ModelStore(root: $0) }
        store = modelStore
        let voiceStore = ImportedVoiceStore(root: support.appendingPathComponent("TachiNovel/voices", isDirectory: true))
        voices = voiceStore
        chatterboxSlot = modelStore.flatMap { s in ExpressiveEngineID.chatterboxNano.pinned.flatMap { ChatterboxVoiceSlot(model: $0, store: s) } }
        selectedVoice = voiceStore.selection(engine: VoicePackEngine.chatterboxNano.id)
        voiceList = voiceStore.list(engine: VoicePackEngine.chatterboxNano.id)
        // A crash in the middle of a load can leave an imported voice in the model's slot: put the built-in one
        // back before anything loads (hashing a 0.6 MB file).
        do {
            try chatterboxSlot?.restorePinned()
        } catch {
            log.error("expressive: voice slot: \(error.localizedDescription, privacy: .public)")
        }
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

    /// The voice Chatterbox Nano should load now ("builtin" or an imported voice's id); nil for other engines.
    private func voiceRequest(for id: ExpressiveEngineID) -> String? {
        // Pocket TTS: the chosen shipped voice (Narrator or Nephis); a change reloads the engine with it.
        if id == .pocketTts { return VoiceSettings.shared.prefs.delivery.pocketVoice }
        guard id == .chatterboxNano else { return nil }
        return sampleVoice ?? selectedVoice ?? defaultVoice
    }

    /// The narrator voice when none is chosen: the shipped default voice if there is a valid one, else
    /// Chatterbox Nano's own voice. (The first call checks the shipped voices.)
    var defaultVoice: String {
        let id = bundled.defaultID(engine: VoicePackEngine.chatterboxNano.id) ?? Self.builtInVoice
        if !loggedBundleProblems {
            loggedBundleProblems = true
            for p in bundled.problems { log.error("expressive: shipped voice: \(p, privacy: .public)") }
        }
        return id
    }

    /// Load `id` (unloading any other engine first) with the voice it should use. Completion on main.
    func ensureLoaded(_ id: ExpressiveEngineID, completion: @escaping (Result<Void, Error>) -> Void) {
        cancelIdleRelease()
        let request = voiceRequest(for: id)
        if loadedID == id, loadState(id) == .ready, synth != nil {
            if request == loadedVoiceRequest { return completion(.success(())) }
            unload(reason: "switching voice")
        }
        if loadedID == id, loadState(id) == .loading {
            if request == loadingVoiceRequest {
                loadWaiters.append(completion)
                return
            }
            unload(reason: "switching voice")
        }
        guard !crashDisabled else { return completion(.failure(ExpressiveError.disabled)) }
        guard Self.supported(id) else { return completion(.failure(ExpressiveEngineError.unsupportedOS(id.title))) }
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
        // Nephis reads as one continuous flow (NephisFlowSynth): carry-over, lead-ins, blended joins, best takes.
        let flow: (any ExpressiveSynthesizer)? = nephis ? nephisFlowAssets.map { NephisFlowSynth(assets: $0, transcriber: NephisSpeech.transcriber()) } : nil
        guard let engine = flow ?? ExpressiveEngines.make(id, pocketVoice: pocketVoice, pocketReads: id == .pocketTts && !nephis ? pocketReads : [:]) else { return completion(.failure(ExpressiveEngineError.unsupportedOS(id.title))) }
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
        let slot = id == .chatterboxNano ? chatterboxSlot : nil
        let sources = VoiceSources(imported: voices, bundled: bundled, fallback: id == .chatterboxNano ? defaultVoice : Self.builtInVoice)
        ExpressiveEngines.setOfflineMode(true)
        Task.detached(priority: .userInitiated) { [weak self] in
            sentinel.begin(context)
            let outcome: VoiceLoadOutcome
            if let slot, let request {
                outcome = await Self.loadChatterbox(engine, slot: slot, sources: sources, request: request)
            } else {
                do { outcome = VoiceLoadOutcome(result: .success(try await engine.load()), used: Self.builtInVoice, note: nil) } catch {
                    outcome = VoiceLoadOutcome(result: .failure(error), used: Self.builtInVoice, note: nil)
                }
            }
            let result = outcome.result
            sentinel.end(success: (try? result.get()) != nil)
            DispatchQueue.main.async {
                guard let self, self.loadedID == id, self.loadGeneration == generation else { return }
                let waiters = self.loadWaiters
                self.loadWaiters = []
                self.loadingVoiceRequest = nil
                switch result {
                case .success(let ms):
                    self.loadStates[id] = .ready
                    self.lastLoad[id] = (ms: ms, cold: cold)
                    self.loadedThisLaunch.insert(id)
                    if id == .chatterboxNano {
                        self.loadedVoiceRequest = request
                        self.loadedVoiceUsed = outcome.used
                        self.voiceNote = outcome.note
                        if let note = outcome.note { self.log.error("expressive: \(note, privacy: .public)") }
                    }
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

    struct VoiceLoadOutcome: Sendable {
        let result: Result<Double, Error>
        /// The voice actually loaded ("builtin" or an id).
        let used: String
        /// Why the requested voice wasn't used (said in the Voice Lab), nil when it was.
        let note: String?
    }

    /// Where a voice's data comes from: imported ("v…") or shipped with the app ("b…"); "builtin" is the model's own.
    struct VoiceSources: Sendable {
        let imported: ImportedVoiceStore
        let bundled: BundledVoices
        /// Tried when the requested voice can't be used (the default voice), before Chatterbox's own voice.
        let fallback: String

        func data(_ id: String) throws -> Data {
            let engine = VoicePackEngine.chatterboxNano
            if BundledVoices.isBundledID(id) {
                let contents = try bundled.contents(id)
                guard contents.manifest.engine == engine else { throw VoicePackError.notFound(id) }
                return contents.conditioning
            }
            return try imported.conditioning(id, engine: engine.id)
        }

        func name(_ id: String) -> String? {
            if id == ExpressiveService.builtInVoice { return ExpressiveService.engineVoiceName }
            if BundledVoices.isBundledID(id) { return bundled.entry(id)?.name }
            return imported.voice(id, engine: VoicePackEngine.chatterboxNano.id)?.name
        }
    }

    static let engineVoiceName = "Original Chatterbox voice"

    /// Chatterbox Nano with `request` in its voice slot, one load at a time. If that voice is missing, fails the
    /// checks again or doesn't load, the default voice is tried, then Chatterbox's own; the outcome says why.
    private static func loadChatterbox(_ engine: any ExpressiveSynthesizer, slot: ChatterboxVoiceSlot, sources: VoiceSources,
                                       request: String) async -> VoiceLoadOutcome {
        await slotGate.acquire()
        let outcome = await loadChatterboxLocked(engine, slot: slot, sources: sources, request: request)
        await slotGate.release()
        return outcome
    }

    private static func loadChatterboxLocked(_ engine: any ExpressiveSynthesizer, slot: ChatterboxVoiceSlot, sources: VoiceSources,
                                             request: String) async -> VoiceLoadOutcome {
        var candidates = [request]
        if !candidates.contains(sources.fallback) { candidates.append(sources.fallback) }
        if !candidates.contains(builtInVoice) { candidates.append(builtInVoice) }
        var note: String?
        var lastError: Error = ExpressiveEngineError.notLoaded
        for candidate in candidates {
            do {
                let ms: Double
                if candidate == builtInVoice {
                    try slot.restorePinned()
                    ms = try await engine.load()
                } else {
                    try slot.install(try sources.data(candidate))
                    do {
                        ms = try await engine.load()
                    } catch {
                        try? slot.restorePinned()
                        await engine.unload()
                        throw error
                    }
                    try? slot.restorePinned()
                }
                let reason = note.map { "\($0) Using “\(sources.name(candidate) ?? "another voice")” instead." }
                return VoiceLoadOutcome(result: .success(ms), used: candidate, note: reason)
            } catch {
                lastError = error
                if note == nil {
                    let shown = sources.name(candidate).map { "“\($0)”" } ?? "your narrator voice"
                    note = "Couldn’t use \(shown): \(error.localizedDescription)"
                }
            }
        }
        return VoiceLoadOutcome(result: .failure(lastError), used: builtInVoice, note: note)
    }

    // MARK: - Imported and shipped voices

    /// Check and keep a .tnvoice file (off the main thread). Completion on main.
    func importVoice(from url: URL, sourceName: String, completion: @escaping (Result<(voice: ImportedVoice, replaced: Bool), Error>) -> Void) {
        let voices = self.voices
        DispatchQueue.global(qos: .userInitiated).async {
            let result: Result<(voice: ImportedVoice, replaced: Bool), Error>
            do {
                let contents = try VoicePack.read(fileAt: url)
                result = .success(try voices.add(contents, sourceFile: sourceName))
            } catch {
                result = .failure(error)
            }
            DispatchQueue.main.async {
                self.refreshVoices()
                if case .success(let r) = result {
                    self.log.info("expressive: imported voice \(r.voice.id, privacy: .public)")
                    // Re-importing the loaded voice: load it again next time (the file may have changed).
                    if r.voice.id == self.loadedVoiceRequest { self.unload(reason: "voice re-imported") }
                }
                completion(result)
            }
        }
    }

    func refreshVoices() {
        voiceList = voices.list(engine: VoicePackEngine.chatterboxNano.id)
        selectedVoice = voices.selection(engine: VoicePackEngine.chatterboxNano.id)
    }

    /// Shipped voices for Chatterbox Nano (checked on the first call).
    var shippedVoices: [BundledVoices.Entry] { bundled.entries(engine: VoicePackEngine.chatterboxNano.id) }

    /// Is `id` a voice that can be chosen right now: "builtin", a shipped voice or an imported one?
    func voiceExists(_ id: String) -> Bool {
        id == Self.builtInVoice || shippedVoices.contains { $0.id == id } || voiceList.contains { $0.id == id }
    }

    /// The narrator voice for Chatterbox Nano (nil = the default voice). Survives restarts (selection.json).
    func selectVoice(_ id: String?) throws {
        if let id, !voiceExists(id) { throw VoicePackError.notFound(id) }
        try voices.setSelection(id, engine: VoicePackEngine.chatterboxNano.id)
        refreshVoices()
        voiceNote = nil
        if loadedID == .chatterboxNano, loadedVoiceRequest != (id ?? defaultVoice) { unload(reason: "narrator voice changed") }
    }

    @discardableResult
    func renameVoice(_ id: String, to name: String) throws -> ImportedVoice {
        let voice = try voices.rename(id, engine: VoicePackEngine.chatterboxNano.id, to: name)
        refreshVoices()
        return voice
    }

    func deleteVoice(_ id: String) throws {
        if loadedID == .chatterboxNano, loadedVoiceRequest == id || loadingVoiceRequest == id { unload(reason: "voice deleted") }
        if sampleVoice == id { sampleVoice = nil }
        try voices.delete(id, engine: VoicePackEngine.chatterboxNano.id)
        refreshVoices()
    }

    /// An imported voice's preview file.
    func previewURL(_ id: String) -> URL? {
        voices.previewURL(id, engine: VoicePackEngine.chatterboxNano.id)
    }

    /// A shipped voice's preview (read from the app and checked again).
    func shippedPreview(_ id: String) -> Data? {
        guard BundledVoices.isBundledID(id) else { return nil }
        return try? bundled.contents(id).preview
    }

    func voiceName(_ id: String?) -> String {
        guard let id else { return voiceName(defaultVoice) }
        if id == Self.builtInVoice { return Self.engineVoiceName }
        if let shipped = shippedVoices.first(where: { $0.id == id }) { return shipped.name }
        return voiceList.first { $0.id == id }?.name ?? "Unknown voice"
    }

    static func voiceJSON(_ v: ImportedVoice) -> [String: Any] {
        [
            "id": v.id, "name": v.name, "engine": v.engine, "createdAt": v.createdAt, "importedAt": v.importedAt, "bytes": v.bytes,
            "hasPreview": v.hasPreview, "madeFor": v.madeFor ?? NSNull(), "sourceFile": v.sourceFile ?? NSNull(), "bundled": false,
        ]
    }

    static func shippedJSON(_ e: BundledVoices.Entry) -> [String: Any] {
        ["id": e.id, "name": e.name, "engine": e.engine, "createdAt": e.createdAt, "hasPreview": e.hasPreview, "bundled": true, "isDefault": e.isDefault]
    }

    /// The Voice Lab's "Narrator voice" block: shipped voices (default first), then imported ones.
    func voicesSnapshot() -> [String: Any] {
        let shipped = shippedVoices
        let loaded: Any = loadedID == .chatterboxNano && loadState(.chatterboxNano) == .ready ? (loadedVoiceUsed ?? Self.builtInVoice) as Any : NSNull() as Any
        return [
            "engine": VoicePackEngine.chatterboxNano.id,
            "engineTitle": VoicePackEngine.chatterboxNano.title,
            "importEnabled": Self.voiceImportEnabled,
            "default": defaultVoice,
            "selected": selectedVoice ?? NSNull(),
            "selectedMissing": selectedVoice.map { !voiceExists($0) } ?? false,
            "loaded": loaded,
            "note": voiceNote ?? NSNull(),
            "list": shipped.map(Self.shippedJSON) + voiceList.map(Self.voiceJSON),
        ]
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
        loadedVoiceUsed = nil
        let waiters = loadWaiters
        loadWaiters = []
        waiters.forEach { $0(.failure(ExpressiveError.released(reason))) }
        Task.detached { await engine?.unload() }
    }

    /// Nephis is the reader: load her model shortly after launch (the first load after an app update compiles it for
    /// this phone, which takes a while), so Listen starts with her voice instead of waiting. Released again after 3 idle
    /// minutes unless narration is using it by then.
    func warmNephis() {
        guard NarrationController.listenEngine() == .pocketTts, VoiceSettings.shared.prefs.delivery.isNephis, isInstalled(.pocketTts),
              !crashDisabled, Self.supported(.pocketTts), loadedID == nil else { return }
        ensureLoaded(.pocketTts) { [weak self] result in
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

    /// Nephis's flow (Listen): `prepared` (on main) as soon as the call's latents are ready, so the next call can start
    /// generating while this one decodes; then `completion` (on main) with the audio. Calls must come in reading
    /// order and be prepared one at a time.
    func synthesizeFlow(_ line: ExpressiveLine, prepared: @escaping () -> Void, completion: @escaping (Result<ExpressiveAudio, Error>) -> Void) {
        guard loadedID == .pocketTts, loadState(.pocketTts) == .ready, let flow = synth as? NephisFlowSynth else {
            return completion(.failure(ExpressiveEngineError.notLoaded))
        }
        let sentinel = self.sentinel
        let context = "nephis \(line.text.count) chars \(ProcessInfo.processInfo.operatingSystemVersionString)"
        Task.detached(priority: .userInitiated) { [weak self] in
            sentinel.begin(context)
            let result: Result<ExpressiveAudio, Error>
            do {
                let p = try await flow.prepare(line, seed: nil)
                DispatchQueue.main.async(execute: prepared)
                result = .success(try await flow.decode(p))
            } catch {
                result = .failure(error)
            }
            sentinel.end(success: (try? result.get()) != nil)
            let report = await flow.lastReport
            DispatchQueue.main.async {
                if case .success = result { self?.recordFlow(report) }
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
    }

    private(set) var flowStats = FlowStats()

    func resetFlowStats() {
        flowStats = FlowStats()
    }

    private func recordFlow(_ r: NephisFlowSynth.Report) {
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
        flowStats.last = r
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
            "app": "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"))",
            "voices": voicesSnapshot(),
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
        guard f.calls > 0 else { return ["active": usesFlow, "calls": 0] as [String: Any] }
        let audio = max(1, f.audioMs)
        var out: [String: Any] = [
            "active": usesFlow, "calls": f.calls, "takes": f.takes, "leadIns": f.leadIns, "listened": f.listened,
            "audioSeconds": Self.r1(f.audioMs / 1000),
            // Seconds of work per second of audio, stage by stage (render overlaps the analysis decode; the
            // stream decode overlaps the next call's render in Listen).
            "perAudioSecond": ["render": Self.r2(f.renderMs / audio), "analysis": Self.r2(f.analysisMs / audio),
                               "recognize": Self.r2(f.recognizeMs / audio), "decode": Self.r2(f.decodeMs / audio),
                               "call": Self.r2(f.totalMs / audio)],
            "renderX": f.renderMs > 0 ? Self.r2(f.audioMs / f.renderMs) : 0,
        ]
        // Breaks a listener heard in the last Listen session: waits for her, and sentences another voice read.
        if let s = NarrationController.shared.speechEngine.snapshot {
            out["listen"] = ["breaks": s.underruns, "breakSeconds": Self.r1(s.waitedSeconds), "otherVoiceSentences": s.appleSentences,
                             "fallbacks": Dictionary(uniqueKeysWithValues: s.fallbacks.map { ($0.key.rawValue, $0.value) })] as [String: Any]
        }
        if let r = f.last {
            out["last"] = ["takes": r.takes, "usable": r.usable, "leadIn": r.leadIn, "wordMatch": r.wordMatch.map { Self.r2($0) } ?? NSNull(),
                           "jumpScore": r.jumpScore.map { Self.r2($0) } ?? NSNull(), "renderMs": Self.r1(r.renderMs),
                           "analysisMs": Self.r1(r.analysisMs), "recognizeMs": Self.r1(r.recognizeMs), "decodeMs": Self.r1(r.decodeMs),
                           "totalMs": Self.r1(r.totalMs), "audioMs": Self.r1(r.audioMs)] as [String: Any]
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
