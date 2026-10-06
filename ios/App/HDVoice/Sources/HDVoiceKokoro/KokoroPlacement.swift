//
//  KokoroPlacement.swift — where Core ML actually runs each Kokoro stage on this device.
//
//  The route (KokoroRoute) only states preferences per stage; Core ML decides per operation which device
//  runs it (an ANE-preferred stage can still have ops on the CPU, which is where Apple's BNNS crash on
//  iOS 26.4+ lives, FluidAudio #817/#844). MLComputePlan (iOS 17.4+) reports that decision without
//  running the model. Shown in the Voice Lab and printed by the CI voice check.
//

import CoreML
import FluidAudio
import Foundation
import HDVoiceCore

public struct StagePlacement: Sendable, Equatable {
    public let stage: String
    /// The compute units the stage was configured with.
    public let configured: String
    public let neuralEngine: Int
    public let cpu: Int
    public let gpu: Int
    public let error: String?

    public var summary: String {
        if let error { return "\(stage): \(error)" }
        let total = max(1, neuralEngine + cpu + gpu)
        func pct(_ n: Int) -> Int { Int((Double(n) * 100 / Double(total)).rounded()) }
        return "\(stage) [\(configured)]: ANE \(pct(neuralEngine))%, CPU \(pct(cpu))%, GPU \(pct(gpu))% of \(neuralEngine + cpu + gpu) ops"
    }
}

public enum KokoroPlacement {
    static func units(_ route: KokoroRoute, _ stage: KokoroAneStage) -> MLComputeUnits {
        let u = route.computeUnits
        switch stage {
        case .albert: return u.albert
        case .postAlbert: return u.postAlbert
        case .alignment: return u.alignment
        case .prosody: return u.prosody
        case .noise: return u.noise
        case .vocoder: return u.vocoder
        case .tail: return u.tail
        }
    }

    public static func name(_ c: MLComputeUnits) -> String {
        switch c {
        case .cpuOnly: return "CPU"
        case .cpuAndGPU: return "CPU+GPU"
        case .cpuAndNeuralEngine: return "CPU+ANE"
        case .all: return "all"
        @unknown default: return "?"
        }
    }

    /// Per-stage operation placement for the bundled chain with this route (needs iOS 17.4 / macOS 14.4).
    public static func analyze(modelsDirectory: URL, route: KokoroRoute) async -> [StagePlacement] {
        guard #available(iOS 17.4, macOS 14.4, *) else {
            return [StagePlacement(stage: "all", configured: route.rawValue, neuralEngine: 0, cpu: 0, gpu: 0, error: "needs iOS 17.4")]
        }
        var out: [StagePlacement] = []
        let dir = modelsDirectory.appendingPathComponent("kokoro-82m-coreml/ANE")
        for stage in KokoroAneStage.allCases {
            let configured = units(route, stage)
            let cfg = MLModelConfiguration()
            cfg.computeUnits = configured
            do {
                let plan = try await MLComputePlan.load(contentsOf: dir.appendingPathComponent(stage.bundleName), configuration: cfg)
                var counts = (ane: 0, cpu: 0, gpu: 0)
                if case .program(let program) = plan.modelStructure, let main = program.functions["main"] {
                    var stack: [MLModelStructure.Program.Block] = [main.block]
                    while let block = stack.popLast() {
                        for op in block.operations {
                            if let usage = plan.deviceUsage(for: op) {
                                switch usage.preferred {
                                case .neuralEngine: counts.ane += 1
                                case .gpu: counts.gpu += 1
                                case .cpu: counts.cpu += 1
                                @unknown default: counts.cpu += 1
                                }
                            }
                            stack.append(contentsOf: op.blocks)
                        }
                    }
                }
                out.append(StagePlacement(stage: stage.rawValue, configured: name(configured), neuralEngine: counts.ane, cpu: counts.cpu, gpu: counts.gpu, error: nil))
            } catch {
                out.append(StagePlacement(stage: stage.rawValue, configured: name(configured), neuralEngine: 0, cpu: 0, gpu: 0, error: error.localizedDescription))
            }
        }
        return out
    }
}
