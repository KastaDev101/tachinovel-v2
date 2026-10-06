/**
 * setTimeout/clearTimeout/setInterval/clearInterval built on an injected `sleep(ms)` (Scriptable has
 * no timers in the script context; the platform implements sleep with its `Timer`).
 * String callbacks (implied eval) are not supported.
 */

export interface Timers {
  setTimeout(cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): number;
  clearTimeout(id?: number): void;
  setInterval(cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): number;
  clearInterval(id?: number): void;
}

export function createTimers(sleep: (ms: number) => Promise<void>, onError?: (err: unknown) => void): Timers {
  let nextId = 1;
  const active = new Set<number>();

  function run(cb: (...args: unknown[]) => void, args: unknown[]): void {
    try {
      cb(...args);
    } catch (err) {
      onError?.(err);
    }
  }

  function delay(ms: number | undefined): number {
    const n = Number(ms);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  return {
    setTimeout(cb, ms, ...args) {
      if (typeof cb !== 'function') throw new TypeError('setTimeout: callback must be a function');
      const id = nextId++;
      active.add(id);
      void sleep(delay(ms)).then(() => {
        if (!active.delete(id)) return;
        run(cb, args);
      });
      return id;
    },
    clearTimeout(id) {
      if (id !== undefined) active.delete(id);
    },
    setInterval(cb, ms, ...args) {
      if (typeof cb !== 'function') throw new TypeError('setInterval: callback must be a function');
      const id = nextId++;
      active.add(id);
      const d = Math.max(delay(ms), 1);
      const tick = (): void => {
        void sleep(d).then(() => {
          if (!active.has(id)) return;
          run(cb, args);
          tick();
        });
      };
      tick();
      return id;
    },
    clearInterval(id) {
      if (id !== undefined) active.delete(id);
    },
  };
}
