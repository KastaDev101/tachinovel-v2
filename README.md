# TachiNovel v2

A web-novel reader for iPhone with built-in narration: a native iOS app (Capacitor 8 + Swift) around the
TachiNovel v1 reader UI and its script core. Library, browse and search, an infinite-scroll reader with
progress sync, and "Listen" mode that reads chapters aloud on the lock screen and in the car.

**Status: pre-release (`2.0.0-alpha`).** Not on the App Store and not signed. CI builds an unsigned IPA
that can be sideloaded for personal testing ([docs/how-to-test-tonight.md](docs/how-to-test-tonight.md)).
Plans and open decisions are in [docs/roadmap.md](docs/roadmap.md).

## How it fits together

| Layer | Where | What it does |
|---|---|---|
| UI | WKWebView (Capacitor); `vendor/v1/src/ui` + `src/ui` | Rendering and interaction (Preact), sanitizing (DOMPurify + strict CSP) |
| Core | JavaScriptCore context owned by Swift; `vendor/v1/src/script` + `src/core` | Network, storage, sources, chapters, progress, updates |
| Native | Swift; `ios/App/App/Native` | HTTP, files/iCloud, native UI, narration (AVSpeech), CarPlay, StoreKit, background refresh |

Details, contracts and the security model: [docs/architecture.md](docs/architecture.md). The v1 code is a
read-only snapshot in `vendor/v1/` (see `vendor/v1/VENDORED.md`); v2 never edits it.

Two build flavors: **personal** (default; built-in sources, LNReader JS plugins) and **store** (App Store
candidate; no bundled sources, declarative source definitions only). See architecture.md §6.

## Build and test

Requirements: Node 24+ (any OS). The iOS app itself needs Xcode 26+ on macOS; without a Mac, GitHub
Actions compiles and runs it in the simulator.

```sh
npm ci                       # dev dependencies (local to the repo)
npm run typecheck            # node, core and UI contexts
npm run build                # personal flavor → www/   (npm run build:store for the store flavor)
npm test                     # unit + core-in-a-bare-JS-context tests (vitest)
npm run test:shell           # UI + core in WebKit with Capacitor's real bridge (needs Playwright's WebKit)
npm run lint                 # ESLint (type-aware, per-context globals)
npm run check                # typecheck + lint + build + test + Xcode project check
node tools/ios-project.ts    # register new Swift files in the Xcode project (no Xcode needed)
npx cap sync ios             # copy www/ into the iOS project
```

On a Mac: `npx cap sync ios`, then open `ios/App/App.xcodeproj` and run the `App` scheme.

## CI

[`.github/workflows/ios.yml`](.github/workflows/ios.yml) runs on pull requests, pushes to `main` and
manual dispatch:

| Job | What |
|---|---|
| `web` | typecheck, both flavors, unit tests, Xcode project check |
| `lint` | ESLint with type-aware rules |
| `shell` | PC shell test in WebKit, screenshots as artifacts |
| `ios-compile + simulator smoke` | unsigned simulator build, launch and screenshot tour |
| `ios-ipa (unsigned, for AltStore)` | unsigned device build packaged as an `.ipa` artifact |

All four are required checks on `main`. TestFlight upload is wired but waits for an Apple Developer
account.

Releases: tag `v<version>` on `main` and [`.github/workflows/release.yml`](.github/workflows/release.yml)
publishes the unsigned IPA as a GitHub Release with the CHANGELOG notes. Versioning and the release
procedure: [docs/release.md](docs/release.md).

## Contributing

`main` is protected: every change goes through a pull request with green checks. The workflow (also for
AI agents working in this repo) is in [CONTRIBUTING.md](CONTRIBUTING.md); notable changes go in a
[changelog fragment](changelog.d/README.md) and end up in [CHANGELOG.md](CHANGELOG.md) at release time. Security issues: [SECURITY.md](SECURITY.md).

## License

Copyright (c) 2026 KastaDev101. **All rights reserved**; see [LICENSE](LICENSE). The source is public to
read, not licensed for reuse. Third-party components keep their own licenses:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Screens and flow are modeled on
[LNReader](https://github.com/LNReader/lnreader) (MIT).
