/**
 * Bottom sheet with detents ('fit' | 'medium' | 'large') and drag-to-dismiss: drag the grabber/header
 * with any pointer, or pull the content down from its top on touch devices. Animates transform only.
 */
import { createPortal, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { VelocityTracker } from '../lib/gestures.ts';
import { Icon } from './icon.tsx';
import { ScrollContext } from './screen.tsx';

export type Detent = 'fit' | 'medium' | 'large';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ComponentChildren;
  detents?: Detent[];
  children: ComponentChildren;
  left?: ComponentChildren;
  right?: ComponentChildren;
  /** Show a circular close (x) button on the right when no `right` is given. */
  closeButton?: boolean;
  class?: string;
  testId?: string;
  /** Lighter backdrop (reader settings keep the text visible). */
  dimBackdrop?: boolean;
}

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

function overlayRoot(): HTMLElement {
  return document.getElementById('overlay-root') ?? document.body;
}

export function Sheet(props: SheetProps) {
  const [mounted, setMounted] = useState(props.open);
  useEffect(() => {
    if (props.open) setMounted(true);
  }, [props.open]);
  if (!mounted) return null;
  return createPortal(<SheetInner {...props} onExited={() => setMounted(false)} />, overlayRoot());
}

function SheetInner(props: SheetProps & { onExited: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const detents = props.detents ?? ['fit'];
  const hasLarge = detents.includes('large');
  const hasMedium = detents.includes('medium');
  const offsetRef = useRef(0);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;

  /** translateY (px) for each resting position; the panel's own height = "closed". */
  const stops = (): { open: number[]; closed: number } => {
    const el = panel.current;
    const h = el?.offsetHeight ?? 0;
    const vh = el?.parentElement?.clientHeight ?? window.innerHeight;
    const open: number[] = [];
    if (hasLarge || detents.includes('fit')) open.push(0);
    if (hasMedium && hasLarge) open.push(Math.max(0, h - vh * 0.52));
    else if (hasMedium) open.push(0);
    return { open, closed: h };
  };

  const setY = (y: number): void => {
    offsetRef.current = y;
    const el = panel.current;
    if (el) el.style.transform = `translate3d(0,${y}px,0)`;
    const b = body.current;
    if (b) b.style.paddingBottom = `${Math.max(0, y)}px`;
  };

  const animateTo = (y: number, opts: { duration?: number; velocity?: number } = {}): Promise<void> => {
    const el = panel.current;
    const bd = backdrop.current;
    if (!el) return Promise.resolve();
    const from = offsetRef.current;
    const { closed } = stops();
    offsetRef.current = y;
    el.style.transform = `translate3d(0,${y}px,0)`;
    const duration = opts.duration ?? 380;
    const a = el.animate([{ transform: `translate3d(0,${from}px,0)` }, { transform: `translate3d(0,${y}px,0)` }], { duration, easing: EASE });
    if (bd) {
      const o0 = 1 - Math.min(1, Math.max(0, from / Math.max(1, closed)));
      const o1 = y >= closed ? 0 : 1;
      bd.style.opacity = String(o1);
      bd.animate([{ opacity: o0 }, { opacity: o1 }], { duration, easing: EASE });
    }
    return a.finished.then(
      () => {
        if (body.current) body.current.style.paddingBottom = `${Math.max(0, y < closed ? y : 0)}px`;
      },
      () => undefined,
    );
  };

  // Enter.
  useLayoutEffect(() => {
    const { open, closed } = stops();
    setY(closed);
    if (backdrop.current) backdrop.current.style.opacity = '0';
    const start = open.length > 1 ? (open[1] ?? 0) : (open[0] ?? 0);
    if (window.__TACHI_DEV__?.noAnimations) {
      setY(start);
      if (backdrop.current) backdrop.current.style.opacity = '1';
      return;
    }
    void animateTo(start, { duration: 420 });
  }, []);

  // Exit when `open` turns false.
  useEffect(() => {
    if (props.open) return;
    const { closed } = stops();
    if (window.__TACHI_DEV__?.noAnimations) {
      props.onExited();
      return;
    }
    void animateTo(closed, { duration: 300 }).then(props.onExited);
  }, [props.open]);

  // Escape closes (desktop dev).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function settle(velocity: number): void {
    const { open, closed } = stops();
    const y = offsetRef.current;
    const projected = y + velocity * 180;
    const candidates = [...open, closed];
    let best = candidates[0] ?? closed;
    for (const c of candidates) if (Math.abs(c - projected) < Math.abs(best - projected)) best = c;
    if (velocity > 1.1) best = closed;
    if (best >= closed - 1) {
      closeRef.current();
    } else {
      void animateTo(best, { duration: 320 });
    }
  }

  // Grabber/header drag (pointer events; works with mouse in dev and touch on the phone).
  function onHandleDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('button, input, select, a')) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startOffset = offsetRef.current;
    const vt = new VelocityTracker();
    vt.add(startOffset);
    const minY = Math.min(...stops().open);
    const move = (ev: PointerEvent): void => {
      let y = startOffset + (ev.clientY - startY);
      if (y < minY) y = minY - Math.sqrt(minY - y) * 2; // rubber band past the top detent
      setY(y);
      vt.add(y);
      syncBackdrop();
    };
    const up = (): void => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      settle(vt.velocity());
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  function syncBackdrop(): void {
    const { closed } = stops();
    const bd = backdrop.current;
    if (bd) bd.style.opacity = String(1 - Math.min(1, Math.max(0, offsetRef.current / Math.max(1, closed))));
  }

  // Content drag from the top (touch only): pull down to dismiss / move between detents.
  useEffect(() => {
    const b = body.current;
    if (!b) return;
    let startY = 0;
    let startOffset = 0;
    let dragging = false;
    let decided = false;
    const vt = new VelocityTracker();
    const start = (e: TouchEvent): void => {
      const t = e.touches[0];
      if (!t || e.touches.length > 1) return;
      startY = t.clientY;
      startOffset = offsetRef.current;
      dragging = false;
      decided = false;
      vt.reset();
    };
    const move = (e: TouchEvent): void => {
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - startY;
      if (!decided) {
        if (Math.abs(dy) < 4) return;
        decided = true;
        const minY = Math.min(...stops().open);
        dragging = (dy > 0 && b.scrollTop <= 0) || (dy < 0 && offsetRef.current > minY + 1);
      }
      if (!dragging) return;
      e.preventDefault();
      const minY = Math.min(...stops().open);
      setY(Math.max(minY, startOffset + dy));
      vt.add(offsetRef.current);
      syncBackdrop();
    };
    const end = (): void => {
      if (dragging) settle(vt.velocity());
      dragging = false;
    };
    b.addEventListener('touchstart', start, { passive: true });
    b.addEventListener('touchmove', move, { passive: false });
    b.addEventListener('touchend', end, { passive: true });
    b.addEventListener('touchcancel', end, { passive: true });
    return () => {
      b.removeEventListener('touchstart', start);
      b.removeEventListener('touchmove', move);
      b.removeEventListener('touchend', end);
      b.removeEventListener('touchcancel', end);
    };
  }, []);

  const right =
    props.right ??
    (props.closeButton !== false ? (
      <button type="button" class="sheet-close tap tap-dim" aria-label="Close" onClick={() => props.onClose()} data-testid="sheet-close">
        <Icon name="xmark" size={13} />
      </button>
    ) : null);

  return (
    <div class={`sheet-wrap${props.open ? '' : ' is-closing'} ${props.class ?? ''}`} role="dialog" aria-modal="true" data-testid={props.testId}>
      <div class={`sheet-backdrop${props.dimBackdrop === false ? ' is-clear' : ''}`} ref={backdrop} onClick={() => props.onClose()} />
      <div class={`sheet-panel${hasLarge ? ' is-large' : ''}`} ref={panel}>
        <div class="sheet-handle" onPointerDown={onHandleDown}>
          <div class="sheet-grabber" />
          {(props.title !== undefined || props.left !== undefined || right) && (
            <div class="sheet-header">
              <div class="sheet-side">{props.left}</div>
              <div class="sheet-title">{props.title}</div>
              <div class="sheet-side sheet-side-right">{right}</div>
            </div>
          )}
        </div>
        <div class="sheet-body" ref={body}>
          <ScrollContext.Provider value={body}>{props.children}</ScrollContext.Provider>
        </div>
      </div>
    </div>
  );
}
