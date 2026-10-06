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
| Status bar | none (Scriptable's Close/Share bar sat above the page) | real status bar over the page; it followed only the **system** appearance, so a forced Appearance (Settings › Appearance) or a light/sepia reader theme in dark mode (and the reverse) gave unreadable status-bar text | **fixed** (#25) |
| Covers | `covers.fetch` fallback (CORP), relative `covers/…` | routed by `TachiRouter` | ok |
| Haptics | iOS 18 `<input switch>` label trick | same trick in WKWebView (expected to work; check on the phone), plus native haptics on the Listen button | ok (verify) |
| Deep links | `scriptable:///run/TachiNovel?…` | `tachinovel://open?…` (retained until the UI listens, so cold starts work) | ok |
| Background update checks | the widget checked; the app merged `widget-updates.json` | `BGAppRefreshTask` + quiet local notification | better |
| Narration | PC narrator only (settings screen "Listen in the Car") | in-app Apple voices with lock screen, CarPlay list, Now Playing; Kokoro in progress (voice-spike) | better |
| PC narrator settings + status ("Listen in the Car" screen) | config and status files in iCloud Drive › Scriptable › TachiNovel, shared with the PC narrator | v2's own store: the narrator can't see v2's choices, and v2 can't see its status | gap (parked: narrator sidelined) |
| Backup & Restore | backups in iCloud Drive › Scriptable › TachiNovel › backups (visible in Files and on the PC) | Restore from Files works with v1 backups (tested with a real one). New backups: with the iCloud entitlement in iCloud Drive › TachiNovel › backups; in the **free sideload** (no iCloud) inside the app container, reachable only through Share | **fixed** (#24: Documents, shown in Files) |
| Logs for Claude on the PC | `TachiNovel/logs/` mirrored to iCloud | sideload: device only (Copy Full Diagnostics / Send a Problem Report still work through the share sheet) | **fixed** (#24: log mirror in Documents, shown in Files) |
| Same library as v1 | — | separate apps and stores; move with a backup | by design (decision: no live sharing) |
| Storage screen | per-category usage, clear | same code (handles synced = local) | ok |
| Wording that names Scriptable/iCloud | Backup footer ("iCloud Drive › Scriptable › TachiNovel › backups"), Help › "Is my library backed up?", Storage note "Synced with iCloud", About footer ("running in Scriptable"), Help's narrator answer | shown unchanged in v2: wrong locations in the sideload | gap → v2 build patch after #9 |
| Widget, Shortcuts icon, self-test, run lock, flags.json | Scriptable | — | n/a |

## Open gaps and plan (decisions 2026-10-06)

1. **Status bar contrast** (v2): follows the background under the status bar (forced appearance, reader
   theme, overlays). **PR #25.**
2. **Wording** (v1 text): **v2 build patch** (`tools/v1.ts`, after the patch refactor in #9 lands). The
   platform supplies the storage description (iCloud Drive › TachiNovel with iCloud, On My iPhone ›
   TachiNovel in the free sideload), and v2's copy never mentions Scriptable, iCloud paths or BookPlayer.
   No v1 contract change for now.
3. **Backups and logs reachable in Files in the free sideload** (v2): synced store in
   `Documents/TachiNovel` with `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace`, with a
   one-time crash-safe move (copy, verify, switch, keep the old copy until the next launch worked).
   **PR #24.**
4. **Sharing v1's live data folder: no.** Two apps with different schema versions writing the same
   files is too risky; moving data stays backup → restore. **Parked idea:** a read-only "Import from
   the v1 folder" (pick iCloud Drive › Scriptable › TachiNovel once, read its state files like a backup
   preview, merge; never write there).
5. **PC narrator integration**: parked with the narrator.

Verify on the phone (not testable in CI): haptics trick, keyboard with `resize: native`, Cloudflare
"Verification Needed" flow (`solveChallenge`), brightness restore when leaving the reader.
