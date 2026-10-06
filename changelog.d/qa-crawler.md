### Added

- QA: a click-everything UI crawler (`npm run crawl`, docs/qa.md) taps every control of every reachable
  screen of the built app in WebKit (iPhone 16 Pro, dark and light, seeded synthetic library, fixed
  clock, no network) and reports crashes, console errors, dead controls, hung or slow taps, broken Back,
  layout escapes and covered controls, with screenshots. CI workflow `ui-crawler` runs it on pull
  requests and nightly.
