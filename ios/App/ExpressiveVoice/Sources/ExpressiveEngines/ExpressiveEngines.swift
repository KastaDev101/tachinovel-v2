//
//  ExpressiveEngines.swift — FluidAudio 0.17.5's expressive Core ML ports behind one protocol.
//
//  Every engine loads the files ModelStore installed (pinned + verified) from FluidAudio's TTS model cache;
//  `ModelHub.offlineMode` is switched on before loading, so a missing file is an error, never a download
//  of something unpinned. Synthesis is one line at a time (chunked to the engine's per-call limit) and
//  returns 24 kHz mono float samples plus timings.
//
//  Compute placement (FluidAudio's choices, measured fastest on M-series Macs):
//    Chatterbox Nano  all four models on CPU+GPU (the ANE compiler rejects the stateful KV decode)
//    NeuTTS-2E        LM prefill `.all`, decode CPU+GPU, NeuCodec on CPU+Neural Engine
//    Pocket TTS       `.ane` placement: FlowLM on the Neural Engine, Mimi decoder on the CPU
//  iOS forbids GPU work in the background, so the GPU engines are foreground-only (see the app's
//  ExpressiveSpeechEngine: Kokoro takes over while the app isn't active).
//

import ExpressiveCore
import FluidAudio
import Foundation

public struct ExpressiveAudio: Sendable {
    public let samples: [Float]
    public let sampleRate: Int
    /// Wall time of the whole line (all chunks).
    public let synthMs: Double
    /// Time until the first audio was available: the first frame for a streaming engine, the first chunk
    /// for a chunked one-shot engine.
    public let firstAudioMs: Double
    public let chunks: Int

    public var durationMs: Double { sampleRate > 0 ? Double(samples.count) * 1000 / Double(sampleRate) : 0 }
    /// Audio seconds per synthesis second (> 1 = faster than real time).
    public var timesRealtime: Double { synthMs > 0 ? durationMs / synthMs : 0 }
}

public enum ExpressiveEngineError: Error, LocalizedError {
    case notLoaded
    case unsupportedOS(String)
    case modelNotInstalled(String)

    public var errorDescription: String? {
        switch self {
        case .notLoaded: return "The model isn't loaded."
        case .unsupportedOS(let what): return "\(what) needs iOS 18 or later."
        case .modelNotInstalled(let what): return "\(what) isn't downloaded."
        }
    }
}

/// One expressive engine. Actor: Core ML models and sampling state are used by one caller at a time.
public protocol ExpressiveSynthesizer: Actor {
    /// Load the Core ML models (compiles them for this device on first use). Returns wall ms.
    func load() async throws -> Double
    func synthesize(_ line: ExpressiveLine, seed: UInt64?) async throws -> ExpressiveAudio
    func unload()
}

public enum ExpressiveEngines {
    /// FluidAudio's TTS model cache (Application Support/fluidaudio/Models on iOS, ~/.cache/fluidaudio/Models
    /// on macOS): where ModelStore installs files and FluidAudio's managers read them.
    public static func modelsRoot() throws -> URL {
        let root = try TtsCacheDirectory.ensure().appendingPathComponent("Models", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    /// Keep FluidAudio from downloading anything itself (the app's Kokoro loader sets this too).
    public static func setOfflineMode(_ on: Bool) {
        ModelHub.offlineMode = on
    }

    /// A new, unloaded engine; nil if this OS can't run it (Chatterbox Nano and NeuTTS-2E need iOS 18).
    /// `pocketVoice`: Pocket TTS reads with this cloned voice (the shipped Narrator) instead of its default one.
    public static func make(_ id: ExpressiveEngineID, narratorSpeaker: String = "emily", pocketVoice: PocketVoice? = nil) -> (any ExpressiveSynthesizer)? {
        switch id {
        case .chatterboxNano:
            if #available(iOS 18.0, macOS 15.0, *) { return ChatterboxNanoSynth() }
            return nil
        case .neutts2e:
            if #available(iOS 18.0, macOS 15.0, *) { return NeuTtsSynth(narrator: narratorSpeaker) }
            return nil
        case .pocketTts:
            return PocketTtsSynth(voice: pocketVoice)
        }
    }
}

private func elapsedMs(since t0: Date) -> Double { Date().timeIntervalSince(t0) * 1000 }

private func randomSeed() -> UInt64 { UInt64.random(in: 0..<UInt64.max) }

@available(iOS 18.0, macOS 15.0, *)
public actor ChatterboxNanoSynth: ExpressiveSynthesizer {
    private var manager: ChatterboxNanoManager?

    public init() {}

    public func load() async throws -> Double {
        if manager != nil { return 0 }
        let t0 = Date()
        let m = ChatterboxNanoManager()
        try await m.initialize()
        manager = m
        return elapsedMs(since: t0)
    }

    public func synthesize(_ line: ExpressiveLine, seed: UInt64?) async throws -> ExpressiveAudio {
        guard let manager else { throw ExpressiveEngineError.notLoaded }
        let t0 = Date()
        var samples: [Float] = []
        var rate = ExpressiveEngineID.chatterboxNano.sampleRate
        var first: Double?
        let chunks = StyleMapper.chatterboxChunks(line, limit: ExpressiveEngineID.chatterboxNano.maxCharactersPerCall)
        for chunk in chunks {
            let audio = try await manager.synthesize(text: chunk, seed: seed ?? randomSeed())
            if first == nil { first = elapsedMs(since: t0) }
            samples.append(contentsOf: audio.samples)
            rate = audio.sampleRate
        }
        let total = elapsedMs(since: t0)
        return ExpressiveAudio(samples: samples, sampleRate: rate, synthMs: total, firstAudioMs: first ?? total, chunks: chunks.count)
    }

    public func unload() {
        manager = nil
    }
}

@available(iOS 18.0, macOS 15.0, *)
public actor NeuTtsSynth: ExpressiveSynthesizer {
    private var manager: NeuTtsManager?
    private let narrator: String

    public init(narrator: String = "emily") {
        self.narrator = narrator
    }

    public func load() async throws -> Double {
        if manager != nil { return 0 }
        let t0 = Date()
        let m = NeuTtsManager()
        try await m.initialize()
        manager = m
        return elapsedMs(since: t0)
    }

    public func synthesize(_ line: ExpressiveLine, seed: UInt64?) async throws -> ExpressiveAudio {
        guard let manager else { throw ExpressiveEngineError.notLoaded }
        let t0 = Date()
        let speaker = StyleMapper.neuttsSpeaker(role: line.role, narrator: narrator)
        let emotion = StyleMapper.neuttsEmotion(line)
        var samples: [Float] = []
        var rate = ExpressiveEngineID.neutts2e.sampleRate
        var first: Double?
        let chunks = TextChunker.chunks(StyleMapper.plainText(line.text), limit: ExpressiveEngineID.neutts2e.maxCharactersPerCall)
        for chunk in chunks {
            let audio = try await manager.synthesize(text: chunk, speaker: speaker, emotion: emotion, seed: seed ?? randomSeed())
            if first == nil { first = elapsedMs(since: t0) }
            samples.append(contentsOf: audio.samples)
            rate = audio.sampleRate
        }
        let total = elapsedMs(since: t0)
        return ExpressiveAudio(samples: samples, sampleRate: rate, synthMs: total, firstAudioMs: first ?? total, chunks: chunks.count)
    }

    public func unload() {
        manager = nil
    }
}

public actor PocketTtsSynth: ExpressiveSynthesizer {
    private var manager: PocketTtsManager?
    /// The cloned voice (FluidAudio prepends Pocket's BOS itself); nil = Pocket's default voice.
    private let voiceData: PocketTtsVoiceData?

    public init(voice: PocketVoice? = nil) {
        voiceData = voice.map { PocketTtsVoiceData(audioPrompt: $0.audioPrompt, promptLength: $0.frames) }
    }

    public func load() async throws -> Double {
        if manager != nil { return 0 }
        let t0 = Date()
        let m = PocketTtsManager(placement: .ane)
        try await m.initialize()
        manager = m
        return elapsedMs(since: t0)
    }

    public func synthesize(_ line: ExpressiveLine, seed: UInt64?) async throws -> ExpressiveAudio {
        guard let manager else { throw ExpressiveEngineError.notLoaded }
        let t0 = Date()
        var samples: [Float] = []
        var first: Double?
        // A session per call: the voice prefill (~125 tokens) runs once instead of once per ~50-token text chunk, and
        // the Mimi decoder state carries across chunks (no seams inside a paragraph).
        let session: PocketTtsSession
        if let voiceData {
            session = try await manager.makeSession(voiceData: voiceData, seed: seed)
        } else {
            session = try await manager.makeSession(seed: seed)
        }
        session.enqueue(StyleMapper.plainText(line.text))
        session.finish()
        for try await frame in session.frames {
            if first == nil { first = elapsedMs(since: t0) }
            samples.append(contentsOf: frame.samples)
        }
        let total = elapsedMs(since: t0)
        return ExpressiveAudio(samples: samples, sampleRate: ExpressiveEngineID.pocketTts.sampleRate, synthMs: total,
                               firstAudioMs: first ?? total, chunks: 1)
    }

    public func unload() {
        manager = nil
    }
}
