//
//  NephisDewindModel.swift — the de-wind cleaner's network on Core ML, and one read's cleaner (NephisDewinder).
//
//  The model ships inside the voice pack, so it can be retrained without an app build:
//
//    <pack>/Models/nephis-dewind/DewindNet.mlpackage     (or a precompiled DewindNet.mlmodelc)
//    <pack>/Models/nephis-dewind/dewind.json             {"model": "DewindNet", "frames_per_call": 8,
//                                                          "sample_rate": 48000, "sha256": "…", "compute_units": "cpu",
//                                                          "check": "dewind_check.json"}   (every field optional)
//    <pack>/Models/nephis-dewind/dewind_check.json       optional: frames of features and the gains and coefficients the
//                                                         PC's fp32 network made of them (the lab's model_io.json)
//
//  - The package is compiled once on the phone (MLModel.compileModel, cached next to it as <model>.mlmodelc, one compile at
//    a time: ExpressiveEngines' CompiledModels, as her studio's models). Before that first compile, "sha256" (when given)
//    must match the package: SHA-256 over its files in path order, each as "<relative path>\0<file's sha256 hex>\n"
//    (tachinovel-tts-lab coreml-swap/repack_dewind.py writes it); a mismatch keeps the cleaner off.
//  - Compute units: "cpu" (.cpuOnly, the default: the lab measured fp16 and the Neural Engine to change the sound), "gpu"
//    (.cpuAndGPU), "ane" (.cpuAndNeuralEngine), "all". Only for trying them on the phone.
//  - Model I/O (ML Program, iOS 17, fixed shapes, all Float32): feat_erb [1,1,N,32], feat_spec [1,2,N,96] (channel 0 real,
//    1 imaginary), erb_buf [1,1,2,32], spec_buf [1,2,2,96], c0_buf [1,64,4,96], h [5,256] -> gains [1,N,32], coefs
//    [1,N,96,10] (tap · 2 + re/im), and the state as erb_buf_out, spec_buf_out, c0_buf_out, h_out. The state starts at
//    zeros and each output is the next call's input: one set per pass (NephisDewind.Pass), so the two passes never mix.
//  - At load the network runs the check vectors (from zero state) and logs its largest difference from the PC; an output
//    that isn't all numbers, or off by more than 0.05 (a wrong layout, a broken model), keeps the cleaner off. fp32 on the
//    CPU should be within ~1e-4.
//

import CoreML
import Foundation

public final class NephisDewindModel: DewindNetwork, @unchecked Sendable {
    // @unchecked Sendable: every stored property is immutable after init, and the one MLModel's predictions run under
    // `lock` (a read's calls come one at a time anyway).

    /// dewind.json; every field optional.
    public struct Config: Decodable, Sendable, Equatable {
        public var model: String?
        public var frames_per_call: Int?
        public var sample_rate: Int?
        public var sha256: String?
        public var compute_units: String?
        public var check: String?
        public init() {}
    }

    public enum ModelError: Error, CustomStringConvertible {
        case missing(String), badConfig(String), checksum(String), badOutput(String), checkFailed(String)

        public var description: String {
            switch self {
            case .missing(let what): return "missing \(what)"
            case .badConfig(let why): return "dewind.json: \(why)"
            case .checksum(let name): return "\(name).mlpackage does not match dewind.json's sha256"
            case .badOutput(let why): return "model output: \(why)"
            case .checkFailed(let why): return "check: \(why)"
            }
        }
    }

    public static let folder = "Models/nephis-dewind"
    public static let defaultName = "DewindNet"

    public let name: String
    public let framesPerCall: Int
    /// The compute units in a word ("cpu", "cpu+gpu", "cpu+ane", "all"): logs and the Voice speed test.
    public let computeUnits: String
    private let model: MLModel
    private let lock = NSLock()

    init(model: MLModel, name: String, framesPerCall: Int, computeUnits: String) {
        self.model = model
        self.name = name
        self.framesPerCall = framesPerCall
        self.computeUnits = computeUnits
    }

    /// dewind.json in `dir` (all defaults when there is none), checked: the network runs at 48 kHz, 1-64 frames per call.
    public static func readConfig(in dir: URL) throws -> Config {
        let url = dir.appendingPathComponent("dewind.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return Config() }
        let c = try JSONDecoder().decode(Config.self, from: Data(contentsOf: url))
        if let rate = c.sample_rate, rate != NephisDewind.sampleRate { throw ModelError.badConfig("sample_rate \(rate), the cleaner runs at 48000") }
        if let n = c.frames_per_call, !(1...64).contains(n) { throw ModelError.badConfig("frames_per_call \(n)") }
        for (key, value) in [("model", c.model), ("check", c.check)] {
            if let v = value, v.isEmpty || v.contains("/") || v.contains("..") { throw ModelError.badConfig("\(key) \"\(v)\"") }
        }
        return c
    }

    static func units(_ word: String?) -> MLComputeUnits {
        switch word {
        case "gpu": return .cpuAndGPU
        case "ane": return .cpuAndNeuralEngine
        case "all": return .all
        default: return .cpuOnly
        }
    }

    static func unitsName(_ u: MLComputeUnits) -> String {
        switch u {
        case .cpuOnly: return "cpu"
        case .cpuAndGPU: return "cpu+gpu"
        case .cpuAndNeuralEngine: return "cpu+ane"
        case .all: return "all"
        @unknown default: return "other"
        }
    }

    /// SHA-256 over a package's files in path order, each "<relative path>\0<sha256 hex>\n" (repack_dewind.py's).
    public static func treeHash(of package: URL) throws -> String {
        let fm = FileManager.default
        let paths = (fm.subpaths(atPath: package.path) ?? []).filter { rel in
            var dir: ObjCBool = false
            return fm.fileExists(atPath: package.appendingPathComponent(rel).path, isDirectory: &dir) && !dir.boolValue
        }.sorted()
        var lines = ""
        for rel in paths { lines += "\(rel)\u{0}\(try ModelStore.sha256(of: package.appendingPathComponent(rel)))\n" }
        return VoicePack.sha256Hex(Data(lines.utf8))
    }

    /// The network in `dir` (a pack's Models/nephis-dewind). `compiled(name, dir)`: `<name>.mlmodelc` in `dir`, compiling
    /// `<name>.mlpackage` once when only that ships (ExpressiveEngines' CompiledModels). Throws when there is no model, a
    /// bad dewind.json, a checksum mismatch or a model of other shapes.
    public static func load(from dir: URL, computeUnits: MLComputeUnits? = nil,
                            compiled: @Sendable (String, URL) async throws -> URL) async throws -> NephisDewindModel {
        let fm = FileManager.default
        let config = try readConfig(in: dir)
        let name = config.model ?? defaultName
        let package = dir.appendingPathComponent("\(name).mlpackage")
        let compiledURL = dir.appendingPathComponent("\(name).mlmodelc")
        guard fm.fileExists(atPath: package.path) || fm.fileExists(atPath: compiledURL.path) else { throw ModelError.missing("\(name).mlpackage") }
        // Checked before its first compile (afterwards the compiled model is what was checked).
        if !fm.fileExists(atPath: compiledURL.path), let want = config.sha256?.lowercased() {
            guard try treeHash(of: package) == want else { throw ModelError.checksum(name) }
        }
        let mc = MLModelConfiguration()
        mc.computeUnits = computeUnits ?? units(config.compute_units)
        let model = try MLModel(contentsOf: try await compiled(name, dir), configuration: mc)
        // Frames per call from the model itself (feat_erb [1,1,N,32]); dewind.json's, when given, must agree.
        let shape = model.modelDescription.inputDescriptionsByName["feat_erb"]?.multiArrayConstraint?.shape.map(\.intValue) ?? []
        guard shape.count == 4, shape[0] == 1, shape[1] == 1, shape[3] == NephisDewind.erbBands, shape[2] >= 1 else {
            throw ModelError.badConfig("the model's feat_erb is \(shape), expected [1, 1, N, 32]")
        }
        if let n = config.frames_per_call, n != shape[2] { throw ModelError.badConfig("frames_per_call \(n), the model takes \(shape[2])") }
        return NephisDewindModel(model: model, name: name, framesPerCall: shape[2], computeUnits: unitsName(mc.computeUnits))
    }

    private static func array(_ values: [Float], _ shape: [Int]) throws -> MLMultiArray {
        let a = try MLMultiArray(shape: shape.map { NSNumber(value: $0) }, dataType: .float32)
        guard a.count == values.count else { throw ModelError.badOutput("input of \(values.count) values for \(shape)") }
        values.withUnsafeBufferPointer { src in
            guard let base = src.baseAddress else { return }
            a.dataPointer.assumingMemoryBound(to: Float.self).update(from: base, count: values.count)
        }
        return a
    }

    public func run(featErb: [Float], featSpec: [Float], state: inout NephisDewind.NetState) throws -> (gains: [Float], coefs: [Float]) {
        let n = framesPerCall
        let erb = NephisDewind.erbBands, df = NephisDewind.dfBins
        guard featErb.count == n * erb, featSpec.count == 2 * n * df else {
            throw ModelError.badOutput("features: \(featErb.count) + \(featSpec.count) values for \(n) frames")
        }
        let input = try MLDictionaryFeatureProvider(dictionary: [
            "feat_erb": try Self.array(featErb, [1, 1, n, erb]),
            "feat_spec": try Self.array(featSpec, [1, 2, n, df]),
            "erb_buf": try Self.array(state.erbBuf, [1, 1, 2, erb]),
            "spec_buf": try Self.array(state.specBuf, [1, 2, 2, df]),
            "c0_buf": try Self.array(state.c0Buf, [1, 64, 4, df]),
            "h": try Self.array(state.h, [5, 256]),
        ])
        lock.lock()
        defer { lock.unlock() }
        let out = try model.prediction(from: input)
        func read(_ key: String, _ count: Int) throws -> [Float] {
            guard let a = out.featureValue(for: key)?.multiArrayValue else { throw ModelError.badOutput("no \(key)") }
            let v = ModelOutput.floats(a)
            guard v.count == count else { throw ModelError.badOutput("\(key): \(v.count) values, expected \(count)") }
            guard NephisFlow.allFinite(v) else { throw ModelError.badOutput("\(key): not finite") }
            return v
        }
        let gains = try read("gains", n * erb)
        let coefs = try read("coefs", n * df * 2 * NephisDewind.dfOrder)
        state.erbBuf = try read("erb_buf_out", state.erbBuf.count)
        state.specBuf = try read("spec_buf_out", state.specBuf.count)
        state.c0Buf = try read("c0_buf_out", state.c0Buf.count)
        state.h = try read("h_out", state.h.count)
        return (gains, coefs)
    }

    // MARK: - The check against the PC

    /// dewind_check.json (the lab's model_io.json): per frame, the features in (feat_erb [32], feat_spec [2][96]) and what
    /// the PC's fp32 network made of them from zero state (gains [32], coefs [96][10]).
    public struct CheckVectors: Decodable, Sendable {
        public var feat_erb: [[Float]]
        public var feat_spec: [[[Float]]]
        public var gains: [[Float]]
        public var coefs: [[[Float]]]
    }

    /// The largest difference from the PC over the check's frames (whole blocks of `framesPerCall`), from zero state.
    public static func check(_ net: any DewindNetwork, against v: CheckVectors) throws -> Double {
        let n = net.framesPerCall
        let frames = min(v.feat_erb.count, v.feat_spec.count, v.gains.count, v.coefs.count) / n * n
        guard frames > 0 else { throw ModelError.checkFailed("fewer than \(n) frames") }
        var state = NephisDewind.NetState()
        var worst = 0.0
        for b in stride(from: 0, to: frames, by: n) {
            var erb = [Float](repeating: 0, count: n * NephisDewind.erbBands)
            var spec = [Float](repeating: 0, count: 2 * n * NephisDewind.dfBins)
            for i in 0..<n {
                let fe = v.feat_erb[b + i], fs = v.feat_spec[b + i]
                guard fe.count == NephisDewind.erbBands, fs.count == 2, fs.allSatisfy({ $0.count == NephisDewind.dfBins }) else {
                    throw ModelError.checkFailed("frame \(b + i) has the wrong size")
                }
                for k in 0..<NephisDewind.erbBands { erb[i * NephisDewind.erbBands + k] = fe[k] }
                for c in 0..<2 {
                    for k in 0..<NephisDewind.dfBins { spec[(c * n + i) * NephisDewind.dfBins + k] = fs[c][k] }
                }
            }
            let r = try net.run(featErb: erb, featSpec: spec, state: &state)
            for i in 0..<n {
                for (k, g) in v.gains[b + i].enumerated() where k < NephisDewind.erbBands {
                    worst = max(worst, Double(abs(r.gains[i * NephisDewind.erbBands + k] - g)))
                }
                for (k, row) in v.coefs[b + i].enumerated() where k < NephisDewind.dfBins {
                    for (j, c) in row.enumerated() where j < 2 * NephisDewind.dfOrder {
                        worst = max(worst, Double(abs(r.coefs[(i * NephisDewind.dfBins + k) * 2 * NephisDewind.dfOrder + j] - c)))
                    }
                }
            }
        }
        guard worst.isFinite else { throw ModelError.checkFailed("not finite") }
        return worst
    }

    /// Off by more than this from the PC: a wrong layout or a broken model, never just fp16 or another chip.
    public static let checkLimit = 0.05
}

/// One read's de-wind cleaner over the pack's network: calls in reading order, each cleaned and returned whole
/// (NephisDewind.Stream). An actor, so it runs on the synthesis worker's threads (never the audio render thread) and one
/// call at a time.
public actor NephisDewinder {
    private let network: any DewindNetwork
    /// The network's name, frames per call and compute units (the logs, the Voice speed test).
    public nonisolated let name: String
    public nonisolated let framesPerCall: Int
    public nonisolated let computeUnits: String
    /// The largest difference from the PC in the load check (nil: the pack ships no check).
    public nonisolated let checkError: Double?
    private var stream: NephisDewind.Stream?

    public init(network: any DewindNetwork, name: String, computeUnits: String, checkError: Double? = nil) {
        self.network = network
        self.name = name
        framesPerCall = network.framesPerCall
        self.computeUnits = computeUnits
        self.checkError = checkError
    }

    public init(model: NephisDewindModel, checkError: Double? = nil) {
        self.init(network: model, name: model.name, computeUnits: model.computeUnits, checkError: checkError)
    }

    /// What happened to one call: its samples (the call unchanged when `error`), the time it took, and why it was left as
    /// it was.
    public struct Outcome: Sendable {
        public var samples: [Float]
        public var ms = 0.0
        public var error: String?
    }

    /// One call, cleaned. `restart`: a new read (or a seek, a new chapter) starts a fresh chain; so does another rate or
    /// other settings. Settings off: the call untouched. A failing network leaves this call as it was and the next call
    /// starts afresh.
    public func process(_ x: [Float], settings: NephisDewind.Settings, sampleRate: Int, restart: Bool) -> Outcome {
        guard settings.on, sampleRate > 0, !x.isEmpty else { return Outcome(samples: x) }
        if restart || stream?.sampleRate != sampleRate || stream?.settings != settings {
            stream = NephisDewind.Stream(settings: settings, sampleRate: sampleRate, framesPerCall: framesPerCall)
        }
        let t0 = Date()
        do {
            guard var s = stream else { return Outcome(samples: x) }
            stream = nil  // the copy below is the only one: no copy-on-write of the chain's state
            let y = try s.process(x, net: network)
            stream = s
            return Outcome(samples: y, ms: Date().timeIntervalSince(t0) * 1000)
        } catch {
            return Outcome(samples: x, ms: Date().timeIntervalSince(t0) * 1000, error: "\(error)")
        }
    }

    /// The pack's cleaner (`dir`: its Models/nephis-dewind), its check run when the pack ships one, and a line for the log.
    public static func load(from dir: URL, compiled: @Sendable (String, URL) async throws -> URL) async throws -> (NephisDewinder, String) {
        let t0 = Date()
        let model = try await NephisDewindModel.load(from: dir, compiled: compiled)
        let config = try NephisDewindModel.readConfig(in: dir)
        var checkError: Double?
        let checkURL = dir.appendingPathComponent(config.check ?? "dewind_check.json")
        if FileManager.default.fileExists(atPath: checkURL.path) {
            let v = try JSONDecoder().decode(NephisDewindModel.CheckVectors.self, from: Data(contentsOf: checkURL))
            let e = try NephisDewindModel.check(model, against: v)
            guard e <= NephisDewindModel.checkLimit else {
                throw NephisDewindModel.ModelError.checkFailed("off by \(e) from the PC (limit \(NephisDewindModel.checkLimit))")
            }
            checkError = e
        }
        let ms = Int(Date().timeIntervalSince(t0) * 1000)
        let check = checkError.map { "check within \(String(format: "%.1e", $0)) of the PC" } ?? "no check in the pack"
        return (NephisDewinder(model: model, checkError: checkError),
                "dewind: loaded \(model.name) (\(model.framesPerCall) frames per call, units \(model.computeUnits)) in \(ms) ms, \(check)")
    }
}
