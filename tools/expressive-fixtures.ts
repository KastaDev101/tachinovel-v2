/**
 * Fixture lines for the expressive-voice benchmark (.github/workflows/expressive-bench.yml): the Voice
 * Lab's samples (src/ui/native/expressive-samples.ts), flattened with ids, so the CI Mac renders exactly
 * what the phone test plays. `plain` is the text without sound tags (the ASR reference).
 *
 * Usage: node tools/expressive-fixtures.ts <out.json>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { plainText, SAMPLES, type ExpressiveLine } from '../src/ui/native/expressive-samples.ts';

export interface FixtureLine extends ExpressiveLine {
  id: string;
  sample: string;
  plain: string;
}

export function buildExpressiveFixtures(): { lines: FixtureLine[] } {
  const lines: FixtureLine[] = [];
  for (const s of SAMPLES) {
    s.lines.forEach((l, i) => lines.push({ ...l, id: `${s.id}-${String(i + 1).padStart(2, '0')}`, sample: s.id, plain: plainText(l.text) }));
  }
  return { lines };
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node tools/expressive-fixtures.ts <out.json>');
    process.exit(2);
  }
  const fixtures = buildExpressiveFixtures();
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, `${JSON.stringify(fixtures, null, 2)}\n`);
  console.log(`${fixtures.lines.length} lines → ${out}`);
}
