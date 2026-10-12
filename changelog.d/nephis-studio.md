### Added

- Nephis studio sound (off by default): when a Nephis pack carries the studio models, her voice can be rebuilt at
  44.1 kHz studio quality on the phone. Voice Lab's Studio speed test reports the speed against real time, which
  chip each part runs on and the heat level.
- Nephis studio packs can carry a detail refiner (refiner.json + NephisRefiner): after the blueprint it puts back her
  fine detail, which otherwise comes out as faint static. Voice Lab's speed test includes its time.
- Her studio now plays in Listen, the Voice Lab player and "Prepare for the drive" (studio switch on): a read with it
  runs at 44.1 kHz from start to end, and other voices filling in are converted to that rate. Before, every studio
  line was handed to another voice. Chapters prepared with her studio are saved at 44.1 kHz, 128 kbps. Everything
  without the studio stays at 24 kHz and 32 kbps, as before.
- The Voice test report lists her calls one by one: whether her studio rendered each one or why it stepped aside
  (short of audio, phone too hot, failed), its sample rate and mood, and where it falls in her audio. It also counts
  how many of her sentence ends were cut off while still audible and how many were let fade out. The 2-minute test
  records 32-bit float at the read's rate.

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
- Nephis studio sound: each call has one tone. Her studio sound no longer gets the 24 kHz EQ and mood treble on top,
  and a call the studio skips sounds exactly like her reading without the studio. The studio gets her sketch at the
  scale it was trained on. Short first lines (under about 1 s) and very long paragraphs (about 48 s and more) keep
  her studio sound instead of dropping to her plain one. A broken model output plays her plain sound instead of noise.
- Nephis with her studio: a sentence that is still audible where the voice would stop now fades out (up to half a
  second more) instead of being cut, which is the clipped final "s".
- Turning her studio on or off during Listen starts the sentence again with the new sound. Before, her next lines
  went to another voice. Chapters prepared with and without her studio are kept apart.
- Opening a Nephis pack during Listen (or one installed from Documents after a read has started) that adds or drops
  her studio also starts the sentence again at the new rate, instead of the rest of the chapter going to another voice.

### Changed

- Settings › Voices › Voice test is now the one testing page: which Nephis pack is installed and whether it has her
  studio, a studio switch, one Run the test (studio speed test + 2-minute listen), a plain-words result and one Copy
  report. The hidden Voice Lab is no longer needed for testing.
