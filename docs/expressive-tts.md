# Expressive voices on the iPhone (spike)

Status 2026-10-06: research done, two engines in the test build behind the hidden Voice Lab, macOS
benchmark in CI. **Phone numbers still needed** (checklist at the end). Narration is unchanged: chapters
are still read by Kokoro with the Apple voice as the fallback (docs/voices.md).

The question (Kasta): can voices that *act* — emotion, laughs and sighs, distinct character voices,
audiobook-narrator delivery instead of an even read — run on an iPhone 16 (A18, 8 GB, iOS 26.6.1,
sideloaded with a free Apple ID)? Don't assume they can't; measure.

## Bottom line

1. **Yes, plausibly, in the foreground.** Two expressive models now have Core ML ports that load in
   our existing dependency (FluidAudio 0.17.5) and run several times faster than real time on Apple
   Silicon Macs: **Chatterbox Nano** (MIT; acts on tags like `[angry]`, `[whispering]`, `[laugh]`,
   `[sigh]`, `[gasp]`) and **NeuTTS-2E** (seven emotions × four speakers; free commercial use below
   $5M annual revenue). Both are in the test build. Expected on the A18: Chatterbox Nano around 1–2×
   real time, NeuTTS-2E around real time (borderline). The phone checklist decides.
2. **Not on the lock screen (yet).** Both run on the GPU through Core ML, and iOS refuses GPU work from
   a background app. In the test build Kokoro (Neural Engine + CPU) reads every sentence while the app
   is in the background. Ways around it, in order: render the next chapter ahead while the app is open;
   switch to a Neural-Engine build of Chatterbox Nano (two exist, see the table); Pocket TTS (Neural
   Engine, natural but no emotion control).
3. **The bigger expressive models don't fit the phone.** Orpheus/Maya1 (3B, the best emotion tags),
   Qwen3-TTS (instructions, voice design), CSM-1B, Dia: all below real time even on Macs. They belong on
   the PC narrator, if anywhere.
4. **Acting needs direction.** These models act on what they are told. The test build sends each line
   with an emotion, a style and a speaker (hand-written for the samples, guessed from cue words for
   pasted text). Doing that for real chapters needs a better tagger (rules + the lexicon, or a small
   classifier on the PC); that is the next step if the voices pass the listening test.

## Research: candidates (verified 2026-10-06 against model cards, LICENSE files and READMEs)

Ranked for "expressive narration on an iPhone 16". "×" = seconds of audio per second of synthesis (> 1
keeps up with playback). Speeds are as published, on the hardware named; none is from an A18.

| # | Model | Weights license (commercial?) | Size (params / download) | iOS runtime | Published speed on Apple hardware | Expressiveness | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | **Chatterbox Nano** (Resemble AI, 2026-04) | MIT ✅ | 110M T3 (GPT-2 small) + S3Gen meanflow + HiFT; Core ML fp16 **746 MB** | FluidAudio `ChatterboxNanoManager` (Core ML, CPU+GPU, iOS 18); also ANE builds: iliasaz/chatterbox-nano-coreml (751 MB, Swift package, cloning), seanll95/chatterbox-nano-coreml | 5.4–6.0× M5 Pro (FluidAudio); 6.4× M5 (iliasaz); seanll95: "faster than real time on an iPhone" | 19 tags: sounds `[laugh] [chuckle] [sigh] [gasp] [cough] [sniff] [groan] [shush] [clear throat]`, styles `[angry] [fear] [surprised] [whispering] [dramatic] [narration] [happy] [sarcastic] [crying]`; one built-in voice in FluidAudio | **In the test build** |
| 2 | **NeuTTS-2E** (Neuphonic, 2026-07) | NeuTTS Open License v1.0 ⚠️ free commercial use below **$5M annual revenue**, paid license above; upstream repo gated | Qwen3 236M (125M active) + NeuCodec; Core ML fp16 **1.37 GB** | FluidAudio `NeuTtsManager` (LM on GPU, codec on Neural Engine, iOS 18) | M5 Pro: 7–9 ms/token (needs 20 ms/token), batch ≈2×, streaming 1.6× with ~550 ms to first audio | 7 emotions (angry, disgusted, fearful, happy, neutral, sad, surprised) × 4 speakers (narrator and characters can differ) | **In the test build** (license caveat) |
| 3 | Chatterbox Turbo (2025-12) | MIT ✅ | 350M; Core ML 1.03 GB (iliasaz), MLX 4-bit 415 MB | iliasaz Swift package (ANE); mlx-audio (Python) | iPhone 17 Pro Max decode 29–35 ms/token on the ANE ≈ 0.75–0.9× (needs 40 ms/token), one-time 30 s ANE compile | Same tags as Nano, better quality ("excels at narration") | Next if Nano sounds too thin; pre-render only on an A18 |
| 4 | Pocket TTS (Kyutai, 2026-01) | CC-BY-4.0 ✅ (attribution; gated with an acceptable-use prompt). Voices `cosette`, `jean` are NC: don't use | 100M; Core ML `.ane` set 368 MB | FluidAudio `PocketTtsManager` (Neural Engine placement, streaming); mlx-audio-swift; sherpa-onnx | 6.5× M5 Pro, first frame 26 ms; **iPhone 17 Pro Max 2.5×** (FluidAudio) / 7.8× (Core AI, iOS 27) | Voice cloning from a clip (narrator and character voices from prompts); no emotion control; issue #115 "prosody worse than Kokoro" with default voices | Benchmarked; the background-capable fallback idea |
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
- NeuTTS-2E's license must travel with the weights (the downloader fetches its LICENSE file too).
- espeak-ng (GPL-3.0) is used by Kitten, NeuTTS Air, Zonos and StyleTTS2 front-ends; neither engine in
  the test build uses it (BPE text input).

## What the test build does

More › Developer › Voice Models (Developer options: More › About › tap the version 7 times), also the Kokoro Voice Lab › **Experimental engines**:

| Piece | Where |
|---|---|
| Pinned model files (repo, commit, path, size, SHA-256) | `ios/expressive-models.lock.json` ⇄ `ios/App/ExpressiveVoice/Sources/ExpressiveCore/PinnedModels.generated.swift` (`node tools/expressive-models.ts --update-lock / --check`) |
| Downloader: Wi-Fi only, free-space check, resumable, SHA-256 per file, excluded from backups, delete | `ExpressiveCore/ModelStore.swift` (the app and the CI benchmark use the same code) |
| Engines behind one protocol (`ExpressiveSynthesizer`): Chatterbox Nano, NeuTTS-2E, Pocket TTS (CI only) | `ios/App/ExpressiveVoice/Sources/ExpressiveEngines/` (FluidAudio 0.17.5, the same pin as HDVoice) |
| Per-engine direction: tags for Chatterbox (`[angry] …` in front, sound tags inline), emotion + speaker for NeuTTS, tags stripped for Kokoro; chunking to each model's per-call limit | `ExpressiveCore/ExpressiveCatalog.swift` |
| Engine behind the narration protocol (`SpeechEngine`): renders 3 sentences ahead, plays gaplessly, **Kokoro reads a sentence whenever the expressive engine can't deliver it** (still loading, queue ran dry, app in background, thermal serious, sentence failed, model released) and the expressive engine takes over again once 2 sentences ahead (HDVoiceCore's `HybridScheduler`, roles shifted) | `ios/App/App/Native/Voice/Expressive/ExpressiveSpeechEngine.swift` |
| Model lifecycle: one engine loaded at a time, unloaded on memory warnings and after 3 minutes idle (a release cancels the load and calls still running, a load released while it waits never starts, and the next load waits until the models are gone and any load still running has ended; after a memory warning no expressive model loads for 60 s, doubling until she has read 5 minutes without one, and Nephis refuses to load with less than ~700 MB free; her studio's models load in the background behind Pocket's with ~1,000 MB free (her calls play her plain sound until they are up, never waiting for them) and are dropped under ~500 MB free; the studio speed test runs alone, refusing under ~1,000 MB free, Kokoro loads asked for meanwhile wait for it and Nephis is warmed again after it; Kokoro's once-per-build warm-up runs after hers: crash plan 2026-10-12, `ExpressiveCore/NephisGuards.swift`); its own crash sentinel, judged with the run journal (`VoiceRun.swift`, `HDVoiceCore/RunJournal.swift`): only real crashes of her model count, two in a row → Nephis and the experimental engines off until "Turn Nephis back on" (Settings › Voices, the Voice test) or a new build | `Native/Voice/Expressive/ExpressiveService.swift` |
| Plugin `ExpressiveVoice` and the Voice Lab screen; samples (calm narration, emotional dialogue, a ~3-minute passage) and the cue-word tagger for pasted text | `ExpressiveVoicePlugin.swift`, `src/ui/native/expressive-lab.ts`, `src/ui/native/expressive-samples.ts` |
| Narrator voices for Chatterbox Nano: `.tnvoice` files made on the PC (`tachinovel-narrator/py/export_voice.py`), shipped in the app (`BuiltInVoices/`, one of them the default; `tools/built-in-voices.ts`) or imported (personal flavor), checked, chosen as the narrator voice, the default and then Chatterbox's own voice as the fallback | `ExpressiveCore/VoicePack.swift`, `ImportedVoices.swift`, `VoiceImport.swift`, `src/ui/native/voice-import.ts`, `tools/voice-pack.ts`; docs/voice-import.md |

The screen shows, per engine: size and license, download progress, load time (cold/warm); for the last
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

**Her studio in Listen** (`ExpressiveCore/NephisGuards.swift` StudioBudget and NephisStudioSwitch, 2026-10-15): the
"Her studio" switch is per pack and on by default (an off is kept for that pack until it is installed again). A call
gets the studio when its estimated work (its text at 12 characters a second, over the studio's measured × real time)
is at most half the audio buffered ahead of playback, that never counted under 1 s, so the first call of a read gets it
too when it costs at most 0.5 s. The speed is measured on every call it renders (a slower call sets it at once, a
faster one moves it 30 % of the way), kept over the app's life and remembered per pack for the next launch at half; with
nothing known it is 8x. Under 4x, in serious heat or Low Power Mode the old rule alone: the studio only with 6 s
buffered. The Voice test report's `flow.studio.plannedX` is the speed it plans with.

**Pack tone chain (pack.json `chain`)**, after her voice is made, in this order: first `dewind` `{"passes": 2}` (1-2;
the de-wind cleaner, below), then `breathPolish` and `eqAfterStudio`
(studio calls), `studioEQ` (studio calls: `gainDB` and up to 8 RBJ sections, `highShelf`, `lowShelf`, `peaking`, and
the browser EQ tuner's `highPass` low cut / `lowPass` top cut, 12 dB/octave with the section's Q, `db` ignored), then on
every call of hers (studio or plain) the tuner's finishing: `closeness` `{"amount"}` (0-1; a port of Chromium's
DynamicsCompressorNode with the tuner's threshold -32c - 18·min(1, 4c) dB, +6.02 dB for the phone's level, ratio 1 + 3c,
12 dB knee, 8 ms attack, 180 ms release, Chromium's makeup gain and the tuner's; 6 ms look-ahead), `breathAir`
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

## Expected on the iPhone 16 (A18)

The A18 has a 5-core GPU and ~60 GB/s of memory bandwidth, against 16–20 cores and ~300 GB/s on the M5
Pro behind FluidAudio's numbers, and a 16-core Neural Engine the CI runner lacks.
- **Chatterbox Nano**: the token generator is small (193 MB of fp16 weights per step, 25 steps per second
  of audio needed): fine. The flow + vocoder run on a fixed 10-second bucket per call (0.47 s on the M5
  Pro), so they cost the same for a short line as for a long one: expect roughly **1–2× real time** and
  **1.5–3 s to the first line**, better on long sentences than short ones.
- **NeuTTS-2E**: each step reads ~470 MB of weights; at the A18's bandwidth that is ≥ 8 ms per step
  before overhead, against a 20 ms budget: expect **0.6–1.2×**, so live playback may hand lines to Kokoro;
  the speed test shows whether rendering ahead would cover it.
- **Memory**: Chatterbox ~0.8–1.1 GB, NeuTTS ~1.5–1.9 GB, plus Kokoro (0.3–0.9 GB) for the fallback. No
  increased-memory entitlement with a free Apple ID; the Voice Lab shows what iOS still allows.
- **Heat**: sustained GPU decoding will warm the phone; the long-passage speed test shows the thermal state.
- **Lock screen**: GPU engines stop; Kokoro continues (by design in this build).

## 5-minute phone checklist

Downloads take a few extra minutes on Wi-Fi (0.75 GB + 1.37 GB); keep the app open while they run.

1. Install the IPA from the PR's `ios-ipa` artifact with AltStore. Connect to Wi-Fi.
2. More › About › tap the version 7 times (Developer options), then More › Developer › **Voice Models**.
3. **Chatterbox Nano** › Download 746 MB (tap twice). Then sample **Emotional dialogue** › ▶ Play
   sample. Listen for the anger, the whisper, the chuckle/gasp/sigh/laugh. Note *Time to first audio* and
   *Expressive / Kokoro lines*.
4. **▶ Same sample with Kokoro (as today)**: the A/B. Which one would you listen to for an hour?
5. Sample **Long passage** › **Speed test** (Chatterbox Nano): note × real time (all / slowest 10%),
   memory max and thermal before → after.
6. **NeuTTS-2E** › Download 1.37 GB, then repeat 3 and 5 with it (its narrator and characters use
   different voices).
7. Lock test: Long passage › ▶ Play sample with Chatterbox Nano, lock the phone for 30 s. Audio continues
   (Kokoro takes over: the lines show `kokoro` with `thermal`, which here means background); unlock and the
   expressive voice comes back after two sentences. No crash.
8. **Copy report**, paste it to Claude, and say which voice you preferred and why. Then delete the models
   (2.1 GB) unless you want to keep testing.

## Next steps (depending on the phone results)

- Expressive and ≥ 1.5× on the phone → wire the engine into narration as a per-novel "Expressive (beta)"
  voice that renders the next chapter ahead while the app is open, with Kokoro on the lock screen.
- Good but too slow or foreground-only → try the Neural-Engine builds of Chatterbox Nano (iliasaz, seanll95;
  ANE also works in the background on iOS 26) and Chatterbox Turbo for quality.
- Direction for real chapters: a better line tagger (dialogue attribution, cue words, the per-novel
  lexicon for character → voice), tested on the PC like the narration front-end.

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
