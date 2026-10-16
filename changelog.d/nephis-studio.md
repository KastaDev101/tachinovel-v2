### Added

- Audio downloads, part 1 (the engine): chapters render into audio files through the one pipeline Listen plays
  (her calls, her studio always, the dialogue pack, her finishing and real sentence cuts), so a downloaded chapter
  sounds like Listen. The director's moods are worked out for the whole chapter first and stored with the file.
  Renders resume from the last paragraph after an interruption, yield to live reading at the next call (and go on
  30 s after), pause at serious heat until two minutes cool, and wait in Low Power Mode on battery. Audio made with
  an older voice or settings is never played: Listen reads live and the chapter is rendered again while charging.
  Files are AAC 44.1 kHz 128 kbps with her studio. About a minute before a downloaded chapter ends, the next
  chapter's first calls are rendered so live reading starts at once. "Prepare for the drive" runs on the new engine;
  its files move to Application Support/NarrationAudio. Bridge for the coming screens: audioStatus, audioEnqueue,
  audioPause, audioResume, audioCancel, audioDelete, audioEstimate, audioSetOptions. Developer › "Best of 2 Takes
  for Audio". The reader's Listen plays a chapter's audio first when it has some in the current voice.
- The Voice Speed Test builds and finishes its calls with the same pipeline as Listen (its .wav is what Listen plays
  before the volume stage).

- Nephis's dialogue voice: a second Nephis pack with the role "dialogue" (pack.json, or Developer › Voice Packs › Edit ›
  "For Dialogue") reads quoted dialogue while her narrator pack reads the narration, in one continuous read. Quote
  routing handles tags inside a quote pair, quotations over several calls and paragraphs, stray marks, single-quoted
  thoughts (narration unless the pack opts in), apostrophes and short interjections. Per-mood style clips (a laugh clip
  for written laughter), pauses (new `clause`), the dialogue comma beat, tempo without a pitch change, EQ groups, the
  tuner's floor guard, a level match to the narrator and a 5 ms equal-power crossfade where the voice changes. Both
  models stay loaded (the dialogue one behind her studio, dropped first when memory runs low); without a dialogue pack
  every call reads exactly as before. The Voice speed test and the listening report show both voices, per-voice time
  and voice changes per minute (docs/expressive-tts.md "Dialogue packs").
- Pack chain `floorGuard` {"amount"}: the browser EQ tuner's downward expander after closeness, for any pack.
- A listening report at the end of each Listen session (Stop, 2 minutes idle, or paused and the app left):
  listen-<date>-<time>.json in the Diagnostics folder with the time heard, the voice and pack, her calls (studio used
  or skipped and why, the de-wind cleaner and its time, takes, lead-ins, speech checks, Mimi's work), breaks, time to
  first audio, heat at the start, at its worst and at the end, Low Power Mode, the battery used, × real time and errors.
  No audio and no book text.
- Voice Speed Test, with Developer options: "Start With 60 s Buffered" renders the passage the way Listen runs once it
  is going (a lead-in and a speech check on every call, background priority). Every report now has the work counters
  and where each call starts in the .wav (for the PC's join check).

- Developer options: tap the version in More › About 7 times ("Developer options on"; the first tap still copies the
  version). While they are on, More has a Developer row (hammer) with the voice's test tools and internals in one
  grouped list: Voice Speed Test, Voice Test, 15-Minute Test, Voice Packs, her Studio (Automatic / Off) and where it
  runs; Natural Delivery, AI Scene Reading, Studio Sound and Reset to Defaults; the Scene-Reading and Mood tests, a
  copied Voice Report, Now Playing, Voice Models and "Show Voice Details in the Player"; Mix a Voice; the phonemes field
  and JSON paste of the pronunciation editor; Use PC Audio and the Kokoro Voice Lab. A "Developer Options" switch at the
  bottom of About turns them off. They are kept natively (a page reload keeps them); the personal build starts with
  them on. The old 5-tap Voice Lab gesture is gone.
- Long-press the app icon for "Voice Speed Test" (while Developer options are on): it opens the speed test directly.
- Diagnostics folder: the menu has "Open in Files" (iCloud's upload state shows on each file) and says where the folder
  is ("iCloud Drive › TachiNovel-Diagnostics").
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

- Diagnostics folder: "saved in TachiNovel-Diagnostics" no longer hides that iCloud isn't uploading. Each copy checks
  how iCloud did with the one before: an upload error (iCloud storage full), a folder outside iCloud Drive, or copies
  not uploaded for 20 minutes show on the Diagnostics row ("– not uploading"), in its menu (with Reconnect Folder…), in a
  toast and in the Voice Speed Test's result. A folder moved to Recently Deleted or gone counts as disconnected instead
  of being written to (and the folder is never recreated as a new local one). Files under logs/ keep their folders
  (reports/, metrickit/) instead of arriving as "privatereports…".
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

- Cooler listening, with no change to her sound: her renders run at background priority while more than 30 s is
  banked (normal again under 15 s; such calls never count toward switching her studio off or skipping extras); she
  banks 90 s ahead instead of 120 s; the de-wind cleaner allocates nothing per 10 ms frame and feeds its network's
  state back as Core ML arrays; Mimi's output is read without an object per sample; the AI director keeps its moods,
  word senses and chapter brief across seeks and restarts of a chapter instead of asking the on-device model again;
  the Diagnostics folder copies every 10 minutes while a voice works (every minute before) and reads the app's log
  incrementally.
- The Voice Lab report (voice-lab.json) and the speed test count her work: takes, lead-ins, speech checks, Mimi's
  latents per decoder (played, analysis, end guard) and the de-wind cleaner's network, I/O and signal-processing time.

- More › Voices is tidy: the Nephis card (her pack and "Studio" in the personal build), Voice Settings (Scene Moods,
  [System] messages, and a line saying whether scene moods use Apple Intelligence or the built-in rules),
  Pronunciations and In the Car. The test tools, voice packs, her studio switch, delivery internals and PC audio moved
  to More › Developer; the Voice test no longer has the "Her studio" switch.
- Natural delivery, studio sound and her studio are automatic (AI scene reading wherever Apple Intelligence is
  available): an "off" saved with the old switches goes back on once; only More › Developer switches them off now.
- The Listen player's voice chip says "Nephis" (or "Backup voice" while another voice stands in); the engine and the
  reason for a stand-in show with Developer options' "Show Voice Details in the Player". Its Voice panel is titled with
  the novel's name and has Voice Settings and Pronunciations for This Novel (the Voice Speed Test with Developer options).
- "Share N Crash & Hang Reports" is a tinted row under Copy Full Diagnostics instead of a floating bar (and no timer
  checks for it while the app runs).
- Wording: Nephis prepares chapters for the drive (the sheet, the novel card and Help said Kokoro); preparing waits
  with "Paused while you listen"; consistent Title Case for screen titles, row titles and buttons.
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
- The voice screens look like the rest of the app (cleanup 2): v1's grouped lists in light and dark mode (they were
  always dark), a centred title with "‹ Back", tinted group headers, explanations as footers, SF Symbols instead of
  text glyphs, skeleton rows while loading, Dynamic Type in the labs, v1's toast (above the mini player) and the
  native confirmation alert for every delete (voice packs, mixes, pronunciations, models, prepared audio).
- More › Voices: Nephis shows her Narrator pack ("· Studio") and her Dialogue pack ("Uses the narrator" without one);
  "Download Her Voice" downloads her model right there with its progress (after a confirmation with its size), instead
  of opening the Voice models lab; Car Buttons is a segmented control.
- The Backup Voice is back: the Kokoro voice that reads only when Nephis can't (her matched voice by default), with the
  three best voices first, ▶ samples and All Voices (your mixes too; Mix a Voice and Edit with Developer options).
  Native reads her stand-in sentences with the picked voice (VoicePreferences.backupVoice).
- Pronunciations has one title and an "All Novels | This Novel" switch when opened for a novel.
- The Voice models lab reads its numbers only while something runs (a download, a sample, a speed test), the Kokoro
  Voice Lab only while narration plays (both read every second before).
