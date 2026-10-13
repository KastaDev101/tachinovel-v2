//
//  NephisFlowSynth.swift — Pocket TTS reading as Nephis, as one continuous read (ExpressiveCore/NephisFlow.swift
//  explains the method). Calls must come in reading order: each one continues from the previous (carry-over voice
//  prompt, lead-in, the join into it), and the audio returned for a call starts with the pause before it (her fade-out
//  after the last word ends the call before).
//
//  Needs the vendored FluidAudio's latent access (ios/App/Vendor/FluidAudio/README.md): sessions yield latents only,
//  one PocketTtsLatentDecoder decodes the whole read, a second one (reset per take) decodes takes for analysis. In her
//  studio's reads a third one tells the end guard how loud a piece still is where Pocket would stop (studio audit A6).
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
//  Memory (crash plan 2026-10-12, build 321 closed by iOS for memory):
//  - a release frees: `unload` cancels the load, her studio's load, the prepares and the decodes still running (each
//    checks between its steps, and her studio between vocoder windows), and a load that finishes after it keeps nothing
//    (LoadGeneration); an engine once released never loads again; `unloadAndWait` returns once they have let go of the
//    models;
//  - her studio's models load in the background once Pocket is up (not inside `load`, never in a call's path), only
//    with ~1,000 MB free, and are dropped when free memory falls under ~500 MB; the calls meanwhile play her plain sound
//    at the studio's rate, with the reason in the call log ("loading", "memory: 480 MB free").
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
        /// The pack's studio (`Models/nephis-studio`, NephisStudio.swift): her 44.1 kHz sound from Mimi's 24 kHz
        /// decode. nil = no studio, the stream stays 24 kHz exactly as before.
        public let studioDirectory: URL?
        public init(calm: PocketVoice, moods: [String: PocketVoice], projection: NephisFlow.Projection, modelsDirectory: URL? = nil,
                    chain: NephisFlow.Chain = .init(), studioDirectory: URL? = nil) {
            self.calm = calm
            self.moods = moods
            self.projection = projection
            self.modelsDirectory = modelsDirectory
            self.chain = chain
            self.studioDirectory = studioDirectory
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
        /// Her studio on this call (the player's log). `studioRead`: the read runs through the studio, so the stream is
        /// at its rate and decode set the call's whole tone (the player adds no EQ). `studioUsed`: the call is her
        /// studio sound; otherwise `bypassReason` says why it is Mimi's sound with the read's own EQ ("hurry", "heat",
        /// "empty", "failed: …", "loading": its models still loading, "memory: 480 MB free": dropped or not loaded for
        /// lack of memory). Without a studio: false, false, nil.
        public var studioRead = false
        public var studioUsed = false
        public var bypassReason: String?
        /// The call's sample rate, and the mood it was read in (her mood names; a role without a mood reads calm).
        public var sampleRate = NephisFlow.sampleRate
        public var mood = "calm"
        /// How her pieces ended (studio audit A6), for the take kept for each piece: pieces read, and those whose last
        /// latent was still above -40 dBFS when Pocket stopped (a hard cut: measured on every read, guard or not).
        /// With the end guard (`endGuard`: her studio's reads only), the text chunks it ran on past their usual stop,
        /// the latents it added and the end-of-speech signals it ignored before step 6.
        public var pieces = 0
        public var piecesEndingAudible = 0
        public var tailsExtended = 0
        public var extraLatents = 0
        public var earlyEos = 0
        public var endGuard = false
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
        /// Skip the studio for this call (ExpressiveLine.studio == false: playback is short of audio).
        var hurry = false
    }

    private let assets: Assets
    private var transcriber: NephisTranscriber?
    /// Memory left before iOS closes the app, MB (os_proc_available_memory, from the app); nil = unknown, never refuses.
    private let freeMemoryMB: @Sendable () -> Double?
    private var manager: PocketTtsManager?
    private var decoder: PocketTtsLatentDecoder?
    private var scratch: PocketTtsLatentDecoder?
    /// Her studio's settings (studio.json, read at load) when the pack ships one: the read is then at its rate (44.1
    /// kHz) and her pieces get the end guard, whether its models are loaded or not.
    private var studioConfig: NephisStudio.Config?
    /// Her studio's models: loaded in the background behind Pocket's (startStudioLoad), dropped when memory runs low.
    private var studio: NephisStudio?
    /// Her studio's models loading (no call waits for it): a release cancels it, `unloadAndWait` waits for it.
    private var studioLoading: Task<Void, Never>?
    /// Why her studio's models aren't loaded now (low memory, a failed load), and the wait before they may load again.
    private var studioOff: String?
    private var studioHold = MemoryHold(base: 120, cap: 1_200)
    /// Her studio's reads only: decodes the latents the end guard asks about (PocketTtsSynthesizer.levelProbe).
    private var tailDecoder: PocketTtsLatentDecoder?
    /// The stream decodes, one after the other in call order.
    private var decodes: Task<Void, Never>?
    /// The load running, and the releases it must see (a release during a load keeps nothing: crash plan a3).
    private var loading: Task<Double, Error>?
    private var generation = LoadGeneration()
    /// The calls being prepared and decoded (they hold the models while they run): a release cancels them.
    private var prepareJobs: [Int: Task<Prepared, Error>] = [:]
    private var decodeJobs: [Int: Task<Decoded, Error>] = [:]
    private var jobCount = 0

    // The read so far.
    private var carry: [[Float]] = []
    private var pendingTail: [[Float]] = []
    /// The levels of `pendingTail` (where her fade-out dies away).
    private var pendingTailLevels: [Double] = []
    /// The first latents of `pendingTail` already decoded with the call before: her fade-out after its last word.
    private var pendingDecoded = 0
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
    /// A piece whose last latent is louder than this (dBFS) when Pocket stops was cut off, not finished (A6).
    static let audibleEndDB = -40.0

    public init(assets: Assets, transcriber: NephisTranscriber? = nil, freeMemoryMB: @escaping @Sendable () -> Double? = { nil }) {
        self.assets = assets
        self.transcriber = transcriber
        self.freeMemoryMB = freeMemoryMB
    }

    public func setTranscriber(_ t: NephisTranscriber?) {
        transcriber = t
    }

    public func load() async throws -> Double {
        if manager != nil { return 0 }
        // Released before it loaded (ExpressiveService makes a new engine for every load): it never loads afterwards, so
        // a load that was queued behind a release keeps nothing (crash plan a3).
        guard generation.value == 0 else { throw ExpressiveEngineError.released }
        let t0 = Date()
        // A second caller waits for the load already running instead of loading her twice.
        if let loading {
            _ = try await loading.value
            return Date().timeIntervalSince(t0) * 1000
        }
        let ticket = generation.ticket
        let job = Task { try await self.loadNow(ticket) }
        loading = job
        defer { if generation.current(ticket) { loading = nil } }
        let ms = try await job.value
        try keep(ticket)
        // Her studio's models load behind Pocket's, in the background: no call waits for them (crash plan b1).
        startStudioLoad()
        return ms
    }

    /// Pocket's models into locals, kept only if no release came in meanwhile (checked after every wait): a release
    /// during a load frees what it made instead of the load installing it afterwards. Her studio's settings only: its
    /// models load afterwards, in the background (startStudioLoad).
    private func loadNow(_ ticket: Int) async throws -> Double {
        let t0 = Date()
        let m = PocketTtsManager(directory: assets.modelsDirectory, placement: .ane, computeUnits: PocketTtsSynth.backgroundSafeUnits)
        try await m.initialize()
        try keep(ticket)
        let d = try await m.makeLatentDecoder()
        try keep(ticket)
        let s = try await m.makeLatentDecoder()
        try keep(ticket)
        let config = try assets.studioDirectory.flatMap { try NephisStudio.readConfig(in: $0) }
        // The end guard's own decoder (it shares the Mimi model; only its state is new).
        var tail: PocketTtsLatentDecoder?
        if config != nil {
            tail = try await m.makeLatentDecoder()
            try keep(ticket)
        }
        manager = m
        decoder = d
        scratch = s
        tailDecoder = tail
        studioConfig = config
        return Date().timeIntervalSince(t0) * 1000
    }

    private func keep(_ ticket: Int) throws {
        guard generation.current(ticket) else { throw ExpressiveEngineError.released }
    }

    /// Drops the models. The load, prepares and decodes still running are cancelled and keep nothing; they let go of
    /// the models at their next check (`unloadAndWait` waits for that).
    public func unload() {
        generation.release()
        loading?.cancel()
        loading = nil
        studioLoading?.cancel()
        studioLoading = nil
        for job in prepareJobs.values { job.cancel() }
        for job in decodeJobs.values { job.cancel() }
        prepareJobs = [:]
        decodeJobs = [:]
        manager = nil
        decoder = nil
        scratch = nil
        studio = nil
        studioConfig = nil
        studioOff = nil
        tailDecoder = nil
        preparing?.cancel()
        preparing = nil
        waiting = nil
        decodes = nil
        forget()
    }

    /// `unload`, returning once what it stopped has ended: the load in progress, her studio's load and the calls running
    /// (they hold the models until then). The studio test and the next load wait for this (crash plan a1, a3).
    public func unloadAndWait() async {
        let load = loading
        let studioLoad = studioLoading
        let prepares = Array(prepareJobs.values)
        let calls = Array(decodeJobs.values)
        unload()
        _ = try? await load?.value
        await studioLoad?.value
        for job in prepares { _ = try? await job.value }
        for job in calls { _ = try? await job.value }
    }

    private func forget() {
        carry = []
        pendingTail = []
        pendingTailLevels = []
        pendingDecoded = 0
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
        let id = nextJob()
        prepareJobs[id] = job
        defer { prepareJobs[id] = nil }
        preparing = job
        waiting = Task { _ = try? await job.value }
        return try await job.value
    }

    private var preparing: Task<Prepared, Error>?
    private var waiting: Task<Void, Never>?

    private func nextJob() -> Int {
        jobCount += 1
        return jobCount
    }

    private func prepareNow(_ line: ExpressiveLine, seed: UInt64?) async throws -> Prepared {
        guard let manager, let scratch else { throw ExpressiveEngineError.notLoaded }
        let t0 = Date()
        let reset = line.flowReset == true
        if reset { forget() }
        var report = Report()
        // The app's text, or the text as written for a pack that asks for it (chain "text": "raw").
        let text = assets.chain.pocketText(for: line)
        // The line's mood read (a mood change blends half the old clip and half the new one: NephisFlow.prompt).
        let clip = (assets.moods[line.role] ?? assets.calm).audioPrompt
        // Pocket generates long text in pieces of about 50 tokens, each started again from the voice prompt: every
        // seam would be a restart nothing edits (an "uh", a mumble in the pause, the tone back at the clip). So the
        // call is read piece by piece here, each one a flow piece of its own: carry-over, joins and clean-up.
        let pieces = try await plan(manager, text: text, clip: clip)
        let mood = assets.moods[line.role] != nil ? line.role : "calm"
        let chain = assets.chain
        // Before the call: her pause after the paragraph before, in its mood (the director's own when it asks for more);
        // inside a paragraph her pause after a sentence; where dialogue hands over, hers there (Chain.callPause).
        let callPause = chain.callPause(pauseBefore: line.pauseBefore, after: lastText, mood: lastMood, next: pieces[0],
                                        handover: line.handover)
        var stream: [[Float]] = []
        var pads: [(at: Int, seconds: Double)] = []
        for (k, piece) in pieces.enumerated() {
            try Task.checkCancellation()
            let pause = k == 0 ? callPause : chain.gap(after: pieces[k - 1], mood: mood)
            let r = try await read(piece, clip: clip, line: line, first: k == 0, last: k == pieces.count - 1, pause: pause,
                                   seed: seed.map { $0 &+ UInt64(16 * k) }, manager: manager, scratch: scratch, report: &report)
            if let at = r.padAt { pads.append((at: stream.count + at, seconds: r.padSeconds)) }
            stream += r.latents
        }
        lastMood = mood
        report.mood = mood
        return Prepared(stream: stream, reset: reset, started: t0, report: report, gainDB: chain.moods[mood]?.gainDB ?? 0, pads: pads,
                        toneDB: chain.moods[mood]?.toneDB ?? 0, hurry: line.studio == false)
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
        // The raw form keeps "..." whole (FluidAudio would end a sentence at each of its dots: ". . .").
        let chunks = try await manager.plannedChunks(text, voiceData: PocketTtsVoiceData(audioPrompt: prompt.frames, promptLength: prompt.count),
                                                     keepsPunctuationRuns: assets.chain.text == .raw)
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
        let lead = first && started && transcriber != nil && line.leadIn != false ? lastText.map(NephisFlow.lastSentence) : nil
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
            /// How its text chunks ended (the end guard's record).
            var ends: [PocketTtsSynthesizer.ChunkEnd]
        }
        var takes: [Take] = []
        for t in 0..<n {
            let said = lead.map { $0 + " " + text } ?? text
            let r = try await render(manager, scratch: scratch, voice: voice, text: said, temperature: temperature,
                                     seed: seed.map { $0 &+ UInt64(t) }, whole: listen || scoring, report: &report)
            var take = Take(latents: r.latents, levels: r.levels, audio: r.audio, endOfText: r.endOfText, match: 1, score: 0, ends: r.ends)
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
            takes = [Take(latents: r.latents, levels: r.levels, audio: r.audio, endOfText: r.endOfText, match: 1, score: 0, ends: r.ends)]
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
        // How the kept take ended, before any edit (A6): still above -40 dBFS where Pocket stopped is a hard cut.
        report.pieces += 1
        if let end = best.levels.last, end > Self.audibleEndDB { report.piecesEndingAudible += 1 }
        for e in best.ends {
            if e.tailExtended { report.tailsExtended += 1 }
            if e.earlyEosStep != nil { report.earlyEos += 1 }
            report.extraLatents += e.extraLatents
        }

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
                                           tailLevels: pendingTailLevels, headLevels: Array(levels.prefix(silence.head)),
                                           decoded: pendingDecoded)
        }
        var stream = joined.latents
        // The trailing silence waits for the next piece's join (unless it is the read's very last piece).
        let keep = last && line.flowLast == true ? 0 : min(silence.tail, stream.count)
        pendingTail = Array(stream.suffix(keep))
        pendingTailLevels = Array(levels.suffix(keep))
        // A call's last piece: her fade-out after the last word (to -68 dB, NephisFlow.fadeOut) is decoded with it. Held
        // back for the next call, it was lost to a fresh read and heard on its own after any wait for that call: a soft
        // final "s" went missing (Kasta, 2026-10-12: "the marching colossus" without its s). The next join still counts
        // it toward the pause (`decoded`): a long pause decodes exactly as before, a short one no longer trims into her
        // fade-out. Pieces inside a call are decoded together anyway: unchanged.
        pendingDecoded = last ? min(keep, NephisFlow.fadeOut(pendingTailLevels)) : 0
        stream.removeLast(keep - pendingDecoded)

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
        try await decodeReporting(p).audio
    }

    /// One call's audio out of the decode queue, and what the studio did with it.
    private struct Decoded: Sendable {
        var samples: [Float]
        var ms = 0.0
        var studioUsed = false
        var bypassReason: String? = nil
    }

    /// `decode`, with this call's report (studio used or why not, rate, mood: the player's log; `lastReport` may
    /// already be a later call's by the time a caller reads it).
    public func decodeReporting(_ p: Prepared) async throws -> (audio: ExpressiveAudio, report: Report) {
        guard let decoder else { throw ExpressiveEngineError.notLoaded }
        let previous = decodes
        let config = studioConfig
        // The studio was trained on the sketch at Mimi's scale (gta_dump.py: latent × std + mean); the stream holds
        // Pocket's normalized latents, which Mimi denormalizes inside its own model (studio audit 2026-10-12, A4).
        let sketch: [[Float]] = config == nil ? [] : assets.projection.denormalized(p.stream)
        // A call the studio skips or fails gets the tone the read without the studio gets (A3).
        let plainTone = NephisFlow.studioTone(studioUsed: false, moodToneDB: p.toneDB, chain: assets.chain)
        // Her studio's models for the call, asked for in call order (the job itself stays off this actor, as before).
        let studioFor: @Sendable (Bool) async -> (studio: NephisStudio?, reason: String?) = { hurry in await self.studioForCall(hurry: hurry) }
        let job = Task { () async throws -> Decoded in
            await previous?.value
            let d0 = Date()
            if p.reset { try await decoder.reset() }
            let mimi = try await decoder.decode(p.stream)
            // Released meanwhile: stop here, and the models go with this call (crash plan a3).
            try Task.checkCancellation()
            var out = Decoded(samples: mimi)
            if let config {  // her 44.1 kHz sound; any studio failure falls back to Mimi's own sound at 44.1 kHz (never a lost call)
                let ready = await studioFor(p.hurry)
                try Task.checkCancellation()
                if let studio = ready.studio {
                    do {
                        let r = try await studio.renderReporting(pcm24: mimi, latents: sketch, hurry: p.hurry, continues: !p.reset)
                        out.samples = r.pcm
                        out.studioUsed = !r.report.bypassed
                        out.bypassReason = out.studioUsed ? nil : r.report.bypassReason ?? "bypassed"
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch {
                        out.bypassReason = "failed: \(error)"
                    }
                } else {
                    out.bypassReason = ready.reason ?? "bypassed"
                }
                if !out.studioUsed {
                    // Mimi's sound with the read's own EQ (the mood's shelf and her Mimi EQ), applied at Mimi's 24 kHz
                    // where it was tuned, then at the studio's rate: the call sounds like the read without the studio.
                    var toned = mimi
                    plainTone.apply(&toned, sampleRate: NephisFlow.sampleRate)
                    out.samples = NephisStudio.plainAudio(pcm24: toned, rate: config.sample_rate)
                }
            }
            out.ms = Date().timeIntervalSince(d0) * 1000
            return out
        }
        let id = nextJob()
        decodeJobs[id] = job
        defer { decodeJobs[id] = nil }
        decodes = Task { _ = try? await job.value }
        let decoded = try await job.value
        // Without a studio everything stays at Mimi's 24 kHz; with one, the pauses and tone follow its rate (whether
        // its models rendered this call or not).
        let rate = config?.sample_rate ?? NephisFlow.sampleRate
        let perLatent = NephisFlow.samplesPerLatent * rate / NephisFlow.sampleRate
        var samples = NephisFlow.insertSilence(decoded.samples, pads: p.pads, sampleRate: rate, samplesPerLatent: perLatent)
        // The mood's tone, for the read without the studio (the player adds her EQ). In a studio read each call's tone
        // was set above: none on her studio sound, the read's own EQ on Mimi's (one owner per path).
        if config == nil { NephisFlow.highShelf(&samples, db: p.toneDB, sampleRate: rate) }
        // Her level for the mood, moved to over the first 200 ms: the call starts in the pause before it, so the
        // change happens in silence (one fixed gain for the stream otherwise: NaturalFinish.renderFlow).
        let from = Float(pow(10, lastGainDB / 20)), to = Float(pow(10, p.gainDB / 20))
        if from != 1 || to != 1 {
            let ramp = min(samples.count, rate / 5)
            for i in samples.indices { samples[i] *= i < ramp ? from + (to - from) * Float(i) / Float(ramp) : to }
        }
        lastGainDB = p.gainDB
        var report = p.report
        report.decodeMs = decoded.ms
        report.totalMs = Date().timeIntervalSince(p.started) * 1000
        report.audioMs = Double(samples.count) * 1000 / Double(rate)
        report.sampleRate = rate
        report.studioRead = config != nil
        report.studioUsed = decoded.studioUsed
        report.bypassReason = decoded.bypassReason
        lastReport = report
        let audio = ExpressiveAudio(samples: samples, sampleRate: rate, synthMs: report.totalMs, firstAudioMs: report.totalMs,
                                    chunks: report.takes)
        return (audio, report)
    }

    // MARK: - Her studio's models (crash plan b1)

    /// Her studio's models for the next call, or nil with the reason the call plays her plain sound instead (its log:
    /// "loading", "hurry", "memory: 480 MB free", "failed: …"). Never waits for them: they load in the background behind
    /// Pocket's (startStudioLoad, again from here after a drop), and the calls meanwhile play her plain sound at the
    /// studio's rate. Dropped when free memory falls under ~500 MB; after a drop or a failed load they wait (2 min,
    /// doubling, back to 2 min once they have worked 5 minutes) before loading again.
    private func studioForCall(hurry: Bool) -> (studio: NephisStudio?, reason: String?) {
        guard assets.studioDirectory != nil else { return (nil, "off") }
        // Released (this call is cancelled, the models gone): nothing loads for it.
        guard manager != nil, !Task.isCancelled else { return (nil, "released") }
        let free = freeMemoryMB()
        if let studio {
            guard NephisMemory.short(.studioKeep, freeMB: free), let free else {
                studioHold.worked(at: Date())
                return (studio, nil)
            }
            dropStudio(NephisMemory.refusal(.studioKeep, freeMB: free))
            return (nil, studioOff)
        }
        // Short of audio: no load started now (it would compete with her generation); the call plays at once.
        if hurry, studioLoading == nil { return (nil, "hurry") }
        return (nil, startStudioLoad() ?? "loading")
    }

    /// Starts loading her studio's models off the calls' path when they may load: Pocket up, no wait after a drop going
    /// on, ~1,000 MB free. The reason her calls play her plain sound meanwhile ("loading", "memory: …", "failed: …").
    @discardableResult
    private func startStudioLoad() -> String? {
        guard let dir = assets.studioDirectory, manager != nil, studio == nil else { return nil }
        if studioLoading != nil { return "loading" }
        if let off = studioOff, studioHold.holds(at: Date()) { return off }
        let free = freeMemoryMB()
        if NephisMemory.short(.studioLoad, freeMB: free), let free {
            dropStudio(NephisMemory.refusal(.studioLoad, freeMB: free))
            return studioOff
        }
        let ticket = generation.ticket
        studioLoading = Task.detached(priority: .utility) { [weak self] in
            let result: Result<NephisStudio?, Error>
            do { result = .success(try await NephisStudio.load(from: dir)) } catch { result = .failure(error) }
            await self?.studioLoaded(result, ticket: ticket)
        }
        return "loading"
    }

    /// Her studio's models are up, or failed to load. Released meanwhile: kept nothing (they go with the task).
    private func studioLoaded(_ result: Result<NephisStudio?, Error>, ticket: Int) {
        guard generation.current(ticket) else { return }
        studioLoading = nil
        switch result {
        case .success(let loaded):
            studio = loaded
            studioOff = loaded == nil ? "missing" : nil
        case .failure(let error):
            dropStudio("failed: \(error)")
        }
    }

    /// Returns once her studio's models loading in the background are up or have failed (at once when none load): the
    /// next big load (the listening test after the studio test, Kokoro's warm-up) never overlaps them.
    public func studioSettled() async {
        await studioLoading?.value
    }

    /// Her studio's models go (low memory, a failed load) for a while; the calls meanwhile play her plain sound at the
    /// studio's rate, with `reason` in the call log.
    private func dropStudio(_ reason: String) {
        studio = nil
        studioOff = reason
        studioHold.release(at: Date())
    }

    // MARK: - One take

    /// One take: its latents (the session doesn't decode them) and the levels of its audio, decoded on the scratch
    /// decoder while the take is generated. `whole`: decode all of it (recognition, the take score); otherwise only
    /// the first `headEdge` latents and the last `tailEdge` (the middle's levels read as speech). `ends`: how each of
    /// its text chunks ended.
    private func render(_ manager: PocketTtsManager, scratch: PocketTtsLatentDecoder, voice: PocketTtsVoiceData, text: String,
                        temperature: Float, seed: UInt64?, whole: Bool, report: inout Report)
        async throws -> (latents: [[Float]], levels: [Double], audio: [Float], endOfText: Int?, ends: [PocketTtsSynthesizer.ChunkEnd]) {
        let r0 = Date()
        let session = try await manager.makeSession(voiceData: voice, temperature: temperature, seed: seed)
        await session.setDecodesAudio(false)
        // The raw form's "..." stays whole when the session chunks a lead-in and its piece (as Kyutai's pocket_tts does).
        if assets.chain.text == .raw { await session.setKeepsPunctuationRuns(true) }
        // Her studio's reads (studio audit 2026-10-12, A6): a piece still above -40 dBFS where Pocket stops runs on until
        // it has died away (two latents under -50 dBFS, at most 6 more), and an end-of-speech signal in its first 6
        // steps is ignored (Kyutai's own loop). The tail decoder measures the level it decides on. Without the studio
        // every piece stops exactly where it always did.
        if studioConfig != nil, let tailDecoder {
            await session.setEndGuard(.audibleTail, levelProbe: PocketTtsSynthesizer.levelProbe(decoder: tailDecoder))
            report.endGuard = true
        }
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
        do {
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
            // Released or a fresh read (the frames end early when the call is cancelled): stop before decoding the rest.
            try Task.checkCancellation()
        } catch {
            // The decodes already sent hold the scratch decoder and the Mimi model (they aren't cancelled with the call):
            // they end before this call does, so a fresh read's reset never races them and a release waits for them.
            _ = try? await analysis?.value
            throw error
        }
        if !batch.isEmpty { send(batch) }
        if !afterEnd { endOfText = nil }
        // Complete: the frames end after the last chunk's end is noted.
        let ends = await session.chunkEnds
        report.renderMs += Date().timeIntervalSince(r0) * 1000
        let a0 = Date()
        defer { report.analysisMs += Date().timeIntervalSince(a0) * 1000 }
        var audio = try await analysis?.value ?? []
        let n = latents.count
        if whole || n <= Self.headEdge {
            return (latents, NephisFlow.levels(audio), audio, endOfText, ends)
        }
        if n <= Self.headEdge + Self.tailEdge + Self.warmUp {
            // Short take: decoding the rest is about as cheap as the tail.
            audio += try await scratch.decode(Array(latents[Self.headEdge...]))
            return (latents, NephisFlow.levels(audio), audio, endOfText, ends)
        }
        let head = NephisFlow.levels(audio)
        try await scratch.reset()
        let tailAudio = Array(try await scratch.decode(Array(latents.suffix(Self.tailEdge + Self.warmUp)))
            .dropFirst(Self.warmUp * NephisFlow.samplesPerLatent))
        let middle = [Double](repeating: 0, count: n - Self.headEdge - Self.tailEdge)
        return (latents, head + middle + NephisFlow.levels(tailAudio), tailAudio, endOfText, ends)
    }
}
