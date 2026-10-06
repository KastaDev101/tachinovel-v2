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
//            again at a sentence boundary once it is two sentences ahead.
//  Both share the app's audio session (.playback/.spokenAudio), so lock screen, Now Playing, remote
//  commands and interruptions work the same for either voice. Main thread only.
//
//  Output: the real-time audio graph, or (CI / simulator self-test without an audio device) a manual
//  rendering mode in which a timer pulls audio at real-time pace; the Apple voice is then rendered with
//  AVSpeechSynthesizer.write to time its sentences.
//

import AVFoundation
import Foundation
import HDVoiceCore
import HDVoiceKokoro
import os
import UIKit

final class HybridSpeechEngine: NSObject, SpeechEngine, AVSpeechSynthesizerDelegate {
    weak var delegate: SpeechEngineDelegate?

    /// Per chapter (NarrationController sets these before enqueue).
    var kokoroVoice = VoiceCatalog.defaultVoiceId
    /// A system voice the user picked explicitly (Narration.setOptions voiceId), else automatic.
    var explicitAppleVoice: String?

    private(set) var currentSource: VoiceSource?
    private(set) var lastFallback: FallbackReason?

    private var audioEngine = AVAudioEngine()
    private var player = AVAudioPlayerNode()
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
        segments = segs
        paused = false
        loudness = LoudnessMatcher()
        sessionStart = Date()
        firstAudioLogged = false
        currentSource = nil
        lastFallback = nil
        let prefs = VoiceSettings.shared.prefs
        var s = HybridScheduler(count: segs.count, kokoro: kokoroState(), config: HybridScheduler.Config(ahead: prefs.clampedAhead))
        s.throttled = ThermalPolicy.throttled(rawState: ProcessInfo.processInfo.thermalState.rawValue)
        scheduler = s
        if KokoroService.shared.usable { KokoroService.shared.ensureLoaded() }
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
        segments.removeAll()
        paused = false
        stopOutput()
    }

    func pause() {
        guard scheduler != nil, !paused else { return }
        paused = true
        scheduler?.paused = true
        cancelWait()
        if !queued.isEmpty {
            player.pause()
            pauseOutput()
        }
        if appleSegment != nil, synth.isSpeaking { synth.pauseSpeaking(at: .word) }
    }

    func resume() {
        guard scheduler != nil, paused else { return }
        paused = false
        scheduler?.paused = false
        if !queued.isEmpty {
            if startOutput() { player.play() } else { replayFromQueuedWithApple() }
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
        guard !paused, let i = scheduler?.nextRender() else { return }
        let seg = segments[i]
        let g = gen
        let voice = kokoroVoice
        KokoroService.shared.synthesize(text: seg.kokoroText, runs: seg.runs, voice: voice, speed: seg.rate) { [weak self] result in
            self?.rendered(i, gen: g, voice: voice, result: result)
        }
    }

    private func rendered(_ i: Int, gen g: Int, voice: String, result: Result<KokoroAudio, Error>) {
        guard g == gen, scheduler != nil else { return }
        switch result {
        case .success(let audio):
            KokoroService.shared.stats.record(SentenceStat(index: i, characters: segments[i].kokoroText.count, synthMs: audio.synthMs, audioMs: audio.durationMs, voice: voice))
            scheduler?.renderDone(i, ok: true)
            if scheduler?.isReady(i) == true {
                let frames = PCM.prepareSentence(audio.samples, sampleRate: audio.sampleRate, pause: segments[i].pauseAfter, loudness: &loudness)
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
        player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async { self?.kokoroFinished(i, gen: g, epoch: e) }
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
        u.postUtteranceDelay = seg.pauseAfter
        appleSegment = i
        appleUtterance = u
        if queued.isEmpty { pauseOutput() } // no Kokoro audio pending: let the graph sleep
        if manualOutput {
            speakAppleManually(i, utterance: u)
        } else {
            if restart, synth.isSpeaking || synth.isPaused { synth.stopSpeaking(at: .immediate) }
            synth.speak(u)
        }
    }

    private func appleFinished(_ u: AVSpeechUtterance) {
        guard u === appleUtterance, let i = appleSegment else { return }
        appleSegment = nil
        appleUtterance = nil
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
        if Thread.isMainThread { fn() } else { DispatchQueue.main.async(execute: fn) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        onMain {
            guard !self.manualOutput, utterance === self.appleUtterance, let i = self.appleSegment else { return }
            self.began(i, .apple)
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onMain { if !self.manualOutput { self.appleFinished(utterance) } }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        onMain {
            guard utterance === self.appleUtterance, let i = self.appleSegment else { return }
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
        audioEngine.connect(player, to: audioEngine.mainMixerNode, format: format)
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
        synth.write(u) { [weak self] buffer in
            let frames = (buffer as? AVAudioPCMBuffer)?.frameLength ?? 0
            let rate = buffer.format.sampleRate
            DispatchQueue.main.async {
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

    @objc private func kokoroStatusChanged() {
        DispatchQueue.main.async {
            guard self.scheduler != nil else { return }
            self.scheduler?.kokoro = self.kokoroState()
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

/// Accumulates the rendered length of a headless Apple utterance (main thread).
private final class RenderedDuration {
    var seconds: Double = 0
    var done = false
}
