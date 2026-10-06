/**
 * TachiNovel narration TEXT FRONT-END, shared by every TTS engine (PC Kokoro, on-device Kokoro,
 * cloud voices, system voices). It decides most of the perceived quality: what is read, how it is
 * said, and where the pauses go.
 *
 * Portable: plain ES2023, no DOM, no Node, no Scriptable globals. Runs in Node (PC narration), in
 * the WKWebView UI (player highlighting, on-device synthesis) and in Scriptable's JavaScriptCore.
 *
 *   chapter HTML ──htmlToBlocks──► blocks (canonical text per block)
 *                └─(UI: domBlockParts → canonicalize, same rules)
 *   blocks ──buildScript(opts, lexicon)──► segments: {block, start, end, kind, pieces, pauseAfterMs}
 *   segment ──renderPlain / renderMisaki / renderSsml──► engine input
 *
 * A segment is (usually) one sentence. `start`/`end` are offsets into the block's CANONICAL text
 * (see `canonicalize`), so the player can highlight exactly the sentence being spoken. The spoken
 * text (`pieces`) is normalized separately and never needs to map back character by character.
 */

export const FRONTEND_VERSION = 1;

// ============================================================================ canonical text

/** One run of text, or `null` for a line break (`<br>`). */
export type TextPart = string | null;

export interface Canonical {
  text: string;
  /** For each char of `text`: index into `parts` it came from (only with `withMap`). */
  partIndex?: number[];
  /** For each char of `text`: offset inside that part (a line break maps to offset 0 of its null part). */
  partOffset?: number[];
}

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/;
const WS = /[\s\u00A0\u202F\u2007\u3000]/;

/**
 * Canonical block text, identical in Node (from HTML) and in the WebView (from DOM text nodes):
 * whitespace runs → one space, `<br>` → "\n" (consecutive breaks collapse), zero-width chars and soft
 * hyphens dropped, no leading/trailing whitespace. With `withMap`, every output char records where
 * it came from so the UI can turn (start, end) back into a DOM Range.
 */
export function canonicalize(parts: readonly TextPart[], withMap = false): Canonical {
  let text = '';
  const pi: number[] = [];
  const po: number[] = [];
  let pendingSpace: [number, number] | null = null;
  const emit = (ch: string, p: number, o: number) => {
    text += ch;
    if (withMap) {
      pi.push(p);
      po.push(o);
    }
  };
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    if (part === null || part === undefined) {
      pendingSpace = null;
      if (text.length > 0 && !text.endsWith('\n')) emit('\n', p, 0);
      continue;
    }
    for (let o = 0; o < part.length; o++) {
      const ch = part.charAt(o);
      if (ZERO_WIDTH.test(ch)) continue;
      if (WS.test(ch)) {
        if (pendingSpace === null) pendingSpace = [p, o];
        continue;
      }
      if (pendingSpace !== null && text.length > 0 && !text.endsWith('\n')) emit(' ', pendingSpace[0], pendingSpace[1]);
      pendingSpace = null;
      emit(ch, p, o);
    }
  }
  while (text.endsWith('\n')) {
    text = text.slice(0, -1);
    if (withMap) {
      pi.pop();
      po.pop();
    }
  }
  return withMap ? { text, partIndex: pi, partOffset: po } : { text };
}

// ============================================================================ HTML → blocks

export interface SourceBlock {
  /** Canonical text (see canonicalize). Empty for <hr>. */
  text: string;
  /** Lower-case tag of the block element ('p', 'h2', 'li', 'hr', 'div', …; '' for loose text). */
  tag: string;
  /** Class names of the block element and its block ancestors (e.g. "author-note-after"), if any. */
  cls?: string;
}

/** Elements that start/end a block. Everything else is inline. Shared with the UI's DOM walker. */
export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'ul', 'ol', 'pre', 'section',
  'article', 'header', 'footer', 'aside', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr',
  'td', 'th', 'dl', 'dt', 'dd', 'hr', 'center', 'main', 'nav', 'details', 'summary', 'caption',
]);
/** Elements whose content is never read (and never shown by the sanitized reader). */
export const SKIP_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'template', 'noscript', 'iframe', 'object', 'svg', 'math', 'head', 'title', 'button', 'select', 'textarea',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', hellip: '…', mdash: '—',
  ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«',
  raquo: '»', middot: '·', bull: '•', times: '×', divide: '÷', copy: '©',
  reg: '®', trade: '™', deg: '°', plusmn: '±', frac12: '½', frac14: '¼',
  frac34: '¾', shy: '\u00AD', zwj: '\u200D', zwnj: '\u200C', thinsp: '\u2009', ensp: '\u2002',
  emsp: '\u2003', larr: '←', rarr: '→', uarr: '↑', darr: '↓', hearts: '♥',
  star: '☆', eacute: 'é', egrave: 'è', aacute: 'á', iacute: 'í', oacute: 'ó',
  uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä',
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/**
 * Split chapter HTML into blocks without a DOM (Node, Scriptable). The UI's DOM walker applies the
 * same BLOCK_TAGS / SKIP_TAGS rules to the sanitized chapter, so both sides see the same blocks.
 * Loose text between blocks becomes its own block (tag '').
 */
export function htmlToBlocks(html: string): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  let parts: TextPart[] = [];
  let tag = '';
  let skipDepth = 0;
  let skipTag = '';
  /** Open block elements with their classes (for author-note detection). */
  const stack: { name: string; cls: string }[] = [];
  const classes = () => stack.map((e) => e.cls).filter(Boolean).join(' ');
  const flush = (nextTag: string) => {
    const { text } = canonicalize(parts);
    if (text) {
      const cls = classes();
      blocks.push(cls ? { text, tag, cls } : { text, tag });
    }
    parts = [];
    tag = nextTag;
  };
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?)>|([^<]+)|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const [whole, closing, rawName, attrs, , textRun] = m;
    if (whole.startsWith('<!--')) continue;
    if (textRun !== undefined || whole === '<') {
      if (skipDepth === 0) parts.push(decodeEntities(textRun ?? '<'));
      continue;
    }
    const name = (rawName ?? '').toLowerCase();
    if (skipDepth > 0) {
      if (name === skipTag) skipDepth += closing ? -1 : 1;
      continue;
    }
    if (SKIP_TAGS.has(name) && !closing) {
      if (!/\/>$/.test(whole)) {
        skipDepth = 1;
        skipTag = name;
      }
      continue;
    }
    if (name === 'br') {
      parts.push(null);
      continue;
    }
    if (name === 'hr') {
      flush('');
      blocks.push({ text: '', tag: 'hr' });
      continue;
    }
    if (!BLOCK_TAGS.has(name)) continue;
    if (closing) {
      flush('');
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at >= 0) stack.length = at;
    } else {
      flush(name);
      const cm = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs ?? '');
      stack.push({ name, cls: decodeEntities(cm?.[1] ?? cm?.[2] ?? cm?.[3] ?? '').trim() });
    }
  }
  flush('');
  return blocks;
}

// ============================================================================ lexicon

/**
 * One pronunciation override. Matching is whole-word and case-insensitive unless told otherwise.
 * Engines that understand phonemes (Kokoro via misaki, on-device Kokoro) use `ipa`; every other
 * engine uses the plain-text respelling `say`. Provide at least one of them.
 */
export interface LexiconEntry {
  /** Word or phrase as it appears in the text ("Nephis", "Tsk", "Lv."). With `regex`, a pattern. */
  match: string;
  /** Respelling any engine can read ("NEF-iss" → write it as "Neffis"). */
  say?: string;
  /** Kokoro/misaki phonemes, e.g. "nˈɛfɪs" (stress marks ˈ ˌ; misaki vowels A I O W Y for eɪ aɪ oʊ aʊ ɔɪ). */
  ipa?: string;
  caseSensitive?: boolean;
  regex?: boolean;
  /** Free text shown in the editor. */
  note?: string;
}

export interface Lexicon {
  schemaVersion: 1;
  entries: LexiconEntry[];
}

/**
 * Small built-in lexicon (lowest priority): web-novel interjections engines routinely get wrong.
 * Per-novel and global user lexicons override it entry by entry (same `match`).
 */
export const DEFAULT_LEXICON: Lexicon = {
  schemaVersion: 1,
  entries: [
    { match: 'Tsk', say: 'tsk', ipa: 'tˈɪsk', note: 'tongue click; Kokoro read it "tersk" without this' },
    { match: 'Tch', say: 'tch', ipa: 'tʃ', note: 'annoyed click' },
    { match: 'Hmph', say: 'hmf', ipa: 'hˈʌmf' },
    { match: 'Pfft', say: 'pfft', ipa: 'pft' },
    { match: 'Mhm', say: 'mm-hmm', ipa: 'mˌhˈʌm' },
    { match: 'Hmm', say: 'hmm', ipa: 'hˈʌm' },
    { match: 'Ugh', say: 'ugh', ipa: 'ˈʌɡ' },
    { match: 'Heh', say: 'heh', ipa: 'hˈɛ' },
  ],
};

/** Merge lexicons; later ones win for the same `match` (compared case-insensitively). */
export function mergeLexicons(...lexicons: (Lexicon | undefined | null)[]): Lexicon {
  const byKey = new Map<string, LexiconEntry>();
  for (const lex of lexicons) {
    for (const e of lex?.entries ?? []) {
      if (!e.match || (!e.say && !e.ipa)) continue;
      const key = (e.regex ? 're:' : '') + (e.caseSensitive ? e.match : e.match.toLowerCase());
      byKey.delete(key); // keep insertion order = priority order
      byKey.set(key, e);
    }
  }
  return { schemaVersion: 1, entries: [...byKey.values()] };
}

/** Validate a user-supplied lexicon (e.g. read from JSON). Returns readable problems; empty = OK. */
export function validateLexicon(lex: unknown): string[] {
  const errs: string[] = [];
  if (typeof lex !== 'object' || lex === null) return ['lexicon must be an object'];
  const l = lex as { schemaVersion?: unknown; entries?: unknown };
  if (l.schemaVersion !== 1) errs.push('schemaVersion must be 1');
  if (!Array.isArray(l.entries)) return [...errs, 'entries must be an array'];
  l.entries.forEach((raw: unknown, i) => {
    const e = raw as Partial<LexiconEntry> | null;
    if (typeof e !== 'object' || e === null) return void errs.push(`entries[${i}] is not an object`);
    if (typeof e.match !== 'string' || !e.match.trim()) errs.push(`entries[${i}].match is empty`);
    if (!e.say && !e.ipa) errs.push(`entries[${i}] needs "say" or "ipa"`);
    if (e.ipa !== undefined && !isKokoroPhonemes(e.ipa)) errs.push(`entries[${i}].ipa has characters Kokoro can't speak`);
    if (e.regex && typeof e.match === 'string') {
      try {
        new RegExp(e.match, 'u');
      } catch {
        errs.push(`entries[${i}].match is not a valid regex`);
      }
    }
  });
  return errs;
}

/** Kokoro v1.0 phoneme vocabulary (misaki), minus punctuation. */
const KOKORO_PHONEME_CHARS =
  "AIOQSTWYabcdefhijklmnopqrstuvwxyzæçðøŋœɐɑɒɔɕɖəɚɛɜɟɡɣɤɥɨɪɯɰɲɳɴɸɹɻɽɾʁʂʃʈʊʋʌʎʒʔʝʣʤʥʦʧʨʰʲˈˌːβθχᵊᵻ ̃'-";

export function isKokoroPhonemes(s: string): boolean {
  if (!s.trim()) return false;
  for (const ch of s) if (!KOKORO_PHONEME_CHARS.includes(ch)) return false;
  return true;
}

interface CompiledEntry {
  re: RegExp;
  entry: LexiconEntry;
}

const lexCache = new WeakMap<Lexicon, CompiledEntry[]>();

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileLexicon(lex: Lexicon): CompiledEntry[] {
  const hit = lexCache.get(lex);
  if (hit) return hit;
  const out: CompiledEntry[] = [];
  // Longest literal first so "Changing Star" beats "Star".
  const entries = [...lex.entries].sort((a, b) => b.match.length - a.match.length);
  for (const entry of entries) {
    const flags = entry.caseSensitive ? 'gu' : 'giu';
    let src: string;
    if (entry.regex) src = entry.match;
    else {
      const lit = escapeRe(entry.match);
      // Word boundaries that also work for entries ending in punctuation ("Lv.", "Ch.").
      const pre = /^[\p{L}\p{N}]/u.test(entry.match) ? '(?<![\\p{L}\\p{N}])' : '';
      const post = /[\p{L}\p{N}]$/u.test(entry.match) ? '(?![\\p{L}\\p{N}])' : '';
      src = pre + lit + post;
    }
    try {
      out.push({ re: new RegExp(src, flags), entry });
    } catch {
      /* invalid user regex: skip it (validateLexicon reports it) */
    }
  }
  lexCache.set(lex, out);
  return out;
}

// ============================================================================ pieces & rendering

/** A run of speakable text. Overridden words carry the user's `say`/`ipa`. */
export interface Piece {
  text: string;
  say?: string;
  ipa?: string;
}

function applyLexicon(text: string, lex: Lexicon): Piece[] {
  let pieces: Piece[] = [{ text }];
  for (const { re, entry } of compileLexicon(lex)) {
    const next: Piece[] = [];
    for (const p of pieces) {
      if (p.say !== undefined || p.ipa !== undefined) {
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
        const o: Piece = { text: m[0] };
        if (entry.say) o.say = entry.say;
        if (entry.ipa) o.ipa = entry.ipa;
        next.push(o);
        last = m.index + m[0].length;
      }
      if (last < p.text.length) next.push({ text: p.text.slice(last) });
    }
    pieces = next;
  }
  return pieces;
}

/** Plain text for engines without phoneme input (cloud, system voices). */
export function renderPlain(pieces: readonly Piece[]): string {
  return tidySpaces(pieces.map((p) => p.say ?? p.text).join(''));
}

/**
 * misaki input for Kokoro on the PC: overrides become misaki links `[word](/phonemes/)`, which misaki
 * passes to the model verbatim. Words with only a respelling use the respelling.
 */
export function renderMisaki(pieces: readonly Piece[]): string {
  return tidySpaces(
    pieces
      .map((p) => {
        if (p.ipa) return `[${p.text.replace(/[[\]()]/g, '')}](/${p.ipa}/)`;
        return p.say ?? p.text;
      })
      .join(''),
  );
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c);
}

/** SSML fragment (Azure): respellings as <sub alias>. Pauses are added by the caller with <break>. */
export function renderSsml(pieces: readonly Piece[]): string {
  return tidySpaces(
    pieces.map((p) => (p.say ? `<sub alias="${xmlEscape(p.say)}">${xmlEscape(p.text)}</sub>` : xmlEscape(p.text))).join(''),
  );
}

/**
 * For engines that phonemize themselves (kokoro-js): text runs to phonemize, interleaved with
 * verbatim phoneme runs from the lexicon.
 */
export function renderPhonemeRuns(pieces: readonly Piece[]): { text?: string; phonemes?: string }[] {
  const out: { text?: string; phonemes?: string }[] = [];
  for (const p of pieces) {
    if (p.ipa) out.push({ phonemes: p.ipa });
    else {
      const t = p.say ?? p.text;
      const last = out[out.length - 1];
      if (last && last.text !== undefined) last.text += t;
      else out.push({ text: t });
    }
  }
  return out;
}

function tidySpaces(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\s+([,.!?;:…])/g, '$1').trim();
}

// ============================================================================ numbers

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Cardinal number in words (0 … 999 999 999 999). */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0) return String(n);
  if (n < 20) return ONES[n] ?? String(n);
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)] ?? '';
    return n % 10 ? `${t}-${ONES[n % 10] ?? ''}` : t;
  }
  if (n < 1000) {
    const rest = n % 100;
    return `${ONES[Math.floor(n / 100)] ?? ''} hundred${rest ? ' and ' + numberToWords(rest) : ''}`;
  }
  for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']] as const) {
    if (n >= size) {
      const head = Math.floor(n / size);
      const rest = n % size;
      return `${numberToWords(head)} ${name}${rest ? (rest < 100 ? ' and ' : ' ') + numberToWords(rest) : ''}`;
    }
  }
  return String(n);
}

const ORDINAL_IRREGULAR: Record<string, string> = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth',
};

export function ordinalToWords(n: number): string {
  const words = numberToWords(n);
  const m = /([a-z]+)$/.exec(words);
  if (!m?.[1]) return words;
  const last = m[1];
  let ord: string;
  if (ORDINAL_IRREGULAR[last]) ord = ORDINAL_IRREGULAR[last];
  else if (last.endsWith('y')) ord = last.slice(0, -1) + 'ieth';
  else ord = last + 'th';
  return words.slice(0, words.length - last.length) + ord;
}

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

export function romanToInt(s: string): number | null {
  if (!/^[IVXLCDM]+$/.test(s)) return null;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s.charAt(i)] ?? 0;
    const next = ROMAN[s.charAt(i + 1)] ?? 0;
    total += v < next ? -v : v;
  }
  // Reject non-canonical forms ("IIII", "VX").
  return intToRoman(total) === s ? total : null;
}

function intToRoman(n: number): string {
  const table: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, r] of table) while (n >= v) {
    out += r;
    n -= v;
  }
  return out;
}

// ============================================================================ normalization

/** Nouns after which a number (or Roman numeral) is a plain cardinal: "Chapter IV" → "Chapter 4". */
const COUNTED_NOUNS =
  'Chapter|Volume|Book|Part|Act|Season|Tier|Rank|Grade|Level|Class|Type|Phase|Stage|Floor|War|Episode|Arc|Generation|Round|Step|Gate|Circle|Realm|Layer|Mark|Model|Unit|Squad|Team|Division|Sector|Zone|Area|Room|Block|Wave|Day|Year|Lesson|Section|Article|Rule';

const UNITS: Record<string, [string, string]> = {
  km: ['kilometer', 'kilometers'], m: ['meter', 'meters'], cm: ['centimeter', 'centimeters'], mm: ['millimeter', 'millimeters'],
  kg: ['kilogram', 'kilograms'], g: ['gram', 'grams'], mg: ['milligram', 'milligrams'], lb: ['pound', 'pounds'],
  lbs: ['pound', 'pounds'], ft: ['foot', 'feet'], mi: ['mile', 'miles'], 'km/h': ['kilometer per hour', 'kilometers per hour'],
  mph: ['mile per hour', 'miles per hour'], 'm/s': ['meter per second', 'meters per second'], kph: ['kilometer per hour', 'kilometers per hour'],
  ml: ['milliliter', 'milliliters'], l: ['liter', 'liters'], s: ['second', 'seconds'], ms: ['millisecond', 'milliseconds'],
  min: ['minute', 'minutes'], hrs: ['hour', 'hours'], hr: ['hour', 'hours'],
};

/** Words in all caps that are real acronyms/initialisms and must stay as they are. */
const KEEP_CAPS = new Set([
  'HP', 'MP', 'SP', 'XP', 'EXP', 'AP', 'DP', 'NPC', 'NPCs', 'PVP', 'PVE', 'RPG', 'MMO', 'MMORPG', 'AI', 'OK', 'TV', 'CEO', 'FBI',
  'CIA', 'USA', 'UK', 'EU', 'UN', 'DNA', 'ID', 'IQ', 'BC', 'AD', 'GPS', 'CPU', 'GPU', 'VR', 'AR', 'STR', 'AGI', 'DEX',
  'INT', 'WIS', 'VIT', 'END', 'LUK', 'CHA', 'DEF', 'ATK', 'SSS', 'SS', 'S', 'A', 'B', 'C', 'D', 'E', 'F', 'I', 'II', 'III', 'IV',
  'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'RIP', 'LOL', 'DIY', 'ASAP', 'NASA', 'SWAT', 'POV', 'UFO', 'ATM', 'MVP', 'AOE', 'DPS', 'DOT',
]);

function fixCase(text: string): string {
  // Shouting: runs of 2+ all-caps words, or single all-caps words of 4+ letters that aren't acronyms.
  return text.replace(/\b[A-Z][A-Z'’]*[A-Z]\b(?:[\s,!?.…-]+\b[A-Z][A-Z'’]*\b)*/g, (run) => {
    const words = run.match(/[A-Z][A-Z'’]*/g) ?? [];
    const shout = words.length >= 2 ? words.filter((w) => !KEEP_CAPS.has(w)).length >= 2 : !KEEP_CAPS.has(run) && run.replace(/['’]/g, '').length >= 4;
    if (!shout) return run;
    return run.replace(/[A-Z][A-Z'’]*/g, (w) => (KEEP_CAPS.has(w) && w.length > 1 ? w : w.charAt(0) + w.slice(1).toLowerCase()));
  });
}

/**
 * Text-level cleanup applied to the spoken text of one segment (after lexicon overrides were cut out).
 * Exported for tests and for engines that want plain normalization of arbitrary strings.
 */
export function normalizeForSpeech(input: string, opts: { stutter?: 'drop' | 'keep' } = {}): string {
  let s = input;
  // --- characters
  s = s.replace(/[\u00A0\u202F\u2007\u3000]/g, ' ').replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '');
  s = s.replace(/[‘’‚′`´]/g, "'").replace(/[“”„″«»]/g, '"');
  s = s.replace(/[「『]/g, '"').replace(/[」』]/g, '"');
  s = s.replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
  s = s.replace(/\.{3,}|。。。/g, '…').replace(/…+/g, '…');
  s = s.replace(/(\d)\s*[–—-]\s*(\d)/g, '$1 to $2'); // ranges 10–20
  s = s.replace(/\s+-{1,2}\s+|\s*--\s*|–|―|‒/g, ' — '); // dashes → em dash
  s = s.replace(/\s*—\s*/g, ' — ');
  s = s.replace(/#(?=\d)/g, ' number ');
  s = s.replace(/[*_~=#^|]+/g, ' '); // emphasis markers, decorations
  s = s.replace(/[←⇐]|<-/g, ' from ').replace(/[→⇒➜➡]|->|=>/g, ' to ');
  s = s.replace(/[<>【】〈〉《》[\]{}]/g, ' '); // brackets (system text, skills)
  s = s.replace(/&/g, ' and ').replace(/\bw\/(?=\s)/gi, 'with').replace(/@/g, ' at ');
  s = s.replace(/[★☆♥♡♪♫•·◆◇○●■□✦✧]/g, ' ');
  s = s.replace(/[\p{Extended_Pictographic}]/gu, ' ');
  // --- punctuation runs
  s = s.replace(/!{2,}/g, '!').replace(/\?{2,}/g, '?').replace(/(?:\?!|!\?)[!?]*/g, '?!').replace(/,{2,}/g, ',');
  s = s.replace(/^[\s…,;:]+/, ''); // leading "…and then"
  // --- stutters "W-what", "I-I"
  if (opts.stutter !== 'keep') {
    s = s.replace(/\b([A-Za-z])-(?=\1)/gi, (_m, l: string) => (/[aeiouAEIOU]/.test(l) ? `${l}, ` : ''));
    s = s.replace(/\b([A-Za-z]{1,3})-(?=\1)/g, '$1… ');
  }
  // --- elongations "Ahhhhh" → "Ahhh", "Nooooo" → "Nooo"; drawn-out interjections to their dictionary
  // form so the lexicon and G2P know them ("Hmmm" was read "hemo")
  s = s.replace(/\b([Hh])m{2,}\b/g, '$1mm').replace(/\b([Uu])m{2,}\b/g, '$1m').replace(/\b([Uu])h{2,}\b/g, '$1h').replace(/\b([Mm])m{2,}\b/g, '$1mm');
  s = s.replace(/(\p{L})\1{3,}/gu, '$1$1$1');
  // --- abbreviations
  s = s.replace(/\b(?:Ch|Chap|Chp)\.\s*(?=[\dIVXLC])/g, 'Chapter ');
  s = s.replace(/\bVol\.\s*(?=[\dIVXLC])/g, 'Volume ');
  s = s.replace(/\b(?:Lv|Lvl|LV|LVL)\.?\s*(?=\d)/g, 'Level ');
  s = s.replace(/\bNo\.\s*(?=\d)/g, 'Number ').replace(/#(?=\d)/g, 'number ');
  s = s.replace(/\bpg\.\s*(?=\d)/gi, 'page ').replace(/\bpp\.\s*(?=\d)/gi, 'pages ');
  s = s.replace(/\be\.g\.,?/gi, 'for example,').replace(/\bi\.e\.,?/gi, 'that is,');
  s = s.replace(/\betc\.(?=\s*$)/g, 'et cetera.').replace(/\betc\./g, 'et cetera');
  s = s.replace(/\bvs\.?(?=\s)/gi, 'versus').replace(/\bapprox\./gi, 'approximately');
  const titles: Record<string, string> = {
    Mr: 'Mister', Mrs: 'Missus', Ms: 'Miz', Dr: 'Doctor', Prof: 'Professor', Sgt: 'Sergeant', Lt: 'Lieutenant',
    Capt: 'Captain', Gen: 'General', Col: 'Colonel', Cmdr: 'Commander', Gov: 'Governor', Rev: 'Reverend', Mt: 'Mount',
    Ft: 'Fort', Jr: 'Junior', Sr: 'Senior',
  };
  s = s.replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sgt|Lt|Capt|Gen|Col|Cmdr|Gov|Rev|Mt|Ft|Jr|Sr)\.(?=\s|$)/g, (_m, t: string) => titles[t] ?? t);
  s = s.replace(/\bSt\.(?=\s+\p{Lu})/gu, 'Saint').replace(/(?<=\p{Lu}\p{Ll}+\s)St\.?(?=[\s,.;!?]|$)/gu, 'Street');
  // --- numbers
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_m, n: string) => ordinalToWords(parseInt(n, 10)));
  s = s.replace(new RegExp(`\\b(${COUNTED_NOUNS})\\s+([IVXLC]+)\\b(?![\\p{L}'])`, 'gu'), (m, noun: string, r: string) => {
    const v = romanToInt(r);
    return v !== null ? `${noun} ${v}` : m;
  });
  // Regnal numbers after a capitalized name: "Louis XIV" → "Louis the Fourteenth" (II+ only; "I" is a pronoun).
  s = s.replace(/(?<=\b\p{Lu}\p{Ll}+\s)(II|III|IV|VI|VII|VIII|IX|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX)\b(?![\p{L}'])/gu, (m, r: string) => {
    const v = romanToInt(r);
    return v !== null ? `the ${ordinalToWords(v)}` : m;
  });
  s = s.replace(/(?<![\p{L}\d])[x×](\d+(?:\.\d+)?)\b/gu, 'times $1').replace(/\b(\d+(?:\.\d+)?)[x×](?![\p{L}\d])/gu, '$1 times');
  s = s.replace(/(^|[\s(])\+(\d)/g, '$1plus $2').replace(/(^|[\s(:])-(\d)/g, '$1minus $2');
  s = s.replace(/\b(\d[\d,]*)\s*\/\s*(\d[\d,]*)\b/g, (m, a: string, b: string) => {
    const x = parseInt(a.replace(/,/g, ''), 10);
    const y = parseInt(b.replace(/,/g, ''), 10);
    return y >= x && y > 12 ? `${a} out of ${b}` : m; // HP 100/100; leave dates and small fractions
  });
  s = s.replace(/(\d)\s*%/g, '$1 percent');
  s = s.replace(/(?<![$£€\d.,])\b(\d+(?:\.\d+)?)(\s?)(km\/h|m\/s|km|cm|mm|kg|mg|lbs?|ft|mi|mph|kph|ml|hrs?|min|ms|m|g|l|s)\b(?!\.\w)/g, (m, n: string, sp: string, u: string) => {
    const names = UNITS[u];
    if (!names) return m;
    // "1990s", "3s" (decades, plurals) are not seconds: bare "s" only counts with a space ("5 s").
    if (u === 's' && !sp) return m;
    return `${n} ${n === '1' ? names[0] : names[1]}`;
  });
  // --- case
  s = fixCase(s);
  return s.replace(/\s+/g, ' ').replace(/\s+([,.!?;:…])/g, '$1').trim();
}

// ============================================================================ sentence splitting

const ABBREV_BEFORE_DOT = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'prof', 'vs', 'etc', 'ch', 'chap', 'vol', 'no', 'lv', 'lvl', 'capt', 'lt', 'gen',
  'col', 'sgt', 'mt', 'ft', 'approx', 'pg', 'pp', 'fig', 'cmdr', 'gov', 'rev', 'e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'inc', 'ltd', 'co',
]);

const OPEN_QUOTES = '"“「『«';
const CLOSERS = '"\'”’」』»)\\]】>';

export interface Span {
  start: number;
  end: number;
}

/**
 * Sentence spans of a block's canonical text. Never splits after common abbreviations, single
 * initials ("J. K."), or before a lowercase word ("Who?" he asked). Line breaks always split.
 */
export function splitSentences(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  const push = (end: number) => {
    let a = start;
    let b = end;
    while (a < b && /\s/.test(text.charAt(a))) a++;
    while (b > a && /\s/.test(text.charAt(b - 1))) b--;
    if (b > a) spans.push({ start: a, end: b });
    start = end;
  };
  const re = new RegExp(`([.!?…。！？]+)([${CLOSERS.replace(/[\]\\]/g, '\\$&')}]*)(\\s+)|\\n`, 'gu');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '\n') {
      push(m.index);
      continue;
    }
    const after = m.index + m[0].length;
    const next = text.charAt(after);
    // Next sentence must start with an uppercase letter, digit, opening quote/bracket, or symbol.
    if (!next || !(/[\p{Lu}\p{N}[(【<*\-—]/u.test(next) || OPEN_QUOTES.includes(next) || next === "'")) continue;
    const punct = m[1] ?? '';
    if (punct === '.') {
      const before = text.slice(start, m.index);
      const word = (/([\p{L}.]+)$/u.exec(before)?.[1] ?? '').toLowerCase();
      if (ABBREV_BEFORE_DOT.has(word) || ABBREV_BEFORE_DOT.has(word.replace(/\.$/, ''))) continue;
      if (/^\p{L}$/u.test(word) && /\p{Lu}/u.test(before.slice(-1))) continue; // initials "J. K. Rowling"
      if (/^(?:\p{L}\.)+\p{L}$/u.test(word)) continue; // "U.S. Army"
    }
    push(m.index + (m[1]?.length ?? 0) + (m[2]?.length ?? 0));
  }
  push(text.length);
  return spans;
}

/** Split an over-long sentence at the clause boundary closest to its middle (repeatedly). */
function splitLong(text: string, span: Span, maxChars: number): Span[] {
  if (span.end - span.start <= maxChars) return [span];
  const s = text.slice(span.start, span.end);
  const mid = s.length / 2;
  let best = -1;
  let bestScore = Infinity;
  const re = /[;:]\s|\s—\s|,\s|\s(?:and|but|or|while|because|which|when)\s/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const cut = m[0].startsWith(' ') && /\w/.test(m[0].charAt(1)) ? m.index : m.index + m[0].trimEnd().length;
    const weight = m[0].includes(';') || m[0].includes(':') ? 0.6 : m[0].includes('—') ? 0.7 : m[0].includes(',') ? 0.85 : 1;
    const score = Math.abs(cut - mid) * weight;
    if (cut > 20 && cut < s.length - 20 && score < bestScore) {
      best = cut;
      bestScore = score;
    }
  }
  if (best < 0) {
    const sp = s.lastIndexOf(' ', Math.min(s.length - 1, maxChars));
    best = sp > 20 ? sp : maxChars;
  }
  const left: Span = { start: span.start, end: span.start + best };
  let rs = span.start + best;
  while (rs < span.end && /\s/.test(text.charAt(rs))) rs++;
  const right: Span = { start: rs, end: span.end };
  return [...splitLong(text, left, maxChars), ...splitLong(text, right, maxChars)];
}

// ============================================================================ script

export type BlockKind = 'title' | 'text' | 'system' | 'scene' | 'note' | 'empty';
export type SegmentKind = 'title' | 'text' | 'system' | 'scene';

export interface Segment {
  id: number;
  /** Index into script.blocks / the chapter's blocks. */
  block: number;
  /** [start, end) in the block's canonical text. Scene breaks span the whole (decorative) block. */
  start: number;
  end: number;
  kind: SegmentKind;
  /** Spoken as dialogue (starts inside quotation marks). */
  quoted: boolean;
  /** Spoken text, normalized, with lexicon overrides as their own pieces. Empty for scene breaks. */
  pieces: Piece[];
  /** Silence after this segment, in ms at speed 1.0 (engines scale by 1/speed). */
  pauseAfterMs: number;
  /** 24-bit FNV-1a of the segment's canonical display text, for re-aligning stale timestamps. */
  hash: number;
}

export interface ScriptBlock {
  kind: BlockKind;
  /** Lower-cased, letters/digits only, first 40 chars: identifies the block across text versions. */
  anchor: string;
}

export interface NarrationScript {
  frontendVersion: number;
  /** FNV-1a (32-bit, hex) of all block texts joined by "\n\n". */
  textHash: string;
  blocks: ScriptBlock[];
  segments: Segment[];
}

export interface PauseConfig {
  sentence: number;
  /** After a sentence ending in "…" or a dash (trailing off / interrupted). */
  trailing: number;
  paragraph: number;
  title: number;
  scene: number;
  /** Before and after a [system message] block (instead of `paragraph`). */
  system: number;
  /** Between a dialogue sentence and narration in the same paragraph. */
  speakerChange: number;
  /** Between two halves of an over-long sentence. */
  clause: number;
}

export const DEFAULT_PAUSES: PauseConfig = {
  sentence: 320,
  trailing: 480,
  paragraph: 700,
  title: 1300,
  scene: 1800,
  system: 950,
  speakerChange: 420,
  clause: 160,
};

export interface FrontendOptions {
  /** Chapter title from the source (helps detect the title line; added as a segment if missing and `announceTitle`). */
  title?: string;
  /** Read the chapter title even when the text doesn't start with it. Default false. */
  announceTitle?: boolean;
  /** User lexicons, lowest priority first (e.g. [global, novel]). DEFAULT_LEXICON always comes first. */
  lexicons?: (Lexicon | undefined | null)[];
  pauses?: Partial<PauseConfig>;
  /** Merge sentences shorter than this into the next one in the same paragraph ("Well." + next). Default 12. */
  minChars?: number;
  /** Split sentences longer than this at a clause boundary. Default 300 (Kokoro's window is ~510 phonemes). */
  maxChars?: number;
  /** Read translator/editor notes. Default false. */
  readNotes?: boolean;
  /** Extra regexes (sources) for blocks to skip, e.g. ads. Case-insensitive. */
  skipPatterns?: string[];
  stutter?: 'drop' | 'keep';
}

const SCENE_RE = /^(?:[\s*~=#\-_.•·◇◆○●□■☆★♦♢<>|+—–―─-╿]{3,}|(?:o0o|oOo|xXx|0o0|-x-|~x~)+|(?:\*\s*){1,}|[◇◆○●□■☆★♦♢⁂※]{1,5})$/u;
const NOTE_RE =
  /^(?:translator|translated by|editor|edited by|proofread(?:er|ed by)?|tl(?:\s*note)?|t\/n|tln|ed|pr|a\/n|author'?s?\s*note|atn|n\/t)\s*[:：-]|^(?:previous|next)\s+chapter\b|^table of contents\b|^(?:support|read) (?:me|us|this|the latest)\b.*(?:patreon|ko-fi|discord|website|\.com)/i;
/**
 * A title line: a numbered label ("Chapter 12 …", "Ch. 3", "Part IV", "Vol. 2"), or a bare section
 * word followed by nothing, punctuation or a number ("Prologue", "Extra: The Feast"), so prose like
 * "Part of me wanted…" or "Extra money…" is not taken for a title.
 */
const TITLE_RE =
  /^(?:(?:chapter|chap\.?|ch\.?|episode|ep\.?|part|volume|vol\.?|book)\s*(?:\d+(?:\.\d+)?|[IVXLC]+\b)|(?:prologue|epilogue|interlude|side story|extra|afterword|bonus chapter)\b(?=\s*(?:$|[-–—:.|(\d])))/i;

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function blockAnchor(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 40);
}

export function segmentHash(display: string): number {
  return fnv1a(blockAnchor(display) || display) & 0xffffff;
}

function looksLikeTitle(text: string, title: string | undefined, index: number): boolean {
  if (index > 1 || text.length > 160) return false;
  if (TITLE_RE.test(text)) return true;
  if (title) {
    // The whole line must be the title (normalized), optionally behind a short label ("Ch 12 – Rain")
    // or before a part number ("Rain (2)"). A paragraph that merely starts with the title ("Rain fell
    // all night…" for the title "Rain") is prose.
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); // not truncated like blockAnchor
    const a = norm(text);
    const b = norm(title);
    if (b.length === 0) return false;
    if (a === b) return true;
    if (a.endsWith(b) && /^(?:chapter|chap|ch|episode|ep|part|vol|volume|book)?\d{0,5}$/.test(a.slice(0, a.length - b.length))) return true;
    if (a.startsWith(b) && /^(?:part|pt)?\d{1,3}$/.test(a.slice(b.length))) return true;
  }
  return false;
}

/** "Chapter 1 - Nightmare Begins" → "Chapter 1. Nightmare Begins." */
function titleSpeech(text: string): string {
  let t = text.replace(/\s*[-–—:|]+\s*/g, '. ').replace(/\s*\.\s*\./g, '.');
  t = t.replace(/^(chapter|ch\.?|chap\.?|episode|ep\.?)\s*(\d+(?:\.\d+)?)\s*\.?\s*/i, (_m, _w: string, n: string) => `Chapter ${n}. `);
  t = t.trim();
  if (!/[.!?…]$/.test(t)) t += '.';
  return t;
}

const NOTE_CLASS_RE = /(?:^|[\s_-])(?:author-?note|translator-?note|tl-?note|footnote|announcement)/i;

function classify(text: string, tag: string, cls: string | undefined, index: number, opts: FrontendOptions, skip: RegExp[]): BlockKind {
  if (tag === 'hr') return 'scene';
  if (!text.trim()) return 'empty';
  if (!opts.readNotes && cls && NOTE_CLASS_RE.test(cls)) return 'note';
  if (SCENE_RE.test(text.trim())) return 'scene';
  if (looksLikeTitle(text, opts.title, index) || /^h[1-3]$/.test(tag) && index <= 1) return 'title';
  if (!opts.readNotes && NOTE_RE.test(text.trim())) return 'note';
  if (skip.some((r) => r.test(text))) return 'note';
  const t = text.trim();
  const lines = t.split('\n');
  const bracketed = (l: string) => /^\s*[[【<〈《].*[\]】>〉》]\s*$/u.test(l);
  if (lines.every((l) => !l.trim() || bracketed(l))) return 'system';
  return 'text';
}

/**
 * Build the narration script of one chapter: what to say, in which order, with which pauses.
 * Deterministic: the same blocks + options always give the same segments (the player relies on it
 * to re-align stale timestamps).
 */
export function buildScript(blocks: readonly SourceBlock[], opts: FrontendOptions = {}): NarrationScript {
  const pauses: PauseConfig = { ...DEFAULT_PAUSES, ...opts.pauses };
  const minChars = opts.minChars ?? 12;
  const maxChars = opts.maxChars ?? 300;
  const lex = mergeLexicons(DEFAULT_LEXICON, ...(opts.lexicons ?? []));
  const skip = (opts.skipPatterns ?? []).flatMap((p) => {
    try {
      return [new RegExp(p, 'i')];
    } catch {
      return [];
    }
  });
  const scriptBlocks: ScriptBlock[] = [];
  const segments: Segment[] = [];
  let firstContent = true;
  let contentIndex = 0;

  const pushSeg = (seg: Omit<Segment, 'id'>) => segments.push({ id: segments.length, ...seg });

  blocks.forEach((b, bi) => {
    const kind = classify(b.text, b.tag, b.cls, contentIndex, opts, skip);
    scriptBlocks.push({ kind, anchor: blockAnchor(b.text) });
    if (kind === 'empty') return;
    contentIndex++;
    if (kind === 'note') return;
    if (kind === 'scene') {
      // Collapse consecutive breaks; never start the chapter with one.
      const prev = segments[segments.length - 1];
      if (!prev || prev.kind === 'scene') return;
      pushSeg({ block: bi, start: 0, end: b.text.length, kind: 'scene', quoted: false, pieces: [], pauseAfterMs: pauses.scene, hash: segmentHash(b.text) });
      return;
    }
    if (firstContent && kind !== 'title' && opts.announceTitle && opts.title) {
      // Title isn't in the text: speak it anyway, anchored to an empty range of this block.
      pushSeg({ block: bi, start: 0, end: 0, kind: 'title', quoted: false, pieces: applyLexicon(normalizeForSpeech(titleSpeech(opts.title)), lex), pauseAfterMs: pauses.title, hash: segmentHash(opts.title) });
    }
    firstContent = false;

    if (kind === 'title') {
      pushSeg({ block: bi, start: 0, end: b.text.length, kind: 'title', quoted: false, pieces: speak(titleSpeech(b.text), lex, opts), pauseAfterMs: pauses.title, hash: segmentHash(b.text) });
      return;
    }

    // Sentences (+ merge tiny fragments, split giants). Tiny fragments ("Ah!", "Well.", "Tsk.") get
    // swallowed or flattened when synthesized alone, so they join their neighbour on the same line.
    let spans = splitSentences(b.text);
    const sameLine = (a: Span, c: Span) => !b.text.slice(a.end, c.start).includes('\n');
    const len = (a: Span) => a.end - a.start;
    const merged: Span[] = [];
    for (const sp of spans) {
      const prev = merged[merged.length - 1];
      if (prev && len(prev) < minChars && sameLine(prev, sp) && len(prev) + len(sp) <= maxChars) prev.end = sp.end;
      else merged.push({ ...sp });
    }
    const tail = merged[merged.length - 1];
    const beforeTail = merged[merged.length - 2];
    if (tail && beforeTail && len(tail) < minChars && sameLine(beforeTail, tail) && len(beforeTail) + len(tail) <= maxChars) {
      beforeTail.end = tail.end;
      merged.pop();
    }
    spans = merged.flatMap((sp) => splitLong(b.text, sp, maxChars));

    const segKind: SegmentKind = kind === 'system' ? 'system' : 'text';
    // Quote state carries across sentences: "Hi. How are you?" are both dialogue.
    let inQuote = false;
    spans.forEach((sp, si) => {
      const display = b.text.slice(sp.start, sp.end);
      const startsQuoted = inQuote || OPEN_QUOTES.includes(display.charAt(0));
      for (const ch of display) {
        if (ch === '“' || ch === '「' || ch === '『') inQuote = true;
        else if (ch === '”' || ch === '」' || ch === '』') inQuote = false;
        else if (ch === '"') inQuote = !inQuote;
      }
      const pieces = speak(display, lex, opts);
      if (!renderPlain(pieces).replace(/[^\p{L}\p{N}]/gu, '')) return; // nothing pronounceable
      const last = si === spans.length - 1;
      let pause = pauses.sentence;
      if (/[…—-]["'”’]?$/.test(display)) pause = pauses.trailing;
      const wasSplit = !/[.!?…"'”’)\]】]$/.test(display);
      if (wasSplit && !last) pause = pauses.clause;
      if (last) pause = segKind === 'system' ? pauses.system : pauses.paragraph;
      pushSeg({ block: bi, start: sp.start, end: sp.end, kind: segKind, quoted: startsQuoted, pieces, pauseAfterMs: pause, hash: segmentHash(display) });
    });
  });

  // Never end on a scene break (e.g. a trailing <hr> before the author's note).
  while (segments[segments.length - 1]?.kind === 'scene') segments.pop();

  // Second pass: pauses that depend on the next segment.
  for (let i = 0; i < segments.length - 1; i++) {
    const a = segments[i];
    const b = segments[i + 1];
    if (!a || !b) continue;
    if (b.kind === 'system' && a.kind !== 'system') a.pauseAfterMs = Math.max(a.pauseAfterMs, pauses.system);
    if (b.kind === 'scene') a.pauseAfterMs = 0; // the scene segment carries the silence
    if (a.block === b.block && a.kind === 'text' && b.kind === 'text' && a.quoted !== b.quoted) {
      a.pauseAfterMs = Math.max(a.pauseAfterMs, pauses.speakerChange);
    }
  }

  const joined = blocks.map((b) => b.text).join('\n\n');
  return {
    frontendVersion: FRONTEND_VERSION,
    textHash: fnv1a(joined).toString(16).padStart(8, '0'),
    blocks: scriptBlocks,
    segments,
  };
}

function speak(display: string, lex: Lexicon, opts: FrontendOptions): Piece[] {
  // Overrides are cut out first (they win over every rule), then the rest is normalized.
  const raw = display.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const pieces = applyLexicon(raw, lex);
  const out: Piece[] = [];
  pieces.forEach((p, i) => {
    if (p.say !== undefined || p.ipa !== undefined) return void out.push(p);
    // NARRATOR PATCH: after an override, keep what joins it to the next words (", " "; " "… " " "):
    // normalizeForSpeech drops leading punctuation (meant for a segment starting "…and then") and
    // whitespace-only text, which turned "Nephis, wait!" into "[Nephis](/nˈɛfɪs/)wait!".
    const joint = i > 0 ? (/^(?:[\s,;:…]|\.{3})+/.exec(p.text)?.[0] ?? '') : '';
    const text = normalizeForSpeech(p.text.slice(joint.length), { stutter: opts.stutter ?? 'drop' });
    const lead = joint ? joint.replace(/\.{3}/g, '…').replace(/\s+/g, ' ') : /^\s/.test(p.text) ? ' ' : '';
    if (text || lead) out.push({ text: lead + text + (text && /\s$/.test(p.text) ? ' ' : '') });
  });
  // Lexicon may now match words produced by normalization ("Lv." → "Level"): one more pass on plain pieces.
  return out.flatMap((p) => (p.say !== undefined || p.ipa !== undefined ? [p] : applyLexicon(p.text, lex)));
}

/** Convenience: HTML → script in one call (PC narration). */
export function scriptFromHtml(html: string, opts: FrontendOptions = {}): { blocks: SourceBlock[]; script: NarrationScript } {
  const blocks = htmlToBlocks(html);
  return { blocks, script: buildScript(blocks, opts) };
}

/** Rough speaking time at 1.0× (for UI estimates before audio exists): ~15 chars/s plus pauses. */
export function estimateDurationMs(script: NarrationScript): number {
  let ms = 0;
  for (const s of script.segments) ms += (renderPlain(s.pieces).length / 15) * 1000 + s.pauseAfterMs;
  return Math.round(ms);
}
