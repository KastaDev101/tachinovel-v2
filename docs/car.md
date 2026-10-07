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
  - Prepared chapters and PC audio show their exact length.
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

  The Voice Lab shows the measured silence between chapters ("chapter gaps").
- **Calls and directions.** Narration pauses for a call, Siri or a spoken navigation prompt and then
  continues by itself. Prepared and PC audio pick up 2 seconds early. If you paused it yourself, it stays
  paused. Disconnecting from the car, Bluetooth or headphones pauses it until you press play.
- **Locked screen.** Everything keeps running with the iPhone locked and the app in the background:
  synthesis, playback, the chapter changes and progress saving. (This uses the audio background mode and
  a `.playback`/`.spokenAudio` audio session, so TachiNovel is the Now Playing app. A background-time
  assertion covers the moment between chapters.)

## Prepare for the drive

For a drive with patchy signal, or to save battery on the road, open the novel and tap **Prepare for the
drive** (under Add to Library / Web View / Share).

- **How many**: 1, 3, 5 or 10 chapters, starting where you would continue listening (the chapter you are
  in, from its start, so resuming mid-chapter still works).
- **When**:
  - **Prepare now**: right away, on any network.
  - **When charging or on Wi-Fi**: waits until one of them is true. On battery with Low Power Mode on it
    waits too. While the app is closed, iOS runs the work as a background processing task, usually
    overnight on the charger.
- **While preparing**: the card and the sheet show the chapter being prepared, the progress, or why it
  waits ("Waiting for charging or Wi-Fi", "Paused while Kokoro reads aloud", "Waiting for the iPhone to
  cool down"). Live narration always comes first: preparing pauses while Kokoro reads aloud, and continues
  while you listen to already-prepared chapters.
- **Playing**: prepared chapters are used first, wherever a chapter starts: the reader, More › Listen,
  CarPlay, Siri, or the chapter change. They need neither synthesis nor the internet. The spoken sentence
  is still highlighted.
- **Storage**: AAC, mono, 24 kHz, 32 kbps, about 14 MB per hour (a typical 20-minute chapter is about
  5 MB). The sheet and More › Voices › In the car show what is on the iPhone. Limits:
  - each chapter is deleted after you listen to it to the end;
  - there is a 600 MB cap, oldest first;
  - Remove clears one novel, and Remove all clears everything;
  - the files are excluded from iCloud and device backups.
- **Voice**: the novel's Kokoro voice at the time of preparing. If you change the voice, the prepared
  chapters are no longer used (prepare again). The same goes for words added to the pronunciation list
  afterwards.

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
| Prepare-for-the-drive policy, index, requests | `HDVoiceCore/DrivePrep.swift` |
| Rendering, files, background tasks | `ios/App/App/Native/Narration/DrivePrep.swift` |
| Timestamp manifest (same format as PC audio, plus previous chapter and reader paragraph) | `HDVoiceCore/NarrationManifest.swift` |
| Playback order (prepared → PC audio if enabled → speech), prefetch, chapter changes, interruptions | `ios/App/App/Native/Narration/NarrationController.swift` |
| Novel page card and sheet, Settings › Voices › In the car, Help | `src/ui/native/drive-ui.ts`, `drive-status.ts`, `voices-ui.ts`, `help-car.ts` |

## Tests

- **Unit, CI host** (`swift test`, job `voice-quality`):
  - `CarAudioTests`: command mapping for both button settings, previous-chapter rules, skips and
    scrubbing, the chapter clock (estimate, refinement, seeking), the smoother (no jumps under the
    tolerance, real changes shown, pause freezes, rate scaling), metadata for every source, and older
    settings decoding.
  - `DrivePrepTests`: policy, index, eviction, cap, job walk and manifest round trip.
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
7. On a novel: Prepare for the drive › 3 › Prepare now. Watch the progress, then turn on airplane mode
   and listen: the prepared chapters play, and each is deleted afterwards (More › Voices › In the car ›
   Prepared audio).
8. Voice Lab (About › tap the version 5 times) › the car section: Now Playing, commands, chapter gaps.
