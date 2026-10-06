/**
 * Fixed-row-height virtual list inside the screen's native scroll container. Rows are absolutely
 * positioned with transforms; the rendered window only changes when the visible rows approach its
 * edges (hysteresis), so a 3,000-row list re-renders in small batches while scrolling.
 */
import type { ComponentChildren, Ref } from 'preact';
import { useImperativeHandle, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { leadFor, nextRange, renderRange, rowAt, rowTop, sameRange, scrollTopForIndex, totalHeight, type Range, type Viewport } from '../lib/virtual.ts';
import { useScroller } from './screen.tsx';

export interface VirtualListHandle {
  scrollToIndex(index: number, opts?: { align?: 'start' | 'center'; smooth?: boolean; inset?: number }): void;
}

/** Offset of `el` inside the scroll content of `scroller`. */
function offsetWithin(el: HTMLElement, scroller: HTMLElement): number {
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== scroller) {
    y += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    if (parent === scroller || parent === null) break;
    node = parent;
  }
  if (node && node.offsetParent !== scroller && node !== scroller) {
    return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }
  return y;
}

export function VirtualList(props: {
  count: number;
  rowHeight: number;
  overscan?: number;
  renderRow: (index: number) => ComponentChildren;
  rowKey?: (index: number) => string | number;
  class?: string;
  handle?: Ref<VirtualListHandle>;
  testId?: string;
  /** Rows of different heights (e.g. section headers): top of each row + total (count + 1 entries). */
  offsets?: readonly number[] | null;
  /** The row at the top of the viewport changed (for sticky section headers). */
  onTopRow?: (index: number) => void;
  /** Height covered at the top of the viewport (the bar the sticky header sits under). */
  topInset?: number;
}) {
  const offsets = props.offsets ?? undefined;
  const topRow = useRef(-1);
  const onTopRow = useRef(props.onTopRow);
  onTopRow.current = props.onTopRow;
  const scroller = useScroller();
  const container = useRef<HTMLDivElement>(null);
  const overscan = props.overscan ?? 10;
  const [range, setRange] = useState<Range>({ start: 0, end: Math.min(props.count, 24) });
  const rangeRef = useRef(range);

  const viewport = (): Viewport | null => {
    const sc = scroller.current;
    const c = container.current;
    if (!sc || !c) return null;
    return { scrollTop: sc.scrollTop, viewportHeight: sc.clientHeight, listTop: offsetWithin(c, sc), rowHeight: props.rowHeight, count: props.count, offsets };
  };

  useLayoutEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    topRow.current = -1; // rows changed: report the top row again
    let listTop = -1;
    let lastTop = sc.scrollTop;
    const update = (force: boolean): void => {
      const v = viewport();
      if (!v) return;
      // listTop only changes on layout changes; cache it between scroll events.
      if (force || listTop < 0) listTop = v.listTop;
      else v.listTop = listTop;
      // Render further ahead in the scroll direction the faster the list moves.
      const lead = leadFor(v.scrollTop - lastTop, props.rowHeight);
      lastTop = v.scrollTop;
      // On layout changes (mount, resize) render a screenful extra below: the first fling starts
      // before the first scroll event arrives.
      const next = force ? renderRange(v, overscan, Math.max(lead, overscan * 2)) : nextRange(rangeRef.current, v, overscan, lead);
      if (!sameRange(next, rangeRef.current)) {
        rangeRef.current = next;
        setRange(next);
      }
      if (onTopRow.current) {
        const t = Math.max(0, Math.min(props.count - 1, rowAt(v, v.scrollTop - v.listTop + (props.topInset ?? 0))));
        if (t !== topRow.current) {
          topRow.current = t;
          onTopRow.current(t);
        }
      }
    };
    // While the list moves, also follow it every animation frame: engines may coalesce scroll events
    // (desktop WebKit does for programmatic scrolls), and a fling must never outrun the rows.
    let raf = 0;
    let still = 0;
    let seen = -1;
    const follow = (): void => {
      const st = sc.scrollTop;
      if (st !== seen) {
        seen = st;
        still = 0;
        update(false);
      } else if (++still > 8) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(follow);
    };
    const onScroll = (): void => {
      seen = sc.scrollTop;
      update(false);
      if (!raf) raf = requestAnimationFrame(follow);
    };
    const onResize = (): void => update(true);
    const startFollowing = (): void => {
      seen = sc.scrollTop;
      if (!raf) raf = requestAnimationFrame(follow);
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    sc.addEventListener('touchstart', startFollowing, { passive: true });
    sc.addEventListener('wheel', startFollowing, { passive: true });
    const ro = new ResizeObserver(onResize);
    ro.observe(sc);
    if (container.current?.parentElement) ro.observe(container.current.parentElement);
    update(true);
    return () => {
      sc.removeEventListener('scroll', onScroll);
      sc.removeEventListener('touchstart', startFollowing);
      sc.removeEventListener('wheel', startFollowing);
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [props.count, props.rowHeight, offsets]);

  useImperativeHandle(props.handle ?? null, () => ({
    scrollToIndex(index, opts = {}) {
      const sc = scroller.current;
      const v = viewport();
      if (!sc || !v) return;
      const top = scrollTopForIndex(index, {
        rowHeight: props.rowHeight,
        listTop: v.listTop,
        viewportHeight: v.viewportHeight,
        contentHeight: sc.scrollHeight,
        align: opts.align ?? 'center',
        inset: opts.inset ?? 0,
        offsets,
      });
      sc.scrollTo({ top, behavior: opts.smooth ? 'smooth' : 'auto' });
    },
  }));

  const rows: ComponentChildren[] = [];
  const end = Math.min(range.end, props.count);
  for (let i = range.start; i < end; i++) {
    rows.push(
      <div
        class="vrow"
        key={props.rowKey ? props.rowKey(i) : i}
        style={{ transform: `translate3d(0,${rowTop({ rowHeight: props.rowHeight, offsets }, i)}px,0)`, height: `${offsets ? (offsets[i + 1] ?? 0) - (offsets[i] ?? 0) : props.rowHeight}px` }}
      >
        {props.renderRow(i)}
      </div>,
    );
  }
  return (
    <div class={`vlist ${props.class ?? ''}`} ref={container} style={{ height: `${totalHeight(props.count, props.rowHeight, offsets)}px` }} data-testid={props.testId} data-count={props.count}>
      {rows}
    </div>
  );
}
