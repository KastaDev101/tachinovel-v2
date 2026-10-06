/**
 * @libs/fetch shim — LNReader's fetchApi / fetchText / fetchFile / fetchProto on top of the host's
 * networking (cookies, default headers, Cloudflare fallback). API mirrors
 * LNReader/lnreader `src/plugins/helpers/fetch.ts` (MIT).
 *
 * Request bodies may be a string, URLSearchParams or FormData (ours or native); they are converted
 * to an encoded string body plus a Content-Type, like fetch would. Responses are Response-like:
 * ok, status, statusText, url, redirected, headers.get(), text(), json(), arrayBuffer(), clone().
 */
import { SourceError } from '../../shared/contracts/plugin-host.ts';
import type { HttpRequest, HttpResponse } from '../../shared/contracts/platform.ts';
import type { CallRecord, PluginContext } from '../context.ts';
import { encodeMultipart, makeBoundary } from '../polyfills/formdata.ts';
import { Headers, headersToRecord } from '../polyfills/headers.ts';
import { TextDecoder, normalizeEncoding } from '../polyfills/text.ts';
import { base64ToBytes } from '../polyfills/base64.ts';
import { URL } from '../polyfills/url.ts';
import { utf8Encode } from '../polyfills/utf8.ts';
import { hostProvided } from './internal.ts';

type HeadersInit = Headers | Record<string, string | undefined> | [string, string][];

/** A body fetch accepts that we can send: strings, URLSearchParams and FormData. */
export type FetchBody = string | { toString(): string } | null;

export interface FetchInit {
  method?: string;
  headers?: HeadersInit;
  body?: FetchBody;
  /** Sets the Referer header (as in fetch). */
  referrer?: string;
  [key: string]: unknown;
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly redirected: boolean;
  readonly type: 'basic';
  readonly headers: Headers;
  readonly bodyUsed: boolean;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
  clone(): FetchResponse;
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'HEAD']);

function tagOf(v: unknown): string {
  return Object.prototype.toString.call(v);
}

class ResponseImpl implements FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly redirected: boolean;
  readonly type = 'basic' as const;
  readonly headers: Headers;
  #body: string;
  #used = false;

  constructor(res: HttpResponse, requestedUrl: string) {
    this.status = res.status;
    this.ok = res.status >= 200 && res.status < 300;
    this.statusText = STATUS_TEXT[res.status] ?? '';
    this.url = res.url || requestedUrl;
    this.redirected = this.url !== requestedUrl;
    this.headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      try {
        this.headers.append(k, v);
      } catch {
        // skip headers with names fetch would reject
      }
    }
    this.#body = res.body;
  }

  get bodyUsed(): boolean {
    return this.#used;
  }

  // Bodies can be read more than once (unlike fetch); some plugins rely on lenient runtimes.
  text(): Promise<string> {
    this.#used = true;
    return Promise.resolve(this.#body);
  }

  json<T = unknown>(): Promise<T> {
    this.#used = true;
    try {
      return Promise.resolve(JSON.parse(this.#body) as T);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new SyntaxError(String(err)));
    }
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    this.#used = true;
    const bytes = utf8Encode(this.#body);
    return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }

  clone(): FetchResponse {
    const headers: Record<string, string> = {};
    this.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const copy = new ResponseImpl({ url: this.url, status: this.status, headers, body: this.#body }, this.url);
    return copy;
  }

  get [Symbol.toStringTag](): string {
    return 'Response';
  }
}

function simpleHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Converts a fetch-style (url, init) into an HttpRequest. Exported for tests. */
/** Path words a site URL is commonly joined with (see repairSiteJoin). */
const SITE_PATH_WORDS = /^(?:page|series|novel|novels|manga|book|books|chapter|chapters|search|genre|genres|tag|tags|wp-admin|wp-json|ajax|api)(?=[/?#]|$)/;

/**
 * Repairs `site + 'page/…'` when a plugin's site lacks its trailing slash ("https://x.com" +
 * "page/1/" → "https://x.compage/1/", a bug in a few published LNReader-template plugins). Only when
 * what follows the site is a common path word, so a different host such as "x.community" is left alone.
 */
export function repairSiteJoin(url: string, site: string | undefined): string {
  if (!site || site.endsWith('/') || !url.startsWith(site)) return url;
  const rest = url.slice(site.length);
  return rest && !/^[/?#:]/.test(rest) && SITE_PATH_WORDS.test(rest) ? `${site}/${rest}` : url;
}

export function toHttpRequest(input: unknown, init: FetchInit | undefined, site?: string): HttpRequest & { referer?: string } {
  let url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: unknown })?.url ?? input);
  url = repairSiteJoin(url, site);
  try {
    url = new URL(url, site).href;
  } catch {
    throw new TypeError(`Invalid URL: ${url}`);
  }
  const method = String(init?.method ?? 'GET').toUpperCase();
  if (!METHODS.has(method)) throw new SourceError('PLUGIN', `HTTP method ${method} is not supported`);
  const headers = headersToRecord(init?.headers);
  const hasHeader = (name: string): boolean => Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
  const req: HttpRequest & { referer?: string } = { url, method: method as HttpRequest['method'], headers };

  const body = init?.body;
  if (body !== undefined && body !== null) {
    if (method === 'GET' || method === 'HEAD') throw new TypeError('Request with GET/HEAD method cannot have body.');
    const tag = tagOf(body);
    if (typeof body === 'string') {
      req.body = body;
      if (!hasHeader('Content-Type')) headers['Content-Type'] = 'text/plain;charset=UTF-8';
    } else if (tag === '[object URLSearchParams]') {
      req.body = body.toString();
      if (!hasHeader('Content-Type')) headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    } else if (tag === '[object FormData]') {
      const entries: [string, string][] = [];
      for (const [k, v] of body as unknown as Iterable<[string, unknown]>) {
        if (typeof v !== 'string') throw new SourceError('PLUGIN', 'FormData file fields are not supported');
        entries.push([k, v]);
      }
      const boundary = makeBoundary(simpleHash(JSON.stringify(entries)));
      const enc = encodeMultipart(entries, boundary);
      req.body = enc.body;
      const ct = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
      if (ct) delete headers[ct];
      headers['Content-Type'] = enc.contentType;
    } else if (tag === '[object ArrayBuffer]' || ArrayBuffer.isView(body)) {
      throw new SourceError('PLUGIN', 'Binary request bodies are not supported');
    } else {
      req.body = String(body);
      if (!hasHeader('Content-Type')) headers['Content-Type'] = 'text/plain;charset=UTF-8';
    }
  }
  if (typeof init?.referrer === 'string' && init.referrer && init.referrer !== 'about:client' && !hasHeader('Referer')) {
    headers.Referer = init.referrer;
  }
  if (site) req.referer = site;
  return req;
}

export function createFetchLib(ctx: PluginContext) {
  /** Sends a request, attributing its outcome to the adapter calls it belongs to (context.ts). */
  async function send(url: unknown, init?: FetchInit): Promise<FetchResponse> {
    const req = toHttpRequest(url, init, ctx.site);
    const calls = ctx.attribute(req.url);
    let res: HttpResponse;
    try {
      const plainGet = (req.method ?? 'GET') === 'GET' && req.body === undefined;
      res = plainGet ? await ctx.sharedGet(`${req.url}
${JSON.stringify(req.headers ?? {})}`, () => ctx.net.request(req)) : await ctx.net.request(req);
    } catch (err) {
      const e = err instanceof SourceError ? err : new SourceError('NETWORK', String(err));
      ctx.recordFailure(calls, e);
      throw e;
    }
    ctx.recordStatus(calls, res.status);
    ctx.recordBody(calls, res.status, res.url || req.url, res.body);
    return new ResponseImpl(res, req.url);
  }

  /** Like send, for raw bytes; resolves to null (and records why) on failure. */
  async function sendBytes(url: unknown, init?: FetchInit): Promise<{ status: number; base64: string } | null> {
    let calls: CallRecord[] = [];
    try {
      const req = toHttpRequest(url, init, ctx.site);
      calls = ctx.attribute(req.url);
      const res = await ctx.net.requestBytes(req);
      ctx.recordStatus(calls, res.status);
      return res;
    } catch (err) {
      if (err instanceof SourceError) ctx.recordFailure(calls, err);
      return null;
    }
  }

  /** fetch() with default headers and cookies. Resolves for any HTTP status, like fetch. */
  async function fetchApi(url: string, init?: FetchInit): Promise<FetchResponse> {
    return send(url, init);
  }

  /** Text of the response, or '' on failure / non-2xx (LNReader semantics). */
  async function fetchText(url: string, init?: FetchInit, encoding?: string): Promise<string> {
    const enc = normalizeEncoding(encoding);
    if (enc === 'utf-8') {
      try {
        const res = await send(url, init);
        return res.ok ? await res.text() : '';
      } catch {
        return ''; // recorded by send()
      }
    }
    if (!enc) {
      const calls = ctx.attribute(typeof url === 'string' ? url : '');
      ctx.recordFailure(calls, new SourceError('PLUGIN', `Text encoding "${String(encoding)}" is not supported`));
      return '';
    }
    const res = await sendBytes(url, init);
    if (!res || res.status < 200 || res.status >= 300) return '';
    return new TextDecoder(enc).decode(base64ToBytes(res.base64));
  }

  /** Base64 of the response body, or '' on failure / non-2xx. */
  async function fetchFile(url: string, init?: FetchInit): Promise<string> {
    const res = await sendBytes(url, init);
    return res && res.status >= 200 && res.status < 300 ? res.base64 : '';
  }

  /** gRPC-web/protobuf requests need protobufjs, which TachiNovel does not ship. */
  function fetchProto(..._args: unknown[]): Promise<never> {
    return Promise.reject(new SourceError('PLUGIN', 'fetchProto (protobuf) is not supported by TachiNovel'));
  }

  return { fetchApi, fetchText, fetchFile, fetchProto };
}

export type FetchLib = ReturnType<typeof createFetchLib>;

export const fetchApi = hostProvided<FetchLib['fetchApi']>('@libs/fetch', 'fetchApi');
export const fetchText = hostProvided<FetchLib['fetchText']>('@libs/fetch', 'fetchText');
export const fetchFile = hostProvided<FetchLib['fetchFile']>('@libs/fetch', 'fetchFile');
export const fetchProto = hostProvided<FetchLib['fetchProto']>('@libs/fetch', 'fetchProto');
