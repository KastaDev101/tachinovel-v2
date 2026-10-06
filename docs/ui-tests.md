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
