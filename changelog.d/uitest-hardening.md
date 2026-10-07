### Fixed

- CI: the simulator UI test no longer fails on taps computed mid-animation or on a web view that
  reloads its page; it waits for elements to settle, retries taps that are safe to repeat, waits out a
  WebContent reload, and reports each workaround as a warning with WebKit's log.
