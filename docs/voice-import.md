# Imported voices (personal flavor)

Status 2026-10-07: built and unit-tested; the phone checklist at the end is still to do.

Kasta designs original synthetic narrator voices on the PC (descriptions → Parler-TTS reference clips, no
recording of a real person) and wants to hear them on the iPhone. A voice is exported on the PC as a
`.tnvoice` file and imported in the app, where **Chatterbox Nano** (the expressive engine,
docs/expressive-tts.md) reads with it instead of its built-in voice. Kokoro and the Apple voice are separate
settings and never change.

## Make a voice on the PC and get it onto the iPhone

1. Have a reference clip of at least 15 seconds of one synthetic voice (for example
   `iCloud Drive/TachiNovel-TTS-Samples/tuning/round8-personas/ref-8A.wav`).
2. In `tachinovel-narrator`, run the exporter in the Chatterbox lab environment:

   ```
   ..\tachinovel-tts-lab\.venv-chatterbox\Scripts\python.exe -W ignore py\export_voice.py ^
       "%USERPROFILE%\iCloudDrive\TachiNovel-TTS-Samples\tuning\round8-personas\ref-8A.wav" --name "Mommy"
   ```

   It writes `iCloud Drive/TachiNovel-Voices/Mommy.tnvoice` (the default folder) plus, next to it, a
   10-second check clip `Mommy.check.wav` and `Mommy.check.json` (see "Verification" below). `--no-preview`
   leaves the short preview out of the file; `--out-dir` writes somewhere else.
3. Wait for iCloud to sync, then on the iPhone: Settings › Voices › **Expressive voices (experimental)** ›
   Narrator voice › **Import voice…** › iCloud Drive › TachiNovel-Voices › `Mommy.tnvoice`.
   Or tap the file in the Files app (or AirDrop it) and choose **Open in TachiNovel** / share to TachiNovel.
4. Tap **Use** on it: Chatterbox Nano now reads with that voice (▶ Play sample, the Voice Lab samples). The
   choice survives restarts. Download Chatterbox Nano on the same screen if it isn't yet (0.75 GB, Wi-Fi).

Each imported voice row has ▶ Play (the preview made on the PC; without one, Chatterbox Nano reads a line),
Use, Rename and Delete (two taps). The built-in voice stays in the list and can be chosen again.

## The `.tnvoice` format (version 1)

A ZIP file (stored or deflate) with exactly these entries, nothing else:

| Entry | Required | Max size | What |
|---|---|---|---|
| `manifest.json` | yes | 64 KB | description, below |
| `voice.safetensors` | yes | 2 MB | the voice: Chatterbox Nano's precomputed conditioning |
| `preview.m4a` | no | 3 MB | a short sample (AAC, made on the PC) |

`manifest.json`:

```json
{
  "format": "tachinovel-voice",
  "formatVersion": 1,
  "engine": "chatterbox-nano",
  "engineVersion": 1,
  "model": {
    "upstream": "ResembleAI/chatterbox-nano",
    "upstreamRevision": "<Hugging Face commit of the checkpoint>",
    "weights": "t3_nano_v1+s3gen_meanflow",
    "coreml": "FluidInference/chatterbox-nano-coreml@f28421eff8e34bb6d70663ba1e3b1295562c620b"
  },
  "name": "Mommy",
  "createdAt": "2026-10-07T08:00:00Z",
  "parts": [
    { "path": "voice.safetensors", "role": "conditioning", "bytes": 659232, "sha256": "<hex>" },
    { "path": "preview.m4a", "role": "preview", "bytes": 81234, "sha256": "<hex>" }
  ],
  "source": { "tool": "tachinovel-narrator/py/export_voice.py", "reference": "ref-8A.wav", "synthetic": true }
}
```

`voice.safetensors` has exactly the tensors of Chatterbox Nano's built-in `tables/voice-default.safetensors`
(FluidAudio 0.17.5 reads it; produced like mobius `export-tables-nano.py --ref-wav`):

| Tensor | dtype | shape | What |
|---|---|---|---|
| `t3_cond_emb` | F16 | 1 × 376 × 768 | T3 conditioning: 1 speaker row + 375 prompt-token rows (`t3.prepare_conditioning`) |
| `prompt_token` | I32 | 1 × 250 | S3Gen reference speech tokens (25 Hz, the first 10 s), ids `0..<6561` |
| `prompt_feat` | F16 | 1 × 500 × 80 | S3Gen reference mel (50 Hz) |
| `embedding` | F16 | 1 × 192 | CAMPPlus x-vector |

Same shapes as the built-in voice, so the per-call budgets don't change (135 BPE tokens of text, ≈ 9.9 s
of audio). That is why the reference must be at least 15 s long (375 tokens of T3 prompt).

## What the app checks (the file is untrusted)

`ios/App/ExpressiveVoice/Sources/ExpressiveCore/VoicePack.swift`, unit-tested in `VoicePackTests.swift`
(every reject path, truncated files and headers, random byte flips), run by the CI job voice-quality:

- the whole file ≤ 8 MB before anything is read into memory; every part's declared size checked against its
  cap **before** decompressing; output longer than declared is refused (zip bombs);
- ZIP: one disk, no ZIP64, no encryption, stored or deflate, ≤ 8 entries, no overlapping entries, local
  headers match the directory, CRC-32 and exact sizes; entry names must be exactly the three above — no
  folders, no `..`, no duplicates (nothing is ever written to a path taken from the file);
- manifest: the schema above; a newer `formatVersion` asks to update the app; another `engine`, another
  `engineVersion` or other `model.weights` is refused with what it was made for; every part listed with its
  size and SHA-256, and listed parts = parts in the file;
- `voice.safetensors`: 8-byte header length within bounds (≤ 64 KB), JSON header, offsets inside the payload,
  byte lengths = dtype × shape (overflow-checked), tensors tiling the payload exactly (no gap, overlap or
  trailing bytes), exactly the four tensors above, finite floats, token ids in the speech vocabulary;
- `preview.m4a` must at least be an MPEG-4 file; AVAudioPlayer decodes it, nothing else.

Nothing in the file is executed. Names are cleaned (no control or bidi characters, ≤ 40 characters).

## How the app uses it

- Kept in `Application Support/TachiNovel/voices/chatterbox-nano/<id>/` (`voice.safetensors`, `preview.m4a`,
  `info.json`); the id is `v` + 16 hex digits of the voice's SHA-256 (the same voice imported twice is one
  copy). `selection.json` holds the narrator voice. Ids from the UI are checked before any path is built.
- FluidAudio 0.17.5's `ChatterboxNanoManager` can't be given a voice: it reads
  `<models>/chatterbox-nano/tables/voice-default.safetensors` while loading. The app puts the chosen voice's
  file in that slot just for the load (one load at a time) and restores the pinned built-in file right after
  (a backup sits next to it); after a crash mid-load the slot is repaired at the next launch. The downloaded
  model therefore always matches its pinned SHA-256 outside a load.
- At load time the voice is checked again (SHA-256 against the import, the tensor checks). Missing or
  invalid → Chatterbox Nano loads its built-in voice and the screen says why (section note, Now playing).
- Kokoro voice packs could come in the same way later: `VoicePackEngine.all` is the list of importable
  engines with their tensor layout; the ZIP/manifest checks, the store and the UI are engine-agnostic.
- Personal flavor only: the store flavor compiles the UI out and native ignores opened `.tnvoice` files.

## Verification on the PC

`export_voice.py` checks its own output the way the phone reads it: the same parser rules as the app, then it
loads the exported tensors (not the reference clip) into Chatterbox Nano the way FluidAudio does — the stored
fp16 conditioning used directly as the T3 prefix and as the S3Gen reference — and renders a 10-second check
clip. `<name>.check.json` has the speaker similarity (Resemble's voice encoder, cosine) of the check clip to
the reference, next to the built-in voice's similarity to the same reference; the export fails if the clip
isn't clearly closer to the reference than the built-in voice is. `--selftest-default` re-creates the pinned
built-in `voice-default.safetensors` from the checkpoint's `conds.pt` and compares it with the published file.

## Phone checklist (5 minutes)

1. Install the PR's IPA. Export a voice on the PC (above) and let iCloud sync.
2. Settings › Voices › Expressive voices › Import voice… › TachiNovel-Voices › the file. It appears in the list.
3. ▶ Play on it: the preview plays at once.
4. Download Chatterbox Nano if needed. Tap Use on the voice, then ▶ Play sample (Emotional dialogue) with
   Chatterbox Nano: it should sound like the preview, not like the built-in voice.
5. Quit the app (swipe up), reopen: the same voice is still the narrator voice; Kokoro's default voice is
   unchanged.
6. In Files, long-press the `.tnvoice` › Share › TachiNovel: the app opens on the screen with “… imported”.
7. Rename it, then delete it (two taps): the built-in voice is the narrator voice again.
