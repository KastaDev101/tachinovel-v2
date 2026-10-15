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
- A Nephis pack can ask for her text as written (pack.json chain "text": "raw"): her model then reads "..." as an
  ellipsis instead of a comma or a period, and "Hmmm", capitals and drawn-out words as they are in the book, while
  numbers, codes, acronyms, abbreviations, Pronunciations and her respellings are still taken care of. Her pause after a
  piece ending in "..." is then her own per-mood pause after one. In the lab, read this way her model lost no last word
  and kept her timing better. Packs without the setting (v4.2 included) read exactly as before. The Voice test's copied
  report says which text her pack reads.
- The Voice test report lists her calls one by one: whether her studio rendered each one or why it stepped aside
  (short of audio, phone too hot, failed), its sample rate and mood, and where it falls in her audio. It also counts
  how many of her sentence ends were cut off while still audible and how many were let fade out. The 2-minute test
  records 32-bit float at the read's rate.
- A Nephis pack can carry its own studio EQ (pack.json chain "studioEQ": an overall gain and up to 8 high shelf, low
  shelf or peaking sections): it runs on every sentence her studio rendered, after the breath polish, so her studio
  sound on the phone matches the audio approved on the PC. Packs without it sound exactly as before; a section type the
  app doesn't know is skipped.
- A Nephis pack can carry the browser EQ tuner's settings: a low cut and a top cut in its studio EQ ("highPass",
  "lowPass"), and on every sentence of hers, before the mastering, "closeness" (the tuner's compressor), "breathAir" (a
  little air on top, its exciter) and "room" (a small, close room, e.g. {"amount": 0.07}). Each sounds as in the tuner
  and carries from sentence to sentence (the room's echo rolls on into the next sentence instead of being cut). Packs
  without them sound exactly as before. The Voice speed test lists them and counts their time under EQ and finishing.
- A Nephis pack can carry her de-wind cleaner ("dewind": {"passes": 2}, the model in the pack): it takes the faint wind
  out of her voice on every sentence, first thing after her voice is made, and carries from sentence to sentence; each
  sentence still comes out whole and as long as before. Packs without it sound exactly as before; a pack that asks for
  it without the model plays without it and says so. The Voice speed test shows it and its time.
- The breath air's two high-pass filters now have the browser EQ tuner's Q (1 dB in WebAudio, 1.122), as tuned, and a
  pack can soften it on loud peaks ("breathAir": {"amount": 0.2, "drive": 0.3}, the tuner's "peak-safe"): quiet words
  get the same air, loud dialogue no longer sounds robotic. Without "drive" it sounds exactly as before.
- Voice speed test (Settings › Voices, the Listen player's Voice panel, the Voice test page and Settings › Diagnostics):
  one tap renders a 45-second passage with the Nephis pack in use exactly like Listen, without playing it, then says
  whether she keeps up, how soon the first audio is ready, the speed against real time, where the time goes (her voice
  model, the decoder, the studio's two parts, EQ), the slowest part, whether her studio ran every time, the phone, iOS,
  heat, Low Power Mode and free memory. Play result plays the passage; Copy report copies everything; the report and the
  audio are saved to the Diagnostics folder as speedtest-<date>-<time>.json and .wav.

### Fixed

- Nephis with a studio pack: her studio is on by default for every pack that has one (the "Her studio" switch is now
  per pack; switching it off is kept for that pack until it is installed again), and it renders every call it can
  afford, the first call of a read included, from its measured speed (a call gets it when its estimated studio time is
  at most half the audio buffered ahead, never counted under 1 s). Before, a call was her plain sound (clicks, no studio
  EQ) whenever less than 6 s was buffered, even with the studio at 23-47x real time; that rule now only applies when the
  studio is slow (under 4x), the phone is hot or in Low Power Mode.

- Nephis: the pauses between her sentences fade in and out over 40 ms with a smooth curve instead of 10 ms straight
  ramps, which could click where words meet a pause.

- Listen: a pause now holds when the system voice is reading. Paused just as it got going, or on its last word, it used
  to finish the sentence anyway, and at a chapter's end the next chapter then started by itself.
- Nephis studio: each sentence is rendered with the end of the one before it, so starts no longer begin from a cold
  edge; the last sound of a sentence (a final "s") is no longer clipped; long paragraphs are rendered in overlapping
  pieces instead of failing past 40 seconds; and if the studio fails for a sentence, her normal sound plays instead of
  nothing.
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
- Nephis is no longer switched off by mistake. The app now notes how each run ends (closed or swiped away, updated or
  refreshed by AltStore, put in the background idle, closed by iOS for memory, the phone restarting) and, as it goes
  down, which crash signal ended it; every 10 seconds while a voice works it notes the chapter, the voice, the phone's
  heat and memory. Only a real crash of her model counts: a memory fault off the main thread while her call runs (how
  Core ML crashes). An app bug during her call (like the Oct 9 crash), iOS closing the app without a crash, or a restart
  never does. Two real crashes in a row still hand over to her backup voice. Anything unsure is noted, never counted. A
  new app build starts her count over and turns her back on.
- The Voice test no longer runs the app out of memory (build 321 was closed by iOS during it). Her studio's speed test
  now runs alone: it stops the players, frees Nephis and Kokoro first, refuses with less than about 1,000 MB free (and
  says how much is free), and reports the memory used and free at each step; "Where her studio runs" is its own button.
  The test frees its own studio before the listening test and warms Nephis again, so the listening test starts the way
  Listen does. A read paused for the test keeps Nephis, and "Prepare for the drive" waits for her instead of failing.
  Freeing her model now really frees it, even while it loads or reads; after a memory warning she waits a minute
  (longer if it happens again soon) before loading again, and Kokoro reads meanwhile; she doesn't load with too little
  memory free (the report says so). Her studio loads in the background after her instead of with her, so her first
  word never waits for it (her plain sound until it is up, "still loading" in the report), and steps aside when memory
  runs low ("low memory"). Kokoro's first-launch warm-up runs after hers instead of at the same time, and broken studio
  outputs play her plain sound instead of crashing.
- Nephis no longer leaves an extra second of silence when her mood changes in the middle of a paragraph: she pauses
  there as she does between sentences.
- Nephis keeps conversations moving: between a quoted line and a reply, or a quote and the narration around it, she
  pauses about 0.66 s (0.5 s when the same speaker goes on), as in her own recordings, instead of a full paragraph pause.

### Changed

- Turning Nephis back on is one tap: "Turn Nephis back on" in Settings › Voices, the Listen player's Voice panel and on
  the Voice test, which also says in
  plain words what happened ("Closed in the background for memory at 2:32 PM, chapter 1026, phone warm. Not counted
  against Nephis."). The same line goes to Settings › Diagnostics.
- Settings › Voices › Voice test is now the one testing page: which Nephis pack is installed and whether it has her
  studio, a studio switch, one Run the test (studio speed test + 2-minute listen), a plain-words result and one Copy
  report. The hidden Voice Lab is no longer needed for testing.
- Diagnostics folder: the app's own voice log (native os_log lines, last hour) is copied as native.log, and a problem report adds native-log.txt, so a read that played nothing without crashing is explained on the PC.
- Nephis with Natural delivery off no longer repeats passages: each of her calls reads one sentence (only natural delivery can cut a paragraph's audio back into sentences; before, a whole paragraph's audio played as its first sentence and was read again from each sentence after it).
- Voice test with a studio pack gets going again: the studio speed test runs only when her studio is switched on (off: "Studio off: speed test skipped", straight to the listening test); it keeps to a 60 s budget and stops as soon as the studio can't reach real time, saying why in plain words ("studio too slow: 0.3x real time", "timed out after 60 s", "not enough memory to load the studio (X MB free)") before the listening test; Stop works during it (cancels the native test).
- A Nephis pack (.tnmodel) copied into the app's Documents (Apple Devices file sharing) now installs when you return to the app, not only at a fresh launch; one install at a time, and a file that failed isn't retried over and over in the same session.
