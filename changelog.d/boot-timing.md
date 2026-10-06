### Added

- Boot timing: the app logs when the library is really on screen (`boot: library visible …`), and the
  simulator smoke test reports tap → library per launch (`boot-times.txt`, a run notice).

### Changed

- The launch screen hides on the first frame that shows library content (at the latest after 3 s)
  instead of a fixed delay after the boot call, so it never reveals an empty library and doesn't wait
  needlessly.
