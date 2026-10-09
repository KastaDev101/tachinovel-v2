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
        /// Her mood reads by line role (PocketVoice.nephisMoods); a missing one reads calm.
        public let moods: [String: PocketVoice]
        public let projection: NephisFlow.Projection
        /// Pocket TTS models trained on her (a Nephis model pack: `<dir>/Models/pocket-tts-coreml/v2.1/english/…`);
        /// nil = Kyutai's released models (downloaded once, cached).
        public let modelsDirectory: URL?
        /// The pack's chain settings (pauses, prompt sizes), tuned with its model; defaults without a pack.
        public let chain: NephisFlow.Chain
        public init(calm: PocketVoice, moods: [String: PocketVoice], projection: NephisFlow.Projection, modelsDirectory: URL? = nil,
                    chain: NephisFlow.Chain = .init()) {
            self.calm = calm
            self.moods = moods
            self.projection = projection
            self.modelsDirectory = modelsDirectory
            self.chain = chain
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
        /// Her level for this call's mood (dB against calm), reached during the pause the call starts with.
        var gainDB = 0.0
        /// True silence spliced into the decoded audio: (latent index in `stream`, seconds). Long pauses aren't
        /// decoded through, which buzzes (NephisFlow.maxBridge).
        var pads: [(at: Int, seconds: Double)] = []
        /// Her tone for the call's mood (NephisFlow.Chain.Mood.toneDB).
        var toneDB = 0.0
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
    /// The levels of `pendingTail` (where her fade-out dies away).
    private var pendingTailLevels: [Double] = []
    private var context: [Float] = []
    private var lastText: String?
    private var lastClip: [Float]?
    /// The mood of the paragraph just read (its paragraph pause follows it), and the level it played at.
    private var lastMood: String?
    private var lastGainDB = 0.0
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
        let m = PocketTtsManager(directory: assets.modelsDirectory, placement: .ane, computeUnits: PocketTtsSynth.backgroundSafeUnits)
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
        pendingTailLevels = []
        context = []
        lastText = nil
        lastClip = nil
        lastMood = nil
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
        // The line's mood read (a mood change blends half the old clip and half the new one: NephisFlow.prompt).
        let clip = (assets.moods[line.role] ?? assets.calm).audioPrompt
        // Pocket generates long text in pieces of about 50 tokens, each started again from the voice prompt: every
        // seam would be a restart nothing edits (an "uh", a mumble in the pause, the tone back at the clip). So the
        // call is read piece by piece here, each one a flow piece of its own: carry-over, joins and clean-up.
        let pieces = try await plan(manager, text: text, clip: clip)
        let mood = assets.moods[line.role] != nil ? line.role : "calm"
        let chain = assets.chain
        // Before a paragraph: her pause after the paragraph before, in its mood; the director's own when it asks for
        // more (a scene break, a title) or there is no paragraph before.
        let director = (line.pauseBefore ?? 0.6) * chain.paragraphGapScale
        let paragraphPause = lastMood.flatMap { chain.moods[$0]?.paragraph }.map { director > 1.3 ? director : $0 } ?? director
        var stream: [[Float]] = []
        var pads: [(at: Int, seconds: Double)] = []
        for (k, piece) in pieces.enumerated() {
            try Task.checkCancellation()
            let pause = k == 0 ? paragraphPause : chain.gap(after: pieces[k - 1], mood: mood)
            let r = try await read(piece, clip: clip, line: line, first: k == 0, last: k == pieces.count - 1, pause: pause,
                                   seed: seed.map { $0 &+ UInt64(16 * k) }, manager: manager, scratch: scratch, report: &report)
            if let at = r.padAt { pads.append((at: stream.count + at, seconds: r.padSeconds)) }
            stream += r.latents
        }
        lastMood = mood
        return Prepared(stream: stream, reset: reset, started: t0, report: report, gainDB: chain.moods[mood]?.gainDB ?? 0, pads: pads,
                        toneDB: chain.moods[mood]?.toneDB ?? 0)
    }

    /// The pause between two pieces of one paragraph: a beat after a sentence, longer after "…" or ":".
    static func sentencePause(after piece: String, chain: NephisFlow.Chain = .init()) -> Double {
        let t = piece.trimmingCharacters(in: .whitespaces)
        return t.hasSuffix("…") || t.hasSuffix("...") || t.hasSuffix(":") ? chain.ellipsisGap : chain.pieceGap
    }

    /// The pieces Pocket would generate `text` in (a sentence split inside stays with the piece it belongs to).
    private func plan(_ manager: PocketTtsManager, text: String, clip: [Float]) async throws -> [String] {
        let prompt = NephisFlow.prompt(clip: clip, previousClip: nil, carry: assets.projection.condition(carry), clipFrames: assets.chain.clipFrames)
        // Planning needs only the tokenizer and the prompt's length: no session, so no voice prefill spent on it.
        let chunks = try await manager.plannedChunks(text, voiceData: PocketTtsVoiceData(audioPrompt: prompt.frames, promptLength: prompt.count))
        var out: [String] = []
        for c in chunks {
            if c.isMidSentence, !out.isEmpty {
                out[out.count - 1] += " " + c.text
            } else {
                out.append(c.text)
            }
        }
        return out.isEmpty ? [text] : out
    }

    /// One piece: its takes (with the lead-in for a call's first piece), the best one, its edits and its join to what
    /// came before. Returns the latents to decode; the piece's trailing silence waits for the next join.
    private func read(_ text: String, clip: [Float], line: ExpressiveLine, first: Bool, last: Bool, pause: Double, seed: UInt64?,
                      manager: PocketTtsManager, scratch: PocketTtsLatentDecoder, report: inout Report) async throws
        -> (latents: [[Float]], padAt: Int?, padSeconds: Double) {
        let prompt = NephisFlow.prompt(clip: clip, previousClip: lastClip.flatMap { $0 == clip ? nil : $0 },
                                       carry: assets.projection.condition(carry), clipFrames: assets.chain.clipFrames)
        let voice = PocketTtsVoiceData(audioPrompt: prompt.frames, promptLength: prompt.count)
        let temperature = min(0.85, max(0.55, line.temperature ?? 0.7))
        let n = max(1, min(8, line.takes ?? 1))
        let lead = first && started && transcriber != nil && line.leadIn != false ? lastText.map(Self.lastSentence) : nil
        // Recognition only where it can change something (a lead-in cut, a choice between takes); the take score
        // only between takes. Otherwise the analysis decode only needs the take's ends.
        let listen = transcriber != nil && (lead != nil || n > 1)
        let scoring = n > 1 && !context.isEmpty
        let reference = scoring ? NephisFlow.voiceFeatures(context) : nil

        struct Take {
            var latents: [[Float]]
            var levels: [Double]
            var audio: [Float]
            var endOfText: Int?
            var match: Double
            var score: Double
        }
        var takes: [Take] = []
        for t in 0..<n {
            let said = lead.map { $0 + " " + text } ?? text
            let r = try await render(manager, scratch: scratch, voice: voice, text: said, temperature: temperature,
                                     seed: seed.map { $0 &+ UInt64(t) }, whole: listen || scoring, report: &report)
            var take = Take(latents: r.latents, levels: r.levels, audio: r.audio, endOfText: r.endOfText, match: 1, score: 0)
            report.takes += 1
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
                    take.endOfText = take.endOfText.map { $0 - cut }
                    take.match = NephisFlow.wordMatch(words, text: text, from: Double(cut) * NephisFlow.latentSeconds)
                } else if let words {
                    take.match = NephisFlow.wordMatch(words, text: text)
                }
            }
            take.score = reference.map { NephisFlow.jumpScore(take: take.audio, reference: $0) } ?? 0
            takes.append(take)
        }
        if takes.isEmpty {
            // No take with a clean lead-in cut: read the piece on its own.
            let r = try await render(manager, scratch: scratch, voice: voice, text: text, temperature: temperature, seed: seed,
                                     whole: false, report: &report)
            report.takes += 1
            takes = [Take(latents: r.latents, levels: r.levels, audio: r.audio, endOfText: r.endOfText, match: 1, score: 0)]
        } else if lead != nil {
            report.leadIn = true
        }
        // A fresh read was asked for meanwhile: this call's audio is never played, and the read's state stays as is.
        try Task.checkCancellation()
        report.usable += takes.count
        let exact = takes.filter { $0.match >= 0.98 }
        let best = (exact.isEmpty ? [takes.max { $0.match < $1.match }!] : exact).min { $0.score < $1.score }!
        report.wordMatch = report.listened ? best.match : nil
        report.jumpScore = scoring ? best.score : nil

        // Edit the stream before any audio exists.
        var latents = best.latents
        var levels = best.levels
        // A mumble once the last word has died away (in the frames Pocket adds after the end of its text).
        if let end = best.endOfText { NephisFlow.cleanTail(&latents, levels: &levels, endOfText: end) }
        // Before the first word: the read's opening "uh", or a mumble before a later piece's first word.
        let drop = started ? NephisFlow.leadingNoise(levels) : NephisFlow.openingDrop(levels)
        latents.removeFirst(drop)
        levels.removeFirst(drop)
        let silence = NephisFlow.silence(levels)
        if started { NephisFlow.cleanClicks(&latents, levels: &levels, from: 0, to: max(0, silence.head - 1)) }
        NephisFlow.cleanClicks(&latents, levels: &levels, from: min(levels.count, levels.count - silence.tail + 1), to: levels.count)
        var joined: (latents: [[Float]], padAt: Int?, padSeconds: Double) = (latents, nil, 0)
        if started && !pendingTail.isEmpty {
            joined = NephisFlow.joinPadded(tail: pendingTail, next: latents, head: silence.head, pause: pause,
                                           tailLevels: pendingTailLevels, headLevels: Array(levels.prefix(silence.head)))
        }
        var stream = joined.latents
        // The trailing silence waits for the next piece's join (unless it is the read's very last piece).
        let keep = last && line.flowLast == true ? 0 : min(silence.tail, stream.count)
        pendingTail = Array(stream.suffix(keep))
        pendingTailLevels = Array(levels.suffix(keep))
        stream.removeLast(keep)

        carry = Array((carry + latents).suffix(assets.chain.carryFrames))
        context = Array(best.audio.suffix(3 * NephisFlow.sampleRate))
        lastText = text
        lastClip = clip
        started = true
        // The pad sits in the pause; the latents kept back for the next join come from the end, after it.
        let padAt = joined.padAt.flatMap { $0 <= stream.count ? $0 : nil }
        return (stream, padAt, padAt == nil ? 0 : joined.padSeconds)
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
        let (decoded, ms) = try await job.value
        var samples = NephisFlow.insertSilence(decoded, pads: p.pads)
        NephisFlow.highShelf(&samples, db: p.toneDB)
        // Her level for the mood, moved to over the first 200 ms: the call starts in the pause before it, so the
        // change happens in silence (one fixed gain for the stream otherwise: NaturalFinish.renderFlow).
        let from = Float(pow(10, lastGainDB / 20)), to = Float(pow(10, p.gainDB / 20))
        if from != 1 || to != 1 {
            let ramp = min(samples.count, NephisFlow.sampleRate / 5)
            for i in samples.indices { samples[i] *= i < ramp ? from + (to - from) * Float(i) / Float(ramp) : to }
        }
        lastGainDB = p.gainDB
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
        async throws -> (latents: [[Float]], levels: [Double], audio: [Float], endOfText: Int?) {
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
        // Where the last piece of text ended (the start of the frames after its end), if the take ends there.
        var endOfText: Int?
        var afterEnd = false
        for try await frame in session.frames where frame.latent.count == NephisFlow.latentDim {
            if frame.afterEos, !afterEnd { endOfText = latents.count }
            afterEnd = frame.afterEos
            latents.append(frame.latent)
            guard whole || latents.count <= Self.headEdge else { continue }
            batch.append(frame.latent)
            if batch.count == 6 {
                send(batch)
                batch = []
            }
        }
        if !batch.isEmpty { send(batch) }
        if !afterEnd { endOfText = nil }
        report.renderMs += Date().timeIntervalSince(r0) * 1000
        let a0 = Date()
        defer { report.analysisMs += Date().timeIntervalSince(a0) * 1000 }
        var audio = try await analysis?.value ?? []
        let n = latents.count
        if whole || n <= Self.headEdge {
            return (latents, NephisFlow.levels(audio), audio, endOfText)
        }
        if n <= Self.headEdge + Self.tailEdge + Self.warmUp {
            // Short take: decoding the rest is about as cheap as the tail.
            audio += try await scratch.decode(Array(latents[Self.headEdge...]))
            return (latents, NephisFlow.levels(audio), audio, endOfText)
        }
        let head = NephisFlow.levels(audio)
        try await scratch.reset()
        let tailAudio = Array(try await scratch.decode(Array(latents.suffix(Self.tailEdge + Self.warmUp)))
            .dropFirst(Self.warmUp * NephisFlow.samplesPerLatent))
        let middle = [Double](repeating: 0, count: n - Self.headEdge - Self.tailEdge)
        return (latents, head + middle + NephisFlow.levels(tailAudio), tailAudio, endOfText)
    }

    /// The last sentence of a text (the lead-in for the next call).
    static func lastSentence(_ text: String) -> String {
        let parts = text.split(omittingEmptySubsequences: true) { $0 == "\n" }.joined(separator: " ")
        guard let r = parts.range(of: "[.!?…][\"'”’]?\\s+(?=[^\\s])", options: [.regularExpression, .backwards]) else { return parts }
        return String(parts[r.upperBound...]).trimmingCharacters(in: .whitespaces)
    }
}
