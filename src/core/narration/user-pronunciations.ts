/**
 * The user's own pronunciations ("Set pronunciation…" in the reader, Settings › Voices › Pronunciations), as each
 * voice engine needs them. Kasta, 2026-10-14: novels have made-up names the narrator says wrong (Nephis, Seishan,
 * Sunny, Cassie); the reader types how a name should sound, per novel or for every novel.
 *
 * Entries live in the existing pronunciation store (core `narration.lexicon.get/set`, synced
 * `narration-lexicons.json`, v1 frontend.ts Lexicon, schemaVersion 1): the novel's list keyed "<pluginId>:<novelPath>"
 * and the global list. A novel's entry wins over a global one for the same word (lexiconsFor: global first, novel
 * last; mergeLexicons: later wins).
 *
 * People write a respelling the way dictionaries and Wikipedia do: syllables split by hyphens, the stressed one in
 * capitals ("NEF-iss", "say-SHAHN", "KASS-ee"). Read as it is, that hurts every engine: capitals look like an acronym
 * or shouting (the director calms CAPS for Nephis, Kokoro's G2P may spell them out) and the stress is lost. So at
 * narration time a stress respelling becomes
 *   say   the plain form for Pocket/Nephis, the Apple voice and Kokoro's text: lower case, hyphens kept, a capital
 *         first letter when the word is a name ("Nef-iss", "Say-shahn");
 *   ipa   Kokoro (misaki) phonemes with the stress where the capitals were ("nˈɛfɪs", "sAʃˈɑn"), unless the entry
 *         already has phonemes of its own; nil when the respelling uses letters the key below doesn't know (Kokoro then
 *         reads the plain form with its own G2P).
 * Anything that isn't a stress respelling ("Neffis", "Nef-iss") is left exactly as typed.
 *
 * THE HOOK (one line, speech-script.ts speechScript(): `opts = withUserPronunciations(opts)`) runs before the
 * front-end (buildScript) and the raw form (raw-text.ts) see the lexicons, so it covers every path that builds a
 * script: Listen from the reader (speech-dom.ts), the core's lock-screen auto-continue and Prepare for the drive
 * (core.ts narration.chapterText). The front-end cuts user entries out of the text before any rule runs, so they
 * win over its normalization and built-in interjections; the native layers that come after (HDVoiceCore Heteronyms,
 * SceneReader's homograph senses, NephisFlow's respell list) only ever see the user's respelling, never the word, so
 * the user's entry wins there too. The DISPLAYED text never changes: only the script's spoken text, runs and raw
 * form carry the respelling (offsets stay on the original words).
 *
 * Pure ES2023, no DOM: runs in the core (JSContext) and the UI.
 */
import { isKokoroPhonemes, type Lexicon, type LexiconEntry } from '@v1tts/frontend.ts';

// ---------------------------------------------------------------- stress respellings

/** One syllable of a respelling: its letters (lower case) and stress (0 none, 1 primary, 2 secondary). */
export interface RespelledSyllable {
  letters: string;
  stress: 0 | 1 | 2;
}

/** Words of a respelling (split by spaces), each a list of syllables (split by hyphens, dots or middle dots). */
export type Respelling = RespelledSyllable[][];

const LETTERS = /^[a-zA-Zə']+$/u;
const isCaps = (s: string): boolean => /[A-Z]/u.test(s) && !/[a-z]/u.test(s);

/**
 * A respelling with its stress, or null when `say` isn't one: stress is marked by capitals on some syllables but
 * not all ("NEF-iss", "say-SHAHN"); a respelling in capitals only ("NEF-ISS", "SHAHN") stresses each word's first
 * syllable. Plain spellings ("Neffis", "Nef-iss", "nef iss") and anything with other characters return null.
 */
export function parseRespelling(say: string): Respelling | null {
  const words = say.trim().split(/\s+/u).filter(Boolean).map((w) => w.split(/[-.·‧]+/u).filter(Boolean));
  const syllables = words.flat();
  if (syllables.length === 0 || !syllables.every((s) => LETTERS.test(s) && /[a-zA-Zə]/u.test(s))) return null;
  const caps = syllables.map(isCaps);
  const someCaps = caps.some(Boolean);
  const allCaps = caps.every(Boolean);
  if (!someCaps) return null;
  // Every syllable in capitals: no stress marked, so each word's first syllable (and a single CAPS word is lowered).
  if (allCaps) return words.map((w) => w.map((s, i) => ({ letters: s.toLowerCase(), stress: i === 0 ? 1 : 0 })));
  let first = true;
  return words.map((w) =>
    w.map((s) => {
      if (!isCaps(s)) return { letters: s.toLowerCase(), stress: 0 };
      const stress = first ? 1 : 2;
      first = false;
      return { letters: s.toLowerCase(), stress };
    }),
  );
}

/** The plain form every engine can read: lower case, hyphens between syllables, a capital first letter for a name. */
export function plainRespelling(r: Respelling, capital: boolean): string {
  const s = r.map((w) => w.map((x) => x.letters.replace(/'/g, '')).join('-')).join(' ');
  return capital ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Respelling key (Wikipedia's pronunciation respelling key, US vowels) → Kokoro's misaki phonemes. Longest first.
// [spelling, stressed, unstressed (default: the same)]
const VOWELS: readonly (readonly [string, string, string?])[] = [
  ['igh', 'I'],
  ['eye', 'I'],
  ['air', 'ɛɹ'],
  ['arr', 'æɹ'],
  ['err', 'ɛɹ'],
  ['irr', 'ɪɹ'],
  ['orr', 'ɔɹ'],
  ['urr', 'ʌɹ'],
  ['ear', 'ɪɹ'],
  ['eer', 'ɪɹ'],
  ['oor', 'ʊɹ'],
  ['ahr', 'ɑɹ'],
  ['ar', 'ɑɹ'],
  ['or', 'ɔɹ'],
  ['er', 'ɜɹ', 'əɹ'],
  ['ir', 'ɜɹ', 'əɹ'],
  ['ur', 'ɜɹ', 'əɹ'],
  ['ah', 'ɑ'],
  ['aw', 'ɔ'],
  ['au', 'ɔ'],
  ['ay', 'A'],
  ['ai', 'A'],
  ['ey', 'A'],
  ['ee', 'i'],
  ['ea', 'i'],
  ['eh', 'ɛ'],
  ['ew', 'ju'],
  ['ih', 'ɪ'],
  ['oh', 'O'],
  ['oa', 'O'],
  ['oe', 'O'],
  ['oo', 'u'],
  ['uu', 'ʊ'],
  ['ow', 'W'],
  ['ou', 'W'],
  ['oy', 'Y'],
  ['oi', 'Y'],
  ['uh', 'ʌ', 'ə'],
  ['a', 'æ', 'ə'],
  ['e', 'ɛ'],
  ['i', 'ɪ'],
  ['o', 'ɑ'],
  ['u', 'ʌ', 'ə'],
  ['ə', 'ə'],
];

const CONSONANTS: readonly (readonly [string, string])[] = [
  ['tch', 'ʧ'],
  ['ch', 'ʧ'],
  ['sh', 'ʃ'],
  ['zh', 'ʒ'],
  ['th', 'θ'],
  ['dh', 'ð'],
  ['ng', 'ŋ'],
  ['nk', 'ŋk'],
  ['ph', 'f'],
  ['ck', 'k'],
  ['kh', 'k'],
  ['gh', 'ɡ'],
  ['wh', 'w'],
  ['qu', 'kw'],
  ['b', 'b'],
  ['c', 'k'],
  ['d', 'd'],
  ['f', 'f'],
  ['g', 'ɡ'],
  ['h', 'h'],
  ['j', 'ʤ'],
  ['k', 'k'],
  ['l', 'l'],
  ['m', 'm'],
  ['n', 'n'],
  ['p', 'p'],
  ['q', 'k'],
  ['r', 'ɹ'],
  ['s', 's'],
  ['t', 't'],
  ['v', 'v'],
  ['w', 'w'],
  ['x', 'ks'],
  ['z', 'z'],
];

/** "Magic e" (a syllable like "shane", "kite"): the vowel is long and the e silent. */
const MAGIC_E: Record<string, string> = { a: 'A', e: 'i', i: 'I', o: 'O', u: 'u' };
const VOWEL_LETTER = /[aeiouə]/u;
const VOWEL_PHONEME = /[AIOWYæɑɔəɛɜɪʊʌiu]/u;

/** One syllable's phonemes, the stress mark before its first vowel; null on a letter the key doesn't know. */
function syllablePhonemes(syl: RespelledSyllable, last: boolean): string | null {
  let s = syl.letters.replace(/'/g, '');
  let magic: string | undefined;
  const m = /^([^aeiouyə]*)([aeiou])([^aeiouyə]+)e$/u.exec(s);
  if (m && s.length > 2 && m[2]) {
    magic = MAGIC_E[m[2]];
    s = s.slice(0, -1);
  }
  const out: string[] = [];
  let i = 0;
  let vowelDone = false;
  while (i < s.length) {
    const rest = s.slice(i);
    const ch = s.charAt(i);
    // "y": a consonant before a vowel ("yah"), else a vowel ("my" = I; an unstressed last "-y" = the i of "happy").
    if (ch === 'y') {
      if (VOWEL_LETTER.test(s.charAt(i + 1))) out.push('j');
      else out.push(last && syl.stress === 0 && i > 0 ? 'i' : 'I');
      i++;
      continue;
    }
    const v = VOWELS.find(([sp]) => rest.startsWith(sp));
    if (v) {
      const [sp, stressed, unstressed] = v;
      out.push(magic && !vowelDone && sp.length === 1 ? magic : syl.stress === 0 ? (unstressed ?? stressed) : stressed);
      vowelDone = true;
      i += sp.length;
      continue;
    }
    const c = CONSONANTS.find(([sp]) => rest.startsWith(sp));
    if (!c) return null;
    // Doubled letters are one sound ("KASS-ee").
    if (out[out.length - 1] !== c[1]) out.push(c[1]);
    i += c[0].length;
  }
  let ph = out.join('');
  if (syl.stress > 0) {
    const at = ph.search(VOWEL_PHONEME);
    const mark = syl.stress === 1 ? 'ˈ' : 'ˌ';
    ph = at < 0 ? mark + ph : ph.slice(0, at) + mark + ph.slice(at);
  }
  return ph;
}

/** Kokoro (misaki) phonemes for a respelling, or null when it has letters the key doesn't cover. */
export function respellingToMisaki(r: Respelling): string | null {
  const words: string[] = [];
  for (const w of r) {
    let word = '';
    for (let k = 0; k < w.length; k++) {
      const syl = w[k];
      if (!syl) continue;
      const ph = syllablePhonemes(syl, k === w.length - 1 && w.length > 1);
      if (ph === null) return null;
      // A consonant doubled across the syllable break is one sound ("KASS-see").
      word += word.length > 0 && ph.length > 0 && word.endsWith(ph.charAt(0)) && !VOWEL_PHONEME.test(ph.charAt(0)) ? ph.slice(1) : ph;
    }
    words.push(word);
  }
  const out = words.join(' ');
  return isKokoroPhonemes(out) ? out : null;
}

/** What the engines get for one respelling typed for `match`; null when it isn't a stress respelling. */
export function respellingForms(say: string, match: string): { say: string; ipa: string | null } | null {
  const r = parseRespelling(say);
  if (!r) return null;
  return { say: plainRespelling(r, /^\p{Lu}/u.test(match.trim())), ipa: respellingToMisaki(r) };
}

// ---------------------------------------------------------------- the hook: lexicons as the engines need them

/** One entry as the engines need it (a stress respelling → plain `say` + Kokoro `ipa`); others unchanged. */
export function engineEntry(e: LexiconEntry): LexiconEntry {
  if (e.regex || !e.say) return e;
  const f = respellingForms(e.say, e.match);
  if (!f) return e;
  const out: LexiconEntry = { ...e, say: f.say };
  if (!e.ipa && f.ipa) out.ipa = f.ipa;
  return out;
}

const converted = new WeakMap<Lexicon, Lexicon>();

/** A lexicon as the engines need it (memoized per lexicon object: the front-end caches its compiled form by identity). */
export function engineLexicon(lex: Lexicon): Lexicon {
  const hit = converted.get(lex);
  if (hit) return hit;
  const out: Lexicon = { schemaVersion: 1, entries: lex.entries.map(engineEntry) };
  converted.set(lex, out);
  return out;
}

/**
 * THE HOOK: script options with the user's lexicons as the engines need them. Called first thing in speechScript(),
 * before buildScript (text, Kokoro runs) and rawTextReader (Nephis's raw form). Order of what decides a word's
 * pronunciation, first wins: the user's entries (novel over global) → the front-end's built-in interjections and
 * normalization → (native) heteronyms / homograph senses → NephisFlow's respell list → the engine's own G2P.
 */
export function withUserPronunciations<T extends { lexicons?: (Lexicon | undefined | null)[] }>(opts: T): T {
  const lexicons = opts.lexicons;
  if (!lexicons || lexicons.length === 0) return opts;
  return { ...opts, lexicons: lexicons.map((l) => (l ? engineLexicon(l) : l)) };
}

// ---------------------------------------------------------------- the reader's "Set pronunciation…"

/** At most this many words in a selection offered "Set pronunciation…" (a name like "Changing Star"). */
export const MAX_PRONOUNCE_WORDS = 3;
const MAX_PRONOUNCE_CHARS = 40;

/**
 * The word to pronounce from a reader selection, or null when it isn't one: surrounding quotes and punctuation
 * dropped, a possessive ("Nephis's", "Nephis’", "Nephis’s") cut back to the name, at most MAX_PRONOUNCE_WORDS words.
 */
export function pronounceTarget(selection: string): string | null {
  let s = selection.replace(/\s+/gu, ' ').trim();
  s = s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}'’]+$/u, '');
  s = s.replace(/['’]s$/iu, '').replace(/(?<=s)['’]$/iu, '').replace(/['’]+$/u, '');
  if (!s || s.length > MAX_PRONOUNCE_CHARS || !/\p{L}/u.test(s)) return null;
  if (s.split(' ').length > MAX_PRONOUNCE_WORDS) return null;
  return s;
}

/** Where a word's entry lives: the novel's list, the global one, or neither. */
export interface FoundEntry {
  entry: LexiconEntry;
  scope: 'novel' | 'global';
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The entry narration uses for `word` (the novel's wins over the global one), literal entries only. */
export function findEntry(global: Lexicon | null | undefined, novel: Lexicon | null | undefined, word: string): FoundEntry | null {
  const inNovel = novel?.entries.find((e) => !e.regex && same(e.match, word));
  if (inNovel) return { entry: inNovel, scope: 'novel' };
  const inGlobal = global?.entries.find((e) => !e.regex && same(e.match, word));
  return inGlobal ? { entry: inGlobal, scope: 'global' } : null;
}

const without = (lex: Lexicon, word: string): Lexicon => ({ schemaVersion: 1, entries: lex.entries.filter((e) => e.regex || !same(e.match, word)) });

/**
 * Save `say` for `word` in the novel's list or (allNovels) the global one. Saving for all novels also drops the
 * novel's own entry for the word (it would win and the new one would seem to do nothing); saving for one novel
 * leaves the global entry alone (the novel's wins for this novel). Returns only the lists that changed.
 */
export function savePronunciation(
  lists: { global: Lexicon; novel: Lexicon | null },
  word: string,
  say: string,
  allNovels: boolean,
): { global?: Lexicon; novel?: Lexicon } {
  const entry: LexiconEntry = { match: word.trim(), say: say.trim() };
  const novel = lists.novel ?? { schemaVersion: 1, entries: [] };
  if (allNovels) {
    const out: { global?: Lexicon; novel?: Lexicon } = { global: { schemaVersion: 1, entries: [...without(lists.global, word).entries, entry] } };
    if (novel.entries.some((e) => !e.regex && same(e.match, word))) out.novel = without(novel, word);
    return out;
  }
  return { novel: { schemaVersion: 1, entries: [...without(novel, word).entries, entry] } };
}

/** Remove `word` from the list it is in (`scope`). */
export function removePronunciation(lists: { global: Lexicon; novel: Lexicon | null }, word: string, scope: 'novel' | 'global'): { global?: Lexicon; novel?: Lexicon } {
  return scope === 'global' ? { global: without(lists.global, word) } : { novel: without(lists.novel ?? { schemaVersion: 1, entries: [] }, word) };
}

/** A respelling the save button accepts: letters, hyphens, spaces, apostrophes, dots; at most 60 characters. */
export function respellingProblem(say: string): string | null {
  const s = say.trim();
  if (!s) return 'Type how it should sound.';
  if (s.length > 60) return 'That’s too long for one word.';
  if (!/\p{L}/u.test(s)) return 'Use letters, like NEF-iss.';
  return null;
}
