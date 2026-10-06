/** Promise helpers that need no timers (Scriptable has no setTimeout; timing goes through Platform.sleep). */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Counting semaphore. */
export class Limiter {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      this.waiters.push(() => resolve(this.releaser()));
    });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/** One Limiter per key (e.g. per host), created on demand and dropped when idle. */
export class KeyedLimiter {
  private readonly limiters = new Map<string, Limiter>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  async acquire(key: string): Promise<() => void> {
    let l = this.limiters.get(key);
    if (!l) {
      l = new Limiter(this.max);
      this.limiters.set(key, l);
    }
    const limiter = l;
    const release = await limiter.acquire();
    return () => {
      release();
      if (limiter.running === 0 && limiter.queued === 0) this.limiters.delete(key);
    };
  }

  running(key: string): number {
    return this.limiters.get(key)?.running ?? 0;
  }
}

/** Interactive work (what the user is waiting for) vs background work (update checks, read-ahead, downloads). */
export type Lane = 'interactive' | 'background';

/**
 * Per-key limiter with two lanes. At most `max` holders per key, of which at most `maxBackground`
 * background ones; waiting interactive requests are always served before waiting background ones.
 * So background work can never occupy more than `maxBackground` slots and never delays an interactive
 * request by more than the slots interactive requests themselves use.
 */
export class LaneLimiter {
  private readonly max: number;
  private readonly maxBackground: number;
  private readonly keys = new Map<string, { interactive: number; background: number; waiting: Record<Lane, (() => void)[]> }>();

  constructor(max: number, maxBackground: number) {
    this.max = Math.max(1, max);
    this.maxBackground = Math.max(1, Math.min(maxBackground, this.max));
  }

  /** Holders per lane for a key (tests/diagnostics). */
  active(key: string): { interactive: number; background: number } {
    const k = this.keys.get(key);
    return { interactive: k?.interactive ?? 0, background: k?.background ?? 0 };
  }

  acquire(key: string, lane: Lane): Promise<() => void> {
    let k = this.keys.get(key);
    if (!k) {
      k = { interactive: 0, background: 0, waiting: { interactive: [], background: [] } };
      this.keys.set(key, k);
    }
    const state = k;
    return new Promise((resolve) => {
      state.waiting[lane].push(() => resolve(this.releaser(key, lane)));
      this.pump(key);
    });
  }

  private canRun(k: { interactive: number; background: number }, lane: Lane): boolean {
    if (k.interactive + k.background >= this.max) return false;
    return lane === 'interactive' || k.background < this.maxBackground;
  }

  private pump(key: string): void {
    const k = this.keys.get(key);
    if (!k) return;
    for (;;) {
      if (k.waiting.interactive.length > 0 && this.canRun(k, 'interactive')) {
        k.interactive++;
        k.waiting.interactive.shift()?.();
      } else if (k.waiting.interactive.length === 0 && k.waiting.background.length > 0 && this.canRun(k, 'background')) {
        k.background++;
        k.waiting.background.shift()?.();
      } else {
        break;
      }
    }
    if (k.interactive + k.background === 0 && k.waiting.interactive.length === 0 && k.waiting.background.length === 0) this.keys.delete(key);
  }

  private releaser(key: string, lane: Lane): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const k = this.keys.get(key);
      if (!k) return;
      k[lane]--;
      this.pump(key);
    };
  }
}

/** Map with bounded concurrency; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < n; w++) {
    workers.push(
      (async () => {
        while (next < items.length) {
          const i = next++;
          results[i] = await fn(items[i] as T, i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

/** Collapse concurrent calls with the same key into one in-flight promise. */
export class Inflight<T> {
  private readonly map = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.map.get(key);
    if (existing) return existing;
    const p = fn().finally(() => {
      if (this.map.get(key) === p) this.map.delete(key);
    });
    this.map.set(key, p);
    return p;
  }

  get(key: string): Promise<T> | undefined {
    return this.map.get(key);
  }

  get size(): number {
    return this.map.size;
  }
}
