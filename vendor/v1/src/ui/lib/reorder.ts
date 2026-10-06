/** Drag-to-reorder math (pure). */

/** The slot a row dragged `dy` px from `from` lands in (rows `rowH` tall, `count` rows). */
export function slotFor(from: number, dy: number, rowH: number, count: number): number {
  if (rowH <= 0 || count <= 0) return from;
  const to = from + Math.round(dy / rowH);
  return Math.max(0, Math.min(count - 1, to));
}

/** `items` with the one at `from` moved to `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [it] = next.splice(from, 1);
  if (it === undefined) return next;
  next.splice(to, 0, it);
  return next;
}
