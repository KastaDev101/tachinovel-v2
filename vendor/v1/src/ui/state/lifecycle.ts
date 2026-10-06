/**
 * App backgrounding. iOS may kill a backgrounded Scriptable, so on visibilitychange → hidden the UI
 * first lets screens save (the reader's progress.save), then flushes debounced settings and pending
 * Undo-able actions, and finally asks the script to persist everything (`app.flush`).
 */
import { bridge } from '../bridge/client.ts';
import { flushSettings } from './store.ts';
import { flushToasts } from './toast.ts';

const savers = new Set<() => void>();

/** Register a synchronous "save now" callback; returns an unregister function. */
export function onBackground(fn: () => void): () => void {
  savers.add(fn);
  return () => savers.delete(fn);
}

export function flushAll(): void {
  for (const fn of savers) {
    try {
      fn();
    } catch (err) {
      console.warn('background save failed', err);
    }
  }
  flushSettings();
  flushToasts();
  bridge()
    .call('app.flush')
    .catch(() => undefined);
}

export function installLifecycle(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
  // pagehide also fires when the WebView is torn down.
  window.addEventListener('pagehide', flushAll);
}
