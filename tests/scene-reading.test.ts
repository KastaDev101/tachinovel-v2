/**
 * Scene reading: which read of the narrator voice the director picks per sentence (calm, performed, tense, sad,
 * tender), against hand labels for original scenes (src/core/narration/scene-tests.ts; each sentence lists every
 * read that would be acceptable). Kasta asked for at least 95 % (2026-10-07).
 */
import { describe, expect, it } from 'vitest';
import { htmlToBlocks } from '@v1tts/frontend.ts';
import { modelVoices, SCENE_TESTS, sceneScore } from '../src/core/narration/scene-tests.ts';
import { speechScript } from '../src/core/narration/speech-script.ts';

const script = (paras: readonly string[]) =>
  speechScript(htmlToBlocks(paras.map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join(''))).items;

describe('scene reading', () => {
  for (const t of SCENE_TESTS) {
    it(`${t.name}: at least 95 % of the sentences get an acceptable read (rules)`, () => {
      const items = script(t.paragraphs);
      expect(items).toHaveLength(t.labels.length);
      const s = sceneScore(items.map((i) => i.voice), t.labels);
      expect(s.ok / s.total, s.misses.map((k) => `${items[k]?.voice ?? 'narrator'}: ${items[k]?.text}`).join('\n')).toBeGreaterThanOrEqual(0.95);
    });
  }

  it('maps the on-device model’s moods like native does', () => {
    const items = [{ voice: undefined }, { voice: undefined }, { voice: 'performed' as const }, { voice: undefined }, { voice: undefined }];
    const kinds = ['narration', 'narration', 'spoken', 'narration', 'system'] as const;
    expect(modelVoices(items, kinds, ['tense', 'tense', 'playful', 'sad', 'tense'])).toEqual(['tense', 'tense', 'performed', undefined, undefined]);
    expect(modelVoices(items, kinds, ['calm'])).toEqual([undefined, undefined, 'performed', undefined, undefined]);
  });
});
