#!/usr/bin/env bash
# Voice self-test in the iOS Simulator (CI job "voice-simulator"): launch the Debug simulator build with
# -tachiVoiceSelfTest 1. src/ui/native/voice-selftest.ts plays a synthetic chapter through the real Listen
# path (speech script → native HybridSpeechEngine → Kokoro from the bundled model, Apple fallback,
# headless output → progress events → sentence highlight), forces the fallback with an injected slow and
# failing Kokoro, and writes Documents/voice-selftest.json; ci/check-voice-selftest.ts asserts on it.
#
# Usage: bash ci/ios-voice-selftest.sh <path/to/App.app> <out-dir>
set -euo pipefail

APP="${1:?path to App.app}"
OUT="${2:?output dir}"
LIMIT="${VOICE_SELFTEST_TIMEOUT:-1500}"
mkdir -p "$OUT"
BUNDLE=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$APP/Info.plist")

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
[ -n "$UDID" ] || { echo "No iPhone simulator available"; exit 1; }
echo "Simulator: $(xcrun simctl list devices | grep "$UDID")"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$APP"

running() {
  local list
  list=$(xcrun simctl spawn "$UDID" launchctl list 2>/dev/null || true)
  grep -qF "$BUNDLE" <<<"$list"
}

DATA=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)
REPORT="$DATA/Documents/voice-selftest.json"
rm -f "$REPORT"
xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE" -tachiVoiceSelfTest 1 -tachiSmokeTab library
start=$(date +%s)
status=0
while [ ! -f "$REPORT" ]; do
  sleep 10
  elapsed=$(( $(date +%s) - start ))
  if ! running; then echo "::error::App is not running during the voice self-test (crashed?)"; status=1; break; fi
  if [ "$elapsed" -gt "$LIMIT" ]; then echo "::error::voice self-test timed out after ${elapsed}s"; status=1; break; fi
  echo "… ${elapsed}s"
done
xcrun simctl io "$UDID" screenshot "$OUT/voice-selftest.png" || true
xcrun simctl spawn "$UDID" log show --last 30m --style compact \
  --predicate "subsystem == \"app.tachinovel\" OR process == \"App\"" > "$OUT/app-log.txt" 2>/dev/null || true
find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 \( -name "App-*.ips" -o -name "App_*.ips" \) -newer "$APP/Info.plist" -exec cp {} "$OUT/" \; 2>/dev/null || true
if [ -f "$REPORT" ]; then
  cp "$REPORT" "$OUT/voice-selftest.json"
  node ci/check-voice-selftest.ts "$OUT/voice-selftest.json" || status=1
fi
xcrun simctl shutdown "$UDID" || true
exit $status
