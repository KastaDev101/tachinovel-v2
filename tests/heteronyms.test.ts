/**
 * Heteronyms (ios/App/HDVoice/Sources/HDVoiceCore/Heteronyms.swift): words spelled the same but said differently,
 * resolved on the phone before Kokoro and Nephis's Pocket voice read a sentence. The rules are data
 * (HeteronymTable.swift, a JSON table); this test checks the table and runs the sentence corpus
 * (tests/fixtures/heteronyms-corpus.json) through a mirror of the Swift rule reader without Apple's tagger, so the
 * rules can be worked on on the PC. CI's HeteronymsTests run the same corpus through the Swift code (with and without
 * NLTagger); keep the two readers in step.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const swiftTable = readFileSync(path.join(root, 'ios/App/HDVoice/Sources/HDVoiceCore/HeteronymTable.swift'), 'utf8');
const sceneReader = readFileSync(path.join(root, 'ios/App/App/Native/Voice/SceneReader.swift'), 'utf8');

interface Rule {
  say?: string;
  use?: string;
  prev?: string[];
  prev2?: string[];
  prevRaw?: string[];
  next?: string[];
  next2?: string[];
  notPrev?: string[];
  notPrev2?: string[];
  notNext?: string[];
  has?: string[];
  hasNot?: string[];
  tag?: string[];
  prevTag?: string[];
  nextTag?: string[];
  tense?: 'past' | 'present';
  capital?: boolean;
  upper?: boolean;
  guess?: boolean;
}
interface Entry {
  variants: Record<string, { kokoro: string; pocket?: string }>;
  default: string;
  kokoroSays?: string;
  kokoroSaysCapital?: string;
  rules: Rule[];
}
interface Table {
  version: number;
  sets: Record<string, string[]>;
  templates: Record<string, Rule[]>;
  words: Record<string, Entry>;
}
interface Sample {
  word: string;
  say: string;
  text: string;
  nth?: number;
  /** Needs Apple's part-of-speech tagger (checked on CI only). */
  tagger?: boolean;
}

const json = /static let tableJSON = #"""\n([\s\S]*?)\n"""#/.exec(swiftTable)?.[1];
const table = JSON.parse(json ?? 'null') as Table;
const corpus = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/heteronyms-corpus.json'), 'utf8')) as Sample[];

// ---------------------------------------------------------------- mirror of Heteronyms.Table.resolve (no tagger)

function expand(list: readonly string[], seen: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  for (const item of list) {
    if (!item.startsWith('@')) {
      out.add(item);
      continue;
    }
    const name = item.slice(1);
    const members = table.sets[name];
    if (!members) throw new Error(`unknown set ${item}`);
    if (seen.has(name)) throw new Error(`set ${item} includes itself`);
    for (const m of expand(members, new Set([...seen, name]))) out.add(m);
  }
  return out;
}
const named = (name: string) => expand([`@${name}`]);
const pronounS = named('pronounS');
const adverbs = named('adverbs');
const lyWords = named('lyWords');
const pastWords = named('pastWords');
const presentWords = named('presentWords');
const notPast = named('notPast');
const CLITICS = new Set(["'ve", "'d", "'ll", "'re", "'m"]);

function member(word: string, set: ReadonlySet<string>): boolean {
  if (set.has(word)) return true;
  if (word.startsWith('$')) return false;
  if (word.endsWith("'s")) return pronounS.has(word.slice(0, -2)) ? set.has("'s") : set.has('$possessive');
  const a = word.lastIndexOf("'");
  if (a > 0) {
    const clitic = word.slice(a);
    return CLITICS.has(clitic) && set.has(clitic);
  }
  return false;
}
const isAdverb = (w: string) => adverbs.has(w) || ([...w].length >= 5 && w.endsWith('ly') && !lyWords.has(w));

interface Token {
  word: string;
  capitalized: boolean;
  breakBefore: boolean;
  hyphenBefore: boolean;
  sentence: number;
}
function tokenize(text: string): Token[] {
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
  const out: Token[] = [];
  let gapStart = 0;
  let sentence = 0;
  for (const m of text.matchAll(re)) {
    const gap = text.slice(gapStart, m.index);
    const first = out.length === 0;
    if (!first && /[.!?…]/.test(gap)) sentence++;
    out.push({
      word: m[0].toLowerCase().replace(/’/g, "'"),
      capitalized: /^\p{Lu}/u.test(m[0]),
      breakBefore: first || (gap !== '-' && /\S/.test(gap)),
      hyphenBefore: !first && gap === '-',
      sentence,
    });
    gapStart = m.index + m[0].length;
  }
  return out;
}

type Compiled = Omit<Rule, 'prev' | 'prev2' | 'prevRaw' | 'next' | 'next2' | 'notPrev' | 'notPrev2' | 'notNext' | 'has' | 'hasNot'> & {
  [K in 'prev' | 'prev2' | 'prevRaw' | 'next' | 'next2' | 'notPrev' | 'notPrev2' | 'notNext' | 'has' | 'hasNot']?: Set<string>;
};
const LISTS = ['prev', 'prev2', 'prevRaw', 'next', 'next2', 'notPrev', 'notPrev2', 'notNext', 'has', 'hasNot'] as const;
function flatten(rules: readonly Rule[], depth = 0): Rule[] {
  if (depth >= 4) throw new Error('templates nested too deep');
  return rules.flatMap((r) => {
    if (!r.use) return [r];
    const t = table.templates[r.use];
    if (!t) throw new Error(`unknown template ${r.use}`);
    return flatten(t, depth + 1);
  });
}
function compile(word: string, e: Entry): Compiled[] {
  return flatten(e.rules).map((r) => {
    if (!r.say || !e.variants[r.say]) throw new Error(`${word}: rule says ${r.say ?? 'nothing'}`);
    const c: Compiled = { ...r } as Compiled;
    for (const k of LISTS) if (r[k]) c[k] = expand(r[k]);
    return c;
  });
}
const compiled = new Map(Object.entries(table.words).map(([w, e]) => [w, compile(w, e)]));

function tenseOf(words: readonly string[]): string | null {
  let past = 0;
  let present = 0;
  for (const w of words) {
    if (member(w, pastWords) || ([...w].length >= 4 && w.endsWith('ed') && !notPast.has(w))) past++;
    if (member(w, presentWords)) present++;
  }
  return past > present ? 'past' : present > past ? 'present' : null;
}

/** [word, variant, decided by] per heteronym of `text`, as the Swift reader gives them without a tagger. */
function resolve(text: string): { word: string; say: string; by: string }[] {
  const tokens = tokenize(text);
  const prevIndex = (i: number) => {
    if (tokens[i]!.breakBefore) return -1;
    let j = i - 1;
    while (j >= 0 && isAdverb(tokens[j]!.word)) {
      if (tokens[j]!.breakBefore) return -1;
      j--;
    }
    return j;
  };
  const out: { word: string; say: string; by: string }[] = [];
  tokens.forEach((tok, i) => {
    const entry = table.words[tok.word];
    const rules = compiled.get(tok.word);
    if (!entry || !rules) return;
    if (i + 1 < tokens.length && tokens[i + 1]!.hyphenBefore) return;
    const p = prevIndex(i);
    const p2 = p < 0 ? -1 : prevIndex(p);
    const n = i + 1 < tokens.length && !tokens[i + 1]!.breakBefore ? i + 1 : -1;
    const n2 = n < 0 || n + 1 >= tokens.length || tokens[n + 1]!.breakBefore ? -1 : n + 1;
    const prev = p < 0 ? '$start' : tokens[p]!.word;
    const prev2 = p2 < 0 ? '$start' : tokens[p2]!.word;
    const prevRaw = tok.breakBefore ? '$start' : tokens[i - 1]!.word;
    const next = n < 0 ? '$end' : tokens[n]!.word;
    const next2 = n2 < 0 ? '$end' : tokens[n2]!.word;
    const same = tokens.filter((t, k) => k !== i && t.sentence === tok.sentence).map((t) => t.word);
    let say = entry.default;
    let by = 'fallback';
    for (const r of rules) {
      if (r.prev && !member(prev, r.prev)) continue;
      if (r.prev2 && !member(prev2, r.prev2)) continue;
      if (r.prevRaw && !member(prevRaw, r.prevRaw)) continue;
      if (r.next && !member(next, r.next)) continue;
      if (r.next2 && !member(next2, r.next2)) continue;
      if (r.notPrev && member(prev, r.notPrev)) continue;
      if (r.notPrev2 && member(prev2, r.notPrev2)) continue;
      if (r.notNext && member(next, r.notNext)) continue;
      if (r.has && !same.some((w) => member(w, r.has!))) continue;
      if (r.hasNot && same.some((w) => member(w, r.hasNot!))) continue;
      if (r.capital && !(tok.capitalized && prev !== '$start' && prevRaw !== '$start')) continue;
      if (r.upper && !tok.capitalized) continue;
      if (r.tense && tenseOf(same) !== r.tense) continue;
      if (r.tag || r.prevTag || r.nextTag) continue; // no tagger here
      say = r.say!;
      by = r.guess ? 'guess' : 'rule';
      break;
    }
    out.push({ word: tok.word, say, by });
  });
  return out;
}

// ---------------------------------------------------------------- tests

/** The words Kasta listed (2026-10-13). */
const CORE = [
  'read', 'lead', 'live', 'tear', 'wind', 'bow', 'close', 'use', 'record', 'present', 'object', 'content', 'minute', 'wound', 'desert',
  'refuse', 'permit', 'project', 'produce', 'row', 'bass', 'dove', 'sow', 'polish', 'separate', 'estimate', 'moderate', 'invalid', 'does',
];

describe('heteronym table', () => {
  it('is in HeteronymTable.swift and compiles: sets, templates, variants, defaults', () => {
    expect(table?.version).toBe(1);
    for (const [word, e] of Object.entries(table.words)) {
      expect(word, word).toBe(word.toLowerCase());
      expect(e.variants[e.default], `${word}: default`).toBeDefined();
      for (const says of [e.kokoroSays, e.kokoroSaysCapital]) if (says) expect(e.variants[says], `${word}: kokoroSays ${says}`).toBeDefined();
      expect(Object.keys(e.variants).length, `${word}: two sayings`).toBeGreaterThanOrEqual(2);
      for (const [name, v] of Object.entries(e.variants)) {
        expect(v.kokoro, `${word}.${name}`).toMatch(/^\S+$/);
        expect(v.kokoro, `${word}.${name}: misaki marks stress`).toMatch(/[ˈˌ]/);
      }
      const kokoros = new Set(Object.values(e.variants).map((v) => v.kokoro));
      expect(kokoros.size, `${word}: variants sound different`).toBe(Object.keys(e.variants).length);
      expect(() => compile(word, e)).not.toThrow();
    }
    for (const w of CORE) expect(table.words[w], w).toBeDefined();
  });

  it('respells for Pocket the way the on-device AI does (SceneReader.homographs)', () => {
    const ai = [...sceneReader.matchAll(/"(\w+)": Homograph\(question: "(?:[^"\\]|\\.)*", yes: (nil|"\w+"), no: (nil|"\w+")\)/g)];
    expect(ai.length).toBeGreaterThanOrEqual(8);
    for (const [, word, yes, no] of ai) {
      const said = [yes, no].filter((x) => x !== 'nil').map((x) => x!.slice(1, -1)).sort();
      const pocket = Object.values(table.words[word!]!.variants).flatMap((v) => (v.pocket ? [v.pocket] : [])).sort();
      expect(pocket, word).toEqual(said);
    }
  });
});

describe('heteronym corpus', () => {
  it('has at least 40 sentences and both readings of every core word', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(40);
    for (const w of CORE) {
      const said = new Set(corpus.filter((c) => c.word === w).map((c) => c.say));
      expect(said.size, w).toBeGreaterThanOrEqual(2);
    }
    for (const c of corpus) expect(table.words[c.word]?.variants[c.say], `${c.word}/${c.say}`).toBeDefined();
  });

  it('every sentence that needs no tagger is read right by the rules alone', () => {
    const misses = corpus
      .filter((c) => !c.tagger)
      .flatMap((c) => {
        const r = resolve(c.text).filter((x) => x.word === c.word)[c.nth ?? 0];
        return r?.say === c.say ? [] : [`${c.word}: wanted ${c.say}, got ${r?.say ?? 'nothing'} (${r?.by ?? '-'}): ${c.text}`];
      });
    expect(misses).toEqual([]);
  });

  it('leaves hyphenated compounds and other words alone', () => {
    expect(resolve('A close-up of the live-action scene.')).toEqual([]);
    expect(resolve('She closed the reading room.')).toEqual([]);
    expect(resolve('He was well-read.')).toEqual([{ word: 'read', say: 'red', by: 'rule' }]);
  });

  it('skips adverbs to find the verb before ("had already read")', () => {
    expect(resolve('She had already read it.')[0]?.say).toBe('red');
    expect(resolve('You will never read it.')[0]?.say).toBe('reed');
    expect(resolve('It came dangerously close.')[0]?.say).toBe('klohs');
  });
});
