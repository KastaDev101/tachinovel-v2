### Fixed

- CI: the Debug simulator build sometimes failed with a Swift compiler crash (swift-frontend 6.3.3,
  SendNonSendable diagnostics on the share bridge); the share call no longer captures a mutable array
  across queues.
