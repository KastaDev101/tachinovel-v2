### Changed

- UI crawler: a control that does nothing on one tap but reacts to five quick taps (a hidden gesture,
  like About › version → Voice Lab) is reported as a warning instead of a dead control.
- UI crawler: a control covered by a toast is a warning (toasts expire on their own; whether one is still up
  depended on timing and failed runs at random).
