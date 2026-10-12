/**
 * The raw text form (src/core/narration/raw-text.ts): the sentence as written, for a Nephis pack that asks for it
 * (pack.json chain "text": "raw"). The lab mirrors these cases (tachinovel-tts-lab finetune/app_text_test.py, form "raw").
 * Q1 lines are from the lab's script_sounds / hour-script sets (written for the lab); prose is written for this test.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlToBlocks, normalizeForSpeech, type Lexicon } from '@v1tts/frontend.ts';
import { ACRONYMS } from '../src/core/narration/delivery.ts';
import { rawNormalize, rawText } from '../src/core/narration/raw-text.ts';
import { speechScript } from '../src/core/narration/speech-script.ts';

const root = path.resolve(import.meta.dirname, '..');
const esc = (p: string): string => p.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const script = (paragraphs: readonly string[], lexicons?: Lexicon[]) => speechScript(htmlToBlocks(paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')), lexicons ? { lexicons } : {});
/** What a raw-form pack gets per sentence: the raw form where the script carries one, else the text. */
const rawOf = (it: { text: string; delivery?: { raw?: string } }): string => it.delivery?.raw ?? it.text;

/** Q1 (2026-10-12): the line as written, and arm B (what was rendered: "…" as "..."). */
const Q1: readonly [string, string][] = [
  ['Hah... hahh... what did you just do to me...', 'Hah... hahh... what did you just do to me...'],
  ['Right there... right there... yes, yes, YES— ohhh... fuuuck... oh...', 'Right there... right there... yes, yes, YES— ohhh... fuuuck... oh...'],
  ['Closer. Closer. Faster now. Faster. Hold the line, hold it, hold it... NOOOW!', 'Closer. Closer. Faster now. Faster. Hold the line, hold it, hold it... NOOOW!'],
  ['"Did you lock the gate?" A long pause. "...Define locked."', '"Did you lock the gate?" A long pause. "...Define locked."'],
  ['Please... please, open the door... please... OPEN IT!', 'Please... please, open the door... please... OPEN IT!'],
  ["Don't stop... don't you dare stop... I'm— OH, GOD— mmmh... god... fuuuuck...", "Don't stop... don't you dare stop... I'm— OH, GOD— mmmh... god... fuuuuck..."],
  ['Heh... ah— you want more, don\'t you? I can tell... mmm... ask me nicely.', 'Heh... ah— you want more, don\'t you? I can tell... mmm... ask me nicely.'],
  ['"Move, move, move! Get them out of there, all of them, now... before the whole... tower... falls!"', '"Move, move, move! Get them out of there, all of them, now... before the whole... tower... falls!"'],
  ['"So if the tower was built first, and the wall came later, then the door... oh. Oh no. The door was never meant to keep anything out."',
    '"So if the tower was built first, and the wall came later, then the door... oh. Oh no. The door was never meant to keep anything out."'],
  ['Look at you… trembling already.', 'Look at you... trembling already.'],
  ['Hmm… you want it so badly, don\'t you?', 'Hmm... you want it so badly, don\'t you?'],
  ['Hmmm... you came back.', 'Hmmm... you came back.'],
  ['Mmmmh... you came back.', 'Mmmmh... you came back.'],
];

describe('raw text form', () => {
  it('keeps what Q1 read as written: ellipses, dashes as spaced, capitals, held letters, interjections', () => {
    for (const [line, b] of Q1) {
      expect(rawText(line)).toBe(b);
      // Through the script too (sentence by sentence, as native joins a call).
      expect(script([line]).items.map(rawOf).join(' ')).toBe(b);
    }
    // What the app's form makes of them instead (the rewrites the raw form leaves out).
    const app = script(['Hold it... NOOOW!', 'Heh... ah— you want more.', '“Kneel!” she ordered.']).items;
    expect(app.map((it) => it.delivery?.say ?? it.text)).toEqual(['Hold it… Nooow!', 'heh… ah — you want more.', '"Kneel." she ordered.']);
    expect(app.map(rawOf)).toEqual(['Hold it... NOOOW!', 'Heh... ah— you want more.', '"Kneel!" she ordered.']);
  });

  it('normalizes every ellipsis to "..." and keeps a leading one', () => {
    expect(rawText('Wait…. Really? . . . Fine.')).toBe('Wait... Really?... Fine.');
    expect(rawText('…and then the lights went out')).toBe('...and then the lights went out');
    expect(rawText('Well. . . maybe.')).toBe('Well... maybe.');
    expect(rawText('“…what? Ah! Hm… W-wait…?”')).toBe('"...what? Ah! Hm... wait...?"');
    expect(rawText('Wait.. what?')).toBe('Wait.. what?');
  });

  it('keeps dashes as spaced, one glyph', () => {
    expect(rawText('I’m— OH, GOD— no')).toBe("I'm— OH, GOD— no");
    expect(rawText('He ran -- fast – faster - gone')).toBe('He ran — fast — faster — gone');
    expect(rawText('Pages 10–20, rooms 3-5')).toBe('Pages 10 to 20, rooms 3 to 5');
    expect(rawText('a well-known man')).toBe('a well-known man');
  });

  it('cuts a letter held six times or more to five, never shorter', () => {
    expect(rawText('Nooooooooooo! Fuuuuuck. Ahhhh.')).toBe('Nooooo! Fuuuuuck. Ahhhh.');
  });

  it('keeps what a book needs, as the front-end does it', () => {
    expect(rawText('Mr. Holmes met Dr. Watson at 5 p.m. on the 21st, Ch. 12 of Vol. II.')).toBe(
      'Mister Holmes met Doctor Watson at 5 p.m. on the twenty-first, Chapter 12 of Volume 2.',
    );
    expect(rawText('He reached Lv. 5, took 30% damage, ran 5km at 20 km/h and saw Louis XIV.')).toBe(
      'He reached Level 5, took 30 percent damage, ran 5 kilometers at 20 kilometers per hour and saw Louis the fourteenth.',
    );
    expect(rawText('[Skill acquired: Shadow Step] HP 100/100 → x3 & +5 @ https://x.io ★')).toBe('Skill acquired: Shadow Step HP 100 out of 100 to times 3 and plus 5 at');
    expect(rawText('“W-wait,” she said. ‘I-I don’t know, b-b-but th-that’s it!!’')).toBe('"wait," she said. \'I, I don\'t know, but th... that\'s it!\'');
  });

  it('applies the user’s Pronunciations, not the built-in interjections', () => {
    const lex: Lexicon = { schemaVersion: 1, entries: [{ match: 'Nephis', say: 'Neffis' }, { match: 'Sunny', ipa: 'sˈʌni' }, { match: 'Hmm', say: 'hum' }] };
    expect(rawText('Nephis... Sunny! Hmm. Heh. Ugh.', { lexicons: [lex] })).toBe('Neffis... Sunny! hum. Heh. Ugh.');
    expect(rawText('Nephis... Sunny! Hmm. Heh. Ugh.')).toBe('Nephis... Sunny! Hmm. Heh. Ugh.');
    // What follows a Pronunciations word keeps its joint (", " and "..." included).
    expect(rawText('Wait, Nephis, ...wait!', { lexicons: [lex] })).toBe('Wait, Neffis,...wait!');
  });

  it('follows the Stutter setting', () => {
    expect(rawText('W-what?', { stutter: 'keep' })).toBe('W-what?');
    expect(rawText('W-what?')).toBe('what?');
  });

  it('is the front-end’s normalization wherever nothing it leaves out occurs', () => {
    const prose = [
      'Mr. Holmes met Dr. Watson at 5 p.m. in St. James Street.',
      'The 3rd gate, 2nd floor; 40th day of the year.',
      'Chapter IV began on Floor XII, e.g. after Rank III, i.e. late, etc.',
      'Approx. 30% of 1,200 men (vs 400) marched 12km.',
      'She paid 5 lbs for 2 kg & 3 ml w/ ease @ noon.',
      'Score: 90/100, then 3/4 of it, then x2 and 3x.',
      'Turn -5 into +5 at #3, No. 7, pg. 12 and pp. 4.',
      '“It’s here,” she said; ‘no, there.’',
      'Wait!! What?? Really?! No!? Fine,, then.',
      'Louis XIV met Henry VIII at Mt. Fuji with Prof. Oak, Jr.',
      'The 1990s were 5 s long, or 3s.',
      '<<The Lord>> 【System】 ★ said ♥ hi • there.',
      'A man walked into a bar. It was quiet, and the rain kept falling.',
    ];
    for (const p of prose) expect(rawNormalize(p, { start: true }).trim(), p).toBe(normalizeForSpeech(p));
    // And through the script: no raw form where it would equal the text.
    const s = script(prose);
    expect(s.items.filter((it) => it.delivery?.raw !== undefined).map((it) => it.text)).toEqual([]);
  });

  it('carries the raw form only where it differs, never for titles or list summaries', () => {
    const s = script(['Chapter 12 - THE GATE…', 'He said… nothing.', 'He said nothing.']);
    expect(s.items.map((it) => [it.kind, it.text, it.delivery?.raw ?? null])).toEqual([
      ['title', 'Chapter 12. The Gate…', null],
      ['text', 'He said… nothing.', 'He said... nothing.'],
      ['text', 'He said nothing.', null],
    ]);
    const list = script(['Skills: [Fire Bolt], [Ice Lance], [Shadow Step], [Blink], [Haste], [Heal], [Ward]… and more.']);
    expect(list.items.every((it) => it.delivery?.raw === undefined)).toBe(true);
  });

  it('native spells out the same capitals in both forms (StyleMapper.keptCapitals = delivery.ts ACRONYMS)', () => {
    const swift = readFileSync(path.join(root, 'ios/App/ExpressiveVoice/Sources/ExpressiveCore/ExpressiveCatalog.swift'), 'utf8');
    const kept = /static let keptCapitals: Set<String> = \[([\s\S]*?)\]/.exec(swift)?.[1] ?? '';
    expect(new Set([...kept.matchAll(/"([A-Z]+)"/g)].map((m) => m[1]))).toEqual(ACRONYMS);
    expect(swift).toMatch(/case raw\b/);
    const chain = readFileSync(path.join(root, 'ios/App/ExpressiveVoice/Sources/ExpressiveCore/NephisFlow.swift'), 'utf8');
    expect(chain).toMatch(/public var text: PocketTextForm = \.app/);
  });

  it('keeps the front-end’s tables (frontend.ts) word for word', () => {
    const fe = readFileSync(path.join(root, 'vendor/v1/experiments/tts/frontend.ts'), 'utf8');
    const mine = readFileSync(path.join(root, 'src/core/narration/raw-text.ts'), 'utf8');
    const counted = (src: string) => /const COUNTED_NOUNS =\s*'([^']+)'/.exec(src)?.[1];
    expect(counted(mine)).toBe(counted(fe));
    const block = (src: string, start: string) => {
      const at = src.indexOf(start);
      return at < 0 ? '' : src.slice(at, src.indexOf('};', at)).replace(/\s+/g, ' ');
    };
    expect(block(mine, 'const UNITS')).toBe(block(fe, 'const UNITS'));
    expect(block(mine, 'const TITLES').replace('const TITLES: Record<string, string> = {', '')).toBe(
      block(fe, 'const titles').replace('const titles: Record<string, string> = {', ''),
    );
  });
});
