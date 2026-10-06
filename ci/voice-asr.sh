#!/usr/bin/env bash
# ASR round trip on the WAVs kokoro-check wrote (af_heart, the `asr` fixtures): whisper.cpp v1.9.4 (pinned,
# built from source) with ggml-base.en-q8_0 (pinned Hugging Face revision + SHA-256) transcribes them, and
# ci/voice-asr.ts fails if the word error rate is above 15%. If whisper.cpp can't be built or the model
# can't be fetched, the round trip is skipped with a warning (never a failure).
#
# Usage: bash ci/voice-asr.sh <dir with the WAVs>
set -uo pipefail
DIR="${1:?wav dir}"
WHISPER=.cache/whisper
MODEL=$WHISPER/ggml-base.en-q8_0.bin
SHA=a4d4a0768075e13cfd7e19df3ae2dbc4a68d37d36a7dad45e8410c9a34f8c87e
REV=5359861c739e955e79d9a303bcbc70fb988958b1
mkdir -p "$WHISPER"

if [ ! -x "$WHISPER/bin/whisper-cli" ]; then
  rm -rf "$WHISPER/src" "$WHISPER/build"
  if git clone --depth 1 --branch v1.9.4 https://github.com/ggml-org/whisper.cpp "$WHISPER/src" \
    && cmake -S "$WHISPER/src" -B "$WHISPER/build" -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DBUILD_SHARED_LIBS=OFF \
    && cmake --build "$WHISPER/build" -j 3 --target whisper-cli; then
    mkdir -p "$WHISPER/bin" && cp "$WHISPER/build/bin/whisper-cli" "$WHISPER/bin/"
  else
    echo "::warning::whisper.cpp could not be built; ASR round trip skipped"
  fi
  rm -rf "$WHISPER/src" "$WHISPER/build"
fi

if [ ! -f "$MODEL" ] || [ "$(shasum -a 256 "$MODEL" | cut -d' ' -f1)" != "$SHA" ]; then
  curl -fsSL -o "$MODEL" "https://huggingface.co/ggerganov/whisper.cpp/resolve/$REV/ggml-base.en-q8_0.bin" || true
  if [ "$(shasum -a 256 "$MODEL" 2>/dev/null | cut -d' ' -f1)" != "$SHA" ]; then
    echo "::warning::whisper model missing or checksum mismatch; ASR round trip skipped"
    rm -f "$MODEL"
  fi
fi

if [ -x "$WHISPER/bin/whisper-cli" ] && [ -f "$MODEL" ]; then
  for wav in "$DIR"/*.wav; do
    [ -f "$wav" ] || continue
    "$WHISPER/bin/whisper-cli" -m "$MODEL" -f "$wav" -l en -nt -otxt -of "${wav%.wav}" > /dev/null 2>&1 || echo "::warning::whisper failed on $wav"
  done
fi
node ci/voice-asr.ts .cache/voice-fixtures.json "$DIR" 0.15
