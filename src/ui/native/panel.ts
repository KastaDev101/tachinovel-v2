/**
 * The v2 screens' shared look (cleanup 2, 2026-10-16): full-screen panels that slide in over v1's UI (Voices, Voice
 * Settings, the novel's Voice panel, pronunciations, Developer, the voice tests, Prepare for the Drive, storage, the
 * labs), drawn with v1's design tokens (vendor/v1 src/ui/styles/tokens.css) so they follow light and dark mode and
 * look like v1's grouped lists: a centred title with "‹ Back", tinted mixed-case group headers, 16 px cards on
 * --bg-grouped-2, explanations as group footers, SF Symbols (v1's symbols store, used as CSS masks), skeleton rows
 * while loading, v1's toast (the mini player moves it up) and the native confirmation alert for every delete.
 * Text sizes follow Dynamic Type (v1's --fs-* tokens, or fs() from type.ts).
 *
 * v1's pieces (its symbols store, toast and native alert) come in through useV1Kit (v1-hooks.ts installs them at start):
 * this module imports nothing from v1, so the PC unit tests can load the screens' pure helpers.
 *
 * Markup classes (inside .tn-v): .sec header, .card group, .row (.main > b title + .sub), .val value, .note footer,
 * .btn / .btn.alt / .btn.danger, .link, .play, .check, .prog progress bar. v1's .switch and .segmented are used as is.
 */
import { Narration } from './narration.ts';
import { fs } from './type.ts';

const CSS = `
.tn-v{position:fixed;inset:0;z-index:90;background:var(--bg-grouped);color:var(--label);display:flex;flex-direction:column;
  font:var(--fs-body)/1.3 var(--font);-webkit-user-select:none;user-select:none;transform:translateX(100%);transition:transform .35s var(--ease-ios);box-shadow:var(--shadow-push)}
.tn-v.is-open{transform:none}
.tn-v button{font:inherit;color:inherit;background:transparent;border:0;padding:0;text-align:inherit;-webkit-tap-highlight-color:transparent}
.tn-v .hd{position:relative;display:flex;align-items:center;justify-content:space-between;flex:none;min-height:var(--nav-h);
  padding:var(--safe-top) max(6px,var(--safe-right)) 0 max(6px,var(--safe-left));box-sizing:content-box}
.tn-v .hd h1{position:absolute;left:96px;right:96px;bottom:0;margin:0;line-height:var(--nav-h);font-size:${fs(20)};font-weight:400;text-align:center;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.tn-v .back,.tn-v .hd-r button{display:flex;align-items:center;gap:2px;min-height:44px;padding:0 8px;color:var(--tint);z-index:1}
.tn-v .back{padding-left:2px}
.tn-v .hd-r{display:flex;justify-content:flex-end;min-width:44px;z-index:1}
.tn-v .body{flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;
  padding:4px max(16px,var(--safe-right)) calc(var(--safe-bottom) + 32px) max(16px,var(--safe-left))}
.tn-v .sec{margin:28px 0 0;padding:0 16px 8px;font-size:${fs(14)};font-weight:500;line-height:1.3;color:var(--tint)}
.tn-v .body>.sec:first-child,.tn-v .body>.seg-bar+.sec{margin-top:12px}
.tn-v .card{background:var(--bg-grouped-2);border-radius:16px;overflow:hidden}
.tn-v .card+.card{margin-top:16px}
.tn-v .card>*{position:relative}
.tn-v .card>*+*::before{content:"";position:absolute;top:0;left:16px;right:0;height:var(--hairline);background:var(--separator);pointer-events:none}
.tn-v .row{display:flex;align-items:center;gap:12px;width:100%;min-height:var(--row-h);padding:11px 16px;box-sizing:border-box;text-align:left}
.tn-v button.row:active,.tn-v label.row:active,.tn-v .row button.main:active{background:var(--fill-3)}
.tn-v .row .main{flex:1;min-width:0;text-align:left}
.tn-v .row b{display:block;font-weight:400}
.tn-v .row .sub{display:block;margin-top:2px;font-size:var(--fs-footnote);line-height:1.3;color:var(--label-2)}
.tn-v .val{flex:none;max-width:55%;color:var(--label-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.tn-v .chev{color:var(--gray-3);margin-right:-4px}
.tn-v .tint,.tn-v .link,.tn-v .edit{color:var(--tint)}
.tn-v .danger{color:var(--red)}
.tn-v .ok{color:var(--green)}
.tn-v .warn{color:var(--orange)}
.tn-v .link,.tn-v .edit{min-height:44px;padding:0 4px;flex:none}
.tn-v .note{margin:0;padding:7px 16px 0;font-size:var(--fs-footnote);line-height:1.35;color:var(--label-2)}
.tn-v .note:empty{display:none}
.tn-v .btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:50px;margin-top:16px;padding:8px 16px;border-radius:14px;
  background:var(--tint);color:var(--on-tint);font-weight:600;text-align:center;white-space:normal}
.tn-v .btn.alt{background:var(--bg-grouped-2);color:var(--tint)}
.tn-v .btn.alt.danger{color:var(--red)}
.tn-v button:disabled{opacity:.4}
.tn-v .play{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:18px;flex:none;background:var(--fill-3);color:var(--tint)}
.tn-v .play.is-busy{opacity:.5}
.tn-v .check{color:var(--tint);flex:none}
.tn-v .check:not(.on){visibility:hidden}
.tn-v .prog{display:block;height:4px;border-radius:2px;background:var(--fill-3);overflow:hidden;margin-top:8px}
.tn-v .prog i{display:block;height:100%;background:var(--tint);transition:width .3s}
.tn-v .seg-bar{padding:4px 0 0}
.tn-v .row .segmented{flex:none;width:min(52%,210px)}
.tn-v .segmented-item{padding:0 6px;font-size:13px;font-weight:500;text-align:center}
.tn-v .segmented-item.is-selected{font-weight:600}
.tn-v .seg-row .segmented{flex:1;width:auto}
.tn-v input[type=text],.tn-v textarea{display:block;width:100%;box-sizing:border-box;margin:0;padding:10px 12px;border:0;border-radius:10px;background:var(--fill-3);
  color:var(--label);font:max(16px,var(--fs-body)) var(--font);-webkit-user-select:text;user-select:text}
.tn-v textarea{min-height:110px;font:max(16px,var(--fs-footnote)) ui-monospace,Menlo,monospace}
.tn-v .form{padding:12px 16px;display:grid;gap:8px}
.tn-v select{flex:none;max-width:52%;padding:8px 10px;border:0;border-radius:10px;background:var(--fill-3);color:var(--label);font:max(16px,var(--fs-body)) var(--font)}
.tn-v .skel-line{display:block;height:14px;border-radius:7px}
.tn-v.lab .body{font-size:${fs(14)}}
.tn-v.lab h2{margin:24px 0 0;padding:0 16px 8px;font-size:${fs(14)};font-weight:500;color:var(--tint)}
.tn-v .kv{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;padding:12px 16px;border-radius:16px;background:var(--bg-grouped-2)}
.tn-v .kv>:nth-child(odd){color:var(--label-2)}
.tn-v .kv>:nth-child(even){font-variant-numeric:tabular-nums;word-break:break-word}
.tn-v .lab-card{margin-bottom:10px;padding:12px 16px;border-radius:16px;background:var(--bg-grouped-2)}
.tn-v .lab-card h3{margin:0 0 4px;font-size:var(--fs-body);font-weight:600}
.tn-v .acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.tn-v .acts button{display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:8px 14px;border-radius:12px;background:var(--bg-grouped-2);color:var(--tint)}
.tn-v .lab-card .acts button{background:var(--fill-3)}
.tn-v .acts button.on{background:var(--tint);color:var(--on-tint)}
.tn-v .acts button.danger{color:var(--red)}
.tn-v .lab-t{width:100%;border-collapse:collapse;border-radius:16px;overflow:hidden;background:var(--bg-grouped-2);font-variant-numeric:tabular-nums;font-size:${fs(12)}}
.tn-v .lab-t td,.tn-v .lab-t th{padding:5px 6px;text-align:right;vertical-align:top}
.tn-v .lab-t th{color:var(--label-2);font-weight:500}
.tn-v .lab-t td.t{text-align:left;max-width:52vw}
.tn-v .lab-t tr.now td{background:var(--tab-selected)}
.tn-v .big{font-size:${fs(24)};font-weight:600}
.tn-v .muted{color:var(--label-2);font-size:var(--fs-footnote)}
.tn-v .err{color:var(--red)}
.tn-v .xtag{display:inline-block;margin-left:4px;padding:0 6px;border-radius:8px;background:var(--fill-3);font-size:${fs(11)};line-height:1.5;vertical-align:middle}
.tn-v .bar{display:block;height:4px;border-radius:2px;background:var(--fill-3);overflow:hidden;margin-top:6px}
.tn-v .bar i{display:block;height:100%;background:var(--tint)}
.tn-v .xv-row{padding:8px 0;border-top:var(--hairline) solid var(--separator)}
.tn-v .xv-row:first-of-type{border-top:0}
.tn-v .xv-row input[type=text]{flex:1;min-width:0}
.tn-v .mix{padding:14px 16px}
.tn-v .mix-shares{font-weight:600;text-align:center;margin-bottom:10px}
.tn-v .mix-range{width:100%;accent-color:var(--tint);margin:0;min-height:32px}
.tn-v .mix-ends{display:flex;justify-content:space-between;color:var(--label-2);font-size:var(--fs-footnote);margin-top:2px}
`;

/** v1's icon URLs, toast and native confirmation (v1-hooks.ts). */
export interface V1Kit {
  /** An SF Symbol's mask URL (v1's symbols store, or its drawn fallback). */
  iconUrl(name: string): string;
  toast(text: string, error: boolean): void;
  confirm(title: string, message: string, action: string, destructive: boolean): Promise<boolean>;
}

let kit: V1Kit | null = null;

export function useV1Kit(k: V1Kit): void {
  kit = k;
}

let styled = false;
function ensureStyle(): void {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Each symbol's mask URL, once, in a stylesheet (a list of 30 rows doesn't carry 60 image URLs in its markup). */
const iconUrls = new Map<string, string>();
let iconStyle: HTMLStyleElement | null = null;

function iconClass(name: string): string {
  const cls = `ic-${name.replace(/[^a-z0-9]/gi, '-')}`;
  const url = kit?.iconUrl(name) ?? '';
  if (iconUrls.get(name) !== url) {
    iconUrls.set(name, url);
    iconStyle ??= document.head.appendChild(document.createElement('style'));
    iconStyle.textContent = [...iconUrls].map(([n, u]) => `.ic-${n.replace(/[^a-z0-9]/gi, '-')}{--icon:url("${u.replace(/"/g, '%22')}")}`).join('');
  }
  return cls;
}

/** An SF Symbol (v1's symbols store, or its drawn fallback) as a tintable mask; v1's .icon class. */
export function icon(name: string, size = 22, cls = ''): string {
  return `<i class="icon ${iconClass(name)}${cls ? ` ${cls}` : ''}" style="--icon-size:${size}px" aria-hidden="true"></i>`;
}

/** A row's trailing chevron. */
export function chevron(): string {
  return icon('chevron.right', 14, 'chev');
}

/** The checkmark on the chosen row (kept in place, hidden, on the others so the rows line up). */
export function check(on: boolean): string {
  return icon('checkmark', 18, on ? 'check on' : 'check');
}

/** ✓ (good) or ⚠ (worth a look) in front of a result line. */
export function verdict(ok: boolean): string {
  return ok ? icon('checkmark.circle.fill', 20, 'ok') : icon('exclamationmark.triangle', 20, 'warn');
}

const NATIVE_SWITCH = typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype;

/** An iOS switch (v1's .switch: the native <input switch> where WebKit has it), with its data attributes. */
export function switchInput(attrs: string, on: boolean, label: string, disabled = false): string {
  return `<input type="checkbox" class="switch${NATIVE_SWITCH ? ' is-native' : ''}" switch ${attrs} ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${esc(label)}">`;
}

/** v1's segmented control; each item is a button with data-act and data-v. */
export function segmented(act: string, label: string, options: readonly (readonly [string, string])[], value: string): string {
  const i = Math.max(0, options.findIndex(([v]) => v === value));
  return `<div class="segmented" role="tablist" aria-label="${esc(label)}" style="--n:${options.length};--i:${i}"><div class="segmented-thumb"></div>${options
    .map(
      ([v, text]) =>
        `<button type="button" role="tab" class="segmented-item${v === value ? ' is-selected' : ''}" aria-selected="${v === value}" data-act="${esc(act)}" data-v="${esc(v)}">${esc(text)}</button>`,
    )
    .join('')}</div>`;
}

/** Skeleton rows in a card while something loads (v1's .skel pulse). */
export function skeleton(rows = 3, header = true): string {
  const widths = ['58%', '42%', '66%', '50%'];
  const lines = Array.from({ length: rows }, (_, i) => `<div class="row"><span class="skel skel-line" style="width:${widths[i % widths.length]}"></span></div>`).join('');
  return `${header ? '<div class="sec"><span class="skel skel-line" style="width:30%;height:12px"></span></div>' : ''}<div class="card" aria-busy="true" aria-label="Loading">${lines}</div>`;
}

/** The error state with Try Again (data-act="retry"). */
export function unavailable(what: string): string {
  return `<div class="card"><div class="row">${icon('exclamationmark.triangle', 20, 'warn')}<div class="main">${esc(what)}</div></div></div><button type="button" class="btn alt" data-act="retry">Try Again</button>`;
}

/** v1's toast (one at a time; above the mini player when it shows). */
export function toast(msg: string, error = false): void {
  kit?.toast(msg, error);
}

/** The app's one confirmation for deletes and other big steps: the native alert. */
export function confirmStep(title: string, message: string, action: string, destructive = true): Promise<boolean> {
  return kit ? kit.confirm(title, message, action, destructive) : Promise.resolve(false);
}

export interface Panel {
  root: HTMLElement;
  body: HTMLElement;
  /** The header's right side (an Edit button, …). */
  right: HTMLElement;
  close: () => void;
  setTitle: (t: string) => void;
  /** Runs once when the panel closes (stop polling, stop a test). */
  onClose: (fn: () => void) => void;
}

/** Close functions of the open panels (Settings › Voices, a novel's voice picker, the pronunciation editor). */
const openPanels = new Set<() => void>();

/** Close every panel: the Listen player opening or closing must never leave one on top of it. */
export function closeVoicePanels(): void {
  for (const close of [...openPanels]) close();
}

/** A full-screen panel (slides in from the right) with a centred title and "‹ Back" (data-act="close"). */
export function panel(title: string, testId: string): Panel {
  ensureStyle();
  const root = document.createElement('div');
  root.className = 'tn-v';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true'); // full screen: VoiceOver must not reach the screen behind
  root.setAttribute('aria-label', title);
  root.dataset.testid = testId;
  root.innerHTML = `<div class="hd"><button type="button" class="back" data-act="close" aria-label="Back">${icon('chevron.left', 22)}<span aria-hidden="true">Back</span></button><h1></h1><div class="hd-r"></div></div><div class="body"></div>`;
  const h1 = root.querySelector('h1') as HTMLElement;
  h1.textContent = title;
  document.body.append(root);
  requestAnimationFrame(() => {
    root.classList.add('is-open');
    root.querySelector<HTMLElement>('[data-act="close"]')?.focus({ preventScroll: true });
  });
  const closers: (() => void)[] = [];
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    openPanels.delete(close);
    root.classList.remove('is-open');
    // Out of the way at once: while it slides out it must not catch taps meant for what's underneath.
    root.inert = true;
    root.style.pointerEvents = 'none';
    void Narration.stopSample().catch(() => undefined);
    for (const fn of closers) fn();
    setTimeout(() => root.remove(), 360);
  };
  openPanels.add(close);
  root.addEventListener('click', (ev) => {
    if ((ev.target as Element).closest('[data-act="close"]')) close();
  });
  return {
    root,
    body: root.querySelector('.body') as HTMLElement,
    right: root.querySelector('.hd-r') as HTMLElement,
    close,
    setTitle: (t) => {
      h1.textContent = t;
      root.setAttribute('aria-label', t);
    },
    onClose: (fn) => void closers.push(fn),
  };
}
