/**
 * Deep-link validation (tachinovel://open?plugin=…&novel=…&chapter=…, from widgets, Shortcuts and
 * notifications, but also from any other app or web page). The core only follows links to installed
 * sources (v1's app.deliverDeepLink); this also keeps the paths from pointing the source anywhere else:
 * paths are site-relative ("novel/alpha") or, for plugins that store full URLs, absolute URLs on the
 * source's own site. Pure, so it is unit-tested (tests/security.test.ts).
 */

export const MAX_DEEP_LINK_PATH = 2048;

const AUTHORITY = /^(?:([a-z][a-z0-9+.-]*):)?\/\/([^/?#]*)/i;

/** Lower-cased host of an absolute or scheme-relative URL, without port; null if it has none. */
function hostOf(url: string): { scheme: string | undefined; host: string; userinfo: boolean } | null {
  const m = AUTHORITY.exec(url);
  if (!m) return null;
  const authority = m[2] ?? '';
  const userinfo = authority.includes('@');
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const host = (hostPort.startsWith('[') ? hostPort.slice(0, hostPort.indexOf(']') + 1) : hostPort.split(':')[0] ?? '').toLowerCase();
  return { scheme: m[1]?.toLowerCase(), host, userinfo };
}

/** Why a deep-link path is refused, or null when it is fine. */
export function pathProblem(path: string, site: string | undefined): string | null {
  if (path.length === 0) return 'empty path';
  if (path.length > MAX_DEEP_LINK_PATH) return 'path too long';
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return 'invalid characters in path'; // controls, backslash
  }
  const target = hostOf(path);
  if (!target) return null; // site-relative
  if (target.userinfo) return 'credentials in URL';
  if (target.scheme !== undefined && target.scheme !== 'http' && target.scheme !== 'https') return 'not an http(s) URL';
  const own = site ? hostOf(site) : null;
  if (!own || !target.host || target.host !== own.host) return "URL is not on the source's site";
  return null;
}

/** Validates both paths of a deep link against the installed source's site. */
export function deepLinkProblem(link: { novelPath: string; chapterPath?: string }, site: string | undefined): string | null {
  const novel = pathProblem(link.novelPath, site);
  if (novel) return `novel: ${novel}`;
  if (link.chapterPath !== undefined) {
    const chapter = pathProblem(link.chapterPath, site);
    if (chapter) return `chapter: ${chapter}`;
  }
  return null;
}
