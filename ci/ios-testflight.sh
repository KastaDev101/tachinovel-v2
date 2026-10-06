#!/usr/bin/env bash
# Archive, sign and upload TachiNovel v2 to App Store Connect (→ TestFlight), from a macOS runner.
#
# Two signing modes:
#  1. Cloud-managed signing (default): xcodebuild -allowProvisioningUpdates with an App Store Connect
#     API key. Needs a TEAM key with the Admin role. No certificates or profiles in the repo or secrets.
#  2. Manual signing (when IOS_DIST_P12_BASE64 + IOS_PROFILE_BASE64 are set): imports the distribution
#     certificate and App Store profile into a throwaway keychain. Use this if cloud signing hits the
#     known "development certificate private key is not installed" problem on fresh runners.
#
# Required env: APPLE_TEAM_ID ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8_BASE64 BUNDLE_ID BUILD_NUMBER
# Optional env: IOS_DIST_P12_BASE64 IOS_DIST_P12_PASSWORD IOS_PROFILE_BASE64 MARKETING_VERSION
set -euo pipefail

: "${APPLE_TEAM_ID:?}" "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${ASC_KEY_P8_BASE64:?}" "${BUNDLE_ID:?}" "${BUILD_NUMBER:?}"
MARKETING_VERSION="${MARKETING_VERSION:-$(node -p "require('./package.json').version.split('-')[0]")}"

ROOT="$(pwd)"
OUT="$ROOT/build"
mkdir -p "$OUT"
KEY_DIR="$HOME/.appstoreconnect/private_keys"
KEY_PATH="$KEY_DIR/AuthKey_${ASC_KEY_ID}.p8"
mkdir -p "$KEY_DIR"
echo "$ASC_KEY_P8_BASE64" | base64 --decode > "$KEY_PATH"
chmod 600 "$KEY_PATH"

AUTH=(-authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
SIGN_STYLE=automatic
EXTRA_ARCHIVE=()
PROFILE_NAME=""

cleanup() {
  rm -f "$KEY_PATH"
  if [ -n "${KEYCHAIN:-}" ]; then security delete-keychain "$KEYCHAIN" || true; fi
}
trap cleanup EXIT

if [ -n "${IOS_DIST_P12_BASE64:-}" ] && [ -n "${IOS_PROFILE_BASE64:-}" ]; then
  SIGN_STYLE=manual
  KEYCHAIN="$RUNNER_TEMP/signing.keychain-db"
  KEYCHAIN_PASSWORD="$(uuidgen)"
  security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
  security set-keychain-settings -lut 21600 "$KEYCHAIN"
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
  echo "$IOS_DIST_P12_BASE64" | base64 --decode > "$RUNNER_TEMP/dist.p12"
  security import "$RUNNER_TEMP/dist.p12" -P "${IOS_DIST_P12_PASSWORD:-}" -A -t cert -f pkcs12 -k "$KEYCHAIN"
  security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" > /dev/null
  security list-keychain -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
  # Xcode 16+ reads profiles from UserData; older tools from MobileDevice. Install in both.
  PROFILE="$RUNNER_TEMP/app.mobileprovision"
  echo "$IOS_PROFILE_BASE64" | base64 --decode > "$PROFILE"
  UUID=$(/usr/libexec/PlistBuddy -c "Print UUID" /dev/stdin <<< "$(security cms -D -i "$PROFILE")")
  PROFILE_NAME=$(/usr/libexec/PlistBuddy -c "Print Name" /dev/stdin <<< "$(security cms -D -i "$PROFILE")")
  for dir in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" "$HOME/Library/MobileDevice/Provisioning Profiles"; do
    mkdir -p "$dir" && cp "$PROFILE" "$dir/$UUID.mobileprovision"
  done
  EXTRA_ARCHIVE=(CODE_SIGN_STYLE=Manual "CODE_SIGN_IDENTITY=Apple Distribution" "PROVISIONING_PROFILE_SPECIFIER=$PROFILE_NAME")
fi

# ExportOptions: upload straight to App Store Connect (TestFlight picks the build up after processing).
EXPORT_OPTIONS="$OUT/ExportOptions.plist"
cat > "$EXPORT_OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>${APPLE_TEAM_ID}</string>
  <key>signingStyle</key><string>${SIGN_STYLE}</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
$( if [ "$SIGN_STYLE" = manual ]; then printf '  <key>provisioningProfiles</key><dict><key>%s</key><string>%s</string></dict>\n' "$BUNDLE_ID" "$PROFILE_NAME"; fi )
</dict>
</plist>
PLIST

echo "Archiving $BUNDLE_ID $MARKETING_VERSION ($BUILD_NUMBER), signing: $SIGN_STYLE"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/App.xcarchive" \
  -allowProvisioningUpdates "${AUTH[@]}" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" MARKETING_VERSION="$MARKETING_VERSION" \
  ${EXTRA_ARCHIVE[@]+"${EXTRA_ARCHIVE[@]}"} \
  archive 2>&1 | tee "$OUT/archive.log" | grep -E "error:|\*\* ARCHIVE" || true
grep -q "\*\* ARCHIVE SUCCEEDED \*\*" "$OUT/archive.log"

xcodebuild -exportArchive -archivePath "$OUT/App.xcarchive" -exportOptionsPlist "$EXPORT_OPTIONS" \
  -exportPath "$OUT/export" -allowProvisioningUpdates "${AUTH[@]}" 2>&1 | tee "$OUT/export.log" | grep -E "error:|EXPORT|Upload" || true
grep -qE "\*\* EXPORT SUCCEEDED \*\*|Upload succeeded" "$OUT/export.log"
echo "Uploaded build $BUILD_NUMBER. It appears in TestFlight after Apple finishes processing (usually minutes)."
