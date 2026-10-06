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
  xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep -q "UIKitApplication:$BUNDLE"
}

shot() {
  local name="$1"
  shift
  echo "--- $name $*"
  xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE" "$@"
  sleep "$WAIT"
  xcrun simctl io "$UDID" screenshot "$OUT/$name.png"
  if ! running; then
    echo "::error::App is not running after '$name' (crashed?)"
    return 1
  fi
}

status=0
shot 1-first-launch || status=1                       # fresh install: v1 onboarding over the library
shot 2-library -tachiSmokeTab library || status=1
shot 3-browse -tachiSmokeTab browse || status=1
shot 4-updates -tachiSmokeTab updates || status=1
shot 5-history -tachiSmokeTab history || status=1
shot 6-more -tachiSmokeTab more || status=1
# Personal flavor only (built-in source): a live source list over the network. Informational.
if [ "${SMOKE_SOURCE:-}" != "" ]; then
  SMOKE_WAIT_SAVED="$WAIT"; WAIT=$((WAIT + 8))
  shot 7-source-"$SMOKE_SOURCE" -tachiSmokeTab browse -tachiSmokeSource "$SMOKE_SOURCE" || status=1
  WAIT="$SMOKE_WAIT_SAVED"
fi

# App + core logs (os_log subsystem app.tachinovel) for debugging failures.
xcrun simctl spawn "$UDID" log show --last 10m --style compact \
  --predicate "subsystem == \"app.tachinovel\" OR process == \"App\"" > "$OUT/app-log.txt" 2>/dev/null || true
grep -E "core exception|startup failed|core boot failed|Fatal" "$OUT/app-log.txt" && echo "::warning::core errors in the log (see app-log.txt)" || true
xcrun simctl shutdown "$UDID" || true
exit $status
