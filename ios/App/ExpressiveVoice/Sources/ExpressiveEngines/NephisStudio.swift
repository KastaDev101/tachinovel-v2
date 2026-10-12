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
//  The sketch comes in at Mimi's scale (denormalized, as in training: the caller maps it). A call shorter than the
//  blueprint takes is padded in front and trimmed again; a model output that is not all numbers throws, so the
//  caller plays Mimi's sound for that call instead (studio audit 2026-10-12).
//

@preconcurrency import AVFoundation
import CoreML
import ExpressiveCore
import Foundation

public actor NephisStudio {
    /// Optional detail refiner (refiner.json + NephisRefiner): a flow-matching step run `steps` times after the
    /// blueprint (tachinovel-tts-lab finetune/wsl/fm_refine.py). It puts back the fine detail the blueprint averages
    /// away, which the vocoder otherwise renders as faint static.
    public struct RefinerConfig: Decodable, Sendable {
        public let steps: Int
        public let temp: Double
        public let rs: Double
        /// Per-band noise scale (one per mel band), fitted on her held-out audio so the drawn detail matches hers.
        public let bands: [Double]?
    }

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
        public var refinerMs = 0.0
        public var vocoderMs = 0.0
        /// Time spent deliberately resting between vocoder windows to cool the phone (not compute).
        public var restMs = 0.0
        public var audioMs = 0.0
        /// The studio was skipped for the call (Mimi's own sound, resampled, is used instead); `bypassReason` says
        /// why: "hurry" (playback short of audio), "heat" (the phone too hot), "empty", or "failed: <error>".
        public var bypassed = false
        public var bypassReason: String?
        /// Latents of leading silence added to a call too short for the blueprint (trimmed off again).
        public var padLatents = 0
        public var thermal = 0
        public var timesRealTime: Double { audioMs / max(1, resampleMs + blueprintMs + refinerMs + vocoderMs + restMs) }
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
    private let refiner: MLModel?
    private let refinerConfig: RefinerConfig?
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
        var rf: MLModel?, rc: RefinerConfig?
        let rcURL = dir.appendingPathComponent("refiner.json")
        if fm.fileExists(atPath: rcURL.path) {
            rc = try JSONDecoder().decode(RefinerConfig.self, from: Data(contentsOf: rcURL))
            rf = try MLModel(contentsOf: try await compiled("NephisRefiner", in: dir), configuration: mc)
        }
        return NephisStudio(config: config, blueprint: bp, vocoder: vc, refiner: rf, refinerConfig: rc)
    }

    public var heat = HeatPolicy()
    public func setHeatPolicy(_ p: HeatPolicy) { heat = p }

    init(config: Config, blueprint: MLModel, vocoder: MLModel, refiner: MLModel? = nil, refinerConfig: RefinerConfig? = nil) {
        self.config = config
        self.blueprint = blueprint
        self.vocoder = vocoder
        self.refiner = refiner
        self.refinerConfig = refinerConfig
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

    /// Left context carried from the previous call of the same read: its last audio (44.1 kHz, the blueprint's input)
    /// and latents. A call's start is then rendered with the audio before it, like the PC's one-piece render, instead
    /// of from a cold edge (code review 2026-10-12: cold call edges = onset artifacts). Cleared when a read restarts.
    private var carryPCM: [Float] = []
    private var carryLatents: [[Float]] = []
    /// Latents of context carried across calls: 0.8 s at 12.5 Hz, more than the blueprint's ~0.65 s reach.
    static let carryLatentCount = 10
    /// Longest stretch (mel frames) sent to the blueprint/refiner at once (their inputs stop at 3446 frames, ~40 s);
    /// longer calls go in overlapping segments, keeping only each segment's middle.
    static let segmentFrames = 2048
    static let segmentContext = 64

    /// One decoded call: Mimi's 24 kHz audio and the latents it was decoded from (at Mimi's scale: denormalized, as
    /// the blueprint was trained) -> her 44.1 kHz audio, exactly `pcm24.count * rate / 24000` samples long. `hurry`:
    /// playback has little buffered; skip the studio for this call (Mimi's sound at 44.1 kHz). `continues`: this call
    /// follows the previous one in the same read (its audio is the left context); false starts a new read.
    public func render(pcm24: [Float], latents: [[Float]], hurry: Bool = false, continues: Bool = false) async throws -> [Float] {
        try await renderReporting(pcm24: pcm24, latents: latents, hurry: hurry, continues: continues).pcm
    }

    /// `render`, with this call's report (`lastReport` may already be a later call's by the time a caller reads it).
    /// A failure throws after recording itself in `lastReport` (bypassed, "failed: …").
    public func renderReporting(pcm24: [Float], latents: [[Float]], hurry: Bool = false, continues: Bool = false) async throws
        -> (pcm: [Float], report: Report) {
        var report = Report()
        guard !pcm24.isEmpty, !latents.isEmpty else {
            report.bypassed = true
            report.bypassReason = "empty"
            return ([], report)
        }
        if !continues { carryPCM = []; carryLatents = [] }
        let thermal = ProcessInfo.processInfo.thermalState
        report.thermal = thermal.rawValue
        var t0 = Date()
        let target = Int((Double(pcm24.count) * Double(config.sample_rate) / Double(Self.inputRate)).rounded())
        // 50 ms of silence past the end, so the resampler's filter tail and the mel framing cover the last real sample
        // (a cut final "s" otherwise). The model's own 11.5 kHz low-pass makes the result independent of the resampler.
        let padded = try Self.resample(pcm24 + [Float](repeating: 0, count: Self.inputRate / 20), from: Self.inputRate, to: config.sample_rate)
        let own = Self.fit(padded, target)
        report.resampleMs = Date().timeIntervalSince(t0) * 1000
        let hop = config.hop
        defer { remember(own: own, latents: latents) }
        let skip: String? = hurry ? "hurry" : thermal.rawValue >= heat.bypassFrom.rawValue ? "heat" : nil
        if let skip {
            report.bypassed = true
            report.bypassReason = skip
            report.audioMs = Double(own.count) * 1000 / Double(config.sample_rate)
            lastReport = report
            return (own, report)
        }

        // A call too short for the blueprint (under 87 mel frames with its carried context, about 1 s: a short first
        // line) gets leading silence up to that length, with quiet latents to match (copies of the first one, which sits
        // in the pause a call starts with). Both are dropped from the output with the carried context. Such a call
        // used to fall back to Mimi's sound: a jump in quality on a short first line (studio audit 2026-10-12, A7).
        let perLatent = NephisFlow.samplesPerLatent * config.sample_rate / Self.inputRate
        let context = carryLatents + latents
        let padLatents = NephisFlow.studioLeadPad(samples: carryPCM.count + padded.count, hop: hop, samplesPerLatent: perLatent)
        report.padLatents = padLatents
        // The padding and the carried context in front; their samples are dropped from the output again.
        let pcm = [Float](repeating: 0, count: padLatents * perLatent) + carryPCM + padded
        let lead = padLatents * perLatent + carryPCM.count
        let latentsAll = [[Float]](repeating: context[0], count: padLatents) + context
        // Mel frame count exactly as the model computes it (reflect pad (n_fft - hop) / 2 each side, n_fft 2048).
        let frames = NephisFlow.studioFrames(samples: pcm.count, hop: hop)
        // The latents cover the real audio (padding + carry + this call), not the 50 ms of padding at the end: map them
        // over those frames and hold the last one over the end padding's frames.
        let realFrames = max(1, min(frames, (lead + target - hop) / hop + 1))
        let zReal = Self.latentsPerFrame(latentsAll, frames: realFrames, dims: config.z_dims)
        var zf = [Float](repeating: 0, count: config.z_dims * frames)
        for d in 0..<config.z_dims {
            for f in 0..<frames { zf[d * frames + f] = zReal[d * realFrames + min(f, realFrames - 1)] }
        }

        do {
            t0 = Date()
            let mel = try await melSegmented(pcm: pcm, zf: zf, frames: frames, report: &report)
            report.blueprintMs = Date().timeIntervalSince(t0) * 1000 - report.refinerMs

            let out = try await vocode(melValues: mel, frames: frames, report: &report)
            let mine = NephisFlow.studioTrim(out, lead: lead, count: target)
            report.audioMs = Double(mine.count) * 1000 / Double(config.sample_rate)
            lastReport = report
            return (mine, report)
        } catch {
            report.bypassed = true
            report.bypassReason = "failed: \(error)"
            lastReport = report
            throw error
        }
    }

    /// The fallback when the studio skips or fails a call: Mimi's own sound at the studio's rate, so the stream keeps
    /// one sample rate and nothing is dropped (NephisFlowSynth gives it the read's own EQ first, at 24 kHz). Linear
    /// interpolation if even the resampler fails.
    public nonisolated func plainAudio(pcm24: [Float]) -> [Float] {
        let rate = config.sample_rate
        let target = Int((Double(pcm24.count) * Double(rate) / Double(Self.inputRate)).rounded())
        if let r = try? Self.resample(pcm24 + [Float](repeating: 0, count: Self.inputRate / 20), from: Self.inputRate, to: rate) {
            return Self.fit(r, target)
        }
        guard pcm24.count > 1 else { return pcm24 }
        let step = Double(pcm24.count - 1) / Double(max(1, target - 1))
        return (0..<target).map { i in
            let x = Double(i) * step, i0 = Int(x), i1 = min(i0 + 1, pcm24.count - 1), t = Float(x - Double(i0))
            return pcm24[i0] * (1 - t) + pcm24[i1] * t
        }
    }

    private func remember(own: [Float], latents: [[Float]]) {
        let keep = min(Self.carryLatentCount, latents.count)
        let perLatent = own.count / max(1, latents.count)
        carryLatents = Array(latents.suffix(keep))
        carryPCM = Array(own.suffix(keep * perLatent))
    }

    /// `x` cut or zero-padded to exactly `n` samples.
    static func fit(_ x: [Float], _ n: Int) -> [Float] {
        x.count >= n ? Array(x.prefix(n)) : x + [Float](repeating: 0, count: n - x.count)
    }

    // MARK: - Steps

    /// Blueprint (+ refiner) for the whole call, in overlapping segments when it is longer than the models take at
    /// once (NephisFlow.studioSegments: none shorter than the blueprint takes). Returns her log-mel, [bands][frames]
    /// row-major.
    private func melSegmented(pcm: [Float], zf: [Float], frames: Int, report: inout Report) async throws -> [Float] {
        let bands = config.n_mels, dims = config.z_dims, hop = config.hop
        let plan = NephisFlow.studioSegments(frames: frames, length: Self.segmentFrames, context: Self.segmentContext)
        if plan.count == 1 { return try await melPiece(pcm: pcm, zf: zf, frames: frames, report: &report) }
        var mel = [Float](repeating: 0, count: bands * frames)
        for seg in plan {
            let f0 = seg.from, n = seg.to - seg.from
            let piecePCM = Array(pcm[(f0 * hop)..<min(pcm.count, seg.to * hop)])
            let pf = min(n, (piecePCM.count - hop) / hop + 1)
            var pieceZ = [Float](repeating: 0, count: dims * pf)
            for d in 0..<dims {
                for f in 0..<pf { pieceZ[d * pf + f] = zf[d * frames + f0 + f] }
            }
            let m = try await melPiece(pcm: piecePCM, zf: pieceZ, frames: pf, report: &report)
            for b in 0..<bands {
                for f in seg.keepFrom..<seg.keepTo where f - f0 < pf { mel[b * frames + f] = m[b * pf + f - f0] }
            }
        }
        return mel
    }

    private func melPiece(pcm: [Float], zf: [Float], frames: Int, report: inout Report) async throws -> [Float] {
        var mel = try blueprintMel(pcm: pcm, zf: zf, frames: frames)
        if let refiner, let refinerConfig {
            let t0 = Date()
            mel = try await refine(cond: mel, frames: frames, model: refiner, settings: refinerConfig)
            report.refinerMs += Date().timeIntervalSince(t0) * 1000
        }
        return mel
    }

    /// Flow matching from seeded noise to her detail (fm_refine.sample): x += v(x, cond, i/steps) / steps; mel = cond + x * rs.
    private func refine(cond: [Float], frames: Int, model: MLModel, settings: RefinerConfig) async throws -> [Float] {
        let bands = config.n_mels
        let n = bands * frames
        guard cond.count >= n else { throw StudioError.badOutput("mel size") }
        let shape: [NSNumber] = [1, NSNumber(value: bands), NSNumber(value: frames)]
        let condArray = try MLMultiArray(shape: shape, dataType: .float32)
        let cp = condArray.dataPointer.assumingMemoryBound(to: Float.self)
        for i in 0..<n { cp[i] = cond[i] }
        var rng = SplitMix64(seed: UInt64(frames))  // same text, same detail
        let xt = try MLMultiArray(shape: shape, dataType: .float32)
        let x = xt.dataPointer.assumingMemoryBound(to: Float.self)
        for i in 0..<n { x[i] = Float(rng.gaussian() * settings.temp) }
        if let scales = settings.bands, scales.count == bands {
            for b in 0..<bands {
                let scale = Float(scales[b])
                for f in 0..<frames { x[b * frames + f] *= scale }
            }
        }
        let t = try MLMultiArray(shape: [1], dataType: .float32)
        let steps = max(1, settings.steps)
        for s in 0..<steps {
            t[0] = NSNumber(value: Float(s) / Float(steps))
            let input = try MLDictionaryFeatureProvider(dictionary: ["x_t": xt, "cond": condArray, "t": t])
            guard let vArray = try await model.prediction(from: input).featureValue(for: "velocity")?.multiArrayValue else {
                throw StudioError.badOutput("velocity")
            }
            let v = Self.floats(vArray)
            for i in 0..<n { x[i] += v[i] / Float(steps) }
        }
        let rs = Float(settings.rs)
        let mel = (0..<n).map { cond[$0] + x[$0] * rs }
        guard NephisFlow.allFinite(mel) else { throw StudioError.badOutput("refined mel: not finite") }
        return mel
    }

    /// The blueprint on one stretch: PCM + the sketch per mel frame ([dims][frames]) -> her log-mel [bands][frames].
    private func blueprintMel(pcm: [Float], zf: [Float], frames: Int) throws -> [Float] {
        let x = try MLMultiArray(shape: [1, 1, NSNumber(value: pcm.count)], dataType: .float32)
        pcm.withUnsafeBufferPointer { src in
            x.dataPointer.assumingMemoryBound(to: Float.self).update(from: src.baseAddress!, count: pcm.count)
        }
        let z = try MLMultiArray(shape: [1, NSNumber(value: config.z_dims), NSNumber(value: frames)], dataType: .float32)
        zf.withUnsafeBufferPointer { src in
            z.dataPointer.assumingMemoryBound(to: Float.self).update(from: src.baseAddress!, count: min(zf.count, config.z_dims * frames))
        }
        let input = try MLDictionaryFeatureProvider(dictionary: ["pcm44": x, "z_frames": z])
        guard let mel = try blueprint.prediction(from: input).featureValue(for: "mel")?.multiArrayValue else {
            throw StudioError.badOutput("mel")
        }
        let m = Self.floats(mel), bands = config.n_mels, mf = m.count / bands
        // A LayerNorm can overflow fp16 on quiet frames (on the Neural Engine): such a call plays Mimi's sound instead.
        guard NephisFlow.allFinite(m) else { throw StudioError.badOutput("mel: not finite") }
        // The model's own frame count may differ by one from ours: re-pack to exactly [bands][frames].
        guard mf == frames else {
            var out = [Float](repeating: 0, count: bands * frames)
            for b in 0..<bands {
                for f in 0..<frames { out[b * frames + f] = m[b * mf + min(f, mf - 1)] }
            }
            return out
        }
        return m
    }

    private func vocode(melValues: [Float], frames: Int, report: inout Report) async throws -> [Float] {
        let bands = config.n_mels, chunk = config.chunk_frames, ctx = config.context_frames, win = config.window_frames
        let stride = melValues.count / bands  // [bands][frames], row-major
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
        let audio = Array(out.prefix(frames * config.hop))
        guard NephisFlow.allFinite(audio) else { throw StudioError.badOutput("pcm44: not finite") }
        return audio
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

/// Small seeded generator for the refiner's noise (reproducible per sentence length, no global RNG state).
struct SplitMix64 {
    private var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E37_79B9_7F4A_7C15 }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    /// Standard normal (Box-Muller).
    mutating func gaussian() -> Double {
        let u1 = max(Double(next() >> 11) / Double(1 << 53), 1e-12), u2 = Double(next() >> 11) / Double(1 << 53)
        return (-2 * log(u1)).squareRoot() * cos(2 * .pi * u2)
    }
}
