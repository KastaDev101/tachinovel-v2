### Fixed

- Nephis with her studio no longer stays silent: her first sentences play in her plain sound straight away, and the
  studio joins once a few seconds of audio are ready (before, every sentence before the first one played waited for
  the studio, and a studio slower than real time left the Voice test silent for over a minute). A sentence the studio
  can't finish in real time plays in her plain sound instead, and after three such sentences in a row the studio is
  switched off for the rest of the read ("studio too slow"), so reading never stops for it.
- Her studio's speed is now in the diagnostics: every sentence it works on writes its speed (× real time), its
  blueprint and vocoder time and its pieces to native.log in the Diagnostics folder, along with the chips its models
  were loaded for and why it stepped aside or was switched off. The Voice test report shows the same per call, plus the
  last and slowest speed in plain words.
