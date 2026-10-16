//
//  ChapterAudioRenderer.swift — one chapter into an audio file (audio downloads part 1, 2026-10-16).
//
//  Nephis (ChapterAudioRenderer): her calls through the one render pipeline Listen plays (NephisRenderPipeline:
//  NephisCallPlan's paragraphs, her studio always and never given up for pace, one take or Developer › "Best of 2
//  Takes", the lead-in, background priority, then her EQ step, the read's rate and NaturalFinish's flow finish with its
//  real sentence cuts). No volume stage or limiter: volume stays a playback control. The director's delivery for the
//  chapter is worked out before (ChapterDirector) and goes into the manifest.
//    - Resumable: each call is a chunk (16-bit PCM at the read's rate) in NarrationAudio/work/<chapter>/, with
//      checkpoint.json (HDVoiceCore RenderCheckpoint). Stopped (live reading, heat, the app suspended), it goes on later
//      from the last paragraph it finished, with a fresh read there; a call made while her studio or dialogue pack was
//      still loading (or short of memory) is made again once, from its paragraph's start.
//    - At the end, one pass encodes the chunks (AAC-LC mono: 44.1 kHz 128 kbps with her studio, 24 kHz 32 kbps without),
//      the manifest is written next to it and both move into the novel's folder; the work folder goes.
//  Kokoro (KokoroChapterRenderer): the backup voice's sentence-by-sentence render, as "Prepare for the drive" had it.
//  Main thread; files on a serial queue.
//

@preconcurrency import AVFoundation
import ExpressiveCore
import ExpressiveEngines
import Foundation
import HDVoiceCore
import HDVoiceKokoro
import os

enum DriveError: Error, LocalizedError {
    case interrupted(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .interrupted(let why), .failed(let why): return why
        }
    }
}

/// What a finished chapter render made (files relative to NarrationAudioStore's folder).
struct ChapterAudioOutput {
    let audioFile: String
    let manifestFile: String
    let bytes: Int
    let durationMs: Double
    let sentences: Int
    /// Wall time her calls took (all runs of the chapter), and calls kept without her studio or dialogue pack.
    let renderSeconds: Double
    let incomplete: Int
}

/// Where a render is (DrivePrep's status).
struct ChapterAudioProgress {
    var sentence: Int
    var sentences: Int
    var calls: Int
    var seconds: Double
    /// "director", "rendering", "waiting", "encoding".
    var step: String
}

enum ChapterAudioFiles {
    /// AAC bit rate for a file at `sampleRate`: 128 kbps for her studio's 44.1 kHz (low rates smear breaths and "s"
    /// sounds first), 32 kbps for 24 kHz (Kokoro, her voice without the studio).
    static func bitRate(sampleRate: Int) -> Int {
        sampleRate == SessionRate.standard ? NarrationAudioEstimate.plainBitRate : NarrationAudioEstimate.studioBitRate
    }

    static func settings(sampleRate: Int) -> [String: Any] {
        [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: bitRate(sampleRate: sampleRate)]
    }

    static func buffer(_ frames: [Float], format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard !frames.isEmpty, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames.count)),
              let ch = buf.floatChannelData?[0] else { return nil }
        frames.withUnsafeBufferPointer { src in
            if let base = src.baseAddress { ch.update(from: base, count: frames.count) }
        }
        buf.frameLength = AVAudioFrameCount(frames.count)
        return buf
    }

    /// 16-bit PCM (host order) of `pieces`, one after the other.
    static func pcm16(_ pieces: [[Float]]) -> Data {
        var ints = [Int16]()
        ints.reserveCapacity(pieces.reduce(0) { $0 + $1.count })
        for p in pieces {
            for x in p { ints.append(Int16(clamping: Int((max(-1, min(1, x.isFinite ? x : 0)) * 32_767).rounded()))) }
        }
        return ints.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    static func floats(_ data: Data) -> [Float] {
        data.withUnsafeBytes { raw in raw.bindMemory(to: Int16.self).map { Float($0) / 32_767 } }
    }

    /// `from` into `to`'s place (replacing it).
    static func place(_ from: URL, at to: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
        if fm.fileExists(atPath: to.path) { try fm.removeItem(at: to) }
        try fm.moveItem(at: from, to: to)
    }

    static func size(_ url: URL) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.intValue ?? 0
    }
}

// MARK: - Nephis

final class ChapterAudioRenderer: @unchecked Sendable {
    private let chapter: NarrationController.Chapter
    private let items: [NarrationController.ScriptItem]
    private let novelKey: String
    private let voice: NarrationVoiceKey
    private let delivery: ChapterDirector.Delivery
    private let bestOfTwo: Bool
    private let work: URL
    private let readRate: Int
    private let sentences: [NephisCallPlan.Sentence]
    let textHash: String
    private let quotes: QuoteRouter.SingleQuotes
    private let finisher: NaturalFinisher
    private var checkpoint: RenderCheckpoint
    /// Her next call starts a fresh read (the chapter's start, a resume, after a retry or another user of her engine).
    private var reset = true
    /// ExpressiveService.flowSequence after this renderer's last call.
    private var ownSequence = -1
    /// The call (its first sentence) made again once for her studio or dialogue pack; a failed call tried again once.
    private var retriedAt: Int?
    private var failedAt: Int?
    private var stopReason: String?
    private var restItem: DispatchWorkItem?
    private var inFlight = false
    private var completion: ((Result<ChapterAudioOutput, Error>) -> Void)?
    private let io = DispatchQueue(label: "app.tachinovel.audio-writer", qos: .utility)
    /// A chunk or checkpoint that couldn't be written (io queue only).
    private let writeError = Box<String?>(nil)
    private let log = Logger(subsystem: "app.tachinovel", category: "audio")

    /// Asked between calls: a reason to stop now (live reading, heat, cancelled…).
    var shouldStop: (() -> String?)?
    var onProgress: ((ChapterAudioProgress) -> Void)?

    init(chapter: NarrationController.Chapter, items: [NarrationController.ScriptItem], novelKey: String, voice: NarrationVoiceKey,
         delivery: ChapterDirector.Delivery, bestOfTwo: Bool) {
        self.chapter = chapter
        self.items = items
        self.novelKey = novelKey
        self.voice = voice
        self.delivery = delivery
        self.bestOfTwo = bestOfTwo
        work = NarrationAudioStore.shared.workFolder(novelKey: novelKey, chapterPath: chapter.chapterPath)
        let rate = SessionRate.forRead(.pocketTts)
        readRate = rate
        let d = VoiceSettings.shared.prefs.delivery
        let count = items.count
        let list = items.indices.map { k -> NephisCallPlan.Sentence in
            let read = NephisRenderPipeline.read(at: k, count: count, natural: { items[$0].natural }, moods: delivery.moods, delivery: d, allMoods: true)
            return NephisRenderPipeline.sentence(items[k], read: read, senses: delivery.senses[k] ?? [:])
        }
        sentences = list
        let hash = NarrationAudioHash.fnv(list.map { s in
            [s.say, s.raw ?? "", s.read ?? "", String(format: "%.3f", s.pauseAfter), s.handoverAfter ?? "",
             s.senses.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ",")].joined(separator: "\u{1}")
        }.joined(separator: "\u{2}"))
        textHash = hash
        quotes = NephisCallPlan.quoteStyle(items.map(\.text))
        finisher = NaturalFinisher(NephisRenderPipeline.finish(rate: rate, seed: 1))
        checkpoint = RenderCheckpoint(novelKey: novelKey, chapterPath: chapter.chapterPath, voice: voice.text, textHash: hash,
                                      sampleRate: rate, sentences: count)
    }

    func start(_ completion: @escaping (Result<ChapterAudioOutput, Error>) -> Void) {
        self.completion = completion
        let fm = FileManager.default
        try? fm.createDirectory(at: work, withIntermediateDirectories: true)
        let saved = (try? Data(contentsOf: work.appendingPathComponent("checkpoint.json"))).flatMap { try? JSONDecoder().decode(RenderCheckpoint.self, from: $0) }
        if var cp = saved, cp.matches(voice: voice.text, textHash: textHash, sampleRate: readRate, sentences: items.count) {
            let dropped = cp.rollBackToParagraph()
            checkpoint = cp
            log.notice("audio: \(self.chapter.chapterPath, privacy: .public) goes on at sentence \(cp.next) of \(self.items.count)")
            let w = work
            io.async { for c in dropped { try? FileManager.default.removeItem(at: w.appendingPathComponent(c.file)) } }
        } else {
            // Another voice, text or rate (or none yet): the chunks of an earlier render go; the chapter's text and delivery stay.
            for name in (try? fm.contentsOfDirectory(atPath: work.path)) ?? [] where name.hasPrefix("call-") || name == "checkpoint.json" {
                try? fm.removeItem(at: work.appendingPathComponent(name))
            }
        }
        saveCheckpoint()
        report("rendering")
        step()
    }

    /// Stop after the call in progress (at once while waiting); the work stays for the next run.
    func stop(_ reason: String) {
        stopReason = reason
        guard let item = restItem else { return }
        item.cancel()
        restItem = nil
        step()
    }

    private func report(_ step: String) {
        let done = checkpoint.next
        onProgress?(ChapterAudioProgress(sentence: done, sentences: items.count, calls: checkpoint.calls.count, seconds: checkpoint.seconds, step: step))
    }

    private func step() {
        guard completion != nil, !inFlight, restItem == nil else { return }
        if let why = stopReason ?? shouldStop?() { return finish(.failure(DriveError.interrupted(why))) }
        if let e = writeError.value { return finish(.failure(DriveError.failed("Couldn't save the audio: \(e)"))) }
        if checkpoint.done { return finalize() }
        // Something else read with her engine since this renderer's last call (Listen, a test): her read goes on from the
        // last paragraph this chapter finished, afresh.
        if ownSequence >= 0, ExpressiveService.shared.flowSequence != ownSequence { rollBack() }
        let i = checkpoint.next
        let count = sentences.count
        let members = NephisCallPlan.group(from: i, count: count, limit: NephisCallPlan.callLimit) { self.sentences[$0] }
        guard !members.isEmpty else { return finalize() }
        var call = NephisCallPlan.call(members: members, count: count, at: { self.sentences[$0] },
                                       context: NephisCallPlan.Context(reset: reset, dialogue: ExpressiveService.shared.nephisDialogue,
                                                                       singleQuotes: quotes),
                                       spoken: NephisRenderPipeline.spoken)
        NephisCallPlan.download(&call.line, bestOfTwo: bestOfTwo)
        inFlight = true
        let letters = members.map { sentences[$0].say.count }
        NephisRenderPipeline.run(call.line, letters: letters, speed: 1, readRate: readRate, finisher: finisher) { [weak self] result in
            self?.callDone(members, result)
        }
        ownSequence = ExpressiveService.shared.flowSequence
    }

    private func callDone(_ members: [Int], _ result: Result<NephisRenderPipeline.CallAudio, Error>) {
        inFlight = false
        guard completion != nil, let first = members.first, let last = members.last else { return }
        switch result {
        case .success(let audio):
            failedAt = nil
            let complete = audio.complete(studioRead: readRate != SessionRate.standard, dialogue: ExpressiveService.shared.nephisDialogue)
            if !complete, retriedAt != first, Self.passing(audio.report) {
                // Her studio or dialogue pack was still loading (or short of memory): this paragraph again in a moment.
                retriedAt = first
                log.notice("audio: call at sentence \(first) made without her studio or dialogue pack; again from its paragraph")
                rollBack()
                return wait(20)
            }
            if !complete { checkpoint.incomplete += 1 }
            let file = String(format: "call-%05d.pcm", first)
            let ends = last == sentences.count - 1 || sentences[last].pauseAfter >= NephisCallPlan.paragraphPause
            checkpoint.calls.append(RenderCheckpoint.Call(first: first, count: members.count, frames: audio.pieces.map(\.count), endsParagraph: ends,
                                                          file: file, complete: complete, renderMs: audio.renderMs))
            reset = false
            let pieces = audio.pieces
            let url = work.appendingPathComponent(file)
            let errors = writeError
            io.async {
                do { try ChapterAudioFiles.pcm16(pieces).write(to: url, options: .atomic) } catch { errors.value = error.localizedDescription }
            }
            saveCheckpoint()
            report("rendering")
            DispatchQueue.main.async { [weak self] in self?.step() }
        case .failure(let error):
            rollBack()
            // Released for memory, or the studio test runs: wait for her (not a failed chapter).
            if let block = ExpressiveService.shared.loadBlock {
                var seconds = 10.0
                if case .resting(let left) = block { seconds = Double(left) + 1 }
                return wait(seconds)
            }
            guard failedAt != first else {
                return finish(.failure(DriveError.failed("Nephis couldn't read a paragraph (\(error.localizedDescription))")))
            }
            failedAt = first
            report("waiting")
            ExpressiveService.shared.ensureLoaded(.pocketTts) { [weak self] _ in
                ExpressiveService.shared.whenSettled { self?.step() }
            }
        }
    }

    /// A call made without her studio or dialogue pack for a passing reason (loading, memory): worth making again.
    private static func passing(_ r: NephisFlowSynth.Report?) -> Bool {
        guard let r else { return false }
        var reasons: [String] = []
        if r.studioRead, !r.studioUsed { reasons.append(r.bypassReason ?? "") }
        if let note = r.dialogueNote { reasons.append(note) }
        return reasons.contains { $0.hasPrefix("loading") || $0.hasPrefix("memory") || $0.isEmpty }
    }

    /// Back to the last call that ended a paragraph; her next call starts afresh there.
    private func rollBack() {
        let dropped = checkpoint.rollBackToParagraph()
        reset = true
        ownSequence = -1
        guard !dropped.isEmpty else { return saveCheckpoint() }
        let w = work
        io.async { for c in dropped { try? FileManager.default.removeItem(at: w.appendingPathComponent(c.file)) } }
        saveCheckpoint()
    }

    private func wait(_ seconds: Double) {
        report("waiting")
        let item = DispatchWorkItem { [weak self] in
            self?.restItem = nil
            self?.step()
        }
        restItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    }

    private func saveCheckpoint() {
        let cp = checkpoint
        let url = work.appendingPathComponent("checkpoint.json")
        let errors = writeError
        io.async {
            do { try JSONEncoder().encode(cp).write(to: url, options: .atomic) } catch { errors.value = error.localizedDescription }
        }
    }

    /// One pass over the chunks into AAC, the manifest beside it, both into the novel's folder; the work folder goes.
    private func finalize() {
        report("encoding")
        let cp = checkpoint
        let times = cp.times()
        guard times.count == items.count else { return finish(.failure(DriveError.failed("The chapter's audio doesn't match its sentences"))) }
        let segments = zip(items, times).map { it, t in
            NarrationTiming.Segment(id: it.id, block: it.block, start: it.start, end: it.end, t0: t.t0, t1: t.t1, hash: it.hash, paragraph: it.paragraph)
        }
        let duration = cp.seconds
        let timing = NarrationTiming(segments: segments, duration: duration, nextChapterPath: chapter.nextPath, nextTitle: chapter.nextName,
                                     prevChapterPath: chapter.prevPath, prevTitle: chapter.prevName)
        let dir = NarrationAudioIndex.folder(novelKey: novelKey)
        let stem = NarrationAudioIndex.stem(chapterPath: chapter.chapterPath)
        let source = NarrationTiming.Source(pluginId: chapter.pluginId, novelPath: chapter.novelPath, chapterPath: chapter.chapterPath,
                                            title: chapter.chapterName, voice: voice.text, audioFile: "\(stem).m4a")
        let renderSeconds = cp.calls.reduce(0) { $0 + $1.renderMs } / 1000
        // Developer › Voice extras off renders one take whatever Best of 2 says (NephisCallPlan.extras, in synthesizeFlow).
        let extras = VoiceSettings.shared.prefs.delivery.extras
        let render: [String: Any] = [
            "voiceKey": voice.text, "renderer": NarrationVoiceKey.rendererVersion, "sampleRate": readRate,
            "bitRate": ChapterAudioFiles.bitRate(sampleRate: readRate), "takes": bestOfTwo && extras ? 2 : 1, "calls": cp.calls.count,
            "incomplete": cp.incomplete, "renderSeconds": (renderSeconds * 10).rounded() / 10, "textHash": textHash, "delivery": delivery.json,
        ]
        let manifest = timing.manifestJSON(source: source, sampleRate: readRate, engine: ("nephis", "Pocket TTS (FluidAudio Core ML) + her studio"),
                                           render: render)
        let rate = readRate
        let w = work
        let root = NarrationAudioStore.shared.folder
        let count = items.count
        let incomplete = cp.incomplete
        let deliver = MainBound({ [weak self] (result: Result<ChapterAudioOutput, Error>) in self?.finish(result) })
        io.async {
            let tmp = w.appendingPathComponent("chapter.m4a")
            try? FileManager.default.removeItem(at: tmp)
            do {
                guard let format = AVAudioFormat(standardFormatWithSampleRate: Double(rate), channels: 1) else { throw DriveError.failed("no audio format") }
                do {
                    let file = try AVAudioFile(forWriting: tmp, settings: ChapterAudioFiles.settings(sampleRate: rate), commonFormat: .pcmFormatFloat32,
                                               interleaved: false)
                    for c in cp.calls {
                        let data = try Data(contentsOf: w.appendingPathComponent(c.file))
                        if let buf = ChapterAudioFiles.buffer(ChapterAudioFiles.floats(data), format: format) { try file.write(from: buf) }
                    }
                }  // the file closes (finishes) here
                let audioRel = "\(dir)/\(stem).m4a"
                let manifestRel = "\(dir)/\(stem).json"
                let tmpManifest = w.appendingPathComponent("chapter.json")
                try manifest.write(to: tmpManifest, options: .atomic)
                let bytes = ChapterAudioFiles.size(tmp)
                try ChapterAudioFiles.place(tmp, at: root.appendingPathComponent(audioRel))
                try ChapterAudioFiles.place(tmpManifest, at: root.appendingPathComponent(manifestRel))
                try? FileManager.default.removeItem(at: w)
                let out = ChapterAudioOutput(audioFile: audioRel, manifestFile: manifestRel, bytes: bytes, durationMs: duration * 1000, sentences: count,
                                             renderSeconds: renderSeconds, incomplete: incomplete)
                DispatchQueue.main.async { deliver.value(.success(out)) }
            } catch {
                let message = error.localizedDescription
                DispatchQueue.main.async { deliver.value(.failure(DriveError.failed("Couldn't write the audio file: \(message)"))) }
            }
        }
    }

    private func finish(_ result: Result<ChapterAudioOutput, Error>) {
        restItem?.cancel()
        restItem = nil
        guard let done = completion else { return }
        completion = nil
        if case .failure = result { saveCheckpoint() }
        done(result)
    }
}

// MARK: - Kokoro

/// The backup voice's chapter: Kokoro sentence by sentence (narrator mode's voices, pacing and polish, as live), 24 kHz,
/// 32 kbps. Not resumable (Kokoro is fast). Main thread; files on a serial queue.
final class KokoroChapterRenderer: @unchecked Sendable {
    private let chapter: NarrationController.Chapter
    private let items: [NarrationController.ScriptItem]
    private let novelKey: String
    private let voice: String
    private let key: NarrationVoiceKey
    private let narrator: NarratorSettings
    private var polish: NarrationPolish?
    private let work: URL
    private let io = DispatchQueue(label: "app.tachinovel.kokoro-writer")
    private let format = AVAudioFormat(standardFormatWithSampleRate: Double(SessionRate.standard), channels: 1)
    private var file: AVAudioFile?
    private let writeError = Box<String?>(nil)
    private var frames = 0
    private var segments: [NarrationTiming.Segment] = []
    private var loudness = LoudnessMatcher()
    private var next = 0
    private var retried = false
    private var stopReason: String?
    private var completion: ((Result<ChapterAudioOutput, Error>) -> Void)?
    private let started = Date()

    var shouldStop: (() -> String?)?
    var onProgress: ((ChapterAudioProgress) -> Void)?

    init(chapter: NarrationController.Chapter, items: [NarrationController.ScriptItem], novelKey: String, voice: String, key: NarrationVoiceKey,
         narrator: NarratorSettings) {
        self.chapter = chapter
        self.items = items
        self.novelKey = novelKey
        self.voice = voice
        self.key = key
        self.narrator = narrator
        polish = narrator.usesPolish ? NarrationPolish(sampleRate: 24_000, roomTone: narrator.usesRoomTone, compressorRatio: narrator.compressorRatio) : nil
        work = NarrationAudioStore.shared.workFolder(novelKey: novelKey, chapterPath: chapter.chapterPath)
    }

    func start(_ completion: @escaping (Result<ChapterAudioOutput, Error>) -> Void) {
        self.completion = completion
        let tmp = work.appendingPathComponent("chapter.m4a")
        let w = work
        let errors = writeError
        io.async {
            try? FileManager.default.createDirectory(at: w, withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: tmp)
            do {
                let f = try AVAudioFile(forWriting: tmp, settings: ChapterAudioFiles.settings(sampleRate: SessionRate.standard),
                                        commonFormat: .pcmFormatFloat32, interleaved: false)
                let made = MainBound(f)
                DispatchQueue.main.async { [weak self] in
                    self?.file = made.value
                    self?.step()
                }
            } catch {
                errors.value = error.localizedDescription
                DispatchQueue.main.async { [weak self] in self?.step() }
            }
        }
    }

    func stop(_ reason: String) { stopReason = reason }

    private func step() {
        if let e = writeError.value { return finish(.failure(DriveError.failed("Couldn't write the audio: \(e)"))) }
        if let why = stopReason ?? shouldStop?() { return finish(.failure(DriveError.interrupted(why))) }
        guard next < items.count else { return finalize() }
        let item = items[next]
        let sentence = item.narrator
        let speed = NarratorPlan.rate(1, for: sentence, settings: narrator)
        let prefs = VoiceSettings.shared.prefs
        let handle: (Result<KokoroAudio, Error>) -> Void = { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let audio):
                self.append(item, audio)
                self.retried = false
                self.next += 1
                self.onProgress?(ChapterAudioProgress(sentence: self.next, sentences: self.items.count, calls: self.next,
                                                      seconds: Double(self.frames) / Double(SessionRate.standard), step: "rendering"))
                self.step()
            case .failure(let error):
                // One retry (a reload after a memory warning, a transient error); then the chapter fails.
                guard !self.retried else { return self.finish(.failure(DriveError.failed("Kokoro couldn't read a sentence: \(error.localizedDescription)"))) }
                self.retried = true
                KokoroService.shared.ensureLoaded { _ in self.step() }
            }
        }
        if let parts = NarratorPlan.parts(for: sentence, settings: narrator, resolve: { prefs.engineVoice($0) }) {
            KokoroService.shared.synthesize(parts: parts, voice: voice, speed: speed, completion: handle)
        } else {
            KokoroService.shared.synthesize(text: item.text, runs: item.runs, voice: voice, speed: speed, completion: handle)
        }
    }

    private func append(_ item: NarrationController.ScriptItem, _ audio: KokoroAudio) {
        let pause = NarratorPlan.pause(for: item.narrator, settings: narrator)
        var out: [Float]
        if var p = polish, p.sampleRate == audio.sampleRate {
            out = p.prepareSentence(audio.samples, pause: pause)
            polish = p
        } else {
            out = PCM.prepareSentence(audio.samples, sampleRate: audio.sampleRate, pause: pause, loudness: &loudness)
        }
        var speech = max(0, out.count - PCM.silenceFrames(seconds: pause, sampleRate: audio.sampleRate))
        if audio.sampleRate != SessionRate.standard {
            guard audio.sampleRate > 0, let converted = SessionRate.resample(out, from: audio.sampleRate, to: SessionRate.standard) else {
                writeError.value = "Kokoro's \(audio.sampleRate) Hz audio couldn't be converted"
                return
            }
            speech = Int((Double(speech) * Double(SessionRate.standard) / Double(audio.sampleRate)).rounded())
            out = converted
        }
        let sr = Double(SessionRate.standard)
        let t0 = Double(frames) / sr
        segments.append(NarrationTiming.Segment(id: item.id, block: item.block, start: item.start, end: item.end,
                                                t0: t0, t1: t0 + Double(speech) / sr, hash: item.hash, paragraph: item.paragraph))
        frames += out.count
        guard let format, let buf = ChapterAudioFiles.buffer(out, format: format) else { return }
        let made = MainBound(file)
        let errors = writeError
        let carried = MainBound(buf)
        io.async {
            guard errors.value == nil, let f = made.value else { return }
            do { try f.write(from: carried.value) } catch { errors.value = error.localizedDescription }
        }
    }

    private func finalize() {
        let duration = Double(frames) / Double(SessionRate.standard)
        let timing = NarrationTiming(segments: segments, duration: duration, nextChapterPath: chapter.nextPath, nextTitle: chapter.nextName,
                                     prevChapterPath: chapter.prevPath, prevTitle: chapter.prevName)
        let dir = NarrationAudioIndex.folder(novelKey: novelKey)
        let stem = NarrationAudioIndex.stem(chapterPath: chapter.chapterPath)
        let source = NarrationTiming.Source(pluginId: chapter.pluginId, novelPath: chapter.novelPath, chapterPath: chapter.chapterPath,
                                            title: chapter.chapterName, voice: key.text, audioFile: "\(stem).m4a")
        let manifest = timing.manifestJSON(source: source, render: ["voiceKey": key.text, "renderer": NarrationVoiceKey.rendererVersion])
        let w = work
        let root = NarrationAudioStore.shared.folder
        let count = items.count
        let seconds = Date().timeIntervalSince(started)
        let errors = writeError
        let deliver = MainBound({ [weak self] (result: Result<ChapterAudioOutput, Error>) in self?.finish(result) })
        file = nil
        io.async {
            if let e = errors.value {
                return DispatchQueue.main.async { deliver.value(.failure(DriveError.failed("Couldn't write the audio: \(e)"))) }
            }
            do {
                let tmp = w.appendingPathComponent("chapter.m4a")
                let tmpManifest = w.appendingPathComponent("chapter.json")
                try manifest.write(to: tmpManifest, options: .atomic)
                let bytes = ChapterAudioFiles.size(tmp)
                let audioRel = "\(dir)/\(stem).m4a"
                let manifestRel = "\(dir)/\(stem).json"
                try ChapterAudioFiles.place(tmp, at: root.appendingPathComponent(audioRel))
                try ChapterAudioFiles.place(tmpManifest, at: root.appendingPathComponent(manifestRel))
                try? FileManager.default.removeItem(at: w)
                let out = ChapterAudioOutput(audioFile: audioRel, manifestFile: manifestRel, bytes: bytes, durationMs: duration * 1000, sentences: count,
                                             renderSeconds: seconds, incomplete: 0)
                DispatchQueue.main.async { deliver.value(.success(out)) }
            } catch {
                let message = error.localizedDescription
                DispatchQueue.main.async { deliver.value(.failure(DriveError.failed("Couldn't write the audio file: \(message)"))) }
            }
        }
    }

    private func finish(_ result: Result<ChapterAudioOutput, Error>) {
        guard let done = completion else { return }
        completion = nil
        if case .failure = result {
            // The half-written file goes; the chapter's saved text stays for the next try.
            file = nil
            let tmp = work.appendingPathComponent("chapter.m4a")
            io.async { try? FileManager.default.removeItem(at: tmp) }
        }
        done(result)
    }
}
