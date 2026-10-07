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
//  - Speech: Kokoro on device (HybridSpeechEngine, the bundled model) with the Apple voice taking over
//    sentence by sentence whenever Kokoro can't deliver. Sentences come from the narration front-end
//    (v1 frontend.ts via src/core/narration/speech-script.ts: normalization, pronunciation lexicon,
//    pauses), so the reader can highlight the spoken sentence whichever voice speaks it.
//  - PC-narrated chapter AUDIO (AudioLibrary + AudioChapterPlayer) only with Settings › Voices › Advanced
//    › "Use PC audio when available" (off by default); a chapter without a file uses speech.
//  - Chapters PREPARED on this iPhone ("Prepare for the drive", DrivePrep.swift) play from their files
//    through the same audio path, before anything else, and are deleted once listened to the end.
//  - In the car (CarAudio.swift): Now Playing for every source (chapter, novel, "TachiNovel", cover,
//    elapsed time and length; for speech the length is estimated from the text and refined as sentences
//    are spoken, ChapterTimeline), remote commands (play/pause, chapters or ±15 s per Settings, scrubbing,
//    speed), and "Hey Siri, resume" with nothing loaded (the novel listened to last).
//  - Chapter changes: the next chapter's text is fetched ahead and Kokoro renders its first sentences
//    while this chapter ends, so there is no silence between chapters (a background-time assertion covers
//    the change while the phone is locked).
//  - Speed (0.5–2.5×) and "Voice volume" (0–150 %) from the Listen player are persisted (VoiceSettings)
//    and apply to every voice: all of them play through the app's own audio graph.
//

import AVFoundation
import Foundation
import HDVoiceCore
import MediaPlayer
import os // Logger interpolation (`privacy:`) used through CoreHost.shared.log
import UIKit

/// Main-thread confined: the plugin and the remote-command hub call it on main, and the engines, the core
/// and background work hop back to main before calling it.
final class NarrationController: NSObject, SpeechEngineDelegate, @unchecked Sendable {
    static let shared = NarrationController()

    enum Status: String { case idle, loading, playing, paused, ended, error }
    enum Mode: String { case speech, audio }

    struct Paragraph {
        let index: Int
        let text: String
        let sentences: [String]?
        let scene: Bool
    }

    /// One sentence of the narration script (src/core/narration/speech-script.ts SpeechItem).
    struct ScriptItem {
        let id: Int
        let block: Int
        let paragraph: Int
        let start: Int
        let end: Int
        let hash: Int
        let text: String
        let runs: [SpeechRun]?
        let pauseMs: Double
        /// Narrator mode (src/core/narration/narrator.ts): all dialogue, or its parts by role; the speaker of an
        /// exchange; the smarter pause; the jitter factor.
        var quoted = false
        var parts: [NarratorSentence.Part]? = nil
        var speaker = 0
        var pacedMs: Double? = nil
        var rateJitter: Double? = nil

        var narrator: NarratorSentence {
            NarratorSentence(text: text, runs: runs, quoted: quoted, parts: parts, speaker: speaker, pauseMs: pauseMs, pacedMs: pacedMs, rate: rateJitter)
        }

        static func parseRuns(_ raw: Any?) -> [SpeechRun]? {
            let runs: [SpeechRun]? = (raw as? [Any])?.compactMap { r in
                guard let ro = r as? [String: Any] else { return nil }
                if let p = ro["p"] as? String { return SpeechRun.phonemes(p) }
                if let t = ro["t"] as? String { return SpeechRun.text(t) }
                return nil
            }
            return runs?.isEmpty == false ? runs : nil
        }

        /// Parse the `script` object sent by the UI (Narration.play) or the core (narration.chapterText).
        static func parse(_ script: Any?) -> [ScriptItem]? {
            guard let obj = script as? [String: Any], let raw = obj["items"] as? [Any] else { return nil }
            let items: [ScriptItem] = raw.compactMap { v in
                guard let o = v as? [String: Any], let text = o["text"] as? String else { return nil }
                func int(_ k: String) -> Int { (o[k] as? NSNumber)?.intValue ?? 0 }
                var item = ScriptItem(id: int("id"), block: int("block"), paragraph: int("paragraph"), start: int("start"), end: int("end"),
                                      hash: int("hash"), text: text, runs: parseRuns(o["runs"]),
                                      pauseMs: (o["pauseMs"] as? NSNumber)?.doubleValue ?? 320)
                item.quoted = (o["role"] as? String) == "dialogue"
                let parts: [NarratorSentence.Part] = (o["parts"] as? [Any] ?? []).compactMap { p in
                    guard let po = p as? [String: Any], let t = po["text"] as? String else { return nil }
                    return NarratorSentence.Part(dialogue: (po["role"] as? String) == "dialogue", text: t, runs: parseRuns(po["runs"]))
                }
                item.parts = parts.count > 1 ? parts : nil
                item.speaker = (o["speaker"] as? NSNumber)?.intValue == 1 ? 1 : 0
                item.pacedMs = (o["pacedMs"] as? NSNumber)?.doubleValue
                item.rateJitter = (o["rate"] as? NSNumber)?.doubleValue
                return item
            }
            return items.isEmpty ? nil : items
        }
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
        /// Sentence script from the narration front-end; preferred over `paragraphs` when present.
        var script: [ScriptItem]? = nil
        var prevPath: String? = nil
        var prevName: String? = nil
    }

    private struct Item {
        let paragraph: Int
        let sentence: Int
        let text: String
        let pauseAfter: TimeInterval
        var runs: [SpeechRun]? = nil
        /// Script segment (front-end id, block, canonical range, hash) for sentence highlighting.
        var segment: ScriptItem? = nil
        /// Narrator mode's smarter pause (used when its Pacing switch is on).
        var pacedAfter: TimeInterval? = nil
    }

    /// Narrator mode for this session: the saved settings, or the Voice Lab's A/B override.
    private var narrator = NarratorSettings()
    /// Voice Lab A/B ("off" / "on" with the saved pieces); nil = the saved settings. Set by Narration.play.
    var narratorOverride: Bool?

    private func refreshNarrator() {
        var n = VoiceSettings.shared.prefs.narrator
        if let on = narratorOverride { n.enabled = on }
        narrator = n
    }

    /// The pause after an item: narrator mode's smarter pause when Pacing is on.
    private func pause(of it: Item) -> TimeInterval {
        narrator.usesPacing ? (it.pacedAfter ?? it.pauseAfter) : it.pauseAfter
    }

    /// One engine segment: narrator mode decides the voices of its parts and its speed.
    private func speechSegment(_ it: Item, id: Int, speed: Double) -> SpeechSegment {
        let s = it.segment?.narrator
        var seg = SpeechSegment(id: id, text: NarrationText.attributed(it.text, lexicon: lexicon), kokoroText: it.text, runs: it.runs,
                                rate: s.map { NarratorPlan.rate(rate, for: $0, settings: narrator) } ?? rate,
                                pitch: pitch, pauseAfter: pause(of: it) / speed)
        if let s {
            let prefs = VoiceSettings.shared.prefs
            seg.parts = NarratorPlan.parts(for: s, settings: narrator) { prefs.engineVoice($0) }
        }
        return seg
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

    private let engine = HybridSpeechEngine()
    /// Voice of the sentence playing now (speech mode).
    private var speechSource: VoiceSource?
    private(set) var status: Status = .idle
    private var chapter: Chapter?
    private var items: [Item] = []
    private var current = 0
    private var generation = 0
    private var lastSavedAt = Date.distantPast
    private var sleepTimer: DispatchWorkItem?
    private var errorMessage: String?
    /// Speech: chapter time (Now Playing, seeking by time), refined as sentences are spoken.
    private var timeline = ChapterTimeline([])
    /// The sentence playing now: when it (last) started playing, how long it played before a pause, and
    /// whether it was interrupted (then it isn't measured).
    private var sentenceStartedAt: TimeInterval?
    private var sentencePlayed: TimeInterval = 0
    private var sentenceInterrupted = false
    /// The next chapter's text, fetched ahead (the chapter change needs no network).
    private var prefetched: Chapter?
    private var prefetchingPath: String?
    /// Background time across a chapter change (nothing plays for a moment).
    private var transitionTask: UIBackgroundTaskIdentifier = .invalid
    /// Silence between chapters: from the end of a chapter to the first sound of the next (last 10, ms).
    private(set) var chapterGapsMs: [Double] = []
    private var chapterEndedAt: TimeInterval?
    /// Cover passed to playNovel (CarPlay, the Listen player) for chapters of that novel loaded later.
    private var coverHint: (key: String, url: String)?
    /// Interruption bookkeeping (calls, Siri, other audio). See InterruptionPolicy.
    private var interruption = InterruptionPolicy()

    // Audio mode (PC-narrated files, or chapters prepared on this iPhone)
    enum AudioOrigin: String { case pc, prepared }
    private(set) var mode: Mode = .speech
    private(set) var audioOrigin: AudioOrigin = .pc
    /// Kokoro voice a prepared chapter was rendered with.
    private var preparedVoice: String?
    private let audio = AudioChapterPlayer()
    private var audioChapter: AudioChapter?
    private var timing: NarrationTiming?
    private var lastSegment: Int?
    private var lastAudioSaveAt = Date.distantPast
    private static let positionsKey = "tachinovel.audioPositions"

    override private init() {
        super.init()
        engine.delegate = self
        // Simulator voice self-test (CI): no audio device, so render headless at real-time pace.
        if NarrationSelfTest.isActive { engine.useManualOutput() }
        let prefs = VoiceSettings.shared.prefs
        rate = Float(prefs.speed)
        engine.volume = prefs.volume
        audio.volume = prefs.volume
        audio.onTime = { [weak self] t in self?.audioTick(fileTime: t) }
        audio.onEnd = { [weak self] in self?.finishChapter() }
        audio.onFail = { [weak self] message in self?.audioFailed(message) }
        RemoteCommandHub.shared.handler = { [weak self] command in self?.remote(command) ?? .noActionableNowPlayingItem }
        RemoteCommandHub.shared.apply(VoiceSettings.shared.prefs.carButtonsChoice)
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(voiceSettingsChanged), name: VoiceSettings.changed, object: nil)
        nc.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        nc.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
    }

    // MARK: - Public API (main thread)

    func play(_ ch: Chapter, startParagraph: Int, startSentence: Int = 0) {
        interruption.userActed()
        generation += 1
        engine.stop()
        stopAudio()
        mode = .speech
        chapter = ch
        if prefetched?.chapterPath == ch.chapterPath { prefetched = nil }
        if let script = ch.script {
            items = Self.items(for: script)
        } else {
            items = Self.items(for: ch.paragraphs, paragraphPause: paragraphPause, scenePause: scenePause)
        }
        refreshNarrator()
        timeline = ChapterTimeline(items.map { ChapterTimeline.Sentence(characters: $0.text.count, pause: pause(of: $0)) })
        resetSentenceClock()
        current = items.firstIndex { $0.paragraph >= startParagraph && ($0.paragraph > startParagraph || $0.sentence >= startSentence) } ?? 0
        guard !items.isEmpty else { return finishChapter() }
        activateSession()
        installRemoteCommands()
        NowPlayingCenter.shared.setArtwork(cover: ch.coverUrl)
        enqueueFromCurrent()
        set(.playing, jump: true)
        if ch.nextPath == nil || ch.prevPath == nil { lookUpNext(for: ch) }
    }

    /// Play a chapter whose text the core fetches (CarPlay, lock-screen auto-continue), or its prepared
    /// audio when there is some.
    func playFromCore(pluginId: String, novelPath: String, chapterPath: String, novelName: String, startParagraph: Int = 0, allowPrepared: Bool = true) {
        if allowPrepared, let p = preparedChapter(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath) {
            return playPrepared(p, pluginId: pluginId, novelPath: novelPath, novelName: novelName, startParagraph: startParagraph)
        }
        if let pre = prefetched, pre.pluginId == pluginId, pre.novelPath == novelPath, pre.chapterPath == chapterPath {
            prefetched = nil
            return play(pre, startParagraph: startParagraph)
        }
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
        if mode == .audio {
            audio.pause()
            saveAudioPosition(force: true)
        } else {
            engine.pause()
            if let t0 = sentenceStartedAt { sentencePlayed += ProcessInfo.processInfo.systemUptime - t0 }
            sentenceStartedAt = nil
            sentenceInterrupted = true
        }
        set(.paused)
        saveProgress(force: true)
    }

    private func resumeInternal() {
        guard status == .paused else { return }
        activateSession()
        if mode == .audio {
            audio.resume(rate: rate)
        } else if engine.isPaused {
            engine.resume()
            sentenceStartedAt = ProcessInfo.processInfo.systemUptime
        } else {
            enqueueFromCurrent()
        }
        set(.playing)
    }

    func stop() {
        interruption.userActed()
        chapterEndedAt = nil
        generation += 1
        engine.stop()
        if mode == .audio { saveAudioPosition(force: true) }
        saveProgress(force: true)
        stopAudio()
        speechSource = nil
        set(.idle)
        sleepTimer?.cancel()
        KokoroService.shared.scheduleIdleRelease()
        prefetched = nil
        NowPlayingCenter.shared.clear()
        endTransition()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func skip(unit: String, count: Int) {
        interruption.userActed()
        if mode == .audio { return skipAudio(unit: unit, count: count) }
        guard chapter != nil, !items.isEmpty else { return }
        if unit == "seconds" { return seekSpeech(by: Double(count)) }
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
        guard let ch = chapter, let next = ch.nextPath ?? nextAudioChapter()?.chapterPath else { return endOfQueue() }
        saveProgress(force: true, finished: true)
        if mode == .audio, audioOrigin == .pc { clearAudioPosition(novelKey: "\(ch.pluginId):\(ch.novelPath)") }
        beginTransition()
        playChapter(pluginId: ch.pluginId, novelPath: ch.novelPath, chapterPath: next, novelName: ch.novelName, startParagraph: 0)
    }

    /// ⏮ near a chapter's start: the chapter before (else this one from the start).
    func previousChapter() {
        guard let ch = chapter, let prev = ch.prevPath ?? previousAudioChapter()?.chapterPath else { return restartChapter() }
        saveProgress(force: true)
        beginTransition()
        playChapter(pluginId: ch.pluginId, novelPath: ch.novelPath, chapterPath: prev, novelName: ch.novelName, startParagraph: 0)
    }

    func restartChapter() {
        interruption.userActed()
        if mode == .audio { return seekAudio(toChapterTime: 0) }
        guard !items.isEmpty else { return }
        seekSpeech(to: 0)
    }

    private func endOfQueue() {
        saveProgress(force: true, finished: true)
        set(.ended)
    }

    /// Play a chapter with the best source: prepared on this iPhone, else PC-narrated audio (if enabled),
    /// else speech (text fetched ahead when possible).
    func playChapter(pluginId: String, novelPath: String, chapterPath: String, novelName: String, startParagraph: Int) {
        if let p = preparedChapter(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath) {
            return playPrepared(p, pluginId: pluginId, novelPath: novelPath, novelName: novelName, startParagraph: startParagraph)
        }
        let usePC = VoiceSettings.shared.prefs.usePCAudio
        // No PC audio: straight to speech, without a thread hop (the chapter change stays seamless).
        guard usePC else {
            return playFromCore(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath, novelName: novelName,
                                startParagraph: startParagraph, allowPrepared: false)
        }
        set(.loading)
        DispatchQueue.global(qos: .userInitiated).async {
            let ac = usePC ? AudioLibrary.shared.chapter(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath) : nil
            DispatchQueue.main.async {
                if let ac {
                    self.playAudio(ac, startParagraph: startParagraph, startTime: nil)
                } else {
                    self.playFromCore(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath, novelName: novelName,
                                      startParagraph: startParagraph, allowPrepared: false)
                }
            }
        }
    }

    /// "Continue listening" for a novel (car player, CarPlay): where reading/listening stopped, audio first.
    func playNovel(pluginId: String, novelPath: String, novelName: String, coverUrl: String?) {
        let key = "\(pluginId):\(novelPath)"
        let narration = self
        if let coverUrl { coverHint = (key, coverUrl) }
        set(.loading)
        let usePC = VoiceSettings.shared.prefs.usePCAudio
        CoreHost.shared.request("narration.resumePoint", args: ["pluginId": pluginId, "novelPath": novelPath]) { ok, result in
            let point = ok ? result as? [String: Any] : nil
            DispatchQueue.global(qos: .userInitiated).async {
                let novel = usePC ? AudioLibrary.shared.novel(key) : nil
                let saved = Self.savedPosition(novelKey: key)
                var chapterPath = point?["chapterPath"] as? String
                var paragraph = (point?["paragraph"] as? NSNumber)?.intValue ?? 0
                var audioChapter: AudioChapter?
                var startTime: Double?
                if let novel {
                    // A listening position saved by the player beats the reader's paragraph for the same chapter.
                    if let saved, chapterPath == nil || saved.chapterPath == chapterPath,
                       let ac = novel.chapters.first(where: { $0.chapterPath == saved.chapterPath }) {
                        audioChapter = ac
                        startTime = saved.seconds
                    } else if let cp = chapterPath {
                        let number = novel.chapters.first { $0.chapterPath == cp }?.number
                        audioChapter = AudioLibrary.shared.chapter(atOrAfter: cp, in: novel, number: number)
                        if audioChapter?.chapterPath != cp { paragraph = 0 }
                    } else {
                        audioChapter = novel.chapters.first
                    }
                    if chapterPath == nil { chapterPath = audioChapter?.chapterPath }
                }
                DispatchQueue.main.async {
                    if let audioChapter {
                        narration.playAudio(audioChapter, startParagraph: paragraph, startTime: startTime, coverUrl: coverUrl)
                    } else if let cp = chapterPath {
                        narration.playFromCore(pluginId: pluginId, novelPath: novelPath, chapterPath: cp, novelName: novelName, startParagraph: paragraph)
                    } else {
                        narration.fail("Nothing to play yet: read a chapter first")
                    }
                }
            }
        }
    }

    // MARK: - Audio mode

    /// Play a narrated chapter file. `startTime` (chapter seconds) wins over `startParagraph`.
    func playAudio(_ ac: AudioChapter, startParagraph: Int, startTime: Double?, coverUrl: String? = nil, origin: AudioOrigin = .pc, voice: String? = nil) {
        interruption.userActed()
        generation += 1
        engine.stop()
        stopAudio()
        mode = .audio
        audioOrigin = origin
        preparedVoice = voice
        if prefetched?.chapterPath == ac.chapterPath { prefetched = nil }
        audioChapter = ac
        timing = nil
        lastSegment = nil
        items = []
        current = 0
        chapter = Chapter(pluginId: ac.pluginId, novelPath: ac.novelPath, chapterPath: ac.chapterPath, novelName: ac.novelName,
                          chapterName: ac.title, coverUrl: coverUrl ?? cover(pluginId: ac.pluginId, novelPath: ac.novelPath),
                          paragraphs: [], nextPath: nil, nextName: nil)
        set(.loading)
        let gen = generation
        DispatchQueue.global(qos: .userInitiated).async {
            var loadError: String?
            do { try AudioLibrary.shared.ensureDownloaded(ac.audioURL) } catch { loadError = error.localizedDescription }
            let parsed = AudioLibrary.shared.timingJSON(ac).flatMap { NarrationTiming(json: $0) }
            DispatchQueue.main.async {
                guard gen == self.generation else { return } // superseded
                if let loadError { return self.audioFailed(loadError, startParagraph: startParagraph) }
                self.timing = parsed
                self.chapter?.nextPath = parsed?.nextChapterPath ?? self.nextAudioChapter()?.chapterPath
                self.chapter?.nextName = parsed?.nextTitle
                self.chapter?.prevPath = parsed?.prevChapterPath ?? self.previousAudioChapter()?.chapterPath
                self.chapter?.prevName = parsed?.prevTitle
                var chapterTime = startTime ?? 0
                if startTime == nil, startParagraph > 0 {
                    let t = origin == .prepared ? parsed?.time(forParagraph: startParagraph) : parsed?.time(forBlock: startParagraph)
                    if let t { chapterTime = t }
                }
                self.activateSession()
                self.installRemoteCommands()
                NowPlayingCenter.shared.setArtwork(cover: self.chapter?.coverUrl)
                self.audio.load(url: ac.audioURL, at: (parsed?.offset ?? 0) + chapterTime, rate: self.rate)
                self.set(.playing, jump: true)
            }
        }
    }

    /// The narrated file can't play (offline and evicted by iCloud, unreadable, corrupt): read the same
    /// chapter with the system voice instead of stopping, from the spoken paragraph if there is one.
    private func audioFailed(_ message: String, startParagraph: Int? = nil) {
        guard mode == .audio, let ac = audioChapter else { return fail(message) }
        CoreHost.shared.log.error("narration: audio failed (\(message, privacy: .public)); falling back to speech")
        let paragraph = startParagraph ?? lastSegment.flatMap { timing?.segments[safe: $0].map { $0.paragraph ?? $0.block } } ?? 0
        if audioOrigin == .prepared { DriveCache.shared.evictAfterListening(novelKey: ac.novelKey, chapterPath: ac.chapterPath) }
        stopAudio()
        mode = .speech
        playFromCore(pluginId: ac.pluginId, novelPath: ac.novelPath, chapterPath: ac.chapterPath, novelName: ac.novelName,
                     startParagraph: paragraph, allowPrepared: false)
    }

    private func stopAudio() {
        audio.stop()
        if mode == .audio {
            audioChapter = nil
            timing = nil
        }
    }

    private func nextAudioChapter() -> AudioChapter? {
        guard mode == .audio, audioOrigin == .pc, let ac = audioChapter else { return nil }
        let key = ac.novelKey
        guard let novel = MainThread.run({ AudioLibrary.shared.novel(key) }),
              let i = novel.chapters.firstIndex(where: { $0.chapterPath == ac.chapterPath }) else { return nil }
        return novel.chapters[safe: i + 1]
    }

    private func previousAudioChapter() -> AudioChapter? {
        guard mode == .audio, audioOrigin == .pc, let ac = audioChapter else { return nil }
        let key = ac.novelKey
        guard let novel = MainThread.run({ AudioLibrary.shared.novel(key) }),
              let i = novel.chapters.firstIndex(where: { $0.chapterPath == ac.chapterPath }) else { return nil }
        return i > 0 ? novel.chapters[safe: i - 1] : nil
    }

    // MARK: - Prepared chapters ("Prepare for the drive")

    /// The chapter's prepared audio, if it was made with the novel's current voice.
    private func preparedChapter(pluginId: String, novelPath: String, chapterPath: String) -> PreparedChapter? {
        guard !Self.isSynthetic(pluginId) || NarrationSelfTest.shared.hasChapters else { return nil }
        let key = VoiceSettings.novelKey(pluginId: pluginId, novelPath: novelPath)
        return DriveCache.shared.prepared(novelKey: key, chapterPath: chapterPath, voice: VoiceSettings.shared.prefs.preparedVoice(forNovel: key))
    }

    private func playPrepared(_ p: PreparedChapter, pluginId: String, novelPath: String, novelName: String, startParagraph: Int) {
        let cache = DriveCache.shared
        let ac = AudioChapter(novelKey: p.novelKey, pluginId: pluginId, novelPath: novelPath, novelName: novelName, chapterPath: p.chapterPath,
                              number: 0, title: p.title, audioURL: cache.url(p.audioFile), timingURL: cache.url(p.manifestFile))
        playAudio(ac, startParagraph: startParagraph, startTime: nil, coverUrl: cover(pluginId: pluginId, novelPath: novelPath), origin: .prepared, voice: p.voice)
    }

    /// The novel's cover: from the chapter playing now (same novel), else the one playNovel was given.
    private func cover(pluginId: String, novelPath: String) -> String? {
        if let ch = chapter, ch.pluginId == pluginId, ch.novelPath == novelPath, let c = ch.coverUrl { return c }
        guard let hint = coverHint, hint.key == "\(pluginId):\(novelPath)" else { return nil }
        return hint.url
    }

    /// A chapter's text and script for preparing it (DrivePrep), the same way narration loads it.
    func chapterForPreparing(pluginId: String, novelPath: String, chapterPath: String, novelName: String, coverUrl: String?,
                             completion: @escaping (Chapter?) -> Void) {
        fetchChapter(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath, novelName: novelName) { ch in
            var ch = ch
            if let coverUrl { ch?.coverUrl = coverUrl }
            completion(ch)
        }
    }

    /// Chapter-relative time (bundles: minus the chapter's offset in the file).
    private var audioChapterTime: Double { max(0, audio.currentTime - (timing?.offset ?? 0)) }

    private func audioTick(fileTime: Double) {
        guard mode == .audio, let ch = chapter else { return }
        let t = max(0, fileTime - (timing?.offset ?? 0))
        // Bundles (.m4b) don't end per chapter: stop at this chapter's length.
        if let timing, timing.offset > 0, timing.duration > 0, t >= timing.duration { return finishChapter() }
        if let timing, let i = timing.segmentIndex(at: t), i != lastSegment {
            if lastSegment == nil { recordChapterGap() }
            lastSegment = i
            let seg = timing.segments[i]
            if audioOrigin == .prepared {
                // Rendered from the same sentence script as live speech: highlight it the same way.
                var p: [String: Any] = ["chapterPath": ch.chapterPath, "engine": "speech", "source": VoiceSource.kokoro.rawValue, "prepared": true,
                                        "paragraph": seg.paragraph ?? seg.block, "segment": seg.id, "block": seg.block, "start": seg.start,
                                        "end": seg.end, "t": t]
                if let hash = seg.hash { p["hash"] = hash }
                onProgress?(p)
            } else {
                onProgress?(["chapterPath": ch.chapterPath, "engine": "audio", "segment": seg.id, "paragraph": seg.block,
                             "charStart": seg.start, "charEnd": seg.end, "t": t])
            }
            saveProgress(force: false)
            publishNowPlaying()
        }
        saveAudioPosition(force: false)
    }

    private func skipAudio(unit: String, count: Int) {
        guard audio.isLoaded else { return }
        var target = audioChapterTime
        switch unit {
        case "sentence", "paragraph":
            if let timing, !timing.segments.isEmpty {
                let i = timing.segmentIndex(at: audioChapterTime) ?? 0
                var j = i + count
                if unit == "paragraph", let cur = timing.segments[safe: i] {
                    let wanted = cur.block + count
                    j = count > 0 ? (timing.segments.firstIndex { $0.block >= wanted } ?? timing.segments.count)
                                  : (timing.segments.firstIndex { $0.block >= max(0, wanted) } ?? 0)
                }
                if j >= timing.segments.count { return nextChapter() }
                target = timing.segments[max(0, j)].t0
            } else {
                target += Double(count) * 15
            }
        default: // "seconds"
            target += Double(count)
        }
        seekAudio(toChapterTime: target)
    }

    func seekAudio(toChapterTime t: Double) {
        guard mode == .audio else { return }
        let clamped = max(0, min(t, max(0, (timing?.duration ?? audio.fileDuration) - 0.5)))
        lastSegment = nil
        audio.seek(to: (timing?.offset ?? 0) + clamped) { [weak self] in
            self?.publishNowPlaying(jump: true)
            self?.saveAudioPosition(force: true)
        }
    }

    // Saved listening positions: novel key → chapter + seconds (UserDefaults; small).
    struct SavedPosition {
        let chapterPath: String
        let seconds: Double
    }

    static func savedPosition(novelKey: String) -> SavedPosition? {
        guard let all = UserDefaults.standard.dictionary(forKey: positionsKey),
              let entry = all[novelKey] as? [String: Any], let cp = entry["chapterPath"] as? String,
              let s = (entry["seconds"] as? NSNumber)?.doubleValue else { return nil }
        return SavedPosition(chapterPath: cp, seconds: s)
    }

    private func saveAudioPosition(force: Bool) {
        guard mode == .audio, audioOrigin == .pc, let ac = audioChapter else { return }
        guard force || Date().timeIntervalSince(lastAudioSaveAt) > 5 else { return }
        lastAudioSaveAt = Date()
        var all = UserDefaults.standard.dictionary(forKey: Self.positionsKey) ?? [:]
        all[ac.novelKey] = ["chapterPath": ac.chapterPath, "seconds": audioChapterTime, "at": Date().timeIntervalSince1970]
        UserDefaults.standard.set(all, forKey: Self.positionsKey)
    }

    private func clearAudioPosition(novelKey: String) {
        var all = UserDefaults.standard.dictionary(forKey: Self.positionsKey) ?? [:]
        all.removeValue(forKey: novelKey)
        UserDefaults.standard.set(all, forKey: Self.positionsKey)
    }

    func setSleepTimer(minutes: Double) {
        sleepTimer?.cancel()
        guard minutes > 0 else { return }
        let item = DispatchWorkItem { [weak self] in self?.pause() }
        sleepTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + minutes * 60, execute: item)
    }

    /// Listen speed 0.5–2.5× (persisted; the same for every voice).
    func applyRate(_ r: Float) {
        let clamped = Float(SpeechSpeed.clamp(Double(r)))
        let changed = abs(clamped - rate) > 0.001
        rate = clamped
        if abs(VoiceSettings.shared.prefs.speed - Double(clamped)) > 0.001 {
            VoiceSettings.shared.update { $0.speed = Double(clamped) }
        }
        guard changed else { return }
        if mode == .audio {
            audio.setRate(rate) // time-stretched: instant
        } else if status == .playing {
            // Speech is synthesized at the speed: re-render the sentence once the slider rests (it sends
            // ~10 changes a second while dragged), not on every step.
            rateRestart?.cancel()
            let item = DispatchWorkItem { [weak self] in
                guard let self, self.mode == .speech, self.status == .playing else { return }
                self.restartFromCurrent()
            }
            rateRestart = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: item)
        } else if status == .paused, mode == .speech {
            // Resume speaks the sentence again at the new speed (not the paused one at the old speed).
            generation += 1
            engine.stop()
        }
        publishNowPlaying(jump: true)
    }

    private var rateRestart: DispatchWorkItem?

    func stateDict() -> [String: Any] {
        var d: [String: Any] = ["status": status.rawValue]
        if let ch = chapter {
            d["pluginId"] = ch.pluginId
            d["novelPath"] = ch.novelPath
            d["chapterPath"] = ch.chapterPath
            d["novelName"] = ch.novelName
            d["chapterName"] = ch.chapterName
        }
        d["engine"] = mode.rawValue
        d["carButtons"] = RemoteCommandHub.shared.buttons.rawValue
        if mode == .audio {
            d["position"] = audioChapterTime
            d["duration"] = audioDuration
            if audioOrigin == .prepared {
                d["prepared"] = true
                let id = preparedVoice ?? kokoroVoiceForCurrentNovel()
                d["voice"] = ["kokoroVoice": id, "kokoroName": VoiceSettings.shared.prefs.displayName(id), "source": VoiceSource.kokoro.rawValue]
            }
            if let i = lastSegment, let seg = timing?.segments[safe: i] {
                d["paragraph"] = seg.block
                d["segment"] = seg.id
            }
        } else if let it = items[safe: current] {
            d["paragraph"] = it.paragraph
            d["sentence"] = it.sentence
            if let seg = it.segment { d["segment"] = seg.id }
            d["position"] = chapterTime()
            d["duration"] = timeline.duration
        }
        if mode == .speech { d["voice"] = voiceDict() }
        if let errorMessage { d["error"] = errorMessage }
        return d
    }

    /// "Voice volume" 0–1.5 (persisted; applied live to every voice).
    func applyVolume(_ v: Double) {
        let clamped = VoiceVolume.clamp(v)
        engine.volume = clamped
        audio.volume = clamped
        if abs(VoiceSettings.shared.prefs.volume - clamped) > 0.0001 {
            VoiceSettings.shared.update { $0.volume = clamped }
        }
    }

    /// Which voice is speaking (for the mini player / Listen player subtitle): Kokoro with its name, or the
    /// system voice standing in, and why.
    private func voiceDict() -> [String: Any] {
        let id = kokoroVoiceForCurrentNovel()
        var v: [String: Any] = ["kokoroVoice": id, "kokoroName": VoiceSettings.shared.prefs.displayName(id)]
        if let speechSource { v["source"] = speechSource.rawValue }
        if speechSource == .apple {
            let apple = VoiceSettings.appleVoice(explicit: voiceIdentifier, kokoroVoice: id)
            v["appleName"] = apple?.name ?? "System voice"
            if let reason = engine.lastFallback { v["fallback"] = reason.rawValue }
            v["kokoroStatus"] = KokoroService.shared.statusText
        }
        return v
    }

    private func kokoroVoiceForCurrentNovel() -> String {
        let key = chapter.map { VoiceSettings.novelKey(pluginId: $0.pluginId, novelPath: $0.novelPath) }
        return VoiceSettings.shared.prefs.voice(forNovel: key)
    }

    /// Narration that would use Kokoro is active (KokoroService reloads after memory pressure only then).
    var wantsKokoro: Bool { mode == .speech && (status == .playing || status == .loading || status == .paused) }

    /// Speech is being synthesized for listening right now ("Prepare for the drive" waits meanwhile).
    var speaksLive: Bool { mode == .speech && (status == .playing || status == .loading) }

    /// The speech engine (Voice Lab reads its counters).
    var speechEngine: HybridSpeechEngine { engine }

    /// A voice sample is about to play: the session must be active; narration pauses.
    func activateForSample() {
        if status == .playing { pause() }
        activateSession()
    }

    /// What the speech engine was started with; a settings change that alters it restarts the sentence.
    private var appliedVoiceKey = ""

    private func voiceKey() -> String {
        let p = VoiceSettings.shared.prefs
        return "\(kokoroVoiceForCurrentNovel())|\(p.kokoroEnabled)|\(p.route)|\(p.clampedAhead)|\(KokoroService.shared.crashDisabled)|\(String(describing: p.narrator))"
    }

    /// Voice, Kokoro on/off or route changed: the current sentence restarts with the new voice.
    @objc private func voiceSettingsChanged() {
        DispatchQueue.main.async {
            RemoteCommandHub.shared.apply(VoiceSettings.shared.prefs.carButtonsChoice)
            // Speed and volume set elsewhere (Settings, the Listen player through setVoiceSettings).
            let prefs = VoiceSettings.shared.prefs
            if abs(Double(self.rate) - prefs.speed) > 0.001 { self.applyRate(Float(prefs.speed)) }
            if abs(self.engine.volume - prefs.volume) > 0.0001 { self.applyVolume(prefs.volume) }
            guard self.mode == .speech, self.status == .playing || self.status == .paused, !self.items.isEmpty,
                  self.voiceKey() != self.appliedVoiceKey else {
                self.onState?(self.stateDict())
                return
            }
            let wasPaused = self.status == .paused
            self.restartFromCurrent()
            if wasPaused { self.pauseInternal() }
        }
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

    /// Items from the front-end script: one per sentence, pauses from the front-end (scene breaks already
    /// folded into the sentence before them), `sentence` = index within its paragraph.
    private static func items(for script: [ScriptItem]) -> [Item] {
        var perParagraph: [Int: Int] = [:]
        return script.map { s in
            let n = perParagraph[s.paragraph, default: 0]
            perParagraph[s.paragraph] = n + 1
            return Item(paragraph: s.paragraph, sentence: n, text: s.text, pauseAfter: max(0, s.pauseMs) / 1000, runs: s.runs, segment: s,
                        pacedAfter: s.pacedMs.map { max(0, $0) / 1000 })
        }
    }

    private func enqueueFromCurrent() {
        // Pauses scale with the speed, like the speech itself (front-end pauses are at 1.0x).
        let speed = Double(max(0.5, rate))
        refreshNarrator()
        let segs = items[current...].enumerated().map { offset, it in
            speechSegment(it, id: generation * 100_000 + current + offset, speed: speed)
        }
        engine.narrator = narrator
        engine.kokoroVoice = kokoroVoiceForCurrentNovel()
        engine.explicitAppleVoice = voiceIdentifier
        appliedVoiceKey = voiceKey()
        engine.enqueue(segs)
        resetSentenceClock()
        if let pre = prefetched { warmUp(pre) }
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

    func speechEngine(didStart id: Int, source: VoiceSource) {
        guard let i = index(of: id), let it = items[safe: i], let ch = chapter else { return }
        current = i
        sentenceStartedAt = ProcessInfo.processInfo.systemUptime
        sentencePlayed = 0
        sentenceInterrupted = false
        recordChapterGap()
        let sourceChanged = speechSource != source
        speechSource = source
        var p: [String: Any] = ["chapterPath": ch.chapterPath, "engine": "speech", "source": source.rawValue,
                                "paragraph": it.paragraph, "sentence": it.sentence]
        if let seg = it.segment {
            p["segment"] = seg.id
            p["block"] = seg.block
            p["start"] = seg.start
            p["end"] = seg.end
            p["hash"] = seg.hash
        }
        onProgress?(p)
        if sourceChanged { onState?(stateDict()) }
        publishNowPlaying()
        saveProgress(force: false)
        // Look ahead: learn the next chapter, then fetch its text (gapless, offline-safe) and let Kokoro
        // render its first sentences once this chapter is fully rendered.
        if autoContinue, i == max(0, items.count * 4 / 5), ch.nextPath == nil { lookUpNext(for: ch) }
        if autoContinue, i >= items.count * 2 / 3 || items.count - i <= 12 { prefetchNext() }
    }

    func speechEngine(didFinish id: Int) {
        guard let i = index(of: id) else { return }
        if let t0 = sentenceStartedAt, !sentenceInterrupted, let it = items[safe: i], i == current {
            // Wall time × speed = chapter time at 1×; the pause after the sentence is already known.
            let played = (sentencePlayed + ProcessInfo.processInfo.systemUptime - t0) * Double(max(0.5, rate))
            timeline.record(i, seconds: played - pause(of: it))
        }
        resetSentenceClock()
        if i >= items.count - 1 { finishChapter() }
    }

    func speechEngine(willSpeak id: Int, range: NSRange) {
        guard let i = index(of: id), let it = items[safe: i], let ch = chapter else { return }
        var p: [String: Any] = ["chapterPath": ch.chapterPath, "engine": "speech", "paragraph": it.paragraph, "sentence": it.sentence,
                                "charStart": range.location, "charEnd": range.location + range.length]
        if let seg = it.segment { p["segment"] = seg.id }
        onProgress?(p)
    }

    private func finishChapter() {
        saveProgress(force: true, finished: true)
        // Listened to the end: prepared audio has done its job.
        if mode == .audio, audioOrigin == .prepared, let ac = audioChapter {
            DriveCache.shared.evictAfterListening(novelKey: ac.novelKey, chapterPath: ac.chapterPath)
        }
        if autoContinue, chapter?.nextPath != nil || (mode == .audio && nextAudioChapter() != nil) {
            chapterEndedAt = ProcessInfo.processInfo.systemUptime
            return nextChapter()
        }
        if mode == .audio, audioOrigin == .pc, let key = audioChapter?.novelKey { clearAudioPosition(novelKey: key) }
        audio.stop()
        set(.ended)
    }

    // MARK: - Core round trips

    private func fetchChapter(pluginId: String, novelPath: String, chapterPath: String, novelName: String, completion: @escaping (Chapter?) -> Void) {
        let args: [String: Any] = ["pluginId": pluginId, "novelPath": novelPath, "chapterPath": chapterPath]
        let request: (@escaping (Bool, Any?) -> Void) -> Void = { done in
            // Simulator self-test: a synthetic novel registered by voice-selftest.ts (no source behind it).
            if pluginId == "voice-selftest", let r = NarrationSelfTest.shared.chapterText(chapterPath) { return done(true, r) }
            CoreHost.shared.request("narration.chapterText", args: args, completion: done)
        }
        request { ok, result in
            DispatchQueue.main.async {
                guard ok, let r = result as? [String: Any] else { return completion(nil) }
                let paragraphs = (r["paragraphs"] as? [[String: Any]] ?? []).map { p in
                    Paragraph(index: p["index"] as? Int ?? 0, text: p["text"] as? String ?? "",
                              sentences: p["sentences"] as? [String], scene: (p["pause"] as? String) == "scene")
                }
                let next = r["next"] as? [String: Any]
                let prev = r["prev"] as? [String: Any]
                completion(Chapter(pluginId: pluginId, novelPath: novelPath, chapterPath: chapterPath, novelName: novelName,
                                   chapterName: r["title"] as? String ?? chapterPath, coverUrl: self.cover(pluginId: pluginId, novelPath: novelPath),
                                   paragraphs: paragraphs,
                                   nextPath: (next?["locked"] as? Bool) == true ? nil : next?["path"] as? String,
                                   nextName: next?["name"] as? String,
                                   script: ScriptItem.parse(r["script"]),
                                   prevPath: (prev?["locked"] as? Bool) == true ? nil : prev?["path"] as? String,
                                   prevName: prev?["name"] as? String))
            }
        }
    }

    /// Voice Lab's test paragraph and the simulator voice self-test: no novel behind them, so no progress,
    /// history or next chapter.
    static func isSynthetic(_ pluginId: String) -> Bool { pluginId == "voice-lab" || pluginId == "voice-selftest" }

    /// Learn the next chapter (UI-initiated plays only carry the current chapter's paragraphs).
    private func lookUpNext(for ch: Chapter) {
        guard !Self.isSynthetic(ch.pluginId) || NarrationSelfTest.shared.hasChapters else { return }
        fetchChapter(pluginId: ch.pluginId, novelPath: ch.novelPath, chapterPath: ch.chapterPath, novelName: ch.novelName) { [weak self] fetched in
            guard let self, let fetched, self.chapter?.chapterPath == ch.chapterPath else { return }
            if self.chapter?.nextPath == nil {
                self.chapter?.nextPath = fetched.nextPath
                self.chapter?.nextName = fetched.nextName
            }
            if self.chapter?.prevPath == nil {
                self.chapter?.prevPath = fetched.prevPath
                self.chapter?.prevName = fetched.prevName
            }
        }
    }

    /// Fetch the next chapter's text ahead (no network needed at the change, works offline) and let Kokoro
    /// render its first sentences while this chapter ends.
    private func prefetchNext() {
        guard let ch = chapter, let next = ch.nextPath, prefetched?.chapterPath != next, prefetchingPath != next else { return }
        if preparedChapter(pluginId: ch.pluginId, novelPath: ch.novelPath, chapterPath: next) != nil { return } // on disk already
        prefetchingPath = next
        fetchChapter(pluginId: ch.pluginId, novelPath: ch.novelPath, chapterPath: next, novelName: ch.novelName) { [weak self] fetched in
            guard let self else { return }
            if self.prefetchingPath == next { self.prefetchingPath = nil }
            guard let fetched, fetched.script != nil || !fetched.paragraphs.isEmpty, self.chapter?.chapterPath == ch.chapterPath else { return }
            self.prefetched = fetched
            self.warmUp(fetched)
        }
    }

    /// Kokoro renders the first sentences of `ch` once the current chapter is fully rendered.
    private func warmUp(_ ch: Chapter) {
        guard mode == .speech, let script = ch.script else { return }
        let speed = Double(max(0.5, rate))
        engine.lookahead = Self.items(for: script).prefix(2).map { it in speechSegment(it, id: -1, speed: speed) }
    }

    private func saveProgress(force: Bool, finished: Bool = false) {
        guard let ch = chapter, !Self.isSynthetic(ch.pluginId) else { return }
        let paragraph: Int
        let percent: Double
        if mode == .audio {
            paragraph = lastSegment.flatMap { timing?.segments[safe: $0].map { $0.paragraph ?? $0.block } } ?? 0
            let duration = audioDuration
            percent = finished ? 1 : (duration > 0 ? min(0.99, audioChapterTime / duration) : 0)
        } else {
            guard let it = items[safe: min(current, max(0, items.count - 1))] else { return }
            paragraph = it.paragraph
            percent = finished ? 1 : Double(current) / Double(max(1, items.count))
        }
        guard force || Date().timeIntervalSince(lastSavedAt) > 5 else { return }
        lastSavedAt = Date()
        var args: [String: Any] = [
            "pluginId": ch.pluginId, "novelPath": ch.novelPath, "chapterPath": ch.chapterPath,
            "position": ["percent": percent, "paragraph": paragraph, "offset": 0] as [String: Any],
        ]
        if finished { args["finished"] = true }
        CoreHost.shared.request("progress.save", args: args)
    }

    // MARK: - State, audio session, Now Playing

    private func set(_ s: Status, jump: Bool = false) {
        status = s
        if s != .error { errorMessage = nil }
        onState?(stateDict())
        publishNowPlaying(jump: jump)
        if s != .loading { endTransition() }
        DrivePrep.shared.narrationChanged()
    }

    private func fail(_ message: String) {
        errorMessage = message
        status = .error
        onState?(stateDict())
        publishNowPlaying()
        endTransition()
        DrivePrep.shared.narrationChanged()
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
                // A call or a navigation prompt cut in: pick up a moment earlier (speech resumes mid-sentence).
                if self.mode == .audio { self.seekAudio(toChapterTime: max(0, self.audioChapterTime - 2)) }
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

    // MARK: - Now Playing, remote commands, seeking

    private var audioDuration: Double {
        let d = timing?.duration ?? 0
        return d > 0 ? d : audio.fileDuration
    }

    private func recordChapterGap() {
        guard let t = chapterEndedAt else { return }
        chapterEndedAt = nil
        chapterGapsMs.append(((ProcessInfo.processInfo.systemUptime - t) * 1000).rounded())
        if chapterGapsMs.count > 10 { chapterGapsMs.removeFirst(chapterGapsMs.count - 10) }
    }

    private func resetSentenceClock() {
        sentenceStartedAt = nil
        sentencePlayed = 0
        sentenceInterrupted = false
    }

    /// Chapter time now (seconds at 1×): the player's for audio, the timeline + the sentence in progress
    /// for speech.
    func chapterTime() -> Double {
        if mode == .audio { return audioChapterTime }
        guard let it = items[safe: current] else { return 0 }
        let inSentence = sentencePlayed + (sentenceStartedAt.map { ProcessInfo.processInfo.systemUptime - $0 } ?? 0)
        return timeline.start(of: current) + min(inSentence * Double(max(0.5, rate)), timeline.speaking(current) + pause(of: it))
    }

    /// Lock screen, Control Center and the car: chapter, novel, "TachiNovel", cover, time and length.
    private func publishNowPlaying(jump: Bool = false) {
        guard let ch = chapter, status != .idle else { return }
        let duration = mode == .audio ? audioDuration : timeline.duration
        NowPlayingCenter.shared.publish(chapter: ch.chapterName, novel: ch.novelName, elapsed: chapterTime(), duration: duration,
                                        playing: status == .playing, speed: Double(rate), jump: jump)
    }

    private func installRemoteCommands() {
        RemoteCommandHub.shared.install()
        RemoteCommandHub.shared.apply(VoiceSettings.shared.prefs.carButtonsChoice)
    }

    /// A remote command (car, lock screen, headphones, Siri), mapped by RemoteCommandMap.
    private func remote(_ command: RemoteCommand) -> MPRemoteCommandHandlerStatus {
        let hasPrevious = chapter?.prevPath != nil || previousAudioChapter() != nil
        let action = RemoteCommandMap.action(for: command, in: RemoteContext(playing: status == .playing, elapsed: chapterTime(), hasPreviousChapter: hasPrevious))
        guard chapter != nil || action == .resume else { return .noActionableNowPlayingItem }
        perform(action)
        return .success
    }

    func perform(_ action: RemoteAction) {
        switch action {
        case .resume:
            if status == .paused {
                resume()
            } else if status != .playing && status != .loading {
                continueListening()
            }
        case .pause:
            pause()
        case .nextChapter:
            interruption.userActed()
            nextChapter()
        case .previousChapter:
            interruption.userActed()
            previousChapter()
        case .restartChapter:
            restartChapter()
        case .seekBy(let d):
            interruption.userActed()
            if mode == .audio { seekAudio(toChapterTime: audioChapterTime + d) } else { seekSpeech(by: d) }
        case .seekTo(let t):
            interruption.userActed()
            if mode == .audio { seekAudio(toChapterTime: t) } else { seekSpeech(to: t) }
        case .setRate(let r):
            applyRate(r)
        }
    }

    /// Play with nothing playing ("Hey Siri, resume" after the app was closed, the car's ▶): the current
    /// novel where it stopped, else the novel listened to or read last.
    private func continueListening() {
        if let ch = chapter, !Self.isSynthetic(ch.pluginId) {
            if status == .ended, ch.nextPath != nil { return nextChapter() }
            return playNovel(pluginId: ch.pluginId, novelPath: ch.novelPath, novelName: ch.novelName, coverUrl: ch.coverUrl)
        }
        CoreHost.shared.request("history.list", args: ["limit": 1]) { ok, result in
            guard ok, let e = (result as? [[String: Any]])?.first, let pluginId = e["pluginId"] as? String,
                  let novelPath = e["path"] as? String else { return }
            let name = e["novelName"] as? String ?? ""
            let cover = e["cover"] as? String
            DispatchQueue.main.async { self.playNovel(pluginId: pluginId, novelPath: novelPath, novelName: name, coverUrl: cover) }
        }
    }

    /// Speech: jump to chapter time `t` (sentence accuracy). Past the end → the next chapter.
    private func seekSpeech(to t: Double) {
        guard mode == .speech, !items.isEmpty else { return }
        if t >= timeline.duration - 0.25, chapter?.nextPath != nil { return nextChapter() }
        current = timeline.index(at: max(0, t))
        if status == .paused {
            // Stay paused; resume speaks from the new sentence.
            generation += 1
            engine.stop()
            resetSentenceClock()
            onState?(stateDict())
            return publishNowPlaying(jump: true)
        }
        restartFromCurrent()
        publishNowPlaying(jump: true)
    }

    /// Speech: ±seconds (the skip buttons). Forward always moves at least one sentence.
    private func seekSpeech(by delta: Double) {
        guard mode == .speech, !items.isEmpty else { return }
        var target = timeline.index(at: max(0, chapterTime() + delta))
        if delta > 0, target <= current { target = current + 1 }
        if target >= items.count {
            if chapter?.nextPath != nil { return nextChapter() }
            target = items.count - 1
        }
        seekSpeech(to: timeline.start(of: target))
    }

    // MARK: - Chapter changes in the background

    private func beginTransition() {
        guard transitionTask == .invalid else { return }
        transitionTask = MainThread.run {
            UIApplication.shared.beginBackgroundTask(withName: "narration-next-chapter") { [weak self] in self?.endTransition() }
        }
    }

    private func endTransition() {
        guard transitionTask != .invalid else { return }
        let task = transitionTask
        MainThread.run { UIApplication.shared.endBackgroundTask(task) }
        transitionTask = .invalid
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
