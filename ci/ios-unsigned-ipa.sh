#!/usr/bin/env bash
# Unsigned device build → .ipa (Payload/App.app) for sideloading with AltStore / SideStore, which re-sign
# it with the user's free Apple ID (7-day certificate). No Apple Developer account involved.
#
# Free-account constraints (checked here, see docs/architecture.md "Sideloading"):
#   - no entitlements are embedded (App.entitlements is empty and signing is off), so no iCloud
#     container, CarPlay, push or App Groups: the app falls back to local storage and plays narration
#     through the phone/car audio without the CarPlay templates.
#   - background modes (audio, fetch) are Info.plist keys, not entitlements: they keep working.
#
# Usage: bash ci/ios-unsigned-ipa.sh <out-dir>   (expects `npx cap sync ios` to have run)
# Env: BUILD_NUMBER (CFBundleVersion, CI run number), MARKETING_VERSION (default: tools/release.ts
#      version, i.e. package.json without the pre-release suffix), IPA_NAME (optional file name).
set -euo pipefail

OUT="${1:?output dir}"
mkdir -p "$OUT"
DERIVED=build/DerivedData-device
BUILD_NUMBER="${BUILD_NUMBER:-1}"
MARKETING_VERSION="${MARKETING_VERSION:-$(node tools/release.ts version)}"

set -o pipefail
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath "$DERIVED" \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=NO \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" CODE_SIGN_ENTITLEMENTS="" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" MARKETING_VERSION="$MARKETING_VERSION" \
  build | tee "$OUT/xcodebuild-device.log" | grep -E "error:|\*\* BUILD" || true
grep -q "\*\* BUILD SUCCEEDED \*\*" "$OUT/xcodebuild-device.log"

APP="$DERIVED/Build/Products/Release-iphoneos/App.app"
[ -d "$APP" ] || { echo "App.app not found at $APP"; exit 1; }

# Guard: nothing a free Apple ID can't sign may be embedded.
if [ -f "$APP/archived-expanded-entitlements.xcent" ]; then
  if grep -qE "icloud|ubiquity|carplay|aps-environment|application-groups" "$APP/archived-expanded-entitlements.xcent"; then
    echo "::error::restricted entitlements embedded in the unsigned build"; exit 1
  fi
fi
lipo -info "$APP/App" || true

STAGE=$(mktemp -d)
mkdir -p "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/"
VERSION=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Info.plist")
# IPA_NAME: the release workflow names the file after the full version (e.g. 2.1.0-beta.1).
IPA="$(cd "$OUT" && pwd)/${IPA_NAME:-TachiNovel-${VERSION}-${BUILD_NUMBER}-unsigned.ipa}"
(cd "$STAGE" && zip -qry "$IPA" Payload)
ls -l "$IPA"
echo "ipa=$IPA" >> "${GITHUB_OUTPUT:-/dev/null}"
