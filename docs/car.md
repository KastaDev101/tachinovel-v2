# Using it in the car

TachiNovel plays in the car without a CarPlay app of its own. CarPlay's built-in **Now Playing** screen
shows and controls any app that is playing audio. So do the lock screen, Control Center, headphones,
steering-wheel buttons and Siri. This page covers what that gives you, how to set it up for a drive, and
how it works. Help › Listening in the app has the short version.

## What you get

- **Start listening.** Tap the headphones in the reader, or More › Listen › a novel. With nothing loaded,
  "Hey Siri, resume" or ▶ in the car continues the novel you listened to or read last.
- **Now Playing.** In CarPlay, on the lock screen and in Control Center you see:
  - Title: the chapter. Artist: the novel. Album: "TachiNovel".
  - The novel's cover, cached on the iPhone so it also shows offline.
  - The time in the chapter, its length, and the speed.
  - For chapters read live by Kokoro or the Apple voice, the length is estimated from the text and
    refined with every sentence spoken. It moves only in real steps, so it doesn't flicker.
  - Chapters with audio on the iPhone (downloaded, prepared) show their exact length.
- **Buttons.** Play/pause, plus one pair of side buttons. Choose which in More › Voices › In the car ›
  **Car buttons**:
  - *Chapters* (the default): ⏮ ⏭ go to the previous or next chapter. ⏮ goes back to the start of the
    chapter, or to the chapter before if you are in its first 5 seconds.
  - *15 seconds*: ↺15 ↻15 skip back or forward within the chapter. For live speech the skip lands on a
    sentence start.

  Headphone and steering-wheel next/previous buttons follow the same choice. Dragging the time bar jumps
  within the chapter, to the sentence for live speech. The car's speed control and Siri ("play faster")
  set the narration speed.
- **Siri.** "Pause", "resume", "next" and "skip back" work through the same commands.
- **Chapters flow on.** Each chapter continues into the next by itself, without a pause:
  - the next chapter's text is fetched while the current one plays;
  - Kokoro renders its first sentences before the current chapter ends.

  More › Developer › Voice Report shows the measured silence between chapters (`car.chapterGapsMs`).
- **Calls and directions.** Narration pauses for a call, Siri or a spoken navigation prompt and then
  continues by itself. Downloaded and prepared audio pick up 2 seconds early. If you paused it yourself, it stays
  paused. Disconnecting from the car, Bluetooth or headphones pauses it until you press play.
- **Locked screen.** Everything keeps running with the iPhone locked and the app in the background:
  synthesis, playback, the chapter changes and progress saving. (This uses the audio background mode and
  a `.playback`/`.spokenAudio` audio session, so TachiNovel is the Now Playing app. A background-time
  assertion covers the moment between chapters.)
- **Back in the app, you're where the listen is.** The listening position is your reading progress: it
  is saved every few seconds and as soon as a new chapter starts, so the library, History and Resume show
  the chapter you are listening to. When you open the app again with the reader on screen, it jumps to the
  sentence being read (opening the chapter narration went on to) and marks it briefly. While the screen is
  on, the reader follows the voice; scroll the page yourself and it stays where you put it, with a **Back
  to narration** pill to return.

## Download with audio

For a drive with patchy signal, or to save battery on the road, download chapters with their audio (2026-10-16;
`src/ui/native/audio-ui.tsx`, `audio-sheet.tsx`, `audio-status.ts`, `audio-live.ts`; v1's pages patched at build time by
`tools/v1-audio.ts`).

- **Where**: the novel's **Download with Audio** card (under Add to Library / Web View / Share), **Download…** in its
  ••• menu, or select chapters (long-press) and tap **Download**.
- **The sheet** (v1's bottom sheet, sized to its content with a grabber; drag down to close): which chapters (Next 5 ·
  Next 10 · Unread, from where you would go on reading; or the selected ones), **Include Narration Audio** with her
  packs ("Nephis · <narrator pack> + <dialogue pack>"), the audio's size (about 16 MB a chapter at 128 kbps) and how long
  it takes to make (from her measured speed), and **Make Audio**: Now · While Charging. The switch and the timing are
  remembered. The text downloads first (v1's queue), then the audio is queued. It refuses when the audio and 1 GB
  wouldn't fit; without her voice on the iPhone it offers Download Her Voice (the text still downloads).
- **Notification**: at the first audio download the app explains, then asks for permission once (a "no" is kept). When a
  download finishes, "12 chapters of <novel> are ready to listen offline" (with the app open: a toast instead).
- **Chapter rows**: headphones for text + audio, a small ring for the chapter being made, the download arrow for text
  only. Audio made with an older voice shows nothing: it never plays.
- **More › Downloads**: the **Queue** (cover, chapter, "Text ✓ · Audio 42 %", why it waits: "Waiting for charging",
  "Paused while you listen", "Paused: iPhone is hot"; a progress ring; ✕ asks while a chapter is half made; Retry after
  three tries; Pause All / Resume All) and **Narration Audio**: its size (→ each novel's audio, swipe left or Edit to
  delete; a novel opens its chapters), Delete Audio After Listening (off), Include Audio in Auto-Download (made only
  while charging, for the chapters v1's auto-download keeps: the core reports them, `src/core/auto-audio.ts`), Delete
  All Audio. More › Storage has a Narration Audio row; the novel's ••• menu has Remove Downloaded Audio.
- **Efficiency**: the screens listen to the plugin's `audio` event only while one of them shows (the novel page with
  its card, the sheet, Downloads, Narration Audio); native sends it only on a change, and progress events reuse the
  audio list for 30 s and the work folder's size for 10 s. Nothing polls, and none of it wakes the voice.
- **While making audio**: why it waits ("Waiting for charging", "Paused while you listen", "Resuming shortly after
  listening", "Waiting for the iPhone to cool down", "Waiting for the internet"). Live reading always comes first:
  rendering stops at the next call when Listen or the Voice Speed Test starts and goes on 30 s after they stop; serious
  heat pauses it until the iPhone has been at fair or below for two minutes. It continues while you listen to
  downloaded chapters, except in the last minute before such a chapter hands over to live reading.
- **"Prepare for the drive"** (older builds' card and sheet, replaced by the above): its engine stays (the bridge's
  prepareDrive…); audio it made still plays, is deleted after listening and shows in More › Voices › In the Car.
- **Playing**: chapters with audio (downloaded or prepared) are used first, wherever a chapter starts: the reader's Listen (from the
  tapped sentence), More › Listen, CarPlay, Siri, or the chapter change. They need neither synthesis nor the
  internet. The spoken sentence is still highlighted, from the real sentence cuts. About a minute before a
  prepared chapter ends whose next chapter has no audio, her model warms up and the next chapter's first
  two calls are rendered, so live reading starts without a cold start.
- **Storage**: with Nephis and her studio AAC-LC mono 44.1 kHz 128 kbps (about 0.96 MB a minute, ~58 MB an
  hour); Kokoro or her voice without the studio 24 kHz 32 kbps (~14 MB an hour). Files live in Application
  Support/NarrationAudio (one folder per novel), excluded from iCloud and device backups. Limits:
  - each prepared chapter is deleted after you listen to it to the end;
  - prepared chapters have a 600 MB cap, oldest first (audio downloads have none);
  - Remove clears one novel, and Remove all clears everything.
- **Voice**: only audio made with the voice that reads now plays (Kasta, 2026-10-15). Its key is her
  narrator and dialogue packs, her studio, the packs' chains and the delivery settings, the novel's
  pronunciation list and the renderer's version (Kokoro: its voice and narrator mode). Audio made with an
  older version is not played: Listen reads live, and the chapter is queued to render again while charging
  (the new file replaces the old one). Audio of another voice (Kokoro's while Nephis reads) is kept, not
  played.

## Audio downloads (the engine)

The queue renders chosen chapters into audio that stays until deleted ("Delete Audio After Listening",
off by default). Part 1 (build 373) is the engine and its bridge; part 2 the screens above.

- **One render pipeline** (Native/Voice/NephisRenderPipeline.swift, ExpressiveCore NephisCallPlan.swift): Listen,
  the Voice Speed Test and downloads build each call the same way (sentences per call, the director's text and
  heteronyms, raw text, temperature, pause before, handover, dialogue routing) and finish it the same way (her EQ
  for a call without her studio in a studio read, the read's rate, NaturalFinish's flow finish and its sentence
  cuts). A download's calls: her studio always with no time limit, one take (Developer › "Best of 2 Takes for
  Audio": two), the lead-in, background priority. No volume stage or limiter (volume stays a playback control).
- **Director first**: the chapter's brief, moods and senses are worked out before rendering (ChapterDirector,
  shared with Listen through DirectorStore) and stored in the manifest (`render.delivery`), so a chapter read live
  after its file (a fallback) keeps the same moods.
- **Resumable**: each call is a 16-bit PCM chunk in NarrationAudio/work/<chapter>/ with checkpoint.json. After an
  interruption it goes on from the last paragraph it finished, with a fresh read there. The end is one AAC encode
  pass and an atomic move of the file and its manifest into the novel's folder.
- **Bridge** (Narration plugin): `audioStatus`, `audioEnqueue` ({chapters, when: now | charging |
  chargingOrWifi}), `audioPause`, `audioResume`, `audioCancel`, `audioDelete`, `audioEstimate` (minutes, MB,
  render minutes from her measured speed), `audioSetOptions` ({deleteAfterListening}), and an `audio` event.

## The CarPlay app (later)

A TachiNovel icon on the CarPlay home screen needs Apple's `com.apple.developer.carplay-audio`
entitlement, which Apple grants on request to audio apps. The free sideloaded build can't have it.

The template code is already in the app (`Native/CarPlay/CarPlaySceneDelegate.swift`): a "Continue
listening" list from the reading history, each row resuming at its saved paragraph, plus the shared Now
Playing template. It is switched off by the `TNCarPlayTemplates` flag. To switch it on once Apple grants
the entitlement:

1. Add `com.apple.developer.carplay-audio` to `ios/App/App/App.entitlements` (see
   `App.full.entitlements.example`) and to the App ID.
2. Build with `TN_CARPLAY_TEMPLATES=YES` (an xcodebuild setting, or the target's build settings). Info.plist
   passes it to the app, and `AppDelegate` then vends the CarPlay scene.

Without the flag the app never offers a CarPlay scene. Everything above keeps working through Now Playing
either way.

## How it fits together

| Piece | Where |
|---|---|
| Command mapping (Car buttons, previous = restart or chapter before, ±15 s, scrubbing, speed) | `ios/App/HDVoice/Sources/HDVoiceCore/CarAudio.swift` (`RemoteCommandMap`) |
| Chapter clock for live speech (estimate, refined per sentence) and the flicker-free Now Playing time | same file: `ChapterTimeline`, `NowPlayingSmoother`, `NowPlayingMetadata` |
| MediaPlayer glue: Now Playing, artwork cache, remote command targets | `ios/App/App/Native/Narration/CarAudio.swift` |
| Requests (walk or chapter list), drive policy | `HDVoiceCore/DrivePrep.swift` |
| Voice key and stale rule, index (schema 2) and its migration, checkpoint, when rendering may run, estimates | `HDVoiceCore/NarrationAudio.swift` |
| The queue, background tasks, status | `ios/App/App/Native/Narration/DrivePrep.swift` |
| Files, voice key now, freshness | `ios/App/App/Native/Narration/NarrationAudioStore.swift` |
| One chapter into a file (Nephis resumable, Kokoro) | `ios/App/App/Native/Narration/ChapterAudioRenderer.swift` |
| Her one render pipeline, the shared director | `ios/App/App/Native/Voice/NephisRenderPipeline.swift`, `ExpressiveCore/NephisCallPlan.swift` |
| Timestamp manifest (v1's narration manifest format, plus previous chapter and reader paragraph) | `HDVoiceCore/NarrationManifest.swift` |
| Playback order (the chapter's audio in the voice that reads now → speech), prefetch, chapter changes, interruptions | `ios/App/App/Native/Narration/NarrationController.swift` |
| Download with Audio: the novel card, sheet, badges, queue, Narration Audio; v1 page patches | `src/ui/native/audio-ui.tsx`, `audio-sheet.tsx`, `audio-status.ts`, `audio-live.ts`, `tools/v1-audio.ts` |
| The "audio is ready" notification; auto-download's audio | `ios/App/App/Native/Narration/AudioReadyNotice.swift`, `DrivePrep.register`, `src/core/auto-audio.ts` |
| Settings › Voices › In the car, Help | `src/ui/native/drive-status.ts`, `voices-ui.ts`, `help-car.ts` |

## Tests

- **Unit, CI host** (`swift test`, job `voice-quality`):
  - `CarAudioTests`: command mapping for both button settings, previous-chapter rules, skips and
    scrubbing, the chapter clock (estimate, refinement, seeking), the smoother (no jumps under the
    tolerance, real changes shown, pause freezes, rate scaling), metadata for every source, and older
    settings decoding.
  - `DrivePrepTests`: policy, index, eviction, cap, job walk and manifest round trip.
  - `NarrationAudioTests`: voice keys and the stale rule, the index (kinds, cap on drive audio only) and its
    migration, list requests and re-renders, the checkpoint's resume and real-cut times, when rendering may run
    (live, 30 s after, heat, charging, network), estimates, the manifest's render record.
  - `NephisCallPlanTests` (ExpressiveVoice): the speed test's calls are exactly Listen's for the same passage, and
    what it asked before the shared plan; grouping, the line, dialogue hints, the budget, a download's call.
- **Unit, PC** (`tests/car.test.ts`): the card and sheet wording, size and length formatting, the Help
  answers, and the Info.plist and plugin wiring.
- **Simulator** (job `voice-simulator`, `src/ui/native/voice-selftest-car.ts`): a synthetic three-chapter
  novel driven by remote commands through the handler MPRemoteCommandCenter calls. iOS can't inject real
  command events. It checks:
  - Now Playing fields and both Car-buttons settings;
  - ⏭ and ⏮, play/pause, +15 s and scrubbing;
  - the chapter change by itself, and its silence;
  - preparing a chapter, and the chapter change into its audio.

  The prepared chapter finishing and being deleted depends on the simulator's audio output, so it is
  reported as a warning, not a failure.

### On the phone (10 minutes, in the car or with Bluetooth)

1. Start a chapter, lock the iPhone, connect to CarPlay. Now Playing should show chapter, novel,
   "TachiNovel", the cover and a moving time.
2. Press ⏭ on the steering wheel: the next chapter. Press ⏮ twice: the start of the chapter, then the one
   before.
3. More › Voices › In the car › Car buttons › 15 seconds. CarPlay now shows ↺15 ↻15, and the wheel
   buttons skip.
4. "Hey Siri, pause", then "Hey Siri, resume".
5. Start navigation with spoken directions: narration pauses for each prompt and continues.
6. Let a chapter end with the phone locked: the next one starts within a second.
7. On a novel: Download with Audio › Next 5 › Now › Download. Watch the card and More › Downloads › Queue, then
   turn on airplane mode and listen: the downloaded chapters play (headphones on their rows) and stay until you
   delete them (More › Downloads › Narration Audio).
8. More › Developer › Now Playing (Developer options: About › tap the version 7 times), and Voice Report's `car` section: commands, chapter gaps.
