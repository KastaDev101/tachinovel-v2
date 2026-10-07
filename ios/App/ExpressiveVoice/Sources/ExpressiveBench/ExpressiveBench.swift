//
//  expressive-bench — benchmark ONE experimental expressive engine on a Mac (CI: workflow
//  .github/workflows/expressive-bench.yml, macOS runner, a rough proxy for the iPhone).
//
//  1. Downloads the engine's pinned model files with the app's own downloader (ModelStore: pinned
//     revision, SHA-256 per file), then turns FluidAudio's own downloader off.
//  2. Loads the model cold (first load: Core ML compiles it for this machine), renders every fixture line
//     (tools/expressive-fixtures.ts = the Voice Lab's samples) with a fixed seed per line, then unloads,
//     reloads warm and renders the first line again.
//  3. Measures: load (cold/warm), time to first audio, per-line synthesis time and × real time, memory
//     (phys_footprint before / loaded / max while rendering / after unload, peak resident size), and checks
//     the audio (sample rate, NaN/Inf, clipping, RMS). Writes report.json and one WAV per line (the ASR round
//     trip and the listening samples).
//  Each engine runs in its own process (ci/expressive-bench.sh), so a crash in one doesn't hide the others.
//
//  Usage: expressive-bench --engine <chatterbox-nano|neutts-2e|pocket-tts> --fixtures <json> --out <dir>
//                          [--budget-seconds 900]
//

import Darwin
import ExpressiveCore
import ExpressiveEngines
import Foundation
import Metal

struct FixtureLine: Decodable {
    let id: String
    let sample: String
    let text: String
    let plain: String
    let emotion: String
    let style: String?
    let role: String
}

struct FixtureFile: Decodable {
    let lines: [FixtureLine]
}

/// Progress printing from the downloader's (concurrent) callback: once per new tenth.
final class PrintedDecile: @unchecked Sendable {
    private let lock = NSLock()
    private var last = -1

    func advance(to decile: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard decile > last else { return false }
        last = decile
        return true
    }
}

struct BenchFailure: Error, CustomStringConvertible {
    let description: String
}

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

func taskInfo() -> task_vm_info_data_t? {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return kr == KERN_SUCCESS ? info : nil
}

/// Physical footprint (what iOS's jetsam counts), MB.
func footprintMB() -> Double {
    taskInfo().map { Double($0.phys_footprint) / 1_048_576 } ?? -1
}

func residentPeakMB() -> Double {
    taskInfo().map { Double($0.resident_size_peak) / 1_048_576 } ?? -1
}

func sysctlString(_ name: String) -> String {
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return "?" }
    var buf = [CChar](repeating: 0, count: size)
    guard sysctlbyname(name, &buf, &size, nil, 0) == 0 else { return "?" }
    return String(cString: buf)
}

func wav16(_ samples: [Float], sampleRate: Int) -> Data {
    var d = Data()
    d.reserveCapacity(44 + samples.count * 2)
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    let bytes = UInt32(samples.count * 2)
    d.append(contentsOf: Array("RIFF".utf8))
    u32(36 + bytes)
    d.append(contentsOf: Array("WAVEfmt ".utf8))
    u32(16)
    u16(1)
    u16(1)
    u32(UInt32(sampleRate))
    u32(UInt32(sampleRate * 2))
    u16(2)
    u16(16)
    d.append(contentsOf: Array("data".utf8))
    u32(bytes)
    for s in samples {
        let c = s.isFinite ? max(-1, min(1, s)) : 0
        u16(UInt16(bitPattern: Int16(c * 32767)))
    }
    return d
}

func r1(_ x: Double) -> Double { (x * 10).rounded() / 10 }
func r3(_ x: Double) -> Double { (x * 1000).rounded() / 1000 }

func percentile(_ xs: [Double], _ p: Double) -> Double {
    let s = xs.sorted()
    guard !s.isEmpty else { return 0 }
    return s[Int((Double(s.count - 1) * p).rounded())]
}

@main
struct ExpressiveBench {
    static func main() async {
        do {
            try await run()
        } catch {
            print("::error::expressive-bench: \(error)")
            exit(1)
        }
    }

    static func run() async throws {
        guard let engineArg = arg("--engine"), let engine = ExpressiveEngineID(rawValue: engineArg), let pinned = engine.pinned else {
            throw BenchFailure(description: "--engine must be one of \(ExpressiveEngineID.allCases.map(\.rawValue))")
        }
        let fixturesURL = URL(fileURLWithPath: arg("--fixtures") ?? ".cache/expressive-fixtures.json")
        let out = URL(fileURLWithPath: arg("--out") ?? ".cache/expressive-bench").appendingPathComponent(engine.rawValue)
        let budget = Double(arg("--budget-seconds") ?? "900") ?? 900
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let fixtures = try JSONDecoder().decode(FixtureFile.self, from: Data(contentsOf: fixturesURL)).lines
        guard !fixtures.isEmpty else { throw BenchFailure(description: "no fixture lines") }

        var report: [String: Any] = [
            "engine": engine.rawValue,
            "title": engine.title,
            "repo": pinned.repo,
            "revision": pinned.revision,
            "license": pinned.license,
            "modelBytes": pinned.totalBytes,
            "device": [
                "model": sysctlString("hw.model"),
                "cpu": sysctlString("machdep.cpu.brand_string"),
                "cores": ProcessInfo.processInfo.activeProcessorCount,
                "memoryGB": r1(Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824),
                "os": ProcessInfo.processInfo.operatingSystemVersionString,
                "metal": MTLCreateSystemDefaultDevice()?.name ?? "none",
            ] as [String: Any],
        ]
        var problems: [String] = []
        let writeReport = {
            report["problems"] = problems
            let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: out.appendingPathComponent("report.json"))
        }

        // 1. Download (pinned, verified) with the app's downloader.
        let store = ModelStore(root: try ExpressiveEngines.modelsRoot())
        let tDownload = Date()
        let lastPrinted = PrintedDecile()
        try await store.install(pinned, wifiOnly: false) { p in
            let decile = Int(p.fraction * 10)
            if lastPrinted.advance(to: decile) || p.filesDone == p.filesTotal {
                print("download \(engine.rawValue): \(Int(p.fraction * 100))% (\(p.filesDone)/\(p.filesTotal) files)")
            }
        }
        report["downloadSeconds"] = r1(Date().timeIntervalSince(tDownload))
        guard store.isInstalled(pinned) else { throw BenchFailure(description: "model not installed after download") }
        ExpressiveEngines.setOfflineMode(true)

        guard let synth = ExpressiveEngines.make(engine) else {
            problems.append("\(engine.title) needs macOS 15 / iOS 18")
            try writeReport()
            throw BenchFailure(description: "unsupported OS")
        }

        // 2. Cold load + every fixture line.
        let memBefore = footprintMB()
        let loadMs: Double
        do {
            loadMs = try await synth.load()
        } catch {
            problems.append("load failed: \(error.localizedDescription)")
            try writeReport()
            throw error
        }
        let memLoaded = footprintMB()
        print(String(format: "load (cold): %.0f ms, memory %.0f → %.0f MB", loadMs, memBefore, memLoaded))

        var rows: [[String: Any]] = []
        var xs: [Double] = []
        var totalAudio = 0.0
        var totalSynth = 0.0
        var memMax = memLoaded
        var firstLine: (firstAudioMs: Double, synthMs: Double)?
        let tRender = Date()
        for (i, line) in fixtures.enumerated() {
            if Date().timeIntervalSince(tRender) > budget {
                problems.append("time budget (\(Int(budget)) s) reached after \(i) of \(fixtures.count) lines")
                break
            }
            let input = ExpressiveLine(text: line.text, emotion: line.emotion, style: line.style, role: line.role)
            let audio: ExpressiveAudio
            do {
                audio = try await synth.synthesize(input, seed: UInt64(42 + i))
            } catch {
                problems.append("\(line.id): synthesis failed: \(error.localizedDescription)")
                continue
            }
            if firstLine == nil { firstLine = (audio.firstAudioMs, audio.synthMs) }
            let s = audio.samples
            let nonFinite = s.filter { !$0.isFinite }.count
            let clipped = s.filter { abs($0) >= 0.999 }.count
            var acc = 0.0
            for v in s where v.isFinite { acc += Double(v) * Double(v) }
            let rms = s.isEmpty ? 0 : (acc / Double(s.count)).squareRoot()
            if audio.sampleRate != 24_000 { problems.append("\(line.id): sample rate \(audio.sampleRate)") }
            if s.isEmpty { problems.append("\(line.id): no audio") }
            if nonFinite > 0 { problems.append("\(line.id): \(nonFinite) NaN/Inf samples") }
            if Double(clipped) > Double(s.count) * 0.001 { problems.append("\(line.id): \(clipped) clipped samples") }
            if rms < 0.005 { problems.append("\(line.id): nearly silent (RMS \(r3(rms)))") }
            try wav16(s, sampleRate: audio.sampleRate).write(to: out.appendingPathComponent("\(line.id).wav"))
            memMax = max(memMax, footprintMB())
            xs.append(audio.timesRealtime)
            totalAudio += audio.durationMs
            totalSynth += audio.synthMs
            rows.append([
                "id": line.id, "sample": line.sample, "emotion": line.emotion, "style": line.style ?? NSNull(), "role": line.role,
                "chars": line.plain.count, "chunks": audio.chunks, "synthMs": r1(audio.synthMs), "firstAudioMs": r1(audio.firstAudioMs),
                "audioMs": r1(audio.durationMs), "x": r3(audio.timesRealtime), "rms": r3(rms), "clipped": clipped, "nonFinite": nonFinite,
            ])
            print(String(format: "%-12@ %4d chars  synth %6.0f ms  first %6.0f ms  audio %5.2f s  %5.2f× RT  rms %.3f",
                         line.id, line.plain.count, audio.synthMs, audio.firstAudioMs, audio.durationMs / 1000, audio.timesRealtime, rms))
        }

        // 3. Warm reload (Core ML's compiled cache) + the first line again.
        await synth.unload()
        let memUnloaded = footprintMB()
        var warm: [String: Any] = [:]
        do {
            let warmLoad = try await synth.load()
            if let line = fixtures.first {
                let a = try await synth.synthesize(ExpressiveLine(text: line.text, emotion: line.emotion, style: line.style, role: line.role), seed: 42)
                warm = ["loadMs": r1(warmLoad), "firstAudioMs": r1(a.firstAudioMs), "synthMs": r1(a.synthMs), "x": r3(a.timesRealtime)]
            }
        } catch {
            problems.append("warm reload failed: \(error.localizedDescription)")
        }
        await synth.unload()

        report["loadMs"] = r1(loadMs)
        if let f = firstLine {
            report["firstLine"] = ["firstAudioMs": r1(f.firstAudioMs), "synthMs": r1(f.synthMs), "coldStartToFirstAudioMs": r1(loadMs + f.firstAudioMs)]
        } else {
            report["firstLine"] = NSNull()
        }
        report["warm"] = warm
        report["lines"] = rows
        report["linesTotal"] = fixtures.count
        report["aggregateX"] = r3(totalSynth > 0 ? totalAudio / totalSynth : 0)
        report["p50X"] = r3(percentile(xs, 0.5))
        report["p10X"] = r3(percentile(xs, 0.1))
        report["minX"] = r3(xs.min() ?? 0)
        report["audioSeconds"] = r1(totalAudio / 1000)
        report["memoryMB"] = ["before": r1(memBefore), "loaded": r1(memLoaded), "maxWhileRendering": r1(memMax),
                              "afterUnload": r1(memUnloaded), "residentPeak": r1(residentPeakMB())]
        try writeReport()
        print(String(format: "%@: %d/%d lines, aggregate %.2f× real time (p50 %.2f×, p10 %.2f×), load %.0f ms, memory max %.0f MB, %d problems",
                     engine.title, rows.count, fixtures.count, report["aggregateX"] as? Double ?? 0, percentile(xs, 0.5), percentile(xs, 0.1),
                     loadMs, memMax, problems.count))
        if rows.isEmpty { throw BenchFailure(description: "no line rendered") }
    }
}
