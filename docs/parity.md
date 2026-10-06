# v1 → v2 feature parity

Audit of TachiNovel v1 (Scriptable, vendored at the commit in `vendor/v1/VENDORED.md`) against v2 (this
repo), screen by screen. Scriptable-only pieces are out of scope: the home-screen widget, the Shortcuts
home-screen icon, the on-phone self-test and Scriptable's run lock, `flags.json` and Close/Share bar.

v2 runs v1's UI and v1's script services unchanged (`createApp` in `src/core/core.ts`), so every feature
that only needs v1 code and the platform contract (`vendor/v1/src/shared/contracts/platform.ts`) behaves
the same. Gaps come from what Scriptable provided around that code: the file locations, the WebView's
origin, the presented view's chrome, and data shared with other tools through iCloud Drive › Scriptable.

How it was checked: v1's screens, help topics and CLAUDE.md feature checklist against the v2 platform
layer (`src/core/platform.ts`, `ios/App/App/Native/**`), the simulator smoke screenshots, the PC shell
tests and the UI crawler (`docs/qa.md`, which taps every control of the v1 UI in v2 on the PC).
Last audit: 2026-10-06.

Status: **ok** = same as v1 · **better** = v2 does more · **fixed** = gap closed (PR) · **gap** = open ·
**n/a** = Scriptable-only by design.

## Screens and features

| Area | v1 | v2 | Status |
|---|---|---|---|
| Library | grid, badges, sort/filter/search, categories, multi-select, continue reading, pull-to-refresh update check | same code | ok |
| Updates, History | grouped by day; resume, remove, clear | same code | ok |
| Browse | sources, Extensions (LNReader repo), source filters, global search, genre search | same code; store flavor: declarative sources only (D3) | ok |
| Novel page | header, summary, chapters, jump, filters, Open in Safari, Share | same code; `openUrl`/`share` are native | ok |
| Reader: text | infinite scroll, themes, fonts, spacing, tap zones, paged mode, find, copy | same code | ok |
| Reader: illustrations a site blocks (CORP) | fetched by the script, loaded from `cache/img-…` next to the page | the page is `capacitor://localhost/`; only `/covers/*` was routed, so they silently collapsed | **fixed** (#21) |
| Reader: brightness, battery, keep awake | `Device.setScreenBrightness`, `Device.batteryLevel`, Wake Lock | `UIScreen.brightness`, `UIDevice` battery, wake lock shim → `isIdleTimerDisabled` (more reliable than WKWebView's) | ok / better |
| Status bar | none (Scriptable's Close/Share bar sat above the page) | real status bar over the page; it followed only the **system** appearance, so a forced Appearance (Settings › Appearance) or a light/sepia reader theme in dark mode (and the reverse) gave unreadable status-bar text | **gap** → fix PR follows #19 |
| Covers | `covers.fetch` fallback (CORP), relative `covers/…` | routed by `TachiRouter` | ok |
| Haptics | iOS 18 `<input switch>` label trick | same trick in WKWebView (expected to work; check on the phone), plus native haptics on the Listen button | ok (verify) |
| Deep links | `scriptable:///run/TachiNovel?…` | `tachinovel://open?…` (retained until the UI listens, so cold starts work) | ok |
| Background update checks | the widget checked; the app merged `widget-updates.json` | `BGAppRefreshTask` + quiet local notification | better |
| Narration | PC narrator only (settings screen "Listen in the Car") | in-app Apple voices with lock screen, CarPlay list, Now Playing; Kokoro in progress (voice-spike) | better |
| PC narrator settings + status ("Listen in the Car" screen) | config and status files in iCloud Drive › Scriptable › TachiNovel, shared with the PC narrator | v2's own store: the narrator can't see v2's choices, and v2 can't see its status | gap (parked: narrator sidelined) |
| Backup & Restore | backups in iCloud Drive › Scriptable › TachiNovel › backups (visible in Files and on the PC) | Restore from Files works with v1 backups (tested with a real one). New backups: with the iCloud entitlement in iCloud Drive › TachiNovel › backups; in the **free sideload** (no iCloud) inside the app container, reachable only through Share | gap (sideload) |
| Logs for Claude on the PC | `TachiNovel/logs/` mirrored to iCloud | sideload: device only (Copy Full Diagnostics / Send a Problem Report still work through the share sheet) | gap (sideload) |
| Same library as v1 | — | separate apps and stores; move with a backup | by design (see proposal) |
| Storage screen | per-category usage, clear | same code (handles synced = local) | ok |
| Wording that names Scriptable/iCloud | Backup footer ("iCloud Drive › Scriptable › TachiNovel › backups"), Help › "Is my library backed up?", Storage note "Synced with iCloud", About footer ("running in Scriptable"), Help's narrator answer | shown unchanged in v2: wrong locations in the sideload | gap (v1 text; requested upstream) |
| Widget, Shortcuts icon, self-test, run lock, flags.json | Scriptable | — | n/a |

## Open gaps and plan

1. **Status bar contrast** (v2): follow the effective background under the status bar: v1's
   `data-appearance` override and the reader theme of the top screen. Small TS change next to the
   launch-screen code; lands after #19 to avoid a conflict in `prelude.ts`.
2. **Wording** (v1 text): requested upstream: let the platform supply the storage description
   ("iCloud Drive › Scriptable › TachiNovel" vs "iCloud Drive › TachiNovel" vs "On this iPhone") and the
   About line, instead of hard-coded strings. Until then v2 can patch the five strings at build time
   (`tools/v1.ts`), after the patch refactor in #9 lands.
3. **Backups and logs reachable in Files in the free sideload** (v2, needs a decision): when iCloud is
   unavailable, root the synced store in the app's `Documents/TachiNovel` and turn on
   `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace`, so Files shows On My iPhone ›
   TachiNovel › backups / logs. Needs a one-time move of the synced files of existing installs out of
   Application Support, so it waits for a go-ahead (it must not put existing data at risk).
4. **Proposal: share v1's data folder.** A document-picker bookmark (like the audio folder; no iCloud
   entitlement needed) could make v2 read and write iCloud Drive › Scriptable › TachiNovel directly: the
   same library and progress as v1, backups and logs where they were, the PC narrator's files. Risks:
   v1 and v2 writing the same files at once (v1's run lock would need to cover v2) and schema versions
   when v1 is newer than v2's vendored copy. Decision for the coordinator/user.
5. **PC narrator integration**: parked with the narrator; solved by 4 if that goes ahead.

Verify on the phone (not testable in CI): haptics trick, keyboard with `resize: native`, Cloudflare
"Verification Needed" flow (`solveChallenge`), brightness restore when leaving the reader.
