/**
 * Suggested Text Cleanup rules (pure; unit-tested): common junk lines any source can carry, plus one
 * rule per installed source that hides lines naming the site itself ("Read at stonescape.xyz…").
 * Suggestions are off until the user turns one on; regexes are matched case-insensitively, like the
 * script does.
 */
import type { CleanupRule, SourceInfo } from '../../shared/contracts/domain.ts';

export interface CleanupSuggestion {
  id: string;
  /** Id of the rule it becomes (stable, so a turned-on suggestion is recognised later). */
  ruleId: string;
  label: string;
  pattern: string;
  regex: boolean;
  /** '*' or a pluginId. */
  scope: string;
  /** A line it hides. */
  example: string;
}

function common(id: string, label: string, pattern: string, regex: boolean, example: string): CleanupSuggestion {
  return { id, ruleId: `preset-${id}`, label, pattern, regex, scope: '*', example };
}

/** Junk seen across many sites. Each is narrow enough not to catch story text. */
export const COMMON_JUNK: readonly CleanupSuggestion[] = [
  common('read-at', 'Read at …', String.raw`^\W*read (?:\w+ ){0,3}(?:at|on) \S+\.[a-z]{2,}`, true, 'Read at novelsite.com for the fastest updates'),
  common('translator', 'Translator:', 'Translator:', false, 'Translator: Mira · Editor: Kael'),
  common('patreon', 'Support us on Patreon', String.raw`support (?:us|me|the \w+) on patreon`, true, 'Support us on Patreon for 10 advance chapters!'),
  common('visit', 'Visit … for the latest chapters', String.raw`visit \S+ for (?:the )?(?:latest|newest|fastest)`, true, 'Visit novelsite.com for the latest chapters'),
  common(
    'webnovel',
    'Find authorized novels in Webnovel…',
    String.raw`find authori[sz]ed novels in webnovel`,
    true,
    'Find authorized novels in Webnovel, faster updates, better experience. Please click www.webnovel.com for visiting.',
  ),
  common(
    'stolen',
    'Stolen-from-Royal-Road notices',
    String.raw`(?:stolen|unlawfully|pilfered|misappropriated|without (?:the )?(?:author'?s )?(?:permission|consent)).{0,80}royal ?road|royal ?road.{0,80}(?:on amazon|report (?:it|this|any))`,
    true,
    'This tale has been unlawfully lifted from Royal Road; report any instances of this story if found elsewhere.',
  ),
];

/** "https://www.stonescape.xyz/x" → { host: 'stonescape.xyz', name: 'stonescape' }; null if there's no usable domain. */
export function siteDomain(site: string): { host: string; name: string } | null {
  const host = (site.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/:?#]/)[0] ?? '').toLowerCase();
  const labels = host.split('.').filter(Boolean);
  const name = labels.at(-2);
  const tld = labels.at(-1);
  if (!name || !tld || !/^[a-z0-9-]{3,}$/.test(name) || !/^[a-z]{2,}$/.test(tld)) return null;
  return { host: `${name}.${tld}`, name };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Endings novel sites use. Not "me", "us", "co": after a sentence-ending word they'd be words too. */
const TLDS = ['com', 'net', 'org', 'xyz', 'io', 'cc', 'info', 'online', 'site', 'club', 'ws', 'tv'];

/** Hides lines naming the source's own site ("stonescape.xyz", "Stonescape . com"), in that source only. */
export function siteSuggestion(source: Pick<SourceInfo, 'id' | 'site'>): CleanupSuggestion | null {
  const d = siteDomain(source.site);
  if (!d) return null;
  return {
    id: `site-${source.id}`,
    ruleId: `site-${source.id}`,
    label: `Mentions of ${d.host}`,
    // Real TLDs only after the dot: a site name can be a word ("…across the stonescape. Nothing grew").
    pattern: String.raw`\b${escapeRe(d.name)}\s*\.\s*(?:${[...new Set([...TLDS, d.host.slice(d.name.length + 1)])].join('|')})\b`,
    regex: true,
    scope: source.id,
    example: `More chapters at ${d.host}!`,
  };
}

function sameRule(r: Pick<CleanupRule, 'id' | 'pattern' | 'regex' | 'scope'>, s: CleanupSuggestion): boolean {
  return r.id === s.ruleId || (r.pattern === s.pattern && r.regex === s.regex && (s.scope === '*' || r.scope === s.scope));
}

/** The suggestion a rule came from (or matches), for its title. */
export function suggestionFor(rule: Pick<CleanupRule, 'id' | 'pattern' | 'regex' | 'scope'>, sources: readonly Pick<SourceInfo, 'id' | 'site'>[]): CleanupSuggestion | undefined {
  return COMMON_JUNK.find((s) => sameRule(rule, s)) ?? sources.map(siteSuggestion).find((s): s is CleanupSuggestion => s !== null && sameRule(rule, s));
}

/**
 * What to offer: one site rule per enabled source (most recently used first), and the common junk,
 * both without anything already in the rules.
 */
export function suggestions(
  sources: readonly Pick<SourceInfo, 'id' | 'site' | 'enabled' | 'lastUsedAt'>[],
  rules: readonly Pick<CleanupRule, 'id' | 'pattern' | 'regex' | 'scope'>[],
): { forSources: CleanupSuggestion[]; common: CleanupSuggestion[] } {
  const fresh = (s: CleanupSuggestion): boolean => !rules.some((r) => sameRule(r, s));
  const forSources: CleanupSuggestion[] = [];
  const seen = new Set<string>();
  for (const src of [...sources].filter((s) => s.enabled).sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))) {
    const s = siteSuggestion(src);
    // Two sources on one domain name: offered one at a time (the next shows once the first is on).
    if (s && fresh(s) && !seen.has(s.pattern)) {
      seen.add(s.pattern);
      forSources.push(s);
    }
  }
  return { forSources, common: COMMON_JUNK.filter(fresh) };
}

export function ruleFrom(s: CleanupSuggestion, enabled: boolean): CleanupRule {
  return { id: s.ruleId, pattern: s.pattern, regex: s.regex, scope: s.scope, enabled };
}
