// swift-tools-version: 5.9
//
// ExpressiveVoice — Nephis's on-device voice for TachiNovel (docs/expressive-tts.md): Pocket TTS, her flow engine and
// her studio. Separate from ios/App/HDVoice (Kokoro + Apple, her backup voices) on purpose.
//
//   ExpressiveCore     platform-free: pinned model files (revision + SHA-256, generated from
//                      ios/expressive-models.lock.json), the verified downloader, engine catalog, per-engine
//                      text/style mapping and chunking, keep-up statistics. Unit-tested on the macOS runner:
//                      `swift test --package-path ios/App/ExpressiveVoice`.
//   ExpressiveEngines  FluidAudio's Pocket TTS Core ML port (CC-BY-4.0) behind one protocol (ExpressiveSynthesizer),
//                      her flow engine (NephisFlowSynth) and her studio (NephisStudio).
//   expressive-bench   macOS CLI for the workflow_dispatch benchmark (.github/workflows/expressive-bench.yml):
//                      downloads with the same downloader the app uses, renders the Voice Lab samples,
//                      measures load, time to first audio, real-time factor and memory, writes WAVs.
//
// FluidAudio is the SAME vendored copy as ios/App/HDVoice uses (one copy in the app; a test checks it).
import PackageDescription

let package = Package(
    name: "ExpressiveVoice",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "ExpressiveVoice", targets: ["ExpressiveCore", "ExpressiveEngines"]),
        .executable(name: "expressive-bench", targets: ["ExpressiveBench"]),
    ],
    dependencies: [
        // FluidAudio 0.17.5, vendored with TachiNovel's Pocket TTS changes (ios/App/Vendor/FluidAudio/README.md).
        .package(path: "../Vendor/FluidAudio"),
    ],
    targets: [
        .target(name: "ExpressiveCore"),
        .target(
            name: "ExpressiveEngines",
            dependencies: ["ExpressiveCore", .product(name: "FluidAudio", package: "FluidAudio")]
        ),
        .executableTarget(name: "ExpressiveBench", dependencies: ["ExpressiveCore", "ExpressiveEngines"]),
        // Resources: BreathPolish's PC test vector (a 4 s piece of her studio read and what the PC made of it).
        .testTarget(name: "ExpressiveCoreTests", dependencies: ["ExpressiveCore"], resources: [.copy("Resources")]),
    ]
)
