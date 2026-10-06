/**
 * Chapter HTML → narration script (paragraphs → sentences), core side. Pure ECMAScript + htmlparser2,
 * so it runs in the JSContext (no DOM) and in Node tests.
 *
 * Used when NATIVE code needs chapter text without the UI (lock screen, CarPlay, auto-continue into
 * the next chapter while the WebView is suspended). When the reader is on screen, the UI sends the
 * paragraphs it actually rendered instead (exact highlight alignment); see docs/tts-v2.md.
 *
 * Paragraph rule (approximates v1 src/ui/lib/sanitize.ts flattening): every block element
 * (p, div without block children, h1–h6, li, blockquote, pre, tr) is one paragraph; <br><br> splits a
 * block; script/style/noscript/template/head content is skipped; empty paragraphs are dropped.
 * Text cleanup follows the PC TTS lab (tachinovel-tts-lab/narrate.py): curly quotes normalized, "..."
 * → "…", spaced hyphen/en dash → em dash, "!!!" → "!", "***" scene breaks become a pause marker.
 */
import { Parser } from 'htmlparser2';

export interface NarrationParagraph {
  /** Index in the chapter's paragraph list (same numbering the reader uses for positions). */
  index: number;
  text: string;
  sentences: string[];
  /** Scene break ("***", "* * *", <hr>): spoken as silence, not text. */
  pause?: 'scene';
}

const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'tr', 'section', 'article', 'figure', 'figcaption', 'dd', 'dt']);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'iframe', 'object', 'svg', 'math']);
const VOID_BREAK = new Set(['br']);

/** Extract plain-text paragraphs from (unsanitized) chapter HTML. */
export function htmlToParagraphs(html: string): string[] {
  const out: string[] = [];
  let current = '';
  let skipDepth = 0;
  let pendingBreaks = 0;

  const flush = (): void => {
    const t = current.replace(/[\s\u00A0\u200B]+/g, ' ').trim();
    if (t) out.push(t);
    current = '';
    pendingBreaks = 0;
  };

  const parser = new Parser(
    {
      onopentag(name) {
        if (SKIP.has(name)) {
          skipDepth++;
          return;
        }
        if (skipDepth > 0) return;
        if (name === 'hr') {
          flush();
          out.push('***');
          return;
        }
        if (VOID_BREAK.has(name)) {
          pendingBreaks++;
          if (pendingBreaks >= 2) flush();
          else current += ' ';
          return;
        }
        if (BLOCK.has(name)) flush();
      },
      ontext(text) {
        if (skipDepth > 0) return;
        if (text.trim()) pendingBreaks = 0;
        current += text;
      },
      onclosetag(name) {
        if (SKIP.has(name)) {
          skipDepth = Math.max(0, skipDepth - 1);
          return;
        }
        if (skipDepth > 0) return;
        if (BLOCK.has(name)) flush();
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();
  flush();
  return out;
}

const SCENE_BREAK = /^[\s*~#=_\-–—·•]{3,}$/;

/** Text normalization for speech (mirrors the PC lab's narrate.py rules). */
export function normalizeForSpeech(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/\.{3,}/g, '…')
    .replace(/\s+[-–]\s+/g, ' — ')
    .replace(/!{2,}/g, '!')
    .replace(/\?{2,}/g, '?')
    .replace(/\[([^\]]{1,200})\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const ABBREVIATIONS = /\b(Mr|Mrs|Ms|Dr|St|Prof|Sr|Jr|vs|etc|Lt|Capt|Gen|Col|Sgt|No)\.$/i;
const MIN_SENTENCE_CHARS = 12;

interface SegmenterLike {
  segment(input: string): Iterable<{ segment: string }>;
}

function sentenceSegmenter(): SegmenterLike | null {
  const I = (globalThis as { Intl?: { Segmenter?: new (locale: string, opts: { granularity: 'sentence' }) => SegmenterLike } }).Intl;
  if (!I?.Segmenter) return null;
  try {
    return new I.Segmenter('en', { granularity: 'sentence' });
  } catch {
    return null;
  }
}

let cachedSegmenter: SegmenterLike | null | undefined;

/** Split one paragraph into sentences; abbreviations protected; tiny fragments ("Well.") merged forward. */
export function splitSentences(text: string): string[] {
  if (cachedSegmenter === undefined) cachedSegmenter = sentenceSegmenter();
  let raw: string[];
  if (cachedSegmenter) {
    raw = Array.from(cachedSegmenter.segment(text), (s) => s.segment);
  } else {
    raw = text.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g) ?? [text];
  }
  // Re-join splits after abbreviations ("Mr." + " Smith …").
  const joined: string[] = [];
  for (const part of raw) {
    const prev = joined[joined.length - 1];
    if (prev !== undefined && ABBREVIATIONS.test(prev.trimEnd())) joined[joined.length - 1] = prev + part;
    else joined.push(part);
  }
  // Merge fragments shorter than MIN_SENTENCE_CHARS into the next sentence (intonation context).
  const out: string[] = [];
  let carry = '';
  for (const part of joined) {
    const s = (carry + part).trim();
    if (!s) continue;
    if (s.length < MIN_SENTENCE_CHARS) {
      carry = s + ' ';
      continue;
    }
    out.push(s);
    carry = '';
  }
  if (carry.trim()) {
    if (out.length > 0) out[out.length - 1] = `${out[out.length - 1] as string} ${carry.trim()}`;
    else out.push(carry.trim());
  }
  return out;
}

/** Full narration script for a chapter. Indexes count every extracted paragraph, including breaks. */
export function narrationScript(html: string, title?: string): NarrationParagraph[] {
  const paragraphs = htmlToParagraphs(html);
  const out: NarrationParagraph[] = [];
  paragraphs.forEach((p, index) => {
    if (SCENE_BREAK.test(p)) {
      out.push({ index, text: '', sentences: [], pause: 'scene' });
      return;
    }
    let text = normalizeForSpeech(p);
    // "Chapter 1 - Nightmare Begins" → "Chapter 1. Nightmare Begins." (lab rule) for the title line.
    if (index === 0 && title && /^chapter\s+\d/i.test(text)) text = `${text.replace(/\s+—\s+/, '. ').replace(/[.!?…]?$/, '.')}`;
    out.push({ index, text, sentences: splitSentences(text) });
  });
  return out;
}
