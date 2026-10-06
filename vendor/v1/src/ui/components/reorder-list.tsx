/**
 * Drag-to-reorder rows (iOS edit-mode style): drag a row by its grip; the others slide out of the
 * way (transform only) and the new order is committed on release. Rows are equal height.
 */
import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { haptic } from '../lib/gestures.ts';
import { moveItem, slotFor } from '../lib/reorder.ts';
import { Icon } from './icon.tsx';

interface Drag {
  from: number;
  to: number;
  dy: number;
}

export function ReorderList<T>(props: {
  items: readonly T[];
  keyOf: (item: T) => string;
  render: (item: T, index: number) => ComponentChildren;
  onReorder: (next: T[]) => void;
  /** Accessible name of each grip ("Reorder Reading"). */
  gripLabel: (item: T) => string;
  testId?: string;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const rowH = useRef(0);

  function start(e: PointerEvent, index: number): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const grip = e.currentTarget as HTMLElement;
    const row = grip.closest<HTMLElement>('[data-reorder-row]');
    if (!row) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    rowH.current = row.offsetHeight;
    const y0 = e.clientY;
    let current: Drag = { from: index, to: index, dy: 0 };
    setDrag(current);
    haptic();
    const move = (ev: PointerEvent): void => {
      const dy = ev.clientY - y0;
      const to = slotFor(index, dy, rowH.current, props.items.length);
      if (to !== current.to) haptic();
      current = { from: index, to, dy };
      setDrag(current);
    };
    const end = (): void => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      setDrag(null);
      if (current.to !== current.from) props.onReorder(moveItem(props.items, current.from, current.to));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  /** How far row `i` is shifted while another row is dragged over it. */
  const shift = (i: number): number => {
    if (!drag || i === drag.from) return 0;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -rowH.current;
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return rowH.current;
    return 0;
  };

  return (
    <div class={`reorder-list${drag ? ' is-dragging' : ''}`} ref={list} data-testid={props.testId}>
      {props.items.map((item, i) => {
        const dragging = drag?.from === i;
        return (
          <div
            class={`reorder-row${dragging ? ' is-lifted' : ''}`}
            key={props.keyOf(item)}
            data-reorder-row
            style={{ transform: `translate3d(0, ${dragging ? (drag?.dy ?? 0) : shift(i)}px, 0)` }}
          >
            <div class="reorder-content">{props.render(item, i)}</div>
            <button type="button" class="reorder-grip" aria-label={props.gripLabel(item)} onPointerDown={(e) => start(e, i)} data-testid="reorder-grip">
              <Icon name="line.3.horizontal" size={18} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
