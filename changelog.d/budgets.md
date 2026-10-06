### Added

- CI budgets: the `ios-ipa` job fails when the sideload IPA grows more than 10% over the committed
  baseline in `ci/budgets.json` (enforced once the baseline is recorded), and the simulator smoke test
  warns when the cold-launch median (process start to library painted) is over its soft budget.
