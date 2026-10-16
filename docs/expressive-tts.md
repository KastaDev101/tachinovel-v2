# Expressive voices on the iPhone

**Status 2026-10-16:** Pocket TTS (Kyutai, CC-BY-4.0) is the one expressive engine: Nephis reads with it (her trained
model from a `.tnmodel` pack, or Kyutai's released model downloaded once), with her flow engine and studio below, and
Kokoro as her backup voice (docs/voices.md). **Chatterbox Nano and NeuTTS-2E were removed** (Kasta's decision 4,
2026-10-16), with Nano's `.tnvoice` narrator voices (shipped and imported), the Kokoro Voice Lab and the PC narrator.
Settings › Storage lists a removed engine's downloaded model and imported `.tnvoice` voices under Leftovers, so Clean
Up frees them. The research and the 2026-10-06 phone plan below are kept as the record of how Pocket TTS was chosen.

The question (Kasta, 2026-10-06): can voices that *act* — emotion, laughs and sighs, distinct character voices,
audiobook-narrator delivery instead of an even read — run on an iPhone 16 (A18, 8 GB, iOS 26.6.1,
sideloaded with a free Apple ID)? Don't assume they can't; measure.

## Bottom line (2026-10-06, before Pocket TTS was chosen)

1. Two expressive models had Core ML ports in FluidAudio 0.17.5 that ran several times faster than real time on Apple
   Silicon Macs: **Chatterbox Nano** (MIT; tags like `[angry]`, `[whispering]`, `[laugh]`) and **NeuTTS-2E** (seven
   emotions × four speakers; free commercial use below $5M annual revenue). Both went into the test build.
2. Both ran on the GPU, which iOS refuses to a background app: no lock screen, no CarPlay. **Pocket TTS** (Neural
   Engine + CPU) keeps reading with the screen locked; Kasta preferred its voice in the A/B (2026-10-07), so it became
   the narrator engine and the other two stayed experiments until their removal.
3. The bigger expressive models don't fit the phone (Orpheus/Maya1, Qwen3-TTS, CSM-1B, Dia: below real time even on
   Macs).
4. Acting needs direction: the director (src/core/narration/delivery.ts, rules + Apple Intelligence) picks the mood
   of every sentence, and her mood reads and dialogue pack carry it.

## Research: candidates (verified 2026-10-06 against model cards, LICENSE files and READMEs)

Ranked for "expressive narration on an iPhone 16". "×" = seconds of audio per second of synthesis (> 1
keeps up with playback). Speeds are as published, on the hardware named; none is from an A18.

| # | Model | Weights license (commercial?) | Size (params / download) | iOS runtime | Published speed on Apple hardware | Expressiveness | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | **Chatterbox Nano** (Resemble AI, 2026-04; removed 2026-10-16) | MIT ✅ | 110M T3 (GPT-2 small) + S3Gen meanflow + HiFT; Core ML fp16 **746 MB** | FluidAudio `ChatterboxNanoManager` (Core ML, CPU+GPU, iOS 18); also ANE builds: iliasaz/chatterbox-nano-coreml (751 MB, Swift package, cloning), seanll95/chatterbox-nano-coreml | 5.4–6.0× M5 Pro (FluidAudio); 6.4× M5 (iliasaz); seanll95: "faster than real time on an iPhone" | 19 tags: sounds `[laugh] [chuckle] [sigh] [gasp] [cough] [sniff] [groan] [shush] [clear throat]`, styles `[angry] [fear] [surprised] [whispering] [dramatic] [narration] [happy] [sarcastic] [crying]`; one built-in voice in FluidAudio | Was in the test build (removed) |
| 2 | **NeuTTS-2E** (Neuphonic, 2026-07; removed 2026-10-16) | NeuTTS Open License v1.0 ⚠️ free commercial use below **$5M annual revenue**, paid license above; upstream repo gated | Qwen3 236M (125M active) + NeuCodec; Core ML fp16 **1.37 GB** | FluidAudio `NeuTtsManager` (LM on GPU, codec on Neural Engine, iOS 18) | M5 Pro: 7–9 ms/token (needs 20 ms/token), batch ≈2×, streaming 1.6× with ~550 ms to first audio | 7 emotions (angry, disgusted, fearful, happy, neutral, sad, surprised) × 4 speakers (narrator and characters can differ) | Was in the test build (removed) |
| 3 | Chatterbox Turbo (2025-12) | MIT ✅ | 350M; Core ML 1.03 GB (iliasaz), MLX 4-bit 415 MB | iliasaz Swift package (ANE); mlx-audio (Python) | iPhone 17 Pro Max decode 29–35 ms/token on the ANE ≈ 0.75–0.9× (needs 40 ms/token), one-time 30 s ANE compile | Same tags as Nano, better quality ("excels at narration") | Next if Nano sounds too thin; pre-render only on an A18 |
| 4 | Pocket TTS (Kyutai, 2026-01) | CC-BY-4.0 ✅ (attribution; gated with an acceptable-use prompt). Voices `cosette`, `jean` are NC: don't use | 100M; Core ML `.ane` set 368 MB | FluidAudio `PocketTtsManager` (Neural Engine placement, streaming); mlx-audio-swift; sherpa-onnx | 6.5× M5 Pro, first frame 26 ms; **iPhone 17 Pro Max 2.5×** (FluidAudio) / 7.8× (Core AI, iOS 27) | Voice cloning from a clip (narrator and character voices from prompts); no emotion control; issue #115 "prosody worse than Kokoro" with default voices | **Nephis's engine** (2026-10-07: chosen; her own trained model in packs) |
| 5 | Supertonic 3 (Supertone, 2026-04) | OpenRAIL-M ⚠️ commercial OK with use-based restrictions; upstream archived | 99M; Core ML int4 0.10 GB | FluidAudio, speech-swift | **iPhone 16 Pro RTF 0.15 (6.7×)**, 956 MB peak (speech-swift) | 10 preset voices, a few tags (`<laugh>`, `<breath>`, `<sigh>`), 44.1 kHz | Fast "expressive-lite"; not acting |
| 6 | Qwen3-TTS 0.6B / 1.7B (2026-01) | Apache-2.0 ✅ | 0.9B / 1.9B + 682 MB codec; MLX 4-bit 1.0–1.6 GB | mlx-audio-swift, speech-swift (MLX, macOS-only per their FAQ) | M4 Pro (MLX Swift): 0.6B 8-bit 8.4 tok/s vs 12.5 needed → **below real time on a Mac** | Natural-language emotion/style instructions (1.7B), voice design, cloning | PC narrator / design character voices |
| 7 | Fun-CosyVoice3 0.5B | Apache-2.0 ✅ | ~1.2–1.7 GB MLX | speech-swift (MLX) | none published | Instruction emotions (fixed list), `[breath]`, dialogue tags | Later, if ever |
| 8 | Marvis TTS 250M v0.2 | Apache-2.0 ✅ | MLX 4/8-bit 414–666 MB | mlx-audio-swift (MLX = GPU, foreground only) | "real-time on iPhone" claimed, no numbers | Context prosody, cloning, no tags | Not expressive enough to justify |
| 9 | Orpheus 3B / Maya1 3B | Llama 3.2 Community ✅ (< 700M MAU) / Apache-2.0 per card (Llama-3B shapes, provenance unclear) | 3–3.8B; GGUF Q4 2.1–2.4 GB | llama.cpp has no SNAC path; mlx-audio | Need ~83 tokens/s; A18 est. 20–25 tok/s ≈ **0.3×** | The best tags (`<laugh> <sigh> <gasp>…`; Maya1: voice descriptions + 17 tags) | PC only |
| 10 | Sesame CSM-1B | Apache-2.0 ✅ (Llama tokenizer) | 1.5B; MLX 5-bit 1.1 GB | speech-swift | 0.5–0.9× real time on M-series | Conversational context, multi-speaker | Too slow |
| 11 | VibeVoice-Realtime-0.5B | MIT ✅ (cards: "research only" recommendation) | 1.0B, MLX 4-bit 633 MB | speech-swift | 2.3× M2 Max (RTF 0.43) | Single speaker, long-form | Not expressive enough |
| 12 | Dia 1.6B / Dia2 1–2B | Apache-2.0 ✅ | 1.1–1.6B | none in Swift | GPU/CUDA only | `[S1]/[S2]` dialogue, nonverbals | No runtime |
| 13 | Kitten TTS 0.8 / Soprano 1.1 | Apache-2.0 ✅ | 15–80M / 80M | sherpa-onnx / mlx-audio-swift | fast | None (fixed voices) | Not expressive |
| — | Kokoro-82M (shipping) | Apache-2.0 ✅ | 82M, 93 MB bundled | FluidAudio (ANE + CPU) | iPhone 16 Pro RTF 0.08 (12×) | Fixed style vectors, no emotion | The baseline |

**Rejected on the license** (non-commercial): Spark-TTS (CC-BY-NC-SA), F5-TTS (CC-BY-NC), Fish Speech /
OpenAudio S1-mini (CC-BY-NC-SA + research license), XTTS-v2 (Coqui CPML), MaskGCT (CC-BY-NC), Higgs TTS 3,
OmniVoice, OuteTTS 0.2 / 0.3-1B / Llama-1.0 (NC). **Capped or restricted commercial licenses** (allowed
in principle, excluded for size or quality): Kitten TTS 2 (1.7B; commercial grant ends at $1M revenue),
Kani-TTS (LFM 1.0, $10M), Dramabox (3.3B + 12B encoder, LTX-2 license, $10M), IndexTTS2 (bilibili
license: revenue/MAU caps, no training other models), Higgs Audio v2 (5.8B, 100k annual users).

Notes that matter for a commercial build later:
- Resemble's Python package watermarks every output (Perth); the MIT license doesn't require it and the
  Core ML ports don't do it. Decide deliberately (it is inaudible and marks AI audio).
- espeak-ng (GPL-3.0) is used by Kitten, NeuTTS Air, Zonos and StyleTTS2 front-ends; Pocket TTS doesn't use it.

## What the test build does

More › Developer › Voice Models (Developer options: More › About › tap the version 7 times); More › Voices › Download Her
Voice downloads the same model:

| Piece | Where |
|---|---|
| Pinned model files (repo, commit, path, size, SHA-256) | `ios/expressive-models.lock.json` ⇄ `ios/App/ExpressiveVoice/Sources/ExpressiveCore/PinnedModels.generated.swift` (`node tools/expressive-models.ts --update-lock / --check`) |
| Downloader: Wi-Fi only, free-space check, resumable, SHA-256 per file, excluded from backups, delete | `ExpressiveCore/ModelStore.swift` (the app and the CI benchmark use the same code) |
| The engine behind one protocol (`ExpressiveSynthesizer`): Pocket TTS (`PocketTtsSynth`), and her flow engine (`NephisFlowSynth`) | `ios/App/ExpressiveVoice/Sources/ExpressiveEngines/` (FluidAudio 0.17.5, the same pin as HDVoice) |
| Pocket's text: sound tags stripped, numbers and codes spoken, ellipses kept from ending a call (the app's form) or as written (a pack's raw form); 400 characters per call | `ExpressiveCore/ExpressiveCatalog.swift` |
| Engine behind the narration protocol (`SpeechEngine`): renders 3 sentences ahead, plays gaplessly, **Kokoro reads a sentence whenever the expressive engine can't deliver it** (still loading, queue ran dry, app in background, thermal serious, sentence failed, model released) and the expressive engine takes over again once 2 sentences ahead (HDVoiceCore's `HybridScheduler`, roles shifted) | `ios/App/App/Native/Voice/Expressive/ExpressiveSpeechEngine.swift` |
| Model lifecycle: one engine loaded at a time, unloaded on memory warnings and after 3 minutes idle (a release cancels the load and calls still running, a load released while it waits never starts, and the next load waits until the models are gone and any load still running has ended; after a memory warning no expressive model loads for 60 s, doubling until she has read 5 minutes without one, and Nephis refuses to load with less than ~700 MB free; her studio's models load in the background behind Pocket's with ~1,000 MB free (her calls play her plain sound until they are up, never waiting for them) and are dropped under ~500 MB free; the studio speed test runs alone, refusing under ~1,000 MB free, Kokoro loads asked for meanwhile wait for it and Nephis is warmed again after it; Kokoro's once-per-build warm-up runs after hers: crash plan 2026-10-12, `ExpressiveCore/NephisGuards.swift`); its own crash sentinel, judged with the run journal (`VoiceRun.swift`, `HDVoiceCore/RunJournal.swift`): only real crashes of her model count, two in a row → Nephis off until "Turn Nephis back on" (Settings › Voices, the Voice test) or a new build | `Native/Voice/Expressive/ExpressiveService.swift` |
| Plugin `ExpressiveVoice` and the Voice Models screen; samples (calm narration, emotional dialogue, a ~3-minute passage) and the cue-word tagger for pasted text | `ExpressiveVoicePlugin.swift`, `src/ui/native/expressive-lab.ts`, `src/ui/native/expressive-samples.ts` |
| Her model packs (`.tnmodel`, personal flavor): "Open in TachiNovel" or dropped into Documents, unpacked into the pack library, the result shown in Voice Models (the plugin's `voiceImport` event) | `Native/Voice/Expressive/NephisModelPack.swift`, `ExpressiveCore/NephisPackLibrary.swift` |
| Voice files that ship in the app: the Pocket TTS voices and speaker projection (`BuiltInVoices/pocket/`), breaths (`BuiltInVoices/breaths/`) | `tools/built-in-voices.ts` checks them |

The screen shows her model: size and license, download progress, load time (cold/warm); for the last
playback: time to first audio (and whether it included the model load), which voice read each line,
synthesis time and × real time per line, Kokoro fallback lines and why, queue-ran-dry count, throttling;
for the speed test: load, first audio, × real time (all / median / slowest 10%), memory before / loaded /
max, thermal state before and after. "Copy report" puts everything on the clipboard.

**Voice Speed Test** (More › About › Diagnostics › Voice Speed Test; More › Developer; the app icon's long-press menu,
the Voice Test page and the Listen player's Voice panel while Developer options are on; `Native/Voice/VoiceSpeedTest.swift`, `ExpressiveCore/NephisSpeedTest.swift`,
`src/ui/native/voice-speed.ts`): renders a fixed ~45 s passage with the Nephis pack in use exactly as Listen renders it
(her chain, studio, the pack's `studioEQ`, pauses; calls cut and budgeted as Listen does) without playing it, simulates
playback (keeps up: every call ready before the one before ends), and reports time to first audio, × real time, the
time per stage (Pocket generation, Mimi decode, studio blueprint, studio vocoder, EQ/post), the slowest call, every
call, device, iOS, heat, Low Power Mode, free memory, the pack (name, `weightsSha256`) and whether her studio ran on
every call. The report (`speedtest-<date>-<time>.json`) and the audio (`.wav`, 32-bit float at the read's rate) go to
the Diagnostics folder; "Play result" plays the audio, "Copy report" copies the JSON.

**Her studio in Listen** (`ExpressiveCore/NephisGuards.swift` StudioBudget and NephisStudioSwitch, 2026-10-15/16): the
"Her studio" switch is per pack and on by default (an off is kept for that pack until it is installed again). The first
call of a read always gets the studio (its first audio ~0.2-0.5 s later on a fast phone). Any other call gets it when
its estimated work (its text at 12 characters a second, over the studio's × real time) is at most half the audio
buffered ahead of playback, that never counted under 1 s. The speed: measured once when a pack's studio loads while
nothing is saved for the pack (`NephisStudio.measureSpeed`: one vocoder piece of silence, 1.36 s, rendered twice, about
0.1 s of work; not in serious heat or Low Power Mode), then on every call it renders (a slower call sets it at once, a
faster one moves it 30 % of the way); kept over the app's life and saved per pack, and the next launch starts from the
saved speed (half of it when the phone is warm). With nothing known: 25x for the fast phone vocoder (studio.json
`vocoder_model` NephisVocoderFast), else 8x. Under 4x, in serious heat or Low Power Mode the old rule alone, the first
call included: the studio only with 6 s buffered. The Voice test report's `flow.studio.plannedX`/`plannedFrom` and the
speed test's `studio.estimate` (`startX`, `startFrom`: "measured at load", "saved", "default", "measured on calls") are
the speed it plans with and where it came from.

**Voice extras** (More › Developer, `DeliverySettings.extras`, on by default, 2026-10-16): her lead-ins, extra takes and
the speech checks that serve them. Off: every flow call (Listen, the speed test, audio downloads, the hand-off) renders
one plain take without a lead-in (`NephisCallPlan.extras`, applied once in `ExpressiveService.synthesizeFlow`), so no
speech recognition runs and the analysis decode only reads each take's ends. The speed test and listening reports say
`"extras": "on" | "off"` at the top level.

**Pack tone chain (pack.json `chain`)**, after her voice is made, in this order: first `dewind` `{"passes": 2}` (1-2;
the de-wind cleaner, below), then `breathPolish` and `eqAfterStudio`
(studio calls), `studioEQ` (studio calls: `gainDB` and up to 8 RBJ sections, `highShelf`, `lowShelf`, `peaking`, and
the browser EQ tuner's `highPass` low cut / `lowPass` top cut, 12 dB/octave with the section's Q, `db` ignored), then on
every call of hers (studio or plain) the tuner's finishing: `closeness` `{"amount"}` (0-1; a port of Chromium's
DynamicsCompressorNode with the tuner's threshold -32c - 18·min(1, 4c) dB, +6.02 dB for the phone's level, ratio 1 + 3c,
12 dB knee, 8 ms attack, 180 ms release, Chromium's makeup gain and the tuner's; 6 ms look-ahead), `floorGuard`
`{"amount"}` (a downward expander, below), `breathAir`
`{"amount"}` (0-1; a parallel exciter x + 0.24a · HPF7k(shaper(5 · HPF5k(x))), shaper tanh(4v)/tanh(4) 4x oversampled
with Chromium's WaveShaper resamplers; both high-passes RBJ with Q 1.1220, the tuner's WebAudio default Q of 1 dB; optional `"drive"` 0.1-1, default 1:
preGain 5 · drive, mix 0.24 · amount / drive, the tuner's "peak-safe" is 0.3),
`room` `{"amount", "seconds" 0.35, "decay" 0.07, "seed" 1}` (amount 0-0.35; a
seeded noise impulse, normalized like WebAudio's ConvolverNode, wet amount · 2.2, level 1/(1 + 0.6 · amount), FFT
convolution on vDSP), then `master`. Each runs at the call's rate as one chain over the read (filters, look-ahead and the
room's tail carry from call to call; a new read starts fresh). Absent, unreadable or 0: off, the audio bit-identical to
before. Files: `ExpressiveCore/NephisStudioEQ.swift`, `NephisCloseness.swift`, `NephisBreathAir.swift`,
`NephisRoom.swift`; the Voice speed test lists them in its chain and their time in "EQ and finishing" (`finishMs`).

**De-wind cleaner (chain `dewind`)**: a DeepFilterNet3 (MIT/Apache-2.0) fine-tuned in tachinovel-tts-lab to remove the
faint wind her source audio taught her voice; Kasta's locked sound runs it twice. The model ships in the pack:
`Models/nephis-dewind/DewindNet.mlpackage` (or `.mlmodelc`), `dewind.json` (`model`, `frames_per_call` 8, `sample_rate`
48000, `sha256` over the package's files, optional `compute_units`: `cpu` by default, the lab measured fp16 and the
Neural Engine to change the sound) and optional `dewind_check.json` (the lab's model_io.json: checked at every load,
off when the phone's numbers are more than 0.05 from the PC's). It runs on every call of hers as the first step after
her voice is made: her studio's 44.1 kHz sound, her Mimi sound at 24 kHz in a read without her studio, and in a studio
read the calls her studio skipped as they join the 44.1 kHz stream (after their 24 kHz Mimi EQ, which stays where it was
tuned). Each call is resampled to 48 kHz (resample_poly's Kaiser filter, streamed), cleaned `passes` times (libdf's
960/480 STFT, ERB and deep-filter features, Core ML in blocks of 8 frames with its state per pass) and resampled back.
One chain runs over a read; a call comes back complete and as long as it went in: the chain's ~70-200 ms of held-back
audio at a call's end comes from a copy of the chain that assumes silence follows (the PC's end-of-stream flush), the
next call drops what was already played and crossfades 5 ms into the true output. A new read, a seek or a new chapter
starts afresh; a read's last call is simply complete. Absent, unreadable or 0: off, bit-identical. A pack whose chain
asks for it without the model, or a failed load or call, plays without it and says why (native.log, the call log, the
Voice speed test: its passes, model and units in the chain, "De-wind cleaner" as its own stage, `dewindMs` per call).
Files: `ExpressiveCore/NephisDewind.swift`, `NephisDewindModel.swift`; port notes in tachinovel-tts-lab
`coreml-swap/dewind/PORTING.md`.

**Floor guard (chain `floorGuard`, 2026-10-15)**: the browser EQ tuner's downward expander, right after `closeness` (so
the order is closeness → floor guard → breath air → room → master), on every call of hers, any pack. `{"amount": g}`
(0-1; under 0.005 off, absent or unreadable off: bit-identical). The tuner's definition, at its page level: envelope
e = 30 · LPF20(|x|) (a 2nd-order low-pass at 20 Hz, WebAudio Q -3 dB = linear 10^(-3/20)); gain c(e) = 1 when
g < 0.005 or e ≥ 0.075, else max(10^(-12g/20), (e / 0.075)^(2g)); output x · c(e). The phone's signal is 6.02 dB hotter
than the page's, so the app's envelope is 15 · LPF20(|x|) (the same gain for the same sound). No look-ahead; one guard
runs over the read like the rest of the finishing. File: `ExpressiveCore/NephisFloorGuard.swift`.

## Dialogue packs (2026-10-15)

One model can't do Nephis's calm narration and her expressive dialogue well, so a second model of the same base is
fine-tuned on Her's expressive dialogue takes. With a **dialogue pack** installed, Listen (and Prepare for the drive, and
the Voice speed test) reads narration with the narrator pack and quoted dialogue with the dialogue pack, in one
continuous read, so both sound like the same woman. **Without a dialogue pack nothing changes: every call reads with
the narrator pack exactly as before (bit-identical).** Files: `ExpressiveCore/NephisDialogue.swift` (routing, clips, the
mix, the level match), `NephisTempo.swift`, `NephisFloorGuard.swift`, `ExpressiveEngines/NephisFlowSynth.swift`
(`prepareRouted`, the mixed decode), `NephisPackLibrary.swift` (roles).

### The pack

A dialogue pack is a `.tnmodel` exactly like a narrator pack (the same required files: the full
`Models/pocket-tts/v2.1/english/…` model set, `BuiltInVoices/pocket/nephis.pocketvoice` + `.json` and
`speaker-projection.bin` + `.json`), plus:

- `pack.json` `"role": "dialogue"`. Developer › Voice Packs overrides it per pack (Edit › "For Dialogue" / "For
  Narration"; kept in `NephisPacks/roles.json`). Installing a dialogue pack makes it her dialogue voice
  (`NephisPacks/dialogue.json`) and leaves the narrator pack as it was; "Narrator Reads Dialogue Too" turns it off.
- Style clips: `BuiltInVoices/pocket/nephis-dlg-<name>.pocketvoice` + `nephis-dlg-<name>.json` (FluidAudio's voice
  prompt format, as every Nephis clip: float32 `[frames, 1024]`, at most 125 frames, the manifest's `schemaVersion` 1,
  `engine` "pocket-tts", `frames`, `embeddingDim`, `bytes`, `sha256`; each checked at load, a bad one is skipped). Up to
  ~20 (at most 40 are read). Mood clips named like a narrator pack's (`nephis-<mood>`) work too.
- `"decoder": "shipped"`: the stream is decoded by the narrator pack's Mimi decoder (Mimi, her studio and the de-wind
  cleaner are voice-independent and shared; a dialogue pack's own studio, de-wind model and `breathPolish` are never
  used).

Which clip a dialogue span reads with (`DialogueClips.pick`): a span with written laughter (Ha!, Haha, Heh, Hehe, Pfft,
Ahaha, Bwahaha, Tee-hee) uses the laugh clip (`moods.laugh.clip`, else a file named `nephis-dlg-laugh`) when the pack
has one; otherwise the director's mood (the 12: calm, awe, wry, cold, triumph, intense, tense, dread, tender, hushed, sad,
playful; "calm" when the call has none) picks `moods[<mood>].clip`, else `nephis-dlg-<mood>`, else `nephis-<mood>`, else
the pack's `nephis.pocketvoice`.

### The chain (pack.json `chain` of the dialogue pack)

Every narrator field works in a dialogue pack and applies to its dialogue spans only: `moods` (pauses, `gainDB`,
`toneDB`, `dialogue`), `pieceGap`, `ellipsisGap`, `clauseGap`, `paragraphGapScale`, `dialogueGaps`, `clipFrames`,
`carryFrames`, `respell`, `text`, `highShelfDB` / `softSibilance` (its Mimi EQ in a read without her studio),
`eqAfterStudio`, `studioEQ`, `closeness`, `floorGuard`, `breathAir` (with `drive`: 0.3 is the tuner's "peak-safe"),
`room`, `master`. New (all optional; absent = today's behaviour):

| Field | What it does |
|---|---|
| `moods[<mood>].clip` | The style clip for that mood (a file name without extension, e.g. `"nephis-dlg-smug"`). |
| `moods[<mood>].clause` | The pause between the pieces of a sentence in that mood (seconds, 0.05-1.5): a piece that ends mid-sentence, a "Come here," before its tag, and each dialogue comma beat. Absent: `clauseGap` (0.25). Narrator packs may use it too. |
| `moods[<mood>].tempo` | The tempo of that mood's dialogue spans, 0.85-1.15 (> 1 faster), time-stretched without a pitch change (WSOLA on vDSP, 40 ms frames, normalized correlation over ±8 ms). Absent or 1: untouched. |
| `moods[<mood>].eqGroup` | The `eqGroups` entry its dialogue spans use instead of the pack's `studioEQ`. |
| `moods.laugh.clip` | The laugh clip (only `clip` is read from `laugh`). |
| `dialogueCommaBeat` | `true`: each dialogue span is cut after its commas, semicolons and dashes ("1,000" and "well-known" stay whole) and the mood's `clause` pause goes between the pieces (Kasta: the dialogue voice ran through commas). |
| `eqGroups` | `{"hushed": {studioEQ}, "average": {studioEQ}, "loud": {studioEQ}}`: named studio EQs (the `studioEQ` format). |
| `thoughts` | `true`: thoughts in single quotes ('Curse it...' in a chapter that quotes speech with double quotes) are read by the dialogue pack too. Off: narration. Italic thoughts without quote marks are always narration. |
| `loudnessMatch` | `false` turns the level match off (on by default). |

A mood entry may list only some fields; the rest keep the mood's defaults (her narrator values, calm's for a mood she
has none for). Example (values from Her's measured pauses, below):

```json
{
  "name": "Nephis dialogue (expressive)", "made": "2026-10-16 01:00", "role": "dialogue", "decoder": "shipped",
  "weightsSha256": "…",
  "chain": {
    "text": "raw", "clipFrames": 100, "carryFrames": 12,
    "dialogueCommaBeat": true,
    "moods": {
      "calm":    {"clip": "nephis-dlg-calm",    "sentence": 0.50, "paragraph": 0.80, "clause": 0.30},
      "playful": {"clip": "nephis-dlg-playful", "sentence": 0.56, "clause": 0.21, "tempo": 0.90, "eqGroup": "average"},
      "intense": {"clip": "nephis-dlg-command", "sentence": 0.48, "clause": 0.27, "tempo": 0.94, "eqGroup": "loud"},
      "tense":   {"clip": "nephis-dlg-tense",   "sentence": 0.56, "clause": 0.21, "tempo": 1.10},
      "hushed":  {"clip": "nephis-dlg-secret",  "sentence": 0.60, "clause": 0.33, "eqGroup": "hushed"},
      "laugh":   {"clip": "nephis-dlg-laugh"}
    },
    "eqGroups": {
      "hushed":  {"gainDB": -1.0, "sections": [{"type": "highShelf", "hz": 8000, "q": 0.71, "db": 4}]},
      "average": {"gainDB": -2.5, "sections": [{"type": "highShelf", "hz": 8000, "q": 0.71, "db": 6}]},
      "loud":    {"gainDB": -4.0, "sections": [{"type": "peaking", "hz": 3000, "q": 1.0, "db": -2}]}
    },
    "studioEQ": {"gainDB": -2.5, "sections": [{"type": "highShelf", "hz": 8000, "q": 0.71, "db": 6}]},
    "closeness": {"amount": 0.2}, "floorGuard": {"amount": 0.3}, "breathAir": {"amount": 0.2, "drive": 0.3},
    "room": {"amount": 0.07}
  }
}
```

**Her measured pauses per mood** (`D:\TachiNovel-packs\her_dialogue\pace.json`, her dialogue takes, word-aligned), mapped
to the director's moods, as starting values for `sentence` / `clause` / `tempo` (tempo = her speaking rate over ours
before the dialogue model, clamped; measure again on the dialogue model's own renders):

| Mood | Her takes | sentence | clause | tempo |
|---|---|---|---|---|
| calm | calm | 0.50 | 0.30 | 1.0 |
| awe | awe | 0.66 | 0.49 | 1.0 |
| wry | smug (banter 0.58 / 0.26) | 0.56 | 0.20 | 1.0 (banter 0.91) |
| cold | cold | 0.65 | 0.32 | 0.95 |
| triumph | victory | 0.40 | 0.39 | 1.06 |
| intense | command (excited 0.42 / 0.17) | 0.48 | 0.27 | 0.94 (excited 0.89) |
| tense | tense | 0.56 | 0.21 | 1.15 (1.26 measured) |
| dread | scared | 0.58 | 0.25 | 1.0 |
| tender | tender | 0.58 | 0.36 | 0.97 |
| hushed | secret | 0.60 | 0.33 | 1.0 |
| sad | sad | 0.81 | 0.48 | 1.06 |
| playful | playful | 0.56 | 0.21 | 0.86 |
| (laugh clip) | laugh, laugh2 | 0.61-0.66 | 0.17-0.24 | 0.87 |

### How a call is read (`QuoteRouter`, `NephisFlowSynth.prepareRouted`)

- **Spans.** The call's text is cut by its quotation marks into narration (read by the narrator pack, as written) and
  dialogue (read by the dialogue pack, without its marks): straight and curly double quotes (and « », 「 」); curly
  single quotes only in a chapter that quotes speech with them (Listen works it out per chapter: any double quote → single
  quotes are thoughts), never an apostrophe ("don't", "the boys' room"). `"Come here," she whispered, "now."` is
  dialogue / narration / dialogue; punctuation right after a closing quote goes with the words before it.
- **Across calls and paragraphs.** A quotation left open at a call's end is speech when it closes later in the same
  paragraph or the next paragraph reopens it (the novel convention for a speech over several paragraphs; Listen sends
  both hints with each call); otherwise the mark is a stray and that stretch is narration, as before.
- **Short interjections.** A lone dialogue span of at most 2 words / 14 letters inside at least 3 words of narration
  (`He looked up. "Oh." Then he left.`, scare quotes) stays with the narrator: a voice change for one word costs more
  than it gives. Written laughter keeps the dialogue voice when the pack has a laugh clip.
- **Pieces and pauses.** Each span is planned in Pocket's chunks for its own voice (and with `dialogueCommaBeat` cut at
  its commas and dashes); every piece is read with its voice's prompt (its clip + its own carry-over of what that voice
  said last) and joined into the one latent stream as always. The pause after a piece is its voice's: inside a span its
  pause after a sentence, or the mood's `clause` at a comma beat; where the voice changes, a comma's beat when the
  sentence goes on ("Come here," | she whispered), else her hand-over pause (`dialogueGaps` "narration", capped by her
  sentence pause; a mood's own `dialogue` value wins). A call's opening pause is the previous voice's. A lead-in only
  follows the same voice.
- **Each voice keeps its own state:** carry-over latents, last clip (the half-and-half blend at a mood change), finishing
  chain. Shared: the read's stream, Mimi decoder, her studio, the de-wind cleaner, the take analysis decoder.

### The sound of a mixed call (`decodeReporting`)

Mimi decodes the one stream; her studio and the de-wind cleaner run over the whole call as always. Where the voice
changes is known in latents (the middle of the join's pause, or the middle of the true silence spliced in there). Then:

1. Tone before the pauses go in: the narrator's (its `eqAfterStudio` and `studioEQ`, or in a call the studio skipped its
   mood shelf and Mimi EQ at 24 kHz) over the call, the dialogue pack's (its own, with the mood's `eqGroup`) over its
   regions, mixed.
2. The pauses go in; the dialogue regions get the mood's `tempo`.
3. **Level match**: each voice's active level in the call (10 ms frames over -45 dBFS, their mean power), smoothed over
   the read (a call with 3 s of speech moves it 30 % of the way; each voice needs 0.5 s before it counts); the dialogue
   regions get the difference (±6 dB at most) on top of their mood's `gainDB`.
4. Each voice's own steps: the narrator's chain over the whole call (it carries on as always), the dialogue pack's from
   the call's start to its last region (it carries on when it ran to the end of the call before, else starts fresh in
   the call's opening pause): mood shelf (no studio), level, Mimi EQ (no studio: both, so the player adds none),
   closeness, floor guard, breath air, room, master.
5. The two are mixed with an **equal-power crossfade of 5 ms** at each change; changes fall in pauses, so it only
   smooths the tails (no change ever lands inside a word).

### Memory and speed (estimates until the phone's report)

- Both flow models stay loaded (no switching cost): a second Pocket model is ~300 MB of weights (cond_prefill 132 MB,
  flowlm_step 151 MB, flow_decoder 19 MB) plus its own Mimi (42 MB, unused but loaded by FluidAudio): **about +350-450 MB
  resident** on top of Nephis + studio + de-wind. It loads in the background behind her studio, only with ~900 MB free
  (`NephisMemory.dialogueLoad`), and is the first thing dropped under ~550 MB free (`dialogueKeep`, before her studio's
  500 MB); meanwhile the narrator reads the dialogue (the call log says why: "loading", "memory: …").
- Cost per voice change: one more prompt prefill (tens of ms on the Neural Engine), one more join, and short pieces are
  decoded whole for analysis (Mimi's analysis decode rises from ~1.5× to ~2× the stream on dialogue calls). Listen's
  extras budget counts each change as 0.5 s less audio ahead (`HybridSpeechEngine.switchCost`), and the "under 1.5×
  real time → lightest calls" rule covers a slow mixed call. The dialogue finishing chain runs only on calls with
  dialogue, up to its last region (~10-30 ms per second of audio).
- The Voice speed test appends a short exchange to its passage when a dialogue pack is in use (the narrator-only passage
  is unchanged) and reports `dialogue`: the pack, its model load time and free memory before/after, calls, spans, voice
  changes per minute, and per voice the pieces, Pocket time, audio seconds and × real time. The listening report has the
  same per session; each call in the call log has a `dialogue` entry.

Never crashing was the design rule: unsupported OS (< iOS 18), missing or corrupt files (checksums),
a failed load, a failed sentence, memory warnings and backgrounding all end in Kokoro reading, never in
silence or a crash; a Core ML crash inside these engines is contained by the sentinel on the next launch.

## macOS benchmark (CI)

Workflow `expressive-bench` (`.github/workflows/expressive-bench.yml`), manual or the
`expressive-bench` label on a pull request (macOS minutes are scarce, so it never runs by itself):
ExpressiveCore unit tests, then per engine in its own process: download (pinned, checksummed), cold load,
render all 40 sample lines with fixed seeds, warm reload; whisper.cpp ASR word error rate per sample; the
Kokoro check on the same runner. Artifact `expressive-bench`: `summary.md`, `report.json` per engine and
**one WAV per line per engine: listen to the dialogue lines**.

RESULTS_PLACEHOLDER

## Phone check (Pocket TTS)

1. More › About › tap the version 7 times (Developer options), then More › Developer › **Voice Models**.
2. **Pocket TTS** › Download 368 MB (Wi-Fi; not needed with a Nephis pack installed). Sample **Emotional dialogue** ›
   ▶ Play Sample, then **Same Sample With Kokoro** for the A/B with her backup voice.
3. Sample **Long passage** › **Speed Test**: × real time (all / slowest 10%), memory max, thermal before → after.
4. **Copy Report** and paste it to Claude. The Voice Speed Test (More › About › Diagnostics) measures her pack the way
   Listen reads, which is the number that matters for listening.

(The 2026-10-06 expectations and checklist for Chatterbox Nano and NeuTTS-2E are in git history before 2026-10-16.)

## Sources

Model cards and licenses (all accessed 2026-10-06): https://huggingface.co/ResembleAI/chatterbox-nano ·
https://huggingface.co/FluidInference/chatterbox-nano-coreml ·
https://raw.githubusercontent.com/resemble-ai/chatterbox/master/LICENSE ·
https://huggingface.co/ResembleAI/chatterbox-turbo · https://huggingface.co/iliasaz/chatterbox-nano-coreml ·
https://huggingface.co/iliasaz/chatterbox-turbo-coreml · https://huggingface.co/seanll95/chatterbox-nano-coreml ·
https://huggingface.co/FluidInference/neutts-2e-coreml (LICENSE: NeuTTS Open License v1.0) ·
https://github.com/neuphonic/neutts · https://huggingface.co/kyutai/pocket-tts ·
https://github.com/kyutai-labs/pocket-tts/issues/115 · https://huggingface.co/rahulrachuri/pocket-tts-coreai ·
https://huggingface.co/FluidInference/pocket-tts-coreml · https://huggingface.co/Supertone/supertonic-3 ·
https://github.com/soniqo/speech-swift/blob/main/docs/benchmarks/ios-coreml.md ·
https://github.com/QwenLM/Qwen3-TTS · https://github.com/Blaizzy/mlx-audio-swift/issues/224 ·
https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512 · https://github.com/Marvis-Labs/marvis-tts ·
https://github.com/canopyai/Orpheus-TTS (issue #33 on the weights' Llama license) ·
https://huggingface.co/maya-research/maya1 · https://huggingface.co/sesame/csm-1b ·
https://huggingface.co/aufklarer/CSM-1B-MLX-8bit · https://github.com/microsoft/VibeVoice ·
https://github.com/nari-labs/dia · https://github.com/nari-labs/dia2 ·
https://huggingface.co/KittenML/kitten-tts-mini-0.8 · https://huggingface.co/KittenML/kitten-tts-2 ·
https://huggingface.co/ekwek/Soprano-1.1-80M · https://huggingface.co/SparkAudio/Spark-TTS-0.5B ·
https://huggingface.co/SWivid/F5-TTS · https://huggingface.co/coqui/XTTS-v2 ·
https://huggingface.co/IndexTeam/IndexTTS-2 · https://huggingface.co/bosonai/higgs-tts-2-3b-base ·
https://huggingface.co/LiquidAI/LFM2-350M/blob/main/LICENSE.

Runtimes: FluidAudio 0.17.5 (https://github.com/FluidInference/FluidAudio, Documentation/TTS/Chatterbox.md,
Benchmarks.md, PocketTTS.md; source read at the tag) · https://github.com/soniqo/speech-swift ·
https://github.com/Blaizzy/mlx-audio-swift · https://github.com/k2-fsa/sherpa-onnx.

Platform: background GPU — https://developer.apple.com/documentation/metal/preparing-your-metal-app-to-run-in-the-background ;
Core ML compute units in the background — https://developer.apple.com/documentation/coreml/mlcomputeunits ;
Neural Engine in the background on iOS 26 (developer report) — https://developer.apple.com/forums/thread/832048 ;
increased memory limit — https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.kernel.increased-memory-limit ;
llama.cpp on A-series (speed proxy) — https://github.com/ggml-org/llama.cpp/discussions/4508.
