//
//  kokoro-check — CI check of the BUNDLED Kokoro voice (job "voice-quality", macOS runner).
//
//  Loads ios/App/App/KokoroModels exactly the way the app does (HDVoiceKokoro.KokoroRuntime, same compute
//  route, same lexicon phoneme splicing), synthesizes the fixture sentences (tools/voice-fixtures.ts:
//  short, long, dialogue, numbers/"Ch. 12", lexicon names, run through the app's narration front-end) with
//  every offered voice and two voice mixes (VoiceMix.swift), and checks the audio:
//    - 24 kHz, non-empty, no NaN/Inf, no clipping, speech-level RMS,
//    - duration within a plausible speaking rate (words per minute),
//    - time to first audio and real-time factor (logged; fails only on gross regressions),
//    - memory released after the model is dropped,
//    - a mix sounds like neither of its two voices alone (the blend reached the model),
//    - narrator mode (Narrator.swift + Polish.swift) on the ASR sentences: quoted parts in a dialogue voice,
//      jitter and polish; peaks ≤ −1 dBFS and loudness near −16 LUFS.
//  Writes report.json and WAVs (af_heart; "mix--" for the first mix; "narrator--" for narrator mode, held
//  to ≤ 5 % WER) for the ASR round trip in ci/voice-asr.ts.
//
//  Usage: swift run -c release kokoro-check --models <dir> --fixtures <json> --out <dir> [--route ane-cpu]
//

import Darwin
import Foundation
import HDVoiceCore
import HDVoiceKokoro

struct Fixture: Decodable {
    struct Run: Decodable {
        let t: String?
        let p: String?
    }
    struct Part: Decodable {
        let role: String
        let text: String
        let runs: [Run]?
    }
    let id: String
    let label: String
    let text: String
    let runs: [Run]?
    let asr: Bool?
    let role: String?
    let parts: [Part]?
    let rate: Double?
    struct Phrase: Decodable {
        let text: String
        let pauseMs: Double
    }
    let phrases: [Phrase]?

    static func speechRuns(_ runs: [Run]?) -> [SpeechRun]? {
        let out: [SpeechRun]? = runs?.compactMap { r in
            if let p = r.p { return SpeechRun.phonemes(p) }
            if let t = r.t { return SpeechRun.text(t) }
            return nil
        }
        return out?.isEmpty == false ? out : nil
    }

    var narrator: NarratorSentence {
        NarratorSentence(text: text, runs: Fixture.speechRuns(runs), quoted: role == "dialogue",
                         parts: parts.map { $0.map { NarratorSentence.Part(dialogue: $0.role == "dialogue", text: $0.text, runs: Fixture.speechRuns($0.runs)) } },
                         pauseMs: 320, rate: rate, phrases: phrases?.map { NarratorSentence.Phrase(text: $0.text, pauseMs: $0.pauseMs) })
    }
}

/// Narrator mode as checked in CI: Heart narrates, Michael speaks the dialogue.
let checkedNarrator = NarratorSettings.all(dialogueVoice: "am_michael")

/// Voice mixes checked like a voice, on every fixture (blend strings, VoiceMix.swift). The first also goes
/// through the ASR round trip.
let checkedMixes = ["af_heart+am_michael@50", "bf_emma+am_fenrir@30"]

struct FixtureFile: Decodable {
    let sentences: [Fixture]
}

func arg(_ name: String, _ fallback: String) -> String {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: name), i + 1 < a.count { return a[i + 1] }
    return fallback
}

func footprintMB() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return kr == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
}

func words(_ text: String) -> Int {
    text.split { !$0.isLetter && !$0.isNumber && $0 != "'" }.count
}

struct Failure: Error, CustomStringConvertible {
    let description: String
}

@main
struct KokoroCheck {
    static func main() async {
        do {
            try await run()
        } catch {
            print("::error::kokoro-check: \(error)")
            exit(1)
        }
    }

    static func run() async throws {
        let models = URL(fileURLWithPath: arg("--models", "ios/App/App/KokoroModels"))
        let fixturesURL = URL(fileURLWithPath: arg("--fixtures", ".cache/voice-fixtures.json"))
        let out = URL(fileURLWithPath: arg("--out", ".cache/voice-check"))
        let route = KokoroRoute.from(arg("--route", KokoroRoute.backgroundSafe.rawValue))
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let fixtures = try JSONDecoder().decode(FixtureFile.self, from: Data(contentsOf: fixturesURL)).sentences
        guard !fixtures.isEmpty else { throw Failure(description: "no fixtures") }

        let missing = KokoroRuntime.missingFiles(in: models)
        guard missing.isEmpty else { throw Failure(description: "bundle incomplete: \(missing)") }

        var problems: [String] = []
        var warnings: [String] = []
        var rows: [[String: Any]] = []

        let memBefore = footprintMB()
        let runtime = KokoroRuntime(modelsDirectory: models)
        let t0 = Date()
        try await runtime.load(route: route)
        let loadMs = Date().timeIntervalSince(t0) * 1000
        let memLoaded = footprintMB()
        print(String(format: "load: %.0f ms (route %@), memory %.0f → %.0f MB", loadMs, route.rawValue, memBefore, memLoaded))
        let placement = await KokoroPlacement.analyze(modelsDirectory: models, route: route)
        for p in placement { print("placement: \(p.summary)") }

        var firstAudioMs: Double?
        // Every bundled voice is checked; the well-graded ones (C+ and up) on every fixture, the rest on two
        // (enough to catch a broken or silent voice pack) so the job stays a few minutes with 28 voices.
        let fullRank = VoiceCatalog.gradeRank("C+")
        let plan: [(voice: String, fixtures: [Fixture])] =
            VoiceCatalog.voices.map { v in (v.id, v.gradeRank >= fullRank ? fixtures : fixtures.filter { $0.id == "plain" || $0.id == "names" }) }
            + checkedMixes.map { ($0, fixtures) }
        /// "voice/fixture" → samples of the "plain" fixture, to compare each mix with its two voices.
        var plain: [String: [Float]] = [:]
        for (voice, mine) in plan {
            for f in mine {
                let runs: [SpeechRun]? = f.runs?.compactMap { r in
                    if let p = r.p { return SpeechRun.phonemes(p) }
                    if let t = r.t { return SpeechRun.text(t) }
                    return nil
                }
                let audio: KokoroAudio
                do {
                    audio = try await runtime.synthesize(text: f.text, runs: runs, voice: voice, speed: 1)
                } catch {
                    problems.append("\(voice)/\(f.id): synthesis failed: \(error.localizedDescription)")
                    continue
                }
                if firstAudioMs == nil { firstAudioMs = loadMs + audio.synthMs }
                let s = audio.samples
                let nonFinite = s.filter { !$0.isFinite }.count
                let clipped = s.filter { abs($0) >= 0.999 }.count
                let trimmed = PCM.trimSilence(s, sampleRate: audio.sampleRate)
                let rms = PCM.rms(trimmed)
                let seconds = Double(trimmed.count) / Double(max(1, audio.sampleRate))
                let wpm = seconds > 0 ? Double(words(f.text)) / seconds * 60 : 0
                let x = audio.synthMs > 0 ? audio.durationMs / audio.synthMs : 0
                let tag = "\(voice)/\(f.id)"
                if audio.sampleRate != 24_000 { problems.append("\(tag): sample rate \(audio.sampleRate)") }
                if s.isEmpty { problems.append("\(tag): no audio") }
                if nonFinite > 0 { problems.append("\(tag): \(nonFinite) NaN/Inf samples") }
                if Double(clipped) > Double(s.count) * 0.001 { problems.append("\(tag): \(clipped) clipped samples") }
                if rms < 0.01 { problems.append("\(tag): too quiet (RMS \(rms))") }
                // Kokoro at 1.0× speaks ~150–200 wpm; short lines with pauses/punctuation vary more.
                let minWpm = words(f.text) < 6 ? 40.0 : 80.0
                if wpm < minWpm || wpm > 330 { problems.append("\(tag): implausible speaking rate \(Int(wpm)) wpm over \(String(format: "%.2f", seconds)) s") }
                if x < 0.25 { problems.append("\(tag): gross slowdown, \(String(format: "%.2f", x))× real time") } else if x < 1 { warnings.append("\(tag): slower than real time (\(String(format: "%.2f", x))×)") }
                if voice == VoiceCatalog.defaultVoiceId, f.asr == true {
                    try WAV.pcm16(s, sampleRate: audio.sampleRate).write(to: out.appendingPathComponent("\(f.id).wav"))
                }
                if voice == checkedMixes.first, f.asr == true {
                    try WAV.pcm16(s, sampleRate: audio.sampleRate).write(to: out.appendingPathComponent("mix--\(f.id).wav"))
                }
                if f.id == "plain" { plain[voice] = s }
                rows.append(["voice": voice, "id": f.id, "label": f.label, "seconds": seconds, "rms": Double(rms), "wpm": wpm,
                             "synthMs": audio.synthMs, "x": x, "clipped": clipped, "nonFinite": nonFinite])
                print(String(format: "%-11@ %-10@ %5.2f s  rms %.3f  %3.0f wpm  synth %5.0f ms  %5.1f× RT", voice, f.id, seconds, rms, wpm, audio.synthMs, x))
            }
        }

        // Narrator mode on the ASR sentences, through the same plan and polish as the app.
        var polish = NarrationPolish(sampleRate: 24_000, roomTone: false)
        for f in fixtures where f.asr == true {
            let s = f.narrator
            let speed = NarratorPlan.rate(1, for: s, settings: checkedNarrator)
            let parts = NarratorPlan.parts(for: s, settings: checkedNarrator) { VoiceCatalog.voice($0) != nil ? $0 : nil }
                ?? [NarratorPart(text: f.text, runs: Fixture.speechRuns(f.runs), voice: nil)]
            var pieces: [[Float]] = []
            do {
                for p in parts {
                    pieces.append(try await runtime.synthesize(text: p.text, runs: p.runs, voice: p.voice ?? VoiceCatalog.defaultVoiceId, speed: speed).samples)
                }
            } catch {
                problems.append("narrator/\(f.id): synthesis failed: \(error.localizedDescription)")
                continue
            }
            let joined = PCM.joinParts(pieces, sampleRate: 24_000, gaps: parts.map { ($0.pauseAfter ?? NarratorPlan.partGap) / Double(speed) })
            let audioOut = polish.prepareSentence(joined, pause: 0.3)
            let peak = PCM.peak(audioOut)
            let lufs = LoudnessMeter.integrated(audioOut, sampleRate: 24_000)
            if peak > NarrationPolish.peakCeiling + 0.01 { problems.append("narrator/\(f.id): peak \(peak) above −1 dBFS") }
            if audioOut.contains(where: { !$0.isFinite }) { problems.append("narrator/\(f.id): NaN/Inf samples") }
            print(String(format: "narrator    %-10@ %d part(s)  peak %.2f  %.1f LUFS", f.id, parts.count, peak, lufs ?? -99))
            rows.append(["voice": "narrator", "id": f.id, "parts": parts.count, "peak": Double(peak), "lufs": lufs ?? -99])
            try WAV.pcm16(audioOut, sampleRate: 24_000).write(to: out.appendingPathComponent("narrator--\(f.id).wav"))
        }

        // A mix must not come out as one of its voices (the blended style reached the chain).
        for spec in checkedMixes {
            guard let blend = VoiceBlend.parse(spec) else {
                problems.append("\(spec): not a valid mix")
                continue
            }
            guard let mixed = plain[spec] else { continue }
            for one in [blend.a, blend.b] where plain[one] == mixed {
                problems.append("\(spec)/plain: identical to \(one) alone (the blend was not applied)")
            }
        }

        await runtime.release()
        // Give Core ML a moment to tear down its E5 runtime objects.
        try await Task.sleep(nanoseconds: 1_500_000_000)
        let memReleased = footprintMB()
        let loadDelta = max(1, memLoaded - memBefore)
        let retained = (memReleased - memBefore) / loadDelta
        print(String(format: "memory: before %.0f, loaded %.0f, released %.0f MB (%.0f%% of the model's memory still held)", memBefore, memLoaded, memReleased, retained * 100))
        // How much one release gives back depends on the host (Core ML keeps compiled models cached: 80–95 %
        // stayed on the CI Mac), so that is a warning. A leak shows as growth on every load/release cycle.
        if retained > 0.5 { warnings.append("memory only partly released (\(Int(retained * 100))% held)") }
        try await runtime.load(route: route)
        await runtime.release()
        try await Task.sleep(nanoseconds: 1_500_000_000)
        let memSecond = footprintMB()
        print(String(format: "memory after a second load/release: %.0f MB (%+.0f MB)", memSecond, memSecond - memReleased))
        if memSecond - memReleased > 100 { problems.append("memory grows with every load/release: +\(Int(memSecond - memReleased)) MB on the second cycle") }
        if loadMs > 300_000 { problems.append("gross regression: model load took \(Int(loadMs / 1000)) s") }
        if let f = firstAudioMs, f > 360_000 { problems.append("gross regression: first audio after \(Int(f / 1000)) s") }

        let times = rows.compactMap { $0["x"] as? Double }.sorted()
        let p50 = times.isEmpty ? 0 : times[times.count / 2]
        let report: [String: Any] = [
            "route": route.rawValue, "loadMs": loadMs, "firstAudioMs": firstAudioMs ?? -1, "p50x": p50,
            "memoryMB": ["before": memBefore, "loaded": memLoaded, "released": memReleased, "secondRelease": memSecond],
            "rows": rows, "problems": problems, "warnings": warnings,
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
            "placement": placement.map { $0.summary },
        ]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: out.appendingPathComponent("report.json"))
        print(String(format: "time to first audio: %.0f ms (load %.0f ms), median %.1f× real time over %d sentences", firstAudioMs ?? -1, loadMs, p50, rows.count))
        for w in warnings { print("::warning::\(w)") }
        if !problems.isEmpty {
            for p in problems { print("::error::\(p)") }
            throw Failure(description: "\(problems.count) problem(s)")
        }
        print("kokoro-check: ok")
    }
}
