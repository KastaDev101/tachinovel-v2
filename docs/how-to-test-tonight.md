# How to test tonight (free sideload)

This is the quickest way to get v2 onto the iPhone without an Apple Developer account: an **unsigned IPA from
GitHub Actions**, re-signed on the phone with a free Apple ID by AltStore (or SideStore). The app runs for
7 days per signature; then you refresh it (no data is lost).

## 1. Setup (tonight starts at step 1)

Already done on the PC: **iTunes from apple.com**, **AltServer**, and the iPhone has been seen over USB.
**iCloud stays as it is**: the PC's iCloud is the Microsoft Store version, and it is what syncs the
Scriptable folder (v1 deploys through it). Don't uninstall or reinstall it.

| # | Where | Do |
|---|---|---|
| 1 | PC | Start menu → type "AltServer" → **Run as administrator** (allow private networks if asked); it sits in the tray |
| 2 | iPhone | Connect by USB, unlock, tap Trust if asked |
| 3 | PC → iPhone | AltServer tray icon → **Install AltStore** → your iPhone → sign in with your Apple ID (AltServer sends it only to Apple) |
| 4 | iPhone | Settings › General › VPN & Device Management → trust your Apple ID. Then Settings › Privacy & Security › **Developer Mode** → on (the phone restarts; confirm "Turn On") |

**If AltServer reports an iCloud error** (for example "iCloud is not installed" or anything about
AppleiCloudServices/anisette): **stop and ask** before changing anything. AltStore's FAQ has a workaround
for the Microsoft Store iCloud (https://faq.altstore.io/altstore-classic/troubleshooting-guide), but it
temporarily swaps iCloud installations, which could disturb the Scriptable folder sync.

Free Apple ID limits: 3 sideloaded apps at once (AltStore counts as one), 10 new app IDs per 7 days, and
apps stop opening after 7 days until AltStore refreshes them. AltStore refreshes in the background when the
PC with AltServer is on the same Wi-Fi (in iTunes, turn on "Sync with this iPhone over Wi-Fi" for that);
you can also open AltStore › My Apps › Refresh All.

SideStore (https://sidestore.io) is an alternative that refreshes without the PC after setup. Setup is
longer (pairing file + a VPN app), so AltStore is the faster choice for tonight.

## 2. Get the IPA

**Option A (easiest):** a ready `.ipa` is waiting in **iCloud Drive › TachiNovel-Builds**. Nothing to
download: pick it from Files in the install step below.

**Option B (any newer build):**
1. Open https://github.com/KastaDev101/tachinovel-v2/actions/workflows/ios.yml and pick the newest green
   run on `main` (you must be signed in to GitHub to download artifacts, even on a public repo).
2. Under **Artifacts**, download **`TachiNovel-<version>-<run>-unsigned.ipa`** (about 1.5 MB; the browser
   downloads the `.ipa` itself, not a zip). Use the browser: `gh run download` unpacks it into a
   `Payload/` folder (zip it back as `Payload/…` → `.ipa` if you go that way).
3. Put it where the phone can see it: iCloud Drive (iCloud for Windows syncs it), or download it on the
   phone in Safari while signed in to GitHub.

Install: AltStore › **My Apps** › **+** (top left) → pick the `.ipa` in Files. The first install takes
~30 s. The app appears on the home screen as "TachiNovel".

**Updates from AltStore (once):** AltStore › **Sources** › **+** → paste
`https://github.com/KastaDev101/tachinovel-v2/releases/download/altstore-source/apps.json` → Add.
Every release (each `v*` tag) rewrites that file, so new builds show up in AltStore as **Update** on
TachiNovel; tap it. AltStore installs through AltServer on the PC:

- **With the USB cable** (AltServer running): works now.
- **Over Wi-Fi**: AltServer finds the phone with Apple's **Bonjour** service, which isn't installed on
  this PC yet (it comes with iTunes from apple.com, or as "Bonjour Print Services for Windows"). Until
  then, plug the phone in to update, or use AltServer's tray menu › **Sideload .ipa** with a downloaded
  IPA (hold Shift while clicking "Install AltStore" if that item isn't shown).

The source only lists releases, not every CI build; option B above still works for in-between builds.

The IPA is the **sideload variant**: it has no entitlements a free account can't sign (iCloud, CarPlay,
push, App Groups, Associated Domains). What that means while you test:

- Data lives on the phone, not in iCloud: library, progress, settings, backups and logs are in the Files
  app under **On My iPhone › TachiNovel** (copy a backup or the `logs` folder from there). Bring your v1
  library over with a backup (section 3, step 2).
- CarPlay's own app screen doesn't appear, but audio still plays through the car (Bluetooth or CarPlay
  audio) with Now Playing and the steering-wheel buttons.
- Background audio, the lock screen player and local notifications all work.

## 3. Ten-minute checklist

Listening uses the **Apple voices** on `main` for now. The bundled Kokoro voices are in the PR
"On-device HD voices (Kokoro) with Apple fallback": its `ios-ipa` artifact has them (about 90–100 MB), and
docs/voices.md has a 5-minute voice checklist. Once it merges, the same Listen button uses Kokoro, with the
Apple voices as the fallback.

| # | Do | Expect |
|---|---|---|
| 1 | Open the app | Dark launch screen with the book icon (white in light mode), then the onboarding; **Skip** |
| 2 | More › **Backup & Restore** › **Restore from Files…** → iCloud Drive › Scriptable › TachiNovel › backups → newest `.json` | The Restore Backup sheet shows what it holds; restore → your library, progress and settings from v1 |
| 3 | Library → open a novel → Resume | Reader opens at your v1 position; scrolling flows into the next chapter |
| 4 | Browse → Stonescape → Popular → a novel | Covers load, chapter list appears, locked chapters show a lock |
| 5 | In the reader, tap the middle of the page for the bars, then **Listen** (bottom bar, next to Appearance) | Kokoro reads from the first visible paragraph (the mini player says "Kokoro · Heart"; for the first seconds after installing it may say "System voice (fallback) · Kokoro is starting"); the sentence is highlighted and followed; tapping the page hides the bars and the mini player together |
| 6 | Lock the phone | Lock-screen player with title and cover; play/pause and next chapter work; audio keeps going |
| 7 | Let a chapter end (or skip to its last paragraphs) | It continues into the next chapter by itself |
| 8 | Pause, swipe the app away, reopen the novel | The reader opens where listening stopped |
| 9 | More › **Listen in the Car** › **Open the player** › Continue reading aloud › the novel | Listening resumes at that paragraph; with the Apple voice the ↺15/15↻ buttons step a paragraph back/forward; the speed buttons work |
| 10 | Bluetooth or the car | Steering-wheel next/previous and play/pause work; after a call or Siri it resumes only if it was playing |

**In the car** (with the car-audio PR): docs/car.md has a 10-minute car checklist. In short, CarPlay's
Now Playing shows chapter, novel, cover and time; More › Voices › In the car › Car buttons switches the
side buttons between chapters and 15 seconds; and a novel's **Prepare for the drive** makes the next
chapters play offline.

If something fails: More › About › Diagnostics › **Copy Full Diagnostics**, and paste it to Claude. The
full log is also in Files › On My iPhone › TachiNovel › logs. A screenshot helps for anything visual.

### Optional (advanced): PC-narrated audio files

Parked for now (the PC narrator is sidelined). The player can still play chapters the PC narrator wrote to
iCloud Drive › **TachiNovel Audio** (`<Novel>/manifest.json` + `NNNN - title.m4a` + `.json` timestamps):
More › Listen in the Car › Open the player › **Link “TachiNovel Audio” folder** → pick that folder (with
the Kokoro PR: first turn on More › Voices › Advanced › **Use PC audio when available**; the folder link
appears there). Those
chapters then play the file (subtitle "Narrated audio") with the spoken sentence highlighted in the
reader; chapters without a file, or files that can't be read, use the Apple voice. Skip this tonight
unless you already have narrated files.

## 4. Known limits of this build

- Signed for 7 days per refresh; refresh via AltStore before it expires (or reinstall the newer IPA from a
  newer run: data stays as long as the bundle id is the same).
- No iCloud sync between v1 (Scriptable) and v2: they are separate apps; move data with backups.
- Store purchases (Pro) don't load outside the App Store; everything stays in the free tier.
- Listening needs the chapter text: network, the read-ahead cache or a downloaded chapter. For a drive
  without signal, use the novel's **Prepare for the drive** (car-audio PR), or download the next chapters
  first (novel page › download).
- No TachiNovel icon on the CarPlay screen (that needs Apple's CarPlay audio entitlement); it plays
  through CarPlay's Now Playing screen instead (docs/car.md).
