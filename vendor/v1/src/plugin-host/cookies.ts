/**
 * A small RFC 6265-style cookie jar: Set-Cookie in, Cookie header out. Domain/host-only matching,
 * path matching, Secure, Max-Age/Expires. In memory, shared by all plugins of one host instance.
 */
import { URL } from './polyfills/url.ts';

interface Cookie {
  name: string;
  value: string;
  /** Lower-cased, no leading dot. */
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  /** Epoch ms; undefined = session cookie. */
  expires?: number;
  created: number;
}

/**
 * Splits a header value that may contain several Set-Cookie lines joined with ", " or "\n"
 * (platforms differ), without splitting inside Expires dates ("Wed, 21 Oct 2015 …").
 */
export function splitSetCookie(header: string): string[] {
  const out: string[] = [];
  for (const line of header.split(/\r?\n/)) {
    let start = 0;
    for (let i = 0; i < line.length; i++) {
      if (line.charAt(i) !== ',') continue;
      // A new cookie starts after the comma if what follows looks like "name=" before any ';' or ','.
      const rest = line.slice(i + 1);
      if (/^\s*[^=;,\s]+=/.test(rest) && !/^\s*\d{2}[- ]/.test(rest)) {
        const part = line.slice(start, i).trim();
        if (part) out.push(part);
        start = i + 1;
      }
    }
    const last = line.slice(start).trim();
    if (last) out.push(last);
  }
  return out;
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const i = pathname.lastIndexOf('/');
  return i <= 0 ? '/' : pathname.slice(0, i);
}

function domainMatches(host: string, domain: string): boolean {
  if (host === domain) return true;
  return host.endsWith('.' + domain) && !/^\d+\.\d+\.\d+\.\d+$/.test(host);
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || reqPath.charAt(cookiePath.length) === '/';
}

export class CookieJar {
  #cookies: Cookie[] = [];
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** Stores cookies from a response's Set-Cookie header value(s). */
  store(url: string, setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    const lines = Array.isArray(setCookie) ? setCookie.flatMap(splitSetCookie) : splitSetCookie(setCookie);
    for (const line of lines) this.#storeOne(u, line);
  }

  #storeOne(u: URL, line: string): void {
    const [pair = '', ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) return;
    const host = u.hostname.toLowerCase();
    const now = this.#now();
    const cookie: Cookie = { name, value, domain: host, hostOnly: true, path: defaultPath(u.pathname), secure: false, created: now };
    let maxAge: number | undefined;
    for (const attr of attrs) {
      const i = attr.indexOf('=');
      const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const val = i < 0 ? '' : attr.slice(i + 1).trim();
      if (key === 'domain' && val) {
        const d = val.replace(/^\./, '').toLowerCase();
        if (!domainMatches(host, d)) return; // cookie for a foreign domain: reject
        cookie.domain = d;
        cookie.hostOnly = false;
      } else if (key === 'path' && val.startsWith('/')) {
        cookie.path = val;
      } else if (key === 'secure') {
        cookie.secure = true;
      } else if (key === 'max-age' && /^-?\d+$/.test(val)) {
        maxAge = parseInt(val, 10);
      } else if (key === 'expires' && maxAge === undefined) {
        const t = Date.parse(val.replace(/-/g, ' '));
        if (!Number.isNaN(t)) cookie.expires = t;
      }
    }
    if (maxAge !== undefined) cookie.expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
    this.#cookies = this.#cookies.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
    if (cookie.expires === undefined || cookie.expires > now) this.#cookies.push(cookie);
  }

  /** The Cookie header value for a request URL ('' if none). */
  header(url: string): string {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return '';
    }
    const host = u.hostname.toLowerCase();
    const now = this.#now();
    this.#cookies = this.#cookies.filter((c) => c.expires === undefined || c.expires > now);
    const matching = this.#cookies.filter(
      (c) =>
        (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)) &&
        pathMatches(u.pathname || '/', c.path) &&
        (!c.secure || u.protocol === 'https:'),
    );
    matching.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  clear(): void {
    this.#cookies = [];
  }

  get size(): number {
    return this.#cookies.length;
  }
}
