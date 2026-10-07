/**
 * Scene reading: which read of the narrator voice the director picks per sentence (calm, performed, tense, sad,
 * tender), against hand labels for two original scenes (tests/fixtures/scene-reading; each sentence lists every
 * read that would be acceptable). Kasta asked for at least 95 % (2026-10-07).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlToBlocks } from '@v1tts/frontend.ts';
import { speechScript } from '../src/core/narration/speech-script.ts';

const dir = path.join(import.meta.dirname, 'fixtures', 'scene-reading');
const labels = JSON.parse(readFileSync(path.join(dir, 'labels.json'), 'utf8')) as Record<string, string[]>;
const CODE: Record<string, string> = { narrator: 'n', performed: 'p', tense: 't', sad: 's', tender: 'd' };

function reads(name: string): { text: string; read: string }[] {
  const paras = readFileSync(path.join(dir, `${name}.txt`), 'utf8').split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const html = paras.map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('');
  return speechScript(htmlToBlocks(html)).items.map((i) => ({ text: i.text, read: CODE[i.voice ?? 'narrator'] ?? '?' }));
}

describe('scene reading', () => {
  for (const name of ['merrow', 'lighthouse']) {
    it(`${name}: at least 95 % of the sentences get an acceptable read`, () => {
      const got = reads(name);
      const want = labels[name] ?? [];
      expect(got).toHaveLength(want.length);
      const misses = got.filter((g, k) => !(want[k] ?? '').includes(g.read)).map((g) => `${g.read}: ${g.text}`);
      expect(1 - misses.length / got.length, misses.join('\n')).toBeGreaterThanOrEqual(0.95);
    });
  }
});
