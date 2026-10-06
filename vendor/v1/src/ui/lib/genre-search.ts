/**
 * Genre search plumbing (pure; unit-tested): a request limiter shared by every per-source call and a
 * per-session cache of each source's filter definitions.
 */
import type { Filters } from '../../shared/lnreader/filters.ts';

export interface Limiter {
  /** Runs `fn` once fewer than `limit` limited calls are running (first come, first served). */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Calls running right now. */
  readonly active: number;
}

export function createLimiter(limit: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = (): void => {
    if (active >= limit) return;
    const start = queue.shift();
    if (start) start();
  };
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          active++;
          let p: Promise<T>;
          try {
            p = fn();
          } catch (err) {
            p = Promise.reject(err instanceof Error ? err : new Error(String(err)));
          }
          void p.then(resolve, reject).finally(() => {
            active--;
            next();
          });
        });
        next();
      });
    },
    get active() {
      return active;
    },
  };
}

export interface FiltersCache {
  /** The source's filters (one request per source and plugin version per session; failures are retried next time). */
  get(id: string, version: string): Promise<Filters | null>;
  /** Already loaded (no request needed)? */
  has(id: string, version: string): boolean;
}

export function createFiltersCache(load: (id: string) => Promise<Filters | null>): FiltersCache {
  const cache = new Map<string, Promise<Filters | null>>();
  const settled = new Set<string>();
  const keyOf = (id: string, version: string): string => `${id}@${version}`;
  return {
    get(id, version) {
      const key = keyOf(id, version);
      let p = cache.get(key);
      if (!p) {
        p = load(id).then(
          (f) => {
            settled.add(key);
            return f;
          },
          (err: unknown) => {
            cache.delete(key);
            throw err;
          },
        );
        cache.set(key, p);
      }
      return p;
    },
    has(id, version) {
      return settled.has(keyOf(id, version));
    },
  };
}
