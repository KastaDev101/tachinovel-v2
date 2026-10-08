//
//  NephisFlowSynth.swift — Pocket TTS reading as Nephis, as one continuous read (ExpressiveCore/NephisFlow.swift
//  explains the method). Calls must come in reading order: each one continues from the previous (carry-over voice
//  prompt, lead-in, the join into it), and the audio returned for a call starts with the pause before it.
//
//  Needs the vendored FluidAudio's latent access (ios/App/Vendor/FluidAudio/README.md): sessions yield latents only,
//  one PocketTtsLatentDecoder decodes the whole read, a second one (reset per take) decodes takes for analysis.
//
//  Speed (Kasta's phone runs Pocket at only ~1.5–2× real time, and Mimi decoding is the larger half of that):
//  - a call is two stages: `prepare` (generate, check, edit: the read's state moves on) and `decode` (the one
//    stream). Decodes run in call order on their own, so the next call's generation overlaps this call's decode
//    (the model runs on the Neural Engine, Mimi on the CPU);
//  - the analysis decode runs while the take is still being generated, and only decodes the take's first and last
//    latents (the only ones the edits touch) unless speech recognition or the take score needs all of it;
//  - lead-ins, recognition and extra takes only when the caller can afford them (`ExpressiveLine.leadIn/takes`:
//    HybridSpeechEngine asks for them when playback is far enough ahead).
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
        public var listened = false
        public var wordMatch: Double?
        public var jumpScore: Double?
        /// Generation (with the analysis decode running alongside), the analysis decode left after it, speech
        /// recognition, the stream decode, and the whole call; audio is what the call returned.
        public var renderMs = 0.0
        public var analysisMs = 0.0
        public var recognizeMs = 0.0
        public var decodeMs = 0.0
        public var totalMs = 0.0
        public var audioMs = 0.0
    }

    /// A call whose latents are ready: the stream to decode (edits done) and whether the read starts over.
    public struct Prepared: Sendable {
        let stream: [[Float]]
        let reset: Bool
        let started: Date
        var report: Report
    }

    private let assets: Assets
    private var transcriber: NephisTranscriber?
    private var manager: PocketTtsManager?
    private var decoder: PocketTtsLatentDecoder?
    private var scratch: PocketTtsLatentDecoder?
    /// The stream decodes, one after the other in call order.
    private var decodes: Task<Void, Never>?

    // The read so far.
    private var carry: [[Float]] = []
    private var pendingTail: [[Float]] = []
    private var context: [Float] = []
    private var lastText: String?
    private var lastClip: [Float]?
    private var started = false
    public private(set) var lastReport = Report()

    /// Latents decoded for analysis at each end of a take (the edits never touch the middle), and the latents
    /// decoded before the tail's to warm the decoder up (their audio is dropped).
    static let headEdge = 24
    static let tailEdge = 32
    static let warmUp = 6

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
        preparing?.cancel()
        preparing = nil
        waiting = nil
        decodes = nil
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

    /// Both stages, one after the other (the Voice Lab; Listen calls them separately to overlap them).
    public func synthesize(_ line: ExpressiveLine, seed: UInt64?) async throws -> ExpressiveAudio {
        try await decode(prepare(line, seed: seed))
    }

    // MARK: - Stage 1: the latents

    /// Generates the call's takes, picks one, edits the stream and moves the read on. The next call can be
    /// prepared as soon as this returns, while this one decodes. Calls are prepared one at a time, in the order
    /// they arrive; a fresh read (`flowReset`) cancels a call still being prepared for the old one.
    public func prepare(_ line: ExpressiveLine, seed: UInt64?) async throws -> Prepared {
        if line.flowReset == true { preparing?.cancel() }
        let previous = waiting
        let job = Task { () async throws -> Prepared in
            await previous?.value
            try Task.checkCancellation()
            return try await self.prepareNow(line, seed: seed)
        }
        preparing = job
        waiting = Task { _ = try? await job.value }
        return try await job.value
    }

    private var preparing: Task<Prepared, Error>?
    private var waiting: Task<Void, Never>?

    private func prepareNow(_ line: ExpressiveLine, seed: UInt64?) async throws -> Prepared {
        guard let manager, let scratch else { throw ExpressiveEngineError.notLoaded }
        let t0 = Date()
        let reset = line.flowReset == true
        if reset { forget() }
        var report = Report()
        let text = StyleMapper.pocketText(StyleMapper.plainText(line.text))
        let clip = line.role == "tense" ? (assets.tense ?? assets.calm).audioPrompt : assets.calm.audioPrompt
        let prompt = NephisFlow.prompt(clip: clip, previousClip: lastClip.flatMap { $0 == clip ? nil : $0 },
                                       carry: assets.projection.condition(carry))
        let voice = PocketTtsVoiceData(audioPrompt: prompt.frames, promptLength: prompt.count)
        let temperature = min(0.85, max(0.55, line.temperature ?? 0.7))
        let n = max(1, min(8, line.takes ?? 1))
        let lead = started && transcriber != nil && line.leadIn != false ? lastText.map(Self.lastSentence) : nil
        // Recognition only where it can change something (a lead-in cut, a choice between takes); the take score
        // only between takes. Otherwise the analysis decode only needs the take's ends.
        let listen = transcriber != nil && (lead != nil || n > 1)
        let scoring = n > 1 && !context.isEmpty
        let reference = scoring ? NephisFlow.voiceFeatures(context) : nil

        struct Take {
            var latents: [[Float]]
            var levels: [Double]
            var audio: [Float]
            var match: Double
            var score: Double
        }
        var takes: [Take] = []
        for t in 0..<n {
            let said = lead.map { $0 + " " + text } ?? text
            var take = try await render(manager, scratch: scratch, voice: voice, text: said, temperature: temperature,
                                        seed: seed.map { $0 &+ UInt64(t) }, whole: listen || scoring, report: &report)
            report.takes += 1
            var match = 1.0
            if listen, let transcriber {
                let a0 = Date()
                let words = await transcriber(take.audio, NephisFlow.sampleRate)
                report.recognizeMs += Date().timeIntervalSince(a0) * 1000
                report.listened = true
                if let lead {
                    guard let words, let cut = NephisFlow.leadInCut(words: words, lead: lead, piece: text, levels: take.levels) else { continue }
                    take.latents.removeFirst(cut)
                    take.levels.removeFirst(cut)
                    take.audio.removeFirst(min(take.audio.count, cut * NephisFlow.samplesPerLatent))
                    match = NephisFlow.wordMatch(words, text: text, from: Double(cut) * NephisFlow.latentSeconds)
                } else if let words {
                    match = NephisFlow.wordMatch(words, text: text)
                }
            }
            let score = reference.map { NephisFlow.jumpScore(take: take.audio, reference: $0) } ?? 0
            takes.append(Take(latents: take.latents, levels: take.levels, audio: take.audio, match: match, score: score))
        }
        if takes.isEmpty {
            // No take with a clean lead-in cut: read the paragraph on its own.
            let take = try await render(manager, scratch: scratch, voice: voice, text: text, temperature: temperature, seed: seed,
                                        whole: false, report: &report)
            report.takes += 1
            takes = [Take(latents: take.latents, levels: take.levels, audio: take.audio, match: 1, score: 0)]
        } else {
            report.leadIn = lead != nil
        }
        // A fresh read was asked for meanwhile: this call's audio is never played, and the read's state stays as is.
        try Task.checkCancellation()
        report.usable = takes.count
        let exact = takes.filter { $0.match >= 0.98 }
        let best = (exact.isEmpty ? [takes.max { $0.match < $1.match }!] : exact).min { $0.score < $1.score }!
        report.wordMatch = report.listened ? best.match : nil
        report.jumpScore = scoring ? best.score : nil

        // Edit the stream before any audio exists.
        var latents = best.latents
        var levels = best.levels
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

        carry = Array((carry + best.latents).suffix(NephisFlow.carryFrames))
        context = Array(best.audio.suffix(3 * NephisFlow.sampleRate))
        lastText = text
        lastClip = clip
        started = true
        return Prepared(stream: stream, reset: reset, started: t0, report: report)
    }

    // MARK: - Stage 2: the sound

    /// Decodes a prepared call into the read's one stream, after every call prepared before it.
    public func decode(_ p: Prepared) async throws -> ExpressiveAudio {
        guard let decoder else { throw ExpressiveEngineError.notLoaded }
        let previous = decodes
        let job = Task { () async throws -> (samples: [Float], ms: Double) in
            await previous?.value
            let d0 = Date()
            if p.reset { try await decoder.reset() }
            let samples = try await decoder.decode(p.stream)
            return (samples, Date().timeIntervalSince(d0) * 1000)
        }
        decodes = Task { _ = try? await job.value }
        let (samples, ms) = try await job.value
        var report = p.report
        report.decodeMs = ms
        report.totalMs = Date().timeIntervalSince(p.started) * 1000
        report.audioMs = Double(samples.count) * 1000 / Double(NephisFlow.sampleRate)
        lastReport = report
        return ExpressiveAudio(samples: samples, sampleRate: NephisFlow.sampleRate, synthMs: report.totalMs, firstAudioMs: report.totalMs,
                               chunks: report.takes)
    }

    // MARK: - One take

    /// One take: its latents (the session doesn't decode them) and the levels of its audio, decoded on the scratch
    /// decoder while the take is generated. `whole`: decode all of it (recognition, the take score); otherwise only
    /// the first `headEdge` latents and the last `tailEdge` (the middle's levels read as speech).
    private func render(_ manager: PocketTtsManager, scratch: PocketTtsLatentDecoder, voice: PocketTtsVoiceData, text: String,
                        temperature: Float, seed: UInt64?, whole: Bool, report: inout Report)
        async throws -> (latents: [[Float]], levels: [Double], audio: [Float]) {
        let r0 = Date()
        let session = try await manager.makeSession(voiceData: voice, temperature: temperature, seed: seed)
        await session.setDecodesAudio(false)
        session.enqueue(text)
        session.finish()
        try await scratch.reset()
        var latents: [[Float]] = []
        var batch: [[Float]] = []
        var analysis: Task<[Float], Error>?
        // Hand latents to the scratch decoder in small batches, in order, without waiting for it.
        func send(_ b: [[Float]]) {
            let previous = analysis
            analysis = Task {
                var audio = try await previous?.value ?? []
                audio += try await scratch.decode(b)
                return audio
            }
        }
        for try await frame in session.frames where frame.latent.count == NephisFlow.latentDim {
            latents.append(frame.latent)
            guard whole || latents.count <= Self.headEdge else { continue }
            batch.append(frame.latent)
            if batch.count == 6 {
                send(batch)
                batch = []
            }
        }
        if !batch.isEmpty { send(batch) }
        report.renderMs += Date().timeIntervalSince(r0) * 1000
        let a0 = Date()
        defer { report.analysisMs += Date().timeIntervalSince(a0) * 1000 }
        var audio = try await analysis?.value ?? []
        let n = latents.count
        if whole || n <= Self.headEdge {
            return (latents, NephisFlow.levels(audio), audio)
        }
        if n <= Self.headEdge + Self.tailEdge + Self.warmUp {
            // Short take: decoding the rest is about as cheap as the tail.
            audio += try await scratch.decode(Array(latents[Self.headEdge...]))
            return (latents, NephisFlow.levels(audio), audio)
        }
        let head = NephisFlow.levels(audio)
        try await scratch.reset()
        let tailAudio = Array(try await scratch.decode(Array(latents.suffix(Self.tailEdge + Self.warmUp)))
            .dropFirst(Self.warmUp * NephisFlow.samplesPerLatent))
        let middle = [Double](repeating: 0, count: n - Self.headEdge - Self.tailEdge)
        return (latents, head + middle + NephisFlow.levels(tailAudio), tailAudio)
    }

    /// The last sentence of a text (the lead-in for the next call).
    static func lastSentence(_ text: String) -> String {
        let parts = text.split(omittingEmptySubsequences: true) { $0 == "\n" }.joined(separator: " ")
        guard let r = parts.range(of: "[.!?…][\"'”’]?\\s+(?=[^\\s])", options: [.regularExpression, .backwards]) else { return parts }
        return String(parts[r.upperBound...]).trimmingCharacters(in: .whitespaces)
    }
}
