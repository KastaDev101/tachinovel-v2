/**
 * Set-Cookie normalization for HttpResponse.headers (contract: multiple values joined with "\n").
 *
 * iOS (NSHTTPURLResponse.allHeaderFields, which Scriptable's request.response.headers mirrors) folds
 * repeated Set-Cookie headers into one string joined with ", ". Commas also occur inside
 * `Expires=Wed, 21 Oct 2026 07:28:00 GMT`, so we only split at a comma that is followed by a
 * `name=` token (a date's "21 Oct …" never is).
 */

/** Split a folded Set-Cookie header into individual cookie strings. */
export function splitSetCookie(folded: string): string[] {
  const out: string[] = [];
  for (const part of folded.split(/,(?=\s*[^\s;,=]+=)/)) {
    const c = part.trim();
    if (c) out.push(c);
  }
  return out;
}

/** Cookie object as Scriptable reports it in request.response.cookies (fields vary; all optional). */
export interface NativeCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  isSecure?: unknown;
  sessionOnly?: unknown;
  expiresDate?: unknown;
}

/** Rebuild a Set-Cookie string from Scriptable's cookie object (null if it has no name). */
export function cookieToSetCookie(c: NativeCookie): string | null {
  if (typeof c.name !== 'string' || !c.name) return null;
  const parts = [`${c.name}=${typeof c.value === 'string' ? c.value : ''}`];
  if (typeof c.domain === 'string' && c.domain) parts.push(`Domain=${c.domain}`);
  if (typeof c.path === 'string' && c.path) parts.push(`Path=${c.path}`);
  if (c.sessionOnly !== true && c.expiresDate !== undefined && c.expiresDate !== null) {
    const d = c.expiresDate instanceof Date ? c.expiresDate : new Date(c.expiresDate as string | number);
    if (!Number.isNaN(d.getTime())) parts.push(`Expires=${d.toUTCString()}`);
  }
  if (c.secure === true || c.isSecure === true) parts.push('Secure');
  if (c.httpOnly === true) parts.push('HttpOnly');
  return parts.join('; ');
}

/**
 * The "\n"-joined set-cookie value for HttpResponse.headers: from the raw (possibly folded) header
 * when present, else rebuilt from the native cookie list. Undefined when there are no cookies.
 */
export function setCookieHeader(rawHeader: string | undefined, cookies: unknown): string | undefined {
  if (rawHeader) {
    const list = rawHeader.split('\n').flatMap((line) => splitSetCookie(line));
    return list.length > 0 ? list.join('\n') : undefined;
  }
  if (!Array.isArray(cookies)) return undefined;
  const list: string[] = [];
  for (const c of cookies) {
    if (c && typeof c === 'object') {
      const s = cookieToSetCookie(c as NativeCookie);
      if (s) list.push(s);
    }
  }
  return list.length > 0 ? list.join('\n') : undefined;
}
