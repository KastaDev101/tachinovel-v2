//
//  AudioChapterPlayer.swift — plays one chapter audio file (AAC .m4a, or a chapter inside an .m4b bundle):
//  PC-narrated chapters (and, with the car-audio work, chapters prepared on the iPhone).
//
//  Played through the app's own audio graph, like Kokoro and the Apple voice (HybridSpeechEngine), so the
//  Listen player's speed and "Voice volume" apply the same way to every voice:
//
//      AVAudioPlayerNode (file) → AVAudioUnitTimePitch (speed, 0.5–2.5×) → gain stage → peak limiter → out
//
//  In the simulator self-test (no audio device) the graph renders offline at real-time pace. Main thread
//  only. NarrationController owns it and handles the session, Now Playing, remote commands and chapter flow.
//

import AVFoundation
import Foundation
import HDVoiceCore

final class AudioChapterPlayer {
    private var engine = AVAudioEngine()
    private var node = AVAudioPlayerNode()
    private var pitch = AVAudioUnitTimePitch()
    private var gain = AudioGraphParts.gainStage()
    private var limiter = AudioGraphParts.limiter()
    private var file: AVAudioFile?
    private var connected: AVAudioFormat?
    /// File frame where the scheduled segment starts (the node's sample time counts from there).
    private var startFrame: AVAudioFramePosition = 0
    /// File time while paused or stopped (the node has no render time then).
    private var heldTime: Double = 0
    private var playing = false
    private var rate: Float = 1
    /// Bumped on every schedule/stop: completions of older segments are ignored.
    private var token = 0
    private var timer: DispatchSourceTimer?
    private var manualTimer: DispatchSourceTimer?
    private let manual = NarrationSelfTest.isActive

    /// File time (seconds), ~4×/s while playing.
    var onTime: ((Double) -> Void)?
    var onEnd: (() -> Void)?
    var onFail: ((String) -> Void)?

    /// "Voice volume" 0–1.5 (VoiceVolume): applied live.
    var volume: Double = 1 {
        didSet { AudioGraphParts.apply(volume: volume, gain: gain, limiter: limiter) }
    }

    private var configObserver: NSObjectProtocol?

    init() {
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] note in
            self?.configurationChanged(note)
        }
    }

    var isLoaded: Bool { file != nil }
    var isPlaying: Bool { playing }

    private var sampleRate: Double { file?.processingFormat.sampleRate ?? 44_100 }

    var currentTime: Double {
        // Right after the engine starts, lastRenderTime can exist without a valid sample or host time, and
        // playerTime(forNodeTime:) then raises an exception that terminates the app (voice-simulator, #41).
        guard playing, engine.isRunning, let t = node.lastRenderTime, t.isSampleTimeValid || t.isHostTimeValid,
              let pt = node.playerTime(forNodeTime: t), pt.isSampleTimeValid else { return heldTime }
        let s = Double(startFrame + pt.sampleTime) / sampleRate
        return s.isFinite ? max(0, s) : heldTime
    }

    /// File duration in seconds (0 until loaded).
    var fileDuration: Double {
        guard let file else { return 0 }
        return Double(file.length) / file.processingFormat.sampleRate
    }

    func load(url: URL, at seconds: Double, rate: Float) {
        stop()
        do {
            let f = try AVAudioFile(forReading: url)
            file = f
            try buildGraph(for: f.processingFormat)
        } catch {
            let message = error.localizedDescription
            file = nil
            DispatchQueue.main.async { self.onFail?(message.isEmpty ? "The audio file can't be played" : message) }
            return
        }
        setRate(rate)
        schedule(from: seconds)
        start()
    }

    func pause() {
        guard playing else { return }
        heldTime = currentTime
        playing = false
        node.pause()
        engine.pause()
        stopTimers()
    }

    func resume(rate: Float) {
        guard file != nil, !playing else { return }
        setRate(rate)
        // Re-anchor at the held position (the node's clock restarts after the engine paused).
        schedule(from: heldTime)
        start()
    }

    func setRate(_ rate: Float) {
        self.rate = max(0.5, min(2.5, rate))
        pitch.rate = self.rate
    }

    func seek(to seconds: Double, completion: (() -> Void)? = nil) {
        guard file != nil else { return }
        let wasPlaying = playing
        if playing {
            playing = false
            stopTimers()
        }
        schedule(from: seconds)
        if wasPlaying { start() }
        DispatchQueue.main.async { completion?() }
    }

    func stop() {
        token += 1
        playing = false
        stopTimers()
        node.stop()
        engine.stop()
        file = nil
        heldTime = 0
        startFrame = 0
    }

    // MARK: - Graph

    private func buildGraph(for format: AVAudioFormat) throws {
        guard connected != format else { return }
        engine.stop()
        engine = AVAudioEngine()
        node = AVAudioPlayerNode()
        pitch = AVAudioUnitTimePitch()
        gain = AudioGraphParts.gainStage()
        limiter = AudioGraphParts.limiter()
        for n in [node, pitch, gain, limiter] as [AVAudioNode] { engine.attach(n) }
        engine.connect(node, to: pitch, format: format)
        engine.connect(pitch, to: gain, format: format)
        engine.connect(gain, to: limiter, format: format)
        engine.connect(limiter, to: engine.mainMixerNode, format: format)
        if manual {
            let out = AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: format.channelCount) ?? format
            try engine.enableManualRenderingMode(.offline, format: out, maximumFrameCount: 4096)
        }
        connected = format
        AudioGraphParts.apply(volume: volume, gain: gain, limiter: limiter)
        pitch.rate = rate
    }

    /// Schedule the file from file time `seconds` to its end.
    private func schedule(from seconds: Double) {
        guard let file else { return }
        token += 1
        let t = token
        node.stop()
        let frame = min(max(0, AVAudioFramePosition(seconds * sampleRate)), max(0, file.length - 1))
        startFrame = frame
        heldTime = Double(frame) / sampleRate
        let count = AVAudioFrameCount(max(0, file.length - frame))
        guard count > 0 else { return }
        node.scheduleSegment(file, startingFrame: frame, frameCount: count, at: nil,
                             completionCallbackType: manual ? .dataRendered : .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, t == self.token, self.playing else { return }
                self.heldTime = self.fileDuration
                self.playing = false
                self.stopTimers()
                self.onEnd?()
            }
        }
    }

    private func start() {
        do {
            if !engine.isRunning {
                engine.prepare()
                try engine.start()
            }
        } catch {
            let message = error.localizedDescription
            DispatchQueue.main.async { self.onFail?(message) }
            return
        }
        node.play()
        playing = true
        startTimers()
    }

    private func startTimers() {
        stopTimers()
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 0.25, repeating: 0.25)
        t.setEventHandler { [weak self] in
            guard let self, self.playing else { return }
            self.onTime?(self.currentTime)
        }
        timer = t
        t.resume()
        guard manual else { return }
        // Headless (simulator self-test): pull the graph at real-time pace.
        let m = DispatchSource.makeTimerSource(queue: .main)
        let period = 0.02
        m.schedule(deadline: .now(), repeating: period)
        m.setEventHandler { [weak self] in
            guard let self, self.engine.isInManualRenderingMode, self.engine.isRunning,
                  let out = AVAudioPCMBuffer(pcmFormat: self.engine.manualRenderingFormat, frameCapacity: 4096) else { return }
            let frames = AVAudioFrameCount(self.engine.manualRenderingFormat.sampleRate * period)
            _ = try? self.engine.renderOffline(min(frames, out.frameCapacity), to: out)
            NarrationSelfTest.shared.observeOutput(out)
        }
        manualTimer = m
        m.resume()
    }

    private func stopTimers() {
        timer?.cancel()
        timer = nil
        manualTimer?.cancel()
        manualTimer = nil
    }

    /// The engine stopped itself (route or format change, e.g. Bluetooth): continue where it was.
    private func configurationChanged(_ note: Notification) {
        guard (note.object as? AVAudioEngine) === engine, file != nil, playing else { return }
        let t = currentTime
        playing = false
        schedule(from: t)
        start()
    }
}

/// The voice graph's shared parts: a gain stage ("Voice volume") and a peak limiter (only above 100 %).
enum AudioGraphParts {
    static func gainStage() -> AVAudioUnitEQ {
        let eq = AVAudioUnitEQ(numberOfBands: 1)
        eq.bands.first?.bypass = true
        eq.globalGain = 0
        return eq
    }

    static func limiter() -> AVAudioUnitEffect {
        let desc = AudioComponentDescription(componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_PeakLimiter,
                                             componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
        let unit = AVAudioUnitEffect(audioComponentDescription: desc)
        unit.bypass = true
        return unit
    }

    static func apply(volume: Double, gain: AVAudioUnitEQ, limiter: AVAudioUnitEffect) {
        gain.globalGain = VoiceVolume.gainDB(volume)
        limiter.bypass = !VoiceVolume.limiterActive(volume)
    }
}
