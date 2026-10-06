## What and why

<!-- One topic per PR. What changes for the user or the build, and why. Link the issue or roadmap item. -->

## How it was tested

<!-- Commands you ran, what you checked by hand, screenshots for UI changes (synthetic data only). -->

## Checklist

- [ ] Branched from `origin/main`; one topic; no unrelated changes
- [ ] `npm run check` passes locally (typecheck, both flavors build, tests, Xcode project check)
- [ ] New Swift files registered with `node tools/ios-project.ts`
- [ ] Tests added or updated for logic that can be tested
- [ ] Changelog fragment added: `changelog.d/<branch-name>.md` (required when `src/` or `ios/` change; not `CHANGELOG.md`)
- [ ] Docs updated (`docs/architecture.md`, `docs/roadmap.md`, README) if behavior or setup changed
- [ ] New third-party code or assets added to `THIRD_PARTY_NOTICES.md` with their license
- [ ] No secrets, signing material, personal paths, emails or real user data (public repo)
- [ ] No edits to `vendor/v1/` (refresh it with `npm run vendor:v1` instead)
