#!/usr/bin/env bash
# Run kokoro-check (ios/App/HDVoice, product kokoro-check) on the bundled model and the fixtures written by
# tools/voice-fixtures.ts, then add the numbers to the job summary. Needs `swift build -c release
# --package-path ios/App/HDVoice --product kokoro-check` first.
#
# Usage: bash ci/voice-check.sh <out-dir>
set -euo pipefail
OUT="${1:?out dir}"
mkdir -p "$OUT"
BIN="$(swift build -c release --package-path ios/App/HDVoice --show-bin-path)/kokoro-check"
status=0
"$BIN" --models ios/App/App/KokoroModels --fixtures .cache/voice-fixtures.json --out "$OUT" 2>&1 | tee "$OUT/kokoro-check.log" || status=$?
if [ -f "$OUT/report.json" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  node -e '
    const r = require(process.argv[1]);
    const lines = [
      "### Kokoro on the CI Mac (bundled model, the app loader)",
      "",
      `- route ${r.route}: model load ${Math.round(r.loadMs)} ms, first audio ${Math.round(r.firstAudioMs)} ms, median ${r.p50x.toFixed(1)}x real time`,
      `- memory: ${Math.round(r.memoryMB.before)} MB before, ${Math.round(r.memoryMB.loaded)} MB loaded, ${Math.round(r.memoryMB.released)} MB after release`,
      `- ${r.rows.length} sentences (${new Set(r.rows.map((x) => x.voice)).size} voices), ${r.problems.length} problems, ${r.warnings.length} warnings`,
      ...r.problems.map((p) => `- problem: ${p}`),
    ];
    require("fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  ' "$PWD/$OUT/report.json"
fi
exit $status
