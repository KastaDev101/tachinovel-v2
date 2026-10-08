@preconcurrency import CoreML
import Foundation

/// TachiNovel addition: Pocket TTS's Mimi decoder with its own persistent state.
///
/// Sessions decode each paragraph with a decoder that starts cold, which makes an audible start-up thump and
/// seams between paragraphs. Fed the latents of several sessions (`AudioFrame.latent`, with
/// `PocketTtsSession.setDecodesAudio(false)`), this decodes them as one stream: no restarts at the joins.
public actor PocketTtsLatentDecoder {
    private let model: MLModel
    private let mimiKeys: PocketTtsMimiKeys
    private let initialState: PocketTtsSynthesizer.MimiState
    private var state: PocketTtsSynthesizer.MimiState

    init(model: MLModel, mimiKeys: PocketTtsMimiKeys, initialState: PocketTtsSynthesizer.MimiState) throws {
        self.model = model
        self.mimiKeys = mimiKeys
        self.initialState = initialState
        self.state = try PocketTtsSynthesizer.cloneMimiState(initialState)
    }

    /// Decode latents (32 values each) in order, continuing from everything decoded before.
    /// Returns 1920 samples (80 ms at 24 kHz) per latent.
    public func decode(_ latents: [[Float]]) async throws -> [Float] {
        var out: [Float] = []
        out.reserveCapacity(latents.count * PocketTtsConstants.samplesPerFrame)
        for latent in latents {
            var s = state
            let samples = try await PocketTtsSynthesizer.runMimiDecoder(latent: latent, state: &s, model: model, mimiKeys: mimiKeys)
            state = s
            out.append(contentsOf: samples)
        }
        return out
    }

    /// Start over (a new chapter, or after a seek).
    public func reset() throws {
        state = try PocketTtsSynthesizer.cloneMimiState(initialState)
    }
}

extension PocketTtsSynthesizer {
    /// Must be called within a `withModelStore` context.
    static func makeLatentDecoder() async throws -> PocketTtsLatentDecoder {
        let store = try currentModelStore()
        let mimiModel = try await store.mimiDecoder()
        let mimiKeys = try await store.mimiDecoderKeys()
        let repoDir = try await store.repoDir()
        let state = try loadMimiInitialState(from: repoDir, mimiKeys: mimiKeys)
        return try PocketTtsLatentDecoder(model: mimiModel, mimiKeys: mimiKeys, initialState: state)
    }
}
