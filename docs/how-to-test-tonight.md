# How to test tonight (free sideload)

This is the quickest way to get v2 onto the iPhone without an Apple Developer account: an **unsigned IPA from
GitHub Actions**, re-signed on the phone with a free Apple ID by AltStore (or SideStore). The app runs for
7 days per signature; then you refresh it (no data is lost).

## 1. What to install (once, about 20 minutes)

| Where | What |
|---|---|
| Windows PC | **iTunes and iCloud downloaded from apple.com**, not the Microsoft Store versions (AltServer needs Apple's versions; https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows) |
| Windows PC | **AltServer** from https://altstore.io. Run it as administrator; it sits in the tray |
| iPhone | Connect it by USB, unlock it, tap Trust; in iTunes, turn on "Sync with this iPhone over Wi-Fi" |
| PC → iPhone | AltServer tray icon → **Install AltStore** → your iPhone → sign in with your Apple ID (AltServer sends it only to Apple) |
| iPhone | Settings › General › VPN & Device Management → trust your Apple ID. Then Settings › Privacy & Security › **Developer Mode** → on (the phone restarts) |

Free Apple ID limits: 3 sideloaded apps at once (AltStore counts as one), 10 new app IDs per 7 days, and
apps stop opening after 7 days until AltStore refreshes them. AltStore refreshes in the background when the
PC with AltServer is on the same Wi-Fi; you can also open AltStore › My Apps › Refresh All.

SideStore (https://sidestore.io) is an alternative that refreshes without the PC after setup. Setup is
longer (pairing file + a VPN app), so AltStore is the faster choice for tonight.

## 2. Get the IPA

1. Open https://github.com/KastaDev101/tachinovel-v2/actions/workflows/ios.yml and pick the newest green
   run on `main` (you must be signed in to GitHub to download artifacts, even on a public repo).
2. Under **Artifacts**, download **`TachiNovel-2.0.0-<run>-unsigned.ipa`** (about 1.5 MB; it downloads
   as the `.ipa` itself, not a zip). From the PC you can also run
   `gh run download <run-id> -R KastaDev101/tachinovel-v2 -p "TachiNovel-*"`.
3. Put it where the phone can see it: the simplest is iCloud Drive (iCloud for Windows syncs it), or
   download it on the phone in Safari while signed in to GitHub.

Install: AltStore › **My Apps** › **+** (top left) → pick the `.ipa` in Files. The first install takes
~30 s. The app appears on the home screen as "TachiNovel".

The IPA is the **sideload variant**: it has no entitlements a free account can't sign (iCloud, CarPlay,
push, App Groups, Associated Domains). What that means while you test:

- Data lives in the app's own local storage, not in iCloud. Bring your v1 library over with a backup (step 3).
- CarPlay's own app screen doesn't appear, but audio still plays through the car (Bluetooth or CarPlay
  audio) with Now Playing and the steering-wheel buttons.
- Background audio, the lock screen player and local notifications all work.

## 3. Ten-minute checklist

| # | Do | Expect |
|---|---|---|
| 1 | Open the app | Dark launch screen with the book icon (white in light mode), then the onboarding; **Skip** |
| 2 | More › **Backup & Restore** › **Restore from Files…** → iCloud Drive › Scriptable › TachiNovel › backups → newest `.json` | The Restore Backup sheet shows what it holds; restore → your library, progress and settings from v1 |
| 3 | Library → open a novel → Resume | Reader opens at your v1 position; scrolling flows into the next chapter |
| 4 | Browse → Stonescape → Popular → a novel | Covers load, chapter list appears, locked chapters show a lock |
| 5 | In the reader, tap **Listen** (round button, bottom right) | System voice reads from the first visible paragraph; the paragraph is highlighted; a mini player appears |
| 6 | Lock the phone | Lock-screen player with title and cover; play/pause and skip work; audio keeps going |
| 7 | More › **Listen in the Car** › **Open the player** › **Link “TachiNovel Audio” folder** → iCloud Drive › TachiNovel Audio › Open | The narrated novels from the PC narrator are listed |
| 8 | Tap a narrated chapter | The m4a plays (subtitle "Narrated audio"); in the reader the spoken sentence is highlighted; ±15 s, scrubbing and speed work; at the end it continues with the next chapter |
| 9 | Stop, close the app (swipe it away), reopen, More › Listen in the Car › Open the player | The novel resumes where you stopped |
| 10 | Bluetooth or the car | Steering-wheel next/previous and play/pause work; Siri announcements don't stop it for good (it resumes only if it was playing) |

If something fails: More › About › Diagnostics › **Copy Full Diagnostics**, and paste it to Claude. A screenshot
helps for anything visual.

## 4. Known limits of this build

- Signed for 7 days per refresh; refresh via AltStore before it expires (or reinstall the newer IPA from a
  newer run: data stays as long as the bundle id is the same).
- No iCloud sync between v1 (Scriptable) and v2: they are separate apps; move data with backups.
- Store purchases (Pro) don't load outside the App Store; everything stays in the free tier.
- A narrated chapter that iCloud has evicted from the phone is downloaded first (a few seconds of
  "Loading…"). If the file can't be read (no network, broken file), the same chapter continues with the
  system voice, which needs the chapter text (network, read-ahead cache or a downloaded chapter). For a
  drive without signal, open the audio folder in Files beforehand and choose "Keep Downloaded".
