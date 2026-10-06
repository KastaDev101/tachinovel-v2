#!/usr/bin/env bash
# IPA and installed-app size (job summary + log): the bundled Kokoro model is most of it.
# Usage: bash ci/ipa-size.sh <app.ipa> <path/to/App.app>
set -euo pipefail
IPA="${1:?ipa}"
APP="${2:?App.app}"
mb() { awk -v k="$1" 'BEGIN { printf "%.1f MB", k / 1024 }'; }
ipa_k=$(du -k "$IPA" | cut -f1)
app_k=$(du -sk "$APP" | cut -f1)
model_k=$(du -sk "$APP/KokoroModels" 2>/dev/null | cut -f1 || echo 0)
bin_k=$(du -k "$APP/App" | cut -f1)
fw_k=$(du -sk "$APP/Frameworks" 2>/dev/null | cut -f1 || echo 0)
{
  echo "### App size"
  echo ""
  echo "| | Size |"
  echo "|---|---|"
  echo "| IPA (download) | $(mb "$ipa_k") |"
  echo "| Installed app (unpacked bundle) | $(mb "$app_k") |"
  echo "| Kokoro model (KokoroModels/) | $(mb "$model_k") |"
  echo "| App binary | $(mb "$bin_k") |"
  echo "| Frameworks | $(mb "$fw_k") |"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
