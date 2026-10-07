### Added

- CI budgets: the `ios-ipa` job fails when the sideload IPA grows more than 10% over the committed
  baseline in `ci/budgets.json` (94.5 MB with the bundled Kokoro model), and the simulator smoke test
  warns when the cold-launch median (process start to library painted) is over its soft budget.
