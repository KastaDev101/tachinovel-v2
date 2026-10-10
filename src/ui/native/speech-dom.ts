/**
 * The speech script from the reader's DOM, and sentence highlighting for speech (Kokoro or Apple).
 *
 * "Listen from here" builds the script from exactly what the reader shows: v1's DOM walker (dom-blocks.ts,
 * the same block rules as the narration front-end) → speech-script.ts (front-end + pronunciation lexicon).
 * Every sentence keeps its (block, start, end) in the chapter's canonical text, so when native reports the
 * sentence it is speaking, the reader paints exactly that sentence (CSS Custom Highlight API, no DOM
 * mutation). Chapters the core scripted on its own (lock-screen auto-continue) are matched by hash.
 */
import { blockRange, domBlocks, type DomBlock } from '@v1tts/player/dom-blocks.ts';
import type { Lexicon } from '@v1tts/frontend.ts';
import type { Emphasis } from '../../core/narration/delivery.ts';
import type { ListMemory } from '../../core/narration/lists.ts';
import { speechScript, type SpeechScript } from '../../core/narration/speech-script.ts';

/** Index of the reader paragraph (`.rd-body > *`) that contains a node. */
export function paragraphIndexOf(body: HTMLElement, node: Node | null): number {
  let el: Node | null = node;
  while (el && el.parentNode !== body) el = el.parentNode;
  if (!el) return 0;
  return Math.max(0, Array.prototype.indexOf.call(body.children, el));
}

export interface DomScript {
  body: HTMLElement;
  blocks: DomBlock[];
  script: SpeechScript;
}

const EMPHASIS = 'em, i, cite, strong, b';

/** The reader's italic and bold text in document order (natural delivery's emphasis; nested ones count once). */
export function domEmphasis(body: HTMLElement): Emphasis[] {
  const out: Emphasis[] = [];
  for (const el of Array.from(body.querySelectorAll<HTMLElement>(EMPHASIS))) {
    const outer = el.parentElement?.closest(EMPHASIS);
    if (outer && body.contains(outer)) continue;
    const text = (el.textContent ?? '').replace(/[\s\u00A0\u200B]+/g, ' ').trim();
    if (!text) continue;
    const bold = el.tagName === 'STRONG' || el.tagName === 'B';
    out.push(bold ? { text, bold } : { text });
  }
  return out;
}

/** Script for a rendered chapter body. `title` helps the front-end recognise the title line. */
export function domSpeechScript(body: HTMLElement, opts: { title?: string; lexicons?: Lexicon[]; lists?: ListMemory } = {}): DomScript {
  const blocks = domBlocks(body);
  const paragraphOf = (b: number): number => {
    const blk = blocks[b];
    const anchor = blk?.element && blk.element !== body ? blk.element : (blk?.nodes.find((n) => n !== null) ?? null);
    return paragraphIndexOf(body, anchor);
  };
  const script = speechScript(blocks, {
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.lexicons ? { lexicons: opts.lexicons } : {}),
    paragraphOf,
    emphasis: domEmphasis(body),
    ...(opts.lists ? { lists: opts.lists } : {}),
  });
  return { body, blocks, script };
}

/**
 * The novel's LitRPG lists as last read (lists.ts), kept on this device: a status screen's long list is read as
 * what changed since the previous chapter that had it. Re-listening to the same chapter compares with the one
 * before it, not with itself.
 */
export function listMemory(novelKey: string, chapterKey: string): ListMemory {
  const key = `tn.lists.${novelKey}`;
  type Rec = { chapter: string; items: string[]; prev?: string[] };
  const load = (): Record<string, Rec> => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, Rec>;
    } catch {
      return {};
    }
  };
  return {
    previous(label) {
      const rec = load()[label];
      return rec ? (rec.chapter === chapterKey ? rec.prev : rec.items) : undefined;
    },
    remember(label, items) {
      const all = load();
      const rec = all[label];
      const prev = rec ? (rec.chapter === chapterKey ? rec.prev : rec.items) : undefined;
      all[label] = { chapter: chapterKey, items: [...items], ...(prev ? { prev } : {}) };
      try {
        localStorage.setItem(key, JSON.stringify(all));
      } catch {
        // storage full or blocked: the next read summarizes instead of saying what's new
      }
    },
  };
}

let listened: { chapter: string; script: SpeechScript } | null = null;
/** The script of the chapter last started with Listen (Voice Lab › Test moods on it). */
export function rememberListened(chapter: string, script: SpeechScript): void {
  listened = { chapter, script };
}
export const lastListened = (): { chapter: string; script: SpeechScript } | null => listened;

/** First sentence at or after a reader paragraph ("listen from the first visible paragraph"). */
export function startItemForParagraph(script: SpeechScript, paragraph: number): number {
  const i = script.items.findIndex((it) => it.paragraph >= paragraph);
  return i < 0 ? 0 : i;
}

export interface SpokenSentence {
  block?: number;
  start?: number;
  end?: number;
  hash?: number;
}

/**
 * The DOM range of a spoken sentence. Exact when the reader's text is what was scripted (same block and
 * hash at that position); otherwise the nearest sentence with the same hash; null if none matches.
 */
export function rangeForSentence(dom: DomScript, s: SpokenSentence): Range | null {
  if (s.block === undefined || s.start === undefined || s.end === undefined) return null;
  const items = dom.script.items;
  let match = items.find((it) => it.block === s.block && it.start === s.start && it.end === s.end && (s.hash === undefined || it.hash === s.hash));
  if (!match && s.hash !== undefined) {
    let best: (typeof items)[number] | undefined;
    for (const it of items) {
      if (it.hash !== s.hash) continue;
      if (!best || Math.abs(it.block - s.block) < Math.abs(best.block - s.block)) best = it;
    }
    match = best;
  }
  if (!match) return null;
  const block = dom.blocks[match.block];
  return block ? blockRange(block, match.start, match.end) : null;
}
