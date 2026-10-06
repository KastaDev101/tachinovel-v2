/**
 * `net`: the HttpClient handed to the plugin host and used for repos/covers.
 * Wraps Platform.http with a default timeout (and an optional default User-Agent), per-host concurrency
 * (≤ 3, of which ≤ 1 background; interactive requests jump the queue — see LaneLimiter),
 * and retry with backoff for idempotent requests (GET/HEAD) on transport errors and 429/502/504.
 * 503/403 are NOT retried here: they are the usual Cloudflare challenge statuses and the plugin host
 * runs its own Cloudflare detection + browserFetch fallback.
 * Transport failures surface as SourceError-shaped errors (code NETWORK/TIMEOUT).
 */
import type { BrowserFetchOptions, HttpBytesResponse, HttpClient, HttpRequest, HttpResponse, Platform } from '../../shared/contracts/platform.ts';
import { KeyedLimiter, type Lane, LaneLimiter } from '../lib/async.ts';
import { AppError, errorCode, errorMessage } from '../lib/errors.ts';
import { hostOf } from '../lib/url.ts';

/** Mobile Safari UA, available via NetOptions.userAgent (not injected by default, see below). */
export const SAFARI_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

/** 'cover': on-screen cover images, with their own per-host limit so they never queue behind other work. */
export type NetLane = Lane | 'cover';

export interface NetOptions {
  maxPerHost: number;
  /** Cover image requests in flight per host (own limit, separate from the API lanes). */
  maxCoversPerHost: number;
  /** Background requests (update checks, read-ahead, downloads, covers) in flight per host. */
  maxBackgroundPerHost: number;
  /** Extra attempts for idempotent requests. */
  retries: number;
  /** First backoff; doubles per attempt. */
  backoffMs: number;
  timeoutMs: number;
  /**
   * User-Agent added when a request sets none. Default null: keep the platform's own (CP0: Royal Road
   * answers 200 to Scriptable's default Request; the PC harness adds its own default UA).
   */
  userAgent: string | null;
}

export const DEFAULT_NET_OPTIONS: NetOptions = {
  maxPerHost: 3,
  maxCoversPerHost: 4,
  maxBackgroundPerHost: 1,
  retries: 2,
  backoffMs: 500,
  timeoutMs: 15_000,
  userAgent: null,
};

const RETRY_STATUS = new Set([429, 502, 504]);

/**
 * iOS errors where an immediate retry can't help (no connection, DNS failure): fail fast so an offline
 * phone shows "offline" at once instead of after ~1.5 s of backoff per request.
 */
const NO_RETRY_ERROR = /appears to be offline|not connected to the internet|hostname could not be found|cannot find host/i;
/** Longest Retry-After we honour for 429/503 before retrying (longer → give up with the response). */
const MAX_RETRY_AFTER_MS = 10_000;

/** Retry-After (seconds or HTTP date) → ms, or undefined. */
export function retryAfterMs(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const secs = Number(value.trim());
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export class NetError extends AppError {
  constructor(code: 'NETWORK' | 'TIMEOUT', message: string) {
    super(code, message, true);
    this.name = 'SourceError';
  }
}

function toNetError(err: unknown, url: string): Error {
  const known = errorCode(err);
  if (known) return err instanceof Error ? err : new AppError(known, errorMessage(err));
  const msg = errorMessage(err);
  const host = hostOf(url) || url;
  if (/timed? ?out|timeout/i.test(msg)) return new NetError('TIMEOUT', `${host} took too long to answer. Try again.`);
  return new NetError('NETWORK', `Couldn't reach ${host}: ${msg}`);
}

/** The interactive client, plus lane-bound clients sharing the same per-host limits. */
export interface Net extends HttpClient {
  readonly stats: { requests: number; retries: number };
  lane(lane: NetLane): HttpClient;
  /**
   * After the user passed a Cloudflare check in a visible WebView: send this host's GETs through the
   * platform's hidden-WebView fetch (shares cookies if Scriptable WebViews share a data store; unverified).
   */
  preferBrowser(host: string): void;
  prefersBrowser(host: string): boolean;
}

export function createNet(platform: Pick<Platform, 'http' | 'sleep' | 'log' | 'browserFetch'> & { now?: () => number }, options: Partial<NetOptions> = {}): Net {
  const opts: NetOptions = { ...DEFAULT_NET_OPTIONS, ...options };
  const browserHosts = new Set<string>();
  /** Hosts whose first WebView-routed response was logged (we want to learn whether cookies carry over). */
  const loggedBrowserHosts = new Set<string>();

  async function viaBrowser(req: HttpRequest, host: string): Promise<HttpResponse> {
    const fetchInBrowser = platform.browserFetch;
    if (!fetchInBrowser) return platform.http.request(req);
    const timeoutMs = Math.max(req.timeoutMs ?? opts.timeoutMs, 30_000);
    const post = req.method === 'POST';
    const init: BrowserFetchOptions = { timeoutMs };
    if (post) {
      init.method = 'POST';
      if (req.headers) init.headers = req.headers;
      if (req.body !== undefined) init.body = req.body;
    }
    const res = await fetchInBrowser(req.url, init);
    const key = post ? `POST ${host}` : host;
    if (!loggedBrowserHosts.has(key)) {
      loggedBrowserHosts.add(key);
      const title = /<title[^>]*>([^<]{0,80})/i.exec(res.body)?.[1]?.trim() ?? '';
      platform.log('info', `net: ${post ? 'POST ' : ''}${host} via WebView after challenge → ${res.status}, ${res.body.length} chars${title ? `, title "${title}"` : ''}`);
    }
    return res;
  }
  const limiter = new LaneLimiter(opts.maxPerHost, opts.maxBackgroundPerHost);
  const coverLimiter = new KeyedLimiter(opts.maxCoversPerHost);
  const stats = { requests: 0, retries: 0 };

  function prepare(req: HttpRequest): HttpRequest {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (opts.userAgent && !Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent')) headers['User-Agent'] = opts.userAgent;
    return { ...req, headers, timeoutMs: req.timeoutMs ?? opts.timeoutMs };
  }

  async function send<R extends { status: number; headers: Record<string, string> }>(
    req: HttpRequest,
    lane: NetLane,
    call: (r: HttpRequest) => Promise<R>,
  ): Promise<R> {
    const prepared = prepare(req);
    const method = prepared.method ?? 'GET';
    const idempotent = method === 'GET' || method === 'HEAD';
    const host = hostOf(prepared.url);
    const attempts = idempotent ? opts.retries + 1 : 1;
    let lastErr: unknown;
    let waitMs: number | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        stats.retries++;
        await platform.sleep(waitMs ?? opts.backoffMs * 2 ** (attempt - 1));
        waitMs = undefined;
      }
      const release = lane === 'cover' ? await coverLimiter.acquire(host) : await limiter.acquire(host, lane);
      let res: R;
      try {
        stats.requests++;
        res = await call(prepared);
      } catch (err) {
        lastErr = err;
        platform.log('warn', `net: ${method} ${prepared.url} failed (attempt ${attempt + 1}/${attempts}): ${errorMessage(err)}`);
        if (NO_RETRY_ERROR.test(errorMessage(err))) break;
        continue;
      } finally {
        release();
      }
      if (RETRY_STATUS.has(res.status) && attempt < attempts - 1) {
        // Rate limited: honour a short Retry-After; a long one isn't worth holding the user for.
        const after = res.status === 429 ? retryAfterMs(res.headers['retry-after'], platform.now?.() ?? Date.now()) : undefined;
        if (after !== undefined && after > MAX_RETRY_AFTER_MS) return res;
        waitMs = after;
        lastErr = undefined;
        platform.log('info', `net: ${method} ${prepared.url} → ${res.status}, retrying${after !== undefined ? ` in ${after} ms` : ''}`);
        continue;
      }
      return res;
    }
    throw toNetError(lastErr ?? new Error('request failed'), prepared.url);
  }

  const clientFor = (lane: NetLane): HttpClient => ({
    request: (req: HttpRequest): Promise<HttpResponse> =>
      send(req, lane, (r) => {
        const host = hostOf(r.url);
        // GET and POST can go through the WebView (POST as an in-page fetch); other methods can't.
        const method = r.method ?? 'GET';
        return (method === 'GET' || method === 'POST') && browserHosts.has(host) ? viaBrowser(r, host) : platform.http.request(r);
      }),
    requestBytes: (req: HttpRequest): Promise<HttpBytesResponse> => send(req, lane, (r) => platform.http.requestBytes(r)),
  });
  const lanes: Record<NetLane, HttpClient> = { interactive: clientFor('interactive'), background: clientFor('background'), cover: clientFor('cover') };
  return {
    stats,
    ...lanes.interactive,
    lane: (lane) => lanes[lane],
    preferBrowser(host) {
      if (host) browserHosts.add(host.toLowerCase());
    },
    prefersBrowser: (host) => browserHosts.has(host.toLowerCase()),
  };
}
