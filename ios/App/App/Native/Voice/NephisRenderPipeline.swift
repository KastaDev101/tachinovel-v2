//
//  NephisRenderPipeline.swift — her one render pipeline (audio downloads part 1, 2026-10-16): the chain Listen plays,
//  the Voice speed test measures and audio downloads write, so a downloaded chapter sounds exactly like Listen.
//
//    1. the call        NephisCallPlan (ExpressiveCore): which sentences, the line (director's text, heteronyms with the
//                       director's senses, raw text, temperature, pause before, handover, fresh or continued read, her
//                       dialogue pack's quote routing) — `sentence` maps Listen's segments and a chapter's script to it;
//    2. her engine      ExpressiveService.synthesizeFlow (her studio, de-wind, studio EQ, closeness, breath air, room,
//                       floor guard, the dialogue pack's finishing);
//    3. her EQ          a call made without her studio in a studio read gets her Mimi EQ at 24 kHz (`preEQ`), then the
//                       read's rate (SessionRate);
//    4. the finish      NaturalFinish's flow path (`unit`): the thump filter and soft limit (unless mastered), the
//                       listener's speed, and the cut into one piece per sentence (the sentence highlighting's times).
//  Listen keeps its scheduler around steps 2–4 (HybridSpeechEngine.pumpRender/renderedGroup call `preEQ` and `unit`);
//  downloads and the hand-off warm start run the whole call with `run`. What a download leaves out is the player's own
//  stage: "Voice volume" and its limiter (volume stays a playback control).
//
//  Also here: the AI director's answers shared by Listen and downloads (DirectorStore), and the director worked out for
//  a whole chapter before it is rendered (ChapterDirector), stored with the audio.
//

import ExpressiveCore
import ExpressiveEngines
import Foundation
import HDVoiceCore

enum NephisRenderPipeline {
    enum Failure: Error, LocalizedError {
        case empty
        var errorDescription: String? { "her voice gave no audio" }
    }

    // MARK: - 1. The call

    /// Listen's speech segment as her calls see it (HybridSpeechEngine: the director's text, raw form, temperature, pause).
    static func sentence(_ seg: SpeechSegment, read: String?, chapterStart: Bool, senses: [String: String]) -> NephisCallPlan.Sentence {
        let n = seg.natural
        return NephisCallPlan.Sentence(text: seg.kokoroText, say: n?.params.say ?? seg.kokoroText, raw: n?.params.raw,
                                       temperature: n?.params.temperature ?? 0.7, read: read, pauseAfter: seg.naturalPause ?? seg.pauseAfter,
                                       handoverAfter: n?.handover, chapterStart: chapterStart, senses: senses)
    }

    /// A chapter's script sentence as her calls see it, at 1× (a download is rendered at normal speed; speed is the
    /// player's): the same fields as `sentence` gives for the segment NarrationController would make of it.
    static func sentence(_ item: NarrationController.ScriptItem, read: String?, senses: [String: String]) -> NephisCallPlan.Sentence {
        let n = item.natural
        let pause = max(0, min(5, (item.naturalMs ?? item.relaxedMs ?? item.pauseMs) / 1000))
        return NephisCallPlan.Sentence(text: item.text, say: n?.params.say ?? item.text, raw: n?.params.raw,
                                       temperature: n?.params.temperature ?? 0.7, read: read, pauseAfter: n != nil ? pause : max(0, item.pauseMs) / 1000,
                                       handoverAfter: n?.handover, senses: senses)
    }

    /// The text she is given for a sentence: heteronyms said in their sense, the director's senses where the rules guessed.
    static func spoken(_ text: String, _ senses: [String: String]) -> String {
        Heteronyms.pocketText(text, overrides: senses)
    }

    /// Her read for sentence `i` (nil = the calm narrator): the director's mood when it read the sentence, else the
    /// script's; then the settings (Mood voices). Listen and downloads both.
    static func read(at i: Int, count: Int, natural: (Int) -> NaturalSentence?, moods: [Int: String], delivery d: DeliverySettings,
                     allMoods: Bool) -> String? {
        guard i >= 0, i < count else { return nil }
        let n = natural(i)
        var voice = n?.voice
        if d.usesAI, case .some(let r) = SceneMood.read(at: i, moods: moods, speaks: { j in j >= 0 && j < count && natural(j)?.speaks == true },
                                                         system: { j in j >= 0 && j < count && natural(j)?.system == true }, allMoods: allMoods) {
            voice = r
        }
        return d.read(voice, speaks: n?.speaks ?? false)
    }

    // MARK: - 3. Her EQ and the read's rate

    /// Her Mimi sound without the studio, in her studio's read (a call made before her studio loaded, or that it skipped):
    /// natural delivery adds no EQ at 44.1 kHz, so it gets hers here, at 24 kHz where it was tuned (in place).
    /// `tilt`: HybridSpeechEngine.nephisTilt, read on the main thread (her installed pack's top lift).
    static func preEQ(_ samples: inout [Float], sampleRate: Int, readRate: Int, mastered: Bool, toned: Bool, tilt: VoiceTilt) {
        guard readRate != SessionRate.standard, sampleRate == NaturalFinish.mimiRate, !mastered, !toned else { return }
        tilt.apply(&samples, sampleRate: sampleRate)
    }

    // MARK: - 4. The finish

    /// Her NaturalFinish at the read's rate: no breaths, her own sound, her EQ on Mimi's 24 kHz stream only (Listen's).
    static func finish(rate: Int, seed: UInt64) -> NaturalFinish {
        let studioRead = rate != SessionRate.standard
        return NaturalFinish(audio: DeliveryAudio(), studioSound: VoiceSettings.shared.prefs.delivery.studioSound, breaths: nil, sampleRate: rate,
                             seed: seed, tilt: studioRead ? nil : HybridSpeechEngine.nephisTilt, plain: true)
    }

    /// One flow call's audio for the finish: one piece per sentence (`letters` place the cuts), at `speed`.
    static func unit(samples: [Float], letters: [Int], speed: Double, mastered: Bool, toned: Bool) -> NaturalFinish.Unit {
        unit(samples: samples, lines: letters.map { NaturalFinish.Line(params: nil, letters: $0, pause: 0) }, speed: speed, mastered: mastered, toned: toned)
    }

    static func unit(samples: [Float], lines: [NaturalFinish.Line], speed: Double, mastered: Bool, toned: Bool) -> NaturalFinish.Unit {
        var u = NaturalFinish.Unit(samples: samples, lines: lines, speed: speed, expressive: true)
        u.flow = true
        u.mastered = mastered
        u.toned = toned
        return u
    }

    // MARK: - The whole call

    struct CallAudio {
        /// One piece per sentence of the call, at `rate`.
        var pieces: [[Float]]
        var rate: Int
        var report: NephisFlowSynth.Report?
        /// From the call's start to its finished audio.
        var renderMs: Double

        var seconds: Double { Double(pieces.reduce(0) { $0 + $1.count }) / Double(max(1, rate)) }
        /// Her studio and dialogue pack were there as the read expects them (`studioRead`: the read is at her studio's
        /// rate; `dialogue`: her dialogue pack is installed).
        func complete(studioRead: Bool, dialogue: Bool) -> Bool {
            guard let r = report else { return true }
            if studioRead, !r.studioUsed { return false }
            if dialogue, r.dialogueNote != nil { return false }
            return true
        }
    }

    /// One call from its line to finished sentence audio at `readRate` (downloads, the hand-off warm start). `prepared`
    /// (main) when its latents are ready (the next call may start); `completion` (main) with the pieces.
    static func run(_ line: ExpressiveLine, letters: [Int], speed: Double, readRate: Int, finisher: NaturalFinisher,
                    prepared: @escaping () -> Void = {}, completion: @escaping (Result<CallAudio, Error>) -> Void) {
        let t0 = Date()
        let report = Box<NephisFlowSynth.Report?>(nil)
        ExpressiveService.shared.synthesizeFlow(line, prepared: prepared, reported: { report.value = $0 }, completion: { result in
            let a: ExpressiveAudio
            switch result {
            case .failure(let error): return completion(.failure(error))
            case .success(let made): a = made
            }
            guard !a.samples.isEmpty, a.sampleRate > 0 else { return completion(.failure(NephisRenderPipeline.Failure.empty)) }
            let deliver = MainBound(completion)
            let made = MainBound(a)
            let tilt = HybridSpeechEngine.nephisTilt
            SessionRate.queue.async {
                let a = made.value
                var samples = a.samples
                NephisRenderPipeline.preEQ(&samples, sampleRate: a.sampleRate, readRate: readRate, mastered: a.mastered, toned: a.toned, tilt: tilt)
                let converted = SessionRate.resample(samples, from: a.sampleRate, to: readRate)
                DispatchQueue.main.async {
                    guard let converted else {
                        return deliver.value(.failure(SessionRate.ConversionFailed(from: a.sampleRate, to: readRate)))
                    }
                    finisher.render(NephisRenderPipeline.unit(samples: converted, letters: letters, speed: speed, mastered: a.mastered, toned: a.toned)) { pieces in
                        var out = pieces.map(\.frames)
                        // The cut gives one piece per line; a short answer keeps the count (an empty piece is a sentence
                        // without audio of its own: its time is the piece before's end).
                        while out.count < letters.count { out.append([]) }
                        deliver.value(.success(CallAudio(pieces: out, rate: readRate, report: report.value,
                                                          renderMs: Date().timeIntervalSince(t0) * 1000)))
                    }
                }
            }
        })
    }
}

// MARK: - The AI director, shared

/// The AI director's answers (moods, senses, chapter briefs), shared by Listen and audio downloads: a chapter the
/// downloader worked out is read live with the same moods (a fallback mid-chapter, the next chapter). Main thread.
final class DirectorStore: @unchecked Sendable {
    static let shared = DirectorStore()
    var cache = DirectorCache()

    /// A chapter's delivery stored with its audio (`ChapterDirector.Delivery.json`), for its sentences `texts`: each
    /// answer is used only where the sentence is the same one it was given for.
    func seed(_ delivery: [String: Any], texts: [String]) {
        let hashes = delivery["h"] as? [String] ?? []
        guard hashes.count == texts.count else { return }
        let ok = { (i: Int) in i >= 0 && i < texts.count && hashes[i] == NarrationAudioHash.fnv(texts[i]) }
        let before = { (i: Int) -> String? in i > 0 ? texts[i - 1] : nil }
        for (k, v) in delivery["moods"] as? [String: String] ?? [:] {
            guard let i = Int(k), ok(i) else { continue }
            cache.store(mood: v, text: texts[i], before: before(i))
        }
        for (k, v) in delivery["senses"] as? [String: [String: String]] ?? [:] {
            guard let i = Int(k), ok(i) else { continue }
            cache.store(senses: v, text: texts[i], before: before(i))
        }
        if let brief = delivery["brief"] as? String, !texts.isEmpty {
            cache.store(brief: brief, end: DirectorCache.chapterEnd(texts), sentences: texts.count)
        }
    }
}

/// The director for a whole chapter before it is rendered (audio downloads): the brief, every window's moods and the
/// homographs' senses, asked of the on-device model one at a time (or taken from DirectorStore where Listen or an earlier
/// render already asked), kept in DirectorStore and stored with the audio. Without Apple Intelligence: the script's
/// reads (`ai` false). Main thread.
enum ChapterDirector {
    struct Delivery: Equatable {
        var ai = false
        var brief: String?
        var moods: [Int: String] = [:]
        var senses: [Int: [String: String]] = [:]
        /// The sentences' text hashes (what each answer was given for).
        var hashes: [String] = []

        var json: [String: Any] {
            var out: [String: Any] = ["ai": ai, "h": hashes,
                                      "moods": Dictionary(uniqueKeysWithValues: moods.map { (String($0.key), $0.value) }),
                                      "senses": Dictionary(uniqueKeysWithValues: senses.map { (String($0.key), $0.value) })]
            if let brief { out["brief"] = brief }
            return out
        }

        init() {}

        init?(json: [String: Any]) {
            guard let h = json["h"] as? [String] else { return nil }
            ai = json["ai"] as? Bool ?? false
            brief = json["brief"] as? String
            hashes = h
            for (k, v) in json["moods"] as? [String: String] ?? [:] { if let i = Int(k) { moods[i] = v } }
            for (k, v) in json["senses"] as? [String: [String: String]] ?? [:] { if let i = Int(k) { senses[i] = v } }
        }
    }

    /// Works out `items`' delivery; `stop` is asked between model calls (a reason ends it early: the render waits).
    static func run(_ items: [NarrationController.ScriptItem], stop: @escaping () -> Bool, completion: @escaping (Delivery?) -> Void) {
        var out = Delivery()
        out.hashes = items.map { NarrationAudioHash.fnv($0.text) }
        let d = VoiceSettings.shared.prefs.delivery
        guard d.usesAI, SceneReader.shared.available, !items.isEmpty else { return completion(out) }
        out.ai = true
        let texts = items.map(\.text)
        let sentences = items.map { it -> SceneReader.Sentence in
            let kind: SceneReader.Sentence.Kind = it.natural?.system == true ? .system : it.natural?.speaks == true ? .spoken : .narration
            return SceneReader.Sentence(text: it.text, kind: kind)
        }
        let before = { (i: Int) -> String? in i > 0 ? texts[i - 1] : nil }
        let end = DirectorCache.chapterEnd(texts)
        let store = DirectorStore.shared
        let state = Box(out)

        func senses(_ range: Range<Int>, then: @escaping () -> Void) {
            var asks: [(index: Int, text: String, before: String)] = []
            for i in range {
                if let known = store.cache.senses(texts[i], before: before(i)) {
                    if !known.isEmpty { state.value.senses[i] = known }
                } else {
                    asks.append((index: i, text: texts[i], before: before(i) ?? ""))
                }
            }
            guard !asks.isEmpty else { return then() }
            SceneReader.shared.senses(asks) { answers in
                for (i, a) in answers where i >= 0 && i < texts.count {
                    state.value.senses[i] = a
                    store.cache.store(senses: a, text: texts[i], before: before(i))
                }
                then()
            }
        }

        // Windows of SceneReader's size, in order; then the senses of each window.
        func window(_ start: Int) {
            guard !stop() else { return completion(nil) }
            guard start < items.count else { return completion(state.value) }
            let stopAt = min(items.count, start + HybridSpeechEngine.sceneWindow)
            let range = start..<stopAt
            let kept = range.map { store.cache.mood(texts[$0], before: before($0)) }
            let next = { senses(range) { window(stopAt) } }
            if kept.allSatisfy({ $0.map { SceneMood.moods.contains($0) } ?? false }) {
                for (k, m) in kept.enumerated() { state.value.moods[start + k] = m }
                return next()
            }
            let context = Array(sentences[max(0, start - HybridSpeechEngine.sceneContext)..<start])
            SceneReader.shared.read(context: context, window: Array(sentences[range]), brief: state.value.brief,
                                    part: start / SceneReader.briefPart + 1) { moods in
                for (k, m) in (moods ?? []).enumerated() where SceneMood.moods.contains(m) && start + k < stopAt {
                    state.value.moods[start + k] = m
                    store.cache.store(mood: m, text: texts[start + k], before: before(start + k))
                }
                next()
            }
        }

        if let kept = store.cache.brief(end: end, sentences: items.count) {
            state.value.brief = kept.text
            return window(0)
        }
        SceneReader.shared.brief(sentences) { b in
            state.value.brief = b
            if let b { store.cache.store(brief: b, end: end, sentences: items.count) }
            window(0)
        }
    }
}
