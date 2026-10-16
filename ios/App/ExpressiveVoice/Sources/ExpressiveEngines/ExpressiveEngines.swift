//
//  ExpressiveEngines.swift — FluidAudio 0.17.5's Pocket TTS Core ML port behind one protocol (Nephis's flow engine,
//  NephisFlowSynth, is the other implementation).
//
//  Every engine loads the files ModelStore installed (pinned + verified) from FluidAudio's TTS model cache;
//  `ModelHub.offlineMode` is switched on before loading, so a missing file is an error, never a download
//  of something unpinned. Synthesis is one line at a time and returns 24 kHz mono float samples plus timings.
//
//  Compute placement: `.ane` (FlowLM on the Neural Engine, Mimi decoder on the CPU) and no stage on the GPU, which
//  iOS forbids in the background: Pocket reads with the screen locked and in CarPlay.
//

import CoreML
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
    /// Finished by her mastering chain (NephisMaster, pack chain "master"): the player adds no EQ or limiting of its own.
    public var mastered = false
    /// Her EQ already given by her engine (NephisFlowSynth, before the tuner's finishing in a read without her studio):
    /// the player adds no EQ of its own (its thump filter and soft limit stay).
    public var toned = false

    public var durationMs: Double { sampleRate > 0 ? Double(samples.count) * 1000 / Double(sampleRate) : 0 }
    /// Audio seconds per synthesis second (> 1 = faster than real time).
    public var timesRealtime: Double { synthMs > 0 ? durationMs / synthMs : 0 }
}

public enum ExpressiveEngineError: Error, LocalizedError {
    case notLoaded
    case modelNotInstalled(String)
    /// Released while it loaded: the load kept nothing (NephisFlowSynth, crash plan a3).
    case released

    public var errorDescription: String? {
        switch self {
        case .notLoaded: return "The model isn't loaded."
        case .released: return "The model was released while it loaded."
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

    /// A new, unloaded Pocket TTS engine. `pocketVoice`: it reads with this cloned voice (the shipped Narrator)
    /// instead of its default one; `pocketReads`: the same voice's other reads by role ("performed", "tense", "sad", "tender").
    public static func make(pocketVoice: PocketVoice? = nil, pocketReads: [String: PocketVoice] = [:]) -> any ExpressiveSynthesizer {
        PocketTtsSynth(voice: pocketVoice, reads: pocketReads)
    }
}

private func elapsedMs(since t0: Date) -> Double { Date().timeIntervalSince(t0) * 1000 }

public actor PocketTtsSynth: ExpressiveSynthesizer {
    private var manager: PocketTtsManager?
    /// The cloned voice (FluidAudio prepends Pocket's BOS itself); nil = Pocket's default voice.
    private let voiceData: PocketTtsVoiceData?
    /// The voice's other reads by line role ("performed", "tense", "sad", "tender").
    private let readData: [String: PocketTtsVoiceData]

    /// CPU + Neural Engine for every transformer stage, CPU for the Mimi decoder (FluidAudio's own choice there).
    public static let backgroundSafeUnits = PocketTtsComputeUnits(conditioner: .cpuAndNeuralEngine, flowLM: .cpuAndNeuralEngine,
                                                                  flowDecoder: .cpuAndNeuralEngine, mimiDecoder: .cpuOnly)

    public init(voice: PocketVoice? = nil, reads: [String: PocketVoice] = [:]) {
        voiceData = voice.map { PocketTtsVoiceData(audioPrompt: $0.audioPrompt, promptLength: $0.frames) }
        readData = reads.mapValues { PocketTtsVoiceData(audioPrompt: $0.audioPrompt, promptLength: $0.frames) }
    }

    public func load() async throws -> Double {
        if manager != nil { return 0 }
        let t0 = Date()
        // No stage on the GPU: iOS refuses GPU work in the background, and Pocket is the voice that reads with the
        // screen locked and in CarPlay. FluidAudio's defaults leave cond_prefill and flow_decoder_fused on `.all`.
        let m = PocketTtsManager(placement: .ane, computeUnits: Self.backgroundSafeUnits)
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
        // A mood read missing → the performed read for a role other than narration → the Narrator.
        let voice = readData[line.role] ?? (line.role == "narrator" ? nil : readData[ExpressiveLine.performedRole]) ?? voiceData
        // The director's temperature (calm narration 0.7 … playful 0.85), kept inside Pocket's stable range.
        // A mood read (tense, sad, tender) already carries its emotion in the voice prompt; a high temperature on top
        // made a tense fight line sound excited (Kasta, 2026-10-07), so those stay at 0.7 or below.
        let ceiling: Float = readData[line.role] != nil && line.role != ExpressiveLine.performedRole ? 0.7 : 0.85
        let temperature = min(ceiling, max(0.55, line.temperature ?? PocketTtsConstants.temperature))
        if let voice {
            session = try await manager.makeSession(voiceData: voice, temperature: temperature, seed: seed)
        } else {
            session = try await manager.makeSession(temperature: temperature, seed: seed)
        }
        session.enqueue(StyleMapper.pocketText(StyleMapper.plainText(line.text)))
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
