/**
 * Reading-position math (pure; unit-tested).
 * Positions are stored as paragraph index + pixel offset inside that paragraph, which survives font
 * and size changes far better than a raw scroll fraction. The fraction is kept as a fallback.
 */
import type { ChapterPosition } from '../../shared/contracts/domain.ts';

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Index of the last element of ascending `tops` that is <= y (0 if y is above the first). */
export function lastIndexAtOrBefore(tops: ArrayLike<number>, y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  if (hi < 0) return 0;
  if (y < (tops[0] ?? 0)) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((tops[mid] ?? 0) <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Position for a reading line at `y` (px, relative to the chapter body's top).
 * `tops` are paragraph tops relative to the same origin, ascending.
 */
export function positionAt(
  tops: ArrayLike<number>,
  y: number,
  percent: number,
): ChapterPosition {
  if (tops.length === 0) return { percent: clamp(percent, 0, 1), paragraph: 0, offset: 0 };
  const paragraph = lastIndexAtOrBefore(tops, y);
  const offset = Math.max(0, Math.round(y - (tops[paragraph] ?? 0)));
  return { percent: round4(clamp(percent, 0, 1)), paragraph, offset };
}

/**
 * Where the reading line should be (relative to the chapter body's top) to restore `pos`.
 * Falls back to the fraction when the paragraph no longer exists (content changed).
 */
export function lineForPosition(
  pos: ChapterPosition,
  tops: ArrayLike<number>,
  heights: ArrayLike<number>,
  bodyHeight: number,
): number {
  const p = pos.paragraph;
  if (Number.isInteger(p) && p >= 0 && p < tops.length) {
    const top = tops[p] ?? 0;
    const h = heights[p] ?? 0;
    // A paragraph "owns" the gap (margin) below it, so offsets saved inside the gap restore exactly.
    const next = p + 1 < tops.length ? tops[p + 1] : undefined;
    const slot = next !== undefined ? Math.max(h, next - top) : h;
    return top + clamp(pos.offset ?? 0, 0, Math.max(0, slot - 1));
  }
  return clamp(pos.percent, 0, 1) * bodyHeight;
}

/** Fraction read: 0 at the chapter top, 1 when its end reaches the bottom of the viewport. */
export function percentRead(scrollTop: number, chapterTop: number, chapterHeight: number, viewportHeight: number): number {
  const scrollable = chapterHeight - viewportHeight;
  if (scrollable <= 0) return scrollTop >= chapterTop ? 1 : 0;
  return clamp((scrollTop - chapterTop) / scrollable, 0, 1);
}

export function scrollTopForPercent(percent: number, chapterTop: number, chapterHeight: number, viewportHeight: number): number {
  return chapterTop + clamp(percent, 0, 1) * Math.max(0, chapterHeight - viewportHeight);
}

/** Index of the chapter section containing `y` (sections ascending by top). */
export function sectionAt(sections: ReadonlyArray<{ top: number; height: number }>, y: number): number {
  if (sections.length === 0) return -1;
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i];
    if (s && y >= s.top) return i;
  }
  return 0;
}

export function samePosition(a: ChapterPosition | undefined, b: ChapterPosition | undefined): boolean {
  if (!a || !b) return a === b;
  return a.paragraph === b.paragraph && (a.offset ?? 0) === (b.offset ?? 0) && Math.abs(a.percent - b.percent) < 0.0005;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Throttled progress saving: at most one save per `intervalMs` while positions keep changing, plus
 * explicit flushes (chapter change, backgrounding, leaving). Timer functions are injectable for tests.
 */
export interface ProgressSaverOptions<T> {
  intervalMs: number;
  save: (value: T) => void;
  equals?: (a: T, b: T) => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ProgressSaver<T> {
  update(value: T): void;
  flush(): void;
  cancel(): void;
  readonly pending: boolean;
}

export function createProgressSaver<T>(opts: ProgressSaverOptions<T>): ProgressSaver<T> {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => globalThis.clearTimeout(h as number));
  let latest: T | undefined;
  let lastSaved: T | undefined;
  let dirty = false;
  let timer: unknown = null;

  function doSave(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (!dirty || latest === undefined) return;
    dirty = false;
    lastSaved = latest;
    opts.save(latest);
  }

  return {
    update(value: T): void {
      latest = value;
      if (lastSaved !== undefined && opts.equals?.(lastSaved, value)) {
        dirty = false;
        return;
      }
      dirty = true;
      timer ??= setTimer(() => {
        timer = null;
        doSave();
      }, opts.intervalMs);
    },
    flush: doSave,
    cancel(): void {
      if (timer !== null) clearTimer(timer);
      timer = null;
      dirty = false;
    },
    get pending(): boolean {
      return dirty;
    },
  };
}
