/**
 * Script side of the bridge (wire format: src/shared/contracts/protocol.ts; UI side:
 * src/ui/bridge/phone-client.ts). Transport-agnostic: anything that can evaluate JS in the UI.
 *
 * Phone facts (CP0, iOS 26.6.1): `completion` is lexical inside the evaluated code (not a global), and
 * Scriptable SERIALIZES evaluateJavaScript (nothing else runs while a callback evaluation is pending),
 * so piggybacking is the only delivery mode:
 *
 *   loop: raw = await evaluate('__bridge.next(<json-string>, completion)', true)
 *         - the argument carries queued responses/events, the completion value is a JSON array of requests
 *         - requests are dispatched concurrently; results/events go to the outbox for the next poll
 *
 * The UI completes every poll within ~50 ms while it has calls pending and ~1 s when idle. After a batch
 * is dispatched the server waits up to `settleWindowMs` for it to settle, so fast results ride on the
 * very next poll. Every evaluation is raced against `closed` (evaluations never resolve after the view
 * is dismissed). Only strings cross the bridge (plain-object return values can fail on the phone).
 * Strings are always double-encoded: JSON.stringify(jsonText) is a valid JS string literal.
 * Envelopes are serialized once, when queued, so one bad result can't poison a batch.
 *
 * Crash-proofing: nothing a handler does (throw synchronously, reject with a non-Error or a hostile
 * object, return a non-promise, never settle) and no failure in logging/telemetry can end the poll
 * loop or cost a call its response. Only dismissal, stop() or repeated poll failures end it.
 */
import type { LogLevel } from '../../shared/contracts/platform.ts';
import type { BridgeError, BridgeEvents, EventName, RequestEnvelope, ResponseEnvelope } from '../../shared/contracts/protocol.ts';
import { AppError, errorMessage, toBridgeError } from '../lib/errors.ts';
import { isRecord } from '../lib/validate.ts';
import { SLOW_CALL_MS, SessionRecorder, type SessionSummary, summarizeArgs } from './session.ts';

export interface BridgeTransport {
  /** Evaluate JS in the UI. With `useCallback`, resolves with the value passed to `completion(...)`. */
  evaluate(js: string, useCallback: boolean): Promise<unknown>;
}

/** MethodHandlers is assignable to this; tests may pass a subset. */
export type HandlerTable = { readonly [method: string]: ((args: never) => Promise<unknown>) | undefined };

export interface BridgeServerOptions {
  transport: BridgeTransport;
  handlers: HandlerTable;
  /** Resolves when the WebView is dismissed. */
  closed?: Promise<unknown>;
  sleep(ms: number): Promise<void>;
  now?(): number;
  log?(level: LogLevel, message: string, data?: unknown): void;
  /** Consecutive failed polls before giving up (e.g. the page never defines __bridge). Default 20. */
  maxConsecutiveFailures?: number;
  /** Calls slower than this are logged right away (warn). Default 1500 ms. */
  slowCallMs?: number;
  /**
   * After dispatching a batch, wait up to this long for it to settle before the next poll, so fast
   * results (most handlers finish within microtasks) ride on the very next poll instead of a later one.
   * Default 10 ms.
   */
  settleWindowMs?: number;
}

export interface BridgeStats {
  polls: number;
  requests: number;
  responses: number;
  events: number;
  failures: number;
  inFlight: number;
}

export interface BridgeTimeline {
  /** When the first poll was sent. */
  firstPollAt?: number;
  /** When the poll carrying the first app.boot result was sent to the UI. */
  bootServedAt?: number;
}

export interface BridgeServer {
  /** Long-poll loop; resolves when closed/stopped. */
  run(): Promise<void>;
  emit<E extends EventName>(event: E, payload: BridgeEvents[E]): void;
  stop(): void;
  readonly stats: Readonly<BridgeStats>;
  readonly stopped: boolean;
  readonly timeline: Readonly<BridgeTimeline>;
  /** Per-method counts/durations, slowest calls and errors of this session (memory only). */
  summary(): SessionSummary;
}

const CLOSED: unique symbol = Symbol('closed');

function safeMessage(err: unknown): string {
  try {
    return errorMessage(err);
  } catch {
    return 'Unknown error';
  }
}

/** An Error for anything thrown (instanceof itself can throw on a hostile proxy). */
function asError(err: unknown): Error {
  try {
    return err instanceof Error ? err : new Error(errorMessage(err));
  } catch {
    return new Error('Unknown error');
  }
}

/** toBridgeError for anything at all (objects with throwing getters, proxies, null, …). */
function safeBridgeError(err: unknown): BridgeError {
  try {
    return toBridgeError(err);
  } catch {
    return { code: 'UNKNOWN', message: safeMessage(err), retryable: false };
  }
}
type Closed = typeof CLOSED;

/** The long-poll expression: deliveries double-encoded, `completion` passed lexically. */
export function nextCall(deliveriesJson: string): string {
  return `__bridge.next(${JSON.stringify(deliveriesJson)}, completion)`;
}

function parseRequests(raw: unknown, log: (level: LogLevel, message: string) => void): RequestEnvelope[] {
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw !== 'string') {
    log('error', 'bridge: poll result is not a string');
    return [];
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    log('error', 'bridge: unparseable poll result');
    return [];
  }
  if (!Array.isArray(v)) {
    log('error', 'bridge: poll result is not an array');
    return [];
  }
  const out: RequestEnvelope[] = [];
  for (const item of v) {
    if (isRecord(item) && typeof item.id === 'number' && Number.isFinite(item.id)) {
      out.push({ kind: 'req', id: item.id, method: typeof item.method === 'string' ? item.method : '', args: item.args });
    } else {
      log('warn', 'bridge: dropped malformed request envelope');
    }
  }
  return out;
}

export function createBridgeServer(opts: BridgeServerOptions): BridgeServer {
  const log = (level: LogLevel, message: string, data?: unknown): void => {
    try {
      opts.log?.(level, message, data);
    } catch {
      // Logging must never take the bridge down.
    }
  };
  const now = (): number => opts.now?.() ?? 0;
  const maxFailures = opts.maxConsecutiveFailures ?? 20;
  const slowCallMs = opts.slowCallMs ?? SLOW_CALL_MS;
  const recorder = new SessionRecorder(now());
  const timeline: BridgeTimeline = {};
  let bootQueued = false;
  const settleWindowMs = opts.settleWindowMs ?? 10;
  const outbox: string[] = [];
  const stats: BridgeStats = { polls: 0, requests: 0, responses: 0, events: 0, failures: 0, inFlight: 0 };
  let stopped = false;
  /** Resolves the wait in progress when the server stops (one at a time: the loop is sequential). */
  let abortCurrent: ((v: Closed) => void) | null = null;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    abortCurrent?.(CLOSED);
    abortCurrent = null;
  }
  // A single listener on the long-lived `closed` promise (never re-subscribed per poll: that would
  // retain a reaction per iteration until the view closes).
  if (opts.closed) void opts.closed.then(stop, stop);

  /** Every evaluation/wait races the view's dismissal (evaluations never resolve after it). */
  function race<T>(p: Promise<T>): Promise<Awaited<T> | Closed> {
    if (stopped) return Promise.resolve(CLOSED);
    const abort = new Promise<Closed>((resolve) => {
      abortCurrent = resolve;
    });
    return Promise.race([p, abort]).finally(() => {
      abortCurrent = null;
    });
  }

  function respond(env: ResponseEnvelope): void {
    let json: string;
    try {
      json = JSON.stringify(env);
    } catch (err) {
      json = JSON.stringify({ kind: 'res', id: env.id, ok: false, error: { code: 'UNKNOWN', message: `Unserializable result: ${errorMessage(err)}`, retryable: false } });
    }
    stats.responses++;
    outbox.push(json);
  }

  /** Bookkeeping that must never cost a call its response. */
  function quietly(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log('error', `bridge: bookkeeping failed: ${safeMessage(err)}`);
    }
  }

  function settle(req: RequestEnvelope, started: number, ok: boolean, value: unknown): void {
    stats.inFlight--;
    const at = now();
    const ms = at - started;
    if (ok) {
      quietly(() => {
        recorder.record(req.method, ms, req.args, null, at);
        if (ms > slowCallMs) log('warn', `bridge: ${req.method} slow: ${ms} ms (${summarizeArgs(req.args)})`);
        if (req.method === 'app.boot' && timeline.bootServedAt === undefined) bootQueued = true;
      });
      respond({ kind: 'res', id: req.id, ok: true, result: value });
      return;
    }
    const error = safeBridgeError(value);
    quietly(() => {
      recorder.record(req.method, ms, req.args, error, at);
      log('warn', `bridge: ${req.method} failed after ${ms} ms: ${error.code} ${error.message} (${summarizeArgs(req.args)})`);
    });
    respond({ kind: 'res', id: req.id, ok: false, error });
  }

  /** Starts the handler; resolves (never rejects) once its response is queued. */
  function dispatch(req: RequestEnvelope): Promise<void> {
    stats.requests++;
    stats.inFlight++;
    const started = now();
    const handler = Object.hasOwn(opts.handlers, req.method) ? opts.handlers[req.method] : undefined;
    let p: unknown;
    if (typeof handler !== 'function') {
      p = Promise.reject(new AppError('UNKNOWN_METHOD', `Unknown method: ${req.method || '(none)'}`));
    } else {
      try {
        p = (handler as (args: unknown) => unknown)(req.args);
      } catch (err) {
        p = Promise.reject(asError(err));
      }
    }
    // Promise.resolve also adopts plain values and odd thenables (a throwing `then` becomes a rejection).
    return Promise.resolve(p).then(
      (result) => settle(req, started, true, result),
      (err: unknown) => settle(req, started, false, err),
    );
  }

  async function run(): Promise<void> {
    let failures = 0;
    while (!stopped) {
      const items = outbox.splice(0, outbox.length);
      let raw: unknown;
      try {
        stats.polls++;
        const sentAt = now();
        timeline.firstPollAt ??= sentAt;
        if (bootQueued && items.length > 0) {
          bootQueued = false;
          timeline.bootServedAt = sentAt;
        }
        const r = await race(opts.transport.evaluate(nextCall(items.length > 0 ? `[${items.join(',')}]` : ''), true));
        if (r === CLOSED) break;
        raw = r;
        failures = 0;
      } catch (err) {
        // The page may not be ready yet (no __bridge) or the evaluation failed: re-queue and back off.
        outbox.unshift(...items);
        failures++;
        stats.failures++;
        log(failures === 1 ? 'warn' : 'debug', `bridge: poll failed (${failures}/${maxFailures}): ${errorMessage(err)}`);
        if (failures >= maxFailures) {
          log('error', 'bridge: giving up after repeated poll failures');
          stop();
          break;
        }
        const r = await race(opts.sleep(Math.min(1000, 50 * 2 ** (failures - 1))));
        if (r === CLOSED) break;
        continue;
      }
      try {
        const requests = parseRequests(raw, log);
        if (requests.length > 0) {
          const settled = Promise.all(requests.map(dispatch));
          const r = await race(Promise.race([settled, opts.sleep(settleWindowMs)]));
          if (r === CLOSED) break;
        }
      } catch (err) {
        // A bug on this side of the bridge: keep serving (the UI's calls time out rather than hang forever).
        log('error', `bridge: dispatch failed: ${safeMessage(err)}`);
      }
    }
    stop();
  }

  return {
    run,
    emit(event, payload) {
      if (stopped) return;
      let json: string;
      try {
        json = JSON.stringify({ kind: 'evt', event, payload });
      } catch (err) {
        log('error', `bridge: unserializable ${event} event: ${errorMessage(err)}`);
        return;
      }
      stats.events++;
      outbox.push(json);
    },
    stop,
    stats,
    get stopped() {
      return stopped;
    },
    timeline,
    summary: () => recorder.summary(now()),
  };
}
