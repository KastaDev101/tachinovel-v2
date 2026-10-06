/**
 * Sentence highlighting in the v1 reader while narrated AUDIO plays.
 *
 * The narrator's timestamp manifest (v1 experiments/tts/manifest.ts) gives every sentence a
 * (block, start, end) in the CANONICAL text of the chapter's blocks. The reader's DOM may differ a
 * little (inserted title line, cleanup rules), so we rebuild blocks from the rendered chapter with v1's
 * DOM walker (dom-blocks.ts, same rules as the narrator) and re-map segments by their text hashes
 * (alignSegments). The spoken sentence becomes a DOM Range painted with the CSS Custom Highlight API
 * (no DOM mutation, so v1's reader and its position math are untouched); without that API, the
 * paragraph gets a class instead.
 */
import { alignSegments, type NarrationManifest, type TimedSegment } from '@v1tts/manifest.ts';
import { blockRange, domBlocks, type DomBlock } from '@v1tts/player/dom-blocks.ts';

export interface ChapterAlignment {
  chapterPath: string;
  body: HTMLElement;
  blocks: DomBlock[];
  /** manifest segment id → segment in the READER's blocks. */
  byId: Map<number, TimedSegment>;
  mode: 'exact' | 'hash' | 'none';
}

export function alignChapter(chapterPath: string, body: HTMLElement, manifestJson: string): ChapterAlignment | null {
  let manifest: NarrationManifest;
  try {
    manifest = JSON.parse(manifestJson) as NarrationManifest;
  } catch {
    return null;
  }
  if (manifest.kind !== 'tachinovel.narration' || !Array.isArray(manifest.segments)) return null;
  const blocks = domBlocks(body);
  const a = alignSegments(manifest, blocks, { title: manifest.chapter?.title });
  const byId = new Map<number, TimedSegment>();
  for (const s of a.segments) byId.set(s.id, s);
  // Diagnostics (Web Inspector / tests): how well the timestamps matched the reader's text.
  document.documentElement.dataset.tnAlign = `${a.mode} ${a.matched}/${a.total} blocks=${blocks.length}`;
  return { chapterPath, body, blocks, byId, mode: a.mode };
}

interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

const HIGHLIGHT = 'tn-spoken';

function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const H = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return css?.highlights && H ? css.highlights : null;
}

let paragraphEl: Element | null = null;

/** Paint segment `id` of an aligned chapter; returns the element to keep in view, if any. */
export function paintSegment(al: ChapterAlignment, id: number): Element | null {
  const seg = al.byId.get(id);
  clearPaint();
  if (!seg || al.mode === 'none') return null;
  const block = al.blocks[seg.block];
  if (!block) return null;
  const range = blockRange(block, seg.start, seg.end);
  const reg = registry();
  const H = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (range && reg && H) {
    reg.set(HIGHLIGHT, new H(range));
  } else if (block.element) {
    paragraphEl = block.element;
    paragraphEl.classList.add('tn-speaking');
  }
  return block.element ?? range?.startContainer.parentElement ?? null;
}

export function clearPaint(): void {
  registry()?.delete(HIGHLIGHT);
  paragraphEl?.classList.remove('tn-speaking');
  paragraphEl = null;
}

/** Index of the reader block that contains a DOM element (for "listen from this paragraph"). */
export function blockIndexOfElement(blocks: readonly DomBlock[], el: Element): number {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b?.element && (b.element === el || el.contains(b.element) || b.element.contains(el))) return i;
  }
  return 0;
}

export const HIGHLIGHT_CSS = `::highlight(${HIGHLIGHT}){background-color:rgba(168,180,255,.32);color:inherit}`;

/** Paint a DOM range (speech: the sentence being spoken); without the Highlight API, the paragraph. */
export function paintRange(range: Range | null, fallback: Element | null): Element | null {
  clearPaint();
  const reg = registry();
  const H = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (range && reg && H) {
    reg.set(HIGHLIGHT, new H(range));
    return range.startContainer.parentElement;
  }
  if (fallback) {
    paragraphEl = fallback;
    paragraphEl.classList.add('tn-speaking');
  }
  return fallback;
}
