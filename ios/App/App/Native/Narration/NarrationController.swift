//
//  NarrationController.swift — "podcast my novel": native playback queue, lock screen, CarPlay audio.
//
//  - Runs entirely natively (main thread), so it keeps going when the WebView is suspended.
//  - Text comes from the reader DOM (UI-initiated play: exact highlight alignment) or from the core
//    (`narration.chapterText`: lock screen auto-continue, CarPlay "Continue listening").
//  - Position follows narration: progress.save goes to the core every few seconds and at chapter end,
//    so the reader resumes where listening stopped (v1 ChapterPosition.paragraph).
//  - Audio session .playback + .spokenAudio (not mixable → eligible as Now Playing app); interruptions
//    pause/resume; unplugging headphones / leaving the car pauses.
//

import AVFoundation
import Foundation
import MediaPlayer
import os // Logger interpolation (`privacy:`) used through CoreHost.shared.log
import UIKit

final class NarrationController: NSObject, SpeechEngineDelegate {
    static let shared = NarrationController()

    enum Status: String { case idle, loading, playing, paused, ended, error }

    struct Paragraph {
        let index: Int
        let text: String
        let sentences: [String]?
        let scene: Bool
    }

    struct Chapter {
        let pluginId: String
        let novelPath: String
        let chapterPath: String
        var novelName: String
        var chapterName: String
        var coverUrl: String?
        var paragraphs: [Paragraph]
        var nextPath: String?
        var nextName: String?
    }

    private struct Item {
        let paragraph: Int
        let sentence: Int
        let text: String
        let pauseAfter: TimeInterval
    }

    // Options (setOptions)
    var rate: Float = 1
    var pitch: Float = 1
    var voiceIdentifier: String?
    var lexicon: [NarrationText.LexiconEntry] = []
    var paragraphPause: TimeInterval = 0.45
    var scenePause: TimeInterval = 1.6
    var autoContinue = true

    /// Plugin hooks (NarrationPlugin forwards these to the UI).
    var onState: (([String: Any]) -> Void)?
    var onProgress: (([String: Any]) -> Void)?

    private let engine: SpeechEngine = SystemSpeechEngine()
    private(set) var status: Status = .idle
    private var chapter: Chapter?
    private var items: [Item] = []
    private var current = 0
    private var generation = 0
    private var lastSavedAt = Date.distantPast
    private var sleepTimer: DispatchWorkItem?
    private var artwork: MPMediaItemArtwork?
    private var commandsInstalled = false
    private var errorMessage: String?
    /// Interruption bookkeeping (calls, Siri, other audio). See InterruptionPolicy.
    private var interruption = InterruptionPolicy()

    override private init() {
        super.init()
        engine.delegate = self
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        nc.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
    }

    // MARK: - Public API (main thread)

    func play(_ ch: Chapter, startParagraph: Int, startSentence: Int = 0) {
        interruption.userActed()
        generation += 1
        engine.stop()
        chapter = ch
        items = Self.items(for: ch.paragraphs, paragraphPause: paragraphPause, scenePause: scenePause)
        current = items.firstIndex { $0.paragraph >= startParagraph && ($0.paragraph > startParagraph || $0.sentence >= startSentence) } ?? 0
        guard !items.isEmpty else { return finishChapter() }
        activateSession()
        installRemoteCommands()
        loadArtwork(ch.coverUrl)
        enqueueFromCurrent()
        set(.playing)
        if ch.nextPath == nil { lookUpNext(for: ch) }
    }

    /// Play a chapter whose text the core fetches (CarPlay, lock-screen auto-continue).
    func playFromCore(pluginId: String, novelPath: String, chapterPath: String, novelName: String, startParagraph: Int = 0) {
        set(.loading)
        fetchChapter(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath, novelName: novelName) { [weak self] ch in
            guard let self else { return }
            guard let ch else { return self.fail("Couldn't load the chapter") }
            self.play(ch, startParagraph: startParagraph)
        }
    }

    /// User (or sleep timer / remote command) pause: never auto-resumed after an interruption.
    func pause() {
        interruption.userActed()
        pauseInternal()
    }

    func resume() {
        interruption.userActed()
        resumeInternal()
    }

    private func pauseInternal() {
        guard status == .playing else { return }
        engine.pause()
        set(.paused)
        saveProgress(force: true)
    }

    private func resumeInternal() {
        guard status == .paused else { return }
        activateSession()
        if engine.isPaused { engine.resume() } else { enqueueFromCurrent() }
        set(.playing)
    }

    func stop() {
        interruption.userActed()
        generation += 1
        engine.stop()
        saveProgress(force: true)
        set(.idle)
        sleepTimer?.cancel()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func skip(unit: String, count: Int) {
        interruption.userActed()
        guard chapter != nil, !items.isEmpty else { return }
        var target = current
        if unit == "paragraph" {
            let p = (items[safe: current]?.paragraph ?? 0) + count
            target = items.firstIndex { $0.paragraph >= p } ?? (count > 0 ? items.count : 0)
        } else {
            target = current + count
        }
        if target >= items.count { return nextChapter() }
        current = max(0, target)
        restartFromCurrent()
    }

    func nextChapter() {
        guard let ch = chapter, let next = ch.nextPath else { return finishChapter() }
        saveProgress(force: true, finished: true)
        playFromCore(pluginId: ch.pluginId, novelPath: ch.novelPath, chapterPath: next, novelName: ch.novelName)
    }

    func setSleepTimer(minutes: Double) {
        sleepTimer?.cancel()
        guard minutes > 0 else { return }
        let item = DispatchWorkItem { [weak self] in self?.pause() }
        sleepTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + minutes * 60, execute: item)
    }

    func applyRate(_ r: Float) {
        rate = max(0.5, min(2, r))
        if status == .playing { restartFromCurrent() }
        updateNowPlaying()
    }

    func stateDict() -> [String: Any] {
        var d: [String: Any] = ["status": status.rawValue]
        if let ch = chapter {
            d["pluginId"] = ch.pluginId
            d["novelPath"] = ch.novelPath
            d["chapterPath"] = ch.chapterPath
            d["chapterName"] = ch.chapterName
        }
        if let it = items[safe: current] {
            d["paragraph"] = it.paragraph
            d["sentence"] = it.sentence
        }
        if let errorMessage { d["error"] = errorMessage }
        return d
    }

    // MARK: - Queue

    private static func items(for paragraphs: [Paragraph], paragraphPause: TimeInterval, scenePause: TimeInterval) -> [Item] {
        var out: [Item] = []
        for p in paragraphs {
            if p.scene {
                if let last = out.popLast() { out.append(Item(paragraph: last.paragraph, sentence: last.sentence, text: last.text, pauseAfter: scenePause)) }
                continue
            }
            let sentences = p.sentences ?? NarrationText.sentences(p.text)
            for (i, s) in sentences.enumerated() where !s.isEmpty {
                out.append(Item(paragraph: p.index, sentence: i, text: s, pauseAfter: i == sentences.count - 1 ? paragraphPause : 0.05))
            }
        }
        return out
    }

    private func enqueueFromCurrent() {
        let segs = items[current...].enumerated().map { offset, it in
            SpeechSegment(id: generation * 100_000 + current + offset,
                          text: NarrationText.attributed(it.text, lexicon: lexicon),
                          rate: rate, pitch: pitch, voiceIdentifier: voiceIdentifier, pauseAfter: it.pauseAfter)
        }
        engine.enqueue(segs)
    }

    private func restartFromCurrent() {
        generation += 1
        engine.stop()
        activateSession()
        enqueueFromCurrent()
        set(.playing)
    }

    // MARK: - SpeechEngineDelegate

    private func index(of id: Int) -> Int? {
        guard id / 100_000 == generation else { return nil } // stale segment from before a restart
        return id % 100_000
    }

    func speechEngine(didStart id: Int) {
        guard let i = index(of: id), let it = items[safe: i], let ch = chapter else { return }
        current = i
        onProgress?(["chapterPath": ch.chapterPath, "paragraph": it.paragraph, "sentence": it.sentence])
        updateNowPlaying()
        saveProgress(force: false)
        // Look ahead: fetch the next chapter's text early so the transition is gapless and offline-safe.
        if autoContinue, i == max(0, items.count * 4 / 5), ch.nextPath == nil { lookUpNext(for: ch) }
    }

    func speechEngine(didFinish id: Int) {
        guard let i = index(of: id) else { return }
        if i >= items.count - 1 { finishChapter() }
    }

    func speechEngine(willSpeak id: Int, range: NSRange) {
        guard let i = index(of: id), let it = items[safe: i], let ch = chapter else { return }
        onProgress?(["chapterPath": ch.chapterPath, "paragraph": it.paragraph, "sentence": it.sentence,
                     "charStart": range.location, "charEnd": range.location + range.length])
    }

    private func finishChapter() {
        saveProgress(force: true, finished: true)
        if autoContinue, chapter?.nextPath != nil { return nextChapter() }
        set(.ended)
    }

    // MARK: - Core round trips

    private func fetchChapter(pluginId: String, novelPath: String, chapterPath: String, novelName: String, completion: @escaping (Chapter?) -> Void) {
        let args: [String: Any] = ["pluginId": pluginId, "novelPath": novelPath, "chapterPath": chapterPath]
        CoreHost.shared.request("narration.chapterText", args: args) { ok, result in
            DispatchQueue.main.async {
                guard ok, let r = result as? [String: Any] else { return completion(nil) }
                let paragraphs = (r["paragraphs"] as? [[String: Any]] ?? []).map { p in
                    Paragraph(index: p["index"] as? Int ?? 0, text: p["text"] as? String ?? "",
                              sentences: p["sentences"] as? [String], scene: (p["pause"] as? String) == "scene")
                }
                let next = r["next"] as? [String: Any]
                completion(Chapter(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath, novelName: novelName,
                                   chapterName: r["title"] as? String ?? chapterPath, coverUrl: self.chapter?.coverUrl,
                                   paragraphs: paragraphs,
                                   nextPath: (next?["locked"] as? Bool) == true ? nil : next?["path"] as? String,
                                   nextName: next?["name"] as? String))
            }
        }
    }

    /// Learn the next chapter (UI-initiated plays only carry the current chapter's paragraphs).
    private func lookUpNext(for ch: Chapter) {
        fetchChapter(pluginId: ch.pluginId, novelPath: ch.novelPath, chapterPath: ch.chapterPath, novelName: ch.novelName) { [weak self] fetched in
            guard let self, let fetched, self.chapter?.chapterPath == ch.chapterPath else { return }
            self.chapter?.nextPath = fetched.nextPath
            self.chapter?.nextName = fetched.nextName
        }
    }

    private func saveProgress(force: Bool, finished: Bool = false) {
        guard let ch = chapter, let it = items[safe: min(current, max(0, items.count - 1))] else { return }
        guard force || Date().timeIntervalSince(lastSavedAt) > 5 else { return }
        lastSavedAt = Date()
        let percent = finished ? 1 : Double(current) / Double(max(1, items.count))
        var args: [String: Any] = [
            "pluginId": ch.pluginId, "novelPath": ch.novelPath, "chapterPath": ch.chapterPath,
            "position": ["percent": percent, "paragraph": it.paragraph, "offset": 0] as [String: Any],
        ]
        if finished { args["finished"] = true }
        CoreHost.shared.request("progress.save", args: args)
    }

    // MARK: - State, audio session, Now Playing

    private func set(_ s: Status) {
        status = s
        if s != .error { errorMessage = nil }
        onState?(stateDict())
        updateNowPlaying()
    }

    private func fail(_ message: String) {
        errorMessage = message
        status = .error
        onState?(stateDict())
    }

    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
            try session.setActive(true)
        } catch {
            CoreHost.shared.log.error("audio session: \(error.localizedDescription, privacy: .public)")
        }
    }

    @objc private func interrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        let opts = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map { AVAudioSession.InterruptionOptions(rawValue: $0) } ?? []
        DispatchQueue.main.async {
            if type == .began {
                // Remember whether WE were playing; the system has already silenced the audio.
                if self.interruption.began(wasPlaying: self.status == .playing) { self.pauseInternal() }
            } else if self.interruption.ended(shouldResume: opts.contains(.shouldResume)), self.status == .paused {
                self.resumeInternal()
            }
        }
    }

    @objc private func routeChanged(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
        // Headphones unplugged / Bluetooth or CarPlay disconnected: pause, and don't auto-resume later.
        DispatchQueue.main.async {
            self.interruption.userActed()
            self.pauseInternal()
        }
    }

    /// Rough time model so the lock screen shows a progress bar (~15 characters per second at 1×).
    private func updateNowPlaying() {
        guard let ch = chapter, status != .idle else { return }
        let charsPerSecond = 15.0 * Double(rate)
        let total = items.reduce(0) { $0 + $1.text.count }
        let done = items.prefix(current).reduce(0) { $0 + $1.text.count }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: ch.chapterName,
            MPMediaItemPropertyArtist: ch.novelName,
            MPMediaItemPropertyAlbumTitle: "TachiNovel",
            MPMediaItemPropertyPlaybackDuration: Double(total) / charsPerSecond,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(done) / charsPerSecond,
            MPNowPlayingInfoPropertyPlaybackRate: status == .playing ? Double(rate) : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func loadArtwork(_ cover: String?) {
        artwork = nil
        guard let cover else { return }
        let apply: (UIImage) -> Void = { [weak self] image in
            DispatchQueue.main.async {
                self?.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self?.updateNowPlaying()
            }
        }
        if cover.hasPrefix("covers/") || cover.contains("/covers/") && !cover.hasPrefix("http") {
            let name = (cover as NSString).lastPathComponent
            let path = CoreHost.shared.localAppDir.appendingPathComponent("covers").appendingPathComponent(name).path
            if let img = UIImage(contentsOfFile: path) { apply(img) }
        } else if let url = URL(string: cover), url.scheme == "https" {
            URLSession.shared.dataTask(with: url) { data, _, _ in
                if let data, let img = UIImage(data: data) { apply(img) }
            }.resume()
        }
    }

    private func installRemoteCommands() {
        guard !commandsInstalled else { return }
        commandsInstalled = true
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in self?.resume(); return .success }
        c.pauseCommand.addTarget { [weak self] _ in self?.pause(); return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            if self.status == .playing { self.pause() } else { self.resume() }
            return .success
        }
        c.nextTrackCommand.addTarget { [weak self] _ in self?.nextChapter(); return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.interruption.userActed()
            self.current = 0
            self.restartFromCurrent()
            return .success
        }
        // Skip buttons move by paragraph (the lock screen shows them as ±15 s glyphs).
        c.skipForwardCommand.preferredIntervals = [15]
        c.skipForwardCommand.addTarget { [weak self] _ in self?.skip(unit: "paragraph", count: 1); return .success }
        c.skipBackwardCommand.preferredIntervals = [15]
        c.skipBackwardCommand.addTarget { [weak self] _ in self?.skip(unit: "paragraph", count: -1); return .success }
        c.changePlaybackRateCommand.supportedPlaybackRates = [0.75, 1.0, 1.25, 1.5, 2.0]
        c.changePlaybackRateCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackRateCommandEvent else { return .commandFailed }
            self?.applyRate(e.playbackRate)
            return .success
        }
        for cmd in [c.playCommand, c.pauseCommand, c.togglePlayPauseCommand, c.nextTrackCommand, c.previousTrackCommand,
                    c.skipForwardCommand, c.skipBackwardCommand, c.changePlaybackRateCommand] {
            cmd.isEnabled = true
        }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

/// When to resume after an audio interruption (phone call, Siri, another app's audio).
/// Resume only if (1) narration was PLAYING when the interruption began, (2) the system says
/// `.shouldResume` when it ends, and (3) nobody paused/stopped/skipped/played in between (a user action
/// or a route change clears the pending resume). A user pause is therefore never undone by a call.
/// Decision table: docs/tts-v2.md "Interruptions".
struct InterruptionPolicy {
    private(set) var resumePending = false

    /// Interruption began. Returns true when narration must be paused now (it was playing).
    mutating func began(wasPlaying: Bool) -> Bool {
        resumePending = wasPlaying
        return wasPlaying
    }

    /// Interruption ended. Returns true when narration should resume.
    mutating func ended(shouldResume: Bool) -> Bool {
        defer { resumePending = false }
        return resumePending && shouldResume
    }

    /// Any explicit control (pause, resume, stop, skip, play) or a route change.
    mutating func userActed() {
        resumePending = false
    }
}
