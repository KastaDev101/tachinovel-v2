/**
 * Paged reading math (pure). A chapter is laid out in CSS columns one page wide; each paragraph is
 * split into fragments, one per page it appears on. Positions stay mode-independent: a paragraph
 * index plus a pixel offset into it, counted down the paragraph's fragments in reading order.
 */
import type { ChapterPosition } from '../../shared/contracts/domain.ts';

/** One paragraph's pieces: the page each piece is on and its height. */
export interface Fragment {
  page: number;
  height: number;
}

/** Pages in a columns box: columns are `pageWidth - 2·margin` wide with a `2·margin` gap. */
export function pageCount(scrollWidth: number, pageWidth: number, margin: number): number {
  if (pageWidth <= 0) return 1;
  return Math.max(1, Math.round((scrollWidth + 2 * margin) / pageWidth));
}

/** Where page `page` starts: the first paragraph with a piece on it, and how far into it. */
export function positionOnPage(paragraphs: readonly (readonly Fragment[])[], page: number, pages: number): ChapterPosition {
  const percent = pages <= 1 ? 1 : Math.max(0, Math.min(1, page / (pages - 1)));
  for (let i = 0; i < paragraphs.length; i++) {
    const frags = paragraphs[i] ?? [];
    if (!frags.some((f) => f.page === page)) continue;
    let offset = 0;
    for (const f of frags) {
      if (f.page >= page) break;
      offset += f.height;
    }
    return { paragraph: i, offset: Math.round(offset), percent: round4(percent) };
  }
  // An empty page (e.g. only an image's overflow): the last paragraph that started before it.
  let last = 0;
  for (let i = 0; i < paragraphs.length; i++) if ((paragraphs[i]?.[0]?.page ?? Infinity) <= page) last = i;
  return { paragraph: last, offset: 0, percent: round4(percent) };
}

/** The page showing `pos` (its paragraph, `offset` px down that paragraph's pieces). */
export function pageForPosition(paragraphs: readonly (readonly Fragment[])[], pos: ChapterPosition, pages: number): number {
  const frags = paragraphs[pos.paragraph];
  if (!frags || frags.length === 0) {
    // Content changed: fall back to the fraction read.
    return clampPage(Math.round(pos.percent * (pages - 1)), pages);
  }
  let left = pos.offset ?? 0;
  for (const f of frags) {
    if (left < f.height) return clampPage(f.page, pages);
    left -= f.height;
  }
  return clampPage(frags[frags.length - 1]?.page ?? 0, pages);
}

/** After a horizontal drag: turn a page (−1 back, +1 forward) or settle back (0). */
export function swipeTurn(dx: number, velocity: number, pageWidth: number): -1 | 0 | 1 {
  // A flick (fast, even if short) or a drag past a fifth of the page.
  if (Math.abs(velocity) > 0.35 && Math.abs(dx) > 12) return velocity < 0 ? 1 : -1;
  if (Math.abs(dx) > pageWidth * 0.2) return dx < 0 ? 1 : -1;
  return 0;
}

function clampPage(p: number, pages: number): number {
  return Math.max(0, Math.min(Math.max(0, pages - 1), p));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
