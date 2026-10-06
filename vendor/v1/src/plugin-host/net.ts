/**
 * Networking for plugins on top of the injected HttpClient: default headers (iPhone Safari UA,
 * Referer = plugin site), a per-host cookie jar, Cloudflare challenge detection with a fallback to
 * the hidden-WebView fetch, and mapping of failures to SourceError codes.
 *
 * One Net per plugin host, shared by all its plugins: one cookie jar (cookies are per site, like a
 * browser), at most 3 requests in flight per host and 1 WebView fetch at a time, whatever the number
 * of plugins (global search fans out to every source at once).
 */
import { SourceError } from '../shared/contracts/plugin-host.ts';
import type { PluginHostDeps } from '../shared/contracts/plugin-host.ts';
import type { BrowserFetchOptions, HttpBytesResponse, HttpRequest, HttpResponse } from '../shared/contracts/platform.ts';
import { challengeProvider, isCloudflareChallenge } from './cloudflare.ts';
import { CookieJar } from './cookies.ts';
import { base64ToBytes } from './polyfills/base64.ts';
import { URL } from './polyfills/url.ts';
import { codeUnitsToString } from './polyfills/utf8.ts';

export const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

/** Headers sent unless the plugin sets them (LNReader sends similar defaults). */
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': IPHONE_SAFARI_UA,
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Transient server errors worth one retry for idempotent requests. */
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const RETRY_DELAY_MS = 800;

/** After a Cloudflare challenge, GETs to that host go straight to the WebView fetch for this long. */
const CF_STICKY_MS = 10 * 60_000;

export interface NetLimits {
  /** Requests in flight per host (default 3). */
  perHost?: number;
  /** Concurrent WebView fetches (default 1: one hidden WebView loads one page at a time). */
  browser?: number;
}

/** A counting semaphore keyed by name; a released slot is handed straight to the next waiter. */
export class KeyedLimiter {
  readonly #limit: number;
  readonly #gates = new Map<string, { active: number; queue: (() => void)[] }>();

  constructor(limit: number) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    await this.#acquire(key);
    try {
      return await fn();
    } finally {
      this.#release(key);
    }
  }

  /** Requests currently running for a key (for tests and diagnostics). */
  active(key: string): number {
    return this.#gates.get(key)?.active ?? 0;
  }

  #acquire(key: string): Promise<void> {
    let g = this.#gates.get(key);
    if (!g) this.#gates.set(key, (g = { active: 0, queue: [] }));
    if (g.active < this.#limit) {
      g.active++;
      return Promise.resolve();
    }
    const gate = g;
    return new Promise<void>((resolve) => gate.queue.push(resolve));
  }

  #release(key: string): void {
    const g = this.#gates.get(key);
    if (!g) return;
    const next = g.queue.shift();
    if (next) {
      next(); // the slot passes to the waiter; `active` is unchanged
      return;
    }
    g.active--;
    if (g.active <= 0) this.#gates.delete(key);
  }
}

export interface NetRequest extends HttpRequest {
  /** Used as Referer when the request sets none (the plugin's site). */
  referer?: string;
}

export type NetDeps = Pick<PluginHostDeps, 'http' | 'browserFetch' | 'log' | 'now'> & Partial<Pick<PluginHostDeps, 'sleep'>>;

export interface Net {
  request(req: NetRequest): Promise<HttpResponse>;
  requestBytes(req: NetRequest): Promise<HttpBytesResponse>;
  readonly cookies: CookieJar;
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return k;
  return undefined;
}

/** Headers a page script cannot (or should not) set on fetch(); the WebView supplies its own. */
const BROWSER_MANAGED = new Set(['cookie', 'user-agent', 'referer', 'host', 'origin', 'content-length', 'connection', 'accept-encoding', 'accept-language']);

/** The request's headers a WebView page's fetch() may send (e.g. Content-Type with its boundary). */
export function pageSettableHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (!BROWSER_MANAGED.has(lower) && !lower.startsWith('sec-') && !lower.startsWith('proxy-')) out[k] = v;
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Maps any thrown value from the HTTP layer to a SourceError (NETWORK or TIMEOUT). */
export function toNetworkError(err: unknown, url: string): SourceError {
  if (err instanceof SourceError) return err;
  const e = err as { name?: unknown; message?: unknown; code?: unknown; cause?: { code?: unknown; message?: unknown } };
  const name = typeof e?.name === 'string' ? e.name : '';
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const rawCode = e?.code ?? e?.cause?.code;
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : '';
  const timeout = name === 'TimeoutError' || /timed? ?out|timeout/i.test(message) || /TIMEOUT|ETIMEDOUT/.test(code);
  return new SourceError(timeout ? 'TIMEOUT' : 'NETWORK', `${timeout ? 'Timed out' : 'Network error'} fetching ${url}: ${message}`);
}

export function createNet(deps: NetDeps, limits: NetLimits = {}): Net {
  const jar = new CookieJar(deps.now);
  const cfHosts = new Map<string, number>();
  const perHost = new KeyedLimiter(limits.perHost ?? 3);
  const browserSlots = new KeyedLimiter(limits.browser ?? 1);

  function prepare(req: NetRequest): HttpRequest {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    for (const [k, v] of Object.entries(DEFAULT_HEADERS)) if (!findHeader(headers, k)) headers[k] = v;
    if (req.referer && !findHeader(headers, 'Referer')) headers.Referer = req.referer;
    const jarCookies = jar.header(req.url);
    if (jarCookies) {
      const existing = findHeader(headers, 'Cookie');
      if (existing) headers[existing] = `${headers[existing]}; ${jarCookies}`;
      else headers.Cookie = jarCookies;
    }
    const out: HttpRequest = { url: req.url, method: req.method ?? 'GET', headers };
    if (req.body !== undefined) out.body = req.body;
    if (req.timeoutMs !== undefined) out.timeoutMs = req.timeoutMs;
    return out;
  }

  function remember(url: string, headers: Record<string, string>): void {
    const k = findHeader(headers, 'set-cookie');
    if (k) jar.store(url, headers[k]);
  }

  function cloudflareError(url: string, provider = 'Cloudflare'): SourceError {
    return new SourceError('CLOUDFLARE', `${provider} challenge at ${hostOf(url)} (open the site in the browser to pass it)`);
  }

  /**
   * Retries a challenged request through the hidden WebView. GETs load the page (as before); POSTs
   * (e.g. Madara's and Scribble Hub's chapter-list calls) are sent by the platform as an in-page fetch
   * on the site's origin, with the body and the headers a page script may set.
   */
  async function viaBrowser(req: NetRequest, provider = 'Cloudflare'): Promise<HttpResponse> {
    const browserFetch = deps.browserFetch;
    const method = req.method ?? 'GET';
    if (!browserFetch || (method !== 'GET' && method !== 'POST')) throw cloudflareError(req.url, provider);
    deps.log('info', `${provider} challenge at ${hostOf(req.url)}; retrying ${method} through the WebView`);
    let res: HttpResponse;
    try {
      const opts: BrowserFetchOptions = {};
      if (req.timeoutMs !== undefined) opts.timeoutMs = req.timeoutMs;
      if (method === 'POST') {
        opts.method = 'POST';
        opts.headers = pageSettableHeaders(req.headers ?? {});
        if (req.body !== undefined) opts.body = req.body;
      }
      res = await browserSlots.run('webview', () => browserFetch(req.url, Object.keys(opts).length ? opts : undefined));
    } catch (err) {
      throw toNetworkError(err, req.url);
    }
    const still = challengeProvider(res);
    if (still) throw cloudflareError(req.url, still);
    cfHosts.set(hostOf(req.url), deps.now() + CF_STICKY_MS);
    return res;
  }

  function stickyCloudflare(req: NetRequest): boolean {
    const method = req.method ?? 'GET';
    if ((method !== 'GET' && method !== 'POST') || !deps.browserFetch) return false;
    const until = cfHosts.get(hostOf(req.url));
    return until !== undefined && until > deps.now();
  }

  const pause = (ms: number): Promise<void> => (deps.sleep ? deps.sleep(ms) : Promise.resolve());

  const idempotent = (req: NetRequest): boolean => {
    const m = req.method ?? 'GET';
    return (m === 'GET' || m === 'HEAD') && req.body === undefined;
  };

  /**
   * One request in a per-host slot, retried once (after RETRY_DELAY_MS, outside the slot) when an
   * idempotent request hits a transient failure: a connection error or HTTP 502/503/504 that is not a
   * Cloudflare challenge. Timeouts are not retried (they already took the full timeout).
   */
  async function send<R extends { url: string; status: number; headers: Record<string, string> }>(
    req: NetRequest,
    run: (prepared: HttpRequest) => Promise<R>,
    isChallenge: (res: R) => boolean,
  ): Promise<R> {
    for (let attempt = 1; ; attempt++) {
      let res: R;
      try {
        // Prepared inside the slot so cookies set by requests that finished meanwhile are sent.
        res = await perHost.run(hostOf(req.url), () => run(prepare(req)));
      } catch (err) {
        const e = toNetworkError(err, req.url);
        if (attempt === 1 && e.code === 'NETWORK' && idempotent(req)) {
          await pause(RETRY_DELAY_MS);
          continue;
        }
        throw e;
      }
      remember(res.url || req.url, res.headers);
      if (attempt === 1 && TRANSIENT_STATUS.has(res.status) && idempotent(req) && !isChallenge(res)) {
        await pause(RETRY_DELAY_MS);
        continue;
      }
      return res;
    }
  }

  async function request(req: NetRequest): Promise<HttpResponse> {
    if (stickyCloudflare(req)) return viaBrowser(req);
    const res = await send<HttpResponse>(req, (r) => deps.http.request(r), isCloudflareChallenge);
    const provider = challengeProvider(res);
    if (provider) return viaBrowser(req, provider);
    return res;
  }

  function bytesChallenge(res: HttpBytesResponse): boolean {
    if (res.status !== 403 && res.status !== 429 && res.status !== 503) return false;
    const head = codeUnitsToString(base64ToBytes(res.base64.slice(0, 80_000)));
    return isCloudflareChallenge({ status: res.status, headers: res.headers, body: head });
  }

  async function requestBytes(req: NetRequest): Promise<HttpBytesResponse> {
    if (stickyCloudflare(req)) throw cloudflareError(req.url);
    const res = await send<HttpBytesResponse>(req, (r) => deps.http.requestBytes(r), bytesChallenge);
    if (bytesChallenge(res)) throw cloudflareError(req.url);
    return res;
  }

  return { request, requestBytes, cookies: jar };
}
