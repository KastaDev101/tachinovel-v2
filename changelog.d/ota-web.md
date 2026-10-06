### Added

- Web updates (personal flavor): the app downloads signed web bundles (UI and core) published with each
  release, verifies their Ed25519 signature and checksum, and switches at the next launch; if an update
  fails to start twice, it rolls back to the built-in bundle by itself. More › About › App Update shows
  the running bundle and checks for updates. Not in the store flavor.
