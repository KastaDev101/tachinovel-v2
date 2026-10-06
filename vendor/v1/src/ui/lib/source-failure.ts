/**
 * Plain-language wording for why a source failed (`SourceFailureReason`, from the plugin host's failure
 * classifier on live errors and from plugins/verified.json for the catalog), plus what to offer next.
 * Shared by Extensions, global search and the source screen so a reason always reads the same.
 */
import type { SourceFailureReason } from '../../shared/contracts/domain.ts';

/** What the screen can offer: open the site to pass its check, try again, look for a plugin update. */
export type FailureAction = 'open-site' | 'retry' | 'update';

export interface FailureInfo {
  /** One sentence for the user. */
  text: string;
  /** A few words for a status line or pill ("Bot check", "Site gone"). */
  short: string;
  /** The button to show, if any. */
  action: FailureAction | null;
}

const BOT_CHECK: FailureInfo = { text: 'The site wants to check you’re not a bot', short: 'Bot check', action: 'open-site' };
const GONE: FailureInfo = { text: 'This site no longer exists', short: 'Site gone', action: null };
const DOWN: FailureInfo = { text: 'Can’t reach the site right now', short: 'Site down', action: 'retry' };

export const FAILURES: Readonly<Record<SourceFailureReason, FailureInfo>> = {
  'bot-check': BOT_CHECK,
  blocked: BOT_CHECK,
  'site-gone': GONE,
  parked: GONE,
  tls: { text: 'The site’s secure connection is broken', short: 'Insecure connection', action: null },
  'site-down': DOWN,
  unreachable: DOWN,
  'rate-limited': { text: 'The site is limiting requests; try again in a few minutes', short: 'Rate limited', action: 'retry' },
  'layout-changed': { text: 'The site changed; check for a plugin update', short: 'Site changed', action: 'update' },
  'needs-account': { text: 'This needs an account on the site; TachiNovel only reads what’s free without signing in', short: 'Needs an account', action: null },
  'not-found': { text: 'Removed or moved on the site', short: 'Not found', action: null },
  offline: { text: 'You’re offline', short: 'Offline', action: 'retry' },
  unsupported: { text: 'This plugin needs something TachiNovel can’t do', short: 'Unsupported', action: null },
};

const REASONS: ReadonlySet<string> = new Set(Object.keys(FAILURES));

export function isFailureReason(v: unknown): v is SourceFailureReason {
  return typeof v === 'string' && REASONS.has(v);
}

/** Wording and action for a reason. */
export function failureInfo(reason: SourceFailureReason): FailureInfo {
  return FAILURES[reason];
}

/**
 * The reason carried by a failed bridge call (`BridgeError.reason`), or by anything shaped like it.
 * An error that says it's offline counts as 'offline' even without a reason.
 */
export function reasonOf(err: unknown): SourceFailureReason | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const r = (err as { reason?: unknown }).reason;
  if (isFailureReason(r)) return r;
  return (err as { offline?: unknown }).offline === true ? 'offline' : undefined;
}
