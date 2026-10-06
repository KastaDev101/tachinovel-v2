### Added

- `node tools/revendor-v1.ts <v1 commit>`: one command to move `vendor/v1` to a v1 commit, re-check the
  build-time patches on both flavors, typecheck and test, with rollback on failure.

### Fixed

- `npm run vendor:v1` wrote CRLF files on Windows (git archive followed the v1 repo's `core.autocrlf`).
