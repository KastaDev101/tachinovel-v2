/**
 * Boot timing: when is the library really on screen?
 *
 * Measured in the WebView from its navigation start (`performance.timeOrigin`, wall-clock ms): the
 * `app.boot` call, the first painted frame that shows library content (grid or an empty state, i.e. the
 * boot payload has rendered), and the moment the launch screen is hidden. One line is logged through the
 * core (`boot: …`, info level: os_log subsystem app.tachinovel + the in-app log). It carries wall-clock
 * epochs, so ci/ios-sim-smoke.sh can compute tap → library from its own launch timestamp (the simulator
 * shares the host clock). `window.__tnBoot` exposes the numbers to tests and Web Inspector.
 */
import { observeCalls, sharedClient } from '../capacitor-client.ts';

/** Library content after boot: the grid, or one of its empty states (v1 test ids). */
export const LIBRARY_CONTENT =
  '[data-testid="screen-library"] :is([data-testid="library-grid"], [data-testid="library-empty"], [data-testid="library-category-empty"], [data-testid="library-no-matches"])';

export interface BootTiming {
  /** WebView navigation start, epoch ms. */
  navStart: number;
  /** ms after navStart: the page's HTML fully received, and parsed (WebKit; before any of our JS ran). */
  html: number | null;
  domReady: number | null;
  /** ms after navStart. */
  bootCall: number | null;
  content: number | null;
  splash: number | null;
  /** The launch screen was hidden by the fallback timer, before library content showed. */
  fallback: boolean;
}

declare global {
  interface Window {
    __tnBoot?: BootTiming;
  }
}

/** Resolves with performance.now() of the first painted frame that shows library content (null on timeout). */
export function whenLibraryVisible(timeoutMs: number, doc: Document = document): Promise<number | null> {
  return new Promise((resolve) => {
    let seen = false;
    let done = false;
    const finish = (v: number | null): void => {
      if (done) return;
      done = true;
      mo.disconnect();
      clearTimeout(timer);
      resolve(v);
    };
    const check = (): void => {
      if (seen || !doc.querySelector(LIBRARY_CONTENT)) return;
      seen = true;
      mo.disconnect();
      // In the DOM now; painted once the frame after the next one starts.
      requestAnimationFrame(() => requestAnimationFrame(() => finish(performance.now())));
    };
    const mo = new MutationObserver(check);
    mo.observe(doc.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => finish(null), timeoutMs);
    check();
  });
}

export function formatBootLine(t: BootTiming): string {
  const ms = (v: number | null): string => (v === null ? 'n/a' : `+${Math.round(v)}ms`);
  const parts = [
    `library visible ${ms(t.content)} after WebView start`,
    `html ${ms(t.html)}`,
    `dom ready ${ms(t.domReady)}`,
    `app.boot call ${ms(t.bootCall)}`,
    `launch screen hidden ${ms(t.splash)}${t.fallback ? ' (fallback timer)' : ''}`,
  ];
  const epoch = t.content === null ? '' : ` epoch=${Math.round(t.navStart + t.content)}`;
  return `boot: ${parts.join(', ')}; nav=${Math.round(t.navStart)}${epoch}`;
}

/**
 * Hide the launch screen as soon as the library shows its boot content (at the latest after
 * `fallbackMs`), then log the timing line once library content is visible (or after `reportAfterMs`).
 */
export function installBootTiming(hideLaunchScreen: () => void, fallbackMs = 3000, reportAfterMs = 20_000): BootTiming {
  const t: BootTiming = { navStart: performance.timeOrigin, html: null, domReady: null, bootCall: null, content: null, splash: null, fallback: false };
  window.__tnBoot = t;
  const stop = observeCalls((method) => {
    if (method !== 'app.boot') return;
    stop();
    t.bootCall = performance.now();
  });
  const hide = (fallback: boolean): void => {
    if (t.splash !== null) return;
    t.splash = performance.now();
    t.fallback = fallback;
    hideLaunchScreen();
  };
  const fallbackTimer = setTimeout(() => hide(true), fallbackMs);
  void whenLibraryVisible(reportAfterMs).then((at) => {
    t.content = at;
    // Where WebKit's part ends: response received, document parsed (Navigation Timing, ms after navStart).
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav) {
      t.html = nav.responseEnd > 0 ? nav.responseEnd : null;
      t.domReady = nav.domInteractive > 0 ? nav.domInteractive : null;
    }
    clearTimeout(fallbackTimer);
    hide(at === null);
    void sharedClient()
      .call('app.log', { level: 'info', message: formatBootLine(t) })
      .catch(() => undefined);
  });
  return t;
}
