### Fixed

- UI tests: taps wait until the element is hittable (the web view rebuilds its accessibility tree while
  the page re-renders), which made the required ios-ui-tests check fail at random ("Skip" gone at the tap,
  "More" not hittable).
