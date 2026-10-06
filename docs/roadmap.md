# TachiNovel v2 — roadmap and decisions

Status 2026-10-06 (evening): public repo https://github.com/KastaDev101/tachinovel-v2; CI builds and runs it on
macOS for free; an unsigned IPA for AltStore is produced on every push to `main`. **To try it on the phone
tonight, follow [how-to-test-tonight.md](how-to-test-tonight.md).** Nothing is published, signed or paid for.
Companion docs: architecture.md, app-store-risk.md, monetization.md, tts-v2.md.

## Where things stand

| Area | State |
|---|---|
| Web layer (v1 UI + Capacitor transport + shims) | Builds on Windows; typechecked; unit tests + PC shell test (real WebKit) |
| Core (v1 services in a native JSContext) | Built `core.js` runs end to end in a bare JS context with a mock native host; vendored v1 = f788523 |
| Store compliance in code | Store flavor: no bundled/seeded sources, no JS plugin host, declarative sources, paywall never on content |
| Swift layer (CoreHost, HTTP, files/iCloud, native UI, Core/Narration/Store plugins, CarPlay, background refresh, audio library) | Compiles on Xcode 26.6 in CI (simulator + device); launches in the iOS Simulator (smoke screenshots per run) |
| CI | `web`, `shell`, `ios-compile` + simulator smoke, `ios-ipa` (unsigned, free sideload); TestFlight job waits for an Apple account |
| Backup | v1 backups restore in v2 via Settings › Backup & Restore › Restore from Files… (document picker) |
| Narration | Apple voices (AVSpeech) with background/lock screen, Now Playing, remote commands, resume, auto-advance, full-screen Listen player; CarPlay list (needs the entitlement). Bundled **Kokoro** voices (FluidAudio Core ML, 6 voices, ~97 MB in the app) with the Apple voices as a seamless per-sentence fallback: `voice-spike` PR, see docs/voices.md. The PC-narrated audio player ("TachiNovel Audio" folder, sentence highlighting from timestamps) works but is parked: the PC narrator is sidelined |
| App icon / launch screen | v1's book icon; launch image follows light/dark |
| Monetization | Ad pacing policy + AdMob wiring (off by default), StoreKit 2 plugin, feature matrix, revenue model |
| Android | Not built (JDK 21 + Gradle downloads needed); design note in architecture.md |

## Decisions made (2026-10-06, by Kasta)

| # | Decision |
|---|---|
| D1 | Not yet on the phone. Step 1 now: free cloud builds (public GitHub repo while building; switch to private later) — compile + iOS Simulator tests/screenshots. No $99 account yet. |
| D3 | **Shell only, no bundled sources** (Tachimanga model): the user pastes a repository link to get sources. The store build must not ship with sources inside. **Deferred: this is the very last step before finalizing** (re-check App Store guideline 2.5.2 on downloaded code at that point). |
| D4 | **Individual seller** (no LLC). |
| D5 | **All of them**: ads, plus remove-ads via a monthly subscription and a lifetime purchase (originally ~$5/month, ~$25 lifetime). |
| D9 | **Keep the name "TachiNovel"** (the full name is unique). Run a trademark search before launch. |

Still open: D2 (go public — implied yes by D3–D5, confirm later), D6/D7 (voice engine, after a device spike), D8 (CarPlay entitlement, once an account exists), D10 (small v1 changes).

## Decision points (yours)

| # | Decision | Options | Recommendation | Blocks |
|---|---|---|---|---|
| **D1** | Get the native app onto your phone at all? | stay on v1 (Scriptable) / v2 personal via TestFlight | **v2 personal** once v1 has settled (the CLAUDE.md "parked" plan) | everything below |
| **D2** | Personal only, or also a public App Store product? | personal / public | Decide after a month of using v2 personally; the public product is a different, smaller-scope app (app-store-risk.md) | phases 4–6 |
| D3 | Public source model | A–F in app-store-risk.md §6 | **D**: owned/licensed/public-domain/permitted sources + TTS (5–15% risk). Not A/B/C | phase 4 |
| D4 | Who is the seller | individual / LLC; EU storefronts or not (DSA trader address) | Individual for approach D with small revenue; LLC (Wyoming or home state) if anything aggregates third-party content or revenue grows | enrollment |
| D5 | Monetization | Pro only / ads + Pro / one-time remove-ads | Ads + Pro hybrid, ladder C ($2.99 / $17.99 yr / $29.99 lifetime); consider **Pro-only, no ads** at launch if DAU < ~1k (ads add ATT/UMP/labels work for ~$5–50/month) | phase 5 |
| D6 | HD voice engine | FluidAudio Core ML (ANE) / ONNX Runtime CPU int8 / own Core ML conversion | **Built with FluidAudio Core ML** (bundled, Neural Engine + CPU, Apple fallback; docs/voices.md). Confirm with the phone checklist incl. a **locked-screen** test; ONNX Runtime CPU stays the plan B if the iOS 26 Core ML crash (FluidAudio #844) shows up | phase 3 |
| D7 | iOS minimum for HD voices | iOS 26 (Apple-hosted asset packs) / iOS 17 + self-hosted download | iOS 26 for HD voices, iOS 17 for the app | phase 3 |
| D8 | CarPlay | request the audio entitlement now / later | Request as soon as the developer account exists (approval takes weeks) | phase 2 |
| D9 | Brand | keep "TachiNovel" for personal / neutral name for store | Neutral store name (no "Tachi") | phase 6 |
| D10 | v1 changes to remove v2's build patches | accept / keep patching | Accept (small): built-ins/default repos/verification table as `ServicesOptions`; reader "Listen" control; Browse banner slot; Settings rows for Pro/voices | phase 2 |

## Phases and effort

Effort = focused engineering weeks for one experienced developer (with Claude Code doing most of the
typing, calendar time is dominated by device testing, App Review and Apple's waits).

| Phase | Scope | Effort | Needs from you |
|---|---|---|---|
| **0. Scaffold** (done) | This repo | — | — |
| **1. First compile + first device run** (personal) | Push to a private GitHub repo; fix whatever the `ios-compile` job reports; first TestFlight internal build; on-device checklist (boot time, bridge latency, covers, iCloud, plugin sources, Cloudflare fallback, 30-min locked narration, Bluetooth/car pause, background refresh) | 1–2 weeks | D1; Apple Developer Program ($99/yr); bundle id; App Store Connect app record; API key (Admin) + secrets in GitHub; an iPhone with TestFlight |
| **2. Personal parity + polish** | v1 UI hooks (Listen button, voice/lexicon/sleep settings, Pro/voices rows); WidgetKit widget (v1's widget was Scriptable); notification toggle; iCloud entitlement on; CarPlay entitlement request; app icon/splash | 2–4 weeks | D8, D10 |
| **3. HD voices** | Engine spike (D6) → neural engine + render-ahead cache + AVAudioEngine player → asset-pack delivery → lexicon tooling with the PC lab | 6–10 weeks | D6, D7 |
| *(gate)* | **D2: go public?** | — | D2, D3, D4 |
| **4. Store-ready product** (approach D) | EPUB/TXT import, OPDS client (Komga/Calibre/Standard Ebooks), Gutenberg catalog, permitted sources with attribution, 4.7 controls if any user-added sources, onboarding, age rating, privacy policy, support page, review notes + lock-screen video | 6–10 weeks | permissions (emails) for any web source; D9 |
| **5. Monetization** | App Store Connect products, paywall UI, StoreKit config tests; ads build (UMP, ATT, SKAdNetwork, privacy label, app-ads.txt, report-ad) if D5 says so | 2–4 weeks | Paid Apps Agreement, tax (W-9) and bank in App Store Connect; AdMob account |
| **6. Launch** | Listing, screenshots, DSA trader setup, Small Business Program enrollment, TestFlight external beta (Beta App Review), submission | 1–2 weeks + review time | D4, D9 |
| 7. Android (optional) | Kotlin `__native` host (headless WebView, sync JS interface), Play listing | 2–4 weeks | $25 Play account; JDK 21/Gradle |

Totals: **personal path (1–3) ≈ 9–16 weeks**; **public path adds (4–6) ≈ 9–16 weeks**. TTS is the
largest single item; the AVSpeech baseline makes v2 useful for driving long before Kokoro lands.

## Costs you would incur

| When | Cost |
|---|---|
| Phase 1 | Apple Developer Program **$99/year** (needed for TestFlight; free provisioning can't do TestFlight) |
| CI | GitHub Actions: macOS runners consume a private repo's included minutes at a higher rate (historically 10×); a build is ~10–20 min. Not re-verified tonight: check current GitHub pricing |
| Phase 3 | $0 hosting (Apple-hosted asset packs) |
| Phase 4–6 | Domain ~$10/yr; optional LLC ($100 + $60/yr Wyoming … $800/yr California); optional RevenueCat ($0 under $2.5k/month) |

## What I need from you (to continue)

1. **D1 / D2** (and D3 if public).
2. If D1 = yes: enroll in the Apple Developer Program (individual or organization per D4), pick a bundle
   id (replace `com.kasta.tachinovel` in `capacitor.config.ts`, `ios/App/App.xcodeproj` and the CI
   variable `BUNDLE_ID`), create the App Store Connect app record and an **Admin** Team API key.
3. Create a **private** GitHub repo, push this repo yourself, and add the secrets listed at the top of
   `.github/workflows/ios.yml`. The first push runs the `ios-compile` job — send me its log.
4. Request the CarPlay audio entitlement when the account exists.
5. Say yes/no to the small v1 changes in D10 (they go into the v1 repo, done by whoever owns v1 paths).

## Requested v1 contract changes (for the v1 coordinator)

- `ServicesOptions`: `builtInSources?`, `defaultRepos?`, `verifiedTable?` (removes tools/v1.ts patches).
- Reader: a first-class "Listen" control + a narration state API instead of the DOM overlay
  (`src/ui/native/narration-overlay.ts`), sentence highlight hooks.
- Browse: an optional banner slot (`<AdSlot placement="browse">`) and a placement hook for interstitials.
- Settings/More: rows for "Pro", "Voices", "Pronunciations", "Notifications".
- Store-build copy: the v1 UI says "Paste an LNReader plugin (CommonJS)…", "running in Scriptable",
  "modeled on … the look of Tachimanga" (browse.tsx, settings.tsx) and, since 3a25883, the onboarding card
  "Find novels on Stonescape, Royal Road and more" (onboarding.tsx). A `__FLAVOR__`-aware About text and
  a "Add source definition (JSON)" paste box are needed before any review; keep the LNReader MIT credit.
- Covers: keep returning `covers/<file>` relative paths (v2 routes them); no change needed.
