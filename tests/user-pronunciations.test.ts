/**
 * The user's own pronunciations (src/core/narration/user-pronunciations.ts): stress respellings ("NEF-iss",
 * "say-SHAHN") as each engine needs them, the hook in speechScript (whole words, any case, possessives, novel over
 * global, the displayed text untouched), and the reader's "Set pronunciation…" helpers. Prose written for this test.
 */
import { describe, expect, it } from 'vitest';
import { htmlToBlocks, isKokoroPhonemes, type Lexicon } from '@v1tts/frontend.ts';
import { rawText } from '../src/core/narration/raw-text.ts';
import { lexiconsFor, speechScript } from '../src/core/narration/speech-script.ts';
import {
  engineEntry,
  engineLexicon,
  findEntry,
  parseRespelling,
  pronounceTarget,
  removePronunciation,
  respellingForms,
  respellingProblem,
  savePronunciation,
  withUserPronunciations,
} from '../src/core/narration/user-pronunciations.ts';

const esc = (p: string): string => p.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const blocksOf = (paragraphs: readonly string[]) => htmlToBlocks(paragraphs.map((p) => `<p>${esc(p)}</p>`).join(''));
const lex = (...entries: Lexicon['entries']): Lexicon => ({ schemaVersion: 1, entries });

describe('stress respellings', () => {
  it('reads the capitals as the stressed syllable', () => {
    expect(parseRespelling('NEF-iss')).toEqual([[{ letters: 'nef', stress: 1 }, { letters: 'iss', stress: 0 }]]);
    expect(parseRespelling('say-SHAHN')).toEqual([[{ letters: 'say', stress: 0 }, { letters: 'shahn', stress: 1 }]]);
    // A second capital syllable is secondary stress; words split by spaces.
    expect(parseRespelling('CHAYN-jing STAR')).toEqual([
      [{ letters: 'chayn', stress: 1 }, { letters: 'jing', stress: 0 }],
      [{ letters: 'star', stress: 2 }],
    ]);
    // All in capitals: each word's first syllable.
    expect(parseRespelling('NEF-ISS')).toEqual([[{ letters: 'nef', stress: 1 }, { letters: 'iss', stress: 0 }]]);
  });

  it('leaves plain spellings alone', () => {
    for (const plain of ['Neffis', 'Nef-iss', 'nef iss', 'neffis', 'Sei-shan']) expect(parseRespelling(plain), plain).toBeNull();
    expect(parseRespelling('NEF-is!')).toBeNull();
    expect(parseRespelling('NÉF-is')).toBeNull();
    expect(respellingForms('Neffis', 'Nephis')).toBeNull();
  });

  it('gives Kokoro misaki phonemes with the stress where the capitals were', () => {
    expect(respellingForms('NEF-iss', 'Nephis')).toEqual({ say: 'Nef-iss', ipa: 'nˈɛfɪs' });
    expect(respellingForms('say-SHAHN', 'Seishan')).toEqual({ say: 'Say-shahn', ipa: 'sAʃˈɑn' });
    expect(respellingForms('SUN-ee', 'Sunny')).toEqual({ say: 'Sun-ee', ipa: 'sˈʌni' });
    expect(respellingForms('KASS-ee', 'Cassie')).toEqual({ say: 'Kass-ee', ipa: 'kˈæsi' });
    expect(respellingForms('kə-SAN-drə', 'Cassandra')?.ipa).toBe('kəsˈændɹə');
    expect(respellingForms('ZHAHR-dən', 'Jardin')?.ipa).toBe('ʒˈɑɹdən');
    // "Magic e" and a vowel "y".
    expect(respellingForms('SHANE', 'Shane')).toEqual({ say: 'Shane', ipa: 'ʃˈAn' });
    expect(respellingForms('MY-rə', 'Myra')?.ipa).toBe('mˈIɹə');
    // A lower-case word keeps its lower case (a made-up common noun).
    expect(respellingForms('ZEE-thra', 'zithra')?.say).toBe('zee-thra');
    for (const say of ['NEF-iss', 'say-SHAHN', 'kə-SAN-drə', 'CHAYN-jing STAR', 'OY-ster', 'THOO-lə', 'ROO-kwah']) {
      const ipa = respellingForms(say, 'X')?.ipa;
      expect(ipa && isKokoroPhonemes(ipa), say).toBe(true);
    }
  });

  it('keeps phonemes the user typed, and regex entries as they are', () => {
    expect(engineEntry({ match: 'Nephis', say: 'NEF-iss', ipa: 'nˈɛfɪs' })).toEqual({ match: 'Nephis', say: 'Nef-iss', ipa: 'nˈɛfɪs' });
    expect(engineEntry({ match: 'Nephis', say: 'Neffis' })).toEqual({ match: 'Nephis', say: 'Neffis' });
    expect(engineEntry({ match: 'Lv\\.', say: 'LEV-əl', regex: true })).toEqual({ match: 'Lv\\.', say: 'LEV-əl', regex: true });
  });

  it('converts each lexicon once (the front-end caches by identity) and leaves options without lexicons alone', () => {
    const l = lex({ match: 'Nephis', say: 'NEF-iss' });
    expect(engineLexicon(l)).toBe(engineLexicon(l));
    const opts: { title: string; lexicons?: Lexicon[] } = { title: 'x' };
    expect(withUserPronunciations(opts)).toBe(opts);
    expect(withUserPronunciations({ lexicons: [l, null] }).lexicons).toEqual([{ schemaVersion: 1, entries: [{ match: 'Nephis', say: 'Nef-iss', ipa: 'nˈɛfɪs' }] }, null]);
  });
});

describe('at narration time (speechScript)', () => {
  const NOVEL = lex({ match: 'Nephis', say: 'NEF-iss' }, { match: 'Seishan', say: 'say-SHAHN' }, { match: 'Sunny', say: 'Sonny' });

  it('replaces whole words in any case, possessives included, never parts of other words', () => {
    const s = speechScript(blocksOf(['Nephis looked at NEPHIS’s sword, then at nephis\'s cloak and the Nephisian banner.']), { lexicons: [NOVEL] });
    const it0 = s.items[0];
    // (The front-end reads curly apostrophes as straight ones.)
    expect(it0?.text).toBe("Nef-iss looked at Nef-iss's sword, then at Nef-iss's cloak and the Nephisian banner.");
    // Kokoro: the stress respelling's phonemes as runs, the rest as text for its G2P.
    expect(it0?.runs?.filter((r) => r.p).map((r) => r.p)).toEqual(['nˈɛfɪs', 'nˈɛfɪs', 'nˈɛfɪs']);
    expect(it0?.runs?.map((r) => r.t ?? '').join('')).toContain('Nephisian');
  });

  it('feeds every engine its form: plain respelling (Apple, Pocket raw form), phonemes (Kokoro)', () => {
    const s = speechScript(blocksOf(['“Seishan,” Sunny whispered, “wait for me.”']), { lexicons: [NOVEL] });
    const it0 = s.items[0];
    expect(it0?.text).toContain('Say-shahn');
    expect(it0?.text).toContain('Sonny');
    expect(it0?.runs?.some((r) => r.p === 'sAʃˈɑn')).toBe(true);
    // The raw form a Nephis pack reads ("text": "raw") carries the same plain respelling.
    expect(rawText('Seishan and Nephis.', { lexicons: [engineLexicon(NOVEL)] })).toBe('Say-shahn and Nef-iss.');
    const raws = s.items.map((i) => i.delivery?.raw ?? i.text).join(' ');
    expect(raws).not.toMatch(/SHAHN|NEF/u);
  });

  it('never changes the displayed text: offsets still point at the words as written', () => {
    const blocks = blocksOf(['Nephis smiled.', 'Sunny didn’t.']);
    const before = blocks.map((b) => b.text);
    const s = speechScript(blocks, { lexicons: [NOVEL] });
    expect(blocks.map((b) => b.text)).toEqual(before);
    expect(s.items.map((i) => blocks[i.block]?.text.slice(i.start, i.end))).toEqual(['Nephis smiled.', 'Sunny didn’t.']);
    expect(s.items.map((i) => i.text)).toEqual(['Nef-iss smiled.', "Sonny didn't."]);
  });

  it('a novel’s entry wins over the global one, and both over the built-in interjections', () => {
    const store = {
      schemaVersion: 1 as const,
      global: lex({ match: 'Nephis', say: 'NEE-fiss' }, { match: 'Cassie', say: 'KASS-ee' }, { match: 'Hmm', say: 'HUM' }),
      novels: { 'demo:novel/a': lex({ match: 'nephis', say: 'NEF-iss' }) },
    };
    const text = (key: string | undefined): string | undefined =>
      speechScript(blocksOf(['Hmm, Nephis and Cassie.']), { lexicons: lexiconsFor(store, key) }).items[0]?.text;
    // The capital follows the entry's word as typed ("nephis": lower case).
    expect(text('demo:novel/a')).toBe('Hum, nef-iss and Kass-ee.');
    expect(text('demo:novel/b')).toBe('Hum, Nee-fiss and Kass-ee.');
    expect(text(undefined)).toBe('Hum, Nee-fiss and Kass-ee.');
    expect(speechScript(blocksOf(['Hmm, Nephis.'])).items[0]?.text).toBe('hmm, Nephis.');
  });

  it('wins over a word the narrator would otherwise read as a heteronym (the word is gone before native sees it)', () => {
    const s = speechScript(blocksOf(['Lead walked in, and the wind rose.']), { lexicons: [lex({ match: 'Lead', say: 'LEED' })] });
    expect(s.items[0]?.text).toBe('Leed walked in, and the wind rose.');
    expect(s.items[0]?.runs?.find((r) => r.p)?.p).toBe('lˈid');
  });
});

describe('the reader’s “Set pronunciation…”', () => {
  it('takes the word out of a selection', () => {
    expect(pronounceTarget('Nephis')).toBe('Nephis');
    expect(pronounceTarget('  “Nephis,” ')).toBe('Nephis');
    expect(pronounceTarget('Nephis’s')).toBe('Nephis');
    expect(pronounceTarget("Nephis's")).toBe('Nephis');
    expect(pronounceTarget('Cassius’')).toBe('Cassius');
    expect(pronounceTarget('Changing Star.')).toBe('Changing Star');
    expect(pronounceTarget("don't")).toBe("don't");
    expect(pronounceTarget('She walked into the hall slowly')).toBeNull();
    expect(pronounceTarget('…')).toBeNull();
    expect(pronounceTarget('')).toBeNull();
  });

  it('finds the entry narration uses (the novel’s first)', () => {
    const global = lex({ match: 'Nephis', say: 'NEE-fiss' }, { match: 'Sunny', say: 'SUN-ee' });
    const novel = lex({ match: 'nephis', say: 'NEF-iss' });
    expect(findEntry(global, novel, 'NEPHIS')).toEqual({ entry: { match: 'nephis', say: 'NEF-iss' }, scope: 'novel' });
    expect(findEntry(global, novel, 'sunny')).toEqual({ entry: { match: 'Sunny', say: 'SUN-ee' }, scope: 'global' });
    expect(findEntry(global, null, 'Cassie')).toBeNull();
  });

  it('saves per novel or for all novels, replacing the same word', () => {
    const lists = { global: lex({ match: 'Sunny', say: 'SUN-ee' }), novel: lex({ match: 'Nephis', say: 'Neffis' }, { match: 'Cassie', say: 'KASS-ee' }) };
    expect(savePronunciation(lists, 'nephis', 'NEF-iss', false)).toEqual({ novel: lex({ match: 'Cassie', say: 'KASS-ee' }, { match: 'nephis', say: 'NEF-iss' }) });
    expect(savePronunciation({ ...lists, novel: null }, 'Nephis', 'NEF-iss', false)).toEqual({ novel: lex({ match: 'Nephis', say: 'NEF-iss' }) });
    // For all novels: into the global list, and out of this novel's (its entry would still win here).
    expect(savePronunciation(lists, 'Nephis', ' NEF-iss ', true)).toEqual({
      global: lex({ match: 'Sunny', say: 'SUN-ee' }, { match: 'Nephis', say: 'NEF-iss' }),
      novel: lex({ match: 'Cassie', say: 'KASS-ee' }),
    });
    expect(savePronunciation(lists, 'Seishan', 'say-SHAHN', true)).toEqual({ global: lex({ match: 'Sunny', say: 'SUN-ee' }, { match: 'Seishan', say: 'say-SHAHN' }) });
    expect(removePronunciation(lists, 'CASSIE', 'novel')).toEqual({ novel: lex({ match: 'Nephis', say: 'Neffis' }) });
    expect(removePronunciation(lists, 'sunny', 'global')).toEqual({ global: lex() });
  });

  it('checks the respelling', () => {
    expect(respellingProblem('')).toMatch(/how it should sound/u);
    expect(respellingProblem('---')).toMatch(/letters/u);
    expect(respellingProblem('NEF-iss')).toBeNull();
  });
});
