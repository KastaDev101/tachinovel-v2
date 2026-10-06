# TachiNovel v2 — architecture

Status: working scaffold, 2026-10-06. The web layer and the core build and are tested on Windows; the
Swift layer is written but has **never been compiled** (no Mac). The GitHub Actions macOS job is the
first compiler it will meet (decision D1 in roadmap.md). Research sources carry dates; "acc." =
accessed 2026-10-06.

## 1. Goal and shape

v2 is v1 (the Scriptable reader) in a native iOS shell, reusing v1's UI and script logic **without
editing v1**:

```
┌──────────────────────────── iOS app process ────────────────────────────────────────────┐
│                                                                                           │
│  WKWebView (Capacitor 8.5.2)                Swift (main thread)          Swift (core queue)│
│  ┌──────────────────────────┐   Core.call   ┌───────────────────┐  call  ┌──────────────┐ │
│  │ v1 UI, unchanged          │ ────────────► │ CorePlugin        │ ─────► │ CoreHost     │ │
│  │  + capacitor-client.ts    │ ◄──────────── │                   │ ◄───── │  JSContext:  │ │
│  │  + prelude (wake lock,    │  "event"      │ NarrationPlugin   │        │  core.js =   │ │
│  │    splash, status bar)    │               │ StorePlugin       │        │  v1 services │ │
│  │  + narration overlay      │ ◄──progress── │ TachiNativePlugin │        │  + v2 platf. │ │
│  │  + ads policy (--ads)     │               │ NarrationController ─req─► │  + plugin    │ │
│  └──────────────────────────┘               │ CarPlay scene      ─req─►  │    hosts     │ │
│        ▲ capacitor://localhost/covers/*      │ BackgroundRefresh  ─req─►  │  __native ──►│─┼─► URLSession, FileManager,
│        └─ TachiRouter → App Support files    └───────────────────┘        └──────────────┘ │   iCloud, UIKit, ImageIO
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

| Context | Runs | Has | Job |
|---|---|---|---|
| **UI** — WKWebView | v1 `src/ui` (Preact) + v2 `src/ui` additions | DOM, JIT, Capacitor bridge | Rendering, interaction, sanitizing (DOMPurify + CSP), as in v1 |
| **Core** — JavaScriptCore `JSContext` owned by Swift | v1 `src/script` services/handlers + v1 `src/plugin-host` (personal) + v2 `src/core` | `__native` (sync file IO, async HTTP/UI), no DOM, **no JIT** | Network, storage, sources, chapters, progress, updates — exactly v1's script side |
| **Native** — Swift | `ios/App/App/Native/**` | UIKit, AVFoundation, MediaPlayer, CarPlay, StoreKit, BackgroundTasks | Platform services, narration, purchases, CarPlay, background refresh |

v1 already split the app this way (CLAUDE.md "Architecture"): a JSC script context + a WebView UI over a
message bridge. v2 keeps the split and replaces Scriptable with our own host.

## 2. Key decision: the core runs in a native-owned JSContext

Options considered for "the script side" (v1 ran it in Scriptable's JSC):

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. JSContext owned by Swift** (chosen) | Same engine and restrictions as v1's Scriptable context (v1 code + polyfills run unchanged); **keeps running when the WebView is suspended** → lock-screen auto-continue, CarPlay, BGAppRefreshTask; synchronous native file API (v1's `FileStore` is sync); plugin code never shares a realm with the DOM or the Capacitor bridge | No JIT (v1 measured ~40 ms for a 245 KB Royal Road page in Scriptable's JSC — fine); more Swift to write and maintain; needs a Mac to debug (`isInspectable`) | **Chosen** |
| B. Core in the UI WebView, CapacitorHttp + @capacitor/filesystem | Least native code; JIT | WebView JS is suspended in the background ("by design", https://developer.apple.com/forums/thread/64150, June 2020) → no lock-screen auto-continue or background refresh; Filesystem API is async but v1's FileStore contract is sync; plugins would run next to the DOM and `window.Capacitor`; CSP needs `unsafe-eval` for plugins | Rejected |
| C. Core in a Web Worker | JIT; off the UI thread | Same background suspension; workers can't reach Capacitor plugins (proxy through main); still async files | Rejected |
| D. Rewrite services in Swift | Fastest runtime | Throws away v1's tested TS core; two codebases | Rejected |

Facts this relies on: JSC only JITs with the `dynamic-codesigning`/`allow-jit` entitlement, which App
Store apps don't have (https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/jit/ExecutableAllocator.cpp);
JSC drains the microtask queue when the outermost API call returns, so promises settle between Swift
calls (https://bugs.webkit.org/show_bug.cgi?id=161942, fixed 2021-06-15); one VM per serial queue is the
thread-safety model (https://developer.apple.com/documentation/javascriptcore/jsvirtualmachine).
Capacitor's own Background Runner uses the same pattern (https://capacitorjs.com/docs/apis/background-runner).

The task suggested CapacitorHttp and the Filesystem/iCloud plugins: they solve CORS and files for code
running **in the WebView**. With the core in a JSContext, the same capabilities come from URLSession and
FileManager directly (no CORS/CORP at all, real cookies, exact sizes, iCloud via the ubiquity container,
which @capacitor/filesystem doesn't support — https://capacitorjs.com/docs/apis/filesystem, acc.).

## 3. Contracts

1. **`src/core/native-api.ts`** — the `__native` host API (Swift ↔ core). One TS interface, one Swift
   implementation (`Native/Core/NativeHostAPI.swift`), one Node mock (`tests/helpers/native-mock.ts`).
   Only strings, numbers, booleans, string arrays and callbacks cross; JSON for structures; sync members
   are local and cheap, async ones call `cb(error, result)` once, on the core queue.
2. **Bridge protocol = v1's** (`vendor/v1/src/shared/contracts/protocol.ts`): same Request/Response/Event
   envelopes and `BridgeMethods`. Transport: Capacitor plugin `Core` (`Core.call({json}) → {json}`,
   listener `event`). No long-poll, no 50 ms ticks; calls are concurrent.
3. **v2-only core methods** (`src/core/core.ts`): `v2.info`, `narration.chapterText` (chapter → narration
   script), `updates.backgroundCheck` (BGAppRefreshTask, 25 s budget), `app.background` (flush),
   `app.openLink` (deep links → v1's `app.deepLink` event).
4. **Plugin JS APIs:** `Narration` (src/ui/native/narration.ts), `Store` (src/ui/monetization/entitlements.ts),
   `TachiNative.setKeepAwake`.

### v1 Scriptable → v2 mapping
| v1 (Scriptable) | v2 |
|---|---|
| `Request` (no CORS) | `__native.http` → URLSession (shared cookies, total timeout, charset decoding, Set-Cookie split) |
| hidden `WebView` fetch / solve challenge | `BrowserFetcher` / `ChallengeViewController` (WKWebView, plugin UA, cookies copied into URLSession) |
| `FileManager.local()` …/Documents/TachiNovel | `Library/Application Support/TachiNovel` (cache/covers/downloads/imports excluded from iCloud Backup) |
| `FileManager.iCloud()` …/Scriptable/TachiNovel | ubiquity container `Documents/TachiNovel` (Files app shows "TachiNovel"); falls back to local without the entitlement |
| `importModule` of iCloud `app/lib/*.js` | `__native.bundle.loadModule` from the app bundle (`public/core/lib/*.js`) — no evicted-placeholder failure |
| `Alert`, `ShareSheet`, `DocumentPicker`, `Safari.open` | `UIAlertController`, `UIActivityViewController`, `UIDocumentPickerViewController`, `UIApplication.open` |
| `SFSymbol` → PNG | `UIImage(systemName:)` rendered @3x |
| `DrawContext` image resize | ImageIO thumbnailing (decodes WebP/HEIC, never the full bitmap) |
| `Device.*`, brightness | `DeviceSnapshot` (main-thread snapshot) / `UIScreen.brightness` |
| `Timer` | `__native.timers` (DispatchWorkItem on the core queue) |
| WebView long-poll bridge | `CorePlugin` (concurrent, ~1 hop each way) |
| UI `file://` + relative `covers/…` | `capacitor://localhost` + `TachiRouter` maps `/covers/*` to the local store |
| `navigator.wakeLock` (unreliable) | shimmed to `UIApplication.isIdleTimerDisabled` |
| visibilitychange flush (Scriptable may be killed) | still there, plus native `app.background` with a background-task assertion |

### Failure handling at the boundary
- **Core not started yet:** CoreHost buffers every request (UI and native) until core.js registers its
  handler, then drains them in order (tested: `core startup` in tests/core-vm.test.ts).
- **Core can't start:** no JSContext, core.js missing, core.js throws before registering, or no handler
  after 20 s → every buffered and later request is answered with `UNKNOWN: The app core failed to start:
  <reason>` (Swift `CoreHost.failStartup`). If JS boot itself fails after registering (e.g. storage),
  core.js answers every request with the same message and the real reason (tested with an injected
  file-system fault).
- **Native popups** (action sheets, alerts, share sheet, document picker, browser-check sheet) go through
  `PresentationQueue` (NativeUI.swift): one at a time, a second request waits for the first, and every
  request is answered exactly once, as "cancelled" if UIKit can't show it (no window, a controller stuck
  animating for 4 s, or a silently refused presentation detected after 1 s).
- **Hidden WebView fetches** are serialized with a per-request watchdog (timeout + 5 s) so a suspended
  web content process can't wedge later fetches. POSTs run as in-page `fetch()` on the site's origin
  (v1 3a25883 parity: `BrowserFetchOptions`).
- **Logs** use v1's `LogFile` (device log, mirrored to iCloud at most once a minute and on errors), so
  v1's Diagnostics screen (`app.logs`) works unchanged.

## 4. Security model
- **UI:** v1's strict CSP (script hash, `connect-src 'none'`, no frames/objects) plus `capacitor:` images;
  DOMPurify as in v1. Capacitor's bridge is a WKUserScript, unaffected by page CSP.
- **Core:** `core.js` reads `__native` and **deletes the global** before any plugin code exists, so
  plugins (v1 sandbox shadows Scriptable globals by name) cannot reach file or HTTP natives through
  globals. Plugins never share a realm with the DOM or `window.Capacitor`.
- **Store flavor:** no JS plugin host compiled in; `importLazy('plugin-host')` refuses; sources are JSON
  specs interpreted by `src/core/declarative/engine.ts` (selectors, JSON paths, regexes — no expressions).
- **Native surface:** bundle reads reject `..`; covers routing accepts flat file names only; `openUrl`
  accepts http(s) only; deep links are validated by the core (installed sources only).

## 5. Reusing v1

- `vendor/v1/` is a read-only snapshot of v1's committed state (commit `3a25883`, refreshed
  2026-10-06; see `vendor/v1/VENDORED.md`); `@v1/*` imports resolve there. `V1_ROOT=../tachinovel npm run build` builds
  against the live v1 repo instead; `npm run vendor:v1` refreshes the snapshot.
- **No v1 file is edited.** Build-time adjustments (tools/v1.ts), each asserted to match exactly once:
  1. v1's `src/ui/bridge/phone-client.ts` import → `src/ui/capacitor-client.ts` (same export name);
  2. store flavor: `BUILTIN_SOURCES = []`, `DEFAULT_REPOS = []`, empty LNReader verification table.
- v1 extension points used as-is: `ServicesOptions.loadPluginHost` (source gate), `solveChallenge`,
  `App.attachEvents`, `App.deliverDeepLink`, `App.flush`.
- Requested upstream (would remove the patches): make built-in sources, default repos and the
  verification table `ServicesOptions` fields; a reader "Listen" control + a banner slot in Browse; a
  Settings entry for Pro/voices (docs/roadmap.md).

## 6. Flavors

| | `personal` (default) | `store` |
|---|---|---|
| Purpose | You, via TestFlight internal testing | App Store candidate (approach D, docs/app-store-risk.md) |
| Sources | Built-in Stonescape, LNReader repo seeded, JS plugins + declarative specs | Declarative specs only; nothing bundled or seeded |
| JS plugin host | `www/core/lib/plugin-host.js` | Not built; `importLazy` refuses |
| Ads | never | only with `--ads` |

## 7. Build, test, run (Windows)

```
npm install                          # 176 packages, ~117 MB node_modules (dev only)
npm run typecheck                    # node + core + ui contexts (v1 sources included via the alias)
npm run build                        # personal flavor → www/
npm run build:store                  # store flavor
npm test                             # 54 tests (vitest)
npm run test:shell                   # PC shell: WebKit + Capacitor's native-bridge.js + built UI + built core (5 tests)
node tools/ios-project.ts            # register new Swift files in project.pbxproj (no Xcode needed)
npx cap sync ios                     # copy www → ios/App/App/public, update Package.swift (works on Windows)
node tools/revenue-model.ts          # monetization scenarios
```

Build output (personal): `index.html` 342 KB, `core/core.js` 372 KB, `core/lib/declarative-host.js`
290 KB, `core/lib/plugin-host.js` 339 KB, built-in Stonescape 11 KB. Store `core.js` 327 KB.

Rough timings on this PC with V8 in `--jitless` mode (a crude stand-in for JSContext without JIT; the
phone will be slower): evaluating `core.js` ~9 ms, `app.boot` served ~6 ms later, first source use
(loading both lazy bundles) ~50 ms, `JSON.parse` of a 1.5 MB chapter list ~2 ms. v1 measured a 245 KB
Royal Road page parse at ~40 ms in Scriptable's JSC on the iPhone 16 (v1 CLAUDE.md, CP1), so the
≤ 1 s launch budget has a lot of headroom; confirm on the device in phase 1.

What the tests prove without a Mac:
- `tests/core-vm.test.ts` (13 per flavor + 2 startup tests): the **built** `core.js` boots in a bare JS context (only
  ECMAScript + Intl, like a JSContext) with a Node implementation of `__native`; boot payload, repos,
  installing a declarative source, browse/search/novel/chapter, locked chapters, narration script,
  JS-plugin refusal (store), deep links, background check, events, flush to the synced store.
- `tests/personal-flavor.test.ts`: the personal flavor runs v1's LNReader plugin host and the built-in
  Stonescape plugin inside the v2 core, replaying v1's recorded HTTP fixtures (read from the v1 repo,
  skipped when absent).
- `tests/units.test.ts`: declarative engine (HTML + JSON APIs), narration text, ad policy, entitlements,
  bridge client (concurrency, errors, timeouts, events).
- `tests/build.test.ts`: flavor guarantees (no plugin host/LNReader repo/Stonescape in store; strict CSP;
  Scriptable long-poll code gone; ads only with `--ads`).
- `tests/shell/flow.shell.ts` (**PC shell**, `npm run test:shell`): the built v1 UI in WebKit (iPhone
  viewport) with Capacitor's real `native-bridge.js` injected exactly as `CAPBridgeViewController` does,
  `window.webkit.messageHandlers.bridge` routed to the built core in a vm. Boot → Browse a declarative
  source → novel page → read chapter 1 (anti-theft line stripped) → infinite scroll into chapter 2 →
  "Listen" sends the rendered paragraphs to `Narration.play` → progress lands in history. Only the Swift
  layer is simulated. Screenshots in `.cache/shell-shots/`. Uses playwright-core 1.63.0 with the WebKit
  build already cached on this PC (v1's Playwright install).
- `tests/ios-project.test.ts`: every Swift file registered, pbxproj valid, iOS 17 target, entitlements,
  no file imports both JavaScriptCore and Capacitor (their `JSValue` types clash).

## 8. iOS project

- Capacitor **8.5.2**, Swift Package Manager (`ios/App/CapApp-SPM`, CLI-managed), UIScene lifecycle;
  `cap add ios` and `cap sync ios` work on Windows (8.5.1 fixed backslash paths in Package.swift,
  https://github.com/ionic-team/capacitor/pull/8549). Capacitor 8 needs Xcode 26+
  (https://capacitorjs.com/docs/updating/8-0); App Store uploads need the iOS 26 SDK since Apr 28, 2026
  (https://developer.apple.com/news/?id=ueeok6yw).
- Deployment target **iOS 17.0** (Personal Voice; JS built for safari17). Scenes built in code
  (`SceneDelegate` → `MainViewController`), no storyboard keys; CarPlay scene role configured.
- `MainViewController` registers the app-target plugins (`registerPluginInstance` in `capacitorDidLoad`,
  https://capacitorjs.com/docs/ios/custom-code) and installs `TachiRouter`.
- `Info.plist`: background modes `audio` + `fetch`, BG task id, `tachinovel://` URL scheme,
  `ITSAppUsesNonExemptEncryption = false`, iCloud container folder "TachiNovel".
- `PrivacyInfo.xcprivacy`: FileTimestamp `C617.1`, UserDefaults `CA92.1`, no tracking
  (https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api).
- `App.entitlements` is empty on purpose (CI can sign without extra capabilities);
  `App.full.entitlements.example` adds iCloud Documents and CarPlay audio once the App ID has them.

## 9. CI/CD (`.github/workflows/ios.yml`)

Public repo https://github.com/KastaDev101/tachinovel-v2, so Actions minutes are free; the macOS jobs
still run only on pushes to `main`, pull requests and manual dispatch (no schedule while there is no
Apple Developer account), and docs-only changes (`docs/**`, `*.md`) don't trigger a run. A full run takes
about 15 minutes, mostly the first simulator boot.

| Job | Runner | Secrets | What |
|---|---|---|---|
| `web` | ubuntu | none | typecheck, both flavors, tests, project check |
| `shell` | ubuntu | none | PC shell test in Playwright's Linux WebKit; artifact `shell-screenshots` |
| `ios-compile` | macos-26 (Xcode 26.6 default, https://github.com/actions/runner-images) | none | `cap sync` + unsigned simulator build, then the **simulator smoke test** (`ci/ios-sim-smoke.sh`): boot the newest iPhone simulator, install, launch, screenshot first launch / Library / Browse / Updates / History / More (+ a live Stonescape list in the personal flavor); fails if the app is not running afterwards. Artifacts `simulator-screenshots` (incl. `app-log.txt` with the core's os_log lines) and `xcodebuild-simulator-log` |
| `ios-ipa` | macos-26 | none | push to `main` / manual only: unsigned **device** build (`iphoneos`, arm64, `CODE_SIGNING_ALLOWED=NO`) packaged as `Payload/App.app` → artifact **`TachiNovel-<version>-<run>-unsigned.ipa`** (uploaded unzipped), for AltStore/SideStore |
| `testflight` | macos-26 | ASC API key, team id | archive + export with `destination=upload` → App Store Connect → TestFlight; only on tags `v*` or manual dispatch with `upload=true`; skips without secrets |

The smoke tour is driven by launch arguments: `-tachiSmokeTab <tab>` / `-tachiSmokeSource <id>`
(NSArgumentDomain) → `MainViewController` injects `window.__TACHI_SMOKE__` (Debug builds only) →
`src/ui/native/smoke.ts` skips onboarding and taps the tab/source.

### Sideloading the unsigned IPA (free Apple ID)
AltStore/SideStore re-sign the app with the user's free Apple ID (7-day certificate, 3 active apps). A
free account can't use iCloud containers, CarPlay, push or App Groups, so the IPA embeds **no
entitlements** (empty `App.entitlements`, signing off; the build script fails if any restricted
entitlement shows up). What happens without them:

| Capability | Without the entitlement |
|---|---|
| iCloud Documents (synced store) | `url(forUbiquityContainerIdentifier:)` returns nil → everything lives in local storage (v1's "iCloud unavailable" fallback); use Backup → Share to move data |
| CarPlay audio templates | the CarPlay scene never connects; narration still plays through the car with Now Playing + steering-wheel controls |
| Background audio, background fetch | work (Info.plist background modes, not entitlements) |
| StoreKit (Pro) | products don't load outside the App Store; the app stays in the free tier |
| Notifications | local notifications work (no push used) |

Signing: cloud-managed signing via `-allowProvisioningUpdates -authenticationKey*` needs a **Team API key
with Admin role** (https://developer.apple.com/forums/thread/698117); fresh runners sometimes fail with a
missing development-certificate key (https://developer.apple.com/forums/thread/695759), so the script
also supports manual signing from a `.p12` + profile in a throwaway keychain (GitHub's recipe,
https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications).
`fastlane/Fastfile` is an alternative (fastlane 2.240.1, https://rubygems.org/gems/fastlane/versions).
Build numbers come from `GITHUB_RUN_NUMBER`.

## 10. Background work
- **Narration:** background audio mode; native queue; core reachable without the WebView.
- **Library updates:** `BGAppRefreshTask` (~30 s at system-chosen times,
  https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app)
  runs v1's update check with a 22–25 s budget and posts a local notification (provisional
  authorization: quiet delivery, no prompt). Capacitor's notification delegate is left alone.
- **WebContent crash:** Capacitor reloads the WebView; the UI rebuilds from `app.boot` (core state lives
  natively, so nothing is lost).

## 11. Verified vs unverified

| Verified on Windows | Unverified (needs macOS CI or a device) |
|---|---|
| TS typechecks (core/ui/node) incl. vendored v1 | Swift compiles and the app launches in the simulator (CI `ios-compile`) |
| Built core runs in a bare JS context end to end | JSContext behaviour on device (microtasks, memory, speed without JIT) |
| v1 UI ↔ Capacitor native-bridge.js ↔ core protocol (PC shell) | Real WKWebView, safe areas, 120 Hz feel, SF Symbols |
| Declarative engine, narration text, ad policy, bridge client | Capacitor plugin registration, `TachiRouter` covers |
| Build flavors and their guarantees | iCloud container, entitlements, signing, TestFlight upload |
| Xcode project file structure | AVSpeech in background, Now Playing, CarPlay (entitlement), StoreKit flows |

## 12. Android (optional; not built)
Not feasible here within the rules: Capacitor 8 needs JDK 21 and Gradle 8.14.3 downloads (this PC has
Java 8; https://capacitorjs.com/docs/updating/8-0). Design note: Android has no JavaScriptCore; the
equivalent core host is a headless `WebView` whose `@JavascriptInterface` methods are **synchronous**,
which fits v1's sync `FileStore`. The core bundle and `native-api.ts` stay the same; only a Kotlin
`__native` implementation is needed (~1–2 weeks). UI, core and tests are shared.
