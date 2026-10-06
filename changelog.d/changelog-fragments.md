### Changed

- Changelog entries are now fragments in `changelog.d/` (one file per pull request), merged into
  CHANGELOG.md by `node tools/release.ts prepare`; the CI job `changelog` asks app-changing PRs for one.
