//
//  HybridSpeechEngine.swift — Kokoro on device, with the Apple voice as a seamless fallback.
//
//  Per sentence (HybridScheduler decides, HDVoiceCore):
//    Kokoro  rendered 2–3 sentences ahead (one render at a time, none while paused or thermally
//            throttled) by KokoroService, post-processed (trim, loudness match, fades, pause as silence)
//            and scheduled on an AVAudioPlayerNode; the next ready sentence is queued right behind the
//            playing one, so playback is gapless.
//    Apple   AVSpeechSynthesizer (best installed voice, Premium > Enhanced > default) speaks a sentence
//            when Kokoro isn't loaded yet, failed, ran dry, or the phone is throttled; Kokoro takes over
//            again at a sentence boundary once it is two sentences ahead. It is rendered with
//            AVSpeechSynthesizer.write into the same player node as Kokoro (converted to the read's rate, mono),
//            so both voices get the same speed handling, "Voice volume" and limiter; a voice that can't
//            render to buffers falls back to speaking directly.
//  Both share the app's audio session (.playback/.spokenAudio), so lock screen, Now Playing, remote
//  commands and interruptions work the same for either voice. Main thread only.
//
//  Graph: player → gain stage ("Voice volume", 0–150 %) → peak limiter (only above 100 %) → output, or (CI /
//  simulator self-test without an audio device) a manual rendering mode in which a timer pulls audio at
//  real-time pace. One rate per read (SessionRate): 24 kHz (Mimi, Kokoro) as always, or 44.1 kHz when Nephis
//  reads with her studio pack; audio made at another rate is resampled to it before it becomes a buffer.
//

@preconcurrency import AVFoundation
import ExpressiveCore
import ExpressiveEngines
import Foundation
import HDVoiceCore
import HDVoiceKokoro
import os
import UIKit

/// Main-thread confined: NarrationController drives it on main; audio, synthesizer and Kokoro callbacks hop
/// to main before touching its state.
final class HybridSpeechEngine: NSObject, SpeechEngine, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    weak var delegate: SpeechEngineDelegate?

    /// Per chapter (NarrationController sets these before enqueue).
    var kokoroVoice = VoiceCatalog.defaultVoiceId
    /// Narrator mode (polish and room tone are applied here; parts and pauses come with the segments).
    var narrator = NarratorSettings()
    /// Narrator mode's polish chain for this session (nil: off; PCM.prepareSentence as before).
    private var polish: NarrationPolish?
    /// A system voice the user picked explicitly (Narration.setOptions voiceId), else automatic.
    var explicitAppleVoice: String?
    /// The next chapter's first sentences: once this chapter is fully rendered, Kokoro renders these into
    /// its warm cache, so the chapter change starts with Kokoro at once (NarrationController sets them).
    var lookahead: [SpeechSegment] = []
    private var prewarming = false
    /// Where each chapter appended to this read starts (`append`): no call groups sentences across one, and Nephis's
    /// first call there gets the chapter break as its pause.
    private var chapterStarts: Set<Int> = []
    /// Each chapter's curly single quotes (QuoteRouter.SingleQuotes: thoughts in a chapter quoting speech with double
    /// quotes, speech in one without), by the chapter's first sentence; for her dialogue pack's quote routing.
    private var quoteStyles: [Int: QuoteRouter.SingleQuotes] = [:]
    /// Another chapter follows this read's last sentence (NarrationController: auto-continue with a next chapter), so her
    /// last call keeps its trailing silence for the join into it instead of ending the read there.
    var continuesIntoNext = false
    /// The read's first calls, already rendered by the shared pipeline (NarrationController's hand-off: a downloaded
    /// chapter ended and the next one is read live): `enqueue` starts with them instead of a cold call. Taken by `enqueue`.
    var warmStart: WarmStart?

    struct WarmStart {
        /// The read's first sentences it was made for (their text), and the sentences of each call, in order.
        let texts: [String]
        let calls: [[Int]]
        /// One finished piece per sentence, at `rate`, made at the listener's `speed`.
        let pieces: [[Float]]
        let rate: Int
        let speed: Float
        /// ExpressiveService.flowSequence after its last call: still the same, her read goes on from it (no fresh read).
        let sequence: Int
    }
    /// When the read began waiting for its next sentence after it had started (the log's underruns); nil = not waiting.
    private var waitBegan: Date?
    /// Listen › the expressive engine that reads chapters (DeliverySettings.listenEngine; Chatterbox Nano = the
    /// "Narrator" voice), nil = Kokoro. Kokoro renders any sentence it can't: not downloaded or loaded yet, the
    /// app in the background (Nano runs on the GPU, which iOS forbids there), thermal throttling, a failed render.
    var listenEngine: ExpressiveEngineID?
    /// The AI director (SceneReader): moods the on-device model gave for sentences ahead, the next sentence to send,
    /// and whether a window is being read.
    private var sceneMoods: [Int: String] = [:]
    private var sceneNext = 0
    private var sceneBusy = false
    /// The chapter's brief (SceneReader.brief), asked once per read; windows asked before it arrives go without.
    private var chapterBrief: String?
    private var briefAsked = false
    /// How many sentences into the brief's read this read starts (its part numbers). The director's answers are kept
    /// across new reads of a chapter (a seek, a restart: heat batch 1) in DirectorStore, shared with audio downloads.
    private var briefOffset = 0
    /// How to say the homographs of sentences ahead (SceneReader.senses): index → [word: respelling, "" = as written];
    /// Heteronyms.pocketText uses them where its rules only guessed.
    private var sceneSenses: [Int: [String: String]] = [:]
    static let sceneWindow = 10
    static let sceneContext = 3

    /// The render-ahead window once the narrator voice is ready (smaller while it loads).
    private var fullAhead = 3
    /// Nephis reads alone (Kasta, 2026-10-08: "the good Nephis voice always, no fallback"): the session waits for her
    /// (loading, late, a sentence tried again) instead of handing sentences to Kokoro or the Apple voice. Only if her
    /// model can't be used at all (not installed, failed to load, crashed, failing sentence after sentence) does the
    /// fallback read, so a chapter never just stops.
    private var nephisOnly = false
    /// Words dropped at the end of an expressive render: one retake (Pocket TTS).
    private var completeness = CompletenessGuard()
    private(set) var retakes = 0
    /// The sentence Kokoro is rendering in place of a late narrator-voice render, and how often that happened.
    private var standIn: Int?
    /// Nephis's flow engine: one render at a time, in reading order; `flowNext` is the sentence the next call must
    /// start at to continue the read (anything else starts the flow afresh: a seek, a failure).
    private var flowBusy = false
    private var flowNext = -1
    /// ExpressiveService.flowSequence after this read's last call: anything else read with her engine since (an audio
    /// download's call while Listen was paused, a test), her next call starts her read afresh.
    private var flowOwn = -1
    private(set) var standIns = 0
    /// Natural delivery for this session (the expressive engine reads chapters and Settings › Voices › Expressive voices ›
    /// Natural delivery is on); nil = the narrator polish or plain loudness matching as before.
    private var natural: NaturalFinisher?

    private(set) var currentSource: VoiceSource?
    /// The expressive engine that rendered the sentence playing now (nil: Kokoro or the Apple voice).
    private(set) var currentExpressive: ExpressiveEngineID?
    private(set) var lastFallback: FallbackReason?

    private var audioEngine = AVAudioEngine()
    private var player = AVAudioPlayerNode()
    private var gainStage = AudioGraphParts.gainStage()
    private var limiter = AudioGraphParts.limiter()
    /// "Voice volume" 0–1.5 (VoiceVolume): applied live to every voice.
    var volume: Double = 1 {
        didSet { AudioGraphParts.apply(volume: volume, gain: gainStage, limiter: limiter) }
    }
    /// The read's format (`useRate`): the graph, every buffer, the recording and natural delivery run at its rate.
    private var format = AVAudioFormat(standardFormatWithSampleRate: Double(SessionRate.standard), channels: 1)!
    /// The read's sample rate: 24 kHz, or her studio's 44.1 kHz (SessionRate.forRead).
    var sessionRate: Int { Int(format.sampleRate) }
    /// The read is at her studio's rate: audio at any other rate is resampled to it (a 24 kHz read takes 24 kHz only).
    private var studioRead: Bool { sessionRate != SessionRate.standard }
    private var graphReady = false
    private var manualTimer: DispatchSourceTimer?
    private(set) var manualOutput = false

    private let synth = AVSpeechSynthesizer()
    private var segments: [SpeechSegment] = []
    private var scheduler: HybridScheduler?
    private var gen = 0
    /// Bumped when the audio graph is restarted: completions of buffers from before are ignored.
    private var epoch = 0
    private var buffers: [Int: AVAudioPCMBuffer] = [:]
    /// Which voice rendered each buffer (a Kokoro voice id, or an expressive engine's id).
    private var bufferVoices: [Int: String] = [:]
    /// Kokoro segments scheduled on the player node, in play order (first = audible).
    private var queued: [Int] = []
    private var appleSegment: Int?
    private var appleUtterance: AVSpeechUtterance?
    /// The Apple sentence being rendered into the graph (nil: none, or spoken directly by the synthesizer).
    private var appleRender: AppleRender?
    /// The Apple sentence is spoken directly by AVSpeechSynthesizer (its voice couldn't render to buffers).
    private var appleDirect = false
    /// That direct sentence is waiting for resume(): the switch to direct speech came while paused, so it wasn't spoken.
    private var appleDirectHeld = false
    private var waitItem: DispatchWorkItem?
    /// Nephis's paced render: the next call once the gap after the last one has passed.
    private var paceItem: DispatchWorkItem?
    /// When her last call's latents were ready (the pacing gap counts from there).
    private var lastFlowDone: Date?
    /// Her renders at background priority (heat batch 1, RenderPacer.relaxed: over 30 s banked, back under 15 s).
    private var relaxedRenders = false
    /// Her cushion (heat plan 2026-10-13): renders stop once it is banked and start again when playback has drawn it
    /// down (RenderPacer); also the read's generated/played seconds and duty cycle for the Voice test report.
    private var pacer = RenderPacer()
    /// When the read stopped (the report's duty cycle counts the read's time only); nil while it goes on.
    private var sessionEnded: Date?
    private var waiting = false
    private var paused = false
    private var loudness = LoudnessMatcher()
    private var sessionStart = Date()
    private var firstAudioLogged = false
    private let log = Logger(subsystem: "app.tachinovel", category: "voice")

    /// Session numbers for the Voice Lab (the scheduler's counters live with the session).
    private(set) var lastScheduler: HybridScheduler?

    override init() {
        super.init()
        synth.delegate = self
        synth.usesApplicationAudioSession = true
        synth.mixToTelephonyUplink = false
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(kokoroStatusChanged), name: KokoroService.statusChanged, object: nil)
        // Her model may be used again (the wait after a memory warning ended, she reloaded): the read picks her up.
        nc.addObserver(self, selector: #selector(kokoroStatusChanged), name: ExpressiveService.statusChanged, object: nil)
        nc.addObserver(self, selector: #selector(thermalChanged), name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(mediaServicesReset), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
    }

    var isSpeaking: Bool { scheduler != nil && (!queued.isEmpty || appleSegment != nil || waiting) }
    var isPaused: Bool { paused }
    /// This read (a new one with every enqueue and stop): what an `append` made belongs to it.
    var session: Int { gen }
    /// Sentences in this read, appended chapters included (the index the next `append` starts at).
    var segmentCount: Int { segments.count }
    /// A chapter appended at sentence `start` is still part of this read.
    func follows(at start: Int) -> Bool { scheduler != nil && chapterStarts.contains(start) }

    /// The source of the sentence playing now (for the UI), and the scheduler snapshot.
    var snapshot: HybridScheduler? { scheduler ?? lastScheduler }

    // MARK: - SpeechEngine

    func enqueue(_ segs: [SpeechSegment]) {
        let warm = warmStart
        warmStart = nil
        stop()
        gen += 1
        // One rate for the whole read, picked before anything is rendered: her studio's 44.1 kHz, else 24 kHz.
        useRate(SessionRate.forRead(listenEngine))
        let rate = sessionRate
        lookahead = []
        chapterStarts = []
        quoteStyles = [:]
        segments = segs
        paused = false
        loudness = LoudnessMatcher()
        // 24 kHz: a studio read never matches it, so her studio sound gets no polish EQ (its tone is NephisFlowSynth's).
        polish = narrator.usesPolish ? NarrationPolish(sampleRate: 24_000, roomTone: narrator.usesRoomTone, compressorRatio: narrator.compressorRatio) : nil
        sessionStart = Date()
        sessionEnded = nil
        pacer = RenderPacer()
        firstAudioLogged = false
        currentSource = nil
        lastFallback = nil
        let prefs = VoiceSettings.shared.prefs
        let d = prefs.delivery
        if listenEngine != nil, d.natural {
            let pack = Self.breathPack
            var audio = DeliveryAudio()
            // The recorded inhales are unit-RMS snippets; −30 dB under the speech was the approved level (round 8).
            if !pack.isEmpty { audio.breathDB = -30 }
            // Nephis: no breaths ("no breaths please", Kasta), her own sound, the start-up sound turned down.
            let nephis = listenEngine == .pocketTts && d.isNephis
            let source: (any BreathSource)? = d.breaths && !nephis ? (pack.isEmpty ? ProceduralBreath() as any BreathSource : Self.breaths(at: rate)) : nil
            // Her studio sets her whole tone (NephisFlowSynth): no EQ on top of it here. A pack asking for her EQ after
            // the studio (chain "eqAfterStudio") gets it there, call by call at 44.1 kHz. Without it, her EQ as before.
            let tilt: VoiceTilt? = listenEngine == .pocketTts ? (nephis ? (studioRead ? nil : Self.nephisTilt) : VoiceTilt.pocketTts) : nil
            natural = NaturalFinisher(NaturalFinish(audio: audio, studioSound: d.studioSound, breaths: source, sampleRate: rate,
                                                    seed: UInt64(truncatingIfNeeded: gen), tilt: tilt, plain: nephis))
        } else {
            natural = nil
        }
        // The expressive voice renders about a minute ahead. Chatterbox Nano can't run in the background (GPU), so
        // locking the phone keeps it for that long before Kokoro takes over; Pocket TTS (CPU + Neural Engine) goes on.
        // Kokoro alone renders 8 ahead (about 40 s): 2–3 ran dry with the screen locked on a drive (Kasta, 2026-10-07).
        // Nephis renders about three minutes ahead, at a steady pace once a minute is banked (pumpRender's pacing):
        // the same work as a burst, lower peaks on the chip, and a cushion that carries her through a hot stretch.
        let nephisReads = listenEngine == .pocketTts && prefs.delivery.isNephis
        let ahead = listenEngine != nil ? max(prefs.clampedAhead, nephisReads ? 36 : 12) : max(prefs.clampedAhead, 8)
        fullAhead = ahead
        // Her model resting after a memory warning (crash plan a4): Kokoro reads meanwhile, as far ahead as it reads alone,
        // and she takes over when she is back (ExpressiveService.statusChanged). The studio test is waited out instead.
        let resting = listenEngine != nil && ExpressiveService.shared.loadBlock?.isMemoryRest == true
        nephisOnly = Self.nephisCanReadAlone(listenEngine) && !resting
        // While the narrator voice is still loading, Kokoro bridges only a sentence or two ahead, so the Narrator
        // takes over within moments instead of after a minute of Kokoro (kokoroStatusChanged widens it again).
        let bridging = !nephisOnly && !resting && (listenEngine.map { ExpressiveService.shared.isInstalled($0) && !expressiveUsable() } ?? false)
        let kokoro = kokoroState()  // may leave Nephis-only, so before the config reads it
        var s = HybridScheduler(count: segs.count, kokoro: kokoro,
                                config: HybridScheduler.Config(ahead: bridging ? min(ahead, 2) : resting ? min(ahead, Self.kokoroAloneAhead) : ahead,
                                                               patient: nephisOnly))
        s.throttled = ThermalPolicy.throttled(rawState: ProcessInfo.processInfo.thermalState.rawValue)
        // A late render at a paragraph start waits (a longer pause) before the Apple voice takes over.
        s.paragraphStarts = Set(segs.indices.dropFirst().filter { !Self.sameChunk(segs[$0 - 1], segs[$0]) })
        scheduler = s
        if let warm { useWarmStart(warm) }
        if KokoroService.shared.usable { KokoroService.shared.ensureLoaded() }
        if let id = listenEngine, ExpressiveService.supported(id), ExpressiveService.shared.isInstalled(id), !ExpressiveService.shared.crashDisabled {
            ExpressiveService.shared.ensureLoaded(id) { [weak self] _ in self?.kokoroStatusChanged() }
        }
        pumpRender()
        advance()
    }

    func stop() {
        gen += 1
        paceItem?.cancel()
        paceItem = nil
        lastFlowDone = nil
        relaxedRenders = false
        standIn = nil
        flowBusy = false
        flowNext = -1
        flowOwn = -1
        sceneMoods = [:]
        sceneSenses = [:]
        chapterBrief = nil
        briefAsked = false
        briefOffset = 0
        sceneNext = 0
        sceneBusy = false
        chapterStarts = []
        waitBegan = nil
        cancelWait()
        waiting = false
        if let s = scheduler {
            lastScheduler = s
            sessionEnded = Date()
        }
        scheduler = nil
        if graphReady { player.stop() }
        if synth.isSpeaking || synth.isPaused { synth.stopSpeaking(at: .immediate) }
        queued.removeAll()
        buffers.removeAll()
        bufferVoices.removeAll()
        appleSegment = nil
        appleUtterance = nil
        appleRender = nil
        appleDirect = false
        appleDirectHeld = false
        segments.removeAll()
        paused = false
        stopOutput()
    }

    /// The next chapter's sentences, after this read's last one (NarrationController, once the next chapter's text is
    /// fetched): they are rendered ahead like the rest, so the read runs on into the next chapter with a chapter pause,
    /// not a stop and a cold start (car ride 2026-10-13: the change between chapters took far too long; the next chapter
    /// only began rendering once this one had ended, and Nephis's first line then came from a cold start). Nephis's flow
    /// carries on across the break (her voice continues; `NephisFlow.chapterPause` before its first call). False when
    /// there is no read to append to.
    @discardableResult
    func append(_ segs: [SpeechSegment]) -> Bool {
        guard scheduler != nil, !segs.isEmpty else { return false }
        let start = segments.count
        segments += segs
        scheduler?.append(segs.count)
        chapterStarts.insert(start)
        // The new chapter starts a paragraph, and so does each paragraph in it (a late render there waits longer).
        let starts = (start..<segments.count).filter { $0 == start || !Self.sameChunk(segments[$0 - 1], segments[$0]) }
        scheduler?.paragraphStarts.formUnion(starts)
        // Kokoro's warm cache for the next chapter isn't needed any more: it renders the chapter itself now.
        lookahead = []
        log.notice("voice: next chapter appended at sentence \(start): \(segs.count) sentences")
        pumpRender()
        if waiting { advance() }
        return true
    }

    func pause() {
        guard scheduler != nil, !paused else { return }
        paused = true
        scheduler?.paused = true
        cancelWait()
        if !queued.isEmpty || appleRender != nil {
            player.pause()
            pauseOutput()
        }
        // At once, not at the end of the word: on a sentence's last word that end is the sentence's end, and it went on.
        if appleSegment != nil, appleDirect, synth.isSpeaking { synth.pauseSpeaking(at: .immediate) }
    }

    func resume() {
        guard scheduler != nil, paused else { return }
        paused = false
        scheduler?.paused = false
        if !queued.isEmpty {
            if startOutput() { player.play() } else { replayFromQueuedWithApple() }
        } else if let i = appleSegment, !appleDirect {
            if startOutput() { player.play() } else { speakApple(i, reason: lastFallback ?? .queueDry, restart: true) }
        } else if let i = appleSegment {
            if appleDirectHeld, let u = appleUtterance {
                // It went direct while paused and hasn't said a word yet.
                appleDirectHeld = false
                synth.speak(u)
            } else if !(synth.isPaused && synth.continueSpeaking()) {
                // An interruption can end the utterance: say this sentence again.
                speakApple(i, reason: lastFallback ?? .queueDry, restart: true)
            }
        } else {
            advance()
        }
        pumpRender()
    }

    // MARK: - Decisions

    private func kokoroState() -> HybridScheduler.KokoroState {
        if expressiveUsable() { return .ready }
        // Nephis alone: the scheduler's voice is her model; while it loads the session waits for it. If it can't be
        // used at all, the session reads the usual way (Kokoro, in her matched voice).
        if nephisOnly {
            // Too hot for her model (critical: expressiveUsable says no until it cools): waiting for her would be
            // silence for as long as the phone stays hot (Kasta, Texas drive 2026-10-09: the read stopped at 80% of a
            // chapter and a restart didn't bring it back). The usual fallbacks read instead; she is back next read.
            if ProcessInfo.processInfo.thermalState == .critical {
                leaveNephisOnly(reason: "the phone is too hot")
            } else if let block = ExpressiveService.shared.loadBlock, block.isMemoryRest {
                // Her model rests after a memory warning (crash plan a4): Kokoro reads, only as far ahead as it reads
                // alone, so she takes over again soon after she is back (statusChanged widens it again).
                leaveNephisOnly(reason: block.localizedDescription)
                scheduler?.config.ahead = min(fullAhead, Self.kokoroAloneAhead)
            } else if Self.nephisCanReadAlone(listenEngine) {
                // Loading, or the studio test running (the read is paused for it; she is warmed again after it).
                return .loading
            } else {
                leaveNephisOnly(reason: "her model can't be used")
            }
        }
        let k = KokoroService.shared
        guard k.isBundled else { return .unavailable }
        guard VoiceSettings.shared.prefs.kokoroEnabled else { return .disabled }
        if k.crashDisabled { return .unavailable }
        switch k.status {
        case .ready: return .ready
        case .loading, .unloaded: return .loading
        case .unavailable: return .unavailable
        }
    }

    /// Nothing is audible: pick the voice for the next sentence.
    private func advance() {
        guard scheduler != nil, !paused, queued.isEmpty, appleSegment == nil, standIn == nil else { return }
        cancelWait()
        guard let d = scheduler?.decide(now: Date().timeIntervalSince1970) else { return }
        switch d {
        case .kokoro(let i):
            waiting = false
            logWaitEnded(at: i)
            playKokoro(i)
        case .apple(let i, let reason):
            waiting = false
            logWaitEnded(at: i)
            if kokoroCanStandIn(reason) { return standInWithKokoro(i, reason: reason) }
            speakApple(i, reason: reason, restart: false)
        case .wait(let t):
            // A break the listener hears (the read had started): when it began, what it waits for, what is buffered.
            if waitBegan == nil, scheduler?.started == true, let s = scheduler {
                waitBegan = Date()
                let next = s.cursor
                let state = s.isReady(next) ? "ready" : s.rendering == next ? "rendering" : "not rendered"
                let ahead = bufferedAhead()
                log.notice("voice: waiting for sentence \(next) (\(state, privacy: .public)); \(ahead, format: .fixed(precision: 1)) s buffered\(self.chapterStarts.contains(next) ? " (a chapter start)" : "", privacy: .public)")
            }
            waiting = true
            let item = DispatchWorkItem { [weak self] in self?.advance() }
            waitItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + t, execute: item)
        case .finished:
            waiting = false
        }
        pumpRender()
    }

    private func cancelWait() {
        waitItem?.cancel()
        waitItem = nil
    }

    /// The wait logged by `advance` is over: sentence i plays after it (native.log, with the wait's length).
    private func logWaitEnded(at i: Int) {
        guard let began = waitBegan else { return }
        waitBegan = nil
        let seconds = Date().timeIntervalSince(began)
        log.notice("voice: sentence \(i) after a \(seconds, format: .fixed(precision: 2)) s wait")
        ListenReport.shared.breakEnded(seconds: seconds)
    }

    // MARK: - Kokoro

    private func pumpRender() {
        guard !paused else { return }
        pumpScene()
        if nephisOnly, scheduler?.kokoro != .unavailable, !expressiveUsable() {
            // Released (idle) or still loading: load her again; the session waits. Released for memory: not at once
            // (crash plan a4, the reload ran the app into iOS's limit again); kokoroState hands the read to Kokoro. The
            // studio test running: the session waits; she loads again when it ends (statusChanged).
            if let block = ExpressiveService.shared.loadBlock {
                if block.isMemoryRest { kokoroStatusChanged() }
            } else if ExpressiveService.shared.loadState(.pocketTts) == .unloaded {
                ExpressiveService.shared.ensureLoaded(.pocketTts) { [weak self] _ in self?.kokoroStatusChanged() }
            }
            return
        }
        // Her cushion banked: no render until playback has drawn it down (RenderPacer, with a look again scheduled).
        if nephisOnly, holdForCushion() { return }
        if nephisOnly, let wait = paceWait() {
            schedulePace(after: wait)
            return
        }
        guard let i = scheduler?.nextRender() else { return prewarmLookahead() }
        let g = gen
        if let id = listenEngine, expressiveUsable() {
            let flow = id == .pocketTts && ExpressiveService.shared.usesFlow
            if flow, flowBusy { return }
            // The sentences of one breath-group chunk (a paragraph, or a same-speaker run of quote paragraphs; the
            // script plans them) go to the model together, up to its per-call limit (Pocket TTS 400 characters, a
            // whole paragraph; Nano 120). One call paces them as one thought: no "Relax, little one." [stop]
            // "I don't bite…" [stop]. NaturalFinish cuts them apart again.
            // Flow: with almost nothing buffered (the start, after a seek) the first sentence goes alone, so her voice
            // starts sooner; then whole paragraphs.
            // Her flow: the shared plan's call (NephisCallPlan via NephisRenderPipeline: what the Voice speed test and
            // audio downloads ask for too): one sentence alone while almost nothing is buffered (the start, after a
            // seek: her voice starts sooner), then whole paragraphs.
            let flowLimit = NephisCallPlan.limit(first: planSentence(i), buffered: bufferedAhead())
            let group = flow ? flowGroup(from: i, limit: flowLimit) : chunkGroup(from: i, limit: id.maxCharactersPerCall)
            let members = [i] + (group.count > 1 ? scheduler?.extendRender(i, through: group[group.count - 1]) ?? [] : [])
            var line: ExpressiveLine
            var syllables = 0
            if flow {
                // The director's shaped text with heteronyms in their sense (the AI director's where the rules only
                // guessed), the text as written for a "raw" pack, the letter-weighted temperature, the pause before and the
                // dialogue handover across it (an appended chapter's first call: the chapter break), a fresh read or her
                // read going on, the read's last call unless another chapter follows, and her dialogue pack's quote hints.
                let reset = i != flowNext || ExpressiveService.shared.flowSequence != flowOwn
                let call = NephisCallPlan.call(members: members, count: segments.count, at: { self.planSentence($0) },
                                               context: NephisCallPlan.Context(reset: reset, continuesIntoNext: continuesIntoNext,
                                                                               dialogue: ExpressiveService.shared.nephisDialogue,
                                                                               singleQuotes: quoteStyle(at: i)),
                                               spoken: NephisRenderPipeline.spoken)
                line = call.line
                if reset { ExpressiveService.shared.countEvidence(\.readRestarts) }
                let budget = flowBudget(readChange: call.readChange, switches: call.switches)
                line.takes = budget.takes
                line.leadIn = budget.leadIn
                let text = line.text
                // Her studio (when on) on every call it can afford from its measured speed, the first call of a read
                // included (StudioBudget, 2026-10-15: at 23-47x real time it costs ~0.1-0.3 s a call); a slow studio
                // (cold guess, heat, Low Power Mode) only while playback has a cushion, as before. Forcing a slow one
                // before playback starts (8e86b7b) left a studio pack's Voice test silent for over a minute: each call's
                // audio waits for the one before it (2026-10-13). The studio also gives up on a call it can't finish at
                // real time (NephisFlowSynth, StudioPace).
                line.studio = Self.studioFor(characters: text.count, ahead: bufferedAhead())
                // Background priority while plenty is banked (same sound, less heat); user-initiated again when it runs low.
                relaxedRenders = RenderPacer.relaxed(was: relaxedRenders, buffered: bufferedAhead())
                if relaxedRenders { line.relaxed = true }
                flowBusy = true
                flowNext = (members.last ?? i) + 1
            } else {
                // The director's shaped text when it has one (falling endings, a beat before the key word, calmer CAPS),
                // heteronyms respelled in their sense for Pocket TTS; one read per call; one temperature per call (the
                // letter-weighted mean of the director's).
                let text = members.map { j in
                    let t = StyleMapper.plainText(Self.readText(segments[j], expressive: true))
                    return id == .pocketTts ? Heteronyms.pocketText(t, overrides: sceneSenses[j] ?? [:]) : t
                }.joined(separator: " ")
                line = ExpressiveLine(text: text, role: read(for: i) ?? "narrator")
                let weights = members.map { Float(max(1, Self.readText(segments[$0], expressive: true).count)) }
                let temps = members.map { segments[$0].natural?.params.temperature ?? 0.7 }
                line.temperature = zip(temps, weights).reduce(0) { $0 + $1.0 * $1.1 } / max(1, weights.reduce(0, +))
                syllables = members.reduce(0) { $0 + (segments[$1].natural?.params.syllables ?? 0) }
            }
            // A flow call frees the next one when its latents are ready (`prepared`), or here if it failed before.
            let prepared = FlowCall()
            // The report's duty cycle: from this call's start to its audio (calls in flight together count once).
            pacer.callStarted(now: Date().timeIntervalSince(sessionStart))
            let handle: (Result<ExpressiveAudio, Error>) -> Void = { [weak self] result in
                self?.onMain {
                    guard let self, g == self.gen, self.scheduler != nil else { return }
                    let made = (try? result.get()).map { $0.sampleRate > 0 ? Double($0.samples.count) / Double($0.sampleRate) : 0 } ?? 0
                    self.pacer.callEnded(now: Date().timeIntervalSince(self.sessionStart), audioSeconds: made)
                    if flow {
                        if !prepared.done { self.flowBusy = false }
                        if case .failure = result {
                            self.flowNext = -1
                            ExpressiveService.shared.countEvidence(\.failedCalls)
                        }
                    }
                    switch result {
                    case .success(let a) where !a.samples.isEmpty && (a.sampleRate == self.sessionRate || ((self.studioRead || flow) && a.sampleRate > 0)):
                        // Her studio's stream is at the read's rate and goes on at once; anything else in a studio read
                        // (a call made before her studio loaded) is resampled to it first. A 24 kHz read takes 24 kHz
                        // audio only, as before, except her flow engine's studio rate: a pack with a studio swapped in
                        // mid-read (ExpressiveService.reloadNephisModel restarts the read at the new rate; this covers
                        // the calls before that) is resampled down instead of all of it going to Kokoro. Without a
                        // studio her flow engine is at 24 kHz, so a read without one never gets here.
                        if !self.studioRead, a.sampleRate != self.sessionRate {
                            let rate = a.sampleRate
                            self.log.info("voice: \(id.rawValue, privacy: .public) gave \(rate) Hz in a 24 kHz read (sentence \(i)); resampled")
                        }
                        var samples = a.samples
                        // A call her mastering finished has her EQ already (NephisFlowSynth): nothing more on top.
                        let mastered = flow && a.mastered
                        // A call her engine already gave her EQ (before the tuner's finishing, pack chain "closeness",
                        // "breathAir", "room"): no EQ on top either.
                        let toned = flow && a.toned
                        if flow, self.natural != nil {
                            // Her Mimi sound without the studio, in her studio's read: her EQ at 24 kHz (the pipeline's step).
                            NephisRenderPipeline.preEQ(&samples, sampleRate: a.sampleRate, readRate: self.sessionRate, mastered: mastered,
                                                       toned: toned, tilt: Self.nephisTilt)
                        }
                        self.atSessionRate(KokoroAudio(samples: samples, sampleRate: a.sampleRate, synthMs: a.synthMs)) { [weak self] audio in
                            guard let self, g == self.gen, self.scheduler != nil else { return }
                            guard let audio else {
                                let rate = self.sessionRate
                                self.log.error("voice: \(id.rawValue, privacy: .public) audio for sentence \(i) couldn't be converted to \(rate) Hz; Kokoro renders it")
                                return self.expressiveFailed(members, gen: g)
                            }
                            if members.count > 1 {
                                self.renderedGroup(members, gen: g, voice: id.rawValue, audio: audio, mastered: mastered, toned: toned)
                            } else {
                                self.rendered(i, gen: g, voice: id.rawValue, result: .success(audio), mastered: mastered, toned: toned)
                            }
                        }
                    case .success:
                        self.log.error("voice: \(id.rawValue, privacy: .public) gave unusable audio for sentence \(i); Kokoro renders it")
                        self.expressiveFailed(members, gen: g)
                    case .failure(let error):
                        self.log.error("voice: \(id.rawValue, privacy: .public) failed on sentence \(i): \(error.localizedDescription, privacy: .public); Kokoro renders it")
                        self.expressiveFailed(members, gen: g)
                    }
                }
            }
            if flow {
                // The next call starts generating as soon as this one's latents are ready (it decodes meanwhile).
                ExpressiveService.shared.synthesizeFlow(line, prepared: { [weak self] in
                    prepared.done = true
                    guard let self, g == self.gen, self.scheduler != nil else { return }
                    self.flowBusy = false
                    self.lastFlowDone = Date()
                    self.pumpRender()
                }, completion: handle)
                flowOwn = ExpressiveService.shared.flowSequence
            } else {
                synthesizeExpressive(line, id: id, syllables: syllables, retry: true, completion: handle)
            }
            return
        }
        renderWithKokoro(i, gen: g)
    }

    /// The read's first calls from the hand-off's warm start, when they fit this read exactly (her flow, the same sentences,
    /// rate and speed, inside the render window): their sentences become ready at once, and her read goes on from them
    /// (no fresh read) when nothing else used her engine since. Otherwise the read starts as usual.
    private func useWarmStart(_ w: WarmStart) {
        let members = w.calls.flatMap { $0 }
        guard listenEngine == .pocketTts, natural != nil, ExpressiveService.shared.usesFlow, w.rate == sessionRate, !w.calls.isEmpty,
              w.pieces.count == w.texts.count, w.texts.count <= segments.count, members == Array(0..<w.texts.count),
              zip(w.texts, segments).allSatisfy({ $0 == $1.kokoroText }), abs((segments.first?.rate ?? 0) - w.speed) < 0.001,
              w.pieces.allSatisfy({ !$0.isEmpty }), let s = scheduler, s.kokoro == .ready, !s.throttled || s.config.patient, !s.paused,
              s.rendering == nil, s.cursor == 0, w.texts.count <= s.config.ahead else {
            log.info("voice: the hand-off's warm start doesn't fit this read; it starts as usual")
            return
        }
        for call in w.calls {
            guard let first = call.first, let last = call.last, scheduler?.nextRender() == first else { return }
            let taken = call.count > 1 ? scheduler?.extendRender(first, through: last) ?? [] : []
            for j in call {
                let buf = makeBuffer(w.pieces[j])
                scheduler?.renderDone(j, ok: buf != nil)
                if let buf, scheduler?.isReady(j) == true {
                    buffers[j] = buf
                    bufferVoices[j] = ExpressiveEngineID.pocketTts.rawValue
                }
            }
            if taken.count != call.count - 1 { log.error("voice: the warm start's call \(first) was cut by the render window") }
        }
        let goesOn = ExpressiveService.shared.flowSequence == w.sequence
        flowNext = goesOn ? w.texts.count : -1
        flowOwn = goesOn ? w.sequence : -1
        lastFlowDone = Date()
        log.notice("voice: read starts with \(w.texts.count) sentences rendered during the hand-off\(goesOn ? "" : " (her read starts afresh after them)", privacy: .public)")
    }

    /// One expressive render, checked for words dropped at the end (CompletenessGuard): a take that looks cut short
    /// is rendered once more and the longer of the two is kept.
    private func synthesizeExpressive(_ line: ExpressiveLine, id: ExpressiveEngineID, syllables: Int, retry: Bool,
                                      completion: @escaping (Result<ExpressiveAudio, Error>) -> Void) {
        ExpressiveService.shared.synthesize(line, engine: id) { [weak self] result in
            self?.onMain {
                guard let self, case .success(let a) = result else { return completion(result) }
                let per = CompletenessGuard.perSyllable(a.samples, sampleRate: a.sampleRate, syllables: syllables)
                guard retry, id == .pocketTts, self.completeness.isShort(per) else {
                    self.completeness.accept(per)
                    return completion(result)
                }
                self.retakes += 1
                self.log.error("voice: \(id.rawValue, privacy: .public) render looks cut short (\(per ?? 0, format: .fixed(precision: 3)) s/syllable); one retake")
                self.synthesizeExpressive(line, id: id, syllables: syllables, retry: false) { second in
                    if case .success(let b) = second, b.samples.count > a.samples.count { return completion(second) }
                    completion(result)
                }
            }
        }
    }

    /// The read of the narrator voice for sentence i (nil = the calm Narrator): the AI director's when it has read
    /// the sentence, else the script's; then the settings (Act out dialogue, Mood voices).
    private func read(for i: Int) -> String? {
        let d = VoiceSettings.shared.prefs.delivery
        return NephisRenderPipeline.read(at: i, count: segments.count, natural: { self.segments[$0].natural }, moods: sceneMoods, delivery: d,
                                         allMoods: listenEngine == .pocketTts && d.isNephis)
    }

    /// Sentence i as her calls see it (NephisCallPlan, through the shared pipeline).
    private func planSentence(_ i: Int) -> NephisCallPlan.Sentence {
        NephisRenderPipeline.sentence(segments[i], read: read(for: i), chapterStart: chapterStarts.contains(i), senses: sceneSenses[i] ?? [:])
    }

    /// Ask the on-device model to read the next window of sentences, up to about two windows ahead of the one playing
    /// (renders happen there). Never waits: a sentence rendered before its answer keeps the script's read.
    private func pumpScene() {
        guard listenEngine != nil, natural != nil, VoiceSettings.shared.prefs.delivery.usesAI, !sceneBusy,
              sceneNext < segments.count, SceneReader.shared.available else { return }
        if !briefAsked {
            briefAsked = true
            let g = gen
            let count = segments.count
            let chapterEnd = DirectorCache.chapterEnd(segments.map(\.kokoroText))
            // This chapter read before (a seek, a restart): its brief from then, no model calls.
            if let kept = DirectorStore.shared.cache.brief(end: chapterEnd, sentences: count) {
                chapterBrief = kept.text
                briefOffset = kept.offset
            } else {
                SceneReader.shared.brief(segments.map(sceneSentence)) { [weak self] b in
                    guard let self, g == self.gen else { return }
                    self.chapterBrief = b
                    if let b { DirectorStore.shared.cache.store(brief: b, end: chapterEnd, sentences: count) }
                }
            }
        }
        let playing = scheduler?.playing ?? 0
        guard sceneNext <= playing + 2 * Self.sceneWindow + 12 else { return }
        let start = sceneNext
        let end = min(segments.count, start + Self.sceneWindow)
        // Every sentence of the window read by the director before (this chapter, an earlier read): its answers again.
        if let kept = keptMoods(start..<end) {
            for (k, m) in kept.enumerated() { sceneMoods[start + k] = m }
            sceneNext = end
            askSenses(start..<end, gen: gen)
            return pumpScene()
        }
        let context = segments[max(0, start - Self.sceneContext)..<start].map(sceneSentence)
        let window = segments[start..<end].map(sceneSentence)
        sceneBusy = true
        let g = gen
        SceneReader.shared.read(context: context, window: window, brief: chapterBrief, part: (start + briefOffset) / SceneReader.briefPart + 1) { [weak self] moods in
            guard let self, g == self.gen else { return }
            self.sceneBusy = false
            if let moods {
                for (k, m) in moods.enumerated() where SceneMood.moods.contains(m) && self.segments.indices.contains(start + k) {
                    self.sceneMoods[start + k] = m
                    DirectorStore.shared.cache.store(mood: m, text: self.segments[start + k].kokoroText, before: self.sceneBefore(start + k))
                }
            }
            self.sceneNext = end
            self.askSenses(start..<end, gen: g)
            self.pumpScene()
        }
    }

    /// The sentence before sentence i in this read; nil for the read's first (its context isn't in the read).
    private func sceneBefore(_ i: Int) -> String? {
        i > 0 && segments.indices.contains(i - 1) ? segments[i - 1].kokoroText : nil
    }

    /// The director's moods for these sentences from an earlier read of the chapter, when it read every one of them.
    private func keptMoods(_ range: Range<Int>) -> [String]? {
        var out: [String] = []
        for i in range {
            guard let m = DirectorStore.shared.cache.mood(segments[i].kokoroText, before: sceneBefore(i)), SceneMood.moods.contains(m) else { return nil }
            out.append(m)
        }
        return out.isEmpty ? nil : out
    }

    /// How to say the homographs of these sentences (Pocket TTS only): an earlier read's answers where the director was
    /// asked, the on-device model for the rest (it is only asked about sentences that hold one).
    private func askSenses(_ range: Range<Int>, gen g: Int) {
        guard listenEngine == .pocketTts else { return }
        var asks: [(index: Int, text: String, before: String)] = []
        for i in range where segments.indices.contains(i) {
            if let known = DirectorStore.shared.cache.senses(segments[i].kokoroText, before: sceneBefore(i)) {
                sceneSenses[i] = known
            } else {
                asks.append((index: i, text: segments[i].kokoroText, before: sceneBefore(i) ?? ""))
            }
        }
        guard !asks.isEmpty else { return }
        SceneReader.shared.senses(asks) { [weak self] senses in
            guard let self, g == self.gen else { return }
            self.sceneSenses.merge(senses) { _, new in new }
            for (i, answer) in senses where self.segments.indices.contains(i) {
                DirectorStore.shared.cache.store(senses: answer, text: self.segments[i].kokoroText, before: self.sceneBefore(i))
            }
        }
    }

    private func sceneSentence(_ s: SpeechSegment) -> SceneReader.Sentence {
        let kind: SceneReader.Sentence.Kind = s.natural?.system == true ? .system : s.natural?.speaks == true ? .spoken : .narration
        return SceneReader.Sentence(text: s.kokoroText, kind: kind)
    }

    /// The text a voice reads: the director's shaped text for the expressive voice, the sentence for Kokoro.
    private static func readText(_ seg: SpeechSegment, expressive: Bool) -> String {
        expressive ? (seg.natural?.params.say ?? seg.kokoroText) : seg.kokoroText
    }

    /// Sentence i and the ones right after it that share one model call: natural delivery only, never the session's
    /// first sentence (it starts alone, fast), only inside the script's chunk, at most `limit` characters in all.
    private func chunkGroup(from i: Int, limit: Int) -> [Int] {
        // Settings › "sentences" (one call per sentence) is the fallback unit.
        guard natural != nil, i > 0, VoiceSettings.shared.prefs.delivery.usesChunks else { return [i] }
        var out = [i]
        var length = Self.readText(segments[i], expressive: true).count
        var j = i
        while j + 1 < segments.count, !chapterStarts.contains(j + 1), Self.sameChunk(segments[j], segments[j + 1]), read(for: j) == read(for: j + 1) {
            let next = Self.readText(segments[j + 1], expressive: true).count
            guard length + 1 + next <= limit else { break }
            length += 1 + next
            j += 1
            out.append(j)
        }
        return out
    }

    /// Nephis's flow: sentence i and the ones after it in the same paragraph (never across a paragraph break, so the
    /// model never reads one as a comma), same read, up to `limit` characters (NephisCallPlan.group). Only with natural
    /// delivery, whose cutter gives each sentence of the call its own buffer (renderedGroup); without it, one sentence per
    /// call, as chunkGroup. Never across a chapter appended to the read; a sentence the script split mid-way stays whole.
    private func flowGroup(from i: Int, limit: Int) -> [Int] {
        NephisCallPlan.group(from: i, count: segments.count, limit: limit, canCut: natural != nil) { self.planSentence($0) }
    }

    /// A pause this long or longer ends a paragraph (the script's paragraph and scene pauses).
    static let paragraphPause = NephisCallPlan.paragraphPause

    /// The single-quote style of the chapter sentence `i` belongs to (worked out once per chapter).
    private func quoteStyle(at i: Int) -> QuoteRouter.SingleQuotes {
        let start = chapterStarts.filter { $0 <= i }.max() ?? 0
        if let known = quoteStyles[start] { return known }
        let end = chapterStarts.filter { $0 > start }.min() ?? segments.count
        let style = NephisCallPlan.quoteStyle(segments[start..<max(start, end)].map(\.kokoroText))
        quoteStyles[start] = style
        return style
    }

    /// What a flow call may cost (NephisCallPlan.budget): the lightest call on a warm phone (from "fair": extras cost heat,
    /// Voice test 2026-10-09) or after her last user-initiated call came in under 1.5× real time; otherwise by the audio
    /// buffered ahead, each voice change counted as `NephisCallPlan.switchCost` seconds less.
    private func flowBudget(readChange: Bool, switches: Int) -> (takes: Int, leadIn: Bool) {
        let warm = ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.fair.rawValue
        let last = ExpressiveService.shared.flowStats.lastUrgent
        let x = last.flatMap { $0.totalMs > 0 ? $0.audioMs / $0.totalMs : nil }
        return NephisCallPlan.budget(buffered: bufferedAhead(), readChange: readChange, switches: switches, warm: warm, lastUrgentX: x)
    }

    /// Her EQ, with the top lift her installed pack asks for.
    static var nephisTilt: VoiceTilt {
        let svc = ExpressiveService.shared
        guard svc.nephisHighShelfDB != nil || svc.nephisSoftSibilance != nil else { return .nephis }
        return VoiceTilt.nephisTilt(highShelfDB: svc.nephisHighShelfDB ?? 5.95, softSibilance: svc.nephisSoftSibilance ?? true)
    }

    /// Audio banked before her renders slow to a steady pace (seconds).
    static let paceFrom = 60.0

    /// Her cushion is banked (RenderPacer: 90 s, 60 s from "fair" heat): hold her renders until playback has drawn it
    /// down by the refill (30 s, 20 s warm), and look again about then. Never while playback waits for audio. The
    /// Voice test's listening part reads through here too (Narration.play), so it is paced exactly as Listen is.
    private func holdForCushion() -> Bool {
        let now = Date().timeIntervalSince(sessionStart)
        guard !waiting else {
            pacer.release(now: now)
            return false
        }
        let thermal = ProcessInfo.processInfo.thermalState.rawValue
        let buffered = bufferedAhead()
        guard pacer.hold(buffered: buffered, thermal: thermal, now: now) else { return false }
        schedulePace(after: RenderPacer.recheck(buffered: buffered, thermal: thermal))
        return true
    }

    /// pumpRender again after `wait` seconds (one look scheduled at a time; a new read cancels it).
    private func schedulePace(after wait: TimeInterval) {
        guard paceItem == nil else { return }
        let g = gen
        let item = DispatchWorkItem { [weak self] in
            guard let self, g == self.gen else { return }
            self.paceItem = nil
            self.pumpRender()
        }
        paceItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: item)
    }

    /// Her render pacing in the read playing or the last one (Voice test report, heat plan 2026-10-13): the cushion
    /// she renders to and the level she renders again below, seconds generated (her audio) and played (every voice),
    /// the duty cycle (share of the read's time with her calls in flight), and the holds at the cushion.
    var pacingReport: [String: Any] {
        let p = pacer
        let now = (sessionEnded ?? Date()).timeIntervalSince(sessionStart)
        let thermal = ProcessInfo.processInfo.thermalState.rawValue
        let r1 = { (x: Double) in (x * 10).rounded() / 10 }
        return [
            "cushionSeconds": p.lastTarget, "resumeBelowSeconds": RenderPacer.resumeBelow(thermal: thermal),
            "cushionNow": RenderPacer.target(thermal: thermal), "bufferedSeconds": r1(scheduler == nil ? 0 : bufferedAhead()),
            "generatedSeconds": r1(p.generatedSeconds), "playedSeconds": r1(p.playedSeconds), "readSeconds": r1(now),
            "busySeconds": r1(p.busy(at: now)), "dutyCycle": (p.dutyCycle(at: now) * 100).rounded() / 100,
            "holds": p.holds, "heldSeconds": r1(p.held(at: now)), "holding": p.holding,
        ]
    }

    /// How long to wait before her next call: none while less than `paceFrom` is banked (she renders flat out to
    /// build the first minute), then a gap after each call (1.5 s, doubled from "fair" heat) until the cushion is
    /// banked (holdForCushion), so the chip runs at part duty instead of bursting.
    private func paceWait() -> TimeInterval? {
        let buffered = bufferedAhead()
        guard buffered > Self.paceFrom, let done = lastFlowDone else { return nil }
        var gap = buffered > 2 * Self.paceFrom ? 3.0 : 1.5
        if ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.fair.rawValue { gap *= 2 }
        let left = gap - Date().timeIntervalSince(done)
        return left > 0.05 ? left : nil
    }

    /// Seconds of rendered audio waiting after the sentence playing.
    private func bufferedAhead() -> Double {
        let playing = scheduler?.playing ?? 0
        return buffers.filter { $0.key > playing }.values.reduce(0.0) { $0 + Double($1.frameLength) / $1.format.sampleRate }
    }

    static let leadInAhead = NephisCallPlan.leadInAhead
    /// Her studio for a flow call of `characters` with `ahead` seconds buffered ahead of playback (ExpressiveLine.studio;
    /// Listen and the Voice speed test): StudioBudget with her studio's speed measured so far, the old cushion rule alone
    /// on a hot phone (serious heat or worse) or in Low Power Mode. Main thread.
    static func studioFor(characters: Int, ahead: Double) -> Bool {
        let info = ProcessInfo.processInfo
        let throttled = info.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue || info.isLowPowerModeEnabled
        return ExpressiveService.shared.studioBudget().use(characters: characters, ahead: ahead, throttled: throttled)
    }
    /// Sentences Kokoro renders ahead when it reads alone (enqueue): while her model rests after a memory warning.
    static var kokoroAloneAhead: Int { max(VoiceSettings.shared.prefs.clampedAhead, 8) }

    /// Whether a flow call got as far as its latents (main thread only).
    private final class FlowCall {
        var done = false
    }

    static func flowBudget(ahead: Double, readChange: Bool) -> (takes: Int, leadIn: Bool) {
        NephisCallPlan.flowBudget(ahead: ahead, readChange: readChange)
    }

    /// Two neighbouring sentences belong to one breath-group chunk: the script's chunk ids (speech-script.ts
    /// planChunks), or for an older web bundle without them, no paragraph-length pause between them.
    private static func sameChunk(_ a: SpeechSegment, _ b: SpeechSegment) -> Bool {
        if let x = a.natural?.chunk, let y = b.natural?.chunk { return x == y }
        return (a.naturalPause ?? a.pauseAfter) < 0.6 && a.natural?.voice == b.natural?.voice
    }

    /// The expressive voice couldn't make these: Kokoro renders the first now, the rest when their turn comes.
    private func expressiveFailed(_ members: [Int], gen g: Int) {
        if nephisOnly {
            // Nephis alone: she tries them again (a fresh read); failing again and again makes her unavailable and
            // the scheduler's fallback reads.
            for j in members.dropFirst() { scheduler?.releaseRender(j) }
            scheduler?.renderDone(members[0], ok: false)
            if scheduler?.kokoro == .unavailable {
                leaveNephisOnly(reason: "sentences kept failing")
                let state = kokoroState()  // reads (and may change) the scheduler: never inside a write to it
                scheduler?.kokoro = state
            }
            pumpRender()
            if waiting { advance() }
            return
        }
        for j in members.dropFirst() { scheduler?.releaseRender(j) }
        renderWithKokoro(members[0], gen: g)
    }

    /// One model call for several sentences: NaturalFinish finds the sentence ends in the audio and returns one buffer
    /// per sentence (the director's per-line controls apply when the cuts are confident).
    private func renderedGroup(_ members: [Int], gen g: Int, voice: String, audio: KokoroAudio, mastered: Bool = false, toned: Bool = false) {
        guard g == gen, scheduler != nil else { return }
        guard let nf = natural, audio.sampleRate == nf.sampleRate else {
            // Natural delivery went away mid-call (a settings change restarts the session anyway).
            for j in members.dropFirst() { scheduler?.releaseRender(j) }
            return rendered(members[0], gen: g, voice: voice, result: .success(audio), mastered: mastered, toned: toned)
        }
        let chars = members.reduce(0) { $0 + segments[$1].kokoroText.count }
        KokoroService.shared.stats.record(SentenceStat(index: members[0], characters: chars, synthMs: audio.synthMs, audioMs: audio.durationMs, voice: voice))
        let lines = members.map { naturalLine($0, expressive: true) }
        // The next call starts now; this one's chain runs meanwhile, off the main thread.
        scheduler?.releaseSynth(members[0])
        pumpRender()
        let speed = Double(segments[members[0]].rate)
        let flowUnit = ExpressiveService.shared.usesFlow && voice == ExpressiveEngineID.pocketTts.rawValue
        // Her flow call: the shared pipeline's finish (the same as the speed test's and audio downloads').
        let unit = flowUnit ? NephisRenderPipeline.unit(samples: audio.samples, lines: lines, speed: speed, mastered: mastered, toned: toned)
                            : NaturalFinish.Unit(samples: audio.samples, lines: lines, speed: speed, expressive: true)
        nf.render(unit) { [weak self] pieces in
            guard let self, g == self.gen, self.scheduler != nil else { return }
            // Voice test evidence: a sentence the cut left without audio is rendered again.
            if flowUnit {
                for k in members.indices where k >= pieces.count || pieces[k].frames.isEmpty {
                    ExpressiveService.shared.countEvidence(\.emptyPieces)
                }
            }
            for (k, j) in members.enumerated() {
                let buf = k < pieces.count ? self.makeBuffer(pieces[k].frames) : nil
                self.scheduler?.renderDone(j, ok: buf != nil)
                if let buf, self.scheduler?.isReady(j) == true {
                    self.buffers[j] = buf
                    self.bufferVoices[j] = voice
                }
            }
            self.pumpRender()
            if self.waiting { self.advance() } else { self.prefetch() }
        }
    }

    /// Natural delivery's description of sentence i: the director's per-line controls only for the expressive voice;
    /// the context pause and breath place for every sentence of the session.
    private func naturalLine(_ i: Int, expressive: Bool) -> NaturalFinish.Line {
        let seg = segments[i]
        let system = seg.natural?.system == true
        let d = VoiceSettings.shared.prefs.delivery
        return NaturalFinish.Line(params: expressive ? seg.natural?.params : nil, letters: Self.readText(seg, expressive: expressive).count,
                                  pause: seg.naturalPause ?? seg.pauseAfter, breath: seg.natural?.breath ?? Self.breathPoint(after: seg),
                                  seed: UInt64(truncatingIfNeeded: seg.id), systemChime: system && d.systemChime, systemTone: system && d.systemTone)
    }

    private func renderWithKokoro(_ i: Int, gen g: Int) {
        let seg = segments[i]
        let voice = kokoroVoice
        if let parts = seg.parts {
            KokoroService.shared.synthesize(parts: parts, voice: voice, speed: seg.rate) { [weak self] result in
                self?.rendered(i, gen: g, voice: voice, result: result)
            }
            return
        }
        KokoroService.shared.synthesize(text: seg.kokoroText, runs: seg.runs, voice: voice, speed: seg.rate) { [weak self] result in
            self?.rendered(i, gen: g, voice: voice, result: result)
        }
    }

    private func prewarmLookahead() {
        guard !prewarming, !lookahead.isEmpty, !expressiveUsable(), let s = scheduler, s.allRendered, !s.throttled, kokoroState() == .ready else { return }
        let seg = lookahead.removeFirst()
        // A sentence in parts is rendered when its turn comes (the warm cache holds whole sentences).
        if seg.parts != nil { return prewarmLookahead() }
        prewarming = true
        KokoroService.shared.prewarm(text: seg.kokoroText, runs: seg.runs, voice: kokoroVoice, speed: seg.rate) { [weak self] in
            self?.prewarming = false
            self?.prewarmLookahead()
        }
    }

    private func rendered(_ i: Int, gen g: Int, voice: String, result: Result<KokoroAudio, Error>, mastered: Bool = false,
                          toned: Bool = false) {
        guard g == gen, scheduler != nil else { return }
        switch result {
        case .success(let made) where made.sampleRate != sessionRate:
            // Kokoro's 24 kHz in her studio's 44.1 kHz read: resampled off the main thread, then finished as usual. (Never
            // in a 24 kHz read: everything there is 24 kHz.)
            let from = made.sampleRate
            return atSessionRate(made) { [weak self] audio in
                guard let self else { return }
                let next: Result<KokoroAudio, Error>
                if let audio { next = .success(audio) } else { next = .failure(SessionRate.ConversionFailed(from: from, to: self.sessionRate)) }
                self.rendered(i, gen: g, voice: voice, result: next, mastered: mastered, toned: toned)
            }
        case .success(let audio):
            KokoroService.shared.stats.record(SentenceStat(index: i, characters: segments[i].kokoroText.count, synthMs: audio.synthMs, audioMs: audio.durationMs, voice: voice))
            if let nf = natural, audio.sampleRate == nf.sampleRate {
                // Natural delivery: the clean-warm chain, rate leveling and the listener's speed (the expressive
                // engine has no speed of its own), the pause after and a breath inside it when the lung budget says
                // so. Kokoro's stand-in sentences get the same chain and pause, so levels never jump. It runs off the
                // main thread while the next sentence synthesizes.
                let expressive = voice == listenEngine?.rawValue
                let lines = [naturalLine(i, expressive: expressive)]
                let speed = expressive ? Double(segments[i].rate) : 1
                let flowUnit = expressive && ExpressiveService.shared.usesFlow && voice == ExpressiveEngineID.pocketTts.rawValue
                let unit = flowUnit ? NephisRenderPipeline.unit(samples: audio.samples, lines: lines, speed: speed, mastered: mastered, toned: toned)
                                    : NaturalFinish.Unit(samples: audio.samples, lines: lines, speed: speed, expressive: expressive)
                scheduler?.releaseSynth(i)
                pumpRender()
                nf.render(unit) { [weak self] pieces in
                    guard let self, g == self.gen, self.scheduler != nil else { return }
                    self.scheduler?.renderDone(i, ok: true)
                    if self.scheduler?.isReady(i) == true {
                        if let buf = self.makeBuffer(pieces.flatMap(\.frames)) {
                            self.buffers[i] = buf
                            self.bufferVoices[i] = voice
                        } else {
                            self.scheduler?.renderDone(i, ok: false)
                        }
                    }
                    self.pumpRender()
                    if self.waiting { self.advance() } else { self.prefetch() }
                }
                return
            }
            scheduler?.renderDone(i, ok: true)
            if scheduler?.isReady(i) == true {
                let frames: [Float]
                if var p = polish, audio.sampleRate == p.sampleRate {
                    frames = p.prepareSentence(audio.samples, pause: segments[i].pauseAfter)
                    polish = p
                } else {
                    frames = PCM.prepareSentence(audio.samples, sampleRate: audio.sampleRate, pause: segments[i].pauseAfter, loudness: &loudness)
                }
                if let buf = makeBuffer(frames) { buffers[i] = buf } else { scheduler?.renderDone(i, ok: false) }
            }
        case .failure(let error):
            KokoroService.shared.stats.recordFailure()
            log.error("voice: Kokoro failed on sentence \(i): \(error.localizedDescription, privacy: .public)")
            scheduler?.renderDone(i, ok: false)
        }
        pumpRender()
        if waiting { advance() } else { prefetch() }
    }

    /// `audio` at the read's rate, on main: at once when it already is (always, in a 24 kHz read), else resampled off
    /// the main thread first (SessionRate.resample; nil: it couldn't be converted). Dropped if the read changed meanwhile.
    private func atSessionRate(_ audio: KokoroAudio, _ done: @escaping (KokoroAudio?) -> Void) {
        guard audio.sampleRate != sessionRate else { return done(audio) }
        let g = gen
        let rate = sessionRate
        let deliver = MainBound(done)
        SessionRate.queue.async { [weak self] in
            let converted = SessionRate.resample(audio.samples, from: audio.sampleRate, to: rate)
                .map { KokoroAudio(samples: $0, sampleRate: rate, synthMs: audio.synthMs) }
            DispatchQueue.main.async { [weak self] in
                guard let self, g == self.gen else { return }
                deliver.value(converted)
            }
        }
    }

    /// One buffer in the read's format (frames at its rate).
    private func makeBuffer(_ frames: [Float]) -> AVAudioPCMBuffer? {
        guard !frames.isEmpty, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames.count)),
              let ch = buf.floatChannelData?[0] else { return nil }
        frames.withUnsafeBufferPointer { src in
            if let base = src.baseAddress { ch.update(from: base, count: frames.count) }
        }
        buf.frameLength = AVAudioFrameCount(frames.count)
        return buf
    }

    private func playKokoro(_ i: Int) {
        guard buffers[i] != nil else {
            // Rendered audio went missing (graph rebuilt): the Apple voice reads it.
            return speakApple(i, reason: .segmentFailed, restart: false)
        }
        guard startOutput() else { return replayFromQueuedWithApple(first: i) }
        schedule(i)
        if !player.isPlaying { player.play() }
        began(i, .kokoro)
        prefetch()
    }

    private func schedule(_ i: Int) {
        guard let buf = buffers[i] else { return }
        let g = gen
        let e = epoch
        queued.append(i)
        // Real output: when the sentence has actually been heard. Headless (manual rendering): when it was rendered.
        player.scheduleBuffer(buf, completionCallbackType: manualOutput ? .dataRendered : .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async { [weak self] in self?.kokoroFinished(i, gen: g, epoch: e) }
        }
    }

    /// Queue the next rendered sentence behind the playing one (one ahead in the node keeps decisions live).
    private func prefetch() {
        guard !queued.isEmpty, queued.count < 2, !paused, let j = scheduler?.prefetchNext() else { return }
        if buffers[j] == nil { return } // unreachable: prefetchNext only returns ready segments
        schedule(j)
    }

    private func kokoroFinished(_ i: Int, gen g: Int, epoch e: Int) {
        guard g == gen, e == epoch, queued.first == i else { return }
        queued.removeFirst()
        if let heard = buffers[i] { pacer.played(seconds: Double(heard.frameLength) / heard.format.sampleRate) }
        buffers[i] = nil
        scheduler?.finished(i)
        let id = segments[i].id
        delegate?.speechEngine(didFinish: id)
        guard g == gen else { return } // the delegate moved on (next chapter, stop)
        if let next = queued.first {
            began(next, .kokoro)
            prefetch()
        } else {
            advance()
        }
        pumpRender()
    }

    // MARK: - Kokoro standing in for the narrator voice

    /// The narrator voice (Pocket TTS) is late or failed a sentence: Kokoro reads it instead of the Apple voice,
    /// which sounds far closer (Kasta's drive: the Apple voice was the abrupt part). Not when Kokoro itself is
    /// what's missing, and not under thermal pressure (Kokoro would only add heat).
    private func kokoroCanStandIn(_ reason: FallbackReason) -> Bool {
        // Only while the narrator voice is the one rendering: when Kokoro itself renders (the narrator voice isn't
        // installed or is still loading), a late sentence is Kokoro's own, and asking Kokoro again only waits longer.
        guard expressiveUsable(), reason == .queueDry || reason == .segmentFailed else { return false }
        let k = KokoroService.shared
        return k.usable && k.status == .ready && !k.crashDisabled
    }

    /// One sentence by Kokoro, rendered now, through the same chain and pause as the narrator voice; the scheduler
    /// still counts it as a fallback, so the narrator voice returns once it is a couple of sentences ahead again.
    private func standInWithKokoro(_ i: Int, reason: FallbackReason) {
        let g = gen
        let seg = segments[i]
        standIn = i
        lastFallback = reason
        standIns += 1
        KokoroService.shared.synthesize(text: seg.kokoroText, runs: seg.runs, voice: kokoroVoice, speed: seg.rate) { [weak self] result in
            self?.onMain {
                guard let self, g == self.gen, self.standIn == i, self.scheduler != nil else { return }
                guard case .success(let made) = result else {
                    self.standIn = nil
                    return self.speakApple(i, reason: reason, restart: false)
                }
                // At the read's rate: in her studio's 44.1 kHz read, Kokoro's 24 kHz is resampled (off the main thread)
                // before the finish; in a 24 kHz read it goes on at once, as before.
                self.atSessionRate(made) { [weak self] audio in
                    guard let self, g == self.gen, self.standIn == i, self.scheduler != nil else { return }
                    guard let audio else {
                        self.standIn = nil
                        return self.speakApple(i, reason: reason, restart: false)
                    }
                    self.finishStandIn(i, audio: audio, pause: seg.pauseAfter, reason: reason, gen: g)
                }
            }
        }
    }

    /// The stand-in sentence through the same chain and pause as the narrator voice (its audio at the read's rate).
    private func finishStandIn(_ i: Int, audio: KokoroAudio, pause: TimeInterval, reason: FallbackReason, gen g: Int) {
        guard let nf = natural, audio.sampleRate == nf.sampleRate else {
            let frames = PCM.prepareSentence(audio.samples, sampleRate: audio.sampleRate, pause: pause, loudness: &loudness)
            return playStandIn(i, frames: frames, reason: reason)
        }
        let unit = NaturalFinish.Unit(samples: audio.samples, lines: [naturalLine(i, expressive: false)], speed: 1, expressive: false)
        nf.render(unit) { [weak self] pieces in
            guard let self, g == self.gen, self.standIn == i, self.scheduler != nil else { return }
            self.playStandIn(i, frames: pieces.flatMap(\.frames), reason: reason)
        }
    }

    private func playStandIn(_ i: Int, frames: [Float], reason: FallbackReason) {
        standIn = nil
        guard let buf = makeBuffer(frames), startOutput() else { return speakApple(i, reason: reason, restart: false) }
        buffers[i] = buf
        schedule(i)
        // Paused meanwhile: it waits in the player, and resume() starts it. (The node can still be "playing" from the
        // sentence before, which pause() left alone when nothing was queued: it would play this one at once.)
        if paused { player.pause() } else if !player.isPlaying { player.play() }
        began(i, .kokoro)
    }

    // MARK: - Apple voice

    private func speakApple(_ i: Int, reason: FallbackReason, restart: Bool) {
        lastFallback = reason
        let seg = segments[i]
        let u = AVSpeechUtterance(attributedString: seg.text)
        u.rate = VoiceSettings.avRate(seg.rate)
        u.pitchMultiplier = max(0.5, min(2, seg.pitch))
        u.voice = VoiceSettings.appleVoice(explicit: explicitAppleVoice, kokoroVoice: kokoroVoice)
        appleSegment = i
        appleUtterance = u
        appleRender = nil
        appleDirect = false
        appleDirectHeld = false
        if restart, synth.isSpeaking || synth.isPaused { synth.stopSpeaking(at: .immediate) }
        guard startOutput() else { return speakAppleDirectly(i, utterance: u) }
        renderAppleIntoGraph(i, utterance: u, pause: seg.pauseAfter)
    }

    /// AVSpeechSynthesizer.write → mono buffers at the read's rate on the player node (the same path as Kokoro). The
    /// sentence starts when its first buffer is queued and ends when its last one (+ the pause) has played.
    private func renderAppleIntoGraph(_ i: Int, utterance u: AVSpeechUtterance, pause: TimeInterval) {
        let g = gen
        let render = AppleRender(output: format, best: studioRead)
        appleRender = render
        // A voice that never delivers audio (some can't render to buffers): speak it directly instead.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, g == self.gen, u === self.appleUtterance, render === self.appleRender, !render.gotAudio, !render.ended else { return }
            self.log.error("voice: the Apple voice gave no audio buffers; speaking it directly")
            self.synth.stopSpeaking(at: .immediate)
            self.appleRender = nil
            // `u` already went to write(_:): AVSpeechSynthesizer throws (and the app terminates) if the same
            // utterance is enqueued twice, so speak a fresh copy; late callbacks for `u` no longer match.
            let again = Self.freshCopy(of: u)
            self.appleUtterance = again
            if self.manualOutput {
                again.postUtteranceDelay = pause
                self.speakAppleManually(i, utterance: again)
            } else {
                self.speakAppleDirectly(i, utterance: again)
            }
        }
        synth.write(u) { [weak self] buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            let converted = pcm.frameLength > 0 ? render.convert(pcm) : nil
            let ended = pcm.frameLength == 0
            DispatchQueue.main.async { [weak self] in
                guard let self, g == self.gen, u === self.appleUtterance, render === self.appleRender else { return }
                if ended {
                    guard !render.ended else { return }
                    render.ended = true
                    if let silence = self.silence(seconds: pause) { self.scheduleApple(silence, render: render, index: i) }
                    if render.pending == 0 { self.appleFinished(u) }
                    return
                }
                guard let converted, converted.frameLength > 0 else { return }
                render.gotAudio = true
                self.scheduleApple(converted, render: render, index: i)
            }
        }
    }

    /// A new utterance with the same text and settings (an utterance can be enqueued only once).
    private static func freshCopy(of u: AVSpeechUtterance) -> AVSpeechUtterance {
        let c = AVSpeechUtterance(attributedString: u.attributedSpeechString)
        c.voice = u.voice
        c.rate = u.rate
        c.pitchMultiplier = u.pitchMultiplier
        c.volume = u.volume
        c.preUtteranceDelay = u.preUtteranceDelay
        c.postUtteranceDelay = u.postUtteranceDelay
        return c
    }

    private func scheduleApple(_ buf: AVAudioPCMBuffer, render: AppleRender, index i: Int) {
        let g = gen
        let e = epoch
        render.pending += 1
        player.scheduleBuffer(buf, completionCallbackType: manualOutput ? .dataRendered : .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async { [weak self] in
                guard let self, g == self.gen, e == self.epoch, render === self.appleRender else { return }
                render.pending -= 1
                if render.pending == 0, render.ended, let u = self.appleUtterance { self.appleFinished(u) }
            }
        }
        if !render.started {
            render.started = true
            // Paused meanwhile: it waits in the player (see playStandIn), and resume() starts it.
            if paused { player.pause() } else if !player.isPlaying { player.play() }
            began(i, .apple)
        }
    }

    private func silence(seconds: TimeInterval) -> AVAudioPCMBuffer? {
        let frames = AVAudioFrameCount(max(0, seconds) * format.sampleRate)
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        buf.frameLength = frames
        if let ch = buf.floatChannelData?[0] { ch.update(repeating: 0, count: Int(frames)) }
        return buf
    }

    /// The old path: the synthesizer plays the sentence itself (its own output, not our graph).
    private func speakAppleDirectly(_ i: Int, utterance u: AVSpeechUtterance) {
        guard i == appleSegment, u === appleUtterance else { return }
        appleDirect = true
        u.postUtteranceDelay = segments[i].pauseAfter
        u.volume = Float(min(1, volume))
        if queued.isEmpty { pauseOutput() } // no Kokoro audio pending: let the graph sleep
        // Paused during the wait for its buffers: not a word until resume() (CI 2026-10-12: it spoke while paused, and
        // its end started the next chapter).
        if paused {
            appleDirectHeld = true
            return
        }
        synth.speak(u)
    }

    private func appleFinished(_ u: AVSpeechUtterance) {
        guard u === appleUtterance, let i = appleSegment else { return }
        appleSegment = nil
        appleUtterance = nil
        appleRender = nil
        appleDirect = false
        appleDirectHeld = false
        scheduler?.finished(i)
        let g = gen
        delegate?.speechEngine(didFinish: segments[i].id)
        guard g == gen else { return }
        advance()
        pumpRender()
    }

    private func began(_ i: Int, _ source: VoiceSource) {
        scheduler?.started(i)
        currentSource = source
        currentExpressive = source == .kokoro ? bufferVoices[i].flatMap(ExpressiveEngineID.init(rawValue:)) : nil
        if source == .kokoro { lastFallback = nil }
        if !firstAudioLogged {
            firstAudioLogged = true
            let ms = Date().timeIntervalSince(sessionStart) * 1000
            KokoroService.shared.stats.recordFirstAudio(FirstAudioStat(ms: ms, source: source.rawValue))
            ListenReport.shared.firstAudio(ms: ms)
        }
        delegate?.speechEngine(didStart: segments[i].id, source: source)
    }

    // AVSpeechSynthesizerDelegate: delivered on main in practice; hop if not (state is main-thread only).
    private func onMain(_ fn: @escaping () -> Void) {
        if Thread.isMainThread { return fn() }
        let work = MainBound(fn)
        DispatchQueue.main.async { work.value() }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        onMain {
            guard !self.manualOutput, self.appleDirect, utterance === self.appleUtterance, let i = self.appleSegment else { return }
            // Paused before the synthesizer got going (it starts a moment after speak(), and a pause then can miss it).
            if self.paused { self.synth.pauseSpeaking(at: .immediate) }
            self.began(i, .apple)
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onMain { if !self.manualOutput, self.appleDirect { self.appleFinished(utterance) } }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        onMain {
            // Word ranges only while the synthesizer speaks itself (rendering into the graph runs ahead of playback).
            guard self.appleDirect, utterance === self.appleUtterance, let i = self.appleSegment else { return }
            self.delegate?.speechEngine(willSpeak: self.segments[i].id, range: characterRange)
        }
    }

    // MARK: - Recording (Settings › Voices › Voice test)

    private var recordURL: URL?
    private var recordFile: AVAudioFile?
    private var recordTapped = false
    private var recordFloat = false

    /// Record what plays (after the volume stage and the limiter) into a WAV at the read's rate until `stopRecording`,
    /// so a test can be listened to on the PC exactly as the phone played it: 16-bit, or 32-bit float (`float32`: the
    /// exact samples, for measuring). A read at another rate starts the file again at that rate (`useRate`).
    func startRecording(to url: URL, float32: Bool = false) {
        stopRecording()
        try? FileManager.default.removeItem(at: url)
        recordURL = url
        recordFloat = float32
        installRecordTap()
    }

    /// Stops recording; the file, if anything was recorded.
    @discardableResult
    func stopRecording() -> URL? {
        if recordTapped {
            limiter.removeTap(onBus: 0)
            recordTapped = false
        }
        let url = recordFile != nil ? recordURL : nil
        recordFile = nil
        recordURL = nil
        return url
    }

    private func installRecordTap() {
        guard let url = recordURL, graphReady, !recordTapped else { return }
        let fmt = limiter.outputFormat(forBus: 0)
        if recordFile == nil {
            let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: fmt.sampleRate, AVNumberOfChannelsKey: fmt.channelCount,
                                           AVLinearPCMBitDepthKey: recordFloat ? 32 : 16, AVLinearPCMIsFloatKey: recordFloat]
            recordFile = try? AVAudioFile(forWriting: url, settings: settings, commonFormat: fmt.commonFormat, interleaved: fmt.isInterleaved)
        }
        guard let file = recordFile else { return }
        limiter.installTap(onBus: 0, bufferSize: 4096, format: fmt) { buffer, _ in try? file.write(from: buffer) }
        recordTapped = true
    }

    // MARK: - Audio graph

    /// Switch to manual rendering (no audio device: CI, headless simulator). Call before any playback.
    func useManualOutput() {
        guard !manualOutput else { return }
        teardownGraph()
        manualOutput = true
    }

    private func buildGraph() throws {
        guard !graphReady else { return }
        audioEngine.attach(player)
        audioEngine.attach(gainStage)
        audioEngine.attach(limiter)
        audioEngine.connect(player, to: gainStage, format: format)
        audioEngine.connect(gainStage, to: limiter, format: format)
        audioEngine.connect(limiter, to: audioEngine.mainMixerNode, format: format)
        AudioGraphParts.apply(volume: volume, gain: gainStage, limiter: limiter)
        if manualOutput {
            let out = AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: 1)!
            try audioEngine.enableManualRenderingMode(.offline, format: out, maximumFrameCount: 4096)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(configurationChanged(_:)), name: .AVAudioEngineConfigurationChange, object: audioEngine)
        graphReady = true
        installRecordTap()
    }

    /// The read's rate (SessionRate.forRead), called by `enqueue` right after `stop()`: a different rate rebuilds the
    /// graph at it (nothing is queued then), and a recording in progress starts its file again at that rate (a WAV
    /// holds one rate; the old file is removed before the new one is made, so its late close can't touch it).
    private func useRate(_ rate: Int) {
        guard rate != sessionRate, let f = AVAudioFormat(standardFormatWithSampleRate: Double(rate), channels: 1) else { return }
        log.info("voice: the read plays at \(rate) Hz")
        if recordTapped {
            limiter.removeTap(onBus: 0)
            recordTapped = false
        }
        recordFile = nil
        teardownGraph()
        format = f
        if let url = recordURL { try? FileManager.default.removeItem(at: url) }
    }

    private func teardownGraph() {
        if graphReady {
            NotificationCenter.default.removeObserver(self, name: .AVAudioEngineConfigurationChange, object: audioEngine)
            player.stop()
            audioEngine.stop()
        }
        manualTimer?.cancel()
        manualTimer = nil
        recordTapped = false
        audioEngine = AVAudioEngine()
        player = AVAudioPlayerNode()
        gainStage = AudioGraphParts.gainStage()
        limiter = AudioGraphParts.limiter()
        graphReady = false
        epoch += 1
    }

    /// Start (or keep) the output running. False if it can't start (Apple voice takes over).
    @discardableResult
    private func startOutput() -> Bool {
        do {
            try buildGraph()
            if !audioEngine.isRunning {
                audioEngine.prepare()
                try audioEngine.start()
            }
            if manualOutput, manualTimer == nil { startManualPump() }
            return true
        } catch {
            log.error("voice: audio engine failed to start: \(error.localizedDescription, privacy: .public)")
            if !manualOutput, NarrationSelfTest.isActive {
                // No audio device (CI): continue in manual rendering mode.
                useManualOutput()
                return startOutput()
            }
            return false
        }
    }

    private func pauseOutput() {
        guard graphReady, audioEngine.isRunning else { return }
        audioEngine.pause()
        manualTimer?.cancel()
        manualTimer = nil
    }

    private func stopOutput() {
        guard graphReady else { return }
        audioEngine.pause()
        manualTimer?.cancel()
        manualTimer = nil
    }

    /// Kokoro audio couldn't be played (output failed): the Apple voice reads from that sentence on.
    private func replayFromQueuedWithApple(first: Int? = nil) {
        let i = first ?? queued.first
        queued.removeAll()
        epoch += 1
        if let i { speakApple(i, reason: .segmentFailed, restart: true) }
    }

    @objc private func configurationChanged(_ note: Notification) {
        DispatchQueue.main.async {
            // The engine stopped itself (route/format change, e.g. Bluetooth). Restart and replay the queued
            // sentences from the start of the audible one.
            if self.scheduler != nil, self.queued.isEmpty, let i = self.appleSegment, !self.appleDirect {
                self.epoch += 1
                self.player.stop()
                ExpressiveService.shared.countEvidence(\.configReplays)
                if !self.paused { self.speakApple(i, reason: self.lastFallback ?? .queueDry, restart: true) }
                return
            }
            guard self.scheduler != nil, !self.queued.isEmpty else { return }
            ExpressiveService.shared.countEvidence(\.configReplays)
            let replay = self.queued
            self.queued.removeAll()
            self.epoch += 1
            self.player.stop()
            guard !self.paused else { return self.requeue(replay, play: false) }
            self.requeue(replay, play: true)
        }
    }

    @objc private func mediaServicesReset() {
        DispatchQueue.main.async {
            let replay = self.queued
            self.queued.removeAll()
            self.teardownGraph()
            if self.scheduler != nil, !replay.isEmpty { self.requeue(replay, play: !self.paused) }
            if self.scheduler != nil, replay.isEmpty, let i = self.appleSegment, !self.appleDirect, !self.paused {
                self.speakApple(i, reason: self.lastFallback ?? .queueDry, restart: true)
            }
        }
    }

    private func requeue(_ ids: [Int], play: Bool) {
        guard startOutput() else { return replayFromQueuedWithApple(first: ids.first) }
        for i in ids where buffers[i] != nil { schedule(i) }
        if play, !queued.isEmpty { player.play() }
        if queued.isEmpty { advance() }
    }

    // MARK: - Manual rendering (headless)

    private func startManualPump() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        let period = 0.02
        let frames = AVAudioFrameCount(format.sampleRate * period)
        let out = AVAudioPCMBuffer(pcmFormat: audioEngine.manualRenderingFormat, frameCapacity: 4096)!
        timer.schedule(deadline: .now(), repeating: period)
        timer.setEventHandler { [weak self] in
            guard let self, self.audioEngine.isInManualRenderingMode, self.audioEngine.isRunning else { return }
            _ = try? self.audioEngine.renderOffline(min(frames, out.frameCapacity), to: out)
            NarrationSelfTest.shared.observeOutput(out)
        }
        manualTimer = timer
        timer.resume()
    }

    /// Headless Apple voice (no audio device): render with write(_:toBufferCallback:) to get the real
    /// duration, and finish the sentence after that long (the speak() delegate path needs an output device).
    private func speakAppleManually(_ i: Int, utterance u: AVSpeechUtterance) {
        let g = gen
        let collector = RenderedDuration()
        // Watchdog: if the synthesizer never reports the end (no voices on a bare simulator), move on anyway.
        let limit = max(3, Double(u.speechString.count) / 8) + u.postUtteranceDelay
        DispatchQueue.main.asyncAfter(deadline: .now() + limit + 2) { [weak self] in
            guard let self, g == self.gen, u === self.appleUtterance, !collector.done else { return }
            collector.done = true
            if collector.seconds == 0 { self.began(i, .apple) }
            self.appleFinished(u)
        }
        synth.write(u) { [weak self] buffer in
            let frames = (buffer as? AVAudioPCMBuffer)?.frameLength ?? 0
            let rate = buffer.format.sampleRate
            DispatchQueue.main.async { [weak self] in
                guard let self, g == self.gen, u === self.appleUtterance else { return }
                if frames > 0 {
                    if collector.seconds == 0 { self.began(i, .apple) }
                    collector.seconds += Double(frames) / max(1, rate)
                } else if !collector.done {
                    // End of the utterance (an empty buffer).
                    collector.done = true
                    if collector.seconds == 0 { self.began(i, .apple) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + max(0.05, collector.seconds + u.postUtteranceDelay)) {
                        guard g == self.gen else { return }
                        self.appleFinished(u)
                    }
                }
            }
        }
    }

    // MARK: - Environment

    /// Recorded inhales that ship in the app (BuiltInVoices/breaths/*.wav: 24 kHz mono float, unit RMS, the owner's own
    /// recording cut by the round-8 breath-pack tool), loaded once. Empty: procedural breaths instead.
    private static let breathPack: SnippetBreaths = {
        var out: [[Float]] = []
        if let dir = Bundle.main.url(forResource: "BuiltInVoices", withExtension: nil)?.appendingPathComponent("breaths"),
           let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) {
            for name in names.sorted() where name.lowercased().hasSuffix(".wav") {
                guard let file = try? AVAudioFile(forReading: dir.appendingPathComponent(name)),
                      file.processingFormat.sampleRate == 24_000, file.processingFormat.channelCount == 1, file.length > 0, file.length < 48_000,
                      let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
                      (try? file.read(into: buf)) != nil, let ch = buf.floatChannelData?[0] else { continue }
                out.append(Array(UnsafeBufferPointer(start: ch, count: Int(buf.frameLength))))
            }
        }
        return SnippetBreaths(snippets: out, sampleRate: 24_000)
    }()

    /// The recorded inhales at the read's rate: as shipped for a 24 kHz read, resampled for any other (a breath at the
    /// wrong rate would be dropped by SnippetBreaths).
    private static func breaths(at rate: Int) -> SnippetBreaths {
        let pack = breathPack
        guard rate != pack.sampleRate, !pack.isEmpty else { return pack }
        return SnippetBreaths(snippets: pack.snippets.compactMap { SessionRate.resample($0, from: pack.sampleRate, to: rate) }, sampleRate: rate)
    }

    /// Where a breath may go in the pause after a sentence: a paragraph's end (a long pause) or a sentence's end. The
    /// lung budget (BreathPlanner) decides whether one actually goes there; it never adds time.
    private static func breathPoint(after seg: SpeechSegment) -> BreathPoint? {
        if seg.pauseAfter >= 0.6 { return .paragraph }
        if seg.pauseAfter >= 0.3 { return .sentence }
        return nil
    }

    /// The expressive engine can render the next sentence right now.
    private func expressiveUsable() -> Bool {
        guard let id = listenEngine else { return false }
        let svc = ExpressiveService.shared
        guard !svc.crashDisabled, ExpressiveService.supported(id), svc.isInstalled(id), svc.loadState(id) == .ready, svc.loadedID == id else { return false }
        if id.usesGPU, UIApplication.shared.applicationState != .active { return false }
        // Nephis alone keeps reading when the phone is warm (lighter calls: one take, no lead-in); only at critical.
        let thermal = ProcessInfo.processInfo.thermalState
        if nephisOnly { return thermal != .critical }
        return !ThermalPolicy.throttled(rawState: thermal.rawValue)
    }

    /// The session goes back to the usual fallbacks (Kokoro renders what Nephis can't).
    private func leaveNephisOnly(reason: String) {
        guard nephisOnly else { return }
        nephisOnly = false
        scheduler?.config.patient = false
        // The fallback has to be there to take over (a Nephis-only read never loaded it).
        if KokoroService.shared.usable { KokoroService.shared.ensureLoaded() }
        log.error("voice: Nephis can't read alone (\(reason, privacy: .public)): Kokoro reads in her voice meanwhile")
    }

    /// Nephis is the chosen reader and her model can be used on this phone (installed, not turned off after crashes,
    /// not failed to load).
    static func nephisCanReadAlone(_ engine: ExpressiveEngineID?) -> Bool {
        guard engine == .pocketTts, VoiceSettings.shared.prefs.delivery.isNephis else { return false }
        let svc = ExpressiveService.shared
        guard !svc.crashDisabled, ExpressiveService.supported(.pocketTts), svc.isInstalled(.pocketTts) else { return false }
        if case .failed = svc.loadState(.pocketTts) { return false }
        return true
    }

    @objc private func kokoroStatusChanged() {
        DispatchQueue.main.async {
            guard self.scheduler != nil else { return }
            // kokoroState() can leave Nephis-only, which writes the scheduler: computed before the write, not inside it
            // (overlapping access to the scheduler aborts the app)
            let state = self.kokoroState()
            self.scheduler?.kokoro = state
            if self.expressiveUsable(), let s = self.scheduler, s.config.ahead < self.fullAhead { self.scheduler?.config.ahead = self.fullAhead }
            self.pumpRender()
            if self.waiting { self.advance() }
        }
    }

    @objc private func thermalChanged() {
        DispatchQueue.main.async {
            let throttled = ThermalPolicy.throttled(rawState: ProcessInfo.processInfo.thermalState.rawValue)
            guard self.scheduler != nil else { return }
            // Critical heat takes her out of a Nephis-only read (kokoroState): the fallbacks take over at once.
            if ProcessInfo.processInfo.thermalState == .critical, self.nephisOnly { self.kokoroStatusChanged() }
            guard self.scheduler?.throttled != throttled else { return }
            self.scheduler?.throttled = throttled
            self.log.info("voice: thermal throttling \(throttled ? "on" : "off", privacy: .public)")
            self.pumpRender()
        }
    }
}

/// One Apple sentence rendered into the graph: converts the synthesizer's buffers (whatever its voice's
/// format) to the graph's format (the read's rate, mono), and counts what is still queued. `convert` runs on the
/// synthesizer's thread, one buffer at a time; the counters are main-thread only.
private final class AppleRender: @unchecked Sendable {
    let output: AVAudioFormat
    /// Her studio's read: the converter at its best quality (SessionRate.resample's settings). A 24 kHz read keeps
    /// the converter's defaults, as before.
    let best: Bool
    private var converter: AVAudioConverter?
    var pending = 0
    var started = false
    var ended = false
    var gotAudio = false

    init(output: AVAudioFormat, best: Bool = false) {
        self.output = output
        self.best = best
    }

    func convert(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if converter == nil || converter?.inputFormat != input.format {
            converter = AVAudioConverter(from: input.format, to: output)
            if best, let c = converter { SessionRate.useBestQuality(c) }
        }
        guard let converter else { return nil }
        let ratio = output.sampleRate / max(1, input.format.sampleRate)
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio + 1024)
        guard let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return nil }
        // The input block runs synchronously inside convert (this thread): one buffer, then "no data now".
        let fed = Box(false)
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if fed.value {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed.value = true
            inputStatus.pointee = .haveData
            return input
        }
        return status == .error || out.frameLength == 0 ? nil : out
    }
}

/// Accumulates the rendered length of a headless Apple utterance (main thread).
private final class RenderedDuration: @unchecked Sendable {
    var seconds: Double = 0
    var done = false
}

/// Natural delivery's audio finishing (NaturalFinish: the clean chain, leveling, breaths) off the main thread and in
/// the order asked, so the next synthesis starts while this one is finished. Its state is only touched on `queue`.
final class NaturalFinisher: @unchecked Sendable {
    private static let queue = DispatchQueue(label: "app.tachinovel.natural-finish", qos: .userInitiated)
    private var finish: NaturalFinish
    let sampleRate: Int

    init(_ finish: NaturalFinish) {
        self.finish = finish
        sampleRate = finish.sampleRate
    }

    /// One unit's buffers, delivered on the main queue.
    func render(_ unit: NaturalFinish.Unit, completion: @escaping ([NaturalFinish.Piece]) -> Void) {
        Self.queue.async {
            let pieces = self.finish.render(unit)
            DispatchQueue.main.async { completion(pieces) }
        }
    }
}

/// The sample rate of a read (Listen, the Voice Lab player, prepared chapters) and the conversion to it. Nephis with her
/// studio pack reads at her studio's 44.1 kHz (NephisFlowSynth renders it); every other read stays at Mimi's and
/// Kokoro's 24 kHz, exactly as before. `forRead` on the main thread (settings, the installed pack); `resample` anywhere.
enum SessionRate {
    /// Mimi's and Kokoro's rate: every read without her studio.
    static let standard = 24_000
    /// Her studio's rate (NephisStudio's vocoder).
    static let studio = 44_100
    /// Where audio at another rate is resampled for a read (off the main thread, in the order asked).
    static let queue = DispatchQueue(label: "app.tachinovel.session-rate", qos: .userInitiated)

    /// The rate for a read by `engine`: her studio's when Nephis reads, her pack ships a studio and the hidden studio
    /// switch is on (NephisModelPack.studioDirectory), and her engine's assets carry it (so her engine renders at it);
    /// else 24 kHz.
    static func forRead(_ engine: ExpressiveEngineID?) -> Int {
        guard engine == .pocketTts, VoiceSettings.shared.prefs.delivery.isNephis, NephisModelPack.studioDirectory != nil,
              ExpressiveService.shared.nephisFlowAssets?.studioDirectory != nil else { return standard }
        return studio
    }

    /// AVAudioConverter at its best: max quality, the Mastering algorithm.
    static func useBestQuality(_ c: AVAudioConverter) {
        c.sampleRateConverterQuality = AVAudioQuality.max.rawValue
        c.sampleRateConverterAlgorithm = AVSampleRateConverterAlgorithm_Mastering
    }

    /// Mono `x` from `from` Hz to `to` Hz in one pass (best quality, zero-latency priming, the end flushed), exactly
    /// round(count × to / from) samples long (the converter's last samples trimmed or padded with silence), so durations
    /// and timings hold. `x` itself when the rates match; nil if it can't be converted.
    static func resample(_ x: [Float], from: Int, to: Int) -> [Float]? {
        guard from != to else { return x }
        guard from > 0, to > 0 else { return nil }
        let length = Int((Double(x.count) * Double(to) / Double(from)).rounded())
        guard !x.isEmpty, length > 0 else { return [] }
        guard let inFormat = AVAudioFormat(standardFormatWithSampleRate: Double(from), channels: 1),
              let outFormat = AVAudioFormat(standardFormatWithSampleRate: Double(to), channels: 1),
              let converter = AVAudioConverter(from: inFormat, to: outFormat),
              let input = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(x.count)),
              let src = input.floatChannelData?[0],
              let output = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(length + 4096)) else { return nil }
        useBestQuality(converter)
        converter.primeMethod = .normal
        x.withUnsafeBufferPointer { p in
            if let base = p.baseAddress { src.update(from: base, count: x.count) }
        }
        input.frameLength = AVAudioFrameCount(x.count)
        // The input block runs synchronously inside convert (this thread): the whole input once, then its end.
        let fed = Box(false)
        var out: [Float] = []
        out.reserveCapacity(length + 64)
        for _ in 0..<16 {  // one pass in practice: the output buffer has room for all of it
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, inputStatus in
                if fed.value {
                    inputStatus.pointee = .endOfStream
                    return nil
                }
                fed.value = true
                inputStatus.pointee = .haveData
                return input
            }
            if status == .error || error != nil { return nil }
            if output.frameLength > 0, let ch = output.floatChannelData?[0] {
                out.append(contentsOf: UnsafeBufferPointer(start: ch, count: Int(output.frameLength)))
            }
            if status == .endOfStream || output.frameLength == 0 { break }
        }
        guard !out.isEmpty else { return nil }
        if out.count > length {
            out.removeLast(out.count - length)
        } else if out.count < length {
            out.append(contentsOf: repeatElement(Float(0), count: length - out.count))
        }
        return out
    }

    /// Audio that couldn't be converted to the read's rate.
    struct ConversionFailed: LocalizedError {
        let from: Int
        let to: Int
        var errorDescription: String? { "its \(from) Hz audio couldn't be converted to \(to) Hz" }
    }
}
