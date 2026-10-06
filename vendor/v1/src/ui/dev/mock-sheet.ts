/**
 * Dev stand-ins for the native iOS action sheet and alert (on the phone these are Scriptable's
 * Alert.presentSheet / presentAlert). Plain DOM so it works outside the Preact tree.
 */
import type { NativeAction } from '../../shared/contracts/protocol.ts';
import { MOCK_SHEET_CSS } from './mock-css.ts';

let styleInjected = false;
function injectStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = MOCK_SHEET_CSS;
  document.head.append(style);
}

interface SheetOpts {
  title?: string;
  message?: string;
  actions: NativeAction[];
  cancel?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Resolves with the chosen action index, or -1 for cancel (Scriptable's convention). */
export function presentMockSheet(opts: SheetOpts, kind: 'sheet' | 'alert'): Promise<number> {
  injectStyle();
  return new Promise((resolve) => {
    const root = document.getElementById('overlay-root') ?? document.body;
    const wrap = el('div', `mock-native mock-${kind}`);
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', opts.title ?? 'Actions');
    const backdrop = el('div', 'mock-backdrop');
    const panel = el('div', 'mock-panel');
    const group = el('div', 'mock-group');
    if (opts.title || opts.message) {
      const head = el('div', 'mock-head');
      if (opts.title) head.append(el('div', 'mock-title', opts.title));
      if (opts.message) head.append(el('div', 'mock-message', opts.message));
      group.append(head);
    }
    let done = false;
    const finish = (index: number): void => {
      if (done) return;
      done = true;
      wrap.classList.remove('is-open');
      window.setTimeout(() => wrap.remove(), 260);
      resolve(index);
    };
    opts.actions.forEach((a, i) => {
      const b = el('button', `mock-action${a.destructive ? ' is-destructive' : ''}`, a.title);
      b.type = 'button';
      b.addEventListener('click', () => finish(i));
      group.append(b);
    });
    panel.append(group);
    const cancelText = opts.cancel ?? 'Cancel';
    const cancel = el('button', 'mock-action mock-cancel', cancelText);
    cancel.type = 'button';
    cancel.addEventListener('click', () => finish(-1));
    if (kind === 'sheet') {
      const cg = el('div', 'mock-group');
      cg.append(cancel);
      panel.append(cg);
    } else {
      group.append(cancel);
    }
    backdrop.addEventListener('click', () => finish(-1));
    wrap.append(backdrop, panel);
    root.append(wrap);
    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('is-open')));
  });
}
