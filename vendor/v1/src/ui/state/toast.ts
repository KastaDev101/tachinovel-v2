/**
 * Toasts with optional Undo. Destructive actions that have no inverse bridge call use
 * `deferredAction`: the UI updates at once, the commit runs when the toast expires (or the app is
 * backgrounded), and Undo simply cancels it.
 */
import { signal } from '@preact/signals';

export interface Toast {
  id: number;
  text: string;
  undo?: () => void;
  /** Label of the action button (default "Undo"). */
  actionLabel?: string;
  tone?: 'default' | 'error';
  durationMs: number;
}

export const toasts = signal<Toast[]>([]);
let seq = 1;
const timers = new Map<number, number>();
const onExpire = new Map<number, () => void>();

export function showToast(
  text: string,
  opts: { undo?: () => void; actionLabel?: string; tone?: 'default' | 'error'; durationMs?: number; onExpire?: () => void } = {},
): number {
  const id = seq++;
  const toast: Toast = {
    id,
    text,
    ...(opts.undo ? { undo: opts.undo } : {}),
    ...(opts.actionLabel ? { actionLabel: opts.actionLabel } : {}),
    ...(opts.tone ? { tone: opts.tone } : {}),
    durationMs: opts.durationMs ?? (opts.undo ? 4500 : 2600),
  };
  // One at a time, like iOS: expire whatever is showing now.
  for (const t of toasts.value) expire(t.id);
  toasts.value = [toast];
  if (opts.onExpire) onExpire.set(id, opts.onExpire);
  timers.set(id, window.setTimeout(() => expire(id), toast.durationMs));
  return id;
}

export function expire(id: number): void {
  window.clearTimeout(timers.get(id));
  timers.delete(id);
  const fn = onExpire.get(id);
  onExpire.delete(id);
  toasts.value = toasts.value.filter((t) => t.id !== id);
  fn?.();
}

export function undoToast(id: number): void {
  const t = toasts.value.find((x) => x.id === id);
  window.clearTimeout(timers.get(id));
  timers.delete(id);
  onExpire.delete(id);
  toasts.value = toasts.value.filter((x) => x.id !== id);
  t?.undo?.();
}

/** Optimistic destructive action: `apply` now, `commit` later unless undone (`revert`). */
export function deferredAction(text: string, apply: () => void, revert: () => void, commit: () => void): void {
  apply();
  showToast(text, { undo: revert, onExpire: commit });
}

/** Commit pending deferred actions immediately (app backgrounded). */
export function flushToasts(): void {
  for (const t of toasts.value) expire(t.id);
}

export function errorToast(text: string): void {
  showToast(text, { tone: 'error' });
}
