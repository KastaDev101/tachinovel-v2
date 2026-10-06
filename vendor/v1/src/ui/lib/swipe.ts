/**
 * Swipe actions on list rows, iOS Mail style. DOM-level (like attachLongPress) so long lists don't
 * re-render while a finger moves; only `transform` is animated.
 *
 * Markup: a row `[data-swipe]` holds `.sw-content` (moves with the finger) over
 * `.sw-actions.is-leading` / `.is-trailing` (revealed underneath). `data-leading` /
 * `data-trailing` on the row say which sides it allows. A long swipe commits the action; a shorter
 * one leaves it open (tap the action button to commit; tap anywhere else to close). Vertical drags
 * are left to native scrolling (`touch-action: pan-y` on the row).
 */
import { haptic } from './gestures.ts';

export type SwipeSide = 'leading' | 'trailing';

export interface SwipeOptions {
  onCommit: (row: HTMLElement, side: SwipeSide) => void;
}

/** Width of an open action button (px). */
const ACTION_W = 88;
/** Fraction of the row width past which releasing commits. */
const COMMIT_AT = 0.5;

function contentOf(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>(':scope > .sw-content');
}

function setOffset(row: HTMLElement, x: number, animate: boolean): void {
  const c = contentOf(row);
  if (!c) return;
  row.classList.toggle('is-animating', animate);
  c.style.transform = x === 0 ? '' : `translate3d(${x}px,0,0)`;
  if (x > 0) row.dataset['dir'] = 'leading';
  else if (x < 0) row.dataset['dir'] = 'trailing';
  else if (!animate) delete row.dataset['dir'];
}

export function attachSwipe(root: HTMLElement, opts: SwipeOptions): () => void {
  let row: HTMLElement | null = null;
  let open: { row: HTMLElement; side: SwipeSide } | null = null;
  let sx = 0;
  let sy = 0;
  let base = 0;
  let offset = 0;
  let mode: 'idle' | 'pending' | 'drag' | 'ignore' = 'idle';
  let armed = false;
  let swallowClick = false;
  let pointerId = -1;

  const allowed = (r: HTMLElement, side: SwipeSide): boolean => r.dataset[side] !== undefined && r.dataset[side] !== '';

  const close = (animate = true): void => {
    if (!open) return;
    const r = open.row;
    open = null;
    setOffset(r, 0, animate);
    if (animate) window.setTimeout(() => r.classList.remove('is-animating'), 280);
  };

  const commit = (r: HTMLElement, side: SwipeSide): void => {
    const width = r.offsetWidth || 375;
    setOffset(r, side === 'leading' ? width : -width, true);
    open = null;
    window.setTimeout(() => {
      opts.onCommit(r, side);
      // The row usually stays (read toggled) or disappears (deleted); either way, settle it.
      setOffset(r, 0, false);
      r.classList.remove('is-animating', 'is-armed');
    }, 200);
  };

  const down = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target instanceof Element ? e.target : null;
    const r = target?.closest<HTMLElement>('[data-swipe]') ?? null;
    // Tapping an open action commits it.
    const actionBtn = target?.closest<HTMLElement>('.sw-action') ?? null;
    if (open && actionBtn && open.row.contains(actionBtn)) return;
    if (open) {
      // Any other touch closes the open row first (and doesn't count as a tap on it).
      if (r === open.row) swallowClick = true;
      close();
      mode = 'ignore';
      return;
    }
    if (!r || !root.contains(r)) return;
    row = r;
    sx = e.clientX;
    sy = e.clientY;
    base = 0;
    offset = 0;
    armed = false;
    mode = 'pending';
    pointerId = e.pointerId;
  };

  const move = (e: PointerEvent): void => {
    if (!row || e.pointerId !== pointerId || mode === 'idle' || mode === 'ignore') return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (mode === 'pending') {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        mode = 'ignore';
        return;
      }
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      mode = 'drag';
      row.classList.add('is-swiping');
      try {
        row.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointers can't be captured; the root still sees their moves.
      }
    }
    let x = base + dx;
    const side: SwipeSide = x > 0 ? 'leading' : 'trailing';
    if (!allowed(row, side)) x = Math.sign(x) * Math.min(18, Math.abs(x) * 0.15); // rubber band
    offset = x;
    setOffset(row, x, false);
    const width = row.offsetWidth || 375;
    const nowArmed = allowed(row, side) && Math.abs(x) > width * COMMIT_AT;
    if (nowArmed !== armed) {
      armed = nowArmed;
      row.classList.toggle('is-armed', armed);
      if (armed) haptic();
    }
  };

  const up = (e: PointerEvent): void => {
    if (!row || e.pointerId !== pointerId) {
      if (mode === 'ignore') mode = 'idle';
      return;
    }
    const r = row;
    row = null;
    const wasDrag = mode === 'drag';
    mode = 'idle';
    r.classList.remove('is-swiping');
    if (!wasDrag) return;
    swallowClick = true;
    const side: SwipeSide = offset > 0 ? 'leading' : 'trailing';
    if (armed) {
      commit(r, side);
    } else if (allowed(r, side) && Math.abs(offset) > ACTION_W * 0.6) {
      setOffset(r, side === 'leading' ? ACTION_W : -ACTION_W, true);
      open = { row: r, side };
    } else {
      setOffset(r, 0, true);
      window.setTimeout(() => r.classList.remove('is-animating'), 280);
    }
    r.classList.remove('is-armed');
    armed = false;
  };

  const click = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    const actionBtn = target?.closest<HTMLElement>('.sw-action') ?? null;
    if (actionBtn && open && open.row.contains(actionBtn)) {
      e.preventDefault();
      e.stopPropagation();
      commit(open.row, open.side);
      return;
    }
    if (swallowClick) {
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // Closing an open row from a tap outside the list.
  const docDown = (e: PointerEvent): void => {
    if (open && !(e.target instanceof Node && root.contains(e.target))) close();
  };

  root.addEventListener('pointerdown', down, { passive: true });
  root.addEventListener('pointermove', move, { passive: true });
  root.addEventListener('pointerup', up, { passive: true });
  root.addEventListener('pointercancel', up, { passive: true });
  root.addEventListener('click', click, true);
  document.addEventListener('pointerdown', docDown, { passive: true, capture: true });
  return () => {
    close(false);
    root.removeEventListener('pointerdown', down);
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerup', up);
    root.removeEventListener('pointercancel', up);
    root.removeEventListener('click', click, true);
    document.removeEventListener('pointerdown', docDown, true);
  };
}
