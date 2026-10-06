# Versions and releases

## One version source

`package.json` `version` is the app version. Everything else is derived from it:

| Where | Value | Example |
|---|---|---|
| `package.json`, About screen, diagnostics, git tag, release name | full SemVer version | `2.1.0-beta.1`, tag `v2.1.0-beta.1` |
| iOS `CFBundleShortVersionString` (`MARKETING_VERSION`) | `major.minor.patch` only (Apple accepts up to three integers) | `2.1.0` |
| iOS `CFBundleVersion` (`CURRENT_PROJECT_VERSION`) | the CI run number of the workflow that built it | `57` |

- `tools/release.ts` does the mapping. CI scripts call `node tools/release.ts version`; the Xcode project
  keeps the same `MARKETING_VERSION` so a local Xcode build shows the right version too, and
  `tests/release.test.ts` fails if the two drift apart.
- Build numbers: the `ios` workflow numbers the main/PR artifacts and TestFlight uploads; the `release`
  workflow numbers release IPAs with its own run counter. Use the version plus the git hash shown on the
  About screen (`Version 2.1.0-beta.1 (abc1234)`) to identify a build exactly.
- Pre-release suffixes (`-alpha.N`, `-beta.N`, `-rc.N`) mark GitHub pre-releases. Two pre-releases of the
  same `major.minor.patch` look identical to iOS apart from the build number; that is fine for sideloading
  and TestFlight.

SemVer for an app: **major** for a data or backup format change that older versions can't read (or a big
redesign), **minor** for new features, **patch** for fixes only.

## Cutting a release

1. Check the notes: `node tools/release.ts changelog` prints "Unreleased" with every fragment in
   `changelog.d/` merged (each PR adds one; see changelog.d/README.md).
2. On a branch from `origin/main`:
   ```sh
   node tools/release.ts prepare 2.0.0-alpha.2
   ```
   This sets `package.json` and the lockfile to the new version, updates `MARKETING_VERSION` in the Xcode
   project, merges the `changelog.d/` fragments into "Unreleased" (and deletes them), and moves it into
   `## [2.0.0-alpha.2] - <today>` with compare links. Review the diff,
   run `npm run check`, and open a PR titled `Release 2.0.0-alpha.2`.
3. After the coordinator merges it, tag the release PR's merge commit and push the tag:
   ```sh
   git fetch origin
   sha=$(gh pr view <release-pr-number> --json mergeCommit --jq .mergeCommit.oid)
   git tag -a v2.0.0-alpha.2 -m "TachiNovel 2.0.0-alpha.2" "$sha"
   git push origin v2.0.0-alpha.2
   ```
   (`origin/main` instead of `"$sha"` is fine when nothing else merged after it; otherwise a later PR's
   changelog fragment would ship without being in these notes.)
4. The `release` workflow ([.github/workflows/release.yml](../.github/workflows/release.yml)) then:
   - **verify** (Ubuntu, ~1 min): the tagged commit is on `main`; the tag equals `v` + the package
     version; the Xcode project is in sync; CHANGELOG has notes for the version. Any mismatch stops the
     release before a macOS minute is spent.
   - **build** (macOS, ~10 min): personal-flavor web build, `cap sync`, unsigned device build
     (`ci/ios-unsigned-ipa.sh`) → `TachiNovel-<version>-unsigned.ipa` and `SHA256SUMS.txt`. This job has a
     read-only token.
   - **publish** (Ubuntu): a build-provenance attestation for the IPA, then a GitHub Release named
     `TachiNovel <version>` with the CHANGELOG section as notes, install and verify instructions, and the
     two files attached. Versions with a suffix are marked pre-release.
5. The `ios` workflow runs on the same tag (web checks, simulator smoke test; TestFlight upload once the
   App Store Connect secrets exist). Check it is green too.

### Dry run (before tagging)

Rehearse a release from `main` without committing, tagging or publishing anything:

```sh
gh workflow run release.yml --ref main -f version=2.0.0-alpha.2
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

The run applies `node tools/release.ts prepare <version>` on the runners only (verify and build), so the
notes are the pending fragments merged exactly as the release PR will merge them, and the IPA carries the
new version. **publish** then creates a **draft** release `v<version>-dryrun-<run id>` on the commit
(drafts create no tag and only maintainers can see them), checks that both files are attached and that
a suffixed version is a pre-release, writes the result and the full notes to the run summary, and deletes
the draft. No attestation is made. It costs one macOS build (~10 min), so run it once before a release,
not per PR. Locally, `tests/release.test.ts` runs the same `prepare` → `verify-tag` steps on a copy of
the tree.

The repository is public, so releases and their IPAs are public. The IPA is the **personal** flavor
(repository variable `FLAVOR` overrides it), unsigned, with no entitlements: AltStore/SideStore re-sign
it on the phone ([how-to-test-tonight.md](how-to-test-tonight.md)).

**AltStore source.** After publishing, the workflow writes `apps.json` (AltStore's source format,
`tools/altstore-source.ts`) with this release's IPA as the newest version (bundle id, version, build,
minimum iOS and privacy strings read from the IPA's own Info.plist; `downloadURL` = this release's
versioned asset) and uploads it to the rolling release **`altstore-source`** (created on first use, not
a pre-release, never deleted; the file is replaced with `--clobber`). Stable URL for AltStore:
`https://github.com/KastaDev101/tachinovel-v2/releases/download/altstore-source/apps.json`.

## Web updates (personal flavor)

Most changes are web UI and core JS, so the app can update those without a new IPA. Each release also
publishes a **signed web update** on the rolling release **`ota`**: `manifest.json` (Ed25519-signed) and
`web-<build>.json` (the pack: the exact `www/` that went into the IPA). The app checks it 20 s after
launch (at most every 6 hours), from background refresh, and from More › About › **App Update**:

1. the manifest's signature must verify with the public key in `src/core/ota/public-key.ts`;
2. it must be for the personal flavor, for this app's **native level** (`src/core/ota/native-level.ts` =
   `WebBundle.nativeLevel` in Swift; bump both with any incompatible native↔JS change), newer than the
   bundle running now, and not rolled back before;
3. the pack's SHA-256 and size must match the signed manifest; paths must stay inside the bundle.

The core stages it under `ota/bundles/<id>/`; `WebBundle.swift` switches to it at the **next launch**.
If a staged bundle fails to answer the UI's `app.boot` within 30 s on two launches in a row, the app
falls back to the bundle inside the IPA by itself and never takes that update again. The store flavor
has none of this (the code is compiled out; the Swift loader is inert without the personal build info).

**One-time setup (owner):**

1. On your PC, outside the repository: `node tools/ota-keygen.ts --out=<a private folder>`. It writes the
   private key `tachinovel-ota-signing-key.pem` and prints the public key.
2. `gh secret set OTA_SIGNING_KEY --repo KastaDev101/tachinovel-v2 < <that .pem>`
3. In a pull request, set `OTA_PUBLIC_KEY` in `src/core/ota/public-key.ts` to the printed public key.
4. Keep the .pem in a password manager and delete the file. Anyone with it can push code to the app.

Until the public key is in a build, the app reports "not set up" and never downloads anything; until the
secret exists, releases skip the web update step.

## Verifying a download

```sh
shasum -a 256 TachiNovel-2.0.0-alpha.2-unsigned.ipa          # compare with SHA256SUMS.txt
gh attestation verify TachiNovel-2.0.0-alpha.2-unsigned.ipa --repo KastaDev101/tachinovel-v2
```

The attestation proves the file was built by this repository's release workflow from the tagged commit.

## When something goes wrong

| Problem | Fix |
|---|---|
| verify: "tag … does not match package.json" | Delete the tag (`git push origin :refs/tags/vX` and `git tag -d vX`), release the right version (step 2) or tag the right commit |
| verify: "not on main" | Only tag commits that have been merged into `main` |
| verify: "no CHANGELOG section" | Run step 2; a tag without notes is refused |
| build failed (flaky runner, Xcode) | Re-run the failed jobs from the Actions page; nothing was published yet |
| A dry run left a `-dryrun-` draft (cancelled mid-publish) | Delete the draft on the Releases page; drafts have no tag |
| A published release is bad | Mark it as a pre-release or delete it on GitHub (and the tag), fix on `main`, release a new patch version. Never re-use a version number |

## Later: App Store builds

TestFlight and App Store builds are signed and uploaded by the `testflight` job of the `ios` workflow on
`v*` tags (see [architecture.md](architecture.md) §9); it skips until the Apple Developer account and the
App Store Connect secrets exist. App Store Connect needs a strictly increasing build number per version,
which the `ios` workflow's run number provides.
