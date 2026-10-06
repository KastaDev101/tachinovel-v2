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
  xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep -qF "$BUNDLE"
}

collect_crashes() {
  # Simulator app crash reports land in the HOST's DiagnosticReports.
  find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 \( -name "App-*.ips" -o -name "App_*.ips" -o -name "App-*.crash" \) -newer "$APP/Info.plist"     -exec cp {} "$OUT/" \; 2>/dev/null || true
}

shot() {
  local name="$1" wait="$2"
  shift 2
  echo "--- $name $*"
  xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE" "$@"
  sleep "$wait"
  xcrun simctl io "$UDID" screenshot "$OUT/$name.png"
  if ! running; then
    echo "::error::App is not running after '$name' (crashed?)"
    collect_crashes
    return 1
  fi
}

status=0
# Fresh install: the first WebView launch on a just-booted simulator is slow.
shot 1-first-launch $((WAIT + 18)) || status=1        # v1 onboarding over the library
shot 2-library "$WAIT" -tachiSmokeTab library || status=1
shot 3-browse "$WAIT" -tachiSmokeTab browse || status=1
shot 4-updates "$WAIT" -tachiSmokeTab updates || status=1
shot 5-history "$WAIT" -tachiSmokeTab history || status=1
shot 6-more "$WAIT" -tachiSmokeTab more || status=1
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
xcrun simctl shutdown "$UDID" || true
exit $status
