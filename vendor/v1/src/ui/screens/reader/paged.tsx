/**
 * Paged reading: each chapter is laid out in CSS columns exactly one page wide, and chapters sit side
 * by side on one horizontal track (previous · current · next), so the last page of chapter N turns
 * straight into the first page of N + 1. Turning is a transform-only slide (tap the edges or swipe,
 * iOS easing). Positions are paragraph + offset, the same as the scrolling reader's.
 */
import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ChapterMeta, ChapterPosition } from '../../../shared/contracts/domain.ts';
import type { ChapterContent } from '../../../shared/contracts/protocol.ts';
import { errorText, toUiError, type UiError } from '../../bridge/client.ts';
import { SkeletonLine } from '../../components/feedback.tsx';
import { Icon } from '../../components/icon.tsx';
import { VelocityTracker } from '../../lib/gestures.ts';
import { pageCount, pageForPosition, positionOnPage, swipeTurn, type Fragment } from '../../lib/paged.ts';
import { sanitizeChapter } from '../../lib/sanitize.ts';
import { ensureTitleLine } from './chapter-section.tsx';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const TURN_MS = 300;

export interface PagedHandle {
  goTo: (meta: Pick<ChapterMeta, 'path' | 'name' | 'number'>) => void;
  /** 0..1 within the current chapter. */
  seek: (fraction: number) => void;
  turn: (dir: 1 | -1) => void;
}

export interface PageInfo {
  path: string;
  content: ChapterContent;
  position: ChapterPosition;
  page: number;
  pages: number;
}

interface PSection {
  key: number;
  path: string;
  name?: string;
  number?: number;
  status: 'loading' | 'ready' | 'error' | 'locked';
  content?: ChapterContent;
  error?: UiError;
}

interface Spot {
  key: number;
  page: number;
}

function noAnimations(): boolean {
  return window.__TACHI_DEV__?.noAnimations === true || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function PagedBody(props: { content: ChapterContent; name?: string; number?: number; onReady: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const ready = useRef(props.onReady);
  ready.current = props.onReady;
  useLayoutEffect(() => {
    const body = el.current;
    if (!body) return;
    const frag = sanitizeChapter(props.content.html);
    ensureTitleLine(frag, props.content.title || props.name || '', props.number);
    body.replaceChildren(frag);
    ready.current();
  }, [props.content]);
  return (
    <div class="rd-pcols">
      <div class="rd-body selectable" ref={el} data-testid="reader-body" />
    </div>
  );
}

export function PagedReader(props: {
  handle: RefObject<PagedHandle | null>;
  startPath: string;
  fetch: (path: string) => Promise<ChapterContent>;
  positionFor: (path: string) => ChapterPosition | undefined;
  onPage: (info: PageInfo) => void;
  /** Taps: the reader may take them (bars, double tap); returns true when it did. */
  onTap: (e: MouseEvent, zone: -1 | 0 | 1) => boolean;
  /** Typography signature: a change re-paginates and keeps the reading position. */
  layoutKey: string;
  sourceName: string;
  onOpenSafari: () => void;
}) {
  const keySeq = useRef(2);
  const [sections, setSections] = useState<PSection[]>([{ key: 1, path: props.startPath, status: 'loading' }]);
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const pages = useRef(new Map<number, number>());
  const frags = useRef(new Map<number, Fragment[][]>());
  /** Where we are: section key + page in it. null until the first chapter is placed. */
  const spot = useRef<Spot | null>(null);
  /** Position to land on once the section's text is laid out (start, goTo, re-pagination). */
  const pendingPos = useRef<{ key: number; pos: ChapterPosition | undefined; page?: number } | null>({ key: 1, pos: undefined });
  const lastPos = useRef<ChapterPosition | null>(null);
  const width = useRef(0);
  const anim = useRef<Animation | null>(null);
  const dragged = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;

  // ---------- loading ----------

  function patch(key: number, p: Partial<PSection>): void {
    setSections((ss) => ss.map((s) => (s.key === key ? { ...s, ...p } : s)));
  }

  async function load(key: number, path: string): Promise<void> {
    try {
      const c = await propsRef.current.fetch(path);
      patch(key, { status: 'ready', content: c, name: c.title });
    } catch (err) {
      const e = toUiError(err);
      patch(key, e.code === 'LOCKED' ? { status: 'locked' } : { status: 'error', error: e });
    }
  }

  useEffect(() => {
    void load(1, props.startPath);
  }, []);

  /** Neighbours of the current chapter loaded (or loading); far ones dropped. */
  function ensureAround(): void {
    const cur = spot.current;
    if (!cur) return;
    const ss = sectionsRef.current;
    const i = ss.findIndex((s) => s.key === cur.key);
    const here = ss[i];
    if (!here || here.status !== 'ready' || !here.content) return;
    let next = ss.slice(Math.max(0, i - 1), i + 2);
    const add: { at: 'start' | 'end'; s: PSection }[] = [];
    const nextMeta = here.content.next;
    if (!ss[i + 1] && nextMeta) {
      const s: PSection = { key: keySeq.current++, path: nextMeta.path, name: nextMeta.name, ...(nextMeta.number !== undefined ? { number: nextMeta.number } : {}), status: nextMeta.locked ? 'locked' : 'loading' };
      next = [...next, s];
      add.push({ at: 'end', s });
    }
    const prevMeta = here.content.prev;
    if (!ss[i - 1] && prevMeta) {
      const s: PSection = { key: keySeq.current++, path: prevMeta.path, name: prevMeta.name, ...(prevMeta.number !== undefined ? { number: prevMeta.number } : {}), status: prevMeta.locked ? 'locked' : 'loading' };
      next = [s, ...next];
      add.push({ at: 'start', s });
    }
    if (add.length === 0 && next.length === ss.length) return;
    for (const s of ss) if (!next.includes(s)) {
      pages.current.delete(s.key);
      frags.current.delete(s.key);
    }
    setSections(next);
    for (const a of add) if (a.s.status === 'loading') void load(a.s.key, a.s.path);
  }

  // ---------- geometry ----------

  function sectionEl(key: number): HTMLElement | null {
    return track.current?.querySelector<HTMLElement>(`.rd-psec[data-key="${key}"]`) ?? null;
  }

  function measure(): void {
    const vp = viewport.current;
    if (!vp) return;
    const w = vp.clientWidth;
    width.current = w;
    vp.style.setProperty('--rd-page-w', `${w}px`);
    const margin = parseFloat(getComputedStyle(vp).getPropertyValue('--rd-margin')) || 0;
    for (const s of sectionsRef.current) {
      const el = sectionEl(s.key);
      if (!el) continue;
      const cols = el.querySelector<HTMLElement>('.rd-pcols');
      const n = s.status === 'ready' && cols ? pageCount(cols.scrollWidth, w, margin) : 1;
      pages.current.set(s.key, n);
      el.style.width = `${n * w}px`;
    }
    frags.current.clear();
  }

  function fragmentsOf(key: number): Fragment[][] {
    const hit = frags.current.get(key);
    if (hit) return hit;
    const el = sectionEl(key);
    const body = el?.querySelector<HTMLElement>('.rd-body');
    if (!el || !body) return [];
    const left = el.getBoundingClientRect().left;
    const w = width.current || 1;
    const out = Array.from(body.children).map((child) =>
      Array.from(child.getClientRects())
        .filter((r) => r.height > 0)
        .map((r) => ({ page: Math.max(0, Math.floor((r.left - left + 1) / w)), height: r.height })),
    );
    frags.current.set(key, out);
    return out;
  }

  function xOf(s: Spot): number {
    let x = 0;
    for (const sec of sectionsRef.current) {
      if (sec.key === s.key) break;
      x += (pages.current.get(sec.key) ?? 1) * width.current;
    }
    return x + s.page * width.current;
  }

  function setX(x: number): void {
    anim.current?.cancel();
    anim.current = null;
    if (track.current) track.current.style.transform = `translate3d(${-x}px,0,0)`;
  }

  function slide(from: number, to: number, ms = TURN_MS): Promise<void> {
    const t = track.current;
    if (!t) return Promise.resolve();
    anim.current?.cancel();
    t.style.transform = `translate3d(${-to}px,0,0)`;
    if (noAnimations() || from === to) return Promise.resolve();
    const a = t.animate([{ transform: `translate3d(${-from}px,0,0)` }, { transform: `translate3d(${-to}px,0,0)` }], { duration: ms, easing: EASE });
    anim.current = a;
    return a.finished.then(
      () => undefined,
      () => undefined,
    );
  }

  function report(): void {
    const cur = spot.current;
    if (!cur) return;
    const sec = sectionsRef.current.find((s) => s.key === cur.key);
    if (!sec || sec.status !== 'ready' || !sec.content) return;
    const n = pages.current.get(cur.key) ?? 1;
    const pos = positionOnPage(fragmentsOf(cur.key), cur.page, n);
    lastPos.current = pos;
    propsRef.current.onPage({ path: sec.path, content: sec.content, position: pos, page: cur.page, pages: n });
  }

  // Lay out after every change: section widths, the pending landing spot, the track offset.
  useLayoutEffect(() => {
    measure();
    const p = pendingPos.current;
    if (p) {
      const sec = sectionsRef.current.find((s) => s.key === p.key);
      if (sec && sec.status !== 'loading') {
        pendingPos.current = null;
        const n = pages.current.get(p.key) ?? 1;
        const pos = p.pos ?? (sec.status === 'ready' ? propsRef.current.positionFor(sec.path) ?? sec.content?.position : undefined);
        const page = p.page ?? (pos && sec.status === 'ready' ? pageForPosition(fragmentsOf(p.key), pos, n) : 0);
        spot.current = { key: p.key, page: Math.min(page, n - 1) };
        setX(xOf(spot.current));
        report();
        ensureAround();
        return;
      }
    }
    const cur = spot.current;
    if (cur) {
      const n = pages.current.get(cur.key) ?? 1;
      if (cur.page > n - 1) cur.page = n - 1;
      if (!anim.current) setX(xOf(cur));
    }
  }, [sections]);

  // Typography or size changed: re-paginate, staying on the same paragraph.
  useLayoutEffect(() => {
    const cur = spot.current;
    if (!cur) return;
    const keep = lastPos.current;
    measure();
    const n = pages.current.get(cur.key) ?? 1;
    cur.page = keep ? pageForPosition(fragmentsOf(cur.key), keep, n) : Math.min(cur.page, n - 1);
    setX(xOf(cur));
    report();
  }, [props.layoutKey]);

  useEffect(() => {
    const onResize = (): void => {
      const cur = spot.current;
      if (!cur) return;
      const keep = lastPos.current;
      measure();
      const n = pages.current.get(cur.key) ?? 1;
      cur.page = keep ? pageForPosition(fragmentsOf(cur.key), keep, n) : Math.min(cur.page, n - 1);
      setX(xOf(cur));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ---------- turning ----------

  function neighbour(dir: 1 | -1): Spot | null {
    const cur = spot.current;
    if (!cur) return null;
    const ss = sectionsRef.current;
    const i = ss.findIndex((s) => s.key === cur.key);
    const n = pages.current.get(cur.key) ?? 1;
    if (dir > 0) {
      if (cur.page < n - 1) return { key: cur.key, page: cur.page + 1 };
      const nx = ss[i + 1];
      return nx ? { key: nx.key, page: 0 } : null;
    }
    if (cur.page > 0) return { key: cur.key, page: cur.page - 1 };
    const pv = ss[i - 1];
    return pv ? { key: pv.key, page: (pages.current.get(pv.key) ?? 1) - 1 } : null;
  }

  function settleOn(target: Spot, fromX: number): void {
    const changed = spot.current?.key !== target.key;
    spot.current = target;
    void slide(fromX, xOf(target)).then(() => {
      anim.current = null;
      // Widths may have changed while sliding (a neighbour finished loading): land exactly.
      if (spot.current === target) setX(xOf(target));
      report();
      if (changed) ensureAround();
    });
  }

  function turn(dir: 1 | -1, fromX?: number): void {
    const cur = spot.current;
    if (!cur) return;
    const from = fromX ?? xOf(cur);
    const target = neighbour(dir);
    if (!target) {
      // Nothing there (first page / caught up): a small bounce.
      const nudge = from + dir * Math.min(28, width.current * 0.08);
      void slide(from, nudge, 120).then(() => slide(nudge, xOf(cur), 220));
      return;
    }
    settleOn(target, from);
  }

  props.handle.current = {
    turn: (dir) => turn(dir),
    seek: (fraction) => {
      const cur = spot.current;
      if (!cur) return;
      const n = pages.current.get(cur.key) ?? 1;
      cur.page = Math.max(0, Math.min(n - 1, Math.round(fraction * (n - 1))));
      setX(xOf(cur));
      report();
    },
    goTo: (meta) => {
      const ss = sectionsRef.current;
      const there = ss.find((s) => s.path === meta.path && s.status === 'ready');
      if (there) {
        spot.current = { key: there.key, page: 0 };
        setX(xOf(spot.current));
        report();
        ensureAround();
        return;
      }
      const key = keySeq.current++;
      pages.current.clear();
      frags.current.clear();
      spot.current = null;
      pendingPos.current = { key, pos: undefined };
      setSections([{ key, path: meta.path, name: meta.name, ...(meta.number !== undefined ? { number: meta.number } : {}), status: 'loading' }]);
      void load(key, meta.path);
    },
  };

  // ---------- input: taps and swipes ----------

  function zoneOf(clientX: number): -1 | 0 | 1 {
    const vp = viewport.current;
    if (!vp) return 0;
    const r = vp.getBoundingClientRect();
    const x = (clientX - r.left) / Math.max(1, r.width);
    return x < 0.28 ? -1 : x > 0.72 ? 1 : 0;
  }

  function onClick(e: MouseEvent): void {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('button, a, input')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const zone = zoneOf(e.clientX);
    if (propsRef.current.onTap(e, zone)) return;
    if (zone !== 0) turn(zone);
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const cur = spot.current;
    const vp = viewport.current;
    if (!cur || !vp) return;
    dragged.current = false;
    const sx = e.clientX;
    const sy = e.clientY;
    const base = xOf(cur);
    let horizontal: boolean | null = null;
    const vt = new VelocityTracker();
    vt.add(0);
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (horizontal === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        horizontal = Math.abs(dx) > Math.abs(dy);
        if (!horizontal) return;
        anim.current?.cancel();
        anim.current = null;
        vp.setPointerCapture(ev.pointerId);
      }
      if (!horizontal) return;
      dragged.current = true;
      // Rubber band where there is nothing to turn to.
      const atEdge = (dx > 0 && !neighbour(-1)) || (dx < 0 && !neighbour(1));
      const shown = atEdge ? dx / 3 : dx;
      vt.add(-shown);
      if (track.current) track.current.style.transform = `translate3d(${-(base - shown)}px,0,0)`;
    };
    const up = (ev: PointerEvent): void => {
      vp.removeEventListener('pointermove', move);
      vp.removeEventListener('pointerup', up);
      vp.removeEventListener('pointercancel', up);
      if (!horizontal) return;
      const dx = ev.clientX - sx;
      const from = base - dx;
      const dir = swipeTurn(dx, -vt.velocity(), width.current);
      if (dir !== 0 && neighbour(dir)) turn(dir, from);
      else void slide(from, base, 220);
    };
    vp.addEventListener('pointermove', move);
    vp.addEventListener('pointerup', up);
    vp.addEventListener('pointercancel', up);
  }

  // ---------- render ----------

  return (
    <div class="rd-paged" ref={viewport} onClick={onClick} onPointerDown={onPointerDown} data-testid="reader-paged">
      <div class="rd-ptrack" ref={track}>
        {sections.map((s) => (
          <section class="rd-psec" key={s.key} data-key={s.key} data-path={s.path} data-status={s.status} data-testid="reader-chapter">
            {s.status === 'ready' && s.content ? (
              <PagedBody content={s.content} {...(s.name !== undefined ? { name: s.name } : {})} {...(s.number !== undefined ? { number: s.number } : {})} onReady={() => frags.current.delete(s.key)} />
            ) : (
              <div class="rd-pnote">
                {s.status === 'loading' && (
                  <div class="rd-skeleton" aria-busy="true" aria-label="Loading chapter">
                    {Array.from({ length: 7 }, (_, i) => (
                      <SkeletonLine key={i} width={i === 0 ? '46%' : i === 6 ? '58%' : '100%'} height={13} class="rd-skel-line" />
                    ))}
                  </div>
                )}
                {s.status === 'locked' && (
                  <p class="rd-inline-note rd-locked" data-testid="reader-locked">
                    <Icon name="lock.fill" size={14} />
                    <span>
                      {s.number !== undefined ? `Chapter ${s.number}` : 'This chapter'} is locked on {props.sourceName}.
                    </span>{' '}
                    <button type="button" class="rd-link tap tap-dim" onClick={props.onOpenSafari}>
                      Open in Safari
                    </button>
                  </p>
                )}
                {s.status === 'error' && (
                  <p class="rd-inline-note" data-testid="reader-chapter-error">
                    Couldn’t load {s.number !== undefined ? `chapter ${s.number}` : 'this chapter'}
                    {s.error ? ` (${errorText(s.error)})` : ''} —{' '}
                    <button
                      type="button"
                      class="rd-link tap tap-dim"
                      onClick={() => {
                        patch(s.key, { status: 'loading' });
                        void load(s.key, s.path);
                      }}
                    >
                      Retry
                    </button>
                  </p>
                )}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
