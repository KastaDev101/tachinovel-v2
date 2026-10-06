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

### Changed

- The package license field is now `UNLICENSED` (proprietary, all rights reserved; previously `MIT`).

### Fixed

- While listening, the mini player covered the tab bar (no tab could be tapped), the reader's bottom
  bar and the novel page's Resume button; it now sits above them, and scrolling content gets room at its
  end so nothing stays under it. "Open the player" (Listen in the Car) no longer hides the screen's last
  rows and its label is centered. The Listen button and "Open the player" only show for the screen on
  top. Found by the UI crawler.

[Unreleased]: https://github.com/KastaDev101/tachinovel-v2/commits/main
