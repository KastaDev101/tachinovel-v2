// swift-tools-version: 5.9
//
// HDVoice — TachiNovel's on-device voices (Kokoro-82M via FluidAudio's Core ML chain, Apple voice fallback).
//
//   HDVoiceCore    platform-free logic: which voice speaks each sentence (HybridScheduler), render-ahead,
//                  PCM post-processing, voice catalog/preferences, crash containment, statistics.
//                  Unit-tested on the macOS CI host: `swift test --package-path ios/App/HDVoice`.
//   HDVoiceKokoro  loads the BUNDLED model read-only and synthesizes a sentence (with lexicon phoneme
//                  overrides). Shared by the app and the CI voice check, so CI tests exactly what ships.
//   kokoro-check   macOS CLI used by CI (job "voice-quality"): loads the bundled model the way the app does,
//                  synthesizes a fixed sentence set with every offered voice and checks the audio.
//
// The app target links HDVoiceCore + HDVoiceKokoro as a local package (registered by tools/ios-project.ts).
// FluidAudio is pinned to an exact version (Apache-2.0, https://github.com/FluidInference/FluidAudio).
import PackageDescription

let package = Package(
    name: "HDVoice",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "HDVoiceCore", targets: ["HDVoiceCore"]),
        .library(name: "HDVoiceKokoro", targets: ["HDVoiceKokoro"]),
        .executable(name: "kokoro-check", targets: ["KokoroCheck"]),
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.5"),
    ],
    targets: [
        .target(name: "HDVoiceCore"),
        .target(
            name: "HDVoiceKokoro",
            dependencies: ["HDVoiceCore", .product(name: "FluidAudio", package: "FluidAudio")]
        ),
        .executableTarget(name: "KokoroCheck", dependencies: ["HDVoiceCore", "HDVoiceKokoro"]),
        .testTarget(name: "HDVoiceCoreTests", dependencies: ["HDVoiceCore"]),
    ]
)
