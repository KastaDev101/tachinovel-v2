/**
 * The raw text form: what Nephis's flow reads when her pack asks for the text as written (pack.json chain
 * "text": "raw", NephisFlow.Chain.text). Without it she reads the app's spoken form: the front-end's item.text
 * (frontend.ts normalizeForSpeech), reshaped by nanoText (delivery.ts) into `say`, then native pocketText. The script
 * carries this form per sentence as `delivery.raw` (only where it differs from item.text); native picks it only for a
 * pack that asks for it, so every other voice and pack reads exactly what it read before.
 *
 * Why (tachinovel-tts-lab Q1, 2026-10-12: c7-1500, 303 renders, 3 seeds, finetune/q1_text.py): the same lines read
 * from the script as written ("…" as "...") lost 0 of 147 last words and never ran away; read from the app's text
 * (finetune/app_text.py, the phone's exact text path) 6 of 147 were lost or garbled and 3 ran away. Her pauses after
 * "..." followed hers better (r +0.66 against +0.54), the bench lines' gap pattern too (+0.91 against +0.74), every
 * word was read (recall 1.00 against 0.94), and her hums came out longer, closer to hers.
 *
 * Left out here: every rewrite the app made to the Q1 lines that the raw arm kept as written.
 *   - Ellipses stay "..." (the front-end makes them "…"; pocketText then makes each one a comma, a period or nothing).
 *     A leading one stays too ('"...Define locked."').
 *   - Dashes keep the writer's spacing ("YES— ohhh"; the front-end spaces every dash " — ").
 *   - Capitals stay: no shouting fix (front-end fixCase, "NOOOW" → "Nooow", which lost her last word in all 3 seeds),
 *     no lower-casing (nanoText, "YES" → "yes").
 *   - Drawn-out words stay ("fuuuuck", "Hmmm"): no cut to three letters, no "Hmmm" → "Hmm" → "Hm".
 *   - The built-in interjection lexicon ("Hmm" → "hmm", "Heh" → "heh"; made for Kokoro's G2P) is not applied.
 *   - Nothing of nanoText: no lower-casing, no command "!" → ".", no "," or "…" before the key word ("keep anything,
 *     out" lost "out" in 2 of 3 seeds), no sound effect's dash → "!".
 * Kept, exactly as the front-end does them (a book needs them; no Q1 line had one, so Q1 says nothing against them):
 * the user's Pronunciations (global and the novel's: their `say`), straight quotes, invisible characters, links,
 * symbols and brackets out, "&"/"@"/"w/", "!!" and "??" collapsed, stutters per the Stutter setting ("W-wait" →
 * "wait"; a stutter's pause is "..." here), abbreviations ("Mr.", "Dr.", "Ch.", "Lv.", "e.g." …) and numbers
 * (ranges, ordinals, Roman numerals after "Chapter" or a name, "x3", "+5", "90/100", "%", units). Dash glyphs become
 * one ("--", "–" → "—"), the spacing stays. Native adds the rest of a book's needs for this form (StyleMapper.pocketText,
 * raw): numbers in words, codes and real acronyms spelled out ("NPC" → "N P C", shouted words stay words), a word broken
 * by "..." joined, every "…" as "...", and her pack's respellings.
 * One bound the raw arm never met: a letter repeated six times or more is cut to five, the longest Q1 read as written
 * ("fuuuuuck"), so a page of "Noooooooooo" can't run her generation away.
 *
 * Pure ES2023 (core and UI). The lab mirrors it: tachinovel-tts-lab finetune/app_text.py, form="raw".
 */
import { mergeLexicons, ordinalToWords, romanToInt, type Lexicon, type LexiconEntry } from '@v1tts/frontend.ts';

/** frontend.ts COUNTED_NOUNS: after these a Roman numeral is a plain number ("Chapter IV" → "Chapter 4"). */
const COUNTED_NOUNS =
  'Chapter|Volume|Book|Part|Act|Season|Tier|Rank|Grade|Level|Class|Type|Phase|Stage|Floor|War|Episode|Arc|Generation|Round|Step|Gate|Circle|Realm|Layer|Mark|Model|Unit|Squad|Team|Division|Sector|Zone|Area|Room|Block|Wave|Day|Year|Lesson|Section|Article|Rule';

/** frontend.ts UNITS. */
const UNITS: Record<string, [string, string]> = {
  km: ['kilometer', 'kilometers'], m: ['meter', 'meters'], cm: ['centimeter', 'centimeters'], mm: ['millimeter', 'millimeters'],
  kg: ['kilogram', 'kilograms'], g: ['gram', 'grams'], mg: ['milligram', 'milligrams'], lb: ['pound', 'pounds'],
  lbs: ['pound', 'pounds'], ft: ['foot', 'feet'], mi: ['mile', 'miles'], 'km/h': ['kilometer per hour', 'kilometers per hour'],
  mph: ['mile per hour', 'miles per hour'], 'm/s': ['meter per second', 'meters per second'], kph: ['kilometer per hour', 'kilometers per hour'],
  ml: ['milliliter', 'milliliters'], l: ['liter', 'liters'], s: ['second', 'seconds'], ms: ['millisecond', 'milliseconds'],
  min: ['minute', 'minutes'], hrs: ['hour', 'hours'], hr: ['hour', 'hours'],
};

/** frontend.ts normalizeForSpeech's titles. */
const TITLES: Record<string, string> = {
  Mr: 'Mister', Mrs: 'Missus', Ms: 'Miz', Dr: 'Doctor', Prof: 'Professor', Sgt: 'Sergeant', Lt: 'Lieutenant',
  Capt: 'Captain', Gen: 'General', Col: 'Colonel', Cmdr: 'Commander', Gov: 'Governor', Rev: 'Reverend', Mt: 'Mount',
  Ft: 'Fort', Jr: 'Junior', Sr: 'Senior',
};

/** A letter repeated more than this many times is cut to it (the longest run Q1 read as written). */
export const RAW_MAX_REPEAT = 5;
const HELD_LETTER = new RegExp(`(\\p{L})\\1{${RAW_MAX_REPEAT},}`, 'gu');

/**
 * frontend.ts normalizeForSpeech with only the rules the raw form keeps, in the same order and with the same
 * expressions (see the file comment for what is left out and why). `start`: the run starts the sentence (only then
 * is leading punctuation dropped; a run after a Pronunciations word keeps what joins it, as the front-end does).
 */
export function rawNormalize(input: string, opts: { stutter?: 'drop' | 'keep'; start?: boolean } = {}): string {
  let s = input;
  // --- characters
  s = s.replace(/[\u00A0\u202F\u2007\u3000]/g, ' ').replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '');
  s = s.replace(/[‘’‚′`´]/g, "'").replace(/[“”„″«»]/g, '"');
  s = s.replace(/[「『]/g, '"').replace(/[」』]/g, '"');
  s = s.replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
  // Every ellipsis as "..." (Q1's raw arm), never a comma, a period or nothing.
  s = s.replace(/…+/g, '...').replace(/\.{3,}|\.(?: \.){2,}|。。。/g, '...');
  s = s.replace(/(\d)\s*[–—-]\s*(\d)/g, '$1 to $2'); // ranges 10–20
  // Dashes: one glyph, the writer's spacing ("YES— ohhh" stays as it is).
  s = s.replace(/-{2,}|[–―‒]/g, '—').replace(/(?<=\s)-(?=\s)/g, '—');
  s = s.replace(/#(?=\d)/g, ' number ');
  s = s.replace(/[*_~=#^|]+/g, ' '); // emphasis markers, decorations
  s = s.replace(/[←⇐]|<-/g, ' from ').replace(/[→⇒➜➡]|->|=>/g, ' to ');
  s = s.replace(/[<>【】〈〉《》[\]{}]/g, ' '); // brackets (system text, skills)
  s = s.replace(/&/g, ' and ').replace(/\bw\/(?=\s)/gi, 'with').replace(/@/g, ' at ');
  s = s.replace(/[★☆♥♡♪♫•·◆◇○●■□✦✧]/g, ' ');
  s = s.replace(/[\p{Extended_Pictographic}]/gu, ' ');
  // --- punctuation runs
  s = s.replace(/!{2,}/g, '!').replace(/\?{2,}/g, '?').replace(/(?:\?!|!\?)[!?]*/g, '?!').replace(/,{2,}/g, ',');
  if (opts.start) s = s.replace(/^[\s,;:]+/, ''); // a leading "..." stays
  // --- stutters "W-what", "I-I" (the front-end's, with "..." for its pause)
  if (opts.stutter !== 'keep') {
    s = s.replace(/\b([A-Za-z])-(?=\1)/gi, (_m, l: string) => (/[aeiouAEIOU]/.test(l) ? `${l}, ` : ''));
    s = s.replace(/\b([A-Za-z]{1,3})-(?=\1)/g, '$1... ');
  }
  s = s.replace(HELD_LETTER, '$1'.repeat(RAW_MAX_REPEAT));
  // --- abbreviations
  s = s.replace(/\b(?:Ch|Chap|Chp)\.\s*(?=[\dIVXLC])/g, 'Chapter ');
  s = s.replace(/\bVol\.\s*(?=[\dIVXLC])/g, 'Volume ');
  s = s.replace(/\b(?:Lv|Lvl|LV|LVL)\.?\s*(?=\d)/g, 'Level ');
  s = s.replace(/\bNo\.\s*(?=\d)/g, 'Number ').replace(/#(?=\d)/g, 'number ');
  s = s.replace(/\bpg\.\s*(?=\d)/gi, 'page ').replace(/\bpp\.\s*(?=\d)/gi, 'pages ');
  s = s.replace(/\be\.g\.,?/gi, 'for example,').replace(/\bi\.e\.,?/gi, 'that is,');
  s = s.replace(/\betc\.(?=\s*$)/g, 'et cetera.').replace(/\betc\./g, 'et cetera');
  s = s.replace(/\bvs\.?(?=\s)/gi, 'versus').replace(/\bapprox\./gi, 'approximately');
  s = s.replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sgt|Lt|Capt|Gen|Col|Cmdr|Gov|Rev|Mt|Ft|Jr|Sr)\.(?=\s|$)/g, (_m, t: string) => TITLES[t] ?? t);
  s = s.replace(/\bSt\.(?=\s+\p{Lu})/gu, 'Saint').replace(/(?<=\p{Lu}\p{Ll}+\s)St\.?(?=[\s,.;!?]|$)/gu, 'Street');
  // --- numbers
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_m, n: string) => ordinalToWords(parseInt(n, 10)));
  s = s.replace(new RegExp(`\\b(${COUNTED_NOUNS})\\s+([IVXLC]+)\\b(?![\\p{L}'])`, 'gu'), (m, noun: string, r: string) => {
    const v = romanToInt(r);
    return v !== null ? `${noun} ${v}` : m;
  });
  s = s.replace(/(?<=\b\p{Lu}\p{Ll}+\s)(II|III|IV|VI|VII|VIII|IX|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX)\b(?![\p{L}'])/gu, (m, r: string) => {
    const v = romanToInt(r);
    return v !== null ? `the ${ordinalToWords(v)}` : m;
  });
  s = s.replace(/(?<![\p{L}\d])[x×](\d+(?:\.\d+)?)\b/gu, 'times $1').replace(/\b(\d+(?:\.\d+)?)[x×](?![\p{L}\d])/gu, '$1 times');
  s = s.replace(/(^|[\s(])\+(\d)/g, '$1plus $2').replace(/(^|[\s(:])-(\d)/g, '$1minus $2');
  s = s.replace(/\b(\d[\d,]*)\s*\/\s*(\d[\d,]*)\b/g, (m, a: string, b: string) => {
    const x = parseInt(a.replace(/,/g, ''), 10);
    const y = parseInt(b.replace(/,/g, ''), 10);
    return y >= x && y > 12 ? `${a} out of ${b}` : m;
  });
  s = s.replace(/(\d)\s*%/g, '$1 percent');
  s = s.replace(/(?<![$£€\d.,])\b(\d+(?:\.\d+)?)(\s?)(km\/h|m\/s|km|cm|mm|kg|mg|lbs?|ft|mi|mph|kph|ml|hrs?|min|ms|m|g|l|s)\b(?!\.\w)/g, (m, n: string, sp: string, u: string) => {
    const names = UNITS[u];
    if (!names) return m;
    if (u === 's' && !sp) return m;
    return `${n} ${n === '1' ? names[0] : names[1]}`;
  });
  // No fixCase: capitals stay as written.
  return s.replace(/\s+/g, ' ').replace(/\s+([,.!?;:…])/g, '$1');
}

interface Piece {
  text: string;
  say?: string;
  ipa?: string;
}

interface Compiled {
  re: RegExp;
  entry: LexiconEntry;
}

/** frontend.ts compileLexicon (not exported there): longest literal first, word edges for literals. */
function compileLexicon(lex: Lexicon): Compiled[] {
  const out: Compiled[] = [];
  for (const entry of [...lex.entries].sort((a, b) => b.match.length - a.match.length)) {
    const flags = entry.caseSensitive ? 'gu' : 'giu';
    let src = entry.match;
    if (!entry.regex) {
      const lit = entry.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      src = (/^[\p{L}\p{N}]/u.test(entry.match) ? '(?<![\\p{L}\\p{N}])' : '') + lit + (/[\p{L}\p{N}]$/u.test(entry.match) ? '(?![\\p{L}\\p{N}])' : '');
    }
    try {
      out.push({ re: new RegExp(src, flags), entry });
    } catch {
      /* an invalid user regex: skipped, as the front-end does */
    }
  }
  return out;
}

/** frontend.ts applyLexicon: overrides cut out as pieces of their own (they win over every rule). */
function applyLexicon(text: string, compiled: readonly Compiled[]): Piece[] {
  let pieces: Piece[] = [{ text }];
  for (const { re, entry } of compiled) {
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

export interface RawTextOptions {
  /** The user's lexicons, lowest priority first (the front-end's `lexicons`). Its built-in interjections are left out. */
  lexicons?: readonly (Lexicon | undefined | null)[];
  /** The front-end's stutter setting (default "drop"). */
  stutter?: 'drop' | 'keep';
}

/**
 * The raw form of one displayed sentence, as the front-end's speak() builds item.text (Pronunciations cut out first,
 * the rest normalized, the lexicon once more over the result) with rawNormalize for normalizeForSpeech.
 * Returns a reader with the lexicon compiled once (a chapter's sentences share it).
 */
export function rawTextReader(opts: RawTextOptions = {}): (display: string) => string {
  const compiled = compileLexicon(mergeLexicons(...(opts.lexicons ?? [])));
  const stutter = opts.stutter ?? 'drop';
  return (display) => {
    const text = display.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    const pieces = applyLexicon(text, compiled).flatMap((p, i) =>
      p.say !== undefined || p.ipa !== undefined ? [p] : applyLexicon(rawNormalize(p.text, { stutter, start: i === 0 }), compiled),
    );
    return pieces
      .map((p) => p.say ?? p.text)
      .join('')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.!?;:…])/g, '$1')
      .trim();
  };
}

/** The raw form of one displayed sentence (rawTextReader for a single call). */
export function rawText(display: string, opts: RawTextOptions = {}): string {
  return rawTextReader(opts)(display);
}
