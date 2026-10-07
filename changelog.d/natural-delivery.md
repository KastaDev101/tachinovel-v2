### Added

- The Narrator voice reads chapters with Pocket TTS (Kyutai, CC-BY-4.0; on-demand download in Settings › Voices ›
  Expressive voices). It runs on the Neural Engine and CPU, so it keeps reading with the screen locked and in CarPlay.
  Chatterbox Nano stays an option; when Pocket isn't downloaded, Nano reads, then Kokoro.
- Natural delivery for the narrator: a whole paragraph per model call (one thought, no sentence-by-sentence cuts),
  a director (moods, dialogue vs narration, emphasis, persona line classes), context pauses, recorded breaths with
  a lung budget, the clean-warm studio chain, rate leveling and speech shaping.
- Thoughts in single quotes ('Curse it...') are read as thoughts; chapters that quote speech with ‘…’ get their
  dialogue recognized.

### Changed

- When the narrator voice runs late at the start of a paragraph, Listen waits up to 2 seconds before the Apple
  voice takes over (was a quarter second), so a short delay becomes a longer pause instead of a voice switch.

### Fixed

- Pocket TTS no longer drops the rest of a line after an ellipsis ("Hmm... I've seen farmers do better.").
