### Changed

- Nephis no longer renders flat out: she banks a cushion of audio ahead (2 minutes, 1 minute once the phone is warm),
  rests until playback has used 30 s (20 s warm) of it, then renders again. Listen and the Voice test are paced the same
  way, and the Voice test report shows the cushion, seconds made against seconds played, and how much of the time she
  was working.
- A Nephis pack can ask for her tone EQ after her studio (pack.json chain "eqAfterStudio": true), for a darker tone with
  the studio. Packs that don't ask sound exactly as before.
