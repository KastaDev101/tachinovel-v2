### Added

- On-device voices: Kokoro-82M runs on the iPhone and is bundled with the app (FluidAudio 0.17.5 Core ML,
  6 English voices, about 93 MB in the bundle, pinned by revision and SHA-256 in
  `ios/kokoro-models.lock.json` and fetched at build time, never committed). It is the default voice for
  every chapter. The Apple voice takes over sentence by sentence when Kokoro is loading, fails, falls
  behind or the phone is hot, and Kokoro takes over again once it is ahead.
- More › Voices: the voices with ▶ samples, a default voice, the Apple fallback with a Premium-voice
  hint, a pronunciation lexicon (global and per novel, also applied to Kokoro), Kokoro on/off and
  Advanced › "Use PC audio when available" (off by default). A voice per novel from the Listen player.
- The reader highlights the sentence being spoken, whichever voice speaks it.
- A hidden Voice Lab (About › tap the version 5 times): time to first audio, real-time factor,
  compute units, memory, thermal state, fallbacks and crashes, and a copyable report.
- CI: `voice-quality` (HDVoice unit tests, every voice checked on the bundled model, ASR round trip)
  and `voice-simulator` (Listen flow, highlight and the Apple fallback in the simulator). `ios-ipa`
  reports the IPA and app size.

### Changed

- PC-narrated audio is opt-in (Settings › Voices › Advanced). With it off, More shows "Listen" (the
  Listen player) instead of the PC narrator's "Listen in the Car" screen.
- Release and TestFlight builds fetch the bundled voice model.
