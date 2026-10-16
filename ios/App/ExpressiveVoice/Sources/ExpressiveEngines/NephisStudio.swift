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
//  Crash plan 2026-10-12 (a5): outputs are read by shape (ModelOutput.floats: Float16, padded strides), every shape
//  and size is checked and throws instead of trapping (the call plays her plain sound), one compile at a time with an
//  atomic install, and a render stops between windows when its call is cancelled (a release).
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
        /// Vocoder pieces (windows) rendered, of those the call needed.
        public var pieces = 0
        public var piecesPlanned = 0
        /// The call's × real time when its `check` gave up on it mid-call (StudioPace.projected); nil otherwise.
        public var projectedX: Double?
        public var timesRealTime: Double { audioMs / max(1, resampleMs + blueprintMs + refinerMs + vocoderMs + restMs) }
        /// × real time of the studio's work on the call: measured when it rendered the call, projected when it gave up on
        /// it; nil when it never ran (skipped, failed).
        public var speedX: Double? { bypassed ? projectedX : timesRealTime }
    }

    /// Asked between the studio's pieces with the call's projected × real time (StudioPace.projected): a reason to give
    /// up on the call (her plain sound for it, the reason in her call log), or nil to go on.
    public typealias Check = @Sendable (_ projectedX: Double) -> String?

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

    public enum StudioError: Error {
        case missing(String), badOutput(String), badConfig(String)
        /// A call's `check` gave up on it (why, and its projected × real time then).
        case gaveUp(String, Double)
    }

    public static let inputRate = 24_000
    public nonisolated let config: Config
    /// The compute units its models were loaded with ("cpu+ane", "cpu+gpu", "all", "cpu"): the logs and the Voice test.
    public nonisolated let computeUnits: String
    private let blueprint: MLModel
    private let vocoder: MLModel
    private let refiner: MLModel?
    private let refinerConfig: RefinerConfig?
    public private(set) var lastReport = Report()

    /// studio.json in `dir` (nil when the pack ships no studio), checked so a bad file throws here instead of
    /// trapping in a render (a zero hop or chunk, a keep range that runs backwards).
    public static func readConfig(in dir: URL) throws -> Config? {
        let url = dir.appendingPathComponent("studio.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let c = try JSONDecoder().decode(Config.self, from: Data(contentsOf: url))
        guard c.sample_rate > 0, c.hop > 0, c.n_mels > 0, c.z_dims > 0, c.chunk_frames > 0, c.window_frames > 0, c.context_frames >= 0,
              c.keep_from_sample >= 0, c.keep_from_sample < c.keep_to_sample else { throw StudioError.badConfig("studio.json") }
        return c
    }

    /// The studio in `<dir>` (a pack's Models/nephis-studio), or nil when the pack doesn't ship one.
    public static func load(from dir: URL, computeUnits: MLComputeUnits? = nil) async throws -> NephisStudio? {
        let fm = FileManager.default
        guard let config = try Self.readConfig(in: dir) else { return nil }
        let mc = MLModelConfiguration()
        switch config.compute_units {
        case "ane": mc.computeUnits = .cpuAndNeuralEngine
        case "gpu": mc.computeUnits = .cpuAndGPU
        default: mc.computeUnits = .all
        }
        if let computeUnits { mc.computeUnits = computeUnits }
        let units = Self.unitsName(mc.computeUnits)
        let bp = try MLModel(contentsOf: try await compiled("NephisBlueprint", in: dir), configuration: mc)
        // Released meanwhile (Listen's background load, NephisFlowSynth.unload): stop before the next model.
        try Task.checkCancellation()
        // The int8 package when the pack ships it (same sound, half the memory traffic), else the fp16 one.
        let name = config.vocoder_model.flatMap { fm.fileExists(atPath: dir.appendingPathComponent("\($0).mlpackage").path)
            || fm.fileExists(atPath: dir.appendingPathComponent("\($0).mlmodelc").path) ? $0 : nil } ?? "NephisVocoder"
        let vc = try MLModel(contentsOf: try await compiled(name, in: dir), configuration: mc)
        try Task.checkCancellation()
        var rf: MLModel?, rc: RefinerConfig?
        let rcURL = dir.appendingPathComponent("refiner.json")
        if fm.fileExists(atPath: rcURL.path) {
            rc = try JSONDecoder().decode(RefinerConfig.self, from: Data(contentsOf: rcURL))
            rf = try MLModel(contentsOf: try await compiled("NephisRefiner", in: dir), configuration: mc)
        }
        return NephisStudio(config: config, blueprint: bp, vocoder: vc, refiner: rf, refinerConfig: rc, computeUnits: units)
    }

    /// MLComputeUnits in a word, for the logs.
    static func unitsName(_ u: MLComputeUnits) -> String {
        switch u {
        case .cpuOnly: return "cpu"
        case .cpuAndGPU: return "cpu+gpu"
        case .cpuAndNeuralEngine: return "cpu+ane"
        case .all: return "all"
        @unknown default: return "other"
        }
    }

    public var heat = HeatPolicy()
    public func setHeatPolicy(_ p: HeatPolicy) { heat = p }

    init(config: Config, blueprint: MLModel, vocoder: MLModel, refiner: MLModel? = nil, refinerConfig: RefinerConfig? = nil,
         computeUnits: String = "all") {
        self.config = config
        self.computeUnits = computeUnits
        self.blueprint = blueprint
        self.vocoder = vocoder
        self.refiner = refiner
        self.refinerConfig = refinerConfig
    }

    /// `<name>.mlmodelc` in `dir`, compiling `<name>.mlpackage` once (cached next to it) when only that ships. One
    /// compile per model at a time (CompiledModels): Listen's studio and the speed test never delete each other's files.
    static func compiled(_ name: String, in dir: URL) async throws -> URL {
        try await CompiledModels.shared.url(name, in: dir)
    }

    /// A freshly compiled model put in place in one step: staged next to `dest` first (a copy if the system compiled it
    /// on another volume), then renamed, so a crash never leaves half a model under the real name. A model installed
    /// there meanwhile is kept, never deleted; staging folders a crash left behind for `dest` are cleared first.
    static func install(_ compiled: URL, at dest: URL) throws {
        let fm = FileManager.default
        let dir = dest.deletingLastPathComponent()
        let prefix = ".\(dest.lastPathComponent)."
        for old in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] where old.hasPrefix(prefix) {
            try? fm.removeItem(at: dir.appendingPathComponent(old))
        }
        let staged = dir.appendingPathComponent(prefix + UUID().uuidString)
        try fm.moveItem(at: compiled, to: staged)
        do {
            try fm.moveItem(at: staged, to: dest)
        } catch {
            try? fm.removeItem(at: staged)
            guard fm.fileExists(atPath: dest.path) else { throw error }
        }
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
    /// A failure throws after recording itself in `lastReport` (bypassed, "failed: …"). `check`: asked between the
    /// blueprint's segments and the vocoder's pieces; when it gives up on the call (too slow for playback, memory), the
    /// call returns Mimi's sound at the studio's rate, bypassed with its reason, like a skip (2026-10-13: a studio slower
    /// than real time held every call of a read behind it). Nil (the speed test): the studio always finishes.
    public func renderReporting(pcm24: [Float], latents: [[Float]], hurry: Bool = false, continues: Bool = false,
                                check: Check? = nil) async throws -> (pcm: [Float], report: Report) {
        var report = Report()
        guard !pcm24.isEmpty, !latents.isEmpty else {
            report.bypassed = true
            report.bypassReason = "empty"
            return ([], report)
        }
        if !continues { carryPCM = []; carryLatents = [] }
        let thermal = ProcessInfo.processInfo.thermalState
        report.thermal = thermal.rawValue
        let started = Date()
        var t0 = started
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
        let context = carryLatents + latents
        // A sketch narrower than the blueprint takes would be read past (crash plan a5): her plain sound instead.
        guard context.allSatisfy({ $0.count >= config.z_dims }) else {
            report.bypassed = true
            report.bypassReason = "failed: sketch size"
            lastReport = report
            throw StudioError.badOutput("sketch: latents shorter than \(config.z_dims)")
        }

        // A call too short for the blueprint (under 87 mel frames with its carried context, about 1 s: a short first
        // line) gets leading silence up to that length, with quiet latents to match (copies of the first one, which sits
        // in the pause a call starts with). Both are dropped from the output with the carried context. Such a call
        // used to fall back to Mimi's sound: a jump in quality on a short first line (studio audit 2026-10-12, A7).
        let perLatent = NephisFlow.samplesPerLatent * config.sample_rate / Self.inputRate
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

        let pace = Pace(check: check, audioMs: Double(target) * 1000 / Double(config.sample_rate), started: started)
        do {
            t0 = Date()
            let mel = try await melSegmented(pcm: pcm, zf: zf, frames: frames, pace: pace, report: &report)
            report.blueprintMs = Date().timeIntervalSince(t0) * 1000 - report.refinerMs

            let out = try await vocode(melValues: mel, frames: frames, pace: pace, report: &report)
            let mine = NephisFlow.studioTrim(out, lead: lead, count: target)
            report.audioMs = Double(mine.count) * 1000 / Double(config.sample_rate)
            lastReport = report
            return (mine, report)
        } catch StudioError.gaveUp(let why, let x) {
            // Too slow for playback (or memory): Mimi's sound at the studio's rate for this call, like a skip.
            if report.blueprintMs == 0 { report.blueprintMs = max(0, Date().timeIntervalSince(t0) * 1000 - report.refinerMs) }  // gave up inside it
            report.bypassed = true
            report.bypassReason = why
            report.projectedX = x
            report.audioMs = Double(own.count) * 1000 / Double(config.sample_rate)
            lastReport = report
            return (own, report)
        } catch {
            report.bypassed = true
            report.bypassReason = "failed: \(error)"
            lastReport = report
            throw error
        }
    }

    /// Its speed on this phone (× real time), measured once when a pack's studio loads (2026-10-16: StudioBudget planned a
    /// fresh pack's first calls with an 8x guess and skipped them; the iPhone 16 runs it at 32-50x). One vocoder piece of
    /// silence (StudioBudget.measureLatents: 1.36 s of audio for her studio) rendered twice: the first run readies the
    /// models (a real call's first run would pay that instead), the second is timed; its work without the heat rests.
    /// About 0.1 s of work on an iPhone 16. nil when a run fails, is cancelled or steps aside for heat. The read's carried
    /// context is cleared afterwards, so the next call starts as if nothing had run.
    public func measureSpeed() async -> Double? {
        let n = StudioBudget.measureLatents(chunkFrames: config.chunk_frames, hop: config.hop, sampleRate: config.sample_rate)
        let pcm = [Float](repeating: 0, count: n * NephisFlow.samplesPerLatent)
        let latents = [[Float]](repeating: [Float](repeating: 0, count: config.z_dims), count: n)
        defer { carryPCM = []; carryLatents = [] }
        var best: Double?
        for _ in 0..<2 {
            guard let r = try? await renderReporting(pcm24: pcm, latents: latents), !r.report.bypassed, !Task.isCancelled else { return nil }
            let work = r.report.resampleMs + r.report.blueprintMs + r.report.refinerMs + r.report.vocoderMs
            guard work > 0, r.report.audioMs > 0 else { return nil }
            best = max(best ?? 0, r.report.audioMs / work)
        }
        return best
    }

    /// The fallback when the studio skips or fails a call: Mimi's own sound at the studio's rate, so the stream keeps
    /// one sample rate and nothing is dropped (NephisFlowSynth gives it the read's own EQ first, at 24 kHz). Linear
    /// interpolation if even the resampler fails.
    public nonisolated func plainAudio(pcm24: [Float]) -> [Float] {
        Self.plainAudio(pcm24: pcm24, rate: config.sample_rate)
    }

    /// `plainAudio` without the models (NephisFlowSynth plays it while the studio's models aren't loaded: they load on
    /// first use and are dropped when memory runs low, crash plan b1). `rate`: the studio's (studio.json).
    public static func plainAudio(pcm24: [Float], rate: Int) -> [Float] {
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

    /// A call's clock and its `check` (renderReporting): asked between the blueprint's segments and the vocoder's pieces.
    private struct Pace {
        let check: Check?
        let audioMs: Double
        let started: Date

        /// Throws `gaveUp` when the check gives up on the call at its projected pace (StudioPace.projected).
        func checkpoint(fixedMs: Double, piecesMs: Double = 0, done: Int = 0, pieces: Int = 0) throws {
            guard let check else { return }
            let x = StudioPace.projected(audioMs: audioMs, fixedMs: fixedMs, piecesMs: piecesMs, done: done, pieces: pieces)
            if let why = check(x) { throw StudioError.gaveUp(why, x) }
        }

        var elapsedMs: Double { Date().timeIntervalSince(started) * 1000 }
    }

    /// Blueprint (+ refiner) for the whole call, in overlapping segments when it is longer than the models take at
    /// once (NephisFlow.studioSegments: none shorter than the blueprint takes). Returns her log-mel, [bands][frames]
    /// row-major.
    private func melSegmented(pcm: [Float], zf: [Float], frames: Int, pace: Pace, report: inout Report) async throws -> [Float] {
        let bands = config.n_mels, dims = config.z_dims, hop = config.hop
        let plan = NephisFlow.studioSegments(frames: frames, length: Self.segmentFrames, context: Self.segmentContext)
        if plan.count == 1 { return try await melPiece(pcm: pcm, zf: zf, frames: frames, report: &report) }
        var mel = [Float](repeating: 0, count: bands * frames)
        for (k, seg) in plan.enumerated() {
            try Task.checkCancellation()
            // Between segments: the work so far alone already under the pace gives up (the vocoder is still to come).
            if k > 0 { try pace.checkpoint(fixedMs: pace.elapsedMs) }
            let f0 = seg.from, n = seg.to - seg.from
            let lo = f0 * hop, hi = min(pcm.count, seg.to * hop)
            guard f0 >= 0, lo < hi else { throw StudioError.badOutput("segment \(seg.from)..<\(seg.to) past the audio") }
            let piecePCM = Array(pcm[lo..<hi])
            let pf = min(n, (piecePCM.count - hop) / hop + 1)
            guard pf > 0, f0 + pf <= frames else { throw StudioError.badOutput("segment \(seg.from)..<\(seg.to): \(pf) frames") }
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
            try Task.checkCancellation()
            t[0] = NSNumber(value: Float(s) / Float(steps))
            let input = try MLDictionaryFeatureProvider(dictionary: ["x_t": xt, "cond": condArray, "t": t])
            guard let vArray = try await model.prediction(from: input).featureValue(for: "velocity")?.multiArrayValue else {
                throw StudioError.badOutput("velocity")
            }
            let v = ModelOutput.floats(vArray)
            guard v.count == n else { throw StudioError.badOutput("velocity: \(v.count) values, expected \(n)") }
            for i in 0..<n { x[i] += v[i] / Float(steps) }
        }
        let rs = Float(settings.rs)
        let mel = (0..<n).map { cond[$0] + x[$0] * rs }
        guard NephisFlow.allFinite(mel) else { throw StudioError.badOutput("refined mel: not finite") }
        return mel
    }

    /// The blueprint on one stretch: PCM + the sketch per mel frame ([dims][frames]) -> her log-mel [bands][frames].
    private func blueprintMel(pcm: [Float], zf: [Float], frames: Int) throws -> [Float] {
        let dims = config.z_dims, bands = config.n_mels
        guard !pcm.isEmpty, frames > 0, zf.count >= dims * frames else {
            throw StudioError.badOutput("blueprint input: \(pcm.count) samples, \(zf.count) sketch values for \(frames) frames")
        }
        let x = try MLMultiArray(shape: [1, 1, NSNumber(value: pcm.count)], dataType: .float32)
        pcm.withUnsafeBufferPointer { src in
            guard let base = src.baseAddress else { return }
            x.dataPointer.assumingMemoryBound(to: Float.self).update(from: base, count: pcm.count)
        }
        let z = try MLMultiArray(shape: [1, NSNumber(value: dims), NSNumber(value: frames)], dataType: .float32)
        zf.withUnsafeBufferPointer { src in
            guard let base = src.baseAddress else { return }
            z.dataPointer.assumingMemoryBound(to: Float.self).update(from: base, count: dims * frames)
        }
        let input = try MLDictionaryFeatureProvider(dictionary: ["pcm44": x, "z_frames": z])
        guard let mel = try blueprint.prediction(from: input).featureValue(for: "mel")?.multiArrayValue else {
            throw StudioError.badOutput("mel")
        }
        let m = ModelOutput.floats(mel)
        // [1, bands, frames'] with frames' close to ours, or the call plays her plain sound (never read past it).
        let shape = mel.shape.map(\.intValue)
        guard let mf = NephisFlow.studioMelFrames(shape: shape, count: m.count, bands: bands, frames: frames) else {
            throw StudioError.badOutput("mel shape \(shape), expected [1, \(bands), \(frames)]")
        }
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

    private func vocode(melValues: [Float], frames: Int, pace: Pace, report: inout Report) async throws -> [Float] {
        let bands = config.n_mels, chunk = config.chunk_frames, ctx = config.context_frames, win = config.window_frames
        let stride = melValues.count / bands  // [bands][frames], row-major
        guard frames > 0, stride >= frames, chunk > 0, win > 0 else {
            throw StudioError.badOutput("vocoder input: \(melValues.count) mel values for \(frames) frames")
        }
        var out: [Float] = []
        out.reserveCapacity(frames * config.hop)
        report.piecesPlanned = (frames + chunk - 1) / chunk
        let fixedMs = report.resampleMs + report.blueprintMs + report.refinerMs
        var start = 0
        while start < frames {
            // Released meanwhile (NephisFlowSynth.unload cancels its calls): stop between windows, and the models go.
            try Task.checkCancellation()
            // Still on pace for playback (and memory)? Before the first piece the work so far alone, then the pieces so far
            // projected over the rest (StudioPace.projected).
            try pace.checkpoint(fixedMs: fixedMs, piecesMs: report.vocoderMs + report.restMs, done: report.pieces, pieces: report.piecesPlanned)
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
            let samples = ModelOutput.floats(pcm)
            let keepFrom = min(config.keep_from_sample, samples.count), keepTo = min(config.keep_to_sample, samples.count)
            guard keepFrom < keepTo else { throw StudioError.badOutput("pcm44: \(samples.count) samples") }
            out.append(contentsOf: samples[keepFrom..<keepTo])
            start += chunk
            report.pieces += 1
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

/// One compile per model at a time (crash plan a5): a second loader of the same model waits for the first one's compile
/// instead of compiling it again and deleting the files the first one is loading from.
actor CompiledModels {
    static let shared = CompiledModels()
    private var compiling: [URL: Task<URL, Error>] = [:]

    func url(_ name: String, in dir: URL) async throws -> URL {
        let dest = dir.appendingPathComponent("\(name).mlmodelc")
        if let running = compiling[dest] { return try await running.value }
        let fm = FileManager.default
        if fm.fileExists(atPath: dest.path) { return dest }
        let package = dir.appendingPathComponent("\(name).mlpackage")
        guard fm.fileExists(atPath: package.path) else { throw NephisStudio.StudioError.missing(name) }
        let job = Task.detached(priority: .userInitiated) { () async throws -> URL in
            let tmp = try await MLModel.compileModel(at: package)
            try NephisStudio.install(tmp, at: dest)
            return dest
        }
        compiling[dest] = job
        defer { compiling[dest] = nil }
        return try await job.value
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
