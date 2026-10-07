//
//  KokoroRuntime.swift — the bundled Kokoro-82M model, loaded read-only, one sentence at a time.
//
//  The model ships inside the app (tools/fetch-voices.ts → KokoroModels/, a folder reference in Copy
//  Bundle Resources): FluidAudio's 7-stage Core ML chain (fp16 + int8-palettized "ANE" build), the
//  English G2P, the Misaki lexicon and all 28 English voices, pre-converted. Nothing is downloaded:
//  `ModelHub.offlineMode` is switched on, so a missing file is an error, never a silent 100 MB download.
//
//  Layout (models directory = KokoroAneManager's `directory`):
//    <dir>/kokoro-82m-coreml/ANE/*.mlmodelc, vocab.json, <voice>.bin     ← read in place
//    <dir>/kokoro-82m-coreml/G2P*.mlmodelc, g2p_vocab.json, us_lexicon_cache.json
//  FluidAudio reads the G2P and lexicon from a fixed cache path (<TtsCacheDirectory>/Models/kokoro/;
//  Application Support on iOS, ~/.cache on macOS), so those four entries are SYMLINKED there, pointing
//  into the bundle (the bundle path changes on every app update, so the links are refreshed on each load).
//
//  Shared by the app (via KokoroService) and the CI voice check (KokoroCheck), so CI tests exactly the
//  code and files that ship.
//

import CoreML
import Darwin
import FluidAudio
import Foundation
import HDVoiceCore

public struct KokoroAudio: Sendable {
    public let samples: [Float]
    public let sampleRate: Int
    /// Wall time of the synthesis call (G2P + 7 stages).
    public let synthMs: Double
    public var durationMs: Double { sampleRate > 0 ? Double(samples.count) * 1000 / Double(sampleRate) : 0 }

    public init(samples: [Float], sampleRate: Int, synthMs: Double) {
        self.samples = samples
        self.sampleRate = sampleRate
        self.synthMs = synthMs
    }
}

public enum KokoroRuntimeError: Error, LocalizedError, Equatable {
    case modelMissing(String)
    case notLoaded
    case injected(String)

    public var errorDescription: String? {
        switch self {
        case .modelMissing(let detail): return "The bundled Kokoro model is missing or incomplete: \(detail)"
        case .notLoaded: return "The Kokoro model isn't loaded."
        case .injected(let what): return "Injected failure (test): \(what)"
        }
    }
}

extension KokoroRoute {
    /// Per-stage Core ML placement for FluidAudio's chain.
    public var computeUnits: KokoroAneComputeUnits {
        switch self {
        case .backgroundSafe: return .aneTailCpu
        case .gpuTail: return .aneTailGpu
        case .allNeuralEngine: return .allAne
        case .cpuOnly: return .cpuOnly
        }
    }
}

public actor KokoroRuntime {
    public enum State: Equatable, Sendable {
        case unloaded
        case loading
        case ready
        case failed(String)
    }

    public private(set) var state: State = .unloaded
    public private(set) var route: KokoroRoute = .backgroundSafe
    /// Wall time of the last successful load, and whether it was the first load of this process.
    public private(set) var lastLoad: (ms: Double, first: Bool)?
    private var manager: KokoroAneManager?
    /// The manager's model store, kept to read voice packs and run the chain directly for voice mixes.
    private var store: KokoroAneModelStore?
    /// Blended packs (VoiceMix.swift), most recently used last; a few at 0.52 MB each.
    private var blendCache: [(spec: String, pack: KokoroAneVoicePack)] = []
    private static let blendCacheSize = 4
    private var loading: Task<Void, Error>?
    private var loadedOnce = false
    private let modelsDirectory: URL

    /// Test hooks (Voice Lab in debug builds, the simulator voice self-test): slow down or fail synthesis.
    public var injectedDelay: TimeInterval = 0
    public var injectedFailure = false

    public init(modelsDirectory: URL) {
        self.modelsDirectory = modelsDirectory
    }

    /// Files that must exist in a usable bundle (checked before loading).
    public static let requiredFiles = [
        "kokoro-82m-coreml/ANE/vocab.json",
        "kokoro-82m-coreml/ANE/af_heart.bin",
        "kokoro-82m-coreml/ANE/KokoroVocoder.mlmodelc/coremldata.bin",
        "kokoro-82m-coreml/G2PEncoder.mlmodelc/coremldata.bin",
        "kokoro-82m-coreml/g2p_vocab.json",
        "kokoro-82m-coreml/us_lexicon_cache.json",
    ]

    public static func missingFiles(in dir: URL) -> [String] {
        var missing = requiredFiles.filter { !FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path) }
        for v in VoiceCatalog.ids where !FileManager.default.fileExists(atPath: dir.appendingPathComponent("kokoro-82m-coreml/ANE/\(v).bin").path) {
            missing.append("kokoro-82m-coreml/ANE/\(v).bin")
        }
        return missing
    }

    public func setInjection(delay: TimeInterval, fail: Bool) {
        injectedDelay = max(0, delay)
        injectedFailure = fail
    }

    /// Load (or reuse) the model with this compute placement. Concurrent callers share one load.
    public func load(route: KokoroRoute) async throws {
        if state == .ready, self.route == route, manager != nil { return }
        if let loading {
            try await loading.value
            if state == .ready, self.route == route { return }
        }
        if manager != nil, self.route != route { await releaseNow() }
        self.route = route
        state = .loading
        let dir = modelsDirectory
        let first = !loadedOnce
        let task = Task { () throws -> Void in
            let missing = KokoroRuntime.missingFiles(in: dir)
            guard missing.isEmpty else { throw KokoroRuntimeError.modelMissing(missing.prefix(3).joined(separator: ", ")) }
            ModelHub.offlineMode = true
            try KokoroRuntime.linkSharedAssets(from: dir)
            let t0 = Date()
            // Our own store (the manager would make the same one) so voice mixes can read packs and run the
            // chain with a blended style (synthesizeBlend).
            let s = KokoroAneModelStore(directory: dir, computeUnits: route.computeUnits, variant: .english)
            let m = KokoroAneManager(variant: .english, defaultVoice: VoiceCatalog.defaultVoiceId, directory: dir, computeUnits: route.computeUnits,
                                     modelStore: s)
            // Only the default voice is read now; the others load on first use (0.52 MB from the bundle, a
            // few ms), so 28 voices don't hold 14.6 MB of RAM while one is speaking. missingFiles has
            // already checked that every voice is there.
            try await m.initialize()
            await self.didLoad(m, store: s, ms: Date().timeIntervalSince(t0) * 1000, first: first)
        }
        loading = task
        do {
            try await task.value
            loading = nil
        } catch {
            loading = nil
            state = .failed(error.localizedDescription)
            throw error
        }
    }

    private func didLoad(_ m: KokoroAneManager, store s: KokoroAneModelStore, ms: Double, first: Bool) {
        manager = m
        store = s
        loadedOnce = true
        lastLoad = (ms: ms, first: first)
        state = .ready
    }

    /// Drop the loaded model (memory pressure, idle). The next load reads it from disk again.
    public func release() async {
        if let loading { _ = try? await loading.value }
        await releaseNow()
    }

    private func releaseNow() async {
        let m = manager
        manager = nil
        store = nil
        blendCache.removeAll()
        if state == .ready { state = .unloaded }
        await m?.cleanup()
        // The lexicon maps and Core ML buffers are freed, but malloc keeps the pages until asked: hand them
        // back to the system now (the point of releasing is lowering the footprint under memory pressure).
        _ = malloc_zone_pressure_relief(nil, 0)
    }

    /// One sentence. `voice` is a built-in id or a mix's blend string ("af_heart+bf_emma@35", VoiceMix.swift).
    /// `runs` carries lexicon phoneme overrides (see PhonemeJoiner); without overrides the plain text goes
    /// through Kokoro's own normalization + G2P.
    public func synthesize(text: String, runs: [SpeechRun]?, voice: String, speed: Float) async throws -> KokoroAudio {
        guard let m = manager, state == .ready else { throw KokoroRuntimeError.notLoaded }
        let t0 = Date()
        if injectedDelay > 0 { try await Task.sleep(nanoseconds: UInt64(injectedDelay * 1e9)) }
        if injectedFailure { throw KokoroRuntimeError.injected("synthesis") }
        let blend = VoiceBlend.parse(voice)
        let overrides = runs?.contains(where: { if case .phonemes = $0 { return true } else { return false } }) ?? false
        guard blend != nil || overrides else {
            let r = try await m.synthesizeDetailed(text: text, voice: voice, speed: speed)
            return KokoroAudio(samples: r.samples, sampleRate: r.sampleRate, synthMs: Date().timeIntervalSince(t0) * 1000)
        }
        // Phonemes first (overrides spliced in, or Kokoro's own normalization + G2P), then one pass per piece
        // that fits, so long sentences keep their overrides and mixes work at any length.
        let phonemes: String
        if overrides, let runs {
            var parts: [(run: SpeechRun, phonemes: String)] = []
            for run in runs {
                switch run {
                case .phonemes(let p):
                    parts.append((run: run, phonemes: p))
                case .text(let t):
                    let ph: String
                    if PhonemeJoiner.isSilent(t) {
                        ph = PhonemeJoiner.punctuationOnly(t)
                    } else {
                        ph = try await m.phonemes(for: t)
                    }
                    parts.append((run: run, phonemes: ph))
                }
            }
            phonemes = PhonemeJoiner.join(parts)
        } else {
            phonemes = try await m.phonemes(for: text)
        }
        let pieces = PhonemeJoiner.chunks(phonemes)
        guard !pieces.isEmpty else {
            // Nothing to pronounce: whatever Kokoro's text path makes of it (the mix's main voice).
            let r = try await m.synthesizeDetailed(text: text, voice: blend?.dominant ?? voice, speed: speed)
            return KokoroAudio(samples: r.samples, sampleRate: r.sampleRate, synthMs: Date().timeIntervalSince(t0) * 1000)
        }
        var samples: [Float] = []
        var sampleRate = KokoroAneConstants.sampleRate
        for piece in pieces {
            try Task.checkCancellation()
            let r: KokoroAneSynthesisResult
            if let blend {
                r = try await synthesizeBlend(piece, blend: blend, speed: speed)
            } else {
                r = try await m.synthesizeFromPhonemesDetailed(piece, voice: voice, speed: speed)
            }
            samples += r.samples
            sampleRate = r.sampleRate
        }
        return KokoroAudio(samples: samples, sampleRate: sampleRate, synthMs: Date().timeIntervalSince(t0) * 1000)
    }

    /// One piece (≤ 510 phonemes) with a blended style: what KokoroAneManager does for a named voice, with
    /// the mixed pack's row for this length.
    private func synthesizeBlend(_ phonemes: String, blend: VoiceBlend, speed: Float) async throws -> KokoroAneSynthesisResult {
        guard let s = store else { throw KokoroRuntimeError.notLoaded }
        let pack = try await blendedPack(blend, store: s)
        let vocab = try await s.vocabulary()
        let ids = try vocab.encode(phonemes)
        let style = pack.slice(for: KokoroAneVocab.phonemeLength(phonemes))
        return try await KokoroAneSynthesizer.synthesize(inputIds: ids, styleS: style.styleS, styleTimbre: style.styleTimbre, speed: speed, store: s)
    }

    /// The mixed pack, (1 − t)·A + t·B over all 510 × 256 values; the last few are kept.
    private func blendedPack(_ blend: VoiceBlend, store s: KokoroAneModelStore) async throws -> KokoroAneVoicePack {
        if let i = blendCache.firstIndex(where: { $0.spec == blend.spec }) {
            let hit = blendCache.remove(at: i)
            blendCache.append(hit)
            return hit.pack
        }
        let a = try await s.voicePack(blend.a)
        let b = try await s.voicePack(blend.b)
        let pack = try KokoroAneVoicePack(storage: VoiceBlend.mix(a.storage, b.storage, t: blend.t))
        if !blendCache.contains(where: { $0.spec == blend.spec }) {
            blendCache.append((spec: blend.spec, pack: pack))
            if blendCache.count > Self.blendCacheSize { blendCache.removeFirst() }
        }
        return pack
    }

    /// Symlink the G2P + lexicon into FluidAudio's fixed cache path (see the header).
    public static func linkSharedAssets(from dir: URL) throws {
        let source = dir.appendingPathComponent("kokoro-82m-coreml")
        let root = try TtsCacheDirectory.ensure()
        // FluidAudio's `Repo.kokoro.folderName` ("kokoro"): where G2PModel and the lexicon cache look.
        let target = root.appendingPathComponent("Models").appendingPathComponent("kokoro")
        let fm = FileManager.default
        try fm.createDirectory(at: target, withIntermediateDirectories: true)
        for name in ["G2PEncoder.mlmodelc", "G2PDecoder.mlmodelc", "g2p_vocab.json", "us_lexicon_cache.json"] {
            let link = target.appendingPathComponent(name)
            let dest = source.appendingPathComponent(name)
            if let existing = try? fm.destinationOfSymbolicLink(atPath: link.path), existing == dest.path { continue }
            if (try? fm.attributesOfItem(atPath: link.path)) != nil { try fm.removeItem(at: link) }
            try fm.createSymbolicLink(at: link, withDestinationURL: dest)
        }
        // Only links live there, but keep the folder out of iCloud/iTunes backups all the same.
        var rootURL = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? rootURL.setResourceValues(values)
    }
}
