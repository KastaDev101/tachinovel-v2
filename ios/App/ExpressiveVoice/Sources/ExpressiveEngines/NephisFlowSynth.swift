//
//  NephisFlowSynth.swift — Pocket TTS reading as Nephis, as one continuous read (ExpressiveCore/NephisFlow.swift
//  explains the method). Calls must come in reading order: each one continues from the previous (carry-over voice
//  prompt, lead-in, the join into it), and the audio returned for a call starts with the pause before it.
//
//  Needs the vendored FluidAudio's latent access (ios/App/Vendor/FluidAudio/README.md): sessions yield latents only,
//  one PocketTtsLatentDecoder decodes the whole read, a second one (reset per take) decodes takes for analysis.
//

import ExpressiveCore
import FluidAudio
import Foundation

/// Speech recognition with word timings for a take (24 kHz mono); nil when unavailable. Supplied by the app.
public typealias NephisTranscriber = @Sendable ([Float], Int) async -> [NephisFlow.Word]?

public actor NephisFlowSynth: ExpressiveSynthesizer {
    public struct Assets: Sendable {
        public let calm: PocketVoice
        public let tense: PocketVoice?
        public let projection: NephisFlow.Projection
        public init(calm: PocketVoice, tense: PocketVoice?, projection: NephisFlow.Projection) {
            self.calm = calm
            self.tense = tense
            self.projection = projection
        }
    }

    /// What happened to the last call (Voice Lab, logs).
    public struct Report: Sendable {
        public var takes = 0
        public var usable = 0
        public var leadIn = false
        public var wordMatch: Double?
        public var jumpScore: Double?
        public var renderMs = 0.0
        public var recognizeMs = 0.0
        public var decodeMs = 0.0
    }

    private let assets: Assets
    private var transcriber: NephisTranscriber?
    private var manager: PocketTtsManager?
    private var decoder: PocketTtsLatentDecoder?
    private var scratch: PocketTtsLatentDecoder?

    // The read so far.
    private var carry: [[Float]] = []
    private var pendingTail: [[Float]] = []
    private var context: [Float] = []
    private var lastText: String?
    private var lastClip: [Float]?
    private var started = false
    public private(set) var lastReport = Report()

    public init(assets: Assets, transcriber: NephisTranscriber? = nil) {
        self.assets = assets
        self.transcriber = transcriber
    }

    public func setTranscriber(_ t: NephisTranscriber?) {
        transcriber = t
    }

    public func load() async throws -> Double {
        if manager != nil { return 0 }
        let t0 = Date()
        let m = PocketTtsManager(placement: .ane, computeUnits: PocketTtsSynth.backgroundSafeUnits)
        try await m.initialize()
        decoder = try await m.makeLatentDecoder()
        scratch = try await m.makeLatentDecoder()
        manager = m
        return Date().timeIntervalSince(t0) * 1000
    }

    public func unload() {
        manager = nil
        decoder = nil
        scratch = nil
        forget()
    }

    private func forget() {
        carry = []
        pendingTail = []
        context = []
        lastText = nil
        lastClip = nil
        started = false
    }

    public func synthesize(_ line: ExpressiveLine, seed: UInt64?) async throws -> ExpressiveAudio {
        guard let manager, let decoder, let scratch else { throw ExpressiveEngineError.notLoaded }
        let t0 = Date()
        if line.flowReset == true {
            forget()
            try await decoder.reset()
        }
        var report = Report()
        let text = StyleMapper.pocketText(StyleMapper.plainText(line.text))
        let clip = line.role == "tense" ? (assets.tense ?? assets.calm).audioPrompt : assets.calm.audioPrompt
        let prompt = NephisFlow.prompt(clip: clip, previousClip: lastClip.flatMap { $0 == clip ? nil : $0 },
                                       carry: assets.projection.condition(carry))
        let voice = PocketTtsVoiceData(audioPrompt: prompt.frames, promptLength: prompt.count)
        let temperature = min(0.85, max(0.55, line.temperature ?? 0.7))
        let lead = started && transcriber != nil ? lastText.map(Self.lastSentence) : nil

        struct Take {
            var latents: [[Float]]
            var audio: [Float]
            var match: Double
            var score: Double
        }
        var takes: [Take] = []
        let n = max(1, min(8, line.takes ?? 1))
        for t in 0..<n {
            let said = lead.map { $0 + " " + text } ?? text
            let r0 = Date()
            var latents = try await render(manager, voice: voice, text: said, temperature: temperature, seed: seed.map { $0 &+ UInt64(t) })
            report.renderMs += Date().timeIntervalSince(r0) * 1000
            report.takes += 1
            try await scratch.reset()
            let d0 = Date()
            var audio = try await scratch.decode(latents)
            report.decodeMs += Date().timeIntervalSince(d0) * 1000
            var match = 1.0
            if let transcriber {
                let a0 = Date()
                let words = await transcriber(audio, NephisFlow.sampleRate)
                report.recognizeMs += Date().timeIntervalSince(a0) * 1000
                if let lead {
                    guard let words, let cut = NephisFlow.leadInCut(words: words, lead: lead, piece: text, levels: NephisFlow.levels(audio)) else { continue }
                    latents.removeFirst(cut)
                    audio.removeFirst(min(audio.count, cut * NephisFlow.samplesPerLatent))
                    match = NephisFlow.wordMatch(words, text: text, from: Double(cut) * NephisFlow.latentSeconds)
                } else if let words {
                    match = NephisFlow.wordMatch(words, text: text)
                }
            }
            let score = context.isEmpty ? 0 : NephisFlow.jumpScore(take: audio, context: context)
            takes.append(Take(latents: latents, audio: audio, match: match, score: score))
        }
        if takes.isEmpty {
            // No take with a clean lead-in cut: read the paragraph on its own.
            let latents = try await render(manager, voice: voice, text: text, temperature: temperature, seed: seed)
            try await scratch.reset()
            takes = [Take(latents: latents, audio: try await scratch.decode(latents), match: 1, score: 0)]
        } else {
            report.leadIn = lead != nil
        }
        report.usable = takes.count
        let exact = takes.filter { $0.match >= 0.98 }
        let best = (exact.isEmpty ? [takes.max { $0.match < $1.match }!] : exact).min { $0.score < $1.score }!
        report.wordMatch = transcriber == nil ? nil : best.match
        report.jumpScore = context.isEmpty ? nil : best.score

        // Edit the stream before any audio exists.
        var latents = best.latents
        var levels = NephisFlow.levels(best.audio)
        if !started {
            let drop = NephisFlow.openingDrop(levels)
            latents.removeFirst(drop)
            levels.removeFirst(drop)
        }
        let silence = NephisFlow.silence(levels)
        if started { NephisFlow.cleanClicks(&latents, levels: &levels, from: 0, to: max(0, silence.head - 1)) }
        NephisFlow.cleanClicks(&latents, levels: &levels, from: min(levels.count, levels.count - silence.tail + 1), to: levels.count)
        var stream = started && !pendingTail.isEmpty
            ? NephisFlow.join(tail: pendingTail, next: latents, head: silence.head, pause: line.pauseBefore ?? 0.6)
            : latents
        // This call's trailing silence waits for the next call's join (unless it is the read's last call).
        let keep = line.flowLast == true ? 0 : min(silence.tail, stream.count)
        pendingTail = Array(stream.suffix(keep))
        stream.removeLast(keep)
        let d0 = Date()
        let samples = try await decoder.decode(stream)
        report.decodeMs += Date().timeIntervalSince(d0) * 1000

        carry = Array((carry + best.latents).suffix(NephisFlow.carryFrames))
        context = Array(best.audio.suffix(3 * NephisFlow.sampleRate))
        lastText = text
        lastClip = clip
        started = true
        let total = Date().timeIntervalSince(t0) * 1000
        lastReport = report
        return ExpressiveAudio(samples: samples, sampleRate: NephisFlow.sampleRate, synthMs: total, firstAudioMs: total, chunks: report.takes)
    }

    /// One take: latents only (the session doesn't decode them).
    private func render(_ manager: PocketTtsManager, voice: PocketTtsVoiceData, text: String, temperature: Float, seed: UInt64?) async throws -> [[Float]] {
        let session = try await manager.makeSession(voiceData: voice, temperature: temperature, seed: seed)
        await session.setDecodesAudio(false)
        session.enqueue(text)
        session.finish()
        var latents: [[Float]] = []
        for try await frame in session.frames where frame.latent.count == NephisFlow.latentDim { latents.append(frame.latent) }
        return latents
    }

    /// The last sentence of a text (the lead-in for the next call).
    static func lastSentence(_ text: String) -> String {
        let parts = text.split(omittingEmptySubsequences: true) { $0 == "\n" }.joined(separator: " ")
        guard let r = parts.range(of: "[.!?…][\"'”’]?\\s+(?=[^\\s])", options: [.regularExpression, .backwards]) else { return parts }
        return String(parts[r.upperBound...]).trimmingCharacters(in: .whitespaces)
    }
}
