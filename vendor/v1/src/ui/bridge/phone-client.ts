/**
 * UI side of the phone bridge transport (see wire format in src/shared/contracts/protocol.ts).
 * Owned by the coordinator. The UI agent uses `createPhoneBridge()` on the phone and its own
 * mock client (same BridgeClient interface) for dev and tests.
 *
 * Facts measured on the phone (CP0, iOS 26.6.1, Scriptable):
 * - `completion` is NOT a global. It only exists lexically inside the code passed to
 *   evaluateJavaScript(code, true), so the script must pass it in: `__bridge.next(json, completion)`.
 * - Scriptable serializes evaluations: while a callback evaluation is pending, every other
 *   evaluateJavaScript call waits. So the long-poll must always complete within a bounded time,
 *   and results/events travel only as piggybacked deliveries on the next poll.
 */
import {
  BridgeCallError,
  type BridgeClient,
  type BridgeEvents,
  type CallOptions,
  type EventName,
  type MethodName,
  type MethodResult,
  type RequestEnvelope,
  type ToUiEnvelope,
} from '../../shared/contracts/protocol.ts';

type Completion = (value: unknown) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
}

export interface PhoneBridgeOptions {
  /** Hold time for a poll while calls are awaiting results (the script piggybacks results on the next poll). */
  pendingTickMs?: number;
  /** Max hold time for a poll when nothing is pending, so script-pushed events still flow. */
  idleHoldMs?: number;
  defaultTimeoutMs?: number;
}

export interface BridgeGlobal {
  /** Called by the script as `__bridge.next(<deliveries JSON string or "">, completion)`. */
  next(deliveriesJson?: string, done?: Completion): void;
  /** Direct push (only usable where concurrent evaluation works; not on Scriptable). */
  deliver(envelopesJson: string): void;
}

declare global {
  interface Window {
    __bridge?: BridgeGlobal;
  }
}

export function createPhoneBridge(opts: PhoneBridgeOptions = {}): BridgeClient {
  const pendingTickMs = opts.pendingTickMs ?? 50;
  const idleHoldMs = opts.idleHoldMs ?? 1000;
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  const queue: RequestEnvelope[] = [];
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let waiting: Completion | null = null;
  let holdTimer = 0;
  let holdUntil = 0;
  let nextId = 1;

  function clearHold(): void {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = 0;
    }
  }

  function complete(json: string): void {
    const done = waiting;
    waiting = null;
    clearHold();
    done?.(json);
  }

  /** Complete the waiting poll now if there is work, otherwise (re)arm its bounded hold timer. */
  function flush(): void {
    if (!waiting) return;
    if (queue.length > 0) {
      complete(JSON.stringify(queue.splice(0)));
      return;
    }
    const holdMs = pending.size > 0 ? pendingTickMs : idleHoldMs;
    const until = Date.now() + holdMs;
    if (holdTimer && until >= holdUntil) return; // an earlier deadline is already armed
    clearHold();
    holdUntil = until;
    holdTimer = window.setTimeout(() => {
      holdTimer = 0;
      if (waiting) complete('[]');
    }, holdMs);
  }

  function apply(envelopes: ToUiEnvelope[]): void {
    for (const env of envelopes) {
      if (env.kind === 'res') {
        const p = pending.get(env.id);
        if (!p) continue; // timed out or stale
        pending.delete(env.id);
        clearTimeout(p.timer);
        if (env.ok) p.resolve(env.result);
        else p.reject(new BridgeCallError(env.error));
      } else {
        const set = listeners.get(env.event);
        if (set) {
          for (const fn of set) {
            try {
              fn(env.payload);
            } catch (err) {
              console.error(`bridge event handler for ${env.event} failed`, err);
            }
          }
        }
      }
    }
  }

  window.__bridge = {
    next(deliveriesJson?: string, done?: Completion): void {
      // A newer poll supersedes an older one (shouldn't happen; Scriptable serializes evaluations).
      if (waiting) complete('[]');
      waiting = typeof done === 'function' ? done : null;
      if (deliveriesJson) apply(JSON.parse(deliveriesJson) as ToUiEnvelope[]);
      flush();
    },
    deliver(envelopesJson: string): void {
      apply(JSON.parse(envelopesJson) as ToUiEnvelope[]);
      flush();
    },
  };

  const client = {
    call(method: MethodName, args?: unknown, callOpts?: CallOptions): Promise<unknown> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeoutMs = callOpts?.timeoutMs ?? defaultTimeoutMs;
        const timer = window.setTimeout(() => {
          pending.delete(id);
          reject(new BridgeCallError({ code: 'TIMEOUT', message: `${method} timed out after ${timeoutMs} ms`, retryable: true }));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        queue.push({ kind: 'req', id, method, args });
        flush();
      });
    },
    on<E extends EventName>(event: E, fn: (payload: BridgeEvents[E]) => void): () => void {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const wrapped = fn as (payload: unknown) => void;
      set.add(wrapped);
      return () => set.delete(wrapped);
    },
  };
  return client as BridgeClient;
}

/** Narrow helper so callers get typed results without casting. */
export type Result<K extends MethodName> = MethodResult<K>;
