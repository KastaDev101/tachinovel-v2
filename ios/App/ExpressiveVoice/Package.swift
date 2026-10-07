// swift-tools-version: 5.9
//
// ExpressiveVoice — EXPERIMENTAL expressive on-device voices for TachiNovel (docs/expressive-tts.md).
// A spike: exposed only in the hidden Voice Lab ("Experimental engines"); the narration player keeps using
// HDVoice (Kokoro + Apple). Separate from ios/App/HDVoice on purpose, so the shipping voice code is untouched.
//
//   ExpressiveCore     platform-free: pinned model files (revision + SHA-256, generated from
//                      ios/expressive-models.lock.json), the verified downloader, engine catalog, per-engine
//                      text/style mapping and chunking, keep-up statistics. Unit-tested on the macOS runner:
//                      `swift test --package-path ios/App/ExpressiveVoice`.
//   ExpressiveEngines  FluidAudio's Core ML ports behind one protocol (ExpressiveSynthesizer):
//                      Chatterbox Nano (MIT), NeuTTS-2E (NeuTTS Open License), Pocket TTS (CC-BY-4.0).
//   expressive-bench   macOS CLI for the workflow_dispatch benchmark (.github/workflows/expressive-bench.yml):
//                      downloads with the same downloader the app uses, renders the Voice Lab samples,
//                      measures load, time to first audio, real-time factor and memory, writes WAVs.
//
// FluidAudio is pinned to the SAME exact version as ios/App/HDVoice (one copy in the app; a test checks it).
import PackageDescription

let package = Package(
    name: "ExpressiveVoice",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "ExpressiveVoice", targets: ["ExpressiveCore", "ExpressiveEngines"]),
        .executable(name: "expressive-bench", targets: ["ExpressiveBench"]),
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.5"),
    ],
    targets: [
        .target(name: "ExpressiveCore"),
        .target(
            name: "ExpressiveEngines",
            dependencies: ["ExpressiveCore", .product(name: "FluidAudio", package: "FluidAudio")]
        ),
        .executableTarget(name: "ExpressiveBench", dependencies: ["ExpressiveCore", "ExpressiveEngines"]),
        .testTarget(name: "ExpressiveCoreTests", dependencies: ["ExpressiveCore"]),
    ]
)
