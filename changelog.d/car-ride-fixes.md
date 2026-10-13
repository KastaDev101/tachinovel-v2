### Fixed

- Listen goes from one chapter into the next after a short pause (about a second), with no wait: the next chapter is
  added to the read while the current one plays and rendered ahead like the rest, so Nephis carries on in the same
  voice instead of stopping and starting again cold.
- Nephis no longer breaks off in the middle of a very long sentence: the parts of a sentence too long for one model
  pass are read as one sentence with a comma's pause between them, not as two sentences with a restart, and a call
  never ends inside a sentence the script split.
- An "s" that opens a word ("Still", "Spell", "Sky") is no longer cut off as if it were an "uh", and soft "s" sounds
  at the start or end of a sentence are no longer trimmed or blended away at her joins.
- A line Nephis kept talking past (her model sometimes runs on and says it again, most often a chapter title read
  alone) is read again, and cut after its text if it runs on every time, so a chapter title is heard once.

### Added

- The diagnostics log (native.log) shows each of her joins (pieces, trims, pauses) and every wait for audio while
  listening, with times, so a break heard on a drive can be found.
