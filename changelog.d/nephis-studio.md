### Added

- Nephis studio sound (off by default): when a Nephis pack carries the studio models, her voice can be rebuilt at
  44.1 kHz studio quality on the phone. Voice Lab's Studio speed test reports the speed against real time, which
  chip each part runs on and the heat level.
- Nephis studio packs can carry a detail refiner (refiner.json + NephisRefiner): after the blueprint it puts back her
  fine detail, which otherwise comes out as faint static. Voice Lab's speed test includes its time.

### Fixed

- Nephis studio: each sentence is rendered with the end of the one before it, so starts no longer begin from a cold
  edge; the last sound of a sentence (a final "s") is no longer clipped; long paragraphs are rendered in overlapping
  pieces instead of failing past 40 seconds; and if the studio fails for a sentence, her normal sound plays instead of
  nothing. The studio now also covers the first lines of a session.
- Listen no longer reads lines again: after a stop it goes on from the sentence heard last (it used to start from the
  top of the page, paragraphs above it), it starts from the first paragraph on the page rather than the one hidden under
  the status bar, and a quick second tap no longer starts the read twice. Nephis keeps the soft end of her last word (a final
  "s") when the next paragraph is late or the read starts over. The Voice test report counts read restarts, failed
  calls, sentences cut without audio and audio-route replays.

### Changed

- Settings › Voices › Voice test is now the one testing page: which Nephis pack is installed and whether it has her
  studio, a studio switch, one Run the test (studio speed test + 2-minute listen), a plain-words result and one Copy
  report. The hidden Voice Lab is no longer needed for testing.
