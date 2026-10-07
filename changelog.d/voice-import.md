### Added

- Imported voices (personal flavor): Settings › Voices › Expressive voices › Narrator voice. Voices designed
  on the PC (`tachinovel-narrator/py/export_voice.py` writes a `.tnvoice` file to iCloud Drive ›
  TachiNovel-Voices) come in with Import voice… (Files) or Open in TachiNovel from Files and the share sheet.
  Each has ▶ Play (its preview, or Chatterbox Nano reading a line), Use, Rename and Delete. The chosen voice
  is what Chatterbox Nano reads with instead of its built-in voice, kept across restarts; if its file is
  missing or invalid when the model loads, the built-in voice reads and the screen says why. Kokoro and
  Apple voice settings are separate and unchanged. docs/voice-import.md has the format and the steps.

### Security

- A `.tnvoice` file is checked before anything is kept: size caps before decompressing, only three allowed
  ZIP entries (no paths, no duplicates, no overlaps, no encryption or ZIP64), manifest schema with SHA-256
  per part, engine and model version, and the voice tensors' header parsed with bounds checks against the
  exact names, dtypes and shapes Chatterbox Nano's built-in voice has. Nothing in it is executed.
