#!/usr/bin/env bash
# Expressive-voice benchmark (docs/expressive-tts.md): run expressive-bench (ios/App/ExpressiveVoice) once
# per engine, each in its own process so a crash in one engine doesn't hide the others' numbers. The models
# are downloaded per run by the app's own downloader (pinned revision + SHA-256, never cached, never
# committed) and deleted after each engine to keep the runner's disk free.
# Needs: `swift build -c release --package-path ios/App/ExpressiveVoice --product expressive-bench` and the
# fixtures from `node tools/expressive-fixtures.ts .cache/expressive-fixtures.json`.
#
# Usage: ENGINES="chatterbox-nano neutts-2e pocket-tts" BUDGET=900 bash ci/expressive-bench.sh <out-dir>
set -uo pipefail
OUT="${1:?out dir}"
ENGINES="${ENGINES:-chatterbox-nano neutts-2e pocket-tts}"
BUDGET="${BUDGET:-900}"
mkdir -p "$OUT"
BIN="$(swift build -c release --package-path ios/App/ExpressiveVoice --show-bin-path)/expressive-bench"
MODELS="$HOME/.cache/fluidaudio/Models"

for engine in $ENGINES; do
  echo "::group::expressive-bench $engine"
  "$BIN" --engine "$engine" --fixtures .cache/expressive-fixtures.json --out "$OUT" --budget-seconds "$BUDGET" 2>&1 | tee "$OUT/$engine.log"
  code=${PIPESTATUS[0]}
  echo "::endgroup::"
  if [ "$code" -ne 0 ]; then
    echo "::warning::expressive-bench $engine exited with status $code (see $engine.log in the artifact)"
    echo "$code" > "$OUT/$engine.exit"
  fi
  rm -rf "${MODELS:?}/$engine"
done
# The report step (ci/expressive-bench-report.ts) decides pass/fail; a benchmark never blocks anything.
exit 0
