/**
 * Narrator mode, the script side (pure ES2023; core and UI). speechScript adds these to every sentence and
 * native uses each one only when its Narrator-mode switch is on (Settings › Voices › Narrator mode), so the
 * sentence list itself (resume points, highlighting) never changes:
 *
 *  - dialogue: `role: 'dialogue'` for a sentence spoken inside quotation marks; a sentence that mixes
 *    speech and narration ("“Run,” she said.") gets `parts`, each with its own text, lexicon runs, role and
 *    range, so native can read the quoted words in the dialogue voice and the rest in the narrator's;
 *  - alternating speakers: `speaker: 1` on the dialogue of every other paragraph in a run of dialogue
 *    paragraphs (a new paragraph is a new speaker, the usual convention in novels); a paragraph without
 *    dialogue starts the count again;
 *  - smarter pacing: `pacedMs`, the pause after the sentence from its ending (? ! … : —), its length, and
 *    what comes next (a quick exchange of short lines, a speaker change, the end of a long paragraph);
 *  - prosody jitter: `rate`, a speed factor within ±3 %, derived from the sentence's text hash, so a
 *    chapter doesn't tick along at one fixed tempo, and the same sentence always sounds the same (prepared
 *    audio and caches stay valid);
 *  - phrase breaks: `phrases`, the sentence split into phrases with a short pause after each (Kasta's pick
 *    "clauses", P3 of the PC tuning round: the narrator repo's py/tune.py `phrases`, commit d172d45).
 */
import { renderPhonemeRuns, renderPlain, type Piece } from '@v1tts/frontend.ts';

export type SpeechRole = 'narration' | 'dialogue';

export interface SpeechPartJson {
  role: SpeechRole;
  /** Plain text for the engine (lexicon respellings applied). */
  text: string;
  /** Lexicon phoneme runs, only when the part has phoneme overrides (as SpeechItem.runs). */
  runs?: { t?: string; p?: string }[];
  /** [start, end) in the block's canonical text. */
  start: number;
  end: number;
}

/** Phrase breaks (tune.py, "clauses" mode): 175 ms after , ; and —; 1.3× after an introductory phrase (a
 * comma within the first five words); 0.6× before a clause starter; never a piece under 12 characters. */
export const PHRASE_BREAK_MS = 175;
export const CLAUSE_STARTERS = ['and then', 'but', 'while', 'because'] as const;
export const MIN_PHRASE_CHARS = 12;

export interface PhraseJson {
  text: string;
  /** Silence after this phrase (ms at 1.0×); 0 for the last one. */
  pauseMs: number;
}

/** A sentence split into phrases with the pause after each (one phrase when nothing qualifies). */
export function phrases(text: string, breakMs = PHRASE_BREAK_MS): PhraseJson[] {
  const cuts: [number, number][] = []; // [index where the next phrase starts, pause ms]
  for (const m of text.matchAll(/(?<=[,;])\s+|\s+—\s+/g)) {
    const at = m.index;
    const intro = (text.slice(0, at).match(/ /g) ?? []).length < 5 && text.charAt(at - 1) === ',';
    cuts.push([at + m[0].length, breakMs * (intro ? 1.3 : 1)]);
  }
  for (const w of CLAUSE_STARTERS) {
    for (const m of text.matchAll(new RegExp(`(?<=[^\\s,;—])\\s+(?=${w}\\b)`, 'gi'))) cuts.push([m.index + m[0].length, breakMs * 0.6]);
  }
  cuts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: PhraseJson[] = [];
  let start = 0;
  for (const [at, ms] of cuts) {
    const head = text.slice(start, at).trim();
    const tail = text.slice(at).trim();
    if (head.length < MIN_PHRASE_CHARS || tail.length < MIN_PHRASE_CHARS) continue;
    out.push({ text: head, pauseMs: Math.round(ms) });
    start = at;
  }
  const last = text.slice(start).trim();
  if (last) out.push({ text: last, pauseMs: 0 });
  return out;
}

/** Same opening quotes as the front-end (frontend.ts OPEN_QUOTES); straight quotes toggle. */
const OPEN = new Set(['“', '「', '『', '«']);
const CLOSE = new Set(['”', '」', '』', '»']);
const SPEAKABLE = /[\p{L}\p{N}]/u;

interface Run<T> {
  dialogue: boolean;
  items: T[];
}

/**
 * Split characters into dialogue/narration runs. Quote marks belong to the dialogue they open or close.
 * `quotedAtStart`: the sentence starts inside a quotation that opened in an earlier sentence.
 */
function quoteRuns(chars: readonly string[], quotedAtStart: boolean): Run<number>[] {
  const runs: Run<number>[] = [];
  let inQuote = quotedAtStart;
  const push = (i: number, dialogue: boolean): void => {
    const last = runs[runs.length - 1];
    if (last && last.dialogue === dialogue) last.items.push(i);
    else runs.push({ dialogue, items: [i] });
  };
  chars.forEach((ch, i) => {
    if (OPEN.has(ch) || (ch === '"' && !inQuote)) {
      inQuote = true;
      push(i, true);
    } else if (CLOSE.has(ch) || (ch === '"' && inQuote)) {
      push(i, true);
      inQuote = false;
    } else {
      push(i, inQuote);
    }
  });
  return runs;
}

/**
 * Fold runs with nothing to pronounce (a lone " — " between two quotes) into the run before them (the
 * first speakable run when they lead), then merge neighbors of the same role.
 */
function foldSilent<T>(runs: readonly Run<T>[], speakable: (r: Run<T>) => boolean): Run<T>[] {
  const out: Run<T>[] = [];
  let leading: T[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (!speakable(r)) {
      if (last) last.items.push(...r.items);
      else leading.push(...r.items);
    } else if (last && last.dialogue === r.dialogue) {
      last.items.push(...r.items);
    } else {
      out.push({ dialogue: r.dialogue, items: [...leading, ...r.items] });
      leading = [];
    }
  }
  return out;
}

/** The pieces split at quote marks (overridden words stay whole), as one list per character run. */
function pieceRuns(pieces: readonly Piece[], quotedAtStart: boolean): Run<Piece>[] {
  // Flatten to characters, remembering which characters are overridden words (kept whole).
  const atoms: { ch: string; piece?: Piece }[] = [];
  for (const p of pieces) {
    if (p.say !== undefined || p.ipa !== undefined) atoms.push({ ch: '\u0000', piece: p });
    else for (const ch of p.text) atoms.push({ ch });
  }
  const runs = quoteRuns(
    atoms.map((a) => a.ch),
    quotedAtStart,
  );
  return runs.map((r) => {
    const out: Piece[] = [];
    let text = '';
    for (const i of r.items) {
      const a = atoms[i];
      if (!a) continue;
      if (a.piece) {
        if (text) out.push({ text });
        text = '';
        out.push(a.piece);
      } else text += a.ch;
    }
    if (text) out.push({ text });
    return { dialogue: r.dialogue, items: out };
  });
}

/**
 * The parts of a sentence that mixes quoted speech and narration, or null when it is all one or the other
 * (or the spoken text and the display text don't line up, e.g. a quote mark removed by normalization).
 * `display` is the sentence's canonical text, `offset` its start in the block.
 */
export function dialogueParts(display: string, offset: number, pieces: readonly Piece[], startsQuoted: boolean): SpeechPartJson[] | null {
  const firstChar = display.charAt(0);
  const carried = startsQuoted && !OPEN.has(firstChar) && firstChar !== '"';
  const chars = [...display];
  const shown = foldSilent(quoteRuns(chars, carried), (r) => SPEAKABLE.test(r.items.map((i) => chars[i] ?? '').join('')));
  if (shown.length < 2) return null;
  const spoken = foldSilent(pieceRuns(pieces, carried), (r) => SPEAKABLE.test(renderPlain(r.items)));
  if (spoken.length !== shown.length || spoken.some((r, i) => r.dialogue !== shown[i]?.dialogue)) return null;
  // Character index → UTF-16 offset in the display text.
  const utf16: number[] = [];
  let at = 0;
  for (const ch of chars) {
    utf16.push(at);
    at += ch.length;
  }
  utf16.push(at);
  return shown.map((r, i) => {
    const pcs = spoken[i]?.items ?? [];
    const first = r.items[0] ?? 0;
    const last = r.items[r.items.length - 1] ?? first;
    const part: SpeechPartJson = {
      role: r.dialogue ? 'dialogue' : 'narration',
      text: renderPlain(pcs),
      start: offset + (utf16[first] ?? 0),
      end: offset + (utf16[last + 1] ?? at),
    };
    if (pcs.some((p) => p.ipa)) part.runs = renderPhonemeRuns(pcs).map((x) => (x.phonemes !== undefined ? { p: x.phonemes } : { t: x.text ?? '' }));
    return part;
  });
}

/** What narrator mode needs to know about a sentence, in script order. */
export interface PacedSentence {
  block: number;
  kind: 'title' | 'text' | 'system';
  text: string;
  /** The front-end's pause (classic pacing). */
  pauseMs: number;
  /** Has dialogue: all of it (role) or some of it (parts). */
  dialogue: boolean;
  /** All of it is dialogue. */
  quoted: boolean;
}

/** Pauses at or above this are titles, scene breaks and system messages: kept as they are. */
const STRUCTURAL_MS = 900;
/** The front-end's pause between halves of an over-long sentence (frontend.ts DEFAULT_PAUSES.clause). */
const CLAUSE_MS = 160;

/** Smarter pause after sentence `i` (ms at 1.0×). */
export function pacedPause(list: readonly PacedSentence[], i: number): number {
  const s = list[i];
  if (!s) return 0;
  const next = list[i + 1];
  if (!next || s.pauseMs >= STRUCTURAL_MS || s.kind !== 'text' || s.pauseMs === CLAUSE_MS) return s.pauseMs;
  const text = s.text.trim();
  const end = text.replace(/["'”’»)\]]+$/u, '').slice(-1);
  const length = text.length;
  if (next.block !== s.block) {
    // End of a paragraph.
    const paragraph = list.filter((x) => x.block === s.block);
    const chars = paragraph.reduce((n, x) => n + x.text.length, 0);
    if (s.dialogue && next.dialogue && chars < 140) return 520; // a quick exchange of short lines
    if (chars > 450) return 820; // let a long paragraph land
    return Math.max(s.pauseMs, 700);
  }
  let ms: number;
  if (end === '…' || end === '—' || end === '-') ms = 500;
  else if (end === '?') ms = 380;
  else if (end === '!') ms = 290;
  else if (end === ':' || end === ';') ms = 300;
  else ms = 320;
  if (length < 40) ms *= 0.8;
  else if (length > 180) ms *= 1.15;
  if (s.quoted !== next.quoted) ms = Math.max(ms, 420); // the speaker changes
  return Math.round(ms);
}

/** Speed factor in [0.97, 1.03] from a sentence's 24-bit text hash (3 decimals; 1 for a zero hash). */
export function rateJitter(hash: number): number {
  if (!Number.isFinite(hash) || hash === 0) return 1;
  // Spread the bits (hashes of similar sentences are close in their low bits).
  let h = Math.imul(hash ^ (hash >>> 13), 0x5bd1e995) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  const unit = (h % 2001) / 1000 - 1; // −1 … 1
  return Math.round((1 + unit * 0.03) * 1000) / 1000;
}

/**
 * Speaker of each sentence's dialogue (0 or 1), alternating per paragraph through a run of paragraphs
 * with dialogue; a paragraph without dialogue (or a title) starts again at 0. Sentences of a paragraph
 * are contiguous in script order.
 */
export function alternateSpeakers(list: readonly Pick<PacedSentence, 'block' | 'kind' | 'dialogue'>[]): number[] {
  const withDialogue = new Set(list.filter((s) => s.dialogue).map((s) => s.block));
  const speakerOf = new Map<number, number>();
  let previous = -1;
  let block = -1;
  for (const s of list) {
    if (s.block === block) continue;
    block = s.block;
    if (s.kind === 'title' || !withDialogue.has(s.block)) {
      previous = -1;
      continue;
    }
    previous = previous === 0 ? 1 : 0;
    speakerOf.set(s.block, previous);
  }
  return list.map((s) => speakerOf.get(s.block) ?? 0);
}
