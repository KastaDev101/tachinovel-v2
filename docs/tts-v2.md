# Built-in narration (TTS) for v2

Status: architecture + working baseline in the scaffold, 2026-10-06. Builds on (does not repeat) the PC
prototype in the separate `tachinovel-tts-lab` repo (local only) (Kokoro-82M v1.0, misaki G2P:
2.6–3.3× realtime on a loaded desktop CPU, Whisper WER 1.6–5.3%, ~0.5 MB/min AAC). Sources carry dates;
"acc." = accessed 2026-10-06. iOS 27 shipped Sept 14, 2026
(https://macrumors.com/2026/09/09/apple-announces-ios-27-release-date/); the app targets iOS 17+.

## Bottom line

1. **Narration must be native.** WKWebView's Web Speech API only exposes the pre-installed low-quality
   voices (Apple engineer, https://developer.apple.com/forums/thread/723503, Jan 2023; WebKit bug 290497,
   filed Mar 26, 2025, still open), and the WebView's JavaScript is suspended in the background
   (https://developer.apple.com/forums/thread/64150, June 2020; WebAudio freezes after ~27 s,
   https://developer.apple.com/forums/thread/121822). v2 plays audio in Swift and fetches the next
   chapter through the native-hosted core, so it keeps going on the lock screen and in the car.
2. **Ship AVSpeechSynthesizer first** (done in the scaffold): free, zero download, Premium/Enhanced voices
   when the user has installed them, Personal Voice on iOS 17+, IPA pronunciations, works in the
   background with `.playback` + `.spokenAudio`.
3. **Then add Kokoro as a downloadable "HD voice"** (the Pro pull, docs/monetization.md): Core ML on the
   Neural Engine/CPU with an Apache-licensed G2P (no espeak-ng), delivered as an Apple-hosted asset pack.
4. **Render ahead, don't synthesize live on the lock screen:** iOS blocks GPU work in the background
   (https://developer.apple.com/documentation/metal/preparing-your-metal-app-to-run-in-the-background,
   acc.; on iOS 26.2 background Metal work now aborts the process,
   https://github.com/ggml-org/whisper.cpp/issues/3531, Nov 18, 2025). The App Store Kokoro app Sandbook
   pauses live reading on lock and pre-renders chapters instead (https://sandbook.app/kokoro-tts, Oct 1, 2026).
5. Effort: **~12–22 weeks** for one experienced iOS developer for the full feature set; the AVSpeech
   baseline in this scaffold is the first ~3–5 of those weeks, still unverified on a device.

## 1. What the scaffold already implements

| Piece | File | Notes |
|---|---|---|
| Engine abstraction + AVSpeech engine | `ios/App/App/Native/Narration/SpeechEngine.swift` | `SpeechEngine` protocol (enqueue/stop/pause/resume, start/finish/word-range callbacks); `usesApplicationAudioSession = true`; best installed voice (premium > enhanced > default); IPA lexicon via `AVSpeechSynthesisIPANotationAttribute`, respellings |
| Queue, chapter flow, lock screen | `Narration/NarrationController.swift` | sentence queue per chapter; paragraph/scene pauses; skip by sentence/paragraph; **auto-continue** into the next chapter via the core (`narration.chapterText`); look-ahead at 80%; **progress.save** every 5 s + at chapter end (the reader resumes where listening stopped); sleep timer; interruptions (see "Interruptions" below); pause on headphone/car disconnect; Now Playing (title, novel, artwork, estimated duration/elapsed); remote commands: play/pause/toggle, next/previous chapter, ±paragraph skip, playback rate 0.75–2× |
| JS API | `src/ui/native/narration.ts` + `Narration/NarrationPlugin.swift` | play (with the reader's paragraphs, or let native fetch), pause/resume/stop/skip, setOptions (voice, rate, pitch, lexicon, pauses, sleep), voices (quality + Personal Voice flag), requestPersonalVoice, state; events `state`, `progress` (paragraph, sentence, word range) |
| Reader integration | `src/ui/native/narration-overlay.ts` | "Listen from here" button over the v1 reader; paragraphs read from the reader DOM so highlight indexes match v1's `ChapterPosition.paragraph`; highlights and follows the spoken paragraph |
| Core-side text | `src/core/narration/text.ts` | HTML → paragraphs → sentences for native use without the UI; normalization rules ported from the lab's `narrate.py` (quotes, "…", em dashes, "!!!", `[System]` brackets, scene breaks, `Chapter 1 - X` → `Chapter 1. X.`, short-fragment merge); unit-tested |
| CarPlay | `Native/CarPlay/CarPlaySceneDelegate.swift` | "Continue listening" list from history, rebuilt every time it appears; a tap resumes at the **saved paragraph** via the core's `narration.resumePoint` (or the next chapter if the last one was finished; continues the current narration instead of restarting it); shared Now Playing template. Needs Apple's CarPlay audio entitlement |
| Background | `Info.plist` | `UIBackgroundModes: audio` |

Not yet: the neural engine, render-ahead cache, word-accurate highlighting for neural voices, a voice/
lexicon settings screen in the v1 UI (needs a v1 UI change), on-device tests.

### Interruptions (phone calls, Siri, other apps' audio)

`InterruptionPolicy` in `NarrationController.swift`. Resume after an interruption only when all three hold:

| Narration when the interruption began | System says `.shouldResume` at the end | User acted in between (pause/play/stop/skip, or headphones/car disconnected) | Result |
|---|---|---|---|
| playing | yes | no | **resume** |
| playing | no | — | stay paused |
| playing | yes | yes | stay as the user left it |
| paused (by the user) | yes or no | — | **stay paused** (a call never undoes a user pause) |
| idle / stopped | — | — | nothing |

Route changes (`.oldDeviceUnavailable`) pause and cancel any pending resume. Swift has no test target in
this scaffold; this table is the spec for the device checklist and a future XCTest.

## 2. Engine options

### System voices (AVSpeechSynthesizer)
| Capability | Status | Source |
|---|---|---|
| Quality tiers | `.default`, `.enhanced`, `.premium` (iOS 16+); enhanced/premium are user downloads in Settings | https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoicequality/premium.md (acc.) |
| Trigger downloads from the app | **No API**; deep-link users to Settings → Accessibility → Spoken Content → Voices | https://developer.apple.com/forums/thread/787779 (June 2025); https://developer.apple.com/forums/thread/758460 |
| Siri voices | Not available to third-party apps (community answer) | https://developer.apple.com/forums/thread/682438 (Oct 2021) |
| Personal Voice | iOS 17+: `requestPersonalVoiceAuthorization`, `voiceTraits.isPersonalVoice`; Apple positions it "primarily" for AAC apps | https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/requestpersonalvoiceauthorization(completionhandler:).md ; https://developer.apple.com/videos/play/wwdc2023/10033/ |
| SSML | `AVSpeechUtterance(ssmlRepresentation:)` iOS 16+; rate/pitch properties don't apply to SSML | https://developer.apple.com/documentation/avfaudio/avspeechutterance/init(ssmlrepresentation:)-8zam9.md |
| IPA | `AVSpeechSynthesisIPANotationAttribute` (iOS 10+) — used for the lexicon | https://developer.apple.com/documentation/avfaudio/avspeechsynthesisipanotationattribute.md |
| Buffers | `write(_:toBufferCallback:)` (iOS 13+), with markers (iOS 16+) — known bugs on 17/18 | https://developer.apple.com/forums/thread/731624 ; https://developer.apple.com/forums/thread/769342 |
| Word ranges | `willSpeakRangeOfSpeechString` (has had wrong-range bugs) | https://developer.apple.com/forums/thread/133104 |
| Background | Continues on the lock screen with background audio + `.playback` (a shipping reader confirms); can't *start* from a suspended state | https://developer.apple.com/forums/thread/826849 (May 2026); https://developer.apple.com/forums/thread/759816 |
| CarPlay caveat | Speech silent/very quiet in some cars, unresolved through May 2026 → for CarPlay, render to PCM and play via AVAudioEngine | https://developer.apple.com/forums/thread/807197 |

### On-device Kokoro-82M (Apache-2.0 weights, https://huggingface.co/hexgrad/Kokoro-82M)
| Stack | Runtime | Size | Speed (published) | Background-safe? | G2P | License | Status |
|---|---|---|---|---|---|---|---|
| mlalma/kokoro-ios (KokoroSwift) | MLX Swift (GPU) | ~325 MB safetensors (Sandbook's MLX bundle 276 MB incl. 41 voices) | ~3.3× realtime iPhone 13 Pro | **No** (GPU) | MisakiSwift (Apache-2.0), BART fallback on MLX | MIT / Apache | last commit Jan 10, 2026; tag 1.0.8 adds per-token timestamps (https://github.com/mlalma/kokoro-ios ; https://swiftpackageregistry.com/mlalma/kokoro-ios) |
| FluidInference/FluidAudio "Kokoro ANE" | Core ML, 7 stages, 4 on ANE | weights on HF (Sept 25, 2026) | 3–11× RT on Apple Silicon; **no iPhone numbers**; cold compile ~20 s on M1 | Yes if forced to CPU+ANE | Core ML BART → IPA (README: no GPL deps; older docs mention eSpeak — conflicting) | Apache-2.0 | v0.17.5 Oct 1, 2026; ≤510 phonemes/call; `synthesizeDetailed()` gives durations; **no custom lexicon on the ANE path** (https://github.com/FluidInference/FluidAudio ; …/Documentation/TTS/KokoroAne.md) |
| soniqo/speech-swift | Core ML (ANE) | ~80 MB INT8 (1 bucket) – 170 MB | inconsistent claims (unverified) | likely | dictionary + stemming + BART; `addPronunciations` API | Apache-2.0 incl. weights | active Sept 2026 (https://github.com/soniqo/speech-swift ; https://soniqo.audio/guides/kokoro) |
| mattmireles/kokoro-coreml | Core ML, 5 packages | 178 MB multifunction | iPhone 15 Pro Max: 30 s audio in 6.4 s (~4.7× RT) | partly (one stage ANE, rest CPU+GPU) | Misaki + BART (Apache) | Apache-2.0 | June 2026 (https://huggingface.co/mattmireles/kokoro-coreml) |
| k2-fsa/sherpa-onnx | ONNX Runtime CPU | 310 MB / int8 ~165 MB | no iOS numbers | Yes (CPU) | **espeak-ng data (GPL-3.0)** | Apache-2.0 code | v1.13.8 Sept 10, 2026 (https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html) |
| Own ONNX Runtime build (lab's model) | ORT CPU (or Core ML EP) | 310 / 169 fp16 / 88 int8 MB (https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0) | no A18 data; nearby CPU data suggests ~1–2.5× RT (https://docs.swmansion.com/react-native-executorch/docs/0.7.x/benchmarks/inference-time) | Yes (CPU) | you supply (MisakiSwift or a port of the lab's misaki) | MIT | — |

Shipping precedents: **Sandbook** (SmashMelon LLC; released May 18, 2025; 277 MB with the model bundled;
MLX; free; pre-renders for lock; no CarPlay — https://apps.apple.com/app/id6745732885) and **Voice
Forge** (Kokoro, 234 MB, subscription — https://apps.apple.com/us/app/-/id6743238823).

### GPL warning
espeak-ng is GPL-3.0-or-later (https://github.com/espeak-ng/espeak-ng). The App Store and GPL have a
history: GNU Go pulled May 26, 2010 after the FSF objected (https://lwn.net/Articles/391423); VLC pulled
Jan 8, 2011 after a contributor's complaint (https://thenextweb.com/news/apple-officially-pulls-vlc-from-the-app-store).
**Keep espeak-ng (and sherpa-onnx's Kokoro path, piper1-gpl, phonemizer) out of the app.** Note for the
lab: misaki's espeak fallback is optional, but without any fallback unknown words get no phonemes
(https://github.com/hexgrad/misaki) — invented names are exactly those words, so the iOS stack needs a
BART fallback **and** the lexicon.

## 3. Recommended architecture

```
 reader (WebView)           native (Swift, main thread)                         core (JSContext)
 ─────────────────          ───────────────────────────────────────────────    ───────────────────
 Listen ▶ paragraphs ──►  NarrationController ── text ──► Normalizer + Lexicon     narration.chapterText
 highlight ◄── progress    │  queue: chapter → paragraphs → sentences            (next chapter, cleanup
                           │                                                      rules, cache) ◄──┐
                           ├─► SystemSpeechEngine (AVSpeech)        live           progress.save ◄─┤
                           └─► NeuralSpeechEngine (Kokoro, Core ML) ─► RenderCache ──► AVAudioEngine │
                                  ▲ foreground / charging: render chapter N and N+1 to AAC/CAF      │
                                  └ lock screen: play rendered audio; never touch the GPU          │
                           Now Playing + remote commands + CarPlay templates ── auto-continue ──────┘
```

1. **Text:** core `narration.chapterText` (cleanup rules applied; same normalization as the lab) or the
   reader's DOM paragraphs. Sentence split: core `Intl.Segmenter` / native `NLTokenizer`
   (https://developer.apple.com/documentation/naturallanguage/nltokenizer.md); fragments < 12 chars merge
   forward (lab rule).
2. **Lexicon:** one store per novel (and global): grapheme → `{ipa, misaki phonemes, respelling}`.
   AVSpeech uses IPA attributes; Kokoro injects phonemes (`[Name](/phonemes/)` convention) or the
   engine's pronunciation API; FluidAudio's ANE path has none, so pre-phonemize. Seed it from the lab's
   QA (Whisper flags mispronounced names; e.g. "Tsk", "Aspirant").
3. **Neural synthesis:** ≤510 phonemes per call; render-ahead whole chapters (current + next) to an AAC
   cache while the app is foreground or charging; keep 30–60 s live look-ahead as a fallback.
   Compute units `.cpuAndNeuralEngine` (never GPU in background). Cache cap + LRU like v1's read-ahead.
4. **Playback:** `AVAudioEngine` + `AVAudioPlayerNode.scheduleBuffer(…, completionCallbackType:
   .dataPlayedBack)` (https://developer.apple.com/documentation/avfaudio/avaudioplayernodecompletioncallbacktype.md);
   silence buffers for pauses (lab: 0.32 s sentence, 0.70 s paragraph, 1.3–1.8 s headings/scenes);
   5–10 ms fades at chunk edges; speed via Kokoro's duration scaling or `AVAudioUnitTimePitch`.
   Session `.playback` + `.spokenAudio`, not mixable (Now Playing eligibility,
   https://developer.apple.com/videos/play/wwdc2022/110338); pause on `.oldDeviceUnavailable`
   (https://developer.apple.com/documentation/avfaudio/responding-to-audio-route-changes.md); iOS 27 adds
   new interruption notifications (https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions.md).
5. **Highlighting:** sentence-level everywhere (cheap and robust); word-level from AVSpeech ranges or
   Kokoro predicted durations (kokoro-ios 1.0.8 timestamps, FluidAudio `synthesizeDetailed`), driven by
   the player node's render time; sent to the WebView only while it is foreground, resynced on return.
6. **Auto-continue:** the native queue asks the core for the next chapter at ~80% (implemented), so a
   locked phone keeps going chapter after chapter; Now Playing chapter number/count and next/previous
   track map to chapters.
7. **Battery/thermal:** synthesize in bursts; shrink look-ahead or fall back to the system voice on
   `ProcessInfo.thermalState` ≥ serious or Low Power Mode; unload the model when idle; peak memory ~0.9–1 GB
   in published runs → consider `com.apple.developer.kernel.increased-memory-limit`
   (https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.kernel.increased-memory-limit.md).

## 4. Delivery and app size

- App limit 4 GB; cellular downloads ask above 200 MB (https://developer.apple.com/help/app-store-connect/reference/maximum-build-file-sizes ;
  https://techcrunch.com/2019/06/03/ios-13-will-let-you-bypass-the-app-store-download-cap-when-on-a-cellular-connection).
  The base app stays small (web layer < 1 MB; Swift; no model).
- **On-Demand Resources are "legacy"; use Background Assets.** Apple-hosted asset packs (iOS 26+),
  200 GB per app included in the membership, essential/prefetch/on-demand policies, versioned separately
  from builds (https://developer.apple.com/videos/play/wwdc2025/325, June 2025;
  https://developer.apple.com/help/app-store-connect/reference/app-uploads/apple-hosted-asset-pack-size-limits).
- Plan: an on-demand **"HD Voice" pack** = int8/fp16 model (~90–180 MB) + the chosen voices (voices file
  28 MB for all 54; ship 4–6 English voices). Show the size and ask before downloading (guideline
  4.2.3). Weights are data, not code (2.5.2), and other Kokoro apps download them.
- iOS 17–25 devices: either require iOS 26 for HD voices (simplest) or self-host (GitHub Releases has no
  bandwidth cap, https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases;
  Cloudflare R2 egress is free, https://developers.cloudflare.com/r2/pricing/).

## 5. CarPlay

- Audio apps need the `com.apple.developer.carplay-audio` entitlement, requested from Apple
  (https://developer.apple.com/carplay/); the guide requires apps "designed primarily" for audio
  playback — ambiguous for a reader with a narration mode (https://developer.apple.com/forums/thread/728907).
  Precedent: Instapaper shipped CarPlay TTS on May 8, 2023
  (https://alternativeto.net/news/2023/5/instapaper-releases-carplay-app-with-advanced-text-to-speech-technology-for-listening-to-saved-articles-on-the-go);
  Speech Central lists CarPlay (https://apps.apple.com/us/app/speech-central-ai-voice-reader/id1127349155).
  Approval: email only, weeks to months (https://developer.apple.com/forums/thread/847440, 2026). **Apply early.**
- Templates: list/tab/grid + the shared `CPNowPlayingTemplate` (audio-entitlement only,
  https://developer.apple.com/documentation/carplay/cpnowplayingtemplate.md); ≤5 levels deep, 3 recommended.
  iOS 26 adds list image row styles and `CPListTemplateDetailsHeader` (26.4).
- **Without the entitlement** narration still plays through the car and shows in CarPlay's own Now
  Playing screen with steering-wheel controls (https://developer.apple.com/videos/play/wwdc2017/719).
  That is the personal-build reality until Apple approves.

## 6. Licensing for commercial use

| Component | License | OK in a closed, monetized app? |
|---|---|---|
| Kokoro-82M weights + voices | Apache-2.0 | **Yes** (keep attribution/NOTICE) |
| misaki / MisakiSwift / kokoro-ios | Apache-2.0 / MIT | Yes (without the espeak fallback) |
| FluidAudio + its Core ML weights; speech-swift; mattmireles/mlboydaisuke conversions | Apache-2.0 | Yes (pin versions: young, fast-moving) |
| MLX Swift; ONNX Runtime | MIT | Yes |
| espeak-ng; piper1-gpl; phonemizer | GPL-3.0 | **No** |
| sherpa-onnx | Apache-2.0 code, but Kokoro path uses espeak-ng data | Code yes, Kokoro path no |
| Piper voices | per voice; e.g. en_US-lessac from Blizzard 2013 data is **non-commercial** | Check each |
| MeloTTS | MIT | Yes |
| Kitten TTS | small models Apache-2.0; v2 under a custom community license | Small models yes |
| Kyutai Pocket TTS | CC-BY-4.0 with use restrictions | Likely, with attribution |
| F5-TTS weights | CC-BY-NC-4.0 | **No** |
| XTTS-v2 | Coqui Public Model License (non-commercial); Coqui closed Jan 2024 | **No** |

Sources: model/repo pages linked in section 2; https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/lessac/medium/MODEL_CARD ;
https://github.com/myshell-ai/MeloTTS ; https://github.com/KittenML/KittenTTS ; https://huggingface.co/kyutai/pocket-tts ;
https://huggingface.co/SWivid/F5-TTS ; https://huggingface.co/coqui/XTTS-v2 (all acc.).

## 7. Relationship to the PC TTS lab

- The lab answers "how good can it sound"; v2 answers "how do I listen in the car". They meet in three
  places: (1) the text rules (already ported into `src/core/narration/text.ts`), (2) the lexicon (lab QA
  finds names to fix), (3) voice choice (lab grades: af_heart A; am_michael/bm_george C+/C).
- **Cheap personal win:** the lab's planned batch job writes M4A chapters to iCloud. The personal v2
  build could play those files with the same Now Playing/CarPlay plumbing (an "audio file" engine
  behind `SpeechEngine`), giving Kokoro quality in the car before on-device Kokoro exists. Copyright:
  personal listening only; never ship or share those files.

## 8. Plan and effort (one experienced iOS developer, estimates)

| Step | Effort | Gate |
|---|---|---|
| Device-test the AVSpeech baseline (lock screen 30+ min, interruptions, Bluetooth, car) | 1 week | needs a device build (TestFlight) |
| Voice/lexicon/sleep settings UI in the reader (v1 UI change) | 1 week | — |
| Neural engine spike: FluidAudio ANE vs ORT CPU int8 on an iPhone 16 — speed, memory, **background test** | 1–2 weeks | **decides the engine** |
| Neural engine + render-ahead cache + AVAudioEngine player | 3–6 weeks | spike result |
| Asset-pack delivery + download UI | 1–2 weeks | iOS 26 decision |
| CarPlay templates polish | 2–3 weeks | entitlement granted |
| QA (cars, Bluetooth, thermal, battery) + App Review iterations (2.5.4 video) | 2–4 weeks | — |
| **Total** | **~12–22 weeks** | |

Main risks: background compute (GPU blocked; ANE behaviour undocumented — test on a locked iPhone 16
first), GPL contamination via a transitive dependency, CarPlay entitlement delay/denial, 2.5.4 review
friction, pronunciation of invented names, AVSpeech `write()`/marker regressions, ~1 GB peak memory and
first-run Core ML compile time, library churn.
