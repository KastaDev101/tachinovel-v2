### Added

- Listen player: a speed slider (0.5×–2.5× in 0.05 steps) next to the preset chips (a chip snaps the
  slider; the slider lights up the chip it sits on), and "Voice volume" (0–150 %, with a limiter above
  100 % so a boosted voice doesn't distort). Both are saved and apply to every voice: Kokoro, the system
  voice and PC audio. Now Playing shows the speed.

### Changed

- Listen is in the reader's bottom bar now, next to Chapters, Auto-scroll, Night and Appearance, so it
  shows and hides with the bars. While listening it opens the player, and the mini player in the reader
  follows the bars too. The floating headphones button is gone.
- The mini player and the Listen player say which voice is speaking: "Kokoro · Heart", or "System voice
  (fallback)" with the reason (Kokoro is starting, catching up, the iPhone is hot, unavailable, off).
- All voices play through the app's own audio engine: the system voice is rendered into it, and PC audio
  plays through an engine file player instead of AVPlayer, so speed and volume work the same everywhere.
