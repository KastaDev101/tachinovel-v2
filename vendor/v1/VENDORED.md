# Vendored v1 snapshot

Read-only copy of TachiNovel v1 sources, used by the v2 build (`@v1/*` alias, tools/v1.ts).

- From: the v1 `tachinovel` repo (local repo, no remote)
- commit: f788523514c876f79562f7cfb67d87cbf5bbe674
- Taken: 2026-10-06 with `git archive HEAD` (committed state only)
- Paths: `src/shared`, `src/script`, `src/plugin-host`, `src/ui`, `src/types`, `plugins/stonescape.ts`, `plugins/verified.json`
- License: MIT (v1 package.json). `src/shared/lnreader/` holds LNReader plugin types, MIT, © LNReader contributors
  (https://github.com/LNReader/lnreader-plugins); keep that notice with any copy.

Do not edit files here. Refresh with `npm run vendor:v1` (or `node tools/vendor-v1.ts --worktree` to include
v1's uncommitted changes), or build against a live v1 checkout with `V1_ROOT=../tachinovel npm run build`.
Requested v1 changes that would remove v2's build-time patches are listed in docs/roadmap.md.
