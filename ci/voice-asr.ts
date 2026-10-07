/**
 * ASR round trip for the bundled Kokoro voice (CI job "voice-quality"): whisper.cpp transcribed the WAVs
 * kokoro-check wrote for the `asr` fixtures; this compares each transcript with the text that was spoken
 * and fails if the word error rate is above the limit. Missing transcripts (whisper.cpp couldn't be
 * built or run on the runner) are reported and skipped, never failed.
 *
 * Usage: node ci/voice-asr.ts <fixtures.json> <dir with <id>.txt (and <voice>--<id>.txt)> [maxWer=0.15]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/(^|\s)'+|'+(\s|$)/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate: word-level Levenshtein distance / reference length. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const r = normalizeWords(reference);
  const h = normalizeWords(hypothesis);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      const sub = (prev[j - 1] ?? 0) + (r[i - 1] === h[j - 1] ? 0 : 1);
      cur[j] = Math.min(sub, (prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1);
    }
    prev = cur;
  }
  return (prev[h.length] ?? 0) / r.length;
}

/** Narrator mode's WER limit (kokoro-check writes its audio as "narrator--<id>.wav"). */
export const NARRATOR_MAX_WER = 0.05;

if (import.meta.main) {
  const [fixturesPath, dir, maxArg] = process.argv.slice(2);
  if (!fixturesPath || !dir) {
    console.error('usage: node ci/voice-asr.ts <fixtures.json> <transcript dir> [maxWer]');
    process.exit(2);
  }
  const maxWer = Number(maxArg ?? '0.15');
  const { sentences } = JSON.parse(readFileSync(fixturesPath, 'utf8')) as { sentences: { id: string; text: string; asr?: boolean }[] };
  let failed = 0;
  let checked = 0;
  // "<id>.txt" is the default voice; "<voice>--<id>.txt" another voice (kokoro-check: "mix--" = a voice mix).
  const variants = readdirSync(dir)
    .map((f) => /^(.+)--.+\.txt$/.exec(f)?.[1])
    .filter((p): p is string => !!p);
  for (const s of sentences.filter((x) => x.asr)) {
    for (const prefix of ['', ...new Set(variants)]) {
      const base = prefix ? `${prefix}--${s.id}` : s.id;
      const file = [path.join(dir, `${base}.txt`), path.join(dir, `${base}.wav.txt`)].find((f) => existsSync(f));
      if (!file) {
        if (!prefix) console.log(`::warning::ASR: no transcript for ${s.id} (whisper.cpp unavailable?) — skipped`);
        continue;
      }
      const heard = readFileSync(file, 'utf8').trim();
      const wer = wordErrorRate(s.text, heard);
      checked++;
      const line = `${base}: WER ${(wer * 100).toFixed(1)}%\n  spoken: ${s.text}\n  heard:  ${heard}`;
      // Narrator mode is held to a stricter bar (dialogue voice, jitter and polish must not cost words).
      if (wer > (prefix === 'narrator' ? Math.min(maxWer, NARRATOR_MAX_WER) : maxWer)) {
        failed++;
        console.log(`::error::ASR ${line}`);
      } else {
        console.log(`ASR ${line}`);
      }
    }
  }
  console.log(`ASR round trip: ${checked} checked, ${failed} above ${(maxWer * 100).toFixed(0)}% WER`);
  process.exit(failed > 0 ? 1 : 0);
}
