/**
 * Cover loading strategy (unit-tested with an injected fetcher).
 * Some sites (Stonescape) send Cross-Origin-Resource-Policy, so a direct <img> from the file:// page
 * fails. Then the script downloads the image (`covers.fetch`) and returns a local path to load.
 * - Direct URL first; once a host fails directly, its later covers go straight to covers.fetch.
 * - Per-URL results are remembered for the session (revisiting a screen never refetches).
 * - At most `maxInFlight` covers.fetch calls at once; a failure is final (placeholder, no retry loop).
 */

export type CoverFetcher = (pluginId: string, url: string) => Promise<string>;

export interface CoverLoader {
  /** What to show first: a known result, the direct URL, or null = must go through covers.fetch. */
  initial(url: string): { src: string | null; failed: boolean };
  /** A direct load failed: remember the host. */
  directFailed(url: string): void;
  /** Resolve through the script (deduplicated, concurrency-limited). null = gave up. */
  resolve(pluginId: string, url: string): Promise<string | null>;
  /** Whether covers.fetch can help for this URL (remote http(s) only). */
  canProxy(url: string): boolean;
}

export function hostOf(url: string): string | null {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  return m?.[1]?.toLowerCase() ?? null;
}

export function createCoverLoader(fetcher: CoverFetcher, opts: { maxInFlight?: number } = {}): CoverLoader {
  const maxInFlight = opts.maxInFlight ?? 6;
  const failedHosts = new Set<string>();
  const results = new Map<string, string | null>();
  const pending = new Map<string, Promise<string | null>>();
  const queue: (() => void)[] = [];
  let inFlight = 0;

  const pump = (): void => {
    while (inFlight < maxInFlight && queue.length > 0) {
      const job = queue.shift();
      if (job) {
        inFlight++;
        job();
      }
    }
  };

  return {
    initial(url) {
      const known = results.get(url);
      if (known !== undefined) return { src: known, failed: known === null };
      const host = hostOf(url);
      if (host && failedHosts.has(host)) return { src: null, failed: false };
      return { src: url, failed: false };
    },
    directFailed(url) {
      const host = hostOf(url);
      if (host) failedHosts.add(host);
    },
    canProxy(url) {
      return hostOf(url) !== null;
    },
    resolve(pluginId, url) {
      const known = results.get(url);
      if (known !== undefined) return Promise.resolve(known);
      const existing = pending.get(url);
      if (existing) return existing;
      const p = new Promise<string | null>((resolve) => {
        queue.push(() => {
          fetcher(pluginId, url)
            .then((src) => {
              results.set(url, src || null);
              resolve(src || null);
            })
            .catch(() => {
              results.set(url, null);
              resolve(null);
            })
            .finally(() => {
              inFlight--;
              pending.delete(url);
              pump();
            });
        });
        pump();
      });
      pending.set(url, p);
      return p;
    },
  };
}
