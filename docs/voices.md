# On-device voices: Kokoro, with the Apple voice as the fallback

Status 2026-10-06: built, unit-tested on the PC, and tested in CI on the macOS runner (model + every voice)
and in the iOS Simulator (Listen flow + fallback). **Speed, stability and sound quality on the iPhone
still need checking:** use the 5-minute checklist at the end.

Every chapter is read by **Kokoro-82M on the iPhone**. Nothing is downloaded and the PC isn't involved.
When Kokoro can't deliver the next sentence in time, the **best installed Apple voice** reads that
sentence, and Kokoro takes over again at a sentence boundary once it is ahead.

## How it works

```
 reader DOM ──speech-dom.ts──┐                                  ┌─► Kokoro (FluidAudio Core ML, bundled)
                             ├─► sentence script ─► Narration ──┤     rendered 2–3 sentences ahead → AVAudioEngine
 core (lock screen) ─────────┘   (v1 front-end +    Controller  └─► Apple voice (AVSpeechSynthesizer)
   narration.chapterText          lexicon, pauses)  HybridSpeechEngine: HybridScheduler picks per sentence
```

| Piece | Where |
|---|---|
| Sentence script: v1's narration front-end (the PC narrator's normalization, pauses and pronunciation lexicon), one item per sentence with its place in the chapter (for highlighting) and lexicon phonemes for Kokoro | `src/core/narration/speech-script.ts`; UI `src/ui/native/speech-dom.ts`; core `narration.chapterText` → `script` |
| Pronunciations: global + per novel, the v1 lexicon format (paste a PC-narrator lexicon to import it) | core `narration.lexicon.get/set` (synced store `narration-lexicons.json`); editor in `voices-ui.ts` |
| Which voice speaks each sentence; render-ahead; fallback and return | `ios/App/HDVoice/Sources/HDVoiceCore/HybridScheduler.swift` (XCTest) |
| Kokoro: bundled model loaded read-only, lexicon phoneme splicing | `HDVoiceKokoro/KokoroRuntime.swift` (shared by the app and CI) |
| Audio: Kokoro buffers (trimmed, loudness-matched, faded, pause appended) on AVAudioEngine, gapless; Apple utterances in between; shared audio session | `ios/App/App/Native/Voice/HybridSpeechEngine.swift` |
| Load/release, memory pressure, idle release, warm-up, crash containment | `Native/Voice/KokoroService.swift`, `HDVoiceCore/CrashSentinel.swift` |
| Preferences: default voice, per-novel voice, Kokoro on/off, "Use PC audio when available" (off) | `HDVoiceCore/VoiceCatalog.swift`, `Native/Voice/VoiceSettings.swift` |
| UI: More › Voices, voice picker per novel (Listen player › Voice), pronunciations, hidden Voice Lab | `src/ui/native/voices-ui.ts`, `voice-lab.ts`, `v1-hooks.ts`, `car-mode.ts` |

### When the Apple voice speaks

| Situation | What happens |
|---|---|
| Listen pressed, model warm | Waits up to 2.5 s for Kokoro's first sentence (usually well under 1 s), then Kokoro |
| First Listen after installing or updating the app | Core ML compiles the model for the Neural Engine once (tens of seconds). The app does this in the background ~6 s after the first launch of a build. If you press Listen before it's done, Apple reads until Kokoro is 2 sentences ahead |
| The next sentence isn't rendered when the current one ends (queue ran dry) | 0.25 s grace, then Apple reads that sentence. Kokoro keeps rendering and takes over when it is 2 sentences ahead |
| Phone thermally throttled (serious or critical) | No new Kokoro renders. Already-rendered sentences still play, then Apple until the phone cools down |
| One sentence fails to synthesize | Apple reads that sentence; Kokoro continues with the next. Three failures in a row: Apple for the rest of the chapter |
| Memory warning | The model is released, Apple covers, and the model reloads after 60 s (backing off to 10 min) |
| Kokoro crashed the app twice in a row (a known iOS Core ML bug, below) | Kokoro is turned off; Settings › Voices shows "Turn it back on" |
| Kokoro turned off in Settings › Voices | Apple always |

Apple voice choice: an explicitly chosen system voice if there is one, else the best installed English
voice (Premium > Enhanced > default), preferring the Kokoro voice's gender and accent. If only default
voices are installed, Settings › Voices suggests downloading a Premium voice (Settings › Accessibility ›
Spoken Content › Voices › English).

Speed, sleep timer, the lock screen, Now Playing, remote commands, interruptions and auto-advance into
the next chapter go through the same NarrationController for every source. Speed is Kokoro's own speed
parameter (no pitch shift), and pauses scale with it.

### Battery and heat

Kokoro renders at most 3 sentences ahead (Voice Lab: 2 or 3), one at a time, and stops rendering while
playback is paused or the phone is throttled. The model is released 5 minutes after narration stops, and
right away on a memory warning. Compute placement (`KokoroRoute`): the RNN/attention stages on the
**Neural Engine**, and the fp32 noise + iSTFT stages on the **CPU**. The GPU is never used, because iOS
doesn't allow GPU work in the background and narration must keep rendering on the lock screen. The Voice
Lab can switch to FluidAudio's GPU placement for a foreground-only speed comparison.

## In the car

Kokoro, the Apple fallback, prepared chapters and PC audio all show in CarPlay's Now Playing screen and
answer the car's buttons and Siri. Before a drive, a novel's **Prepare for the drive** renders the next
chapters with Kokoro into local audio, so playback never waits on synthesis or the network. Details,
settings and the on-phone car checklist: docs/car.md.

## The bundled model

- **What:** FluidAudio's 7-stage Core ML build of Kokoro-82M v1.0 (fp16 + int8-palettized weights, the
  "ANE" build), the English G2P (BART), the Misaki lexicon, and 6 voices: Heart, Bella (US female), Emma
  (UK female), Michael, Fenrir (US male), George (UK male). These are 97.4 MB on disk.
- **Pinned:** `ios/kokoro-models.lock.json` holds the Hugging Face revision and a SHA-256 for every file
  and for every converted voice pack. A mismatch fails the build.
- **Never committed:** `ios/App/App/KokoroModels/` is git-ignored. Xcode copies it into the app as a folder
  reference.
- **Loaded read-only from the bundle**, with FluidAudio's offline mode on: a missing file is an error,
  never a download. FluidAudio reads its G2P and lexicon from a fixed cache path, so those four entries are
  symlinked from Application Support into the bundle on each load.
- **App Store later:** `KokoroService` has a TODO for Apple-hosted asset packs (the model would live in
  Application Support). It isn't built yet.

### Local development

```
node tools/fetch-voices.ts            # download + verify into ios/App/App/KokoroModels (cache: .cache/kokoro)
node tools/fetch-voices.ts --check    # verify an installed folder offline
node tools/fetch-voices.ts --update-lock [--revision=<sha>]   # maintainers: re-pin (hashes everything,
                                      # self-tests the voice conversion against the published af_heart.bin)
node tools/voice-fixtures.ts          # the CI fixture sentences, through the app's front-end
npm test                              # incl. tests/voice.test.ts (script, lexicons, pinning, CI checks)
npm run test:shell                    # PC shell: script from the reader DOM, sentence highlight, Voices screen
```

Swift (`swift test --package-path ios/App/HDVoice`, the app build) needs a Mac, so CI runs it.

## CI

| Job | What it proves |
|---|---|
| `ios-compile + simulator smoke` | The app (with HDVoice + FluidAudio) compiles for the simulator and launches; keeps the simulator app for `voice-simulator` |
| `ios-ipa (unsigned, for AltStore)` | Device build with the bundled model; the job summary lists the IPA size and the installed size |
| `voice-quality (Kokoro on macOS + ASR)` | `swift test` for HDVoiceCore. Then `kokoro-check` loads the bundled model the way the app does and synthesizes the fixtures (short, long, dialogue, numbers/"Ch. 12", lexicon names) with all 6 voices. It checks: 24 kHz, no NaN/Inf, no clipping, speech-level RMS, words per minute, time to first audio, real-time factor (fails only on gross regressions), and memory released afterwards. Ends with a whisper.cpp v1.9.4 (base.en q8_0, pinned) ASR round trip on 3 sentences, WER ≤ 15% (skipped with a warning if whisper.cpp can't be built) |
| `voice-simulator (Listen flow + fallback in the simulator)` | The Debug app runs `-tachiVoiceSelfTest`: a synthetic chapter through the real Listen path (script → native engine → Kokoro → progress → highlight), in three phases: normal, Kokoro slowed down (Apple must take over, and Kokoro must come back when the delay is lifted), Kokoro failing (Apple reads everything). There's no audio device on the runner, so output is rendered headless at real-time pace |

Make `voice-quality` and `voice-simulator` required checks only after they have been stable for a while.
The macOS runner is a VM: Core ML there runs on CPU/GPU, not on the Neural Engine, so speeds from CI are
lower than on the phone.

### Measured in CI (2026-10-06, PR #7)

| What | Result |
|---|---|
| IPA (download) / installed app | 96.7 MB / 115.4 MB (model 93.1 MB, app binary 18.3 MB incl. FluidAudio + NeMo text normalization) |
| Kokoro on the CI Mac (VM, no Neural Engine: CPU) | model load 4.8 s cold, first audio 6.4–7.7 s (load + the first sentence, which also warms the G2P), **median 6.3–8.4× real time** over 36 sentences (6 voices × 6 fixtures), 0 NaN or clipped samples, RMS 0.04–0.10, 119–239 words per minute |
| ASR round trip (whisper.cpp base.en) | 3/3 sentences transcribed word for word (WER 0%) |
| Memory | 318 MB with the model loaded. About 80% stays counted after the model is released (Core ML keeps compiled stages cached; iOS can reclaim them under pressure). Watch the Voice Lab's memory line on the phone |

The phone has a Neural Engine and a faster CPU, so expect faster than this.

## Licenses (commercial use)

Everything in the voice path is **Apache-2.0** and fine in a closed, paid app with attribution. Notices
are in THIRD_PARTY_NOTICES.md and in the app (Settings › About › Open Source Licenses):

- Kokoro-82M weights and voices (hexgrad);
- FluidAudio and its Core ML conversion of Kokoro (FluidInference, derived from laishere/kokoro-coreml
  with the author's permission);
- the misaki lexicon;
- NeMo text normalization (NVIDIA; Rust port by FluidInference) with rustfst (MIT/Apache);
- fastcluster (BSD-2) is linked but unused.

There is no espeak-ng (GPL) in the Kokoro path. One caveat for a store build: FluidAudio bundles a ~1 MB
LuxTTS lexicon that was harvested from espeak-ng output. TachiNovel doesn't use it; strip it or get
upstream to make it optional before a commercial release.

## The iOS 26 Core ML crash (FluidAudio #844): what we know and what this build does

**The reports.** On iOS 26.4–26.6 (#587, #817, #844) and iOS 27 (#889), Kokoro synthesis sometimes kills
the app with `EXC_BAD_ACCESS` in Apple's `libBNNS` (`BNNSGraphContextExecute_v2` →
`E5RT::Ops::BnnsCpuInferenceOperation::ExecuteSync`, queue `com.apple.e5rt.concurrentExecutionQueue`).
It happens with any compute placement, `.cpuOnly` included (#587), because Core ML runs the ops the Neural
Engine can't take through BNNS on the CPU whatever you ask for. Some inputs crash and others don't (#587:
"specific input words"). The more sentences a session synthesizes, the more likely it is (#844). It is
not memory (SIGSEGV, not jetsam) and not a corrupt model.

**The trigger, as far as it is known.** A BNNS CPU kernel reads a few bytes past the end of the Vocoder's
fp16 input `x_source_0` (`[1, 256, 20·T]`, 10,240·T bytes). Whenever that size is a whole number of
16 KB pages (T a multiple of 8), the overread can land on an unmapped page and fault, depending on what
happens to be mapped next to it. That explains "some sentences", "more sentences, more crashes" and
"time/environment-gated". FluidAudio found it on macOS 27 and fixed it in **0.17.0** (PR #950, 2026-09-23):
every chain input is now allocated with a zeroed 16 KB tail, so the overread reads zeros instead of
faulting. Upstream calls the iOS reports "probably the same class, not verified on iOS". There is no
report from an iPhone running ≥ 0.17.0 yet, either way.

**What this build does:**

| Measure | Why |
|---|---|
| FluidAudio **0.17.5** (includes the 0.17.0 padding fix) | The only fix that addresses the root cause. No routing avoids BNNS |
| GPU-free placement (Neural Engine + CPU) | Keeps the RNN stages off the GPU (the GPU RNN JIT abort, #667), and works on the lock screen, where iOS forbids GPU work. iOS 26's FluidAudio default (`aneTailGpu`) crashed the same way in #844 anyway |
| Warm-up only **loads** the model (Neural Engine compile), it never synthesizes | A Core ML crash can't happen right after launch, only while you listen |
| Crash sentinel (a file written before each synthesis, checked at launch) | Two crashes in a row → Kokoro off, Apple voice, a "Turn it back on" button in Settings › Voices |
| Voice Lab: "Safety fallback" (tripped or not, crash count, what was being synthesized) and "Where each stage runs" (Core ML's per-operation plan: Neural Engine / CPU / GPU ops per stage) | So tonight's test tells us whether it held, and how much of each stage runs on the CPU (where BNNS lives) |

Not available, considered and rejected: forcing a stage onto the Neural Engine only (Core ML still sends
unsupported ops to BNNS); `.cpuAndGPU` (no GPU in the background, and it doesn't remove BNNS); an older
FluidAudio (no fix); bypassing Core ML for the Tail with Accelerate (an unmerged experiment in #889); ONNX
Runtime on the CPU, which read a whole book without a crash in #889. That last one is the fallback plan if
the phone still crashes with 0.17.5 (docs/tts-v2.md D6).

A separate class, #979: on an A12 iPhone with iOS 18.7, BNNS overflowed Core ML's 512 KB worker stack in
the Noise stage on the CPU route. There are no reports on newer chips or iOS 26, and the app can't change
that thread's stack. The sentinel covers it too.

## Known risks (watch these on the phone)

1. **The Core ML crash above.** If it happens, note the time and the Voice Lab "Safety fallback" lines.
2. **First compile:** the first load after install/update compiles the model for the Neural Engine (tens
   of seconds). The app warms it up in the background ~6 s after launch.
3. **Memory:** about 300–900 MB while loaded (FluidAudio's Mac peak 881 MB). It is released when idle or on
   memory pressure.
4. **iOS 27:** Core ML needs the `continued-processing.inference` entitlement to use the Neural Engine in
   the background. A free Apple ID can't sign that, so on iOS 27 a sideloaded build may fall back to Apple
   on the lock screen. Not an issue on iOS 26.6.1.

**Expected speed on the iPhone 16 (A18):** laishere's conversion reports ~17× real time on an iPhone 16
Pro. A FluidAudio user measured 18–21× on an iPhone 17 Pro Max with 400-token chunks. Our sentences are
shorter, so expect roughly **8–20× real time** per sentence and **0.3–1 s** to first audio with a warm
model. Anything above ~2× keeps the queue full.

## 5-minute check on the iPhone

1. Install the IPA from the PR's `ios-ipa` artifact (about 90–100 MB now). Open the app and leave it on
   the Library for ~1 minute (background warm-up).
2. **More › Voices**: tap ▶ on each of the 6 voices. The first one may take a while if the warm-up hasn't
   finished; after that each should start in under ~1 s. Pick your favorite (✓). Check the Fallback line:
   if it says only basic Apple voices are installed, download a Premium voice later.
3. Open a chapter and tap **Listen**. The mini player says "Kokoro · Heart"; the spoken sentence is
   highlighted and followed. Change speed in the Listen player (tap the mini player).
4. **Lock the phone for 2 minutes**. Audio keeps going, the lock-screen player works (play/pause, next
   chapter), and there are no gaps between sentences. Unlock and check the mini player label: "Apple
   voice · … Kokoro catching up" means a fallback happened.
5. **Voice Lab** (More › About › tap the version 5 times): note **Safety fallback** (should say "not
   tripped"), **Where each stage runs** (how many ops of each stage Core ML puts on the Neural Engine, the
   CPU and the GPU), **time to first audio**, **speed (× real time)** and slowest 5%, model load
   (cold/warm), **Kokoro / Apple sentences**, **Queue ran dry**, memory and thermal state. Then tap **Copy
   report** and paste it to Claude.
6. Optional: Voice Lab › "Neural Engine + GPU (foreground only)" › Speak test paragraph, to compare speed;
   switch back to the default afterwards.
