//
//  ExpressiveSpeechEngine.swift — an EXPERIMENTAL expressive engine behind the narration engine protocol
//  (SpeechEngine), with Kokoro as the per-sentence safety net. Used only by the Voice Lab for now
//  (ExpressiveLabPlayer below); NarrationController still uses HybridSpeechEngine.
//
//  The same render-ahead state machine as the main engine (HDVoiceCore.HybridScheduler), with the roles
//  shifted: the scheduler's primary voice is the expressive engine (or Kokoro itself, for the "as today"
//  side of an A/B), and its fallback is Kokoro instead of the Apple voice:
//    - the expressive model is still loading (first load compiles it), failed, or was released,
//    - the next sentence isn't rendered when the current one ends (the device can't keep up),
//    - the app left the foreground (Chatterbox Nano and NeuTTS-2E run on the GPU, which iOS forbids in the
//      background) or the phone is thermally throttled,
//    - one sentence failed to synthesize.
//  Switches happen only at sentence boundaries; the expressive engine takes over again once it is two
//  sentences ahead. A crash inside an experimental engine is contained by ExpressiveService's own sentinel.
//  Main thread only.
//

import AVFoundation
import ExpressiveCore
import ExpressiveEngines
import Foundation
import HDVoiceCore
import HDVoiceKokoro
import os
import UIKit

final class ExpressiveSpeechEngine: NSObject, SpeechEngine {
    weak var delegate: SpeechEngineDelegate?

    /// The expressive engine; nil = Kokoro renders every sentence (the "Kokoro as today" side of an A/B).
    var primary: ExpressiveEngineID?
    /// Kokoro voice for the fallback (and for the Kokoro-only side).
    var kokoroVoice = VoiceCatalog.defaultVoiceId
    /// The acting for each segment (by SpeechSegment.id): text with inline tags, emotion, style, role.
    var lines: [Int: ExpressiveLine] = [:]

    struct LineRecord {
        var source: String
        var synthMs: Double?
        var audioMs: Double?
        var fallback: String?
        var error: String?
    }

    private(set) var records: [Int: LineRecord] = [:]
    private(set) var firstAudio: (ms: Double, source: String, includedLoad: Bool)?
    private(set) var playingIndex: Int?
    private(set) var throttle: String?

    private var audioEngine = AVAudioEngine()
    private var player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
    private var graphReady = false

    private var segments: [SpeechSegment] = []
    private var scheduler: HybridScheduler?
    private(set) var lastScheduler: HybridScheduler?
    private var gen = 0
    private var epoch = 0
    private var buffers: [Int: AVAudioPCMBuffer] = [:]
    /// Scheduled on the player node, in play order (first = audible).
    private var queued: [Int] = []
    /// A sentence Kokoro is rendering because the expressive engine couldn't deliver it.
    private var fallbackSegment: Int?
    private var waitItem: DispatchWorkItem?
    private var waiting = false
    private var paused = false
    private var loudness = LoudnessMatcher()
    private var sessionStart = Date()
    private var primaryWasLoaded = false
    private let log = Logger(subsystem: "app.tachinovel", category: "voice-expressive")

    override init() {
        super.init()
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(environmentChanged), name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(environmentChanged), name: UIApplication.willResignActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(environmentChanged), name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(primaryStatusChanged), name: KokoroService.statusChanged, object: nil)
    }

    var isSpeaking: Bool { scheduler != nil && (!queued.isEmpty || fallbackSegment != nil || waiting) }
    var isPaused: Bool { paused }
    var isFinished: Bool { scheduler == nil && lastScheduler != nil }
    var snapshot: HybridScheduler? { scheduler ?? lastScheduler }
    var segmentCount: Int { segments.count }

    // MARK: - SpeechEngine

    func enqueue(_ segs: [SpeechSegment]) {
        stop()
        gen += 1
        segments = segs
        paused = false
        loudness = LoudnessMatcher()
        sessionStart = Date()
        firstAudio = nil
        records = [:]
        playingIndex = nil
        lastScheduler = nil
        if let id = primary { primaryWasLoaded = ExpressiveService.shared.loadState(id) == .ready } else { primaryWasLoaded = KokoroService.shared.status == .ready }
        // A generous start grace: the lab wants to hear the expressive engine, and reports how long it took.
        var s = HybridScheduler(count: segs.count, kokoro: primaryState(),
                                config: HybridScheduler.Config(ahead: 3, returnAhead: 2, startGrace: 10, dryGrace: 0.3, maxConsecutiveFailures: 3))
        throttle = throttleReason()
        s.throttled = throttle != nil
        scheduler = s
        if KokoroService.shared.usable { KokoroService.shared.ensureLoaded() }
        if let id = primary {
            ExpressiveService.shared.ensureLoaded(id) { [weak self] _ in self?.primaryStatusChanged() }
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
        queued.removeAll()
        buffers.removeAll()
        fallbackSegment = nil
        playingIndex = nil
        paused = false
        if graphReady, audioEngine.isRunning { audioEngine.pause() }
    }

    func pause() {
        guard scheduler != nil, !paused else { return }
        paused = true
        scheduler?.paused = true
        cancelWait()
        if graphReady { player.pause() }
    }

    func resume() {
        guard scheduler != nil, paused else { return }
        paused = false
        scheduler?.paused = false
        if !queued.isEmpty {
            if startOutput() { player.play() }
        } else if fallbackSegment == nil {
            advance()
        }
        pumpRender()
    }

    // MARK: - State

    private func primaryState() -> HybridScheduler.KokoroState {
        guard let id = primary else {
            let k = KokoroService.shared
            guard k.isBundled, !k.crashDisabled else { return .unavailable }
            switch k.status {
            case .ready: return .ready
            case .loading, .unloaded: return .loading
            case .unavailable: return .unavailable
            }
        }
        let svc = ExpressiveService.shared
        if svc.crashDisabled || !ExpressiveService.supported(id) || !svc.isInstalled(id) { return .unavailable }
        switch svc.loadState(id) {
        case .ready: return svc.loadedID == id ? .ready : .loading
        case .loading, .unloaded: return .loading
        case .failed: return .unavailable
        }
    }

    private func throttleReason() -> String? {
        if primary?.usesGPU == true, UIApplication.shared.applicationState != .active { return "background (GPU not allowed)" }
        if ThermalPolicy.throttled(rawState: ProcessInfo.processInfo.thermalState.rawValue) { return "thermal" }
        return nil
    }

    @objc private func primaryStatusChanged() {
        DispatchQueue.main.async {
            guard self.scheduler != nil else { return }
            self.scheduler?.kokoro = self.primaryState()
            self.pumpRender()
            if self.waiting { self.advance() }
        }
    }

    @objc private func environmentChanged() {
        DispatchQueue.main.async {
            guard self.scheduler != nil else { return }
            let reason = self.throttleReason()
            guard reason != self.throttle else { return }
            self.throttle = reason
            self.scheduler?.throttled = reason != nil
            self.log.info("expressive: throttle \(reason ?? "off", privacy: .public)")
            self.pumpRender()
            if self.waiting { self.advance() }
        }
    }

    // MARK: - Decisions

    private func advance() {
        guard scheduler != nil, !paused, queued.isEmpty, fallbackSegment == nil else { return }
        cancelWait()
        guard let d = scheduler?.decide(now: Date().timeIntervalSince1970) else { return }
        switch d {
        case .kokoro(let i):
            waiting = false
            playRendered(i)
        case .apple(let i, let reason):
            waiting = false
            playFallback(i, reason: reason)
        case .wait(let t):
            waiting = true
            let item = DispatchWorkItem { [weak self] in self?.advance() }
            waitItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + t, execute: item)
        case .finished:
            waiting = false
            if let s = scheduler { lastScheduler = s }
            scheduler = nil
            if primary != nil { ExpressiveService.shared.scheduleIdleRelease() }
        }
        pumpRender()
    }

    private func cancelWait() {
        waitItem?.cancel()
        waitItem = nil
    }

    // MARK: - Primary renders (expressive engine, or Kokoro on the Kokoro-only side)

    private struct Rendered {
        let samples: [Float]
        let sampleRate: Int
        let synthMs: Double
    }

    private func line(_ i: Int) -> ExpressiveLine {
        let seg = segments[i]
        return lines[seg.id] ?? ExpressiveLine(text: seg.kokoroText)
    }

    private func pumpRender() {
        // While the engine is still loading, a call would fail at once ("The model isn't loaded") and the first line
        // would go to Kokoro (Kasta's report, 2026-10-08): wait, primaryStatusChanged pumps again when it is ready.
        if let id = primary, ExpressiveService.shared.loadState(id) == .loading { return }
        guard !paused, let i = scheduler?.nextRender() else { return }
        let g = gen
        let done: (Result<Rendered, Error>) -> Void = { [weak self] result in self?.rendered(i, gen: g, result: result) }
        if let id = primary {
            ExpressiveService.shared.synthesize(line(i), engine: id) { result in
                done(result.map { Rendered(samples: $0.samples, sampleRate: $0.sampleRate, synthMs: $0.synthMs) })
            }
        } else {
            renderKokoro(i) { done($0) }
        }
    }

    private func renderKokoro(_ i: Int, completion: @escaping (Result<Rendered, Error>) -> Void) {
        let seg = segments[i]
        KokoroService.shared.synthesize(text: StyleMapper.plainText(seg.kokoroText), runs: nil, voice: kokoroVoice, speed: seg.rate) { result in
            completion(result.map { Rendered(samples: $0.samples, sampleRate: $0.sampleRate, synthMs: $0.synthMs) })
        }
    }

    private func rendered(_ i: Int, gen g: Int, result: Result<Rendered, Error>) {
        guard g == gen, scheduler != nil else { return }
        switch result {
        case .success(let audio) where audio.sampleRate == 24_000 && !audio.samples.isEmpty:
            scheduler?.renderDone(i, ok: true)
            if scheduler?.isReady(i) == true {
                let frames = PCM.prepareSentence(audio.samples, sampleRate: audio.sampleRate, pause: segments[i].pauseAfter, loudness: &loudness)
                if let buf = makeBuffer(frames) {
                    buffers[i] = buf
                    records[i] = LineRecord(source: primary?.rawValue ?? "kokoro", synthMs: audio.synthMs,
                                            audioMs: Double(audio.samples.count) * 1000 / Double(audio.sampleRate))
                } else {
                    scheduler?.renderDone(i, ok: false)
                }
            }
        case .success(let audio):
            log.error("expressive: unusable audio for sentence \(i) (\(audio.sampleRate) Hz, \(audio.samples.count) samples)")
            scheduler?.renderDone(i, ok: false)
        case .failure(let error):
            log.error("expressive: sentence \(i) failed: \(error.localizedDescription, privacy: .public)")
            records[i] = LineRecord(source: primary?.rawValue ?? "kokoro", error: error.localizedDescription)
            scheduler?.renderDone(i, ok: false)
            // The model went away (memory warning, crash protection): let the scheduler know right away.
            scheduler?.kokoro = primaryState()
        }
        pumpRender()
        if waiting { advance() } else { prefetch() }
    }

    private func playRendered(_ i: Int) {
        guard buffers[i] != nil else { return playFallback(i, reason: .segmentFailed) }
        guard startOutput() else { return playFallback(i, reason: .segmentFailed) }
        schedule(i)
        if !player.isPlaying { player.play() }
        began(i, source: primary?.rawValue ?? "kokoro")
        prefetch()
    }

    private func prefetch() {
        guard !queued.isEmpty, queued.count < 2, !paused, let j = scheduler?.prefetchNext(), buffers[j] != nil else { return }
        schedule(j)
    }

    // MARK: - Kokoro fallback

    private func playFallback(_ i: Int, reason: FallbackReason) {
        let g = gen
        fallbackSegment = i
        var rec = records[i] ?? LineRecord(source: "kokoro")
        rec.source = "kokoro"
        rec.fallback = reason.rawValue
        records[i] = rec
        let start = Date()
        KokoroService.shared.ensureLoaded { [weak self] status in
            guard let self, g == self.gen, self.fallbackSegment == i else { return }
            guard status == .ready else { return self.skipFallback(i, why: "Kokoro unavailable: \(KokoroService.shared.statusText)") }
            self.renderKokoro(i) { result in
                guard g == self.gen, self.fallbackSegment == i else { return }
                switch result {
                case .success(let audio):
                    let frames = PCM.prepareSentence(audio.samples, sampleRate: audio.sampleRate, pause: self.segments[i].pauseAfter, loudness: &self.loudness)
                    guard audio.sampleRate == 24_000, let buf = self.makeBuffer(frames), self.startOutput() else {
                        return self.skipFallback(i, why: "Kokoro audio unusable")
                    }
                    self.records[i]?.synthMs = Date().timeIntervalSince(start) * 1000
                    self.records[i]?.audioMs = Double(audio.samples.count) * 1000 / Double(audio.sampleRate)
                    self.fallbackSegment = nil
                    self.buffers[i] = buf
                    self.schedule(i)
                    if !self.paused, !self.player.isPlaying { self.player.play() }
                    self.began(i, source: "kokoro")
                case .failure(let error):
                    self.skipFallback(i, why: error.localizedDescription)
                }
            }
        }
    }

    /// Neither voice could render sentence i: skip it (logged in the lab), never stall or crash.
    private func skipFallback(_ i: Int, why: String) {
        log.error("expressive: skipped sentence \(i): \(why, privacy: .public)")
        records[i]?.error = why
        fallbackSegment = nil
        scheduler?.finished(i)
        delegate?.speechEngine(didFinish: segments[i].id)
        advance()
    }

    // MARK: - Playback

    private func makeBuffer(_ frames: [Float]) -> AVAudioPCMBuffer? {
        guard !frames.isEmpty, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames.count)),
              let ch = buf.floatChannelData?[0] else { return nil }
        frames.withUnsafeBufferPointer { src in
            if let base = src.baseAddress { ch.update(from: base, count: frames.count) }
        }
        buf.frameLength = AVAudioFrameCount(frames.count)
        return buf
    }

    private func schedule(_ i: Int) {
        guard let buf = buffers[i] else { return }
        let g = gen
        let e = epoch
        queued.append(i)
        player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async { self?.finishedPlaying(i, gen: g, epoch: e) }
        }
    }

    private func finishedPlaying(_ i: Int, gen g: Int, epoch e: Int) {
        guard g == gen, e == epoch, queued.first == i else { return }
        queued.removeFirst()
        buffers[i] = nil
        scheduler?.finished(i)
        delegate?.speechEngine(didFinish: segments[i].id)
        guard g == gen else { return }
        if let next = queued.first {
            began(next, source: records[next]?.source ?? "?")
            prefetch()
        } else {
            advance()
        }
        pumpRender()
    }

    private func began(_ i: Int, source: String) {
        scheduler?.started(i)
        playingIndex = i
        if firstAudio == nil {
            firstAudio = (ms: Date().timeIntervalSince(sessionStart) * 1000, source: source, includedLoad: !primaryWasLoaded)
        }
        delegate?.speechEngine(didStart: segments[i].id, source: .kokoro)
    }

    private func buildGraph() {
        guard !graphReady else { return }
        audioEngine.attach(player)
        audioEngine.connect(player, to: audioEngine.mainMixerNode, format: format)
        NotificationCenter.default.addObserver(self, selector: #selector(configurationChanged(_:)), name: .AVAudioEngineConfigurationChange, object: audioEngine)
        graphReady = true
    }

    @discardableResult
    private func startOutput() -> Bool {
        buildGraph()
        guard !audioEngine.isRunning else { return true }
        do {
            audioEngine.prepare()
            try audioEngine.start()
            return true
        } catch {
            log.error("expressive: audio engine failed to start: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    @objc private func configurationChanged(_ note: Notification) {
        DispatchQueue.main.async {
            // The engine stopped itself (route change): restart and replay what was queued.
            guard self.scheduler != nil, !self.queued.isEmpty else { return }
            let replay = self.queued
            self.queued.removeAll()
            self.epoch += 1
            self.player.stop()
            guard self.startOutput() else { return }
            for i in replay where self.buffers[i] != nil { self.schedule(i) }
            if !self.paused { self.player.play() }
        }
    }
}

/// The Voice Lab's player: one ExpressiveSpeechEngine, the sample being played, and what happened.
final class ExpressiveLabPlayer: SpeechEngineDelegate {
    static let shared = ExpressiveLabPlayer()

    let engine = ExpressiveSpeechEngine()
    private(set) var sample = ""
    private(set) var texts: [String] = []
    private(set) var finished = 0

    private init() {
        engine.delegate = self
    }

    func play(primary: ExpressiveEngineID?, sample: String, lines: [ExpressiveLine]) {
        NarrationController.shared.activateForSample() // pauses narration, activates the audio session
        self.sample = sample
        texts = lines.map(\.text)
        finished = 0
        engine.primary = primary
        engine.kokoroVoice = VoiceSettings.shared.prefs.voice(forNovel: nil)
        var map: [Int: ExpressiveLine] = [:]
        let segments: [SpeechSegment] = lines.enumerated().map { i, line in
            map[i] = line
            let plain = StyleMapper.plainText(line.text)
            return SpeechSegment(id: i, text: NSAttributedString(string: plain), kokoroText: plain, runs: nil, rate: 1, pitch: 1, pauseAfter: 0.35)
        }
        engine.lines = map
        engine.enqueue(segments)
    }

    func stop() {
        engine.stop()
    }

    func speechEngine(didStart id: Int, source: VoiceSource) {}

    func speechEngine(didFinish id: Int) {
        finished = max(finished, id + 1)
    }

    func speechEngine(willSpeak id: Int, range: NSRange) {}

    func snapshot() -> [String: Any] {
        guard let s = engine.snapshot else { return ["state": "idle"] }
        let state = engine.isPaused ? "paused" : engine.isFinished ? "finished" : "playing"
        let rows: [[String: Any]] = (0..<texts.count).map { i in
            let r = engine.records[i]
            var d: [String: Any] = ["i": i, "text": texts[i]]
            if let r {
                d["source"] = r.source
                if let v = r.synthMs { d["synthMs"] = ExpressiveService.r1(v) }
                if let v = r.audioMs { d["audioMs"] = ExpressiveService.r1(v) }
                if let a = r.audioMs, let b = r.synthMs, b > 0 { d["x"] = ExpressiveService.r2(a / b) }
                if let f = r.fallback { d["fallback"] = f }
                if let e = r.error { d["error"] = e }
            }
            return d
        }
        var out: [String: Any] = [
            "state": state,
            "engine": engine.primary?.rawValue ?? "kokoro",
            "title": engine.primary?.title ?? "Kokoro",
            "sample": sample,
            "current": engine.playingIndex ?? NSNull(),
            "total": texts.count,
            "expressiveLines": s.kokoroSentences,
            "kokoroFallbackLines": s.appleSentences,
            "underruns": s.underruns,
            "returns": s.returnsToKokoro,
            "fallbacks": Dictionary(uniqueKeysWithValues: s.fallbacks.map { ($0.key.rawValue, $0.value) }),
            "throttle": engine.throttle ?? NSNull(),
            "rows": rows,
        ]
        if let f = engine.firstAudio {
            out["firstAudio"] = ["ms": ExpressiveService.r1(f.ms), "source": f.source, "includedLoad": f.includedLoad] as [String: Any]
        }
        if engine.primary == .chatterboxNano {
            // Which voice Chatterbox Nano speaks with (imported or built-in), and why not the chosen one if it fell back.
            let svc = ExpressiveService.shared
            let loaded = svc.loadedID == .chatterboxNano && svc.loadState(.chatterboxNano) == .ready
            let using = loaded ? (svc.loadedVoiceUsed ?? ExpressiveService.builtInVoice) : (svc.sampleVoice ?? svc.selectedVoice ?? svc.defaultVoice)
            out["voice"] = ["id": using, "name": svc.voiceName(using), "loaded": loaded, "note": svc.voiceNote ?? NSNull()] as [String: Any]
        }
        return out
    }
}
