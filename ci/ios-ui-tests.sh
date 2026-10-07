#!/usr/bin/env bash
# Simulator UI tests (ios/App/AppUITests, XCUITest): builds the app and the test bundle, serves the
# synthetic demo site as https://novels.example.test/ on this machine, runs the AppUITests scheme on the
# newest iPhone simulator and exports the screenshots.
#
#   - The site name points at 127.0.0.1 (/etc/hosts; the Simulator resolves through the host).
#   - TLS: a throwaway CA made here, trusted only by this simulator (simctl keychain add-root-cert),
#     so the app's real HTTPS and App Transport Security paths run unchanged.
#   - The sample backup (tools/ui-fixtures.ts backup, synthetic) reaches the test runner through
#     TEST_RUNNER_TACHI_UITEST_BACKUP; the test hands it to the app (Debug-only hook in CoreHost).
#
# Usage: bash ci/ios-ui-tests.sh <out-dir>   (expects www/ built and `npx cap sync ios` done)
set -euo pipefail

OUT="$(mkdir -p "${1:?output dir}" && cd "$1" && pwd)"
SITE_HOST=novels.example.test
TLS="$OUT/tls"
mkdir -p "$TLS" "$OUT/screenshots"

# --- Simulator (same choice as the smoke test: newest iOS, a plain iPhone) ---
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
xcrun simctl ui "$UDID" appearance dark || true

# --- Fixture site over HTTPS ---
cat > "$TLS/site.ext" <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:$SITE_HOST
EXT
cat > "$TLS/ca.ext" <<EXT
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
EXT
openssl req -new -newkey rsa:2048 -nodes -subj "/CN=TachiNovel UI test CA (throwaway)" -keyout "$TLS/ca.key" -out "$TLS/ca.csr" 2>/dev/null
openssl x509 -req -in "$TLS/ca.csr" -signkey "$TLS/ca.key" -days 2 -sha256 -extfile "$TLS/ca.ext" -out "$TLS/ca.pem" 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$SITE_HOST" -keyout "$TLS/site.key" -out "$TLS/site.csr" 2>/dev/null
openssl x509 -req -in "$TLS/site.csr" -CA "$TLS/ca.pem" -CAkey "$TLS/ca.key" -CAcreateserial -days 2 -sha256 -extfile "$TLS/site.ext" -out "$TLS/site.pem" 2>/dev/null
xcrun simctl keychain "$UDID" add-root-cert "$TLS/ca.pem"
grep -q " $SITE_HOST\$" /etc/hosts || echo "127.0.0.1 $SITE_HOST" | sudo tee -a /etc/hosts > /dev/null
site_up() {
  for _ in $(seq 1 50); do
    curl -fsS --cacert "$TLS/ca.pem" "https://$SITE_HOST/spec.json" > /dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}
SERVE=(node tools/ui-fixtures.ts serve 443 --cert="$TLS/site.pem" --key="$TLS/site.key")
"${SERVE[@]}" > "$OUT/fixture-site.log" 2>&1 &
SERVER=$!
if ! site_up; then
  # Port 443 normally needs no root on macOS; fall back to sudo if this runner disagrees.
  kill $SERVER 2>/dev/null || true
  sudo env "PATH=$PATH" "${SERVE[@]}" > "$OUT/fixture-site.log" 2>&1 &
  SERVER=$!
  site_up || { cat "$OUT/fixture-site.log"; echo "fixture site did not start"; exit 1; }
fi
trap 'kill $SERVER 2>/dev/null || sudo kill $SERVER 2>/dev/null || true' EXIT

# --- Sample backup (synthetic) ---
node tools/ui-fixtures.ts backup www "$OUT/sample-backup.json"
export TEST_RUNNER_TACHI_UITEST_BACKUP
TEST_RUNNER_TACHI_UITEST_BACKUP="$(cat "$OUT/sample-backup.json")"

# --- Build and run ---
set +e
xcodebuild test -project ios/App/App.xcodeproj -scheme AppUITests -configuration Debug \
  -destination "id=$UDID" -derivedDataPath build/DerivedData-ui \
  -resultBundlePath "$OUT/AppUITests.xcresult" \
  CODE_SIGNING_ALLOWED=NO > "$OUT/xcodebuild-ui.log" 2>&1
STATUS=$?
set -e
grep -E "error:|Test Case|Executed|\*\* (TEST|BUILD)" "$OUT/xcodebuild-ui.log" | tail -40 || true

# --- Screenshots and failure details out of the result bundle ---
if [ -d "$OUT/AppUITests.xcresult" ]; then
  xcrun xcresulttool export attachments --path "$OUT/AppUITests.xcresult" --output-path "$OUT/screenshots" > /dev/null 2>&1 \
    || echo "::warning::could not export attachments from the result bundle"
  node tools/ui-attachments.ts "$OUT/screenshots" || true
fi

# --- What the test had to work around (docs/ui-tests.md "Flakiness"), and why the page went away if it did ---
# WebKit logs the WebContent process's end in the app's own process (crash, memory limit, …): the full log
# goes with ui-test-logs (on failure), the relevant lines with the screenshots (always uploaded).
xcrun simctl spawn "$UDID" log show --last 30m --style compact \
  --predicate '(process == "App" AND (subsystem BEGINSWITH "com.apple.WebKit" OR subsystem == "app.tachinovel")) OR process BEGINSWITH "com.apple.WebKit.WebContent"' \
  > "$OUT/app-webkit.log" 2>/dev/null || true
grep -oE "UITEST-(WEB-RECOVERED|WEB-BLANK|RETRY).*" "$OUT/xcodebuild-ui.log" | sort -u > "$OUT/workarounds.txt" || true
while IFS= read -r line; do
  echo "::warning title=UI test workaround::$line"
done < "$OUT/workarounds.txt"
if grep -q "UITEST-WEB" "$OUT/workarounds.txt"; then
  grep -iE "WebProcessProxy|processDidTerminate|didClose|terminat|crash|jetsam|memory limit|reload" "$OUT/app-webkit.log" \
    | tail -60 > "$OUT/screenshots/webcontent-events.txt" || true
  find "$HOME/Library/Logs/DiagnosticReports" -name '*WebContent*' -newer "$OUT/sample-backup.json" -exec cp {} "$OUT/screenshots/" \; 2>/dev/null || true
  echo "--- WebContent events (also in the ui-test-screenshots artifact) ---"
  cat "$OUT/screenshots/webcontent-events.txt" || true
fi
echo "--- fixture site requests ---"
tail -40 "$OUT/fixture-site.log" || true
# A crash of the app under test (also one XCUITest recovered from) fails the job; the reports go with the
# screenshots artifact.
CRASHES=$(find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 \( -name "App-*.ips" -o -name "App_*.ips" \) -newer "$OUT/sample-backup.json" 2>/dev/null || true)
if [ -n "$CRASHES" ]; then
  echo "::error::The app crashed during the UI tests (crash reports in the ui-test-screenshots artifact)"
  echo "$CRASHES" | while read -r f; do cp "$f" "$OUT/screenshots/" 2>/dev/null || true; done
  STATUS=1
fi
exit $STATUS
