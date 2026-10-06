//
//  kokoro-check — CI check of the BUNDLED Kokoro voice (job "voice-quality", macOS runner).
//
//  Loads ios/App/App/KokoroModels exactly the way the app does (HDVoiceKokoro.KokoroRuntime, same compute
//  route, same lexicon phoneme splicing), synthesizes the fixture sentences (tools/voice-fixtures.ts:
//  short, long, dialogue, numbers/"Ch. 12", lexicon names, run through the app's narration front-end) with
//  every offered voice, and checks the audio:
//    - 24 kHz, non-empty, no NaN/Inf, no clipping, speech-level RMS,
//    - duration within a plausible speaking rate (words per minute),
//    - time to first audio and real-time factor (logged; fails only on gross regressions),
//    - memory released after the model is dropped.
//  Writes report.json and WAVs (af_heart, for the ASR round trip in ci/voice-asr.ts).
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
    let id: String
    let label: String
    let text: String
    let runs: [Run]?
    let asr: Bool?
}

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
        for voice in VoiceCatalog.ids {
            for f in fixtures {
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
                rows.append(["voice": voice, "id": f.id, "label": f.label, "seconds": seconds, "rms": Double(rms), "wpm": wpm,
                             "synthMs": audio.synthMs, "x": x, "clipped": clipped, "nonFinite": nonFinite])
                print(String(format: "%-11@ %-10@ %5.2f s  rms %.3f  %3.0f wpm  synth %5.0f ms  %5.1f× RT", voice, f.id, seconds, rms, wpm, audio.synthMs, x))
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
