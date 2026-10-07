/**
 * The pronunciation dictionary at synthesis time (text prep). Same entry format as v1's lexicon (the PC
 * narrator's: match → `say` respelling and/or `ipa` Kokoro phonemes), applied as whole-word, case-aware
 * replacements:
 *
 *  - a match with capitals is a name or an acronym: it matches as written, Capitalized and in CAPITALS
 *    ("Will" fixes the name, never "will"); an all-lowercase match matches any case ("tsk", "Tsk", "TSK");
 *    `caseSensitive` matches exactly; `regex` entries are patterns (as in v1);
 *  - possessives come along: "Nephis's" → the respelling + "'s", or the phonemes + /ɪz/;
 *  - the longest match wins ("Changing Star" before "Star"); later lexicons override earlier ones per word.
 *
 * Engines: the Apple voice and Chatterbox read `say` (as text); Kokoro gets `ipa` as phoneme runs when the
 * entry has phonemes, else the respelling as text (speech-script.ts). A respelling written with stressed
 * syllables in capitals ("NEF-iss") is read in lower case, so no engine spells "NEF" out letter by letter.
 */
import { mergeLexicons, type Lexicon, type LexiconEntry, type Piece } from '@v1tts/frontend.ts';

/**
 * Built in, lowest priority: web-novel interjections (v1's list, matched in any case) and common LitRPG /
 * cultivation terms. Nothing novel-specific; the user's global and per-novel lists override any of these.
 */
export const BUILTIN_LEXICON: Lexicon = {
  schemaVersion: 1,
  entries: [
    { match: 'tsk', say: 'tsk', ipa: 'tˈɪsk', note: 'tongue click' },
    { match: 'tch', say: 'tch', ipa: 'tʃ', note: 'annoyed click' },
    { match: 'hmph', say: 'hmf', ipa: 'hˈʌmf' },
    { match: 'pfft', say: 'pfft', ipa: 'pft' },
    { match: 'mhm', say: 'mm-hmm', ipa: 'mˌhˈʌm' },
    { match: 'hmm', say: 'hmm', ipa: 'hˈʌm' },
    { match: 'ugh', say: 'ugh', ipa: 'ˈʌɡ' },
    { match: 'heh', say: 'heh', ipa: 'hˈɛ' },
    { match: 'LitRPG', say: 'lit R P G' },
    { match: 'GameLit', say: 'game lit' },
    { match: 'MMORPG', say: 'M M O R P G' },
    { match: 'MMO', say: 'M M O' },
    { match: 'RPG', say: 'R P G' },
    { match: 'NPC', say: 'N P C' },
    { match: 'NPCs', say: 'N P Cs' },
    { match: 'PvP', say: 'P V P' },
    { match: 'PvE', say: 'P V E' },
    { match: 'AoE', say: 'A O E' },
    { match: 'DPS', say: 'D P S' },
    { match: 'qi', say: 'chee', note: 'life energy (cultivation)' },
    { match: 'dantian', say: 'dahn-tyen' },
    { match: 'Dao', say: 'dow' },
    { match: 'Xianxia', say: 'shyen-shyah' },
    { match: 'Wuxia', say: 'woo-shyah' },
    { match: 'Xuanhuan', say: 'shwen-hwahn' },
    { match: 'Jianghu', say: 'jyahng-hoo' },
  ],
};

export interface CompiledEntry {
  re: RegExp;
  entry: LexiconEntry;
  say?: string;
  ipa?: string;
  /** The match may carry a possessive "'s" that isn't part of the entry. */
  possessive: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Engine text of a respelling. Stressed syllables in capitals ("NEF-iss", "ka-SEE-us") are lowered:
 * engines spell an all-caps chunk out as letters. Anything else is kept as typed ("Neffis", "lit R P G").
 */
export function sayText(say: string): string {
  const chunks = say.split(/[-\s]+/).filter(Boolean);
  const stressCaps = chunks.length > 1 && chunks.some((c) => c.length >= 2 && /^\p{Lu}+$/u.test(c)) && chunks.some((c) => /\p{Ll}/u.test(c));
  return stressCaps ? say.toLowerCase() : say;
}

/** Case forms a match with capitals stands for: as written, Capitalized, CAPITALS. */
function caseForms(match: string): string[] {
  const forms = new Set([match, match.charAt(0).toUpperCase() + match.slice(1), match.toUpperCase()]);
  return [...forms];
}

/** Kokoro phonemes of the possessive ending after these phonemes: /ɪz/ after a sibilant, /s/ after a voiceless stop. */
export function possessivePhonemes(ipa: string): string {
  const last = ipa.replace(/[ˈˌːᵊ\s]+$/u, '').slice(-1);
  if ('szʃʒʧʤ'.includes(last)) return 'ɪz';
  if ('ptkfθ'.includes(last)) return 's';
  return 'z';
}

const LETTER_START = /^[\p{L}\p{N}]/u;
const LETTER_END = /[\p{L}\p{N}]$/u;

function compileEntry(entry: LexiconEntry): CompiledEntry | null {
  if (!entry.match || (!entry.say && !entry.ipa)) return null;
  let src: string;
  let flags: string;
  let possessive = false;
  if (entry.regex) {
    src = entry.match;
    flags = entry.caseSensitive ? 'gu' : 'giu';
  } else {
    // Exact for caseSensitive; a name/acronym (has capitals) in its three forms; lowercase in any case.
    const named = !entry.caseSensitive && /\p{Lu}/u.test(entry.match);
    const forms = named ? caseForms(entry.match) : [entry.match];
    flags = entry.caseSensitive || named ? 'gu' : 'giu';
    const pre = LETTER_START.test(entry.match) ? String.raw`(?<![\p{L}\p{N}])` : '';
    possessive = LETTER_END.test(entry.match) && !/['’]s$/i.test(entry.match);
    // Word end, or a possessive ("Nephis's", "Nephis’s") that comes along with the word.
    const end = String.raw`(?![\p{L}\p{N}])`;
    const post = LETTER_END.test(entry.match) ? (possessive ? `(?:['’]s${end}|${end})` : end) : '';
    src = `${pre}(?:${forms.map(escapeRe).join('|')})${post}`;
  }
  try {
    const out: CompiledEntry = { re: new RegExp(src, flags), entry, possessive };
    if (entry.say) out.say = sayText(entry.say);
    if (entry.ipa) out.ipa = entry.ipa;
    return out;
  } catch {
    return null; // an invalid user regex: skipped (validateLexicon reports it)
  }
}

export interface CompiledLexicon {
  /** Longest match first. */
  entries: CompiledEntry[];
  /** Any literal entry, case-insensitive: a quick "nothing to do here" test for most sentences. */
  any: RegExp | null;
  /** Pattern entries run on every text (they can't join the quick test). */
  hasPatterns: boolean;
}

let builtin: CompiledLexicon | null = null;

/** Lexicons merged (BUILTIN_LEXICON first, then the given ones, later wins per word) and compiled. */
export function compileLexicons(lexicons: readonly (Lexicon | null | undefined)[]): CompiledLexicon {
  const plain = lexicons.every((l) => !l || l.entries.length === 0);
  if (plain && builtin) return builtin;
  const merged = mergeLexicons(BUILTIN_LEXICON, ...lexicons);
  const entries = [...merged.entries]
    .sort((a, b) => b.match.length - a.match.length)
    .map(compileEntry)
    .filter((e): e is CompiledEntry => e !== null);
  // The quick test only has to find candidates: the words themselves, any case, no boundaries (fast).
  const literals = entries.filter((e) => !e.entry.regex).map((e) => escapeRe(e.entry.match));
  const out: CompiledLexicon = { entries, any: literals.length > 0 ? new RegExp(literals.join('|'), 'iu') : null, hasPatterns: entries.some((e) => e.entry.regex) };
  if (plain) builtin = out;
  return out;
}

/** Cut the dictionary's words out of a text as their own pieces (with `say`/`ipa`); the rest stays plain. */
export function applyLexicon(text: string, lex: CompiledLexicon): Piece[] {
  if (!lex.hasPatterns && !lex.any?.test(text)) return [{ text }];
  let pieces: Piece[] = [{ text }];
  for (const { re, say, ipa, possessive: canOwn } of lex.entries) {
    const next: Piece[] = [];
    for (const p of pieces) {
      if (p.say !== undefined || p.ipa !== undefined) {
        next.push(p);
        continue;
      }
      re.lastIndex = 0;
      if (!re.test(p.text)) {
        next.push(p);
        continue;
      }
      re.lastIndex = 0;
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(p.text)) !== null) {
        if (m[0] === '') {
          re.lastIndex++;
          continue;
        }
        if (m.index > last) next.push({ text: p.text.slice(last, m.index) });
        const possessive = canOwn && /['’]s$/.test(m[0]);
        const o: Piece = { text: m[0] };
        if (say) o.say = possessive ? `${say}'s` : say;
        if (ipa) o.ipa = possessive ? ipa + possessivePhonemes(ipa) : ipa;
        next.push(o);
        last = m.index + m[0].length;
      }
      if (last < p.text.length) next.push({ text: p.text.slice(last) });
    }
    pieces = next;
  }
  return pieces;
}
