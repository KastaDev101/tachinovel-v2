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
# Stability: the app must still be alive a while after the last launch (launch tasks run ~5 s in).
sleep 10
if ! running; then echo "::error::App exited after the tour"; collect_crashes; status=1; fi

# App + core logs (os_log subsystem app.tachinovel) for debugging failures.
xcrun simctl spawn "$UDID" log show --last 10m --style compact \
  --predicate "subsystem == \"app.tachinovel\" OR process == \"App\"" > "$OUT/app-log.txt" 2>/dev/null || true
grep -E "core exception|startup failed|core boot failed|Fatal" "$OUT/app-log.txt" && echo "::warning::core errors in the log (see app-log.txt)" || true
if ! grep -q "recovery: the web view was restarted" "$OUT/app-log.txt"; then
  echo "::error::The UI did not restore its screen after the WebContent process was killed (see app-log.txt, 6b-webcontent-recovered.png)"
  status=1
fi

# Boot time per launch: tap (simctl launch) → process start → WebView → HTML → DOM → app.boot → library painted
# (boot-times.txt + a run notice).
kill "$BOOT_STREAM" 2>/dev/null || true
python3 - "$OUT/launches.txt" "$OUT/boot-log.txt" "$OUT/boot-times.txt" "$OUT/app-log.txt" <<'PY' || true
import re, statistics, sys
from datetime import datetime, timezone
# Boot time per launch (src/ui/native/boot-timing.ts logs one "boot: ..." line per launch). The "tap" is the
# moment the script ran `simctl launch` (includes simctl's own overhead, ~1-3 s on CI); process start is the
# app's first log line, so "process->library" is the app's own cold-start time.
launches = [(n, int(t)) for n, t in (l.split() for l in open(sys.argv[1]) if l.strip())]
TS = re.compile(r'^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+\S+\s+App\[(\d+):')
def naive_ms(stamp):
    # The log's wall-clock stamps are in the host's local zone; read them as UTC and correct by `offset`.
    return int(datetime.strptime(stamp, '%Y-%m-%d %H:%M:%S.%f').replace(tzinfo=timezone.utc).timestamp() * 1000)
start = {}
try:
    for line in open(sys.argv[4], errors='replace'):
        m = TS.match(line)
        if m and m.group(2) not in start:
            start[m.group(2)] = naive_ms(m.group(1))
except OSError:
    pass
def ms(label, line):
    m = re.search(label + r' \+(\d+)ms', line)
    return int(m.group(1)) if m else None
# Local-zone offset: each boot line has the log's local stamp and the core's own UTC stamp (ISO, "...Z").
offset = 0
for line in open(sys.argv[2], errors='replace'):
    m, iso = TS.match(line), re.search(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+)Z', line)
    if m and iso:
        utc = int(datetime.strptime(iso.group(1), '%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=timezone.utc).timestamp() * 1000)
        offset = round((utc - naive_ms(m.group(1))) / 900_000) * 900_000  # zones are whole quarter hours
        break
start = {pid: t + offset for pid, t in start.items()}
rows = {}
for line in open(sys.argv[2], errors='replace'):
    m = re.search(r'nav=(\d+) epoch=(\d+)', line)
    if not m:
        continue
    nav, vis = int(m.group(1)), int(m.group(2))
    before = [(n, t) for n, t in launches if t <= nav]
    if not before or before[-1][0] in rows:
        continue
    name, tap = before[-1]
    pid = re.search(r'App\[(\d+):', line)
    proc = start.get(pid.group(1)) if pid else None
    rows[name] = dict(tap=tap, proc=proc, nav=nav, vis=vis, html=ms('html', line), dom=ms('dom ready', line), boot=ms('app.boot call', line), lib=vis - nav)
def d(a, b):
    return '-' if a is None or b is None else str(b - a)
cols = ['launch', 'tap->process', 'process->WebView', 'WebView->HTML', 'HTML->DOM', 'DOM->app.boot', 'app.boot->library', 'process->library', 'tap->library']
with open(sys.argv[3], 'w') as f:
    f.write('  '.join(f'{c:>17}' if i else f'{c:22}' for i, c in enumerate(cols)) + '  (ms)\n')
    for name, _ in launches:
        r = rows.get(name)
        if not r:
            f.write(f'{name:22}  no boot line (library not painted within 20 s of the page starting?)\n')
            continue
        nav0 = 0
        vals = [d(r['tap'], r['proc']), d(r['proc'], r['nav']), d(nav0, r['html']), d(r['html'], r['dom']), d(r['dom'], r['boot']), d(r['boot'], r['lib']), d(r['proc'], r['vis']), d(r['tap'], r['vis'])]
        f.write(f'{name:22}' + ''.join(f'  {v:>17}' for v in vals) + '\n')
print(open(sys.argv[3]).read())
done = [rows[n] for n, _ in launches if n in rows]
own = [r['vis'] - r['proc'] for r in done if r['proc'] is not None]
if own:
    first = launches[0][0] if launches else ''
    fresh = rows.get(first)
    msg = f'process->library median {int(statistics.median(own))} ms, best {min(own)} ms (n={len(own)})'
    msg += f'; fresh install ({first}): ' + (f'tap->library {fresh["vis"] - fresh["tap"]} ms' if fresh else 'no boot line')
    print(f'::notice title=Boot time (simulator, cold launches)::{msg}')
else:
    print('::warning::No boot timing lines captured (see boot-log.txt)')
PY
xcrun simctl shutdown "$UDID" || true
exit $status
