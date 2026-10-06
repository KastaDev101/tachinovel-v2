/**
 * Pool of hidden WebViews per site origin for browserFetch (platform/scriptable.ts), generic over the
 * view type so it is testable in Node. At most `max` views are kept (least recently used idle ones are
 * dropped first); concurrency is bounded by the net layer, not here.
 *
 * Two kinds of use:
 * - navigate (GET): exclusive. Loads a URL in a view, which wipes the page, so it only takes a pooled
 *   view of the origin that is idle (no navigation, no in-page work). If none is idle it uses a fresh
 *   view and adopts it afterwards when there is room. A failed navigation never returns its view.
 * - inPage (POST): shared. Runs in-page work (several at once) on a pooled view that is still on the
 *   origin; waits for a navigation in progress on it; opens the origin's root in a new view if the
 *   origin has none.
 */

export interface ViewPoolDeps<V> {
  max: number;
  create(): V;
  /** True if the view's page is still on `origin` (checked before in-page reuse). */
  isOn(view: V, origin: string): Promise<boolean>;
  /** Load the origin's root in a fresh view and wait past challenge pages (throws on timeout). */
  open(view: V, origin: string, deadline: number): Promise<void>;
  now(): number;
  timedOut(): Error;
}

interface Entry<V> {
  origin: string;
  view: V;
  /** Set while a navigation (GET) owns the view. */
  nav: Promise<void> | null;
  /** In-page users (POSTs) currently on the view, including ones checking it. */
  users: number;
  lastUsed: number;
}

export interface ViewPool<V> {
  navigate<T>(origin: string, fn: (view: V) => Promise<T>): Promise<T>;
  inPage<T>(origin: string, deadline: number, fn: (view: V) => Promise<T>): Promise<T>;
  readonly size: number;
  /** Views per origin (diagnostics/tests). */
  origins(): string[];
}

export function createViewPool<V>(deps: ViewPoolDeps<V>): ViewPool<V> {
  const entries: Entry<V>[] = [];
  const opening = new Map<string, Promise<Entry<V>>>();
  let tick = 0;

  const touch = (e: Entry<V>): void => {
    e.lastUsed = ++tick;
  };
  const idle = (e: Entry<V>): boolean => e.nav === null && e.users === 0;
  const remove = (e: Entry<V>): void => {
    const i = entries.indexOf(e);
    if (i >= 0) entries.splice(i, 1);
  };

  /** Room for one more: drop the least recently used idle view if full. False if everything is busy. */
  function makeRoom(): boolean {
    if (entries.length < deps.max) return true;
    let victim: Entry<V> | null = null;
    for (const e of entries) if (idle(e) && (!victim || e.lastUsed < victim.lastUsed)) victim = e;
    if (!victim) return false;
    remove(victim);
    return true;
  }

  function adopt(origin: string, view: V): Entry<V> | null {
    if (!makeRoom()) return null;
    const e: Entry<V> = { origin, view, nav: null, users: 0, lastUsed: 0 };
    touch(e);
    entries.push(e);
    return e;
  }

  async function navigate<T>(origin: string, fn: (view: V) => Promise<T>): Promise<T> {
    const pooled = entries.filter((e) => e.origin === origin && idle(e)).sort((a, b) => b.lastUsed - a.lastUsed)[0];
    if (!pooled) {
      const view = deps.create();
      const result = await fn(view); // a failed navigation is not adopted
      adopt(origin, view);
      return result;
    }
    let release!: () => void;
    pooled.nav = new Promise<void>((resolve) => {
      release = resolve;
    });
    touch(pooled);
    try {
      return await fn(pooled.view);
    } catch (err) {
      remove(pooled); // unknown state (e.g. stuck on a challenge): never reuse
      throw err;
    } finally {
      pooled.nav = null;
      release();
    }
  }

  async function openFor(origin: string, deadline: number): Promise<Entry<V>> {
    let p = opening.get(origin);
    if (!p) {
      p = (async () => {
        const view = deps.create();
        await deps.open(view, origin, deadline);
        return adopt(origin, view) ?? { origin, view, nav: null, users: 0, lastUsed: 0 }; // full: use it once, unpooled
      })().finally(() => opening.delete(origin));
      opening.set(origin, p);
    }
    return p;
  }

  async function inPage<T>(origin: string, deadline: number, fn: (view: V) => Promise<T>): Promise<T> {
    for (;;) {
      if (deps.now() > deadline) throw deps.timedOut();
      const mine = entries.filter((e) => e.origin === origin).sort((a, b) => b.lastUsed - a.lastUsed);
      const free = mine.find((e) => e.nav === null);
      if (free) {
        free.users++; // reserve before the async check, so a GET can't take it meanwhile
        const ok = await deps.isOn(free.view, origin).catch(() => false);
        if (!ok) {
          free.users--;
          if (free.users === 0 && free.nav === null) remove(free);
          continue;
        }
        touch(free);
        try {
          return await fn(free.view);
        } finally {
          free.users--;
        }
      }
      const busy = mine.find((e) => e.nav !== null);
      if (busy?.nav) {
        await busy.nav;
        continue;
      }
      const e = await openFor(origin, deadline);
      if (!entries.includes(e)) {
        // Pool full of busy views: run on the fresh view once without keeping it.
        return fn(e.view);
      }
    }
  }

  return {
    navigate,
    inPage,
    get size() {
      return entries.length;
    },
    origins: () => entries.map((e) => e.origin),
  };
}
