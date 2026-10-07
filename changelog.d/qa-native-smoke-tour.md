### Added

- CI simulator smoke: a native tour taps through the document picker (Restore from Files…, swiped away and
  cancelled), the Listen player, the share sheet, Listen, the mini player and car player controls,
  brightness and keep-awake, with a screenshot every 4 s; it fails on a crash or a crash report (the
  Debug-only `SmokeResponder` answers system sheets like a user would).

### Fixed

- A document picker (Restore from Files…, Link audio folder) swiped down instead of cancelled answered
  nothing, which left the native popup queue waiting forever: no alert, action sheet, share sheet or
  picker appeared again until the app was restarted. A picker that goes away unanswered now counts as
  cancelled.
- A document picker that took more than a second to come up (its view service starts first: cold start,
  slow device) was answered as cancelled while it appeared, so the file picked in it went nowhere
  (Restore from Files… and Link audio folder did nothing). A picker now gets up to 15 s to appear.
