/** Phrase breaks (src/core/narration/narrator.ts `phrases`), mirroring the narrator repo's py/tune.py (d172d45). */
import { describe, expect, it } from 'vitest';
import { htmlToBlocks } from '@v1tts/frontend.ts';
import { phrases, PHRASE_BREAK_MS } from '../src/core/narration/narrator.ts';
import { speechScript } from '../src/core/narration/speech-script.ts';

describe('phrase breaks ("clauses", Kasta\'s pick P3)', () => {
  it('175 ms after a comma, semicolon or em dash', () => {
    expect(phrases('The rain had stopped by the time we reached the old bridge, and for a moment the whole city held its breath.')).toEqual([
      { text: 'The rain had stopped by the time we reached the old bridge,', pauseMs: 175 },
      { text: 'and for a moment the whole city held its breath.', pauseMs: 0 },
    ]);
    expect(phrases('The lanterns flickered along the river; the wind carried smoke.').map((p) => p.pauseMs)).toEqual([175, 0]);
    expect(phrases('The bell rang three times — then the river went quiet.')).toEqual([
      { text: 'The bell rang three times —', pauseMs: 175 },
      { text: 'then the river went quiet.', pauseMs: 0 },
    ]);
  });

  it('about 230 ms after an introductory phrase (a comma within the first five words)', () => {
    expect(phrases('In the grey morning, the old bridge was gone and nobody could say why.')).toEqual([
      { text: 'In the grey morning,', pauseMs: 228 },
      { text: 'the old bridge was gone and nobody could say why.', pauseMs: 0 },
    ]);
  });

  it('105 ms before a clause starter (but, and then, while, because), not again after a comma', () => {
    expect(phrases('He waited by the river for hours but nobody came to the old stone bridge.')).toEqual([
      { text: 'He waited by the river for hours', pauseMs: 105 },
      { text: 'but nobody came to the old stone bridge.', pauseMs: 0 },
    ]);
    expect(phrases('She closed the door behind her and then walked down to the water.').map((p) => [p.text.split(' ')[0], p.pauseMs])).toEqual([
      ['She', 105],
      ['and', 0],
    ]);
    expect(phrases('He kept walking toward the bridge, but nobody followed him there.').map((p) => p.pauseMs)).toEqual([175, 0]);
    expect(phrases('The city was silent While the lanterns burned low over the water.').map((p) => p.pauseMs)).toEqual([105, 0]);
  });

  it('never leaves a piece shorter than 12 characters', () => {
    expect(phrases('Yes, he said quietly.')).toEqual([{ text: 'Yes, he said quietly.', pauseMs: 0 }]);
    expect(phrases('He ran, fast.')).toEqual([{ text: 'He ran, fast.', pauseMs: 0 }]);
    expect(phrases('But nobody came to the old stone bridge that night.')).toHaveLength(1);
    expect(phrases('')).toEqual([]);
  });

  it('scales with the break length', () => {
    expect(phrases('The rain had stopped by the time we reached the old bridge, and the city held its breath.', 200)[0]?.pauseMs).toBe(200);
    expect(PHRASE_BREAK_MS).toBe(175);
  });

  it('speechScript marks phrases, except in sentences with lexicon phoneme runs', () => {
    const lex = { schemaVersion: 1 as const, entries: [{ match: 'Nephis', ipa: 'nˈɛfɪs' }] };
    const items = speechScript(
      htmlToBlocks('<p>He waited by the river for hours but nobody came to the old stone bridge.</p><p>Nephis waited by the river for hours, but nobody came.</p><p>It held.</p>'),
      { lexicons: [lex] },
    ).items;
    expect(items[0]?.phrases?.map((p) => p.pauseMs)).toEqual([105, 0]);
    expect(items[1]?.runs).toBeDefined();
    expect(items[1]?.phrases).toBeUndefined();
    expect(items[2]?.phrases).toBeUndefined();
  });
});
