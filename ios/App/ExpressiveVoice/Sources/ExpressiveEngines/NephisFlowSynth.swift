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
//  Her studio against the clock (2026-10-13: with a studio pack the Voice test played nothing for over a minute; each
//  call's audio waits for the call before it, so one studio call slower than real time held the whole read): a Listen
//  call's studio gives up between its pieces once it can't finish at real time (StudioPace; her plain sound for that call,
//  "slow: 0.4x real time"), and three such calls in a row switch it off for the rest of this engine's life ("studio too
//  slow: …"). Every studio call's numbers go to the app's log (`log`, native.log) and to the call's report.
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
        /// The pack's de-wind cleaner (`Models/nephis-dewind`, NephisDewindModel.swift), used when its chain asks for it
        /// ("dewind"). nil = the pack ships none.
        public let dewindDirectory: URL?
        /// Her dialogue pack (pack role "dialogue"): quoted dialogue reads with it, narration with the pack above. nil =
        /// none: every call reads exactly as before.
        public let dialogue: Dialogue?
        public init(calm: PocketVoice, moods: [String: PocketVoice], projection: NephisFlow.Projection, modelsDirectory: URL? = nil,
                    chain: NephisFlow.Chain = .init(), studioDirectory: URL? = nil, dewindDirectory: URL? = nil, dialogue: Dialogue? = nil) {
            self.calm = calm
            self.moods = moods
            self.projection = projection
            self.modelsDirectory = modelsDirectory
            self.chain = chain
            self.studioDirectory = studioDirectory
            self.dewindDirectory = dewindDirectory
            self.dialogue = dialogue
        }
    }

    /// Her dialogue pack: its Pocket model (the flow model only is used: Mimi, her studio and the de-wind cleaner are the
    /// narrator pack's, voice-independent and shared), its clips, its speaker projection and its chain (pauses, comma
    /// beat, tempo, EQ groups, finishing). docs/expressive-tts.md "Dialogue packs".
    public struct Dialogue: Sendable {
        public let name: String
        public let modelsDirectory: URL
        public let calm: PocketVoice
        /// Every clip of the pack by file name ("nephis-dlg-smug", "nephis-tense", …).
        public let clips: [String: PocketVoice]
        public let projection: NephisFlow.Projection
        public let chain: NephisFlow.Chain
        public init(name: String, modelsDirectory: URL, calm: PocketVoice, clips: [String: PocketVoice], projection: NephisFlow.Projection,
                    chain: NephisFlow.Chain) {
            self.name = name
            self.modelsDirectory = modelsDirectory
            self.calm = calm
            self.clips = clips
            self.projection = projection
            self.chain = chain
        }

        /// The pack has a laugh clip (DialogueClips.laughClip).
        public var laughs: Bool { DialogueClips.laughClip(chain: chain, available: Set(clips.keys)) != nil }

        /// The clip a dialogue span in `mood` reads with, and its name ("calm" for the pack's base clip).
        public func clip(mood: String, laughing: Bool) -> (name: String, voice: PocketVoice) {
            guard let name = DialogueClips.pick(mood: mood, laughing: laughing, chain: chain, available: Set(clips.keys)),
                  let v = clips[name] else { return ("calm", calm) }
            return (name, v)
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
        /// Takes that ran on past their text (no end-of-speech signal: NephisFlow.ranOn), taken again or cut.
        public var ranOn = 0
        /// Her studio's work on the call (2026-10-13): × real time (measured, or projected when it gave up mid-call; nil
        /// when it never ran), blueprint (+ refiner), vocoder and rest time, and vocoder pieces done of those planned.
        /// `studioUnits`: the compute units its models were loaded with; `studioOff`: why it is off for the rest of the
        /// session (too slow), nil while it may run.
        public var studioX: Double?
        public var studioBlueprintMs = 0.0
        public var studioVocoderMs = 0.0
        public var studioRestMs = 0.0
        public var studioPieces = 0
        public var studioPiecesPlanned = 0
        public var studioUnits: String?
        public var studioOff: String?
        /// Her mastering on this call (pack chain "master"): its preset, and the loudness gain it was at (dB). nil: off.
        public var masterPreset: String?
        public var masterGainDB: Double?
        /// Inside `decodeMs` (the Voice speed test's stages): Mimi's decode of the stream, and the work after the sound
        /// was made (breath polish, the tone and studio EQ, the pauses, her level, mastering).
        public var mimiMs = 0.0
        public var postMs = 0.0
        /// Her pack's studio EQ ran on this call (chain "studioEQ": calls her studio rendered only).
        public var studioEQ = false
        /// The tuner's finishing on this call (chain "closeness", "breathAir", "room": every call of hers when on), and its
        /// time (ms, inside `postMs`).
        public var closeness = false
        public var breathAir = false
        public var room = false
        public var finishMs = 0.0
        /// The de-wind cleaner on this call (chain "dewind"): its passes (0: it didn't run), its time (ms, its own stage:
        /// not inside `postMs`), its model and compute units, and why it didn't run when the chain asks for it ("no model
        /// in the pack", "failed: …").
        public var dewindPasses = 0
        public var dewindMs = 0.0
        public var dewindModel: String?
        public var dewindUnits: String?
        public var dewindNote: String?
        /// Inside `dewindMs` (heat batch 1): its network's predictions, the network's inputs and outputs (building and
        /// reading its arrays), and the signal processing around it (resampling, STFT, features, filtering).
        public var dewindPredictMs = 0.0
        public var dewindIOMs = 0.0
        public var dewindDSPMs = 0.0
        /// Mimi's work on the call (heat batch 1): latents decoded by the read's stream decoder (the sound played), by the
        /// analysis decoder (levels for the edits, speech recognition, the take score) and by the end guard's own decoder.
        public var streamLatents = 0
        public var scratchLatents = 0
        public var tailLatents = 0
        /// Rendered at background priority (ExpressiveLine.relaxed: playback had plenty of audio banked); its speed then
        /// says nothing about the phone's (StudioPace, StudioBudget and the extras rule leave it out).
        public var relaxed = false
        /// Her dialogue pack on the call (NephisDialogue.swift; all 0/nil without one): its spans and pieces, the voice
        /// changes (one at the call's start counts when the call before ended in the other voice), its generation time,
        /// latents and characters, the mood and clip it read with, the level match and tempo its spans got, their seconds
        /// of audio and their finishing time, and why the call's dialogue read with the narrator pack instead ("loading",
        /// "memory: 480 MB free", "hurry").
        public var dialogueSpans = 0
        public var dialoguePieces = 0
        public var switches = 0
        public var dialogueRenderMs = 0.0
        public var dialogueLatents = 0
        public var dialogueChars = 0
        public var dialogueMood: String?
        public var dialogueClip: String?
        public var dialogueMatchDB: Double?
        public var dialogueTempo: Double?
        public var dialogueSeconds = 0.0
        public var dialogueFinishMs = 0.0
        public var dialogueNote: String?
        /// The tuner's floor guard on the call (chain "floorGuard").
        public var floorGuard = false
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
        /// A Listen call (ExpressiveLine.studio set): its studio keeps to real time (StudioPace). Drive prep and the
        /// Voice Lab (nil) aren't played as they render: their studio always finishes.
        var paced = false
        /// The first call of the next chapter in the same read: the de-wind cleaner starts afresh there (as at a new read).
        var chapterStart = false
        /// Rendered at background priority (ExpressiveLine.relaxed): its studio's pace doesn't count toward switching the
        /// studio off for the session.
        var relaxed = false
        /// Her dialogue pack in the call: who speaks the call's start (the voice of the read's last piece before it, 0 the
        /// narrator, 1 the dialogue pack), where the voice changes in `stream`, and the mood its dialogue spans read in. No
        /// change and `firstVoice` 0: the call is the narrator's alone and decodes exactly as before.
        var firstVoice = 0
        var switches: [NephisVoiceMix.LatentSwitch] = []
        var dialogueMood = "calm"
        /// The call has a dialogue region (its decode mixes two finishing chains).
        var mixed: Bool { firstVoice == 1 || switches.contains { $0.voice == 1 } }
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
    /// Her studio's pace over Listen's calls, and why it is off for the rest of this engine's life (too slow on this
    /// phone now): it never loads again then. A new engine (every load of hers) starts afresh.
    private var studioPace = StudioPace()
    private var studioTooSlow: String?
    /// Calls her studio has worked on (the log's call numbers).
    private var studioCalls = 0
    /// The app's log (native.log): her studio's load and every call it works on, in one line each.
    private let log: @Sendable (String) -> Void
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
    /// Who said the read's last piece (0 the narrator pack, 1 the dialogue pack): a lead-in only follows the same voice,
    /// and a call that starts in the other voice changes in its opening pause.
    private var lastVoice = 0

    // Her dialogue pack (Assets.dialogue): its Pocket model, loaded behind her studio (no call waits for it: the narrator
    // reads the dialogue meanwhile) and dropped first when memory runs low; its own carry-over and clip; the quotation left
    // open at the last call's end; its own finishing chain over the read; the level match.
    private var dialogueManager: PocketTtsManager?
    private var dialogueLoading: Task<Void, Never>?
    private var dialogueOff: String?
    private var dialogueHold = MemoryHold(base: 120, cap: 1_200)
    private var dialogueCarry: [[Float]] = []
    private var dialogueLastClip: [Float]?
    private var quoteState = QuoteRouter.State()
    private var dialogueCloseness: NephisCloseness?
    private var dialogueFloor: NephisFloorGuard?
    private var dialogueAir: NephisBreathAir?
    private var dialogueRoom: NephisRoom?
    private var dialogueMaster: NephisMaster?
    private var dialogueGainDB = 0.0
    /// The dialogue chain ran to the end of the call before (it carries on: no restart).
    private var dialogueChainRan = false
    private var loudness = NephisLoudnessMatch()
    /// The narrator's floor guard (chain "floorGuard") over the read.
    private var floorGuard: NephisFloorGuard?
    /// Her mastering over the read (pack chain "master"; nil while off): one chain, call after call, so levels, filters
    /// and delay lines carry across the joins (NephisMaster).
    private var master: NephisMaster?
    /// The tuner's finishing over the read (pack chain "closeness", "breathAir", "room"; nil while off): like her
    /// mastering, one chain call after call, so the compressor's look-ahead, the exciter's filters and the room's tail
    /// carry across the joins. A new read starts them fresh.
    private var closeness: NephisCloseness?
    private var breathAir: NephisBreathAir?
    private var room: NephisRoom?
    /// The pack's de-wind cleaner (chain "dewind"), loading or loaded: the network, or nil and why the calls go without
    /// it. Started with her load; the first call that needs it waits for it (compiled once per pack, then ~0.1 s).
    private var dewind: Task<(NephisDewinder?, String?), Never>?
    private var started = false
    public private(set) var lastReport = Report()

    /// Latents decoded for analysis at each end of a take (the edits never touch the middle), and the latents
    /// decoded before the tail's to warm the decoder up (their audio is dropped).
    static let headEdge = 24
    static let tailEdge = 32
    static let warmUp = 6
    /// A piece whose last latent is louder than this (dBFS) when Pocket stops was cut off, not finished (A6).
    static let audibleEndDB = -40.0

    public init(assets: Assets, transcriber: NephisTranscriber? = nil, freeMemoryMB: @escaping @Sendable () -> Double? = { nil },
                log: @escaping @Sendable (String) -> Void = { _ in }) {
        self.assets = assets
        self.transcriber = transcriber
        self.freeMemoryMB = freeMemoryMB
        self.log = log
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
        // The de-wind cleaner loads alongside Pocket (it is small; its first compile overlaps her load).
        startDewindLoad()
        let job = Task { try await self.loadNow(ticket) }
        loading = job
        defer { if generation.current(ticket) { loading = nil } }
        let ms = try await job.value
        try keep(ticket)
        // Her studio's models load behind Pocket's, in the background: no call waits for them (crash plan b1).
        startStudioLoad()
        // Her dialogue pack's model behind her studio's, in the background too (the narrator reads meanwhile).
        startDialogueLoad()
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
        dialogueLoading?.cancel()
        dialogueLoading = nil
        dialogueManager = nil
        dialogueOff = nil
        dewind?.cancel()
        dewind = nil
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
        let dialogueLoad = dialogueLoading
        let dewindLoad = dewind
        let prepares = Array(prepareJobs.values)
        let calls = Array(decodeJobs.values)
        unload()
        _ = try? await load?.value
        await studioLoad?.value
        await dialogueLoad?.value
        _ = await dewindLoad?.value
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
        lastVoice = 0
        dialogueCarry = []
        dialogueLastClip = nil
        quoteState = QuoteRouter.State()
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
        // Her dialogue pack reads the call's quoted dialogue once its model is up (NephisDialogue.swift). Until then, for a
        // call that asks for none (`line.dialogue` false) and for a call without dialogue, the narrator pack reads it all,
        // exactly as before.
        var dialogueNote: String?
        if let dialogue = assets.dialogue {
            let ready: (manager: PocketTtsManager?, note: String?) = line.dialogue == false ? (nil, "off for this call") : dialogueForCall()
            if let dm = ready.manager {
                if let routed = try await prepareRouted(line, seed: seed, started: t0, reset: reset, manager: manager, dialogueManager: dm,
                                                        dialogue: dialogue, scratch: scratch) { return routed }
            } else {
                dialogueNote = ready.note
                quoteState = QuoteRouter.State()
            }
        }
        var report = Report()
        report.relaxed = line.relaxed == true
        report.dialogueNote = dialogueNote
        // The end guard's decoder is used by this call's takes only (prepares run one at a time).
        let tailBefore = await tailDecoder?.latentsDecoded ?? 0
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
        // inside a paragraph her pause after a sentence; where dialogue hands over, hers there; at the next chapter's
        // start, the chapter break (Chain.callPause).
        let callPause = chain.callPause(pauseBefore: line.pauseBefore, after: lastText, mood: lastMood, next: pieces[0].text,
                                        handover: line.handover, chapterStart: line.chapterStart == true)
        var stream: [[Float]] = []
        var pads: [(at: Int, seconds: Double)] = []
        // After a call that ended in her dialogue pack's voice (only with one), the narrator takes over in this call's
        // opening pause (the dialogue chain's tail rings out there).
        let voiceBefore = started ? lastVoice : 0
        var switches: [NephisVoiceMix.LatentSwitch] = []
        for (k, piece) in pieces.enumerated() {
            try Task.checkCancellation()
            // Between pieces her pause after a sentence, or a comma's beat inside a long sentence (Chain.gap).
            let pause = k == 0 ? callPause : chain.gap(after: pieces[k - 1].text, mood: mood)
            let r = try await read(piece.text, open: piece.open, clip: clip, line: line, first: k == 0, last: k == pieces.count - 1, pause: pause,
                                   seed: seed.map { $0 &+ UInt64(16 * k) }, manager: manager, scratch: scratch, report: &report)
            if k == 0, voiceBefore == 1 {
                switches.append(NephisVoiceMix.LatentSwitch(latent: r.switchAt, voice: 0, inPad: r.padAt != nil && r.padAt == r.switchAt))
                report.switches = 1
            }
            if let at = r.padAt { pads.append((at: stream.count + at, seconds: r.padSeconds)) }
            stream += r.latents
        }
        lastMood = mood
        report.mood = mood
        report.tailLatents = max(0, (await tailDecoder?.latentsDecoded ?? 0) - tailBefore)
        var p = Prepared(stream: stream, reset: reset, started: t0, report: report, gainDB: chain.moods[mood]?.gainDB ?? 0, pads: pads,
                         toneDB: chain.moods[mood]?.toneDB ?? 0, hurry: line.studio == false, paced: line.studio != nil,
                         chapterStart: line.chapterStart == true, relaxed: line.relaxed == true)
        p.firstVoice = voiceBefore
        p.switches = switches
        p.dialogueMood = DialogueClips.mood(role: line.role)
        return p
    }

    /// A call with her dialogue pack up: cut into narration and dialogue spans by its quotation marks (QuoteRouter), each
    /// span read by its own voice (the narrator pack, or the dialogue pack with its clip for the mood, its pauses and, with
    /// "dialogueCommaBeat", its clause pause at each comma and dash), every piece joined into the one stream as always, and
    /// where the voice changes noted for the decode (its two finishing chains). nil when the call has no dialogue: the
    /// narrator path reads it, exactly as before.
    private func prepareRouted(_ line: ExpressiveLine, seed: UInt64?, started t0: Date, reset: Bool, manager: PocketTtsManager,
                               dialogueManager dm: PocketTtsManager, dialogue d: Dialogue, scratch: PocketTtsLatentDecoder) async throws -> Prepared? {
        let chain = assets.chain
        let dchain = d.chain
        // The narrator pack's text form decides the spans (the quotation marks are the same in both forms).
        func written(_ form: PocketTextForm) -> String {
            StyleMapper.pocketText(StyleMapper.plainText(form == .raw ? (line.raw ?? line.text) : line.text), form: form)
        }
        let context = QuoteRouter.Context(singleQuotes: line.singleQuotes.flatMap(QuoteRouter.SingleQuotes.init(rawValue:)),
                                          restOfParagraph: line.restOfParagraph, nextOpensQuote: line.nextOpensQuote,
                                          thoughtsAsDialogue: dchain.thoughtsAsDialogue, keepLaughter: d.laughs)
        let before = quoteState
        var state = before
        var spans = QuoteRouter.split(written(chain.text), state: &state, context: context)
        quoteState = state
        guard spans.contains(where: \.dialogue) else { return nil }
        // A dialogue pack that reads the other text form gets its spans in that form (they line up span for span).
        if dchain.text != chain.text {
            var other = before
            let theirs = QuoteRouter.split(written(dchain.text), state: &other, context: context)
            if theirs.map(\.dialogue) == spans.map(\.dialogue) {
                for k in spans.indices where spans[k].dialogue { spans[k].text = theirs[k].text }
            }
        }
        var report = Report()
        report.relaxed = line.relaxed == true
        report.dialogueSpans = spans.filter(\.dialogue).count
        let tailBefore = await tailDecoder?.latentsDecoded ?? 0
        // The narrator's mood read, as on the narrator path; the dialogue pack's mood: the director's (calm without one).
        let mood = assets.moods[line.role] != nil ? line.role : "calm"
        let dmood = DialogueClips.mood(role: line.role)
        let narratorClip = (assets.moods[line.role] ?? assets.calm).audioPrompt
        // Every piece of the call in order: its text, its voice and clip, its span, and whether a comma beat comes before it.
        struct Planned {
            var text: String
            var midSentence: Bool
            var speaker: Int
            var clip: [Float]
            var span: Int
            var beat: Bool
        }
        var planned: [Planned] = []
        for (k, span) in spans.enumerated() {
            let speaker = span.dialogue ? 1 : 0
            var clip = narratorClip
            if span.dialogue {
                let c = d.clip(mood: dmood, laughing: QuoteRouter.laughs(span.text))
                clip = c.voice.audioPrompt
                report.dialogueClip = report.dialogueClip.map { $0.contains(c.name) ? $0 : $0 + ", " + c.name } ?? c.name
            }
            let voiceChain = span.dialogue ? dchain : chain
            let text = voiceChain.respelled(span.text)
            let parts = span.dialogue && dchain.dialogueCommaBeat ? QuoteRouter.commaBeats(text) : [text]
            for (b, part) in parts.enumerated() {
                let chunks = try await plannedChunks(span.dialogue ? dm : manager, text: part, clip: clip, speaker: speaker, raw: voiceChain.text == .raw)
                for (c, chunk) in chunks.enumerated() {
                    // A piece goes on from the one before when that one ended mid-sentence ("Come here," | she whispered)
                    // or it starts in lower case (| "now."); inside a part, as Pocket chunked it.
                    let goesOn = c > 0 ? chunk.isMidSentence
                        : (planned.last.map { NephisFlow.endsMidSentence($0.text) } ?? false) || chunk.text.first?.isLowercase == true
                    planned.append(Planned(text: chunk.text, midSentence: goesOn, speaker: speaker, clip: clip, span: k, beat: c == 0 && b > 0))
                }
            }
        }
        guard !planned.isEmpty else { return nil }
        let pieces = NephisFlow.plannedPieces(planned.map { (text: $0.text, isMidSentence: $0.midSentence) })
        // Before the call: the pause of the voice that spoke last (its chain, its mood), a hand-over where the voice changes.
        let lastChain = lastVoice == 1 ? dchain : chain
        let inferred: NephisFlow.Handover? = started && lastVoice != planned[0].speaker ? .narration : nil
        let callPause = lastChain.callPause(pauseBefore: line.pauseBefore, after: lastText, mood: lastMood, next: pieces[0].text,
                                            handover: line.handover ?? inferred, chapterStart: line.chapterStart == true)
        let firstVoice = started ? lastVoice : planned[0].speaker
        var current = firstVoice
        var stream: [[Float]] = []
        var pads: [(at: Int, seconds: Double)] = []
        var switches: [NephisVoiceMix.LatentSwitch] = []
        for (k, piece) in pieces.enumerated() {
            try Task.checkCancellation()
            let who = planned[k]
            let pause: Double
            if k == 0 {
                pause = callPause
            } else {
                // After a piece: its voice's pause in its mood. Inside a span her pause after a sentence or a comma's beat (the
                // mood's `clause` at a comma beat); where the voice changes, a comma's beat when the sentence goes on
                // ("Come here," she whispered), else her hand-over pause.
                let prev = planned[k - 1]
                let pc = prev.speaker == 1 ? dchain : chain
                let pm = prev.speaker == 1 ? dmood : mood
                if who.span == prev.span {
                    pause = who.beat ? pc.clausePause(mood: pm) : pc.gap(after: prev.text, mood: pm)
                } else if NephisFlow.endsMidSentence(prev.text) {
                    pause = pc.clausePause(mood: pm)
                } else {
                    pause = pc.handoverPause(after: prev.text, mood: pm, kind: prev.speaker == who.speaker ? .sameSpeaker : .narration)
                }
            }
            let render0 = report.renderMs
            let r = try await read(piece.text, open: piece.open, clip: who.clip, line: line, first: k == 0, last: k == pieces.count - 1, pause: pause,
                                   seed: seed.map { $0 &+ UInt64(16 * k) }, manager: who.speaker == 1 ? dm : manager, scratch: scratch,
                                   report: &report, speaker: who.speaker, raw: (who.speaker == 1 ? dchain : chain).text == .raw)
            if who.speaker == 1 {
                report.dialogueRenderMs += report.renderMs - render0
                report.dialoguePieces += 1
                report.dialogueLatents += r.generated
                report.dialogueChars += piece.text.count
            }
            if who.speaker != current {
                switches.append(NephisVoiceMix.LatentSwitch(latent: stream.count + r.switchAt, voice: who.speaker, inPad: r.padAt != nil && r.padAt == r.switchAt))
                current = who.speaker
            }
            if let at = r.padAt { pads.append((at: stream.count + at, seconds: r.padSeconds)) }
            stream += r.latents
        }
        lastMood = mood
        report.mood = mood
        report.dialogueMood = dmood
        report.switches = switches.count
        report.tailLatents = max(0, (await tailDecoder?.latentsDecoded ?? 0) - tailBefore)
        var p = Prepared(stream: stream, reset: reset, started: t0, report: report, gainDB: chain.moods[mood]?.gainDB ?? 0, pads: pads,
                         toneDB: chain.moods[mood]?.toneDB ?? 0, hurry: line.studio == false, paced: line.studio != nil,
                         chapterStart: line.chapterStart == true, relaxed: line.relaxed == true)
        p.firstVoice = firstVoice
        p.switches = switches
        p.dialogueMood = dmood
        return p
    }

    /// The pause between two pieces of one paragraph: a beat after a sentence, longer after "…" or ":".
    static func sentencePause(after piece: String, chain: NephisFlow.Chain = .init()) -> Double {
        let t = piece.trimmingCharacters(in: .whitespaces)
        return t.hasSuffix("…") || t.hasSuffix("...") || t.hasSuffix(":") ? chain.ellipsisGap : chain.pieceGap
    }

    /// The pieces Pocket would generate `text` in, each read as a flow piece of its own: a sentence too long for one
    /// generation comes in parts that are read as parts of one sentence and joined at a comma's beat
    /// (NephisFlow.plannedPieces; merged into one piece, Pocket restarted mid-sentence inside its take).
    private func plan(_ manager: PocketTtsManager, text: String, clip: [Float]) async throws -> [NephisFlow.PlannedPiece] {
        let prompt = NephisFlow.prompt(clip: clip, previousClip: nil, carry: assets.projection.condition(carry), clipFrames: assets.chain.clipFrames)
        // Planning needs only the tokenizer and the prompt's length: no session, so no voice prefill spent on it.
        // The raw form keeps "..." whole (FluidAudio would end a sentence at each of its dots: ". . .").
        let chunks = try await manager.plannedChunks(text, voiceData: PocketTtsVoiceData(audioPrompt: prompt.frames, promptLength: prompt.count),
                                                     keepsPunctuationRuns: assets.chain.text == .raw)
        let out = NephisFlow.plannedPieces(chunks.map { (text: $0.text, isMidSentence: $0.isMidSentence) })
        return out.isEmpty ? [NephisFlow.PlannedPiece(text: text, open: false)] : out
    }

    /// Pocket's chunks of `text` for `speaker`'s prompt (its clip and carry-over: the prompt's length sets the chunk size),
    /// as `plan` makes them for the narrator.
    private func plannedChunks(_ manager: PocketTtsManager, text: String, clip: [Float], speaker: Int, raw: Bool) async throws
        -> [(text: String, isMidSentence: Bool)] {
        let dialogue = speaker == 1 ? assets.dialogue : nil
        let carried = (dialogue?.projection ?? assets.projection).condition(dialogue != nil ? dialogueCarry : carry)
        let prompt = NephisFlow.prompt(clip: clip, previousClip: nil, carry: carried, clipFrames: (dialogue?.chain ?? assets.chain).clipFrames)
        let chunks = try await manager.plannedChunks(text, voiceData: PocketTtsVoiceData(audioPrompt: prompt.frames, promptLength: prompt.count),
                                                     keepsPunctuationRuns: raw)
        let out = chunks.map { (text: $0.text, isMidSentence: $0.isMidSentence) }
        return out.isEmpty ? [(text: text, isMidSentence: false)] : out
    }

    /// Takes rendered again when one runs on past its text (NephisFlow.ranOn) before the last one is cut instead.
    static let runawayRetakes = 2

    /// The first words of a piece, for the log.
    static func snippet(_ text: String) -> String {
        let words = text.split(whereSeparator: \.isWhitespace)
        return "\"" + words.prefix(6).joined(separator: " ") + (words.count > 6 ? "…" : "") + "\""
    }

    /// One piece: its takes (with the lead-in for a call's first piece), the best one, its edits and its join to what
    /// came before. Returns the latents to decode; the piece's trailing silence waits for the next join. `open`: part
    /// of a longer sentence (NephisFlow.PlannedPiece). Each piece's edits and join go to the app's log (car ride
    /// 2026-10-13: seams heard mid-sentence and on "s" sounds; the log shows where each one is).
    /// `speaker`: who reads the piece (0 her narrator pack, 1 her dialogue pack: its own prompt, carry-over and model, the
    /// shared stream). A lead-in only when the piece before was the same voice's. `raw`: the piece is in the raw text form.
    /// Also returns the latents the take had (`generated`) and where in the returned latents a voice change before the
    /// piece goes (`switchAt`: the middle of its pause, or the true silence spliced in there).
    private func read(_ text: String, open: Bool, clip: [Float], line: ExpressiveLine, first: Bool, last: Bool, pause: Double, seed: UInt64?,
                      manager: PocketTtsManager, scratch: PocketTtsLatentDecoder, report: inout Report, speaker: Int = 0, raw: Bool? = nil) async throws
        -> (latents: [[Float]], padAt: Int?, padSeconds: Double, generated: Int, switchAt: Int) {
        let dialogue = speaker == 1 ? assets.dialogue : nil
        let projection = dialogue?.projection ?? assets.projection
        let voiceChain = dialogue?.chain ?? assets.chain
        let voiceCarry = dialogue != nil ? dialogueCarry : carry
        let voiceLastClip = dialogue != nil ? dialogueLastClip : lastClip
        let prompt = NephisFlow.prompt(clip: clip, previousClip: voiceLastClip.flatMap { $0 == clip ? nil : $0 },
                                       carry: projection.condition(voiceCarry), clipFrames: voiceChain.clipFrames)
        let voice = PocketTtsVoiceData(audioPrompt: prompt.frames, promptLength: prompt.count)
        let rawForm = raw ?? (assets.chain.text == .raw)
        let temperature = min(0.85, max(0.55, line.temperature ?? 0.7))
        let n = max(1, min(8, line.takes ?? 1))
        let lead = first && started && lastVoice == speaker && transcriber != nil && line.leadIn != false ? lastText.map(NephisFlow.lastSentence) : nil
        // Recognition only where it can change something (a lead-in cut, a choice between takes); the take score
        // only between takes. Otherwise the analysis decode only needs the take's ends.
        let listen = transcriber != nil && (lead != nil || n > 1)
        let scoring = n > 1 && !context.isEmpty
        let reference = scoring ? NephisFlow.voiceFeatures(context) : nil

        struct Take {
            var latents: [[Float]]
            var levels: [Double]
            /// Each latent's hiss (NephisFlow.hiss; 0 where not decoded): a word's "s" is never edited as silence or noise.
            var hiss: [Double]
            var audio: [Float]
            var endOfText: Int?
            var match: Double
            var score: Double
            /// How its text chunks ended (the end guard's record).
            var ends: [PocketTtsSynthesizer.ChunkEnd]
            /// It ran on past its text and was cut where the text should have ended.
            var cutRunaway = false

            mutating func dropFirst(_ k: Int) {
                latents.removeFirst(min(k, latents.count))
                levels.removeFirst(min(k, levels.count))
                hiss.removeFirst(min(k, hiss.count))
                audio.removeFirst(min(audio.count, k * NephisFlow.samplesPerLatent))
                endOfText = endOfText.map { $0 - k }
            }
        }
        let wordCount = text.split(whereSeparator: \.isWhitespace).count
        // A take that runs on past its text (no end of speech: the model says it again or mumbles on, nothing trims it)
        // is taken again, at most `runawayRetakes` times; one that still runs on is cut at the first real pause after
        // the text's length (decoded whole for that). Car ride 2026-10-13: a chapter title, read alone at the start of
        // a chapter, was heard twice.
        func ranOn(_ r: (latents: [[Float]], levels: [Double], hiss: [Double], audio: [Float], endOfText: Int?, ends: [PocketTtsSynthesizer.ChunkEnd]),
                   _ runaways: inout Int) -> Bool {
            guard NephisFlow.ranOn(eosSteps: r.ends.map(\.eosStep)) else { return false }
            report.ranOn += 1
            runaways += 1
            log("flow: take of \(Self.snippet(text)) ran on past its text (\(r.latents.count) latents, no end of speech)"
                + (runaways <= Self.runawayRetakes ? "; taken again" : "; cut after the text"))
            return true
        }
        func cutRunaway(_ take: inout Take) {
            guard let end = NephisFlow.runawayEnd(levels: take.levels, words: wordCount), end < take.latents.count else { return }
            let extra = take.latents.count - end
            take.latents.removeLast(extra)
            take.levels.removeLast(min(extra, take.levels.count))
            take.hiss.removeLast(min(extra, take.hiss.count))
            take.audio = Array(take.audio.prefix(end * NephisFlow.samplesPerLatent))
            take.endOfText = nil
            take.cutRunaway = true
        }
        var takes: [Take] = []
        var runaways = 0
        var t = 0
        while t < n + min(runaways, Self.runawayRetakes) {
            let said = lead.map { $0 + " " + text } ?? text
            let r = try await render(manager, scratch: scratch, voice: voice, text: said, open: open, temperature: temperature,
                                     seed: seed.map { $0 &+ UInt64(t) }, whole: listen || scoring || runaways > 0, raw: rawForm, report: &report)
            t += 1
            report.takes += 1
            let ran = ranOn(r, &runaways)
            if ran, runaways <= Self.runawayRetakes { continue }
            var take = Take(latents: r.latents, levels: r.levels, hiss: r.hiss, audio: r.audio, endOfText: r.endOfText, match: 1, score: 0,
                            ends: r.ends)
            if listen, let transcriber {
                let a0 = Date()
                let words = await transcriber(take.audio, NephisFlow.sampleRate)
                report.recognizeMs += Date().timeIntervalSince(a0) * 1000
                report.listened = true
                if let lead {
                    guard let words, let cut = NephisFlow.leadInCut(words: words, lead: lead, piece: text, levels: take.levels) else { continue }
                    take.dropFirst(cut)
                    take.match = NephisFlow.wordMatch(words, text: text, from: Double(cut) * NephisFlow.latentSeconds)
                } else if let words {
                    take.match = NephisFlow.wordMatch(words, text: text)
                }
            }
            if ran { cutRunaway(&take) }
            take.score = reference.map { NephisFlow.jumpScore(take: take.audio, reference: $0) } ?? 0
            takes.append(take)
        }
        if takes.isEmpty {
            // No take with a clean lead-in cut: read the piece on its own.
            var alone = 0
            var r = try await render(manager, scratch: scratch, voice: voice, text: text, open: open, temperature: temperature, seed: seed,
                                     whole: false, raw: rawForm, report: &report)
            report.takes += 1
            while ranOn(r, &alone), alone <= Self.runawayRetakes {
                r = try await render(manager, scratch: scratch, voice: voice, text: text, open: open, temperature: temperature,
                                     seed: seed.map { $0 &+ UInt64(100 + alone) }, whole: true, raw: rawForm, report: &report)
                report.takes += 1
            }
            var take = Take(latents: r.latents, levels: r.levels, hiss: r.hiss, audio: r.audio, endOfText: r.endOfText, match: 1, score: 0,
                            ends: r.ends)
            if alone > Self.runawayRetakes { cutRunaway(&take) }
            takes = [take]
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
        var hiss = best.hiss
        // A mumble once the last word has died away (in the frames Pocket adds after the end of its text).
        if let end = best.endOfText { NephisFlow.cleanTail(&latents, levels: &levels, endOfText: end) }
        // Before the first word: the read's opening "uh", or a mumble before a later piece's first word; never the hiss
        // of a word that opens with "s" (the "s" of "Still", with the "t"'s closure after it, looked like an "uh").
        let drop = started ? NephisFlow.leadingNoise(levels, hiss: hiss) : NephisFlow.openingDrop(levels, hiss: hiss)
        latents.removeFirst(drop)
        levels.removeFirst(drop)
        hiss.removeFirst(min(drop, hiss.count))
        // A soft "s" at either end is part of its word, never silence the join trims or blends.
        let silence = NephisFlow.silence(levels, hiss: hiss)
        if started { NephisFlow.cleanClicks(&latents, levels: &levels, from: 0, to: max(0, silence.head - 1)) }
        NephisFlow.cleanClicks(&latents, levels: &levels, from: min(levels.count, levels.count - silence.tail + 1), to: levels.count)
        let tailBefore = pendingTail.count
        let decodedBefore = pendingDecoded
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
        // The pause as decoded: the join's latents before this piece's first word (the pad is true silence on top).
        let bridge = max(0, joined.latents.count - (latents.count - silence.head))
        let joinWords = tailBefore == 0 ? "no join"
            : "join \(String(format: "%.2f", pause)) s: tail \(tailBefore) (\(decodedBefore) decoded before) + head \(silence.head) → "
            + "\(bridge) latents, pad \(String(format: "%.2f", joined.padSeconds)) s"
        log("flow: piece \(Self.snippet(text))\(dialogue != nil ? " (dialogue pack)" : "")\(open ? " (part of a long sentence)" : ""): \(best.latents.count) latents"
            + (best.cutRunaway ? " (ran on: cut)" : "") + ", dropped \(drop) before the first word, silence \(silence.head)+\(silence.tail); "
            + "\(joinWords); \(keep) held for the next join (\(pendingDecoded) decoded now)")

        if dialogue != nil {
            dialogueCarry = Array((dialogueCarry + latents).suffix(voiceChain.carryFrames))
            dialogueLastClip = clip
        } else {
            carry = Array((carry + latents).suffix(assets.chain.carryFrames))
            lastClip = clip
        }
        context = Array(best.audio.suffix(3 * NephisFlow.sampleRate))
        lastText = text
        lastVoice = speaker
        started = true
        // The pad sits in the pause; the latents kept back for the next join come from the end, after it.
        let padAt = joined.padAt.flatMap { $0 <= stream.count ? $0 : nil }
        return (stream, padAt, padAt == nil ? 0 : joined.padSeconds, best.latents.count, padAt ?? min(stream.count, bridge / 2))
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
        /// Her studio's own report for the call (nil: it never got the call), its compute units, and why it is off for
        /// the session (too slow) once this call is counted.
        var studio: NephisStudio.Report? = nil
        var units: String? = nil
        var off: String? = nil
        /// What the breath polish did with the call (nil: not polished).
        var polish: BreathPolish.Report? = nil
        /// Mimi's decode, and the work on the sound after it inside the job (polish, tone, studio EQ).
        var mimiMs = 0.0
        var postMs = 0.0
        /// The pack's studio EQ ran on the call.
        var studioEQ = false
        /// The de-wind cleaner on the call (Report's dewind fields).
        var dewind = Dewound()
    }

    /// What the de-wind cleaner did with one call (`predictMs`, `ioMs`: its network's share of `ms`).
    struct Dewound: Sendable {
        var passes = 0
        var ms = 0.0
        var predictMs = 0.0
        var ioMs = 0.0
        var model: String?
        var units: String?
        var note: String?
    }

    /// The de-wind cleaner on one call's sound at `rate` (chain "dewind"; nil = off: the samples untouched), waiting for
    /// its load the first time. A read's calls come here in order, so the cleaner's state follows the read; `restart` (a
    /// new read, a seek, the next chapter) starts it afresh. A failed load or call leaves the sound as it was, with why.
    static func dewound(_ samples: inout [Float], rate: Int, settings: NephisDewind.Settings?, load: Task<(NephisDewinder?, String?), Never>?,
                        restart: Bool, log: @Sendable (String) -> Void) async -> Dewound {
        guard let settings, settings.on else { return Dewound() }
        guard let load else { return Dewound(note: "no model in the pack") }
        let (cleaner, why) = await load.value
        guard let cleaner else { return Dewound(note: why ?? "not loaded") }
        let r = await cleaner.process(samples, settings: settings, sampleRate: rate, restart: restart)
        var out = Dewound(ms: r.ms, predictMs: r.predictMs, ioMs: r.ioMs, model: "\(cleaner.name) N\(cleaner.framesPerCall)",
                          units: cleaner.computeUnits)
        if let error = r.error {
            out.note = "failed: \(error)"
            log("dewind: a call failed: \(error); that call without it, the next one starts afresh")
        } else {
            samples = r.samples
            out.passes = settings.passes
        }
        return out
    }

    /// Starts loading the pack's de-wind cleaner when its chain asks for one (once per engine): the calls wait for it; a
    /// pack without the model, or a failed load, plays without it (said once in the log, and in every call's report).
    private func startDewindLoad() {
        guard dewind == nil, let settings = assets.chain.dewind, settings.on else { return }
        let log = self.log
        guard let dir = assets.dewindDirectory else {
            log("dewind: the pack's chain asks for \(settings.passes) passes but the pack has no model (\(NephisDewindModel.folder)); off")
            dewind = Task { () -> (NephisDewinder?, String?) in (nil, "no model in the pack") }
            return
        }
        dewind = Task.detached(priority: .userInitiated) { () -> (NephisDewinder?, String?) in
            do {
                let (cleaner, line) = try await NephisDewinder.load(from: dir) { name, folder in try await CompiledModels.shared.url(name, in: folder) }
                log(line + ", \(settings.passes) passes")
                return (cleaner, nil)
            } catch {
                log("dewind: couldn't load the cleaner: \(error); off, her sound without it")
                return (nil, "failed: \(error)")
            }
        }
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
        // A call the studio rendered: its sound as made, or with her EQ after it when the pack asks ("eqAfterStudio").
        let studioTone = NephisFlow.studioTone(studioUsed: true, moodToneDB: p.toneDB, chain: assets.chain)
        // Her breaths as air (pack "breathPolish"; nil = off): on the studio's sound before its EQ, at the call's rate.
        let breathPolish = assets.chain.breathPolish
        // Her pack's own EQ on her studio's sound (chain "studioEQ"; nil = off): last, after the polish and "eqAfterStudio".
        let studioEQ = assets.chain.studioEQ
        // Her studio's models for the call, asked for in call order (the job itself stays off this actor, as before).
        let studioFor: @Sendable (Bool) async -> (studio: NephisStudio?, reason: String?, n: Int) = { hurry in await self.studioForCall(hurry: hurry) }
        // A call rendered at background priority (`relaxed`) never counts toward switching the studio off for its pace.
        let studioDone: @Sendable (Int, NephisStudio.Report, String, Bool) async -> String? = { n, r, units, counts in
            await self.studioCallDone(n, r, units: units, paced: counts)
        }
        let studioCheck = Self.studioCheck(paced: p.paced, freeMemoryMB: freeMemoryMB)
        let note = log
        // The de-wind cleaner (chain "dewind"; nil = off): the first step after her voice is made, at the call's rate.
        let dewindSettings = assets.chain.dewind
        let dewindLoad = dewind
        let dewindRestart = p.reset || p.chapterStart
        // A call with her dialogue pack's spans (nil: the narrator's alone, decoded exactly as before): the dialogue pack's
        // chain and mood, and where the voice changes (the tone stages in the job run on the sound before the pauses).
        let mixChain: NephisFlow.Chain? = p.mixed ? assets.dialogue?.chain : nil
        let dialogueMood = p.dialogueMood
        let firstVoice = p.firstVoice
        let latentSwitches = p.switches
        let job = Task { () async throws -> Decoded in
            await previous?.value
            let d0 = Date()
            if p.reset { try await decoder.reset() }
            let mimi = try await decoder.decode(p.stream)
            let mimiMs = Date().timeIntervalSince(d0) * 1000
            // Released meanwhile: stop here, and the models go with this call (crash plan a3).
            try Task.checkCancellation()
            var out = Decoded(samples: mimi)
            out.mimiMs = mimiMs
            // A read without her studio: the cleaner on Mimi's 24 kHz sound, before anything else.
            if config == nil {
                out.dewind = await Self.dewound(&out.samples, rate: NephisFlow.sampleRate, settings: dewindSettings, load: dewindLoad,
                                                restart: dewindRestart, log: note)
            }
            if let config {  // her 44.1 kHz sound; any studio failure falls back to Mimi's own sound at 44.1 kHz (never a lost call)
                let ready = await studioFor(p.hurry)
                try Task.checkCancellation()
                if let studio = ready.studio {
                    out.units = studio.computeUnits
                    if !p.hurry {
                        // Before the work: a call that never finishes still shows in the log.
                        let seconds = Double(mimi.count) / Double(NephisFlow.sampleRate)
                        note("studio: call \(ready.n) started: \(String(format: "%.1f", seconds)) s of audio\(p.paced ? "" : " (no time limit)")")
                    }
                    do {
                        let r = try await studio.renderReporting(pcm24: mimi, latents: sketch, hurry: p.hurry, continues: !p.reset,
                                                                 check: studioCheck)
                        out.samples = r.pcm
                        out.studioUsed = !r.report.bypassed
                        // Her studio's sound: the cleaner first, before the breath polish and the EQs.
                        if out.studioUsed {
                            out.dewind = await Self.dewound(&out.samples, rate: config.sample_rate, settings: dewindSettings, load: dewindLoad,
                                                            restart: dewindRestart, log: note)
                        }
                        let post0 = Date()
                        if out.studioUsed, let breathPolish {
                            out.polish = BreathPolish.apply(&out.samples, sampleRate: config.sample_rate, settings: breathPolish)
                            if !p.hurry, let polish = out.polish { note("breath polish: call \(ready.n): \(polish.summary)") }
                        }
                        // A mixed call: the dialogue spans' tone starts from the sound before the narrator's.
                        let untoned = mixChain != nil && out.studioUsed ? out.samples : []
                        if out.studioUsed, studioTone.mimiEQ != nil { studioTone.apply(&out.samples, sampleRate: config.sample_rate) }
                        // The pack's studio EQ: the whole call at once (the studio hands it over whole), at its rate.
                        if out.studioUsed, let studioEQ {
                            studioEQ.apply(&out.samples, sampleRate: config.sample_rate)
                            out.studioEQ = true
                        }
                        // The dialogue spans: the dialogue pack's own tone and studio EQ (its mood's EQ group), mixed in.
                        if out.studioUsed, let mixChain {
                            out.samples = Self.dialogueTone(narrator: out.samples, from: untoned, chain: mixChain, mood: dialogueMood, studio: true,
                                                            toneDB: 0, first: firstVoice, switches: latentSwitches, rate: config.sample_rate)
                            out.studioEQ = out.studioEQ || mixChain.studioEQ(for: dialogueMood) != nil
                        }
                        out.postMs += Date().timeIntervalSince(post0) * 1000
                        out.bypassReason = out.studioUsed ? nil : r.report.bypassReason ?? "bypassed"
                        out.studio = r.report
                        if !p.hurry { out.off = await studioDone(ready.n, r.report, studio.computeUnits, p.paced && !p.relaxed) }
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch {
                        out.bypassReason = "failed: \(error)"
                        note("studio: call \(ready.n) failed: \(error); her plain sound")
                    }
                } else {
                    out.bypassReason = ready.reason ?? "bypassed"
                }
                if !out.studioUsed {
                    // Mimi's sound with the read's own EQ (the mood's shelf and her Mimi EQ), applied at Mimi's 24 kHz
                    // where it was tuned, then at the studio's rate: the call sounds like the read without the studio.
                    let plain0 = Date()
                    var toned = mimi
                    plainTone.apply(&toned, sampleRate: NephisFlow.sampleRate)
                    // A mixed call: the dialogue spans with the dialogue pack's mood shelf and Mimi EQ, at 24 kHz too.
                    if let mixChain {
                        toned = Self.dialogueTone(narrator: toned, from: mimi, chain: mixChain, mood: dialogueMood, studio: false,
                                                  toneDB: mixChain.moods[dialogueMood]?.toneDB ?? 0, first: firstVoice, switches: latentSwitches,
                                                  rate: NephisFlow.sampleRate)
                    }
                    out.samples = NephisStudio.plainAudio(pcm24: toned, rate: config.sample_rate)
                    out.postMs += Date().timeIntervalSince(plain0) * 1000
                    // Her plain sound in her studio's read: cleaned as it joins the read's 44.1 kHz stream, so one cleaner
                    // runs over the whole read at one rate (her Mimi EQ stays at 24 kHz, where it was tuned, before it).
                    out.dewind = await Self.dewound(&out.samples, rate: config.sample_rate, settings: dewindSettings, load: dewindLoad,
                                                    restart: dewindRestart, log: note)
                }
            }
            // A call without her studio's sound (no studio, skipped, failed): polished only when the pack says "plainToo".
            if !out.studioUsed, let breathPolish, breathPolish.plainToo {
                let polish0 = Date()
                out.polish = BreathPolish.apply(&out.samples, sampleRate: config?.sample_rate ?? NephisFlow.sampleRate, settings: breathPolish)
                out.postMs += Date().timeIntervalSince(polish0) * 1000
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
        let after0 = Date()
        var samples = NephisFlow.insertSilence(decoded.samples, pads: p.pads, sampleRate: rate, samplesPerLatent: perLatent)
        // Her mastering (pack chain "master"; off = nothing here runs). Without her studio her EQ comes first, here: the
        // player gives it after this otherwise, which would be after the limiter. A fresh read starts a fresh chain.
        // The tuner's finishing (pack chain "closeness", "floorGuard", "breathAir", "room"; each off = nothing runs, the call
        // bit-identical): every call of hers, studio or plain, after the studio EQ / Mimi EQ, before her mastering.
        let chain = assets.chain
        let masterSettings = chain.master
        var report = p.report
        let eqHere: Bool
        let n: Finished
        var dialogueMastered = true
        if let d = p.mixed ? assets.dialogue : nil {
            // A call with her dialogue pack's spans: its dialogue regions at their mood's tempo (pitch kept), the level of
            // each voice measured (the match), then each voice's own steps (the narrator's over the whole call as always,
            // the dialogue pack's up to its last region), mixed with an equal-power crossfade of 5 ms at each change (they
            // fall in pauses).
            let dchain = d.chain
            var at = NephisVoiceMix.samples(p.switches, perLatent: perLatent, pads: p.pads, sampleRate: rate)
            let tempo = dchain.tempo(mood: p.dialogueMood)
            if NephisTempo.changes(tempo) {
                let stretched = NephisVoiceMix.stretch(samples, first: p.firstVoice, switches: at, voice: 1, tempo: tempo, sampleRate: rate)
                samples = stretched.samples
                at = stretched.switches
                report.dialogueTempo = tempo
            }
            let regions = NephisVoiceMix.regions(count: samples.count, first: p.firstVoice, switches: at)
            for v in 0...1 {
                loudness.observe(voice: v, level: NephisLoudnessMatch.activeLevel(samples, ranges: regions.filter { $0.voice == v }.map { $0.range }, sampleRate: rate))
            }
            let match = dchain.loudnessMatch ? loudness.dialogueGainDB : 0
            report.dialogueMatchDB = match
            report.dialogueSeconds = Double(regions.filter { $0.voice == 1 }.reduce(0) { $0 + $1.range.count }) / Double(rate)
            let fade = max(1, Int(NephisVoiceMix.fadeSeconds * Double(rate)))
            let end = NephisVoiceMix.lastSample(of: 1, count: samples.count, first: p.firstVoice, switches: at, fade: fade) ?? 0
            var dialogue = Array(samples.prefix(end))
            // Without her studio each voice gets its own pack's Mimi EQ here, so the player adds none on top.
            eqHere = config == nil
            n = narratorFinish(&samples, toneDB: p.toneDB, gainDB: p.gainDB, studio: config != nil, eqHere: eqHere, rate: rate, restart: p.reset)
            let dMood = dchain.moods[p.dialogueMood]
            let dRestart = p.reset || !dialogueChainRan
            let dn = dialogueFinish(&dialogue, chain: dchain, toneDB: dMood?.toneDB ?? 0, gainDB: (dMood?.gainDB ?? 0) + match,
                                    studio: config != nil, eqHere: eqHere, rate: rate, restart: dRestart)
            dialogueChainRan = end >= samples.count
            samples = NephisVoiceMix.mix(samples, dialogue, weights: NephisVoiceMix.weights(count: samples.count, first: p.firstVoice, switches: at, fade: fade))
            report.dialogueFinishMs = dn.ms
            dialogueMastered = dn.mastered
        } else {
            // Without her studio her EQ comes first, here, when something follows it: the player gives it after this
            // otherwise, which would be after the limiter or the compressor. With it on, the player adds no EQ (`toned`).
            eqHere = config == nil && (masterSettings != nil || Self.finishes(chain))
            // With a dialogue pack, the narrator's level in her calls without dialogue counts toward the match too.
            if assets.dialogue?.chain.loudnessMatch == true {
                loudness.observe(voice: 0, level: NephisLoudnessMatch.activeLevel(samples[...], sampleRate: rate))
            }
            n = narratorFinish(&samples, toneDB: p.toneDB, gainDB: p.gainDB, studio: config != nil, eqHere: eqHere, rate: rate, restart: p.reset)
            dialogueChainRan = false
        }
        let closed = n.closed, aired = n.aired, roomed = n.roomed, finishMs = n.ms
        let mastered = n.mastered && dialogueMastered
        report.floorGuard = n.guarded
        report.mimiMs = decoded.mimiMs
        report.postMs = decoded.postMs + Date().timeIntervalSince(after0) * 1000
        report.studioEQ = decoded.studioEQ
        report.closeness = closed
        report.breathAir = aired
        report.room = roomed
        report.finishMs = finishMs
        report.dewindPasses = decoded.dewind.passes
        report.dewindMs = decoded.dewind.ms
        report.dewindModel = decoded.dewind.model
        report.dewindUnits = decoded.dewind.units
        report.dewindNote = decoded.dewind.note
        report.dewindPredictMs = decoded.dewind.predictMs
        report.dewindIOMs = decoded.dewind.ioMs
        report.dewindDSPMs = max(0, decoded.dewind.ms - decoded.dewind.predictMs - decoded.dewind.ioMs)
        report.streamLatents = p.stream.count
        report.decodeMs = decoded.ms
        report.totalMs = Date().timeIntervalSince(p.started) * 1000
        report.audioMs = Double(samples.count) * 1000 / Double(rate)
        report.sampleRate = rate
        report.studioRead = config != nil
        report.studioUsed = decoded.studioUsed
        report.bypassReason = decoded.bypassReason
        if let s = decoded.studio, !p.hurry {
            report.studioX = s.speedX
            report.studioBlueprintMs = s.blueprintMs + s.refinerMs
            report.studioVocoderMs = s.vocoderMs
            report.studioRestMs = s.restMs
            report.studioPieces = s.pieces
            report.studioPiecesPlanned = s.piecesPlanned
        }
        report.studioUnits = decoded.units
        report.studioOff = decoded.off ?? (config == nil ? nil : studioTooSlow)
        report.masterPreset = n.mastered ? masterSettings?.preset.rawValue : nil
        report.masterGainDB = n.mastered ? master?.gainDB : nil
        lastReport = report
        var audio = ExpressiveAudio(samples: samples, sampleRate: rate, synthMs: report.totalMs, firstAudioMs: report.totalMs,
                                    chunks: report.takes)
        audio.mastered = mastered
        audio.toned = eqHere
        return (audio, report)
    }

    /// What one voice's steps after the pauses did (Report's finishing fields).
    struct Finished {
        var closed = false
        var guarded = false
        var aired = false
        var roomed = false
        var mastered = false
        var ms = 0.0
    }

    /// Something of the tuner's finishing is on in `chain` (her Mimi EQ then comes first, in the engine).
    static func finishes(_ chain: NephisFlow.Chain) -> Bool {
        (chain.closeness?.on ?? false) || (chain.floorGuard?.on ?? false) || (chain.breathAir.map { $0.amount > 0 } ?? false)
            || (chain.room.map { $0.amount > 0 } ?? false)
    }

    /// Her level for the mood moved from `fromDB` to `toDB` over the first 200 ms: the call starts in the pause before it,
    /// so the change happens in silence (one fixed gain for the stream otherwise: NaturalFinish.renderFlow).
    static func levelRamp(_ x: inout [Float], fromDB: Double, toDB: Double, rate: Int) {
        let from = Float(pow(10, fromDB / 20)), to = Float(pow(10, toDB / 20))
        guard from != 1 || to != 1 else { return }
        let ramp = min(x.count, rate / 5)
        for i in x.indices { x[i] *= i < ramp ? from + (to - from) * Float(i) / Float(ramp) : to }
    }

    /// The narrator pack's steps after the pauses go in, on a whole call, its chains carried over the read: the mood's tone
    /// (a read without her studio: the player adds her EQ), her level for the mood, her Mimi EQ when something follows it
    /// here (`eqHere`), the tuner's finishing (closeness, floor guard, breath air, room) and her mastering.
    private func narratorFinish(_ x: inout [Float], toneDB: Double, gainDB: Double, studio: Bool, eqHere: Bool, rate: Int, restart: Bool) -> Finished {
        let chain = assets.chain
        // In a studio read each call's tone was set in the decode: none on her studio sound, the read's own EQ on Mimi's.
        if !studio { NephisFlow.highShelf(&x, db: toneDB, sampleRate: rate) }
        Self.levelRamp(&x, fromDB: lastGainDB, toDB: gainDB, rate: rate)
        lastGainDB = gainDB
        if eqHere { NephisFlow.MimiEQ(chain: chain).apply(&x, sampleRate: rate) }
        var f = Finished()
        let finish0 = Date()
        f.closed = NephisCloseness.apply(&closeness, settings: chain.closeness, to: &x, sampleRate: rate, restart: restart)
        f.guarded = NephisFloorGuard.apply(&floorGuard, settings: chain.floorGuard, to: &x, sampleRate: rate, restart: restart)
        f.aired = NephisBreathAir.apply(&breathAir, settings: chain.breathAir, to: &x, sampleRate: rate, restart: restart)
        f.roomed = NephisRoom.apply(&room, settings: chain.room, to: &x, sampleRate: rate, restart: restart)
        f.ms = f.closed || f.guarded || f.aired || f.roomed ? Date().timeIntervalSince(finish0) * 1000 : 0
        f.mastered = NephisMaster.apply(&master, settings: chain.master, to: &x, sampleRate: rate, restart: restart)
        return f
    }

    /// The dialogue pack's steps on a mixed call's start up to its last dialogue region (the same as the narrator's, with
    /// its own chain and its own finishing carried over the read; `restart` when it didn't run to the end of the call
    /// before). Its level: its mood's, plus the match to the narrator.
    private func dialogueFinish(_ x: inout [Float], chain: NephisFlow.Chain, toneDB: Double, gainDB: Double, studio: Bool, eqHere: Bool, rate: Int,
                                restart: Bool) -> Finished {
        if !studio { NephisFlow.highShelf(&x, db: toneDB, sampleRate: rate) }
        Self.levelRamp(&x, fromDB: restart ? gainDB : dialogueGainDB, toDB: gainDB, rate: rate)
        dialogueGainDB = gainDB
        if eqHere { NephisFlow.MimiEQ(chain: chain).apply(&x, sampleRate: rate) }
        var f = Finished()
        let finish0 = Date()
        f.closed = NephisCloseness.apply(&dialogueCloseness, settings: chain.closeness, to: &x, sampleRate: rate, restart: restart)
        f.guarded = NephisFloorGuard.apply(&dialogueFloor, settings: chain.floorGuard, to: &x, sampleRate: rate, restart: restart)
        f.aired = NephisBreathAir.apply(&dialogueAir, settings: chain.breathAir, to: &x, sampleRate: rate, restart: restart)
        f.roomed = NephisRoom.apply(&dialogueRoom, settings: chain.room, to: &x, sampleRate: rate, restart: restart)
        f.ms = f.closed || f.guarded || f.aired || f.roomed ? Date().timeIntervalSince(finish0) * 1000 : 0
        // Its mastering, or none: then the player's soft limit finishes the call (`mastered` false).
        f.mastered = chain.master == nil || NephisMaster.apply(&dialogueMaster, settings: chain.master, to: &x, sampleRate: rate, restart: restart)
        return f
    }

    /// A mixed call's dialogue regions with the dialogue pack's tone before the pauses go in: `from` (the sound before any
    /// tone) up to its last dialogue region, toned as the narrator's is (`studio`: her studio sound, its "eqAfterStudio" and
    /// its mood's EQ group or studio EQ; else Mimi's: the mood's shelf and its Mimi EQ), mixed into `narrator` at the voice
    /// changes (their pre-pause positions at `rate`).
    static func dialogueTone(narrator: [Float], from: [Float], chain: NephisFlow.Chain, mood: String, studio: Bool, toneDB: Double,
                             first: Int, switches: [NephisVoiceMix.LatentSwitch], rate: Int) -> [Float] {
        let perLatent = NephisFlow.samplesPerLatent * rate / NephisFlow.sampleRate
        let at = NephisVoiceMix.samples(switches, perLatent: perLatent, sampleRate: rate)
        let fade = max(1, Int(NephisVoiceMix.fadeSeconds * Double(rate)))
        guard let end = NephisVoiceMix.lastSample(of: 1, count: narrator.count, first: first, switches: at, fade: fade), end > 0 else { return narrator }
        var dialogue = Array(from.prefix(end))
        let tone = NephisFlow.studioTone(studioUsed: studio, moodToneDB: toneDB, chain: chain)
        if !studio || tone.mimiEQ != nil { tone.apply(&dialogue, sampleRate: rate) }
        if studio, let eq = chain.studioEQ(for: mood) { eq.apply(&dialogue, sampleRate: rate) }
        return NephisVoiceMix.mix(narrator, dialogue, weights: NephisVoiceMix.weights(count: narrator.count, first: first, switches: at, fade: fade))
    }

    // MARK: - Her studio's models (crash plan b1)

    /// Her studio's models for the next call, or nil with the reason the call plays her plain sound instead (its log:
    /// "loading", "hurry", "memory: 480 MB free", "failed: …"). Never waits for them: they load in the background behind
    /// Pocket's (startStudioLoad, again from here after a drop), and the calls meanwhile play her plain sound at the
    /// studio's rate. Dropped when free memory falls under ~500 MB; after a drop or a failed load they wait (2 min,
    /// doubling, back to 2 min once they have worked 5 minutes) before loading again.
    /// `n`: the call's number in her studio's log (0 without the studio).
    private func studioForCall(hurry: Bool) -> (studio: NephisStudio?, reason: String?, n: Int) {
        guard assets.studioDirectory != nil else { return (nil, "off", 0) }
        // Released (this call is cancelled, the models gone): nothing loads for it.
        guard manager != nil, !Task.isCancelled else { return (nil, "released", 0) }
        // Too slow on this phone now: off for the rest of this engine's life (studioCallDone).
        if let studioTooSlow { return (nil, studioTooSlow, 0) }
        let free = freeMemoryMB()
        if let studio {
            guard NephisMemory.short(.studioKeep, freeMB: free), let free else {
                studioHold.worked(at: Date())
                if !hurry { studioCalls += 1 }
                return (studio, nil, studioCalls)
            }
            dropStudio(NephisMemory.refusal(.studioKeep, freeMB: free))
            return (nil, studioOff, 0)
        }
        // Short of audio: no load started now (it would compete with her generation); the call plays at once.
        if hurry, studioLoading == nil { return (nil, "hurry", 0) }
        return (nil, startStudioLoad() ?? "loading", 0)
    }

    /// Between her studio's pieces (NephisStudio.Check): too little memory left gives up on the call (and drops the
    /// studio: studioCallDone), and a Listen call (`paced`) also gives up once it can't finish at real time.
    static func studioCheck(paced: Bool, freeMemoryMB: @escaping @Sendable () -> Double?) -> NephisStudio.Check {
        { x in
            if let free = freeMemoryMB(), NephisMemory.short(.studioKeep, freeMB: free) { return NephisMemory.refusal(.studioKeep, freeMB: free) }
            return paced && StudioPace.tooSlow(x) ? "slow: \(StudioPace.words(x))" : nil
        }
    }

    /// A call her studio worked on: its numbers in one line of the app's log; a call it gave up on for memory drops it (as
    /// a memory check before a call does); a Listen call's pace counts toward switching it off for the session
    /// (StudioPace: three calls in a row under real time). Returns why it is off for the session, if it now is.
    private func studioCallDone(_ n: Int, _ r: NephisStudio.Report, units: String, paced: Bool) -> String? {
        log(Self.studioLine(n, r, units: units))
        let forMemory = r.bypassed && r.bypassReason?.hasPrefix("memory") == true
        if forMemory, let why = r.bypassReason { dropStudio(why) }
        if paced, !forMemory, let x = r.speedX, let reason = studioPace.record(x), studioTooSlow == nil {
            studioTooSlow = reason
            studio = nil
            studioOff = reason
            log("studio: off for the rest of this session: \(reason) (\(StudioPace.dropAfter) calls in a row under "
                + "\(StudioPace.words(StudioPace.minimum))); her plain sound from here")
        }
        return studioTooSlow
    }

    /// One studio call for the log: "studio: call 3: 0.42x real time, gave up (slow: 0.4x real time) after 2 of 9
    /// pieces; 4.1 s audio, blueprint 1210 ms, vocoder 2400 ms, rest 0 ms, units cpu+ane, heat serious".
    static func studioLine(_ n: Int, _ r: NephisStudio.Report, units: String) -> String {
        let heat = ["nominal", "fair", "serious", "critical"]
        let speed = r.speedX.map { StudioPace.words($0) } ?? "?"
        let outcome = r.bypassed ? "gave up (\(r.bypassReason ?? "?")) after \(r.pieces) of \(r.piecesPlanned) pieces"
            : "\(r.pieces) of \(r.piecesPlanned) pieces"
        let h = heat.indices.contains(r.thermal) ? heat[r.thermal] : "?"
        return "studio: call \(n): \(speed), \(outcome); \(String(format: "%.1f", r.audioMs / 1000)) s audio, blueprint "
            + "\(Int(r.blueprintMs + r.refinerMs)) ms, vocoder \(Int(r.vocoderMs)) ms, rest \(Int(r.restMs)) ms, units \(units), heat \(h)"
    }

    /// Starts loading her studio's models off the calls' path when they may load: Pocket up, no wait after a drop going
    /// on, ~1,000 MB free. The reason her calls play her plain sound meanwhile ("loading", "memory: …", "failed: …").
    @discardableResult
    private func startStudioLoad() -> String? {
        guard let dir = assets.studioDirectory, manager != nil, studio == nil else { return nil }
        if let studioTooSlow { return studioTooSlow }
        if studioLoading != nil { return "loading" }
        if let off = studioOff, studioHold.holds(at: Date()) { return off }
        let free = freeMemoryMB()
        if NephisMemory.short(.studioLoad, freeMB: free), let free {
            dropStudio(NephisMemory.refusal(.studioLoad, freeMB: free))
            return studioOff
        }
        let ticket = generation.ticket
        studioLoading = Task.detached(priority: .utility) { [weak self] in
            let t0 = Date()
            let result: Result<NephisStudio?, Error>
            do { result = .success(try await NephisStudio.load(from: dir)) } catch { result = .failure(error) }
            await self?.studioLoaded(result, ticket: ticket, ms: Date().timeIntervalSince(t0) * 1000)
        }
        return "loading"
    }

    /// Her studio's models are up, or failed to load. Released meanwhile: kept nothing (they go with the task).
    private func studioLoaded(_ result: Result<NephisStudio?, Error>, ticket: Int, ms: Double) {
        guard generation.current(ticket) else { return }
        studioLoading = nil
        switch result {
        case .success(let loaded):
            studio = loaded
            studioOff = loaded == nil ? "missing" : nil
            let free = freeMemoryMB().map { "\(Int($0)) MB" } ?? "unknown"
            log(loaded.map { "studio: loaded in \(Int(ms)) ms, compute units \($0.computeUnits), free memory \(free)" } ?? "studio: missing")
        case .failure(let error):
            dropStudio("failed: \(error)")
        }
    }

    /// Returns once her studio's models loading in the background are up or have failed (at once when none load): the
    /// next big load (the listening test after the studio test, Kokoro's warm-up) never overlaps them.
    public func studioSettled() async {
        await studioLoading?.value
        await dialogueLoading?.value
    }

    /// Her studio's models go (low memory, a failed load) for a while; the calls meanwhile play her plain sound at the
    /// studio's rate, with `reason` in the call log.
    private func dropStudio(_ reason: String) {
        studio = nil
        studioOff = reason
        studioHold.release(at: Date())
        log("studio: off for now: \(reason)")
    }

    // MARK: - Her dialogue pack's model

    /// Her dialogue pack's Pocket model for the next call, or nil with the reason the narrator reads its dialogue instead
    /// ("loading", "memory: 520 MB free", "failed: …"). Never waits: it loads in the background behind her studio's
    /// models (startDialogueLoad, again from here after a drop), and goes first when free memory falls under ~550 MB.
    private func dialogueForCall() -> (manager: PocketTtsManager?, note: String?) {
        guard assets.dialogue != nil else { return (nil, nil) }
        guard manager != nil, !Task.isCancelled else { return (nil, "released") }
        if let m = dialogueManager {
            if let free = freeMemoryMB(), NephisMemory.short(.dialogueKeep, freeMB: free) {
                dropDialogue(NephisMemory.refusal(.dialogueKeep, freeMB: free))
                return (nil, dialogueOff)
            }
            dialogueHold.worked(at: Date())
            return (m, nil)
        }
        return (nil, startDialogueLoad() ?? "loading")
    }

    /// What the dialogue pack's model did at its last load: time, free memory before and after (MB), or why it is off.
    public struct DialogueStatus: Sendable {
        public var pack: String?
        public var loaded = false
        public var loadMs: Double?
        public var freeBeforeMB: Double?
        public var freeAfterMB: Double?
        public var off: String?
    }

    private var dialogueStatusNow = DialogueStatus()

    public func dialogueStatus() -> DialogueStatus {
        var s = dialogueStatusNow
        s.pack = assets.dialogue?.name
        s.loaded = dialogueManager != nil
        s.off = dialogueManager == nil ? (dialogueOff ?? (dialogueLoading != nil ? "loading" : nil)) : nil
        return s
    }

    /// Starts loading the dialogue pack's model off the calls' path when it may load: Pocket up, her studio's load settled,
    /// no wait after a drop going on, ~900 MB free then. The reason the narrator reads the dialogue meanwhile.
    @discardableResult
    private func startDialogueLoad() -> String? {
        guard let d = assets.dialogue, manager != nil, dialogueManager == nil else { return nil }
        if dialogueLoading != nil { return "loading" }
        if let off = dialogueOff, dialogueHold.holds(at: Date()) { return off }
        let ticket = generation.ticket
        let behind = studioLoading
        let free = freeMemoryMB
        let dir = d.modelsDirectory
        dialogueLoading = Task.detached(priority: .utility) { [weak self] in
            // Behind her studio's models: never two big loads at once.
            await behind?.value
            let before = free()
            if let mb = before, NephisMemory.short(.dialogueLoad, freeMB: mb) {
                await self?.dialogueLoaded(nil, why: NephisMemory.refusal(.dialogueLoad, freeMB: mb), ticket: ticket, ms: 0, freeBefore: before)
                return
            }
            let t0 = Date()
            do {
                let m = PocketTtsManager(directory: dir, placement: .ane, computeUnits: PocketTtsSynth.backgroundSafeUnits)
                try await m.initialize()
                await self?.dialogueLoaded(m, why: nil, ticket: ticket, ms: Date().timeIntervalSince(t0) * 1000, freeBefore: before)
            } catch {
                await self?.dialogueLoaded(nil, why: "failed: \(error)", ticket: ticket, ms: 0, freeBefore: before)
            }
        }
        return "loading"
    }

    /// The dialogue pack's model is up, or couldn't load (`why`). Released meanwhile: kept nothing (it goes with the task).
    private func dialogueLoaded(_ loaded: PocketTtsManager?, why: String?, ticket: Int, ms: Double, freeBefore: Double?) {
        guard generation.current(ticket) else { return }
        dialogueLoading = nil
        let after = freeMemoryMB()
        dialogueStatusNow.freeBeforeMB = freeBefore
        dialogueStatusNow.freeAfterMB = after
        guard let loaded else { return dropDialogue(why ?? "missing") }
        dialogueManager = loaded
        dialogueOff = nil
        dialogueStatusNow.loadMs = ms
        let mb = { (x: Double?) in x.map { "\(Int($0)) MB" } ?? "unknown" }
        log("dialogue: \"\(assets.dialogue?.name ?? "?")\" loaded in \(Int(ms)) ms (its flow model; Mimi, studio and de-wind shared), "
            + "free memory \(mb(freeBefore)) before, \(mb(after)) after")
    }

    /// The dialogue pack's model goes (low memory, a failed load) for a while: the narrator reads the dialogue meanwhile.
    private func dropDialogue(_ reason: String) {
        dialogueManager = nil
        dialogueOff = reason
        dialogueHold.release(at: Date())
        dialogueCarry = []
        dialogueLastClip = nil
        log("dialogue: off for now: \(reason); the narrator pack reads the dialogue meanwhile")
    }

    // MARK: - One take

    /// One take: its latents (the session doesn't decode them) and the levels of its audio, decoded on the scratch
    /// decoder while the take is generated. `whole`: decode all of it (recognition, the take score); otherwise only
    /// the first `headEdge` latents and the last `tailEdge` (the middle's levels read as speech, its hiss as none).
    /// `ends`: how each of its text chunks ended. `open`: the text is part of a longer sentence (no full stop added).
    private func render(_ manager: PocketTtsManager, scratch: PocketTtsLatentDecoder, voice: PocketTtsVoiceData, text: String, open: Bool = false,
                        temperature: Float, seed: UInt64?, whole: Bool, raw: Bool, report: inout Report)
        async throws -> (latents: [[Float]], levels: [Double], hiss: [Double], audio: [Float], endOfText: Int?, ends: [PocketTtsSynthesizer.ChunkEnd]) {
        let r0 = Date()
        let session = try await manager.makeSession(voiceData: voice, temperature: temperature, seed: seed)
        await session.setDecodesAudio(false)
        if open { await session.setKeepsSentenceOpen(true) }
        // The raw form's "..." stays whole when the session chunks a lead-in and its piece (as Kyutai's pocket_tts does).
        if raw { await session.setKeepsPunctuationRuns(true) }
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
        // Latents this take decodes on the scratch decoder (the call's heat counters).
        var scratchSent = 0
        defer { report.scratchLatents += scratchSent }
        // Hand latents to the scratch decoder in small batches, in order, without waiting for it.
        func send(_ b: [[Float]]) {
            scratchSent += b.count
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
            return (latents, NephisFlow.levels(audio), NephisFlow.hiss(audio), audio, endOfText, ends)
        }
        if n <= Self.headEdge + Self.tailEdge + Self.warmUp {
            // Short take: decoding the rest is about as cheap as the tail.
            scratchSent += n - Self.headEdge
            audio += try await scratch.decode(Array(latents[Self.headEdge...]))
            return (latents, NephisFlow.levels(audio), NephisFlow.hiss(audio), audio, endOfText, ends)
        }
        let head = NephisFlow.levels(audio)
        let headHiss = NephisFlow.hiss(audio)
        try await scratch.reset()
        scratchSent += min(n, Self.tailEdge + Self.warmUp)
        let tailAudio = Array(try await scratch.decode(Array(latents.suffix(Self.tailEdge + Self.warmUp)))
            .dropFirst(Self.warmUp * NephisFlow.samplesPerLatent))
        let middle = [Double](repeating: 0, count: n - Self.headEdge - Self.tailEdge)
        return (latents, head + middle + NephisFlow.levels(tailAudio), headHiss + middle + NephisFlow.hiss(tailAudio), tailAudio, endOfText, ends)
    }
}
