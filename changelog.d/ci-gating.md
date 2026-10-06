### Changed

- CI: a pull request runs only the macOS jobs its files can affect (UI tests for app code, the device
  IPA for native code and the build, the voice jobs for the voice engine and its UI); main, tags and
  manual runs still run everything.
