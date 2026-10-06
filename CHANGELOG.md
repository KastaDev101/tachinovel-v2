# Changelog

All notable changes to TachiNovel v2 are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) for the app version (`package.json`).

Add a line under **Unreleased** in every pull request that changes what the app does, how it is built or
how it is released. Group lines under Added, Changed, Deprecated, Removed, Fixed or Security.

## [Unreleased]

### Added

- Repository standards: README, contributing guide for people and agents, proprietary LICENSE,
  third-party notices, security policy, Dependabot (npm and GitHub Actions, weekly, grouped), pull
  request template and `.editorconfig`.
- Versioning and releases: `package.json` is the single version source (iOS marketing version =
  `major.minor.patch`, build number = CI run number); `node tools/release.ts prepare <version>`; a
  `release` workflow on `v*` tags publishes the unsigned IPA, its SHA-256 and a provenance attestation
  as a GitHub Release with these notes (docs/release.md).
- Native iOS shell (Capacitor 8.5, iOS 17+) around the v1 reader UI, with the v1 script core running in
  a Swift-owned JavaScriptCore context.
- Two build flavors: `personal` (built-in sources, LNReader JS plugins) and `store` (no bundled
  sources, declarative source definitions only, optional ads).
- Narration with Apple voices: background and lock-screen playback, Now Playing and remote commands,
  resume, auto-advance, full-screen Listen player, CarPlay list (needs the entitlement).
- Restore a v1 backup picked from Files.
- Car listening: in-app player for PC-narrated audio, with sentence highlighting.
- App icon and a launch screen that follows light and dark mode.
- CI: web checks, PC shell test in WebKit, unsigned simulator build with a smoke tour and screenshots,
  unsigned device IPA for sideloading, TestFlight job (waits for an Apple Developer account).
- Crash and hang reports from MetricKit, kept on the device: a summary line per report in Settings ›
  Diagnostics (Recent Problems, Send a Problem Report, Copy Full Diagnostics), and a "Share Crash & Hang
  Reports" button that shares the full reports as one JSON file. Nothing is uploaded.
- Swift quality gates in CI: SwiftLint (pinned, strict) and complete strict-concurrency checking with a
  warnings baseline, so new compiler warnings fail the build (CONTRIBUTING.md "Swift quality gates").

### Changed

- Typechecking uses TypeScript 7 (native compiler): `npm run typecheck` takes ~0.7 s instead of ~4.5 s
  on the dev PC; same files checked, same (zero) errors. Nothing in the repo uses the TypeScript JS API.
- Swift: main-thread-only types are now `@MainActor` (browser fetcher, presentation queue, device
  snapshot refresh); thread-safe image helpers are `nonisolated`; 106 concurrency warnings fewer.
- The package license field is now `UNLICENSED` (proprietary, all rights reserved; previously `MIT`).

[Unreleased]: https://github.com/KastaDev101/tachinovel-v2/commits/main
