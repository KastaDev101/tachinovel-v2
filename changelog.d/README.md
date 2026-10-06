# Changelog fragments

Pull requests don't edit `CHANGELOG.md` (parallel PRs kept conflicting there). Each PR that changes what
the app does, how it is built or how it is released adds **one small file here** instead:

```
changelog.d/<branch-name>.md        e.g. changelog.d/pro-diagnostics.md
```

Content: one or more [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) sections (`### Added`,
`### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security`), each with `- ` bullets.
Continuation lines are indented by two spaces. Nothing else.

```markdown
### Added

- Crash and hang reports in Settings › Diagnostics, kept on the device.
```

- **Required** when a PR changes `src/` or `ios/` (the CI job `changelog` fails without one); a reminder
  only for docs, CI and dependency-only PRs.
- `node tools/release.ts changelog` previews the next release notes with all fragments merged.
- At release time `node tools/release.ts prepare <version>` merges the fragments into `CHANGELOG.md`
  (grouped by section) and deletes them (docs/release.md).
