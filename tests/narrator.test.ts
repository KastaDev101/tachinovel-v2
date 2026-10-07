/** Narrator mode, script side (src/core/narration/narrator.ts, through speechScript). */
import { describe, expect, it } from 'vitest';
import { htmlToBlocks } from '@v1tts/frontend.ts';
import { alternateSpeakers, dialogueParts, pacedPause, rateJitter, type PacedSentence } from '../src/core/narration/narrator.ts';
import { speechScript } from '../src/core/narration/speech-script.ts';

const lex = { schemaVersion: 1 as const, entries: [{ match: 'Nephis', ipa: 'nˈɛfɪs' }] };

function script(html: string) {
  const blocks = htmlToBlocks(html);
  return { blocks, items: speechScript(blocks, { lexicons: [lex] }).items };
}

describe('narrator mode: dialogue', () => {
  it('splits a sentence that mixes speech and narration, with ranges in the block text', () => {
    const { blocks, items } = script('<p>“Run,” she said. “Now!”</p>');
    const it0 = items[0];
    expect(it0?.role).toBeUndefined();
    expect(it0?.parts?.map((p) => [p.role, p.text])).toEqual([
      ['dialogue', '"Run,"'],
      ['narration', 'she said.'],
      ['dialogue', '"Now!"'],
    ]);
    const text = blocks[0]?.text ?? '';
    expect(it0?.parts?.map((p) => text.slice(p.start, p.end).trim())).toEqual(['“Run,”', 'she said.', '“Now!”']);
  });

  it('keeps lexicon phonemes inside the part they belong to', () => {
    const { items } = script('<p>"Nephis, wait!" he called, but she was gone.</p>');
    const [speech, rest] = items[0]?.parts ?? [];
    expect(speech?.runs).toEqual([{ t: '"' }, { p: 'nˈɛfɪs' }, { t: ', wait!"' }]);
    expect(rest).toMatchObject({ role: 'narration', text: 'he called, but she was gone.' });
    expect(rest?.runs).toBeUndefined();
  });

  it('marks whole quoted sentences, also when the quote opened in the sentence before', () => {
    const { items } = script(
      '<p>“I waited for you at the old bridge all night long. You never came, and I still do not know why.”</p><p>The rain fell on the bridge.</p>',
    );
    expect(items.map((i) => [i.role ?? 'narration', i.parts ? 'parts' : ''])).toEqual([
      ['dialogue', ''],
      ['dialogue', ''],
      ['narration', ''],
    ]);
  });

  it('a dash between two quotes is not narration; spoken text that lost its quotes is not split', () => {
    expect(script('<p>“Run!” — “Now!”</p>').items[0]?.role).toBe('dialogue');
    expect(dialogueParts('“Run,” she said.', 0, [{ text: 'Run, she said.' }], false)).toBeNull();
    expect(dialogueParts('She smiled.', 0, [{ text: 'She smiled.' }], false)).toBeNull();
  });

  it('alternates speakers through an exchange and starts again after narration or a title', () => {
    const p = (block: number, dialogue: boolean, kind: PacedSentence['kind'] = 'text') => ({ block, kind, dialogue });
    expect(alternateSpeakers([p(0, true), p(0, true), p(1, true), p(2, true), p(3, false), p(4, true), p(5, true, 'title'), p(6, true)])).toEqual([
      0, 0, 1, 0, 0, 0, 0, 0,
    ]);
    const { items } = script('<p>“Ready?”</p><p>“Always.”</p><p>“Then go.”</p>');
    expect(items.map((i) => i.speaker ?? 0)).toEqual([0, 1, 0]);
  });
});

describe('narrator mode: pacing and jitter', () => {
  const s = (text: string, o: Partial<PacedSentence> = {}): PacedSentence => ({ block: 0, kind: 'text', text, pauseMs: 320, dialogue: false, quoted: false, ...o });

  it('pauses by ending and length inside a paragraph', () => {
    const next = s('And then the rest of it went on for a while.');
    const at = (first: PacedSentence) => pacedPause([first, next], 0);
    expect(at(s('Did the bridge hold up against the storm last night?'))).toBe(380);
    expect(at(s('The bridge held up against the storm last night!'))).toBe(290);
    expect(at(s('The bridge held up against the storm last night…'))).toBe(500);
    expect(at(s('The bridge held up against the storm last night.'))).toBe(320);
    expect(at(s('It held.'))).toBe(256); // short: 0.8×
    expect(at(s('x'.repeat(200) + '.'))).toBe(368); // long: 1.15×
    expect(at(s('A clause that the front-end split', { pauseMs: 160 }))).toBe(160);
    expect(pacedPause([s('He turned to her at last.'), s('“Go.”', { quoted: true })], 0)).toBe(420); // speaker change
  });

  it('paragraph ends: quick exchanges are tighter, long paragraphs get more room, structure stays', () => {
    const quick = [s('“Ready?”', { pauseMs: 700, dialogue: true, quoted: true }), s('“Always.”', { block: 1, pauseMs: 700, dialogue: true, quoted: true })];
    expect(pacedPause(quick, 0)).toBe(520);
    const long = [s('word '.repeat(100), { pauseMs: 700 }), s('Next.', { block: 1 })];
    expect(pacedPause(long, 0)).toBe(820);
    expect(pacedPause([s('Chapter One', { kind: 'title', pauseMs: 1300 }), s('Text.', { block: 1 })], 0)).toBe(1300);
    expect(pacedPause([s('Before the break.', { pauseMs: 1800 }), s('After.', { block: 2 })], 0)).toBe(1800);
    expect(pacedPause([s('The very last sentence.', { pauseMs: 700 })], 0)).toBe(700);
  });

  it('jitter: within ±3 %, the same for the same sentence, varied across sentences', () => {
    const values = Array.from({ length: 2000 }, (_, i) => rateJitter(1 + i * 7919));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0.97);
    expect(Math.max(...values)).toBeLessThanOrEqual(1.03);
    expect(Math.min(...values)).toBeLessThan(0.975);
    expect(Math.max(...values)).toBeGreaterThan(1.025);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(Math.abs(mean - 1)).toBeLessThan(0.003);
    expect(rateJitter(11898211)).toBe(rateJitter(11898211));
    expect(rateJitter(0)).toBe(1);
    // Neighboring hashes don't give neighboring speeds.
    expect(new Set([1, 2, 3, 4, 5, 6].map(rateJitter)).size).toBeGreaterThan(4);
  });

  it('speechScript keeps the sentence list and adds only optional fields', () => {
    const { items } = script('<p>He shook his head. “I can’t.”</p><p>The rain fell on the old bridge, and nobody spoke.</p>');
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(typeof it.pauseMs).toBe('number');
      if (it.rate !== undefined) expect(it.rate).not.toBe(1);
      if (it.pacedMs !== undefined) expect(it.pacedMs).not.toBe(it.pauseMs);
    }
  });
});
