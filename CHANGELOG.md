# Changelog

All notable changes to TachiNovel v2 are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) for the app version (`package.json`).

Pull requests don't edit this file: each adds a fragment in [changelog.d/](changelog.d/README.md), and
`node tools/release.ts prepare <version>` merges the fragments in here at release time.

## [Unreleased]

## [2.0.0-alpha.3] - 2026-10-07

### Added

- UI tests: the native-only surfaces with real taps on the simulator (document picker Cancel and swipe
  down, the next popup after a swipe, share sheet Close, reader brightness and keep-awake, Listen with the
  mini player and the car player's controls); the UI test job also fails on a crash report.
- Narrator voices for Chatterbox Nano: Settings › Voices › Expressive voices › Narrator voice. Voices can ship
  inside the app (`ios/App/App/BuiltInVoices/`, added with one command: `export_voice.py … --bundle-into
  ../tachinovel-v2 --default` or `node tools/built-in-voices.ts add <file> --default`); one of them is the
  default narrator voice, and Chatterbox's own voice stays selectable. Shipped voices can be chosen, not renamed
  or deleted, and are checked like imports when first listed and when loaded.
- Imported voices (personal flavor): voices designed on the PC (`tachinovel-narrator/py/export_voice.py`
  writes a `.tnvoice` file to iCloud Drive › TachiNovel-Voices) come in with Import voice… (Files) or Open in
  TachiNovel from Files and the share sheet. Each has ▶ Play (its preview, or Chatterbox Nano reading a line),
  Use, Rename and Delete. The chosen voice is what Chatterbox Nano reads with, kept across restarts; if its
  file is missing or invalid when the model loads, the default voice reads and the screen says why. Kokoro and
  Apple voice settings are separate and unchanged. docs/voice-import.md has the format and the steps.

### Security

- A `.tnvoice` file is checked before anything is kept: size caps before decompressing, only three allowed
  ZIP entries (no paths, no duplicates, no overlaps, no encryption or ZIP64), manifest schema with SHA-256
  per part, engine and model version, and the voice tensors' header parsed with bounds checks against the
  exact names, dtypes and shapes Chatterbox Nano's built-in voice has. Nothing in it is executed.

## [2.0.0-alpha.2] - 2026-10-07

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
- Accessibility checks: every control on the main screens (v1 screens, the Listen button, mini player
  and Listen player) must have a VoiceOver name, checked on the PC and in the simulator UI test.
- AltStore source: every release publishes `apps.json` on the rolling release `altstore-source`, so
  after adding the source URL once, AltStore offers new builds as an Update.
- Boot timing: the app logs when the library is really on screen (`boot: library visible …`), and the
  simulator smoke test reports tap → library per launch (`boot-times.txt`, a run notice).
- CI budgets: the `ios-ipa` job fails when the sideload IPA grows more than 10% over the committed
  baseline in `ci/budgets.json` (94.5 MB with the bundled Kokoro model), and the simulator smoke test
  warns when the cold-launch median (process start to library painted) is over its soft budget.
- In the car without a CarPlay app: CarPlay's Now Playing screen, the lock screen and Control Center show
  the chapter, the novel, "TachiNovel", the cover (cached for offline), the time in the chapter and its
  length for every voice. For live speech the length is estimated from the text and refined as sentences
  are spoken, without flicker.
- More › Voices › In the car › Car buttons: previous/next chapter (default) or back/forward 15 seconds,
  also for headphone and steering-wheel buttons. Scrubbing, speed and Siri ("pause", "resume", "next")
  work. With nothing loaded, play continues the novel listened to last.
- Prepare for the drive (on a novel's page): Kokoro renders the next 1, 3, 5 or 10 chapters into audio on
  the iPhone, now or while charging / on Wi-Fi (also as a background task). Prepared chapters play first,
  offline, with sentence highlighting, and are deleted after listening. Progress and storage are shown in
  the sheet and in More › Voices.
- Help › Listening: how to use it in the car (replaces the PC-narrator answers). docs/car.md.
- The simulator self-test drives remote commands and chapter changes and checks Now Playing and prepared
  audio. The Voice Lab shows Now Playing, the commands and the silence between chapters.
- App Store compliance groundwork: the Open Source Licenses page (More › About) is built from
  THIRD_PARTY_NOTICES.md, and a test fails when a bundled npm package has no notice; a test keeps the
  privacy manifest in line with the required-reason APIs the Swift code uses; draft privacy policy and
  terms of use in docs/legal (DRAFT, not legal advice).
- Settings › Voices › "Expressive voices (experimental)" (also in the Voice Lab): expressive voices that act (emotions, laughs and sighs, character
  voices) running on the iPhone, as a test. Chatterbox Nano (Resemble AI, MIT) and NeuTTS-2E (Neuphonic,
  NeuTTS Open License) through FluidAudio's Core ML ports. The models (0.75 GB / 1.37 GB) are never
  bundled: the app downloads one on demand (Wi-Fi only, size shown, two taps, deletable), pinned by
  Hugging Face revision and SHA-256 per file (`ios/expressive-models.lock.json`). Play a sample (calm
  narration, emotional dialogue, a 3-minute passage or pasted text with guessed emotions and speakers)
  with an engine and with Kokoro for an A/B, or run a speed test (load, time to first audio, × real time,
  memory, thermal). Kokoro reads any sentence an expressive engine can't deliver in time, and every
  sentence while the app is in the background (these engines use the GPU). A crash inside an
  experimental engine turns them off after two in a row. Narration itself is unchanged.
- CI: `expressive-bench` (manual, or the `expressive-bench` label on a pull request): the expressive
  engines on the macOS runner with an ASR check and listening samples. docs/expressive-tts.md has the
  research, the numbers and a 5-minute phone checklist.
- Listen player: a speed slider (0.5×–2.5× in 0.05 steps) next to the preset chips (a chip snaps the
  slider; the slider lights up the chip it sits on), and "Voice volume" (0–150 %, with a limiter above
  100 % so a boosted voice doesn't distort). Both are saved and apply to every voice: Kokoro, the system
  voice and PC audio. Now Playing shows the speed.
- Narrator mode (Settings › Voices › Narrator mode), with a switch for each piece:
  - optionally (Advanced), quoted speech in its own dialogue voice, with a second voice for the other
    speaker; by default one narrator voice reads everything;
  - natural pauses that follow punctuation and conversation;
  - slight variation in pace from sentence to sentence;
  - studio sound: EQ, gentle compression, even loudness at −16 LUFS, and an optional room tone.
- ▶ Without / ▶ With compares narrator mode on a short passage, here and in the Voice Lab.
- Prepare for the drive uses the same settings.
- Web updates (personal flavor): the app downloads signed web bundles (UI and core) published with each
  release, verifies their Ed25519 signature and checksum, and switches at the next launch; if an update
  fails to start twice, it rolls back to the built-in bundle by itself. More › About › App Update shows
  the running bundle and checks for updates. Not in the store flavor.
- Narrator mode: phrase breaks (on by default). Short pauses at commas, semicolons and dashes, a longer one
  after an opening phrase, and a lighter one before "but", "and then", "while" and "because". These are
  the values Kasta picked by ear on the PC.
- Narrator mode now starts with the settings Kasta picked by ear on the PC:
  - on, with one narrator voice;
  - relaxed pauses (a new "Pause length" choice: Relaxed or Natural);
  - phrase breaks and light studio sound (compressor 1.5:1);
  - no pace variation and no room tone.
  Narrator settings saved by earlier builds are replaced by these.
- QA: a click-everything UI crawler (`npm run crawl`, docs/qa.md) taps every control of every reachable
  screen of the built app in WebKit (iPhone 16 Pro, dark and light, seeded synthetic library, fixed
  clock, no network) and reports crashes, console errors, dead controls, hung or slow taps, broken Back,
  layout escapes and covered controls, with screenshots. CI workflow `ui-crawler` runs it on pull
  requests and nightly.
- Diagnostics Folder (More › About › Diagnostics): pick a folder once (for example in iCloud Drive) and
  the app copies its log, crash and hang reports, the Voice Lab numbers and a short screen trail there
  every few minutes and when it goes to the background. Shake the phone (or use the row) to save a problem report with a
  screenshot, the log tail and the current screen.
- CI simulator smoke: a native tour taps through the document picker (Restore from Files…, swiped away and
  cancelled), the Listen player, the share sheet, Listen, the mini player and car player controls,
  brightness and keep-awake, with a screenshot every 4 s; it fails on a crash or a crash report (the
  Debug-only `SmokeResponder` answers system sheets like a user would).
- Release dry run: a manual run of the `release` workflow with a version rehearses the whole
  release from `main` (prepare on the runner, IPA build, draft release checked and deleted; no tag,
  nothing published), and a test runs `prepare` then `verify-tag` on a copy of the tree.
- `node tools/revendor-v1.ts <v1 commit>`: one command to move `vendor/v1` to a v1 commit, re-check the
  build-time patches on both flavors, typecheck and test, with rollback on failure.
- Simulator UI test (XCUITest, CI job `ios-ui-tests`): first launch, restore a synthetic sample backup
  through Backup & Restore, open and read a novel, Settings, Listen with the Apple voice; screenshots as
  the `ui-test-screenshots` artifact (docs/ui-tests.md).
- Voice mixer: More › Voices › Mix a voice blends two Kokoro voices with a slider. Listen to it, name it
  and save it, then use it as the default voice or for one novel. Mixes can be edited and deleted.
- On-device voices: Kokoro-82M runs on the iPhone and is bundled with the app (FluidAudio 0.17.5 Core ML,
  6 English voices, about 93 MB in the bundle, pinned by revision and SHA-256 in
  `ios/kokoro-models.lock.json` and fetched at build time, never committed). It is the default voice for
  every chapter. The Apple voice takes over sentence by sentence when Kokoro is loading, fails, falls
  behind or the phone is hot, and Kokoro takes over again once it is ahead.
- More › Voices: the voices with ▶ samples, a default voice, the Apple fallback with a Premium-voice
  hint, a pronunciation lexicon (global and per novel, also applied to Kokoro), Kokoro on/off and
  Advanced › "Use PC audio when available" (off by default). A voice per novel from the Listen player.
- The reader highlights the sentence being spoken, whichever voice speaks it.
- A hidden Voice Lab (About › tap the version 5 times): time to first audio, real-time factor,
  compute units, memory, thermal state, fallbacks and crashes, and a copyable report.
- CI: `voice-quality` (HDVoice unit tests, every voice checked on the bundled model, ASR round trip)
  and `voice-simulator` (Listen flow, highlight and the Apple fallback in the simulator). `ios-ipa`
  reports the IPA and app size.
- All 28 English Kokoro voices (20 American, 8 British) are built in, up from 6. The voice pickers group them
  by accent and gender, list the best first and show Kokoro's own grade for each, with a ▶ sample. The app
  grows by about 11.5 MB.

### Changed

- ESLint for v2's own code: typescript-eslint type-aware rules and per-context globals (core: no
  DOM/browser/Node; UI: no Node, no network, no `__native`); CI job `lint`. TypeScript runs side by side:
  TypeScript 7 typechecks, the TypeScript 6 API (`@typescript/typescript6` alias) serves typescript-eslint.
- Typechecking uses TypeScript 7 (native compiler): `npm run typecheck` takes ~0.7 s instead of ~4.5 s
  on the dev PC; same files checked, same (zero) errors.
- Swift: main-thread-only types are now `@MainActor` (browser fetcher, presentation queue, device
  snapshot refresh); thread-safe image helpers are `nonisolated`; 106 concurrency warnings fewer.
- The package license field is now `UNLICENSED` (proprietary, all rights reserved; previously `MIT`).
- v2's own screens follow the system text size (Dynamic Type) like the rest of the app and grow
  instead of clipping: the mini player, the Listen player, the Voices screen, the Voice Lab and the
  "Share Crash & Hang Reports" button. VoiceOver reads the mini player as "<novel>, <chapter>", with a
  hint that it opens the player.
- Boot timing line and simulator report: adds when WebKit finished loading and parsing the page, and the
  app's own cold-start time (process start → library painted) next to the tap-based total.
- The launch screen hides on the first frame that shows library content (at the latest after 3 s)
  instead of a fixed delay after the boot call, so it never reveals an empty library and doesn't wait
  needlessly.
- Chapters continue into the next without a pause: the next chapter's text is fetched ahead and Kokoro
  renders its first sentences before the current chapter ends.
- After a call or a navigation prompt, prepared and PC audio continue 2 seconds early.
- The CarPlay templates app is behind the `TNCarPlayTemplates` flag (`TN_CARPLAY_TEMPLATES=YES` once
  Apple grants the CarPlay audio entitlement).
- The Listen player shows a seek bar for live speech too (estimated length).
- Privacy manifest: declares the system boot time API (reason 35F9.1: time between events inside the
  app, for the Now Playing chapter clock and the silence between chapters).
- Changelog entries are now fragments in `changelog.d/` (one file per pull request), merged into
  CHANGELOG.md by `node tools/release.ts prepare`; the CI job `changelog` asks app-changing PRs for one.
- CI: docs-only pull requests skip the macOS jobs (new `changes` job); pushes to main, tags and manual
  runs still build everything.
- CI: a pull request runs only the macOS jobs its files can affect (UI tests for app code, the device
  IPA for native code and the build, the voice jobs for the voice engine and its UI); main, tags and
  manual runs still run everything.
- Listen is in the reader's bottom bar now, next to Chapters, Auto-scroll, Night and Appearance, so it
  shows and hides with the bars. While listening it opens the player, and the mini player in the reader
  follows the bars too. The floating headphones button is gone.
- The mini player and the Listen player say which voice is speaking: "Kokoro · Heart", or "System voice
  (fallback)" with the reason (Kokoro is starting, catching up, the iPhone is hot, unavailable, off).
- All voices play through the app's own audio engine: the system voice is rendered into it, and PC audio
  plays through an engine file player instead of AVPlayer, so speed and volume work the same everywhere.
- CI: the UI crawler runs every 2 hours on main (was nightly); scheduled runs post only new failures to
  the issue "UI crawler: new failures on main" and close it when a run is clean again.
- UI crawler: a control that does nothing on one tap but reacts to five quick taps (a hidden gesture,
  like About › version → Voice Lab) is reported as a warning instead of a dead control.
- UI crawler: a control covered by a toast is a warning (toasts expire on their own; whether one is still up
  depended on timing and failed runs at random).
- UI crawler: crawls the Voices screens (Voices, voice picker, pronunciations) as screens of their own,
  resets the mock voice settings on every launch, and relaunches once before calling a state unreachable.
- UI crawler: fails on a full-screen dialog that isn't `aria-modal`.
- Free sideload (no iCloud): library, progress, settings, sources, backups and the log mirror now live in
  the app's Documents folder, so Files shows them as On My iPhone › TachiNovel (backups and logs can be
  copied off the phone). Data from earlier builds is moved once, crash-safely: copied and verified first,
  the old copy removed only after a launch on the new layout worked.
- v2's own wording in the v1 screens: Backup & Restore, Storage, About and Help say where v2 keeps your
  data (iCloud Drive › TachiNovel, or Files › On My iPhone › TachiNovel in the free sideload) instead of
  Scriptable's folder; the listening help describes the built-in player instead of BookPlayer; What's New
  shows v2's releases.
- PC-narrated audio is opt-in (Settings › Voices › Advanced). With it off, More shows "Listen" (the
  Listen player) instead of the PC narrator's "Listen in the Car" screen.
- Release and TestFlight builds fetch the bundled voice model.

### Fixed

- While listening, the mini player covered the tab bar (no tab could be tapped), the reader's bottom
  bar and the novel page's Resume button; it now sits above them, and scrolling content gets room at its
  end so nothing stays under it. "Open the player" (Listen in the Car) no longer hides the screen's last
  rows and its label is centered. The Listen button and "Open the player" only show for the screen on
  top. Found by the UI crawler.
- Continuing a different novel from CarPlay or the Listen player no longer shows the previous novel's
  cover in Now Playing.
- A crash when the Apple voice stood in and was slow to start: the sentence was handed to the system
  synthesizer a second time, which iOS doesn't allow (found by the simulator voice self-test).
- A crash when a prepared or PC-narrated chapter started: its position was read before the audio engine
  had a valid clock.
- Chapter illustrations that a site blocks for direct loading (for example Stonescape's, which send
  Cross-Origin-Resource-Policy) showed nothing: the copy the core fetches (`cache/img-…`) is now served
  to the page, like covers.
- The speed slider in the Listen player changes the speed (only the chips did): it applies while dragging
  and when released, for every voice, and the player no longer rebuilds the slider under the finger. Same
  for "Voice volume". Speech re-renders once the slider rests; PC audio follows instantly.
- The Listen player keeps its list scrolled where you left it and its buttons in place while playing (it
  rebuilt itself every second).
- The voice picker no longer covers the Listen player: a closing panel stops catching taps at once (it used
  to for its 340 ms slide-out), and opening or closing the player closes any Voices panel left open.
- Toasts ("No new chapters yet", "Bookmarked"…) no longer cover the mini player or the Listen button: they
  sit above the mini player while it shows, and the mini player is placed above the reader's bar where the
  bar ends up, not where it is mid-slide.
- A document picker (Restore from Files…, Link audio folder) swiped down instead of cancelled answered
  nothing, which left the native popup queue waiting forever: no alert, action sheet, share sheet or
  picker appeared again until the app was restarted. A picker that goes away unanswered now counts as
  cancelled.
- A document picker that took more than a second to come up (its view service starts first: cold start,
  slow device) was answered as cancelled while it appeared, so the file picked in it went nowhere
  (Restore from Files… and Link audio folder did nothing). A picker now gets up to 15 s to appear.
- VoiceOver could read and tap the screen behind the car player, the Voices screens and Voice Lab: they
  are now modal dialogs.
- From v1 1166c74 (found by the UI crawler): a source's filter Reset and the novel page's Jump Go are
  disabled until they would do something, the reader keeps its end notes above the bottom bar, and the
  search fields' clear button works on touch.
- `npm run vendor:v1` wrote CRLF files on Windows (git archive followed the v1 repo's `core.autocrlf`).
- Status bar text stays readable: it follows what is painted under it (a forced Light/Dark appearance,
  the reader's theme, dark overlays) instead of only the system appearance.
- CI: the Debug simulator build sometimes failed with a Swift compiler crash (swift-frontend 6.3.3,
  SendNonSendable diagnostics on the share bridge); the share call no longer captures a mutable array
  across queues.
- CI: the simulator UI test no longer fails on taps computed mid-animation or on a web view that
  reloads its page; it waits for elements to settle, retries taps that are safe to repeat, waits out a
  WebContent reload, and reports each workaround as a warning with WebKit's log.
- A long sentence with a pronunciation override keeps the override. It used to fall back to Kokoro's own
  pronunciation when the sentence was too long for one pass.
- When iOS restarts the web view (memory pressure during long reading sessions), the app comes back on
  the screen you were on (tab, novel, reader chapter at its saved position) instead of the library or a
  blank page; debounced state is flushed first.

### Security

- GitHub Actions are pinned to full commit SHAs (version in a comment), kept current by Dependabot; a
  test rejects unpinned actions.
- Security review against the OWASP Mobile Top 10 (docs/security-review.md). Fixed: the web view is no
  longer inspectable in Release builds; the local file router only serves files inside the web bundle;
  navigations to non-web schemes are refused; core log lines are private in the Release system log;
  cookie copies use RFC 6265 domain matching; deep-link paths must stay on the source's own site.

[Unreleased]: https://github.com/KastaDev101/tachinovel-v2/compare/v2.0.0-alpha.3...HEAD
[2.0.0-alpha.3]: https://github.com/KastaDev101/tachinovel-v2/compare/v2.0.0-alpha.2...v2.0.0-alpha.3
[2.0.0-alpha.2]: https://github.com/KastaDev101/tachinovel-v2/releases/tag/v2.0.0-alpha.2
