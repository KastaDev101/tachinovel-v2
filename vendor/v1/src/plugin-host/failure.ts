/**
 * Why a source call failed, finer than SourceError.code, so the source screen can say "this site is
 * gone" rather than "network error". Proposed contract: `SourceError.reason?: SourceFailureReason`
 * (and `BridgeError.reason`); until then the host sets `reason` as an extra property on the
 * SourceErrors it throws, read with `failureReason(err)`.
 *
 * Classified from what the host already sees: the transport error (Node or iOS NSURLError wording),
 * the HTTP status, bot-check pages, parking pages, and whether the plugin crashed on a page that
 * loaded fine. Derived from the 2026-10-06 triage of every broken English plugin
 * (docs/plugin-survey.md).
 */
import type { SourceError } from '../shared/contracts/plugin-host.ts';

export type SourceFailureReason =
  /** The device has no internet connection. */
  | 'offline'
  /** The site's domain no longer resolves: the site is gone (or moved). */
  | 'site-gone'
  /** The domain is parked, for sale, or redirects to an unrelated site. */
  | 'parked'
  /** Certificate for another host, self-signed, or the server refuses the TLS handshake. */
  | 'tls'
  /** The connection timed out, was refused or reset (the site, or this network). */
  | 'unreachable'
  /** The site's server answers with an error (5xx, Cloudflare 52x). */
  | 'site-down'
  /** HTTP 429. */
  | 'rate-limited'
  /** A Cloudflare / DDoS-Guard / Vercel / Anubis check: open the site to verify. */
  | 'bot-check'
  /** HTTP 403 that is not a check. */
  | 'blocked'
  /** HTTP 404/410: the novel, chapter or listing does not exist (any more). */
  | 'not-found'
  /** Pages load normally but the plugin cannot read them: the site changed, the plugin needs an update. */
  | 'layout-changed'
  /** HTTP 401 / sign-in required (never attempted). */
  | 'needs-account'
  /** The plugin needs something TachiNovel does not provide. */
  | 'unsupported';

export const FAILURE_REASONS: readonly SourceFailureReason[] = [
  'offline',
  'site-gone',
  'parked',
  'tls',
  'unreachable',
  'site-down',
  'rate-limited',
  'bot-check',
  'blocked',
  'not-found',
  'layout-changed',
  'needs-account',
  'unsupported',
];

/** Reasons where trying again soon can help (the script's toBridgeError honours `retryable`). */
const RETRYABLE: Partial<Record<SourceFailureReason, boolean>> = {
  offline: true,
  unreachable: true,
  'site-down': true,
  'rate-limited': true,
  'site-gone': false,
  parked: false,
  tls: false,
  blocked: false,
  'not-found': false,
  'layout-changed': false,
  'needs-account': false,
  unsupported: false,
};

/**
 * Sets the reason on a SourceError (an own property, kept if already set), plus `retryable` where
 * the reason decides it, and returns the error.
 */
export function withReason<E extends SourceError>(err: E, reason: SourceFailureReason | undefined): E {
  if (!reason || failureReason(err) !== undefined) return err;
  const e = err as E & { reason?: SourceFailureReason; retryable?: boolean };
  e.reason = reason;
  const retry = RETRYABLE[reason];
  if (retry !== undefined) e.retryable = retry;
  return err;
}

export function failureReason(err: unknown): SourceFailureReason | undefined {
  const r = (err as { reason?: unknown } | null)?.reason;
  return typeof r === 'string' && (FAILURE_REASONS as readonly string[]).includes(r) ? (r as SourceFailureReason) : undefined;
}

/** A transport error (Node's undici/OpenSSL codes, or iOS NSURLError descriptions) → reason. */
export function networkReason(message: string, code: string): SourceFailureReason {
  const s = `${code} ${message}`;
  if (/ENETDOWN|ENETUNREACH|appears to be offline|not connected to the internet|-1009\b/i.test(s)) return 'offline';
  if (/ENOTFOUND|specified hostname could not be found|-1003\b|getaddrinfo .*NOTFOUND|name not resolved/i.test(s)) return 'site-gone';
  if (/CERT|certificate|self[- ]signed|altname|SSL|TLS|handshake|secure connection|-120[0-6]\b|-9\d{3}\b/i.test(s)) return 'tls';
  return 'unreachable';
}

/** HTTP status → reason, for statuses that explain a failure by themselves. */
export function statusReason(status: number | undefined): SourceFailureReason | undefined {
  if (status === undefined) return undefined;
  if (status === 404 || status === 410) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status === 401) return 'needs-account';
  if (status === 403) return 'blocked';
  if (status >= 500 && status <= 599) return 'site-down';
  return undefined;
}

/** Registrable-ish host: the last two labels (three for short second-level labels such as co.uk). */
function siteOf(host: string): string {
  const parts = host.toLowerCase().replace(/^www\d*\./, '').split('.');
  const n = parts.length >= 3 && (parts[parts.length - 2] ?? '').length <= 3 ? 3 : 2;
  return parts.slice(-n).join('.');
}

function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url);
  return m ? (m[1] ?? '').toLowerCase() : '';
}

/** The host of `finalUrl` when a request ended on a different site (not www/http/path changes). */
export function crossSiteRedirect(requestUrl: string, finalUrl: string): string | undefined {
  const from = hostOf(requestUrl);
  const to = hostOf(finalUrl);
  return from && to && siteOf(from) !== siteOf(to) ? to : undefined;
}

/** Signatures of domain-parking, for-sale and expired-domain pages (seen on dead plugin sites). */
const PARKING =
  /parklogic\.com|sedoparking|bodis\.com|abovedomains\.com\/javascript\/forsale|domain (?:is )?for sale|buy this (?:expired )?domain|expireddomains\.com|hugedomains\.com|afternic\.com|dan\.com\/buy-domain|porkbun\.com \| domain for sale|window\.location\.href\s*=\s*["']\/lander/i;

/**
 * A parking page: a parking signature in the page, or a final URL on a parking host (ww38.example.com,
 * expireddomains.com, …). Redirects to the same site (http→https, www, trailing slash) never count.
 */
export function isParkedPage(requestUrl: string, finalUrl: string, body: string): boolean {
  const head = body.length > 16_384 ? body.slice(0, 16_384) : body;
  if (PARKING.test(head)) return true;
  const to = hostOf(finalUrl);
  if (!to || to === hostOf(requestUrl)) return false;
  return /^ww\d+\./.test(to) || /(?:^|\.)(?:expireddomains\.com|hugedomains\.com|afternic\.com|sedo\.com|dan\.com)$/.test(to) || (siteOf(to) !== siteOf(hostOf(requestUrl)) && /<title>\s*(?:redirecting|loading)\.\.\.\s*<\/title>/i.test(head));
}

/** A plugin crash that means "the page is not what the plugin expects" (after pages loaded fine). */
export function looksLikeLayoutChange(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /is not valid JSON|Unexpected token|Cannot read propert|is not a function|undefined is not an object|null is not an object/i.test(msg);
}

/** The plugin's own "bot check / open in WebView" error (Madara, LightNovelWP templates). */
export function looksLikeBotCheck(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /captcha|bot verification|cloudflare|open (?:it |the site )?in (?:the )?webview/i.test(msg);
}
