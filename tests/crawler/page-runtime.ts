/**
 * In-page half of the crawler, injected with `page.addInitScript(crawlerRuntime, config)`. It must be
 * self-contained (Playwright serializes the function). Exposes `window.__qaCrawl`:
 *
 *  - state():      where the app is (modal / top screen / sub-tab), as a stable signature
 *  - enumerate():  every visible interactive element of the active region, tagged data-qa-id
 *  - fingerprint(): a cheap hash of what's visible (text, control states, scroll positions)
 *  - layout():     horizontal escapes, content hidden behind the tab bar, controls under the safe areas
 */

export interface RuntimeConfig {
  safeTop: number;
  safeBottom: number;
}

export interface Region {
  kind: 'crash' | 'car' | 'modal' | 'layer';
  /** Human/stable id: "sheet:Sort & Filter", "novel", "settings:screen-appearance", "tabs:library". */
  id: string;
}

export interface StateInfo {
  /** Stack of layers (bottom → top), modal last. */
  stack: string[];
  /** Sub-state inside the top region: selected inner tabs/segments, reader bars. */
  sub: string[];
  modal: string | null;
  /** True when a v1 crash box or a "Something Went Wrong" state is on screen. */
  crash: string | null;
  errorState: string | null;
  /** Full signature (whole stack): what the report shows. */
  sig: string;
  /**
   * What the crawler keys states by: the screen on top (+ modal), its sub-state and a variant (the
   * on/off/disabled states of its testid'd controls), so "novel" reached from Library, History or
   * Updates is one state, while a novel not in the library ("Add to Library") is another.
   */
  key: string;
  /** The screen on top (+ modal), without sub-state: controls are tried once per screen. */
  screen: string;
}

export type ControlKind = 'tap' | 'toggle' | 'select' | 'range' | 'text' | 'longpress';

export interface ControlInfo {
  qaId: number;
  key: string;
  /** Template key: same for repeated items of one list (sampled). */
  template: string;
  repeated: boolean;
  kind: ControlKind;
  label: string;
  role: string;
  tag: string;
  testid: string | null;
  disabled: boolean;
  /** Already the current choice (selected tab/segment/option): tapping it again may do nothing. */
  selected: boolean;
  /** Element covering the control's center (null = reachable or off-screen in a scroller). */
  obscuredBy: string | null;
  rect: { x: number; y: number; w: number; h: number };
  /** select: option labels; range: min/max/value. */
  options?: string[];
  selectedIndex?: number;
  inputType?: string;
}

export interface LayoutIssue {
  kind: 'h-overflow' | 'escape' | 'behind-fixed' | 'safe-area';
  detail: string;
}

declare global {
  interface Window {
    __qaCrawl?: {
      state(): StateInfo;
      enumerate(): ControlInfo[];
      fingerprint(withScroll?: boolean): string;
      saveScroll(): void;
      restoreScroll(): void;
      layout(): Promise<LayoutIssue[]>;
      describe(el: Element | null): string;
    };
    __qaClickable?: WeakSet<Element>;
  }
}

export function crawlerRuntime(cfg: RuntimeConfig): void {
  const CANDIDATE =
    'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=link], [role=menuitem], ' +
    '[role=menuitemcheckbox], [role=menuitemradio], [role=switch], [role=checkbox], [role=radio], [role=option], [role=slider], .tap, [data-act]';
  /** Long-press targets of v1's attachLongPress users (library/source grids, browse, history, novel, updates, cleanup). */
  const LONG = '[data-key], [data-index], .src-row[data-source], [data-group], [data-rule], [data-testid="library-toggle"]';
  const STATE_CLASSES = /^(is-|has-)/;

  function visible(el: Element): boolean {
    if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return false;
    if (el.closest('[inert], [hidden], [aria-hidden="true"]') && !el.closest('.tn-car')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    // Opacity 0 on an ancestor (closing sheets, faded bars).
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (Number(ps.opacity) === 0 || ps.visibility === 'hidden') return false;
    }
    return true;
  }

  function text(el: Element, max = 48): string {
    // innerText is "" for content skipped by `content-visibility: auto` (off-screen reader chapters).
    const t = (el as HTMLElement).innerText || el.textContent || '';
    return t.replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function describe(el: Element | null): string {
    if (!el) return '(none)';
    const tid = el.getAttribute('data-testid');
    const cls = [...el.classList].filter((c) => !STATE_CLASSES.test(c)).slice(0, 3).join('.');
    const label = el.getAttribute('aria-label') ?? text(el, 30);
    return `${el.tagName.toLowerCase()}${tid ? `[data-testid=${tid}]` : ''}${cls ? `.${cls}` : ''}${label ? ` "${label}"` : ''}`;
  }

  function crashBox(): Element | null {
    for (const el of document.querySelectorAll('body > div[role="alert"]')) {
      if (/^TachiNovel (error|unhandled rejection)/.test(el.textContent ?? '')) return el;
    }
    return null;
  }

  /** Topmost modal: the car player, the last open sheet/dialog. */
  function modalRoot(): Element | null {
    const car = document.querySelector('.tn-car.is-open:not([hidden])');
    if (car) return car;
    const dialogs = [...document.querySelectorAll('[aria-modal="true"]')].filter((d) => visible(d) && !d.classList.contains('is-closing'));
    const d = dialogs[dialogs.length - 1];
    if (!d) return null;
    return d.closest('.rtips') ?? d;
  }

  function topLayer(): Element | null {
    const layers = document.querySelectorAll('.nav-root > .layer');
    return layers[layers.length - 1] ?? null;
  }

  function layerId(layer: Element): string {
    const name = layer.getAttribute('data-layer') ?? '?';
    if (name === 'tabs') {
      const pane = layer.querySelector('.tab-pane.is-active');
      return `tabs:${pane?.getAttribute('data-tab') ?? '?'}`;
    }
    if (name === 'settings') {
      const screen = layer.querySelector('[data-testid^="screen-"]');
      return `settings:${(screen?.getAttribute('data-testid') ?? '?').replace(/^screen-/, '')}`;
    }
    return name;
  }

  function modalId(m: Element): string {
    if (m.classList.contains('tn-car')) return 'car-player';
    const tid = m.getAttribute('data-testid');
    const title = m.querySelector('.sheet-title, h1, h2, [role=heading]');
    const t = title ? text(title, 40) : '';
    return `${m.classList.contains('sheet-wrap') ? 'sheet' : 'dialog'}:${tid ?? (t || m.getAttribute('aria-label') || '?')}`;
  }

  /** The element(s) whose controls are reachable right now. */
  function activeRoots(): Element[] {
    const m = modalRoot();
    if (m) return [m];
    const roots: Element[] = [];
    const layer = topLayer();
    if (layer) {
      const pane = layer.getAttribute('data-layer') === 'tabs' ? layer.querySelector('.tab-pane.is-active') : null;
      roots.push(pane ?? layer);
      const tabbar = layer.querySelector('.tabbar:not(.is-hidden)');
      if (tabbar) roots.push(tabbar);
    }
    // Non-modal floating UI: toasts, notices, v2's Listen button / mini player / "Open the player".
    for (const el of document.querySelectorAll('.toast-host, [data-testid="notice"], .tn-listen, .tn-player, .tn-open-car')) roots.push(el);
    return roots;
  }

  function state(): StateInfo {
    const stack = [...document.querySelectorAll('.nav-root > .layer')].map(layerId);
    const m = modalRoot();
    const modal = m ? modalId(m) : null;
    const top = m ?? (topLayer()?.getAttribute('data-layer') === 'tabs' ? topLayer()?.querySelector('.tab-pane.is-active') : topLayer()) ?? null;
    const sub: string[] = [];
    if (top) {
      for (const t of top.querySelectorAll('[role="tab"][aria-selected="true"]')) {
        if (!t.closest('.tabbar') && visible(t)) sub.push(text(t, 24).replace(/\s*\d+$/, ''));
      }
      // v2's mini player (narration running) floats over every screen: a state of its own.
      const player = document.querySelector('.tn-player');
      if (player && !player.hasAttribute('hidden') && !m) sub.push('player');
      const reader = top.querySelector('.reader');
      if (reader && !m) {
        if (reader.classList.contains('bars-visible')) sub.push('bars');
        if (reader.classList.contains('is-finding')) sub.push('find');
      }
    }
    const crash = crashBox();
    let errorState: string | null = null;
    for (const e of document.querySelectorAll('[data-testid="error-state"]')) {
      if (visible(e)) errorState = text(e, 120);
    }
    const screen = [...stack, ...(modal ? [modal] : [])].join(' > ');
    const topScreen = [stack[stack.length - 1] ?? '', ...(modal ? [modal] : [])].join(' > ');
    const marks = new Set<string>();
    for (const root of activeRoots()) {
      for (const el of root.querySelectorAll('[data-testid]')) {
        if (!el.matches(CANDIDATE) || !visible(el)) continue;
        marks.add(`${el.getAttribute('data-testid')}:${el.getAttribute('aria-pressed') ?? ''}${el.getAttribute('aria-checked') ?? ''}${el.getAttribute('aria-selected') ?? ''}${el.matches(':disabled') ? 'd' : ''}`);
      }
    }
    let h = 2166136261;
    for (const ch of [...marks].sort().join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const subText = sub.length ? ` [${sub.join(', ')}]` : '';
    return {
      stack,
      sub,
      modal,
      crash: crash ? text(crash, 300) : null,
      errorState,
      sig: screen + subText,
      key: `${topScreen}${subText}#${(h >>> 0).toString(36)}`,
      screen: topScreen,
    };
  }

  function roleOf(el: Element): string {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el as HTMLInputElement).type;
      return t === 'checkbox' ? 'checkbox' : t === 'range' ? 'slider' : t === 'radio' ? 'radio' : 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'a') return 'link';
    return tag === 'button' ? 'button' : 'generic';
  }

  function labelOf(el: Element): string {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 48);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const lab = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
      return (lab ? text(lab) : '') || el.placeholder || el.name || el.type;
    }
    if (el instanceof HTMLSelectElement) {
      const row = el.closest('.row');
      return (row ? text(row.querySelector('.row-title') ?? row) : '') || el.name || 'select';
    }
    return text(el) || el.getAttribute('title') || el.getAttribute('data-act') || '';
  }

  function stableClasses(el: Element): string {
    return [...el.classList]
      .filter((c) => !STATE_CLASSES.test(c))
      .sort()
      .join('.');
  }

  function kindOf(el: Element): ControlKind {
    if (el instanceof HTMLSelectElement) return 'select';
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') return 'toggle';
      if (el.type === 'range') return 'range';
      return 'text';
    }
    if (el instanceof HTMLTextAreaElement) return 'text';
    return 'tap';
  }

  function center(el: Element): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** What a tap at the control's center would hit, if it's on screen and something else is on top. */
  function obscurer(el: Element, target: Element): string | null {
    const r = target.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return null;
    const c = center(target);
    if (c.y < 0 || c.y >= innerHeight || c.x < 0 || c.x >= innerWidth) return null;
    const hit = document.elementFromPoint(c.x, c.y);
    if (!hit || hit === target || target.contains(hit) || hit.contains(target) || el.contains(hit)) return null;
    // A label's input, an element inside the same row, the sheet panel scrolled over it: still reachable.
    if (hit.closest('label') && hit.closest('label') === target.closest('label')) return null;
    return describe(hit.closest('button, a, [role], .tap, [data-testid], [class]') ?? hit);
  }

  let nextId = 1;

  function enumerate(): ControlInfo[] {
    // Stale tags from an earlier listing would make a selector hit another (maybe hidden) element.
    for (const el of document.querySelectorAll('[data-qa-id], [data-qa-target], [data-qa-long]')) {
      el.removeAttribute('data-qa-id');
      el.removeAttribute('data-qa-target');
      el.removeAttribute('data-qa-long');
    }
    nextId = 1;
    const roots = activeRoots();
    const tagged = window.__qaClickable;
    const seen = new Set<Element>();
    const out: ControlInfo[] = [];
    const vw = innerWidth;
    const vh = innerHeight;
    for (const root of roots) {
      const cands: Element[] = [];
      if (root.matches(CANDIDATE)) cands.push(root);
      cands.push(...root.querySelectorAll(CANDIDATE));
      if (tagged) {
        for (const el of root.querySelectorAll('*')) {
          if (!tagged.has(el) || el.matches(CANDIDATE)) continue;
          // Delegation roots and gesture surfaces (scrollers, grids, the edge-swipe strip) are not controls.
          if (el.querySelector(CANDIDATE) || el.matches('[data-testid="edge-swipe"], .sheet-backdrop, .sheet-handle, .layer, .tab-pane')) continue;
          const r = el.getBoundingClientRect();
          if (r.width * r.height > vw * vh * 0.4) continue;
          cands.push(el);
        }
      }
      for (const el of cands) {
        if (seen.has(el)) continue;
        // Keep the outermost control (an icon inside a button is the button).
        const outer = el.parentElement?.closest(CANDIDATE);
        if (outer && root.contains(outer) && !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) {
          if (!(outer instanceof HTMLLabelElement)) continue;
        }
        let target: Element = el;
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) target = el.closest('label') ?? el;
        if (el instanceof HTMLSelectElement && getComputedStyle(el).opacity === '0') target = el.closest('.row') ?? el;
        if (!visible(target) && !(el instanceof HTMLSelectElement && visible(el.closest('.row') ?? el))) continue;
        seen.add(el);
        seen.add(target);
        const testid = el.getAttribute('data-testid') ?? target.getAttribute('data-testid');
        const role = roleOf(el);
        const label = labelOf(el);
        const kind = kindOf(el);
        // Data-driven list items (rows, grid cells, carousels) are sampled, not all tapped.
        const listItem = el.closest(LONG);
        const shared = !!testid && root.querySelectorAll(`[data-testid="${CSS.escape(testid)}"]`).length >= 3;
        const repeated = (!!listItem && listItem !== root && root.contains(listItem)) || shared;
        const parent = el.parentElement;
        const template = `${testid ?? ''}|${role}|${el.tagName}.${stableClasses(el)}|${parent ? `${parent.tagName}.${stableClasses(parent)}` : ''}|${listItem && listItem !== el ? stableClasses(listItem) : ''}`;
        const disabled = el.matches(':disabled, [aria-disabled="true"]') || !!el.closest('[aria-disabled="true"], fieldset:disabled');
        const selected =
          el.matches('[aria-selected="true"], [aria-current]:not([aria-current="false"]), [aria-checked="true"][role^="menuitem"], [aria-checked="true"][role="radio"], .is-active, .is-selected, .is-on') ||
          !!el.querySelector('.row-check.is-on');
        const id = nextId++;
        el.setAttribute('data-qa-id', String(id));
        const r = target.getBoundingClientRect();
        const info: ControlInfo = {
          qaId: id,
          key: `${testid ?? ''}|${role}|${label}`,
          template,
          repeated,
          kind,
          label,
          role,
          tag: el.tagName.toLowerCase(),
          testid,
          disabled,
          selected,
          // Scrolling content may sit under the floating bars at rest (the user scrolls it out); only
          // pinned controls (fixed/sticky, or not in a scroller) can be truly covered.
          obscuredBy: pinned(target) ? obscurer(el, target) : null,
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        };
        if (target !== el) target.setAttribute('data-qa-target', String(id));
        if (el instanceof HTMLSelectElement) {
          info.options = [...el.options].map((o) => o.label || o.value);
          info.selectedIndex = el.selectedIndex;
        }
        if (el instanceof HTMLInputElement) info.inputType = el.type;
        out.push(info);
      }
      // Long-press candidates (list rows / grid cells): one per list.
      for (const el of root.querySelectorAll(LONG)) {
        if (!visible(el)) continue;
        const parent = el.parentElement;
        const template = `long|${el.tagName}.${stableClasses(el)}|${parent ? `${parent.tagName}.${stableClasses(parent)}` : ''}`;
        const id = nextId++;
        el.setAttribute('data-qa-long', String(id));
        const r = el.getBoundingClientRect();
        out.push({
          qaId: id,
          key: `long|${el.getAttribute('data-testid') ?? ''}|${labelOf(el)}`,
          template,
          repeated: true,
          kind: 'longpress',
          label: `long-press ${labelOf(el)}`,
          role: 'longpress',
          tag: el.tagName.toLowerCase(),
          testid: el.getAttribute('data-testid'),
          disabled: false,
          selected: false,
          obscuredBy: null,
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        });
      }
    }
    return out;
  }

  let savedScroll: [Element, number, number][] = [];
  function saveScroll(): void {
    savedScroll = [...document.querySelectorAll('*')].filter((e) => e.scrollTop > 0 || e.scrollLeft > 0 || e.scrollHeight > e.clientHeight).map((e) => [e, e.scrollTop, e.scrollLeft]);
  }
  function restoreScroll(): void {
    for (const [e, t, l] of savedScroll) {
      if (e.isConnected) {
        e.scrollTop = t;
        e.scrollLeft = l;
      }
    }
  }

  function fingerprint(withScroll = true): string {
    const parts: string[] = [document.documentElement.getAttribute('data-appearance') ?? '', document.documentElement.className];
    for (const root of activeRoots()) {
      parts.push((root as HTMLElement).innerText ?? '');
      for (const el of root.querySelectorAll('[aria-selected], [aria-checked], [aria-pressed], [aria-expanded], input, select, textarea, [style*="--"]')) {
        if (el instanceof HTMLInputElement) parts.push(el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value);
        else if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) parts.push(el.value);
        else parts.push(`${el.getAttribute('aria-selected')}${el.getAttribute('aria-checked')}${el.getAttribute('aria-pressed')}${el.getAttribute('aria-expanded')}${el.getAttribute('style') ?? ''}`);
      }
      if (withScroll) {
        for (const el of root.querySelectorAll('*')) {
          if (el.scrollTop > 0 || el.scrollLeft > 0) parts.push(`${Math.round(el.scrollTop)}:${Math.round(el.scrollLeft)}`);
        }
      }
      parts.push(stableClasses(root));
      const reader = root.querySelector('.reader');
      if (reader) parts.push(reader.className, reader.getAttribute('style') ?? '');
    }
    const s = parts.join('\u0001');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
  }

  function clippedByAncestor(el: Element): boolean {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible') {
        const r = p.getBoundingClientRect();
        if (r.left >= -1 && r.right <= innerWidth + 1) return true;
      }
    }
    return false;
  }

  function pinned(el: Element): boolean {
    for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.position === 'fixed' || cs.position === 'sticky') return true;
      if (p !== el && (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 1) return false;
    }
    return true;
  }

  /** `el` is (inside) fixed/sticky UI that isn't part of the scroller `s`. */
  function pinnedOutside(el: Element, s: Element): boolean {
    for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
      if (p === s || p.contains(s)) return false;
      const pos = getComputedStyle(p).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  }

  const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  async function layout(): Promise<LayoutIssue[]> {
    const issues: LayoutIssue[] = [];
    const se = document.scrollingElement ?? document.documentElement;
    if (se.scrollWidth > innerWidth + 1) issues.push({ kind: 'h-overflow', detail: `page is ${se.scrollWidth}px wide in a ${innerWidth}px viewport` });
    const roots = activeRoots();
    const seen = new Set<string>();
    for (const root of roots) {
      for (const el of root.querySelectorAll('*')) {
        if (!(el instanceof HTMLElement)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (r.right <= innerWidth + 1 && r.left >= -1) continue;
        if (!visible(el) || clippedByAncestor(el)) continue;
        // Report the outermost escaping element only.
        const parent = el.parentElement;
        if (parent) {
          const pr = parent.getBoundingClientRect();
          if ((pr.right > innerWidth + 1 || pr.left < -1) && !clippedByAncestor(parent) && visible(parent)) continue;
        }
        const d = `${describe(el)} spans x=${Math.round(r.left)}…${Math.round(r.right)}`;
        if (!seen.has(d)) issues.push({ kind: 'escape', detail: d });
        seen.add(d);
      }
      // Fixed controls under the status bar / Dynamic Island or the home indicator.
      for (const el of root.querySelectorAll(CANDIDATE)) {
        if (!visible(el) || !pinned(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.top < cfg.safeTop - 1 && r.bottom > 0) issues.push({ kind: 'safe-area', detail: `${describe(el)} top=${Math.round(r.top)} is under the status bar (safe top ${cfg.safeTop})` });
        // iOS 26 floating bars dip into the bottom inset; only the home indicator's own strip is off limits.
        else if (r.bottom > innerHeight - cfg.safeBottom * 0.4 && r.top < innerHeight) issues.push({ kind: 'safe-area', detail: `${describe(el)} bottom=${Math.round(r.bottom)} reaches the home indicator (bottom ${Math.round(cfg.safeBottom * 0.4)} px)` });
      }
    }
    // Content that stays hidden behind fixed UI (tab bar, toolbars, floating buttons, the mini player)
    // even when its scroller is scrolled to the end: the user can never see or tap it.
    for (const root of roots) {
      const scrollers = [root, ...root.querySelectorAll('*')].filter((e) => {
        const cs = getComputedStyle(e);
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 1 && e.clientHeight > innerHeight * 0.3 && visible(e);
      });
      for (const s of scrollers) {
        // The reader's bars (and what floats above them) overlay the text while shown; a tap hides them.
        if (s.matches('.reader-scroll') && s.closest('.reader.bars-visible')) continue;
        const before = s.scrollTop;
        s.scrollTop = s.scrollHeight;
        await frame();
        const sr = s.getBoundingClientRect();
        const bottom = Math.min(sr.bottom, innerHeight);
        const near = [...s.querySelectorAll('*')].filter((e) => {
          if (!(e.children.length === 0 && (e as HTMLElement).innerText?.trim()) && !e.matches(CANDIDATE)) return false;
          const r = e.getBoundingClientRect();
          return r.height > 0 && r.bottom > bottom - 220 && r.top < bottom && visible(e);
        });
        for (const leaf of near) {
          const r = leaf.getBoundingClientRect();
          const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
          const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
          const hit = document.elementFromPoint(x, y);
          // Toasts are transient (they expire on their own); only lasting UI counts here.
          if (!hit || s.contains(hit) || leaf.contains(hit) || hit.closest('.toast-host') || !pinnedOutside(hit, s)) continue;
          issues.push({ kind: 'behind-fixed', detail: `${describe(leaf)} (y=${Math.round(r.top)}…${Math.round(r.bottom)}) stays under ${describe(hit.closest('button, nav, [role], [class]') ?? hit)} when ${describe(s)} is scrolled to the end` });
          break;
        }
        s.scrollTop = before;
        await frame();
      }
    }
    return issues;
  }

  window.__qaCrawl = { state, enumerate, fingerprint, layout, describe, saveScroll, restoreScroll };
}
