# Contributing

TachiNovel v2 is a one-maintainer project; most changes are written by AI coding agents working in
parallel and merged by a coordinator. These rules keep that safe. They apply to people too.

## The flow: branch → PR → checks → merge

1. **Start from `origin/main` in your own worktree**, one branch per topic:
   ```sh
   git fetch origin
   git worktree add ../tachinovel-v2-<topic> -b <topic> origin/main
   ```
2. **Keep the PR small and about one thing.** Unrelated fixes go in their own PR.
3. **Check locally before pushing:** `npm run check` (typecheck, both flavors, tests, Xcode project
   check). Run `npm run test:shell` too when you touch the UI, the bridge or the core.
4. **Open the PR** with `gh pr create` and fill in the template (what/why, how tested, checklist).
5. **Required checks** must pass: `web`, `shell`, `ios-compile + simulator smoke`,
   `ios-ipa (unsigned, for AltStore)`. Conversations must be resolved.
6. **The coordinator merges.** Agents never merge their own PRs, never enable auto-merge, never use admin
   bypass and never force-push `main` or someone else's branch. History on `main` is linear (squash or
   rebase merges).

If `main` moves while your PR is open and there is a conflict, rebase your own branch on `origin/main`
and push with `--force-with-lease` (your branch only), or ask the coordinator.

## CI cost

Every push to a PR runs two macOS jobs (about 15 minutes each, mostly the first simulator boot). Public
repos get them free, but they are slow and they queue:

- Push when the change is ready, not after every commit. Batch fixups into one push.
- The Swift layer cannot be compiled on Windows; CI is the compiler. Read the `xcodebuild-*-log`
  artifacts carefully and fix every error from one run in one push.
- A newer push cancels the older run of the same branch (workflow `concurrency`).

## Code rules

- **`vendor/v1/` is read-only.** Refresh it with `npm run vendor:v1`; build-time adjustments live in
  `tools/v1.ts` and must match exactly once.
- **Contracts:** `src/core/native-api.ts`, `Native/Core/NativeHostAPI.swift` and
  `tests/helpers/native-mock.ts` change together, in one PR.
- **New Swift files:** run `node tools/ios-project.ts` to register them in the Xcode project.
- **Imports** use explicit `.ts` extensions; TypeScript is strict; no `any` without a comment saying why.
- **Line endings** are LF (`.gitattributes`, `.editorconfig`). Don't run formatters over whole files.
- **Tests** for logic that can be tested on a PC (Vitest); UI flows in the PC shell test.
- **Third-party code or assets:** add them to `THIRD_PARTY_NOTICES.md` with their license before they
  ship. Check that the license allows use in a proprietary App Store app.

## Toolchain

- **TypeScript 7** (the native compiler) typechecks everything: `npm run typecheck` (tools/typecheck.ts).
- TypeScript 7.0 has **no stable JavaScript API** (`require('typescript')` only exposes the version).
  Nothing in this repo needs the API today: esbuild and Vitest strip types themselves, and Capacitor's CLI
  (8.5.2+) loads `capacitor.config.ts` with Node's built-in type stripping when the API is missing. A tool
  that does need the compiler API (a lint plugin with type-aware rules, a codegen script) must depend on
  Microsoft's compatibility package `@typescript/typescript6` and import it
  (`import ts from '@typescript/typescript6'`), never `typescript`.
  TODO: revisit when TypeScript 7.1 ships its stable API, then drop this rule.

## Swift quality gates

The `ios-compile` job ends with two gates (both in `tools/swift-quality.ts`, unit-tested on the PC):

- **No new compiler warnings.** The app target builds with `SWIFT_STRICT_CONCURRENCY = complete` (Swift 5
  mode: concurrency problems are warnings). Existing warnings are listed in
  `ci/swift-warnings-baseline.txt`; any warning not in it fails the job. Matching ignores line numbers.
  When you fix warnings, shrink the baseline: download the `xcodebuild-simulator-log` artifact and run
  `node tools/swift-quality.ts warnings xcodebuild.log --update`. Never add to the baseline to get a PR
  through; fix the warning (or explain why not in the PR).
- **SwiftLint** ([`.swiftlint.yml`](.swiftlint.yml), pinned release in `ci/swiftlint.sh`): strict, every
  violation fails. SwiftLint can't run on Windows; the annotations on the PR's checks show each
  violation with its file and line.

Paths owned by another workstream are **report-only** for both gates (listed in
`tools/swift-quality.ts` `REPORT_ONLY`, currently the voice and narration code): their findings show as
notices and don't fail the build. Remove a path from the list once its owner has cleaned it up.

If the Swift compiler itself crashes (seen once with Swift 6.3.3 in the `SendNonSendable` pass), the log
names the function; restructure that closure or revert the change that triggered it.

## Public repository hygiene

The repository is public. Never commit:

- secrets, API keys, certificates, provisioning profiles or `.p8`/`.p12` files (use GitHub secrets);
- personal paths (like a Windows user folder), email addresses other than GitHub noreply addresses,
  device names or identifiers;
- real user data: backups, libraries, reading history or logs. Fixtures and screenshots use synthetic
  data only.

Security problems go through private reporting, not issues: see [SECURITY.md](SECURITY.md).

## Commits, changelog and docs

- Commit messages: `Area: what changed (why)`, for example `CI smoke: capture launchctl output before
  grep`. AI agents add their `Co-Authored-By` trailer.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under **Unreleased** for anything that changes the app,
  the build or releases.
- Update `docs/architecture.md` or `docs/roadmap.md` when behavior, contracts or setup change.

## Parallel work

Several agents work at the same time. Stay inside the files your task names; if you need a change in
someone else's area (for example the voice engine and narration player on `voice-spike`), describe it in
your PR or report instead of editing it.
