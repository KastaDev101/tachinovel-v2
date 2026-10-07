/**
 * Sentence segmentation and pauses: v1's narration front-end `buildScript` (vendor/v1/experiments/tts/
 * frontend.ts, MIT, the PC narrator's), with the speech step passed in. v1's buildScript normalizes every
 * sentence itself; text prep (prepare.ts) says sentences its own way, so going through buildScript would
 * normalize each sentence twice (a third of the time of a chapter). Same rules otherwise:
 *  - blocks: titles (a numbered label or the source's title, in the first two content blocks), scene breaks
 *    (decorative lines, <hr>), notes by class name ("author-note"), [all-bracketed] system lines, text;
 *    notes by their wording, navigation and plugs are text prep's cleanup (cleanup.ts), not done here;
 *  - sentences: v1 splitSentences, tiny fragments merged into the next one on the same line, over-long ones
 *    split at the clause boundary nearest the middle;
 *  - pauses: sentence, trailing off, paragraph, title, scene, system message, speaker change, clause.
 */
import {
  DEFAULT_PAUSES,
  FRONTEND_VERSION,
  blockAnchor,
  fnv1a,
  renderPlain,
  segmentHash,
  splitSentences,
  type BlockKind,
  type FrontendOptions,
  type NarrationScript,
  type Piece,
  type ScriptBlock,
  type Segment,
  type SegmentKind,
  type SourceBlock,
  type Span,
} from '@v1tts/frontend.ts';

export interface SpeakRequest {
  /** What the sentence (or title) says on the page; for a title, its spoken form ("Chapter 3. The Hall."). */
  display: string;
  kind: 'title' | 'text' | 'system';
  block: number;
  start: number;
  end: number;
}

/** Text prep's speech step: the spoken pieces of a sentence; nothing speakable drops the sentence. */
export type Speaker = (req: SpeakRequest) => Piece[];

const SCENE_RE = /^(?:[\s*~=#\-_.•·◇◆○●□■☆★♦♢<>|+—–―─-╿]{3,}|(?:o0o|oOo|xXx|0o0|-x-|~x~)+|(?:\*\s*){1,}|[◇◆○●□■☆★♦♢⁂※]{1,5})$/u;
const TITLE_RE =
  /^(?:(?:chapter|chap\.?|ch\.?|episode|ep\.?|part|volume|vol\.?|book)\s*(?:\d+(?:\.\d+)?|[IVXLC]+\b)|(?:prologue|epilogue|interlude|side story|extra|afterword|bonus chapter)\b(?=\s*(?:$|[-–—:.|(\d])))/i;
const NOTE_CLASS_RE = /(?:^|[\s_-])(?:author-?note|translator-?note|tl-?note|footnote|announcement)/i;
const OPEN_QUOTES = '"“「『«';

function looksLikeTitle(text: string, title: string | undefined, index: number): boolean {
  if (index > 1 || text.length > 160) return false;
  if (TITLE_RE.test(text)) return true;
  if (!title) return false;
  const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const a = norm(text);
  const b = norm(title);
  if (b.length === 0) return false;
  if (a === b) return true;
  if (a.endsWith(b) && /^(?:chapter|chap|ch|episode|ep|part|vol|volume|book)?\d{0,5}$/.test(a.slice(0, a.length - b.length))) return true;
  return a.startsWith(b) && /^(?:part|pt)?\d{1,3}$/.test(a.slice(b.length));
}

/** "Chapter 1 - Nightmare Begins" → "Chapter 1. Nightmare Begins." */
export function titleSpeech(text: string): string {
  let t = text.replace(/\s*[-–—:|]+\s*/g, '. ').replace(/\s*\.\s*\./g, '.');
  t = t.replace(/^(chapter|ch\.?|chap\.?|episode|ep\.?)\s*(\d+(?:\.\d+)?)\s*\.?\s*/i, (_m, _w: string, n: string) => `Chapter ${n}. `).trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function classify(text: string, tag: string, cls: string | undefined, index: number, opts: FrontendOptions, skip: RegExp[]): BlockKind {
  if (tag === 'hr') return 'scene';
  if (!text.trim()) return 'empty';
  if (!opts.readNotes && cls && NOTE_CLASS_RE.test(cls)) return 'note';
  if (SCENE_RE.test(text.trim())) return 'scene';
  if (looksLikeTitle(text, opts.title, index) || (/^h[1-3]$/.test(tag) && index <= 1)) return 'title';
  if (skip.some((r) => r.test(text))) return 'note';
  const lines = text.trim().split('\n');
  const bracketed = (l: string): boolean => /^\s*[[【<〈《].*[\]】>〉》]\s*$/u.test(l);
  return lines.every((l) => !l.trim() || bracketed(l)) ? 'system' : 'text';
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
  return [...splitLong(text, left, maxChars), ...splitLong(text, { start: rs, end: span.end }, maxChars)];
}

/** v1 buildScript with the speech step passed in (deterministic: same blocks + options → same segments). */
export function segmentChapter(blocks: readonly SourceBlock[], opts: FrontendOptions, speak: Speaker): NarrationScript {
  const pauses = { ...DEFAULT_PAUSES, ...opts.pauses };
  const minChars = opts.minChars ?? 12;
  const maxChars = opts.maxChars ?? 300;
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
  const pushSeg = (seg: Omit<Segment, 'id'>): void => void segments.push({ id: segments.length, ...seg });
  const speakable = (pieces: Piece[]): boolean => /[\p{L}\p{N}]/u.test(renderPlain(pieces));

  blocks.forEach((b, bi) => {
    const kind = classify(b.text, b.tag, b.cls, contentIndex, opts, skip);
    scriptBlocks.push({ kind, anchor: blockAnchor(b.text) });
    if (kind === 'empty') return;
    contentIndex++;
    if (kind === 'note') return;
    if (kind === 'scene') {
      const prev = segments[segments.length - 1];
      if (!prev || prev.kind === 'scene') return;
      pushSeg({ block: bi, start: 0, end: b.text.length, kind: 'scene', quoted: false, pieces: [], pauseAfterMs: pauses.scene, hash: segmentHash(b.text) });
      return;
    }
    if (firstContent && kind !== 'title' && opts.announceTitle && opts.title) {
      const pieces = speak({ display: titleSpeech(opts.title), kind: 'title', block: bi, start: 0, end: 0 });
      if (speakable(pieces)) pushSeg({ block: bi, start: 0, end: 0, kind: 'title', quoted: false, pieces, pauseAfterMs: pauses.title, hash: segmentHash(opts.title) });
    }
    firstContent = false;

    if (kind === 'title') {
      const pieces = speak({ display: titleSpeech(b.text), kind: 'title', block: bi, start: 0, end: b.text.length });
      if (speakable(pieces)) pushSeg({ block: bi, start: 0, end: b.text.length, kind: 'title', quoted: false, pieces, pauseAfterMs: pauses.title, hash: segmentHash(b.text) });
      return;
    }

    let spans = splitSentences(b.text);
    const sameLine = (a: Span, c: Span): boolean => !b.text.slice(a.end, c.start).includes('\n');
    const len = (a: Span): number => a.end - a.start;
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
      const pieces = speak({ display, kind: segKind === 'system' ? 'system' : 'text', block: bi, start: sp.start, end: sp.end });
      if (!speakable(pieces)) return;
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
    if (b.kind === 'scene') a.pauseAfterMs = 0;
    if (a.block === b.block && a.kind === 'text' && b.kind === 'text' && a.quoted !== b.quoted) a.pauseAfterMs = Math.max(a.pauseAfterMs, pauses.speakerChange);
  }

  return {
    frontendVersion: FRONTEND_VERSION,
    textHash: fnv1a(blocks.map((b) => b.text).join('\n\n')).toString(16).padStart(8, '0'),
    blocks: scriptBlocks,
    segments,
  };
}
