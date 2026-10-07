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
//            AVSpeechSynthesizer.write into the same player node as Kokoro (converted to 24 kHz mono), so
//            both voices get the same speed handling, "Voice volume" and limiter; a voice that can't
//            render to buffers falls back to speaking directly.
//  Both share the app's audio session (.playback/.spokenAudio), so lock screen, Now Playing, remote
//  commands and interruptions work the same for either voice. Main thread only.
//
//  Graph: player → gain stage ("Voice volume", 0–150 %) → peak limiter (only above 100 %) → output, or (CI /
//  simulator self-test without an audio device) a manual rendering mode in which a timer pulls audio at
//  real-time pace.
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
    /// Listen › the expressive engine that reads chapters (DeliverySettings.listenEngine; Chatterbox Nano = the
    /// "Narrator" voice), nil = Kokoro. Kokoro renders any sentence it can't: not downloaded or loaded yet, the
    /// app in the background (Nano runs on the GPU, which iOS forbids there), thermal throttling, a failed render.
    var listenEngine: ExpressiveEngineID?
    /// The render-ahead window once the narrator voice is ready (smaller while it loads).
    private var fullAhead = 3
    /// Words dropped at the end of an expressive render: one retake (Pocket TTS).
    private var completeness = CompletenessGuard()
    private(set) var retakes = 0
    /// Natural delivery for this session (the expressive engine reads chapters and Settings › Voices › Expressive voices ›
    /// Natural delivery is on); nil = the narrator polish or plain loudness matching as before.
    private var natural: NaturalFinish?

    private(set) var currentSource: VoiceSource?
    private(set) var lastFallback: FallbackReason?

    private var audioEngine = AVAudioEngine()
    private var player = AVAudioPlayerNode()
    private var gainStage = AudioGraphParts.gainStage()
    private var limiter = AudioGraphParts.limiter()
    /// "Voice volume" 0–1.5 (VoiceVolume): applied live to every voice.
    var volume: Double = 1 {
        didSet { AudioGraphParts.apply(volume: volume, gain: gainStage, limiter: limiter) }
    }
    private let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
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
    /// Kokoro segments scheduled on the player node, in play order (first = audible).
    private var queued: [Int] = []
    private var appleSegment: Int?
    private var appleUtterance: AVSpeechUtterance?
    /// The Apple sentence being rendered into the graph (nil: none, or spoken directly by the synthesizer).
    private var appleRender: AppleRender?
    /// The Apple sentence is spoken directly by AVSpeechSynthesizer (its voice couldn't render to buffers).
    private var appleDirect = false
    private var waitItem: DispatchWorkItem?
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
        nc.addObserver(self, selector: #selector(thermalChanged), name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(mediaServicesReset), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
    }

    var isSpeaking: Bool { scheduler != nil && (!queued.isEmpty || appleSegment != nil || waiting) }
    var isPaused: Bool { paused }

    /// The source of the sentence playing now (for the UI), and the scheduler snapshot.
    var snapshot: HybridScheduler? { scheduler ?? lastScheduler }

    // MARK: - SpeechEngine

    func enqueue(_ segs: [SpeechSegment]) {
        stop()
        gen += 1
        lookahead = []
        segments = segs
        paused = false
        loudness = LoudnessMatcher()
        polish = narrator.usesPolish ? NarrationPolish(sampleRate: 24_000, roomTone: narrator.usesRoomTone, compressorRatio: narrator.compressorRatio) : nil
        sessionStart = Date()
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
            let source: (any BreathSource)? = d.breaths ? (pack.isEmpty ? ProceduralBreath() as any BreathSource : pack) : nil
            natural = NaturalFinish(audio: audio, studioSound: d.studioSound, breaths: source, seed: UInt64(truncatingIfNeeded: gen),
                                    tilt: listenEngine == .pocketTts ? .pocketTts : nil)
        } else {
            natural = nil
        }
        // The expressive voice renders about a minute ahead. Chatterbox Nano can't run in the background (GPU), so
        // locking the phone keeps it for that long before Kokoro takes over; Pocket TTS (CPU + Neural Engine) goes on.
        let ahead = listenEngine != nil ? max(prefs.clampedAhead, 12) : prefs.clampedAhead
        fullAhead = ahead
        // While the narrator voice is still loading, Kokoro bridges only a sentence or two ahead, so the Narrator
        // takes over within moments instead of after a minute of Kokoro (kokoroStatusChanged widens it again).
        let bridging = listenEngine.map { ExpressiveService.shared.isInstalled($0) && !expressiveUsable() } ?? false
        var s = HybridScheduler(count: segs.count, kokoro: kokoroState(), config: HybridScheduler.Config(ahead: bridging ? min(ahead, 2) : ahead))
        s.throttled = ThermalPolicy.throttled(rawState: ProcessInfo.processInfo.thermalState.rawValue)
        // A late render at a paragraph start waits (a longer pause) before the Apple voice takes over.
        s.paragraphStarts = Set(segs.indices.dropFirst().filter { !Self.sameChunk(segs[$0 - 1], segs[$0]) })
        scheduler = s
        if KokoroService.shared.usable { KokoroService.shared.ensureLoaded() }
        if let id = listenEngine, ExpressiveService.supported(id), ExpressiveService.shared.isInstalled(id), !ExpressiveService.shared.crashDisabled {
            ExpressiveService.shared.ensureLoaded(id) { [weak self] _ in self?.kokoroStatusChanged() }
        }
        pumpRender()
        advance()
    }

    func stop() {
        gen += 1
        cancelWait()
        waiting = false
        if let s = scheduler { lastScheduler = s }
        scheduler = nil
        if graphReady { player.stop() }
        if synth.isSpeaking || synth.isPaused { synth.stopSpeaking(at: .immediate) }
        queued.removeAll()
        buffers.removeAll()
        appleSegment = nil
        appleUtterance = nil
        appleRender = nil
        appleDirect = false
        segments.removeAll()
        paused = false
        stopOutput()
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
        if appleSegment != nil, appleDirect, synth.isSpeaking { synth.pauseSpeaking(at: .word) }
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
            if !(synth.isPaused && synth.continueSpeaking()) {
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
        guard scheduler != nil, !paused, queued.isEmpty, appleSegment == nil else { return }
        cancelWait()
        guard let d = scheduler?.decide(now: Date().timeIntervalSince1970) else { return }
        switch d {
        case .kokoro(let i):
            waiting = false
            playKokoro(i)
        case .apple(let i, let reason):
            waiting = false
            speakApple(i, reason: reason, restart: false)
        case .wait(let t):
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

    // MARK: - Kokoro

    private func pumpRender() {
        guard !paused else { return }
        guard let i = scheduler?.nextRender() else { return prewarmLookahead() }
        let g = gen
        if let id = listenEngine, expressiveUsable() {
            // The sentences of one breath-group chunk (a paragraph, or a same-speaker run of quote paragraphs; the
            // script plans them) go to the model together, up to its per-call limit (Pocket TTS 400 characters, a
            // whole paragraph; Nano 120). One call paces them as one thought: no "Relax, little one." [stop]
            // "I don't bite…" [stop]. NaturalFinish cuts them apart again.
            let group = chunkGroup(from: i, limit: id.maxCharactersPerCall)
            let members = [i] + (group.count > 1 ? scheduler?.extendRender(i, through: group[group.count - 1]) ?? [] : [])
            // The director's shaped text when it has one (falling endings, a beat before the key word, calmer CAPS).
            let text = members.map { StyleMapper.plainText(Self.readText(segments[$0], expressive: true)) }.joined(separator: " ")
            // Dialogue and thoughts in the performed read of the same voice (one call is all one or the other).
            let performed = segments[i].natural?.performed == true && VoiceSettings.shared.prefs.delivery.performed
            var line = ExpressiveLine(text: text, role: performed ? ExpressiveLine.performedRole : "narrator")
            // One temperature per call: the letter-weighted mean of the director's (the script keeps calls similar).
            let weights = members.map { Float(max(1, Self.readText(segments[$0], expressive: true).count)) }
            let temps = members.map { segments[$0].natural?.params.temperature ?? 0.7 }
            line.temperature = zip(temps, weights).reduce(0) { $0 + $1.0 * $1.1 } / max(1, weights.reduce(0, +))
            let syllables = members.reduce(0) { $0 + (segments[$1].natural?.params.syllables ?? 0) }
            synthesizeExpressive(line, id: id, syllables: syllables, retry: true) { [weak self] result in
                self?.onMain {
                    guard let self, g == self.gen, self.scheduler != nil else { return }
                    switch result {
                    case .success(let a) where a.sampleRate == 24_000 && !a.samples.isEmpty:
                        let audio = KokoroAudio(samples: a.samples, sampleRate: a.sampleRate, synthMs: a.synthMs)
                        if members.count > 1 {
                            self.renderedGroup(members, gen: g, voice: id.rawValue, audio: audio)
                        } else {
                            self.rendered(i, gen: g, voice: id.rawValue, result: .success(audio))
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
            return
        }
        renderWithKokoro(i, gen: g)
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
        while j + 1 < segments.count, Self.sameChunk(segments[j], segments[j + 1]) {
            let next = Self.readText(segments[j + 1], expressive: true).count
            guard length + 1 + next <= limit else { break }
            length += 1 + next
            j += 1
            out.append(j)
        }
        return out
    }

    /// Two neighbouring sentences belong to one breath-group chunk: the script's chunk ids (speech-script.ts
    /// planChunks), or for an older web bundle without them, no paragraph-length pause between them.
    private static func sameChunk(_ a: SpeechSegment, _ b: SpeechSegment) -> Bool {
        if let x = a.natural?.chunk, let y = b.natural?.chunk { return x == y }
        return (a.naturalPause ?? a.pauseAfter) < 0.6 && a.natural?.performed == b.natural?.performed
    }

    /// The expressive voice couldn't make these: Kokoro renders the first now, the rest when their turn comes.
    private func expressiveFailed(_ members: [Int], gen g: Int) {
        for j in members.dropFirst() { scheduler?.releaseRender(j) }
        renderWithKokoro(members[0], gen: g)
    }

    /// One model call for several sentences: NaturalFinish finds the sentence ends in the audio and returns one buffer
    /// per sentence (the director's per-line controls apply when the cuts are confident).
    private func renderedGroup(_ members: [Int], gen g: Int, voice: String, audio: KokoroAudio) {
        guard g == gen, scheduler != nil else { return }
        guard var nf = natural, audio.sampleRate == nf.sampleRate else {
            // Natural delivery went away mid-call (a settings change restarts the session anyway).
            for j in members.dropFirst() { scheduler?.releaseRender(j) }
            return rendered(members[0], gen: g, voice: voice, result: .success(audio))
        }
        let chars = members.reduce(0) { $0 + segments[$1].kokoroText.count }
        KokoroService.shared.stats.record(SentenceStat(index: members[0], characters: chars, synthMs: audio.synthMs, audioMs: audio.durationMs, voice: voice))
        let lines = members.map { naturalLine($0, expressive: true) }
        let pieces = nf.render(NaturalFinish.Unit(samples: audio.samples, lines: lines, speed: Double(segments[members[0]].rate), expressive: true))
        natural = nf
        for (k, j) in members.enumerated() {
            let buf = k < pieces.count ? makeBuffer(pieces[k].frames) : nil
            scheduler?.renderDone(j, ok: buf != nil)
            if let buf, scheduler?.isReady(j) == true { buffers[j] = buf }
        }
        pumpRender()
        if waiting { advance() } else { prefetch() }
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

    private func rendered(_ i: Int, gen g: Int, voice: String, result: Result<KokoroAudio, Error>) {
        guard g == gen, scheduler != nil else { return }
        switch result {
        case .success(let audio):
            KokoroService.shared.stats.record(SentenceStat(index: i, characters: segments[i].kokoroText.count, synthMs: audio.synthMs, audioMs: audio.durationMs, voice: voice))
            scheduler?.renderDone(i, ok: true)
            if scheduler?.isReady(i) == true {
                let frames: [Float]
                if var nf = natural, audio.sampleRate == nf.sampleRate {
                    // Natural delivery: the clean-warm chain, rate leveling and the listener's speed (the expressive
                    // engine has no speed of its own), the pause after and a breath inside it when the lung budget
                    // says so. Kokoro's stand-in sentences get the same chain and pause, so levels never jump.
                    let expressive = voice == listenEngine?.rawValue
                    let unit = NaturalFinish.Unit(samples: audio.samples, lines: [naturalLine(i, expressive: expressive)],
                                                  speed: expressive ? Double(segments[i].rate) : 1, expressive: expressive)
                    frames = nf.render(unit).flatMap(\.frames)
                    natural = nf
                } else if var p = polish, audio.sampleRate == p.sampleRate {
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
        if restart, synth.isSpeaking || synth.isPaused { synth.stopSpeaking(at: .immediate) }
        guard startOutput() else { return speakAppleDirectly(i, utterance: u) }
        renderAppleIntoGraph(i, utterance: u, pause: seg.pauseAfter)
    }

    /// AVSpeechSynthesizer.write → 24 kHz mono buffers on the player node (the same path as Kokoro). The
    /// sentence starts when its first buffer is queued and ends when its last one (+ the pause) has played.
    private func renderAppleIntoGraph(_ i: Int, utterance u: AVSpeechUtterance, pause: TimeInterval) {
        let g = gen
        let render = AppleRender(output: format)
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
            if !paused, !player.isPlaying { player.play() }
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
        synth.speak(u)
    }

    private func appleFinished(_ u: AVSpeechUtterance) {
        guard u === appleUtterance, let i = appleSegment else { return }
        appleSegment = nil
        appleUtterance = nil
        appleRender = nil
        appleDirect = false
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
        if source == .kokoro { lastFallback = nil }
        if !firstAudioLogged {
            firstAudioLogged = true
            KokoroService.shared.stats.recordFirstAudio(FirstAudioStat(ms: Date().timeIntervalSince(sessionStart) * 1000, source: source.rawValue))
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
            let out = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
            try audioEngine.enableManualRenderingMode(.offline, format: out, maximumFrameCount: 4096)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(configurationChanged(_:)), name: .AVAudioEngineConfigurationChange, object: audioEngine)
        graphReady = true
    }

    private func teardownGraph() {
        if graphReady {
            NotificationCenter.default.removeObserver(self, name: .AVAudioEngineConfigurationChange, object: audioEngine)
            player.stop()
            audioEngine.stop()
        }
        manualTimer?.cancel()
        manualTimer = nil
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
                if !self.paused { self.speakApple(i, reason: self.lastFallback ?? .queueDry, restart: true) }
                return
            }
            guard self.scheduler != nil, !self.queued.isEmpty else { return }
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
        let frames = AVAudioFrameCount(24_000 * period)
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
        return !ThermalPolicy.throttled(rawState: ProcessInfo.processInfo.thermalState.rawValue)
    }

    @objc private func kokoroStatusChanged() {
        DispatchQueue.main.async {
            guard self.scheduler != nil else { return }
            self.scheduler?.kokoro = self.kokoroState()
            if self.expressiveUsable(), let s = self.scheduler, s.config.ahead < self.fullAhead { self.scheduler?.config.ahead = self.fullAhead }
            self.pumpRender()
            if self.waiting { self.advance() }
        }
    }

    @objc private func thermalChanged() {
        DispatchQueue.main.async {
            let throttled = ThermalPolicy.throttled(rawState: ProcessInfo.processInfo.thermalState.rawValue)
            guard self.scheduler != nil, self.scheduler?.throttled != throttled else { return }
            self.scheduler?.throttled = throttled
            self.log.info("voice: thermal throttling \(throttled ? "on" : "off", privacy: .public)")
            self.pumpRender()
        }
    }
}

/// One Apple sentence rendered into the graph: converts the synthesizer's buffers (whatever its voice's
/// format) to the graph's 24 kHz mono, and counts what is still queued. `convert` runs on the synthesizer's
/// thread, one buffer at a time; the counters are main-thread only.
private final class AppleRender: @unchecked Sendable {
    let output: AVAudioFormat
    private var converter: AVAudioConverter?
    var pending = 0
    var started = false
    var ended = false
    var gotAudio = false

    init(output: AVAudioFormat) {
        self.output = output
    }

    func convert(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if converter == nil || converter?.inputFormat != input.format {
            converter = AVAudioConverter(from: input.format, to: output)
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
