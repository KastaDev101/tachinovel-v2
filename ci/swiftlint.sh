#!/usr/bin/env bash
# SwiftLint from a pinned, checksum-verified release (nothing installed system-wide). Writes SwiftLint's
# JSON report; tools/swift-quality.ts lint turns it into pass/fail and annotations (strict, with the
# report-only paths listed there). Config: .swiftlint.yml.
#
# Usage: bash ci/swiftlint.sh <report.json>      (macOS runner; the portable build is a macOS binary)
# Bump: change VERSION and SHA256 together (the release page lists each asset's sha256 digest).
set -euo pipefail

VERSION=0.65.1
SHA256=c1e429b0599cf1b516f369a2d9ec04eaf0e436f3c12b637df8851fa52ff694d0
OUT="${1:?report path}"
DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/swiftlint-$VERSION"

if [ ! -x "$DIR/swiftlint" ]; then
  mkdir -p "$DIR"
  curl -fsSL --retry 3 -o "$DIR/portable_swiftlint.zip" \
    "https://github.com/realm/SwiftLint/releases/download/$VERSION/portable_swiftlint.zip"
  echo "$SHA256  $DIR/portable_swiftlint.zip" | shasum -a 256 -c -
  unzip -q -o "$DIR/portable_swiftlint.zip" -d "$DIR"
fi

mkdir -p "$(dirname "$OUT")"
echo "SwiftLint $("$DIR/swiftlint" version)"
# The exit status only says "violations found"; the report decides. An empty report (config error,
# crash) fails in tools/swift-quality.ts.
"$DIR/swiftlint" lint --quiet --reporter json > "$OUT" || true
