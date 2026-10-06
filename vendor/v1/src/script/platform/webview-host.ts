/**
 * Presents the UI. The built UI HTML (`virtual:html/ui`) is written to local `TachiNovel/index.html`
 * only when the build changes, then opened with the WebView *instance* API:
 *   new WebView() → await loadFile(index.html) → present(true) (NOT awaited; resolves on dismissal).
 * Files next to index.html (covers/…) are reachable by relative path. Never uses WebView.loadHTML
 * (static: presents without a handle, so evaluateJavaScript would be impossible).
 */
import html from 'virtual:html/ui';
import type { FileStore, LogLevel } from '../../shared/contracts/platform.ts';
import type { BridgeTransport } from '../bridge/server.ts';
import { waitForViewport } from '../lib/viewport.ts';

export const UI_FILE = 'index.html';

/** present() was refused (typically: another TachiNovel WebView is still presented). */
export class WebViewPresentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebViewPresentError';
  }
}
export const UI_STAMP_FILE = 'ui-build.txt';
/** loadFile of the local UI normally takes well under a second. */
const LOAD_TIMEOUT_MS = 10_000;

export interface WebViewHost {
  transport: BridgeTransport;
  /** Resolves when the user dismisses the WebView. */
  closed: Promise<void>;
  /** Epoch ms: when present() was called and when loadFile() finished (session diagnostics). */
  timeline: { presentedAt: number; loadedAt: number };
}

/** Rewrite index.html only when the build stamp changed (or the file is missing). */
export async function ensureUiFile(local: FileStore, buildStamp: string): Promise<boolean> {
  const current = await local.readText(UI_STAMP_FILE);
  if (current === buildStamp && local.exists(UI_FILE)) return false;
  await local.writeText(UI_FILE, html);
  await local.writeText(UI_STAMP_FILE, buildStamp);
  return true;
}

export async function startWebViewHost(opts: {
  local: FileStore;
  buildStamp: string;
  log: (level: LogLevel, message: string, data?: unknown) => void;
  /**
   * Load as soon as the presented view reports its full size (polled every 30 ms, two stable samples,
   * capped at 600 ms) instead of always waiting 250 ms. Opt-in (flags.json "fastPresent") until verified
   * on the phone; never waits less than 250 ms unless the full size was actually seen. A function is
   * called right after present() (main.ts reads flags.json then), and an answer that takes longer than
   * the 250 ms wait counts as false: reading it never delays the view or the load.
   */
  fastPresent?: boolean | (() => Promise<boolean>);
}): Promise<WebViewHost> {
  if (await ensureUiFile(opts.local, opts.buildStamp)) opts.log('info', `UI written for build ${opts.buildStamp}`);
  const wv = new WebView();
  // Present FIRST, then load (CP1): loading before presenting lays the page out in a 300×300
  // off-screen view, and fixed-position layout keeps that size on iOS. Verified on the phone
  // (TachiNovel-Diag variant E): present → ~250 ms → loadFile renders at full size.
  // present() throws synchronously when another TachiNovel view is still on screen (phone log
  // 2026-10-06: "Presenting a configured web view is not supported"). Surface that as a typed error
  // so main.ts can leave the running instance alone instead of showing a fatal alert.
  let presenting: Promise<void>;
  try {
    presenting = wv.present(true);
  } catch (err) {
    throw new WebViewPresentError(err instanceof Error ? err.message : String(err));
  }
  const closed = presenting.then(
    () => undefined,
    (err: unknown) => {
      opts.log('warn', `WebView present failed: ${err instanceof Error ? err.message : String(err)}`);
    },
  );
  const presentedAt = Date.now();
  const wait = (ms: number): Promise<void> => new Promise<void>((resolve) => Timer.schedule(Math.max(0, ms), false, resolve));
  // Close can be tapped while we're still starting, and evaluations never resolve after dismissal
  // (CP0): every startup step races the dismissal and a time limit, so a quick Close always ends the run.
  const CLOSED = 'closed' as const;
  const TIMED_OUT = 'timed-out' as const;
  let isClosed = false;
  const whenClosed = closed.then(() => {
    isClosed = true;
    return CLOSED;
  });
  const bounded = <T>(p: Promise<T>, ms: number): Promise<T | typeof CLOSED | typeof TIMED_OUT> =>
    Promise.race([p, whenClosed, wait(ms).then(() => TIMED_OUT)]);
  const host = (loadedAt: number): WebViewHost => ({
    transport: {
      evaluate: (js, useCallback) => wv.evaluateJavaScript(js, useCallback) as Promise<unknown>,
    },
    closed,
    timeline: { presentedAt, loadedAt },
  });
  const settleStart = Date.now();
  const fastAnswer = typeof opts.fastPresent === 'function' ? opts.fastPresent().catch(() => false) : Promise.resolve(opts.fastPresent === true);
  const fast = (await bounded(fastAnswer, 250)) === true;
  if (fast) {
    const screen = Device.screenSize();
    const result = await waitForViewport({
      screen: { width: screen.width, height: screen.height },
      sleep: wait,
      now: () => Date.now(),
      // The blank, presented page's size; a stuck evaluation counts as "no sample".
      sample: async () => {
        if (isClosed) return null;
        try {
          const v: unknown = await bounded(wv.evaluateJavaScript('innerWidth + "x" + innerHeight', false) as Promise<unknown>, 200);
          return typeof v === 'string' && v !== CLOSED && v !== TIMED_OUT ? v : null;
        } catch {
          return null;
        }
      },
    });
    opts.log('info', `WebView ready to load via ${result.via} after ${result.waitedMs} ms (last size ${result.lastSize ?? 'n/a'}, screen ${screen.width}x${screen.height})`);
  } else {
    const left = 250 - (Date.now() - settleStart);
    if (left > 0) await bounded(wait(left), left);
  }
  if (isClosed) return host(Date.now()); // closed before loading: the bridge sees `closed` and stops
  const load = await bounded(wv.loadFile(opts.local.absolute(UI_FILE)) as Promise<unknown>, LOAD_TIMEOUT_MS).catch((err: unknown) => {
    opts.log('error', `UI load failed: ${err instanceof Error ? err.message : String(err)}`);
    return TIMED_OUT;
  });
  const loadedAt = Date.now();
  if (load === CLOSED) return host(loadedAt);
  if (load === TIMED_OUT) opts.log('warn', `UI load did not finish within ${LOAD_TIMEOUT_MS} ms; continuing`);
  // Loading before presenting left the page with a 0×0 viewport on the phone (CP1 black screen).
  // present → 250 ms → loadFile is confirmed working on the phone; log the size so a regression shows up.
  opts.log('debug', `UI loaded ${loadedAt - presentedAt} ms after present`);
  try {
    const size = await bounded(wv.evaluateJavaScript('innerWidth + "x" + innerHeight') as Promise<unknown>, 1000);
    if (size !== CLOSED && size !== TIMED_OUT) opts.log(String(size).startsWith('0x') ? 'warn' : 'info', `WebView viewport ${String(size)}`);
  } catch (err) {
    opts.log('warn', `WebView viewport check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return host(loadedAt);
}
