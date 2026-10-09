### Changed

- Nephis is the app's one voice: Settings › Voices shows her, her settings and the Voice test; the Narrator, the
  Kokoro voice lists and the experimental engines are gone from the menus. Her backup voice (when the phone is too
  hot for her) is re-matched to how she sounds now.
- Nephis has a new voice, made from her own narration, and reads in moods when Mood voices is on: tense, sad,
  tender, playful and intense, each a read of her own voice (a mood she has no read for yet stays calm). A drawl
  ("was… is") in a question, or in a line not said to someone, is hesitation now, not teasing, so grim dialogue no
  longer reads playful.

### Fixed

- Listen no longer goes silent when the phone gets critically hot while Nephis reads: the backup voice takes over
  until it cools (it used to wait for her model indefinitely).
- Listen shows the novel's cover on the lock screen, in Control Center and in CarPlay when you start from the reader.
- Nephis: no buzz in long pauses, no clipped endings on words that trail off, numbers and codes read as people say
  them ("312", "3rd", "APC", "L0-49"), and her phone stays cooler (fewer redo takes while it is warm).

### Added

- Prepare for the drive reads in Nephis's voice when she is your voice: chapters are rendered ahead (best of two
  takes, her moods, pauses and EQ), so in the car the phone only plays files.
- Voice test › 15-minute test with your own chapter: records what plays while you listen the usual way, with the
  phone's heat, the voice's speed and any break or voice switch every 15 seconds.
- Long LitRPG lists ("Memories: [A], [B]…", six or more items) are read as a summary: how many, and what's new since
  the novel's previous chapter that had the list ("Memories: 32. New: …"), or the first few the first time. The
  reader still shows the whole list.
- Nephis model packs can carry her timing, level and tone per mood and her EQ for that model.

- Voice Lab › Test moods: the on-device AI director over the chapter you last started with Listen, next to the
  rules' moods, with a report to copy.
- Eleven moods for Nephis (calm plus wry, playful, tense, dread, intense, sad, tender, awe, hushed, triumph, cold):
  the on-device AI director now picks from all of them. Wry, for dry humor, can carry a single line (a joke is
  often one sentence); the other moods need a neighbouring sentence to agree, so her voice doesn't flicker. The
  Narrator reads dread as tense.
- Nephis model packs (personal flavor): a ".tnmodel" made on the PC holds her trained Pocket TTS model and her voice
  files for it; open it in TachiNovel (Files, share sheet) or copy it into the app's Documents and she reads with it.
- Planning a paragraph's pieces no longer prepares her voice just to count tokens (one voice prefill less per call).
