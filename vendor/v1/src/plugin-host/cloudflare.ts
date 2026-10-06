/**
 * Bot-check detection. All of these clear by themselves in a real browser engine (JavaScript or
 * proof-of-work checks), so the host retries them through the WebView:
 *   - Cloudflare interstitials ("Just a moment…") and block pages (403/429/503),
 *   - DDoS-Guard's check page (403),
 *   - Vercel's Security Checkpoint (429/403, `x-vercel-mitigated: challenge`),
 *   - Anubis proof-of-work pages ("Making sure you're not a bot!", served with 200).
 */

const CHALLENGE_STATUS = new Set([403, 429, 503]);
const SCAN_LIMIT = 60_000;

const PROVIDERS: { name: string; status: (s: number) => boolean; markers: RegExp; header?: (h: Record<string, string>) => boolean }[] = [
  {
    name: 'Cloudflare',
    status: (s) => CHALLENGE_STATUS.has(s),
    markers:
      /<title>\s*Just a moment\.{0,3}\s*<\/title>|cf-browser-verification|cdn-cgi\/challenge-platform|window\._cf_chl_opt|cf_chl_opt|challenge-error-text|Attention Required! \| Cloudflare|cf-error-details|Checking your browser before accessing/i,
    header: (h) => (header(h, 'cf-mitigated') ?? '').toLowerCase() === 'challenge',
  },
  {
    name: 'DDoS-Guard',
    status: (s) => CHALLENGE_STATUS.has(s),
    markers: /<title>\s*DDoS-Guard\s*<\/title>|ddos-guard\.net\/|check\.ddos-guard/i,
    header: (h) => /ddos-guard/i.test(header(h, 'server') ?? ''),
  },
  {
    name: 'Vercel',
    status: (s) => s === 429 || s === 403,
    markers: /<title>\s*Vercel Security Checkpoint\s*<\/title>/i,
    header: (h) => (header(h, 'x-vercel-mitigated') ?? '').toLowerCase() === 'challenge',
  },
  {
    // Anubis answers 200 with its check page, so it is recognized by its own markers only.
    name: 'Anubis',
    status: (s) => s === 200 || CHALLENGE_STATUS.has(s),
    markers: /<title>\s*Making sure you(?:&#39;|')re not a bot!\s*<\/title>[\s\S]*?\.within\.website\/|id="anubis_challenge"|\/\.within\.website\/x\/cmd\/anubis/i,
  },
];

export interface ResponseLike {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  if (name in headers) return headers[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return headers[k];
  return undefined;
}

/** The bot-check provider whose check page this is, if any. */
export function challengeProvider(res: ResponseLike): string | undefined {
  const head = res.body.length > SCAN_LIMIT ? res.body.slice(0, SCAN_LIMIT) : res.body;
  for (const p of PROVIDERS) {
    if (!p.status(res.status)) continue;
    if (p.header?.(res.headers) || p.markers.test(head)) return p.name;
  }
  return undefined;
}

/** True for any bot-check page a browser engine would clear (name kept from when it was Cloudflare only). */
export function isCloudflareChallenge(res: ResponseLike): boolean {
  return challengeProvider(res) !== undefined;
}
