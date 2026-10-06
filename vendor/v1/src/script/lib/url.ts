/**
 * Minimal URL helpers (no URL global in Scriptable's JavaScriptCore). Only what the script core
 * needs: host extraction for per-host limits, origin, and file extensions.
 */

const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i;

/** Lower-cased host (with port), or '' if the string is not an absolute URL. */
export function hostOf(url: string): string {
  const m = URL_RE.exec(url);
  if (!m) return '';
  const authority = (m[2] as string).replace(/^[^@]*@/, '');
  return authority.toLowerCase();
}

export function originOf(url: string): string {
  const m = URL_RE.exec(url);
  if (!m) return '';
  return `${(m[1] as string).toLowerCase()}://${hostOf(url)}`;
}

/** Path part without query/fragment ('' if none). */
export function pathOf(url: string): string {
  const m = URL_RE.exec(url);
  return m ? (m[3] as string) : '';
}

/** Lower-case extension of the URL path's last segment, without dot ('' if none). */
export function extensionOf(url: string): string {
  const p = pathOf(url);
  const last = p.slice(p.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return '';
  const ext = last.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

/** Readable name for a repo index URL: "owner/repo" for GitHub-hosted files, otherwise the host. */
export function repoNameOf(url: string): string {
  const host = hostOf(url);
  const parts = pathOf(url).split('/').filter(Boolean);
  if ((host === 'raw.githubusercontent.com' || host === 'github.com') && parts.length >= 2) {
    return `${parts[0] as string}/${parts[1] as string}`;
  }
  return host || url;
}
