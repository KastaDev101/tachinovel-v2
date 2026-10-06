/** Chapter list helpers for the novel page (pure; unit-tested). */
import type { ChapterView } from '../../shared/contracts/domain.ts';

export interface ChapterFilter {
  unread: boolean;
  bookmarked: boolean;
  downloaded: boolean;
}

export const NO_CHAPTER_FILTER: ChapterFilter = { unread: false, bookmarked: false, downloaded: false };

/**
 * Returns indexes into `chapters` (source order = oldest → newest) after filtering and sorting.
 * Index arrays keep the 3,000-row list cheap to re-sort and let rows look up live chapter state.
 */
export function chapterOrder(chapters: readonly ChapterView[], filter: ChapterFilter, desc: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    if (!c) continue;
    if (filter.unread && c.read) continue;
    if (filter.bookmarked && !c.bookmarked) continue;
    if (filter.downloaded && !c.downloaded) continue;
    out.push(i);
  }
  if (desc) out.reverse();
  return out;
}

export function hasChapterFilter(f: ChapterFilter): boolean {
  return f.unread || f.bookmarked || f.downloaded;
}

/**
 * Finds a chapter for "jump to chapter": a number matches `number` (or the first number in the name),
 * otherwise a case-insensitive substring of the name. Returns the index in `chapters` or -1.
 */
export function findChapter(chapters: readonly ChapterView[], query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return -1;
  const n = Number(q);
  if (Number.isFinite(n)) {
    const exact = chapters.findIndex((c) => c.number === n || firstNumber(c.name) === n);
    if (exact >= 0) return exact;
    // Closest number at or below.
    let best = -1;
    let bestNum = -Infinity;
    chapters.forEach((c, i) => {
      const num = c.number ?? firstNumber(c.name);
      if (num !== undefined && num <= n && num > bestNum) {
        best = i;
        bestNum = num;
      }
    });
    if (best >= 0) return best;
    if (Number.isInteger(n) && n >= 1 && n <= chapters.length) return n - 1;
    return -1;
  }
  return chapters.findIndex((c) => c.name.toLowerCase().includes(q));
}

export function firstNumber(s: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)/.exec(s);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

/** First unread, unlocked chapter after the last read one (or the first chapter). */
export function nextToRead(chapters: readonly ChapterView[]): number {
  let lastRead = -1;
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (chapters[i]?.read) {
      lastRead = i;
      break;
    }
  }
  for (let i = lastRead + 1; i < chapters.length; i++) {
    const c = chapters[i];
    if (c && !c.read && !c.locked) return i;
  }
  return chapters.length > 0 ? 0 : -1;
}

/** Inclusive index range between two positions in display order. */
export function rangeBetween(order: readonly number[], a: number, b: number): number[] {
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia < 0 || ib < 0) return [];
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
  return order.slice(lo, hi + 1);
}
