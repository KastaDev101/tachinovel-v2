/**
 * v2 bridge transport (UI side). Build-time substitute for v1's src/ui/bridge/phone-client.ts: the
 * v2 build redirects v1's `import { createPhoneBridge } from './phone-client.ts'` here (tools/build.ts,
 * plugin "v1-phone-client"), so the v1 UI runs unchanged.
 *
 * Wire: the native `Core` Capacitor plugin (ios/App/App/Native/Core/CorePlugin.swift).
 *   Core.call({ json: RequestEnvelope JSON }) → { json: ResponseEnvelope JSON }
 *   Core listener "event": { event, payload: JSON string }
 * Calls run concurrently (no long-poll, no 50 ms tick): a small call costs one WKScriptMessage hop
 * plus a hop onto the core thread, typically a few ms.
 */
import { registerPlugin } from '@capacitor/core';
import {
  BridgeCallError,
  type BridgeClient,
  type BridgeEvents,
  type CallOptions,
  type EventName,
  type MethodName,
  type ResponseEnvelope,
} from '@v1/shared/contracts/protocol.ts';

export interface CoreTransport {
  call(requestJson: string): Promise<string>;
  onEvent(fn: (event: string, payloadJson: string) => void): void;
}

interface CorePluginApi {
  call(opts: { json: string }): Promise<{ json: string }>;
  addListener(eventName: 'event', fn: (data: { event: string; payload: string }) => void): Promise<{ remove: () => Promise<void> }>;
}

export function capacitorTransport(): CoreTransport {
  const Core = registerPlugin<CorePluginApi>('Core');
  return {
    call: (json) => Core.call({ json }).then((r) => r.json),
    onEvent(fn) {
      void Core.addListener('event', (d) => fn(d.event, d.payload));
    },
  };
}

export interface PhoneBridgeOptions {
  defaultTimeoutMs?: number;
  transport?: CoreTransport;
}

export function createBridgeClient(opts: PhoneBridgeOptions = {}): BridgeClient {
  const transport = opts.transport ?? capacitorTransport();
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let nextId = 1;

  transport.onEvent((event, payloadJson) => {
    const set = listeners.get(event);
    if (!set || set.size === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      return;
    }
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`bridge event handler for ${event} failed`, err);
      }
    }
  });

  const client = {
    call(method: MethodName, args?: unknown, callOpts?: CallOptions): Promise<unknown> {
      const id = nextId++;
      const timeoutMs = callOpts?.timeoutMs ?? defaultTimeoutMs;
      return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          reject(new BridgeCallError({ code: 'TIMEOUT', message: `${method} timed out after ${timeoutMs} ms`, retryable: true }));
        }, timeoutMs);
        transport
          .call(JSON.stringify({ kind: 'req', id, method, args: args ?? null }))
          .then((json) => {
            if (done) return; // timed out: stale response dropped (same rule as v1)
            done = true;
            clearTimeout(timer);
            const env = JSON.parse(json) as ResponseEnvelope;
            if (env.ok) resolve(env.result);
            else reject(new BridgeCallError(env.error));
          })
          .catch((err: unknown) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(new BridgeCallError({ code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err), retryable: true }));
          });
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

/** Observers of bridge traffic (ad pacing, narration overlay) — the v1 UI is not modified for them. */
type CallObserver = (method: string, args: unknown) => void;
const observers = new Set<CallObserver>();

export function observeCalls(fn: CallObserver): () => void {
  observers.add(fn);
  return () => observers.delete(fn);
}

let shared: BridgeClient | null = null;

/** The client v1's UI and v2's additions share (one listener registration, one id sequence). */
export function sharedClient(): BridgeClient {
  if (!shared) {
    const base = createBridgeClient();
    shared = {
      call: ((method: MethodName, args?: unknown, o?: CallOptions) => {
        for (const fn of observers) {
          try {
            fn(method, args);
          } catch {
            // observers never break calls
          }
        }
        return (base.call as (m: MethodName, a?: unknown, o?: CallOptions) => Promise<unknown>)(method, args, o);
      }) as BridgeClient['call'],
      on: base.on.bind(base),
    };
  }
  return shared;
}

/** Same name/signature as v1's phone-client export, so v1's bridge/client.ts uses this unchanged. */
export function createPhoneBridge(_opts: unknown = {}): BridgeClient {
  return sharedClient();
}

/**
 * Call a v2-only core method (src/core/core.ts V2Methods, e.g. narration.lexicon.get), which v1's typed
 * client doesn't know. Same transport, ids and observers as the v1 calls.
 */
export function callCore<T = unknown>(method: string, args?: unknown): Promise<T> {
  return (sharedClient().call as unknown as (m: string, a?: unknown) => Promise<T>)(method, args);
}
