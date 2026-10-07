### Added

- Release dry run: a manual run of the `release` workflow with a version rehearses the whole
  release from `main` (prepare on the runner, IPA build, draft release checked and deleted; no tag,
  nothing published), and a test runs `prepare` then `verify-tag` on a copy of the tree.
