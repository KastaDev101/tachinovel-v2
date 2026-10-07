# QA: the click-everything crawler and the native smoke tour

Two automated "user tests" check that every button works, on every pull request (and the crawler every
2 hours on main):

| | Where | What it taps | Catches |
|---|---|---|---|
| **UI crawler** (`ui-crawler` workflow) | Ubuntu, WebKit, iPhone 16 Pro viewport, dark and light | Every visible control of every reachable screen of the built app (v1 UI + v2 overlays), with the real core | JS errors, console errors, crash boxes, "Something Went Wrong", dead controls, hung or slow taps, broken Back, layout escapes, controls covered by other UI |
| **Native smoke tour** (`ios-compile + simulator smoke` job) | macOS, iOS Simulator, Debug build | The native-only surfaces: document picker, share sheet, Listen (system voice), mini player and car player controls, brightness and keep-awake | Crashes (app not running, crash reports), a stuck popup queue (tour never finishes) |

## UI crawler

### Run it locally

```sh
npm ci
node tools/ui-crawler.ts                    # personal flavor, dark + light, 4 workers (~10–20 min)
node tools/ui-crawler.ts --scheme=dark      # one appearance
node tools/ui-crawler.ts --max-actions=200  # a quick partial run
QA_VERBOSE=1 node tools/ui-crawler.ts --scheme=dark --workers=1   # log every tap with its effects
```

Options: `--flavor=personal|store`, `--scheme=dark|light|both`, `--seed=N`, `--workers=N`,
`--max-actions=N`, `--max-states=N`, `--max-minutes=N`, `--out=DIR`, `--no-build` (reuse the last build),
`--quiet`. It needs Playwright's WebKit (`npx playwright-core install webkit` once, or the cached build the
shell test uses). The exit code is 1 when there are failures that are not listed as known issues.

Output in `.cache/crawler/` (the CI artifact `ui-crawler-<scheme>` has the same files):

- `report.md`: totals, every finding (failures first) with a screenshot link and repro steps, and the list of
  states visited with their screenshots;
- `report.json`: everything, including each control's outcome, time and observed effects;
- `<scheme>/states/NNN.png`: one screenshot per state; `<scheme>/failures/*.png`: the screen at each finding.

### How it works

The crawler runs the **PC shell** (the built `www/index.html`, Capacitor's real `native-bridge.js`, the
built `core.js` in a JSC-like `vm`; see `tests/helpers/`) with a resettable, deterministic setup
(`tests/crawler/env.ts`):

- **Synthetic data** (`tests/crawler/fake-web.ts`, `seed.ts`): an invented HTML novel site read by a
  declarative source, the Stonescape JSON API (built-in source of the personal flavor), an LNReader repo
  index with small plugins, generated PNG covers. The store is seeded through the core's own bridge
  methods: 8 novels in the library across 3 categories, reading progress and history in 6 of them, a
  bookmark, new chapters found by a real update check (Updates), and three downloaded chapters.
- **Determinism:** fixed clock (page and core start at 2026-10-06 12:00 UTC), seeded `Math.random`, UTC
  time zone, no network (the core's HTTP is answered by the synthetic site; the page can only load cover
  images from it), no transitions (`__TACHI_DEV__.noAnimations`), `localStorage` cleared per launch.
- **Device:** 402×874 CSS px at 3×, touch, with the iPhone 16 Pro safe areas (62 / 34 px): v1 reads
  them from `__TACHI_DEV__.safeArea`, and the page's `env(safe-area-inset-*)` are rewritten to the same
  values (the inline script's CSP hash is recomputed).
- **Native layer:** stateful mocks of the Swift plugins (Narration emits `state`/`progress` events, so the
  mini player and car player appear), and the core's native UI is recorded and steered: action sheets and
  alerts, share sheet, Safari, document picker (always cancelled, like a user tapping Cancel).

The crawl (`tests/crawler/crawler.ts`) is a breadth-first search over **states**: the screen on top, the
open sheet or dialog, the selected inner tab or reader bars, and a variant (the on/off/disabled states of
the screen's controls), e.g. `novel > sheet:chapter-filter-sheet` or `reader [bars, player]`. The novel
page reached from Library, History or Updates is one state; a novel that isn't in the library ("Add to
Library") is another. A control that only changed stored data on the same screen (a filter toggled, a
chapter marked read) doesn't open a new state. The report shows each state with the full stack of the
path that first reached it, and `report.json` has the graph (`edges`: which control led where).
For each new state it takes a screenshot, runs the layout checks and lists the visible controls
(`tests/crawler/page-runtime.ts`): buttons, links, tabs, switches, selects, sliders, text fields, elements
with click/pointer listeners, plus long-press targets (list rows and grid cells) and two gestures (tap the
middle of the reader, swipe from the left edge). Then it activates each control, starting from a fresh
launch of the seeded app followed by the state's path, and records what happened.

| Check | Fails when |
|---|---|
| Errors | an uncaught error or unhandled rejection, a `console.error`, v1's red crash box, or a "Something Went Wrong" state appears |
| Dead control | nothing happened: no navigation, no visible change, no sheet or native popup, no core or native call, no scroll, focus or copy (re-tapping the current choice may do nothing). Before failing, it tries five quick taps (a hidden gesture, like the About version's Voice Lab) and a mouse click (desktop WebKit's tap emulation); either one working makes it a warning |
| Time | a core call is still pending 5 s after the tap (warning when the UI takes longer than 1.5 s to settle) |
| Back | the nav bar Back button doesn't leave the screen, or the screen it lands on is blank or broken |
| Layout | the page scrolls sideways, an element sticks out of the screen unclipped, the end of a tab's content stays behind the tab bar, a fixed control sits under the status bar or on the home indicator, or a fixed control is covered by another element |
| Core | a core call answers `ok:false` (warning: some are expected answers) |

Native prompts are answered "cancel" first; each of their options then becomes its own control
("More actions › Mark All as Read"), up to three prompts deep. Repeated list items are sampled (two
rows per list and screen type, one long-press). Each control is tried once per screen type, so the crawl
terminates. Several workers (own WebKit and core each) run the controls of a BFS level in parallel and
results are merged in a fixed order. A control that left the app unchanged lets the next control of the
same state reuse the page; a failure seen on a reused page is re-checked from a fresh launch, so every
reported failure's repro is "launch → path → control".

### Every 2 hours on main

The workflow also runs on a schedule (every 2 hours, on `main`). Its last job, `report new failures`,
posts failures that are **new** — not in `known-issues.json` and not already reported — as a comment on the
issue "UI crawler: new failures on main" (opened on the first one), with the repro steps and a link to the
run's screenshots; a clean run closes the issue (`tools/crawler-notify.ts`). Fix the failure or, if it can't
be fixed in this repo, add it to `known-issues.json`.

### Known issues

`tests/crawler/known-issues.json` lists findings that are understood and tracked elsewhere (for example a
bug in the vendored v1 UI that has to be fixed in the v1 repo and re-vendored). They stay in the report,
marked "known", but don't fail the job. Each entry has an `id`, the finding `kind`, optional regexes for
`state`, `control` and `message`, an `owner` (`v1`, `v2` or `harness`) and a `note`. Remove the entry
when the fix lands.

### When the crawler fails your PR

1. Open the job summary or the `ui-crawler-<scheme>` artifact's `report.md`.
2. Each failure has the state, the control, the message, a screenshot and the steps from a fresh launch.
3. Reproduce locally with `QA_VERBOSE=1 node tools/ui-crawler.ts --scheme=<scheme> --workers=1`, or in
   the browser with the steps.
4. Fix the bug (with a regression test), or, if the finding is wrong, fix the crawler. Add a known issue only
   for something that can't be fixed in this repo (v1 code) and say where it is tracked.

## Native smoke tour (simulator, #14)

`ci/ios-sim-smoke.sh` launches the Debug simulator build a few times with smoke arguments. After the
screenshots of each tab, `-tachiSmokeTour native` runs `src/ui/native/smoke.ts`, which taps through:

1. More › Backup & Restore › **Restore from Files…** twice (document picker): the first one is swiped away
   (UIKit calls no delegate method then), the second cancelled; both times the row must come back;
2. More › **Listen** (the Listen player; with PC audio on: Listen in the Car › **Open the player** ›
   **Link audio folder**) › close;
3. Browse › the built-in source › the first novel › **Share** (share sheet) › start reading;
4. reader settings: **brightness** slider (`native.setBrightness`) and **Keep screen awake**
   (`TachiNative.setKeepAwake`);
5. **Listen** (system voice), the **mini player** pause/resume, the **car player** (±15 s, speed,
   play/pause, next chapter), close, stop.

Nobody can tap system sheets in CI, so `SmokeResponder.swift` (Debug builds only) answers them two
seconds after they appear: the first document picker like a swipe down (`dismiss` only), the others like
Cancel (`dismiss` + `documentPickerWasCancelled`), the share sheet with `dismiss` + its completion handler.
The job fails if the swiped picker's request is never answered, is answered before the picker went away
(while it was still coming up), or the share sheet doesn't appear after it. Each step logs
`smoke: …` through the core (os_log subsystem `app.tachinovel`); the job prints those lines, saves
`native-tour-log.txt` and a screenshot every 4 s (`9-native-NN.png`), fails if the app stops running or
leaves a crash report, and warns if the tour didn't reach `smoke: tour done` or skipped steps (step 3 needs
the network). Alerts and action sheets can't be answered without private API, so the tour avoids them;
the UI crawler covers their options on the PC.

A real XCUITest target (actual taps on the system sheets, swipe-to-dismiss) would close the remaining
gap; it needs a UI-testing target in the Xcode project.

## Latest results

First full crawl, 2026-10-06 (personal flavor, seed 1, 4 workers on a Windows PC; CI publishes each run's
report as an artifact):

| | States | Screens (+ sheets) | Controls activated | Repeated rows sampled out | Disabled | Time |
|---|---|---|---|---|---|---|
| dark | 173 | 30 (59) | 869 | 507 | 21 | 11 min |
| light | 173 | 30 (59) | 860 | 505 | 21 | 10 min |

Every tab, pushed screen and settings page that is reachable without a real network was visited: Library
(categories, select mode, sort/filter/display), Updates, Browse (sources, extensions, languages, genres,
Latest, For You, source pages and filters), History, More and all its pages, novel page (chapter filter,
jump, categories, migrate), reader (bars, find, chapter list, appearance, auto-scroll), Listen in the Car
and the car player, global search, genre search, Reading Insights, Migrate, Text Cleanup, Diagnostics.

Found and fixed (v2):

- The mini player covered the tab bar (no tab could be tapped while listening), the reader's bottom bar
  and the Resume button; "Open the player" hid the last rows of Listen in the Car — #13.
- The car player rebuilt itself every second: its list jumped back to the top and taps could be lost — #16.

Open (vendored v1 UI, reported for a fix in the v1 repo; listed in `known-issues.json` where they fail):

- Source filters: Reset does nothing while the filters are the defaults (should be disabled).
- Novel page › Jump to chapter: Go with an empty field does nothing (should be disabled).
- Search fields' ⓧ: a touch tap doesn't clear in desktop WebKit (the button prevents `pointerdown` to keep
  the keyboard up); iOS WebKit still sends the click (bugs.webkit.org/195839), so it is reported as a
  warning to confirm on the phone.
- Copy written for Scriptable shows in v2: What's New on first launch, More › About ("running in
  Scriptable"), Backup & Restore and Help ("iCloud Drive › Scriptable › TachiNovel").

Warnings that are expected: Auto-scroll keeps the UI changing (by design), a few taps settle in 1.5–3 s on a
loaded machine, and a handful of reader states aren't reached again identically (the reader restores its
position asynchronously).
