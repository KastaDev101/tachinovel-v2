/** Hooks for e2e tests (only installed when window.__TACHI_DEV__ is set). */
import { bridge } from '../bridge/client.ts';
import { sanitizeChapterToString } from '../lib/sanitize.ts';
import { pop, push, stack } from '../state/nav.ts';

export function installTestHooks(): void {
  window.__tachiTest = {
    sanitize: (html: string) => sanitizeChapterToString(html),
    stackDepth: () => stack.peek().length,
    push,
    pop,
    bridge,
  };
}
