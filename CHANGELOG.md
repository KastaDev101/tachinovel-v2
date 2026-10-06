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

- Typechecking uses TypeScript 7 (native compiler): `npm run typecheck` takes ~0.7 s instead of ~4.5 s
  on the dev PC; same files checked, same (zero) errors. Nothing in the repo uses the TypeScript JS API.
- The package license field is now `UNLICENSED` (proprietary, all rights reserved; previously `MIT`).

[Unreleased]: https://github.com/KastaDev101/tachinovel-v2/commits/main
