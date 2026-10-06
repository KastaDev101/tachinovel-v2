# UI tests on the simulator

CI job **`ios-ui-tests (simulator)`** runs an XCUITest end to end against the real app in the iOS
Simulator (`ci/ios-ui-tests.sh`, target `AppUITests`, scheme `AppUITests`):

1. first launch, onboarding (**Skip**);
2. More › Backup & Restore › the sample backup › **Restore…** (native action sheet) › **Merge** ›
   **Install** (native alert: reinstall the demo source) › "Restored 1 novel and 1 source";
3. Settings (More › General);
4. Library › **Alpha Story** › **Resume** › chapter 1 text, the Reading Tips sheet (**Got It**);
5. **Listen from here** › the mini player shows **Pause**: narration runs with the Apple (system) voice.

Screenshots of each step are the artifact **`ui-test-screenshots`** (`01-library-first-launch.png` …
`08-listening.png`, plus a screen recording). On a failure the job also keeps **`ui-test-logs`**: the
xcodebuild log, the fixture site's request log and the `.xcresult` bundle; the screenshots then include
`accessibility-tree.txt`, the app's accessibility hierarchy at the moment it failed.

## How it works

| Piece | What |
|---|---|
| `ios/App/AppUITests/AppUITests.swift` | The test. Reaches the web UI through accessibility (visible labels, `aria-label`s); native sheets and alerts directly |
| `tools/ui-fixtures.ts` | Synthetic fixtures only: serves the demo site (`tests/fixtures/demo-site`) and builds the sample backup with the built core (demo source, "Alpha Story", progress in chapter 1) |
| `ci/ios-ui-tests.sh` | Picks the simulator, makes a throwaway CA and a certificate for `novels.example.test`, trusts the CA in **that simulator only** (`simctl keychain add-root-cert`), points the name at 127.0.0.1 (`/etc/hosts`), serves the site on 443, runs `xcodebuild test`, exports the attachments |
| `CoreHost.installUITestBackup` | Debug builds only: a backup handed over in `TACHI_UITEST_BACKUP` (from the test runner) is placed where Backup & Restore lists backups (the synced store: Documents/backups in the simulator, which has no iCloud) |

The app talks to the fixture site over real HTTPS, so App Transport Security and the `https`-only rule
for source definitions run unchanged. The store flavor is used: nothing bundled or seeded, so the restored
demo source is the only one.

## Running it

It needs a Mac (Xcode 26). From the repo root after `npm ci`:

```sh
node tools/build.ts --flavor=store && npx cap sync ios
bash ci/ios-ui-tests.sh build/ui      # uses sudo once to add novels.example.test to /etc/hosts
```

Without CI's environment (`TACHI_UITEST_BACKUP`) the test skips itself, so running the `AppUITests`
scheme from Xcode by hand does nothing harmful.

## Changing the UI

The test finds elements by their visible text or `aria-label`. When a label it uses changes (for example
"Listen from here" or "Backup & Restore"), update `AppUITests.swift` in the same PR. Keep fixtures
synthetic: no real sites, novels or user data.

## Flakiness

The CI simulator runs on a busy VM (a first launch has taken 78 s, first paint 43 s), and the test has
failed for reasons that were not the app's:

| Seen | What the test does about it |
|---|---|
| A tap landed where a row *was*: its hit point was computed during v1's push animation (`{396,646}` while the row ends at x 386 once in place) | Every tap waits until the element stops moving (the same frame twice, 150 ms apart, its center on screen), then taps the element, or that fresh frame's center when XCUITest calls the element not hittable |
| A tap was swallowed, or a tab tap picked a moving "More" title instead of the tab | Taps that are safe to repeat (navigation, dismissing) check their effect (the next element appears, or the tapped one goes away) and tap again from a fresh snapshot, up to 3 times. Tabs are looked up in the bottom 30 % of the screen |
| The page went blank right after onboarding appeared: the web view kept only its scroll bars (a WebContent process that ended: the app reloads the page and rebuilds its screen stack, `WebContentRecovery.swift` and `src/ui/native/recovery.ts`) | Once the page has been seen, a web view without any readable element counts as blank: the test keeps a screenshot and the accessibility tree, waits up to 150 s for the reload, and starts the current step over: it skips onboarding again if it reappears, then goes back from the restored screens to the tab bar, where every step starts |

Every workaround prints a `UITEST-…` line. `ci/ios-ui-tests.sh` turns those into warnings on the run,
and for a blank page it saves WebKit's own log lines about the WebContent process
(`webcontent-events.txt`, plus any WebContent crash report) to the `ui-test-screenshots` artifact. The
full app and WebKit log is `app-webkit.log` in `ui-test-logs`. A warning that comes back often is worth
reading: it may be a real problem in the app rather than the simulator.
