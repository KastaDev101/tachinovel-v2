/**
 * Status bar text that stays readable. In Scriptable, v1 sat below Scriptable's own bar; in v2 the iOS
 * status bar is drawn over the page, so its text color must follow what is painted under it, not just the
 * system appearance:
 *  - Settings › Appearance can force Light or Dark (`<html data-appearance>`);
 *  - the reader paints its theme (light / sepia / dark / black) under the status bar (`.reader::before`);
 *  - v2 overlays (the car player) are dark in every appearance.
 *
 * So we look at the topmost opaque-enough background at the status bar's position (elementsFromPoint)
 * and pick light or dark text from its luminance. Event-driven: checks run shortly after taps, gestures,
 * transitions, navigation and appearance changes (never per frame), and the native call is only made when
 * the style changes.
 */
import { StatusBar, Style } from '@capacitor/status-bar';

type Rgba = [number, number, number, number];

/** `rgb(…)` / `rgba(…)` (comma or space syntax, as computed styles give them) → [r, g, b, a]; null otherwise. */
export function parseColor(css: string): Rgba | null {
  const m = /^rgba?\(([^)]*)\)$/i.exec(css.trim());
  if (!m?.[1]) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const [r, g, b] = parts.slice(0, 3).map((p) => Number.parseFloat(p)) as [number, number, number];
  const alphaText = parts[3];
  const a = alphaText === undefined ? 1 : alphaText.endsWith('%') ? Number.parseFloat(alphaText) / 100 : Number.parseFloat(alphaText);
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
  return [r, g, b, a];
}

/** WCAG relative luminance of an sRGB color (0 black … 1 white). */
export function luminance([r, g, b]: Rgba): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Dark text on light backgrounds, light text on dark ones (the 0.18 midpoint ≈ equal contrast with both). */
export function styleFor(color: Rgba): Style {
  return luminance(color) > 0.18 ? Style.Light : Style.Dark;
}

/** Topmost background with alpha ≥ 0.5 painted where the status bar is; the page background otherwise. */
export function backgroundUnderStatusBar(doc: Document = document): Rgba | null {
  const x = Math.round((doc.defaultView?.innerWidth ?? 0) / 2);
  for (const el of doc.elementsFromPoint(x, 2)) {
    const c = parseColor(getComputedStyle(el).backgroundColor);
    if (c && c[3] >= 0.5) return c;
  }
  for (const el of [doc.body, doc.documentElement]) {
    const c = el ? parseColor(getComputedStyle(el).backgroundColor) : null;
    if (c && c[3] >= 0.5) return c;
  }
  return null;
}

export function installStatusBar(): void {
  let current: Style | null = null;
  let timers: ReturnType<typeof setTimeout>[] = [];

  const check = (): void => {
    if (document.visibilityState !== 'visible') return;
    const bg = backgroundUnderStatusBar();
    const mq = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const style = bg ? styleFor(bg) : mq ? Style.Dark : Style.Light;
    if (style === current) return;
    current = style;
    void StatusBar.setStyle({ style }).catch(() => undefined);
  };
  // Right after the event, and again once push/pop and sheet animations (~350 ms) have settled.
  const schedule = (): void => {
    for (const t of timers) clearTimeout(t);
    timers = [setTimeout(check, 60), setTimeout(check, 450)];
  };

  check();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule);
  document.addEventListener('visibilitychange', schedule);
  for (const type of ['pointerup', 'click', 'touchend'] as const) document.addEventListener(type, schedule, { capture: true, passive: true });
  document.addEventListener('transitionend', schedule, { capture: true, passive: true });
  // Appearance override, screens pushed/popped (by code, e.g. deep links), overlays added.
  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-appearance'] });
  mo.observe(document.body, { childList: true });
  const watchNav = (): boolean => {
    const nav = document.querySelector('.nav-root');
    if (nav) mo.observe(nav, { childList: true });
    return nav !== null;
  };
  if (!watchNav()) {
    const wait = new MutationObserver(() => {
      if (watchNav()) {
        wait.disconnect();
        schedule();
      }
    });
    wait.observe(document.body, { childList: true, subtree: true });
  }
}
