#!/usr/bin/env bash
# Simulator smoke test: boot an iPhone simulator, install the Debug simulator build, launch it a few
# times with -tachiSmokeTab/-tachiSmokeSource (src/ui/native/smoke.ts drives the UI there), screenshot
# each screen, and fail if the app is not running afterwards (crash on launch or while navigating).
#
# Usage: bash ci/ios-sim-smoke.sh <path/to/App.app> <out-dir>
set -euo pipefail

APP="${1:?path to App.app}"
OUT="${2:?output dir}"
WAIT="${SMOKE_WAIT:-12}"
mkdir -p "$OUT"
BUNDLE=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$APP/Info.plist")

# Newest iOS runtime, preferring a non-Plus/Max/mini iPhone (closest to the user's iPhone 16).
UDID=$(xcrun simctl list devices available -j | python3 -c '
import json, re, sys
devices = json.load(sys.stdin)["devices"]
best = None
for runtime, items in devices.items():
    m = re.search(r"iOS-(\d+)-(\d+)", runtime)
    if not m:
        continue
    version = (int(m.group(1)), int(m.group(2)))
    for d in items:
        name = d["name"]
        if not name.startswith("iPhone"):
            continue
        plain = 0 if re.search(r"Plus|Max|mini|SE|Air|e$", name) else 1
        key = (version, plain, name)
        if best is None or key > best[0]:
            best = (key, d["udid"])
print(best[1] if best else "")
')
[ -n "$UDID" ] || { echo "No iPhone simulator available"; xcrun simctl list devices available; exit 1; }
echo "Simulator: $(xcrun simctl list devices | grep "$UDID")"

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl ui "$UDID" appearance dark || true
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4 || true
xcrun simctl install "$UDID" "$APP"

running() {
  # The simulator's launchd lists the app as UIKitApplication:<bundle>[…]; any match counts.
  # Capture first: with pipefail, `launchctl list | grep -q` fails at random (grep exits on the first
  # match, launchctl gets SIGPIPE), which reported live apps as crashed.
  local list
  list=$(xcrun simctl spawn "$UDID" launchctl list 2>/dev/null || true)
  grep -qF "$BUNDLE" <<<"$list"
}

collect_crashes() {
  # Simulator app crash reports land in the HOST's DiagnosticReports.
  find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 \( -name "App-*.ips" -o -name "App_*.ips" -o -name "App-*.crash" \) -newer "$APP/Info.plist"     -exec cp {} "$OUT/" \; 2>/dev/null || true
}

now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

shot() {
  local name="$1" wait="$2"
  shift 2
  echo "--- $name $*"
  echo "$name $(now_ms)" >> "$OUT/launches.txt"   # "tap" time for the boot-time report
  xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE" "$@"
  sleep "$wait"
  xcrun simctl io "$UDID" screenshot "$OUT/$name.png"
  if ! running; then
    echo "::error::App is not running after '$name' (crashed?)"
    collect_crashes
    return 1
  fi
}

# Boot timing (src/ui/native/boot-timing.ts logs "boot: …" at info level, which `log show` may not keep):
# stream it live for the whole tour.
xcrun simctl spawn "$UDID" log stream --level info --style compact   --predicate 'subsystem == "app.tachinovel" AND eventMessage CONTAINS "boot: library visible"' > "$OUT/boot-log.txt" 2>/dev/null &
BOOT_STREAM=$!
sleep 2

status=0
# Fresh install: the first WebView launch on a just-booted simulator is slow.
shot 1-first-launch $((WAIT + 18)) || status=1        # v1 onboarding over the library
shot 2-library "$WAIT" -tachiSmokeTab library || status=1
shot 3-browse "$WAIT" -tachiSmokeTab browse || status=1
shot 4-updates "$WAIT" -tachiSmokeTab updates || status=1
shot 5-history "$WAIT" -tachiSmokeTab history || status=1
shot 6-more "$WAIT" -tachiSmokeTab more || status=1
# Web content recovery: Debug builds kill the web view's content process 6 s in, like iOS under memory
# pressure (WebContentRecovery.swift); the reloaded UI must restore its screen (src/ui/native/recovery.ts,
# checked in the log below) and the app must stay up.
shot 6b-webcontent-recovered $((WAIT + 12)) -tachiSmokeTab more -tachiSmokeKillWebContentAfter 6 || status=1
# Personal flavor only (built-in source): a live source list over the network.
if [ "${SMOKE_SOURCE:-}" != "" ]; then
  shot 7-source-"$SMOKE_SOURCE" $((WAIT + 8)) -tachiSmokeTab browse -tachiSmokeSource "$SMOKE_SOURCE" || status=1
fi
# Native surfaces (docs/qa.md): document picker (Restore from Files…, Link audio folder), share sheet,
# Listen with the system voice, mini player and car player controls, brightness and keep-awake. The web
# side (src/ui/native/smoke.ts) taps through them; SmokeResponder.swift cancels system sheets like a user.
native_tour() {
  echo "--- native tour"
  xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE" -tachiSmokeTour native
  local i
  for i in $(seq -w 1 24); do
    sleep 4
    xcrun simctl io "$UDID" screenshot "$OUT/9-native-$i.png" >/dev/null 2>&1 || true
    if ! running; then
      echo "::error::App is not running during the native tour (crashed?)"
      collect_crashes
      return 1
    fi
    if xcrun simctl spawn "$UDID" log show --last 2m --style compact --predicate 'subsystem == "app.tachinovel"' 2>/dev/null | grep -q "smoke: tour done"; then
      break
    fi
  done
  xcrun simctl spawn "$UDID" log show --last 4m --style compact --predicate 'subsystem == "app.tachinovel"' > "$OUT/native-tour-log.txt" 2>/dev/null || true
  grep -E "smoke:" "$OUT/native-tour-log.txt" | sed -E 's/^.*smoke: /  /' || true
  # Report, don't fail (yet): a hung tour shows up here; a crash already failed above.
  grep -q "smoke: tour done" "$OUT/native-tour-log.txt" || echo "::warning::The native tour did not finish (see native-tour-log.txt and the 9-native-*.png screenshots)"
  grep -q "smoke: skipped" "$OUT/native-tour-log.txt" && echo "::warning::Native tour steps were skipped (see native-tour-log.txt)"
  # Regression: the folder picker is swiped away (no delegate call); the popup queue must not stay stuck,
  # so the share sheet that follows must appear. (Needs the network for the novel step.)
  if grep -q "smoke: Share (share sheet)" "$OUT/native-tour-log.txt" && ! grep -q "native on screen: UIActivityViewController" "$OUT/native-tour-log.txt"; then
    echo "::error::The share sheet never appeared after a document picker was swiped away (native popup queue stuck)"
    return 1
  fi
  return 0
}
native_tour || status=1

# Stability: the app must still be alive a while after the last launch (launch tasks run ~5 s in).
sleep 10
if ! running; then echo "::error::App exited after the tour"; collect_crashes; status=1; fi
# Any crash report of this build (also one the app recovered from, e.g. a relaunch) fails the smoke test.
if find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 \( -name "App-*.ips" -o -name "App_*.ips" \) -newer "$APP/Info.plist" 2>/dev/null | grep -q .; then
  echo "::error::Crash reports from this build (copied to the screenshots artifact)"
  collect_crashes
  status=1
fi

# App + core logs (os_log subsystem app.tachinovel) for debugging failures.
xcrun simctl spawn "$UDID" log show --last 10m --style compact \
  --predicate "subsystem == \"app.tachinovel\" OR process == \"App\"" > "$OUT/app-log.txt" 2>/dev/null || true
grep -E "core exception|startup failed|core boot failed|Fatal" "$OUT/app-log.txt" && echo "::warning::core errors in the log (see app-log.txt)" || true
if ! grep -q "recovery: the web view was restarted" "$OUT/app-log.txt"; then
  echo "::error::The UI did not restore its screen after the WebContent process was killed (see app-log.txt, 6b-webcontent-recovered.png)"
  status=1
fi

# Boot time per launch: tap (simctl launch) → WebView start → library painted (boot-times.txt + a notice).
kill "$BOOT_STREAM" 2>/dev/null || true
python3 - "$OUT/launches.txt" "$OUT/boot-log.txt" "$OUT/boot-times.txt" <<'PY' || true
import re, statistics, sys
launches = [(n, int(t)) for n, t in (l.split() for l in open(sys.argv[1]) if l.strip())]
rows = []
for line in open(sys.argv[2], errors='replace'):
    m = re.search(r'nav=(\d+) epoch=(\d+)', line)
    if not m:
        continue
    nav, vis = int(m.group(1)), int(m.group(2))
    before = [(n, t) for n, t in launches if t <= nav]
    if before:
        name, tap = before[-1]
        rows.append((name, nav - tap, vis - nav, vis - tap))
seen, uniq = set(), []
for r in rows:  # one line per launch
    if r[0] not in seen:
        seen.add(r[0]); uniq.append(r)
with open(sys.argv[3], 'w') as f:
    f.write('launch                 tap->WebView  WebView->library  tap->library (ms)\n')
    for name, a, b, c in uniq:
        f.write(f'{name:22} {a:11} {b:16} {c:12}\n')
print(open(sys.argv[3]).read())
if uniq:
    later = [r[3] for r in uniq[1:]]
    msg = f'first launch (fresh install) {uniq[0][3]} ms'
    if later:
        msg += f'; later cold launches median {int(statistics.median(later))} ms (n={len(later)})'
    print(f'::notice title=Boot time (tap -> library painted, simulator)::{msg}')
else:
    print('::warning::No boot timing lines captured (see boot-log.txt)')
PY
xcrun simctl shutdown "$UDID" || true
exit $status
