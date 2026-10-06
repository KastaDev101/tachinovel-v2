/**
 * POST through the hidden WebView (browserFetch with method 'POST'): the pure parts, testable in Node.
 * platform/scriptable.ts loads the site's origin in a hidden WebView (reused per origin), then runs
 * fetch() inside the page with the site's cookies (credentials: 'include'). Two modes:
 *
 * - 'poll' (default): a short non-callback evaluation starts the fetch and stores the outcome as a JSON
 *   string in window.__tnPost[id]; `runPolledPost` then reads it with short non-callback evaluations
 *   every ~150 ms. No evaluation ever waits on the network, so even if Scriptable serializes
 *   evaluations across WebViews, the UI bridge is never blocked for longer than one tiny evaluation.
 * - 'callback' (for comparison, flags.json "browserPostCallback"): one useCallback evaluation of
 *   `postScript` that completes with the JSON string when the fetch is done.
 *
 * Only strings come back from evaluations (CP0); `parsePostResult` turns the JSON into an HttpResponse.
 *
 * Limits of an in-page fetch: forbidden headers (User-Agent, Cookie, Origin, Referer, ...) are dropped
 * by the browser, and Set-Cookie can't be read from the response (the WebView stores it itself).
 */
import type { HttpResponse } from '../../shared/contracts/platform.ts';

export interface PostInit {
  headers?: Record<string, string>;
  body?: string;
}

/**
 * The JS evaluated in the page. Values are embedded as JSON literals; the page-side timer completes
 * with an error after `timeoutMs` so the callback evaluation always ends.
 */
export function postScript(url: string, init: PostInit, timeoutMs: number): string {
  const opts = JSON.stringify({ method: 'POST', headers: init.headers ?? {}, body: init.body ?? '', credentials: 'include' });
  return `(function () {
  var finished = false;
  function finish(v) { if (!finished) { finished = true; clearTimeout(timer); completion(JSON.stringify(v)); } }
  var timer = setTimeout(function () { finish({ e: 'timeout' }); }, ${Math.max(1, Math.round(timeoutMs))});
  try {
    fetch(${JSON.stringify(url)}, ${opts})
      .then(function (r) {
        var h = {};
        r.headers.forEach(function (v, k) { k = String(k).toLowerCase(); h[k] = h[k] ? h[k] + ', ' + v : v; });
        return r.text().then(function (b) { finish({ s: r.status, u: r.url, h: h, b: b }); });
      })
      .catch(function (err) { finish({ e: String((err && err.message) || err) }); });
  } catch (err) {
    finish({ e: String((err && err.message) || err) });
  }
})();`;
}

/** Thrown for in-page failures; `timeout` lets the caller map it to TIMEOUT. */
export class BrowserPostError extends Error {
  readonly timeout: boolean;
  constructor(message: string, timeout: boolean) {
    super(message);
    this.name = 'BrowserPostError';
    this.timeout = timeout;
  }
}

/** The completion string → HttpResponse (throws BrowserPostError on in-page errors or garbage). */
export function parsePostResult(raw: unknown, url: string): HttpResponse {
  if (typeof raw !== 'string') throw new BrowserPostError(`browserFetch POST ${url}: no result from the page`, false);
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new BrowserPostError(`browserFetch POST ${url}: unreadable result from the page`, false);
  }
  const o = (v && typeof v === 'object' ? v : {}) as { s?: unknown; u?: unknown; h?: unknown; b?: unknown; e?: unknown };
  if (typeof o.e === 'string') {
    const timeout = o.e === 'timeout';
    throw new BrowserPostError(timeout ? `browserFetch POST timed out: ${url}` : `browserFetch POST ${url} failed in the page: ${o.e}`, timeout);
  }
  if (typeof o.s !== 'number') throw new BrowserPostError(`browserFetch POST ${url}: result without a status`, false);
  const headers: Record<string, string> = {};
  if (o.h && typeof o.h === 'object') {
    for (const [k, val] of Object.entries(o.h as Record<string, unknown>)) if (typeof val === 'string') headers[k.toLowerCase()] = val;
  }
  return { url: typeof o.u === 'string' && o.u ? o.u : url, status: o.s, headers, body: typeof o.b === 'string' ? o.b : '' };
}

// ---------- 'poll' mode ----------

export type BrowserPostMode = 'poll' | 'callback';

/** Short evaluation: starts the fetch, returns 'started' at once. The outcome lands in window.__tnPost[id]. */
export function startPostScript(id: string, url: string, init: PostInit, timeoutMs: number): string {
  const opts = JSON.stringify({ method: 'POST', headers: init.headers ?? {}, body: init.body ?? '', credentials: 'include' });
  const key = JSON.stringify(id);
  return `(function () {
  var store = window.__tnPost || (window.__tnPost = {});
  var id = ${key};
  store[id] = null;
  var finished = false;
  function finish(v) { if (!finished) { finished = true; clearTimeout(timer); if (id in store) store[id] = JSON.stringify(v); } }
  var timer = setTimeout(function () { finish({ e: 'timeout' }); }, ${Math.max(1, Math.round(timeoutMs))});
  try {
    fetch(${JSON.stringify(url)}, ${opts})
      .then(function (r) {
        var h = {};
        r.headers.forEach(function (v, k) { k = String(k).toLowerCase(); h[k] = h[k] ? h[k] + ', ' + v : v; });
        return r.text().then(function (b) { finish({ s: r.status, u: r.url, h: h, b: b }); });
      })
      .catch(function (err) { finish({ e: String((err && err.message) || err) }); });
  } catch (err) {
    finish({ e: String((err && err.message) || err) });
  }
  return 'started';
})()`;
}

/** Short evaluation: '' while pending, '!gone' if the slot vanished (page navigated), else the JSON (slot freed). */
export function pollPostScript(id: string): string {
  return `(function () {
  var store = window.__tnPost, id = ${JSON.stringify(id)};
  if (!store || !(id in store)) return '!gone';
  var v = store[id];
  if (v === null) return '';
  delete store[id];
  return v;
})()`;
}

/** Short evaluation: forget a slot (after a script-side timeout), so a late result isn't kept. */
export function dropPostScript(id: string): string {
  return `(function () { var s = window.__tnPost; if (s) delete s[${JSON.stringify(id)}]; return 'ok'; })()`;
}

export interface PolledPostDeps {
  /** A NON-callback evaluation in the origin page (WebView.evaluateJavaScript(js, false)). */
  evaluate(js: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

let postSeq = 0;

/** Starts the in-page POST and polls for its outcome until `timeoutMs` (plus a short grace) passes. */
export async function runPolledPost(deps: PolledPostDeps, url: string, init: PostInit, timeoutMs: number, intervalMs = 150): Promise<HttpResponse> {
  postSeq = (postSeq + 1) % 1_000_000_000;
  const id = `p${postSeq}-${deps.now().toString(36)}`;
  const deadline = deps.now() + timeoutMs + 1_000; // the page-side timer answers first
  const timedOut = (): BrowserPostError => new BrowserPostError(`browserFetch POST timed out: ${url}`, true);
  const started = await deps.evaluate(startPostScript(id, url, init, timeoutMs));
  if (started !== 'started') throw new BrowserPostError(`browserFetch POST ${url}: the page did not start the request`, false);
  for (;;) {
    await deps.sleep(intervalMs);
    const raw = await deps.evaluate(pollPostScript(id));
    if (raw === '!gone') throw new BrowserPostError(`browserFetch POST ${url}: the page navigated away before the response`, false);
    if (typeof raw === 'string' && raw !== '') return parsePostResult(raw, url);
    if (deps.now() > deadline) {
      await deps.evaluate(dropPostScript(id)).catch(() => undefined);
      throw timedOut();
    }
  }
}
