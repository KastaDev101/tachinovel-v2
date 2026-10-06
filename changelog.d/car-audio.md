### Added

- In the car without a CarPlay app: CarPlay's Now Playing screen, the lock screen and Control Center show
  the chapter, the novel, "TachiNovel", the cover (cached for offline), the time in the chapter and its
  length for every voice. For live speech the length is estimated from the text and refined as sentences
  are spoken, without flicker.
- More › Voices › In the car › Car buttons: previous/next chapter (default) or back/forward 15 seconds,
  also for headphone and steering-wheel buttons. Scrubbing, speed and Siri ("pause", "resume", "next")
  work. With nothing loaded, play continues the novel listened to last.
- Prepare for the drive (on a novel's page): Kokoro renders the next 1, 3, 5 or 10 chapters into audio on
  the iPhone, now or while charging / on Wi-Fi (also as a background task). Prepared chapters play first,
  offline, with sentence highlighting, and are deleted after listening. Progress and storage are shown in
  the sheet and in More › Voices.
- Help › Listening: how to use it in the car (replaces the PC-narrator answers). docs/car.md.
- The simulator self-test drives remote commands and chapter changes and checks Now Playing and prepared
  audio. The Voice Lab shows Now Playing, the commands and the silence between chapters.

### Changed

- Chapters continue into the next without a pause: the next chapter's text is fetched ahead and Kokoro
  renders its first sentences before the current chapter ends.
- After a call or a navigation prompt, prepared and PC audio continue 2 seconds early.
- The CarPlay templates app is behind the `TNCarPlayTemplates` flag (`TN_CARPLAY_TEMPLATES=YES` once
  Apple grants the CarPlay audio entitlement).
- The Listen player shows a seek bar for live speech too (estimated length).
- Privacy manifest: declares the system boot time API (reason 35F9.1: time between events inside the
  app, for the Now Playing chapter clock and the silence between chapters).

### Fixed

- Continuing a different novel from CarPlay or the Listen player no longer shows the previous novel's
  cover in Now Playing.
