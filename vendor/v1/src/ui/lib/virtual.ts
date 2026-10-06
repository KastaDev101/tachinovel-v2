/**
 * Fixed-row-height virtualization math (pure; unit-tested).
 * Coordinates: `scrollTop` of the scroll container, `listTop` = offset of the list's first row inside
 * the scroll content. Ranges are [start, end) row indexes.
 */
export interface Range {
  start: number;
  end: number;
}

export interface Viewport {
  scrollTop: number;
  viewportHeight: number;
  listTop: number;
  rowHeight: number;
  count: number;
  /** Rows of different heights: top of each row plus the total at the end (count + 1 entries). */
  offsets?: ArrayLike<number> | undefined;
}

export const EMPTY_RANGE: Range = { start: 0, end: 0 };

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Index of the row containing `y` (list coordinates); with offsets, by binary search. */
export function rowAt(v: Pick<Viewport, 'rowHeight' | 'count' | 'offsets'>, y: number): number {
  const o = v.offsets;
  if (!o) return Math.floor(y / v.rowHeight);
  let lo = 0;
  let hi = v.count; // offsets[count] = total height
  if (y < (o[0] ?? 0)) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((o[mid] ?? Infinity) <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Top of row `i` in list coordinates. */
export function rowTop(v: Pick<Viewport, 'rowHeight' | 'offsets'>, i: number): number {
  return v.offsets ? (v.offsets[i] ?? 0) : i * v.rowHeight;
}

/** Rows that intersect the viewport. */
export function visibleRange(v: Viewport): Range {
  if (v.count <= 0 || v.rowHeight <= 0 || v.viewportHeight <= 0) return EMPTY_RANGE;
  const top = v.scrollTop - v.listTop;
  if (v.offsets) {
    const start = clamp(rowAt(v, top), 0, v.count);
    const bottom = top + v.viewportHeight;
    const last = rowAt(v, bottom);
    // The row starting exactly at the bottom edge isn't visible.
    const end = clamp(rowTop(v, last) >= bottom ? last : last + 1, 0, v.count);
    return { start, end: Math.max(start, end) };
  }
  const start = clamp(Math.floor(top / v.rowHeight), 0, v.count);
  const end = clamp(Math.ceil((top + v.viewportHeight) / v.rowHeight), 0, v.count);
  return { start, end: Math.max(start, end) };
}

/**
 * Visible rows plus `overscan` rows on each side, plus `lead` extra rows in the scroll direction
 * (positive = scrolling down, negative = up) so fast flings never outrun the rendered window.
 */
export function renderRange(v: Viewport, overscan: number, lead = 0): Range {
  const vis = visibleRange(v);
  if (vis.end === vis.start && (vis.start === 0 || vis.start === v.count)) {
    // List entirely above/below the viewport: render a small edge so measuring still works.
    if (v.count === 0) return EMPTY_RANGE;
    if (vis.start === 0) return { start: 0, end: Math.min(v.count, overscan + Math.max(0, lead)) };
    return { start: Math.max(0, v.count - overscan), end: v.count };
  }
  return {
    start: Math.max(0, vis.start - overscan - Math.max(0, -lead)),
    end: Math.min(v.count, vis.end + overscan + Math.max(0, lead)),
  };
}

/**
 * Hysteresis: keep the current range while the visible rows stay at least `overscan / 2` rows (plus
 * the lead in the scroll direction) away from its edges, so scrolling re-renders in batches instead
 * of on every scroll event.
 */
export function nextRange(current: Range, v: Viewport, overscan: number, lead = 0): Range {
  const vis = visibleRange(v);
  const margin = Math.max(1, Math.floor(overscan / 2));
  const okStart = current.start === 0 || vis.start - current.start >= margin + Math.max(0, -lead);
  const okEnd = current.end >= v.count || current.end - vis.end >= margin + Math.max(0, lead);
  const inside = vis.start >= current.start && vis.end <= current.end;
  const tooBig = current.end - current.start > vis.end - vis.start + overscan * 4 + Math.abs(lead) * 2;
  if (inside && okStart && okEnd && !tooBig && current.end <= v.count && (vis.end > vis.start || current.end > current.start)) {
    return current;
  }
  return renderRange(v, overscan, lead);
}

/** Extra rows to render ahead for a scroll step of `delta` px (≈ 4 steps of look-ahead, capped). */
export function leadFor(delta: number, rowHeight: number, cap = 40): number {
  if (rowHeight <= 0 || delta === 0) return 0;
  const rows = Math.min(cap, Math.ceil((Math.abs(delta) * 4) / rowHeight));
  return delta > 0 ? rows : -rows;
}

export function sameRange(a: Range, b: Range): boolean {
  return a.start === b.start && a.end === b.end;
}

export function totalHeight(count: number, rowHeight: number, offsets?: ArrayLike<number>): number {
  if (offsets) return offsets[Math.max(0, count)] ?? 0;
  return Math.max(0, count) * rowHeight;
}

/** scrollTop that brings row `index` to the top (or centre) of the viewport, clamped to the content. */
export function scrollTopForIndex(
  index: number,
  opts: { rowHeight: number; listTop: number; viewportHeight: number; contentHeight: number; align?: 'start' | 'center'; inset?: number; offsets?: ArrayLike<number> | undefined },
): number {
  const o = opts.offsets;
  const top = opts.listTop + (o ? (o[index] ?? 0) : index * opts.rowHeight);
  const h = o ? (o[index + 1] ?? 0) - (o[index] ?? 0) : opts.rowHeight;
  const inset = opts.inset ?? 0;
  const raw = opts.align === 'center' ? top - (opts.viewportHeight - h) / 2 : top - inset;
  return clamp(Math.round(raw), 0, Math.max(0, opts.contentHeight - opts.viewportHeight));
}
