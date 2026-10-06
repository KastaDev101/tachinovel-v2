/**
 * Waiting for a freshly presented WebView to get its real size before loading the UI.
 *
 * CP1: loading before the view is presented lays the page out at the off-screen 300×300 (or 0×0) size
 * and iOS keeps it, so the UI is loaded only after present(). The proven fallback is a fixed 250 ms
 * wait. The fast path polls the blank page's innerWidth/innerHeight and proceeds as soon as two
 * consecutive samples show the full screen size. If samples can't be taken at all it behaves exactly
 * like the fallback (250 ms); if they come back but not yet full-size it keeps waiting up to the cap,
 * which is never less safe than the fallback.
 */

export interface ViewportWaitOptions {
  /** Screen size in points (Device.screenSize()); either orientation is accepted. */
  screen: { width: number; height: number };
  /** One sample: "WxH" from the presented view, or null if evaluation failed. */
  sample: () => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Poll interval. Default 30 ms. */
  intervalMs?: number;
  /** Give up on the signal after this long. Default 600 ms. */
  capMs?: number;
  /** Never load sooner than this without the signal (CP1-proven). Default 250 ms. */
  fallbackMs?: number;
}

export interface ViewportWaitResult {
  /** 'signal': the full size was seen (twice in a row); 'fallback': waited the proven delay. */
  via: 'signal' | 'fallback';
  waitedMs: number;
  lastSize: string | null;
}

/** Parse "WxH" (numbers may be fractional). */
export function parseSize(s: string | null): { w: number; h: number } | null {
  const m = s ? /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(s.trim()) : null;
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** Is this the presented, full-screen size (not 0×0, not the 300×300 off-screen default)? */
export function isFullScreen(size: { w: number; h: number } | null, screen: { width: number; height: number }): boolean {
  if (!size || size.w <= 0 || size.h <= 0) return false;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
  return (near(size.w, screen.width) && size.h >= screen.height * 0.5) || (near(size.w, screen.height) && size.h >= screen.width * 0.5);
}

export async function waitForViewport(o: ViewportWaitOptions): Promise<ViewportWaitResult> {
  const interval = o.intervalMs ?? 30;
  const cap = o.capMs ?? 600;
  const fallback = o.fallbackMs ?? 250;
  const start = o.now();
  let lastSize: string | null = null;
  let streak = 0;
  while (o.now() - start < cap) {
    lastSize = await o.sample();
    if (isFullScreen(parseSize(lastSize), o.screen)) {
      streak++;
      if (streak >= 2) return { via: 'signal', waitedMs: o.now() - start, lastSize };
    } else {
      streak = 0;
      // No usable samples at all (evaluation unsupported on the blank view): behave exactly like CP1.
      if (lastSize === null && o.now() - start + interval >= fallback) break;
    }
    await o.sleep(interval);
  }
  const elapsed = o.now() - start;
  if (elapsed < fallback) await o.sleep(fallback - elapsed);
  return { via: 'fallback', waitedMs: o.now() - start, lastSize };
}
