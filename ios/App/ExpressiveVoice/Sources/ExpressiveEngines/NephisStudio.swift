//
//  NephisStudio.swift — the PC "studio" that makes Nephis sound like her, on the phone (2026-10-11, scaffold; off
//  unless a model pack ships it). After Pocket writes the sketch (32-dim latents, 12.5 Hz) and Mimi decodes it to
//  24 kHz, the studio turns that into her 44.1 kHz recording:
//    1. resample the 24 kHz decode to 44.1 kHz;
//    2. NephisBlueprint (Core ML, one call per decoded call): PCM + the sketch spread over the mel frames
//       -> her log-mel (128 bands, hop 512). Its own receptive field is ~0.65 s, so it sees the whole call;
//    3. NephisVocoder (Core ML, BigVGAN fine-tuned on her): fixed windows of `window_frames` mel frames, keeping the
//       middle `chunk_frames` (context on both sides), so the stream matches a one-piece render (PC: 35 dB SNR,
//       the difference sits at the very ends, not at the chunk joins).
//  The models and studio.json live in a model pack: `<pack>/Models/nephis-studio/` (NephisBlueprint.mlpackage or
//  .mlmodelc, NephisVocoder.mlpackage or .mlmodelc, studio.json), exported by tachinovel-tts-lab
//  finetune/wsl/studio_port.py. Packages are compiled once on the device and cached next to them.
//

@preconcurrency import AVFoundation
import CoreML
import Foundation

public actor NephisStudio {
    public struct Config: Decodable, Sendable {
        public let sample_rate: Int
        public let hop: Int
        public let n_mels: Int
        public let chunk_frames: Int
        public let context_frames: Int
        public let window_frames: Int
        public let keep_from_sample: Int
        public let keep_to_sample: Int
        public let z_dims: Int
        /// Which vocoder package to load (NephisVocoder8 = int8 weights, half the size, same sound on the PC check).
        public let vocoder_model: String?
        /// "ane" = CPU + Neural Engine (coolest per operation), "gpu" = CPU + GPU, anything else = all units.
        public let compute_units: String?
    }

    /// Timing of the last render (Voice Lab).
    public struct Report: Sendable {
        public var resampleMs = 0.0
        public var blueprintMs = 0.0
        public var vocoderMs = 0.0
        /// Time spent deliberately resting between vocoder windows to cool the phone (not compute).
        public var restMs = 0.0
        public var audioMs = 0.0
        /// The phone was too hot: Mimi's own sound (resampled) was used instead of the studio.
        public var bypassed = false
        public var thermal = 0
        public var timesRealTime: Double { audioMs / max(1, resampleMs + blueprintMs + vocoderMs + restMs) }
    }

    /// Heat policy (quality first, then speed, then heat): the studio runs at full speed while the phone is cool,
    /// rests between vocoder windows when it warms up (same sound, lower power), and steps aside when it is hot
    /// (Mimi's sound, resampled, so the stream stays 44.1 kHz and nothing breaks). The caller can force a bypass
    /// when playback has little audio buffered (speed beats polish then).
    public struct HeatPolicy: Sendable {
        /// Rest after each window, as a share of that window's compute time, by thermal state.
        public var restShareFair = 0.35
        public var restShareSerious = 1.0
        /// From this state on, bypass the studio.
        public var bypassFrom: ProcessInfo.ThermalState = .critical
        public init() {}
    }

    public enum StudioError: Error { case missing(String), badOutput(String) }

    public static let inputRate = 24_000
    public nonisolated let config: Config
    private let blueprint: MLModel
    private let vocoder: MLModel
    public private(set) var lastReport = Report()

    /// The studio in `<dir>` (a pack's Models/nephis-studio), or nil when the pack doesn't ship one.
    public static func load(from dir: URL, computeUnits: MLComputeUnits? = nil) async throws -> NephisStudio? {
        let fm = FileManager.default
        let cfgURL = dir.appendingPathComponent("studio.json")
        guard fm.fileExists(atPath: cfgURL.path) else { return nil }
        let config = try JSONDecoder().decode(Config.self, from: Data(contentsOf: cfgURL))
        let mc = MLModelConfiguration()
        switch config.compute_units {
        case "ane": mc.computeUnits = .cpuAndNeuralEngine
        case "gpu": mc.computeUnits = .cpuAndGPU
        default: mc.computeUnits = .all
        }
        if let computeUnits { mc.computeUnits = computeUnits }
        let bp = try MLModel(contentsOf: try await compiled("NephisBlueprint", in: dir), configuration: mc)
        // The int8 package when the pack ships it (same sound, half the memory traffic), else the fp16 one.
        let name = config.vocoder_model.flatMap { fm.fileExists(atPath: dir.appendingPathComponent("\($0).mlpackage").path)
            || fm.fileExists(atPath: dir.appendingPathComponent("\($0).mlmodelc").path) ? $0 : nil } ?? "NephisVocoder"
        let vc = try MLModel(contentsOf: try await compiled(name, in: dir), configuration: mc)
        return NephisStudio(config: config, blueprint: bp, vocoder: vc)
    }

    public var heat = HeatPolicy()
    public func setHeatPolicy(_ p: HeatPolicy) { heat = p }

    init(config: Config, blueprint: MLModel, vocoder: MLModel) {
        self.config = config
        self.blueprint = blueprint
        self.vocoder = vocoder
    }

    /// `<name>.mlmodelc` in `dir`, compiling `<name>.mlpackage` once (cached next to it) when only that ships.
    static func compiled(_ name: String, in dir: URL) async throws -> URL {
        let fm = FileManager.default
        let compiledURL = dir.appendingPathComponent("\(name).mlmodelc")
        if fm.fileExists(atPath: compiledURL.path) { return compiledURL }
        let package = dir.appendingPathComponent("\(name).mlpackage")
        guard fm.fileExists(atPath: package.path) else { throw StudioError.missing(name) }
        let tmp = try await MLModel.compileModel(at: package)
        try? fm.removeItem(at: compiledURL)
        try fm.moveItem(at: tmp, to: compiledURL)
        return compiledURL
    }

    /// One decoded call: Mimi's 24 kHz audio and the latents it was decoded from -> her 44.1 kHz audio.
    /// `hurry`: playback has little buffered; skip the studio for this call (Mimi's sound at 44.1 kHz).
    public func render(pcm24: [Float], latents: [[Float]], hurry: Bool = false) async throws -> [Float] {
        guard !pcm24.isEmpty, !latents.isEmpty else { return [] }
        var report = Report()
        let thermal = ProcessInfo.processInfo.thermalState
        report.thermal = thermal.rawValue
        var t0 = Date()
        // The model's own 11.5 kHz low-pass makes the result independent of this resampler's filter.
        let pcm = try Self.resample(pcm24, from: Self.inputRate, to: config.sample_rate)
        report.resampleMs = Date().timeIntervalSince(t0) * 1000
        let hop = config.hop
        if hurry || thermal.rawValue >= heat.bypassFrom.rawValue || pcm.count < 2048 {
            report.bypassed = true
            report.audioMs = Double(pcm.count) * 1000 / Double(config.sample_rate)
            lastReport = report
            return pcm
        }

        // Mel frame count exactly as the model computes it (reflect pad (n_fft - hop) / 2 each side, n_fft 2048).
        let frames = (pcm.count - hop) / hop + 1

        t0 = Date()
        let mel = try blueprintMel(pcm: pcm, latents: latents, frames: frames)
        report.blueprintMs = Date().timeIntervalSince(t0) * 1000

        let out = try await vocode(mel: mel, frames: frames, report: &report)
        report.audioMs = Double(out.count) * 1000 / Double(config.sample_rate)
        lastReport = report
        return out
    }

    // MARK: - Steps

    private func blueprintMel(pcm: [Float], latents: [[Float]], frames: Int) throws -> MLMultiArray {
        let x = try MLMultiArray(shape: [1, 1, NSNumber(value: pcm.count)], dataType: .float32)
        pcm.withUnsafeBufferPointer { src in
            x.dataPointer.assumingMemoryBound(to: Float.self).update(from: src.baseAddress!, count: pcm.count)
        }
        let zf = Self.latentsPerFrame(latents, frames: frames, dims: config.z_dims)
        let z = try MLMultiArray(shape: [1, NSNumber(value: config.z_dims), NSNumber(value: frames)], dataType: .float32)
        zf.withUnsafeBufferPointer { src in
            z.dataPointer.assumingMemoryBound(to: Float.self).update(from: src.baseAddress!, count: zf.count)
        }
        let input = try MLDictionaryFeatureProvider(dictionary: ["pcm44": x, "z_frames": z])
        guard let mel = try blueprint.prediction(from: input).featureValue(for: "mel")?.multiArrayValue else {
            throw StudioError.badOutput("mel")
        }
        return mel
    }

    private func vocode(mel: MLMultiArray, frames: Int, report: inout Report) async throws -> [Float] {
        let bands = config.n_mels, chunk = config.chunk_frames, ctx = config.context_frames, win = config.window_frames
        let melValues = Self.floats(mel)  // [bands][frames], row-major
        let stride = melValues.count / bands
        var out: [Float] = []
        out.reserveCapacity(frames * config.hop)
        var start = 0
        while start < frames {
            let w0 = Date()
            let w = try MLMultiArray(shape: [1, NSNumber(value: bands), NSNumber(value: win)], dataType: .float32)
            let wp = w.dataPointer.assumingMemoryBound(to: Float.self)
            for b in 0..<bands {
                for j in 0..<win {  // replicate the edge frames past both ends (the PC test did the same)
                    let f = min(max(start - ctx + j, 0), frames - 1)
                    wp[b * win + j] = melValues[b * stride + f]
                }
            }
            let input = try MLDictionaryFeatureProvider(dictionary: ["mel": w])
            guard let pcm = try await vocoder.prediction(from: input).featureValue(for: "pcm44")?.multiArrayValue else {
                throw StudioError.badOutput("pcm44")
            }
            let samples = Self.floats(pcm)
            let keep = samples[min(config.keep_from_sample, samples.count)..<min(config.keep_to_sample, samples.count)]
            out.append(contentsOf: keep)
            start += chunk
            report.vocoderMs += Date().timeIntervalSince(w0) * 1000
            // Cooling rest: same sound, lower average power while the phone is warm.
            let share: Double
            switch ProcessInfo.processInfo.thermalState {
            case .fair: share = heat.restShareFair
            case .serious, .critical: share = heat.restShareSerious
            default: share = 0
            }
            if share > 0, start < frames {
                let rest = Date().timeIntervalSince(w0) * share
                report.restMs += rest * 1000
                try await Task.sleep(nanoseconds: UInt64(rest * 1e9))
            }
        }
        return Array(out.prefix(frames * config.hop))
    }

    // MARK: - Where it runs (Voice Lab)

    /// How many of each model's operations Core ML places on the Neural Engine, GPU and CPU (iOS 17.4+): the map for
    /// speed and heat work (BigVGAN's Snake activation uses sin, which may not run on the Neural Engine; every hop
    /// between chips costs time). Keys like "vocoder.ane"; empty on older systems.
    public static func placement(in dir: URL) async -> [String: Int] {
        guard #available(iOS 17.4, macOS 14.4, *) else { return [:] }
        var out: [String: Int] = [:]
        let fm = FileManager.default
        let cfg = (try? Data(contentsOf: dir.appendingPathComponent("studio.json"))).flatMap { try? JSONDecoder().decode(Config.self, from: $0) }
        let mc = MLModelConfiguration()
        mc.computeUnits = cfg?.compute_units == "ane" ? .cpuAndNeuralEngine : cfg?.compute_units == "gpu" ? .cpuAndGPU : .all
        let vocoderName = cfg?.vocoder_model.flatMap { fm.fileExists(atPath: dir.appendingPathComponent("\($0).mlmodelc").path) ? $0 : nil } ?? "NephisVocoder"
        for (key, name) in [("blueprint", "NephisBlueprint"), ("vocoder", vocoderName)] {
            let url = dir.appendingPathComponent("\(name).mlmodelc")
            guard fm.fileExists(atPath: url.path), let plan = try? await MLComputePlan.load(contentsOf: url, configuration: mc),
                  case .program(let program) = plan.modelStructure, let main = program.functions["main"] else { continue }
            for op in main.block.operations {
                guard let usage = plan.deviceUsage(for: op) else { continue }
                switch usage.preferred {
                case .neuralEngine: out["\(key).ane", default: 0] += 1
                case .gpu: out["\(key).gpu", default: 0] += 1
                case .cpu: out["\(key).cpu", default: 0] += 1
                @unknown default: out["\(key).other", default: 0] += 1
                }
            }
        }
        return out
    }

    // MARK: - Helpers (pure, mirrored by studio_port.py)

    /// Latents (12.5 Hz) spread over the mel frames: linear, align_corners = false, exactly the blueprint's own
    /// F.interpolate in training. Returns [dims][frames] row-major.
    public static func latentsPerFrame(_ latents: [[Float]], frames: Int, dims: Int) -> [Float] {
        let n = latents.count
        var out = [Float](repeating: 0, count: dims * frames)
        let scale = Double(n) / Double(frames)
        for i in 0..<frames {
            let src = max(0, (Double(i) + 0.5) * scale - 0.5)
            let i0 = min(Int(src), n - 1), i1 = min(i0 + 1, n - 1)
            let t = Float(src - Double(i0))
            for d in 0..<dims { out[d * frames + i] = latents[i0][d] * (1 - t) + latents[i1][d] * t }
        }
        return out
    }

    static func floats(_ a: MLMultiArray) -> [Float] {
        let n = a.count
        switch a.dataType {
        case .float32:
            return Array(UnsafeBufferPointer(start: a.dataPointer.assumingMemoryBound(to: Float.self), count: n))
        #if arch(arm64)
        case .float16:
            return Array(UnsafeBufferPointer(start: a.dataPointer.assumingMemoryBound(to: Float16.self), count: n)).map(Float.init)
        #endif
        default:
            return (0..<n).map { a[$0].floatValue }
        }
    }

    static func resample(_ x: [Float], from: Int, to: Int) throws -> [Float] {
        guard from != to else { return x }
        guard let inFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(from), channels: 1, interleaved: false),
              let outFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(to), channels: 1, interleaved: false),
              let conv = AVAudioConverter(from: inFmt, to: outFmt),
              let inBuf = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: AVAudioFrameCount(x.count)) else {
            throw StudioError.badOutput("resampler")
        }
        conv.sampleRateConverterQuality = AVAudioQuality.max.rawValue
        inBuf.frameLength = AVAudioFrameCount(x.count)
        x.withUnsafeBufferPointer { inBuf.floatChannelData![0].update(from: $0.baseAddress!, count: x.count) }
        let cap = AVAudioFrameCount(Double(x.count) * Double(to) / Double(from)) + 1024
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: cap) else { throw StudioError.badOutput("resampler") }
        var fed = false
        var err: NSError?
        conv.convert(to: outBuf, error: &err) { _, status in
            if fed { status.pointee = .endOfStream; return nil }
            fed = true
            status.pointee = .haveData
            return inBuf
        }
        if let err { throw err }
        return Array(UnsafeBufferPointer(start: outBuf.floatChannelData![0], count: Int(outBuf.frameLength)))
    }
}
