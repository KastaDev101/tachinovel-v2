/**
 * Per-plugin runtime context shared by the shim libs (@libs/fetch, @libs/storage, …) and the adapter.
 * The plugin's id and site are only known after its code has run, so they are bound late; storage
 * used while the plugin is being constructed goes to a scratch store that is merged in on bind.
 *
 * It also tracks adapter calls (CallRecord): each request's outcome is attributed to the calls it
 * belongs to, so the adapter can map a plugin's own error (or an empty result) back to the real cause
 * (NETWORK, CLOUDFLARE, NOT_FOUND…) of that call, not of another one running at the same time.
 */
import type { PluginHostDeps, PluginKV, SourceError } from '../shared/contracts/plugin-host.ts';
import type { HttpResponse, LogLevel } from '../shared/contracts/platform.ts';
import type { Net } from './net.ts';

export function memoryKV(): PluginKV {
  const m = new Map<string, unknown>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => void m.set(k, v),
    delete: (k) => void m.delete(k),
    clearAll: () => m.clear(),
    getAllKeys: () => [...m.keys()],
  };
}

/**
 * One adapter call (popular, search, novel, chapter, parsePage) and what the network did for it.
 * Requests are attributed to calls when they start (see `PluginContext.attribute`), so concurrent
 * calls on one plugin (a search next to a read-ahead chapter fetch) don't inherit each other's errors.
 */
export interface CallRecord {
  readonly id: number;
  readonly what: string;
  /** Strings that identify this call's requests (the novel/chapter path, the search query). */
  readonly hints: readonly string[];
  /** First network failure attributed to this call. */
  failure?: SourceError;
  /** Status of the last response attributed to this call. */
  lastStatus?: number;
  /** At least one 2xx response was attributed to this call. */
  ok: boolean;
  /** Host whose response was a domain-parking / for-sale page (failure.ts isParkedPage). */
  parked?: string;
  /** Another site a request was redirected to (failure.ts crossSiteRedirect). */
  movedTo?: string;
  /** When set, 2xx text responses whose URL passes it are kept in `captured` (see enrich.ts). */
  capture?: (url: string) => boolean;
  captured?: { url: string; body: string }[];
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export class PluginContext {
  readonly deps: PluginHostDeps;
  readonly net: Net;
  #id: string | undefined;
  #site: string | undefined;
  #kv: PluginKV | undefined;
  #scratch: PluginKV | undefined;
  #calls = new Map<number, CallRecord>();
  #nextCall = 1;
  #sharedGets: Map<string, Promise<HttpResponse>> | undefined;
  #sharing = 0;

  constructor(deps: PluginHostDeps, net: Net, expectedId?: string) {
    this.deps = deps;
    this.net = net;
    if (expectedId) {
      this.#id = expectedId;
      this.#kv = deps.storageFor(expectedId);
    }
  }

  get id(): string {
    return this.#id ?? '(loading plugin)';
  }

  get site(): string | undefined {
    return this.#site;
  }

  /** Called once the plugin object exists. */
  bind(id: string, site: string): void {
    this.#site = site;
    if (this.#kv && this.#id === id) return;
    this.#id = id;
    this.#kv = this.deps.storageFor(id);
    const scratch = this.#scratch;
    if (scratch) {
      for (const k of scratch.getAllKeys()) this.#kv.set(k, scratch.get(k));
      this.#scratch = undefined;
    }
  }

  /** The plugin's key/value store (a scratch store until the id is known). */
  kv(): PluginKV {
    if (this.#kv) return this.#kv;
    return (this.#scratch ??= memoryKV());
  }

  log(level: LogLevel, message: string, data?: unknown): void {
    this.deps.log(level, message, data);
  }

  /**
   * While at least one share is open (a novel() flatten), identical GETs share one response: page
   * plugins often re-download the same novel page for every page/volume. Only 2xx responses are kept,
   * so retries after errors still go out. Returns the function that closes the share.
   */
  shareGets(): () => void {
    this.#sharing++;
    this.#sharedGets ??= new Map();
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      if (--this.#sharing === 0) this.#sharedGets = undefined;
    };
  }

  /** Runs a GET through the share when one is open (see shareGets), else directly. */
  sharedGet(key: string, run: () => Promise<HttpResponse>): Promise<HttpResponse> {
    const cache = this.#sharedGets;
    if (!cache) return run();
    const hit = cache.get(key);
    if (hit) return hit;
    const p = run();
    cache.set(key, p);
    p.then(
      (res) => {
        if (res.status < 200 || res.status >= 300) cache.delete(key);
      },
      () => cache.delete(key),
    );
    return p;
  }

  /** Starts tracking an adapter call; `end()` stops attributing new requests to it. */
  beginCall(what: string, hints: readonly string[], capture?: (url: string) => boolean): { record: CallRecord; end: () => void } {
    const record: CallRecord = { id: this.#nextCall++, what, hints: hints.filter((h) => h.length >= 2), ok: false };
    if (capture) {
      record.capture = capture;
      record.captured = [];
    }
    this.#calls.set(record.id, record);
    return { record, end: () => void this.#calls.delete(record.id) };
  }

  /**
   * The calls a request to `url`, starting now, belongs to: the only call in flight; else the calls
   * whose hints appear in the URL; else the calls without hints (popular); else all (ambiguous).
   */
  attribute(url: string): CallRecord[] {
    const active = [...this.#calls.values()];
    if (active.length <= 1) return active;
    const decoded = safeDecode(url);
    const matching = active.filter((c) => c.hints.some((h) => url.includes(h) || decoded.includes(h)));
    if (matching.length) return matching;
    const unhinted = active.filter((c) => c.hints.length === 0);
    return unhinted.length ? unhinted : active;
  }

  recordFailure(calls: readonly CallRecord[], err: SourceError): void {
    for (const c of calls) c.failure ??= err;
  }

  recordStatus(calls: readonly CallRecord[], status: number): void {
    for (const c of calls) {
      c.lastStatus = status;
      if (status >= 200 && status < 300) c.ok = true;
    }
  }

  recordParked(calls: readonly CallRecord[], host: string): void {
    for (const c of calls) c.parked ??= host;
  }

  recordMoved(calls: readonly CallRecord[], host: string): void {
    for (const c of calls) c.movedTo ??= host;
  }

  /** Keeps a 2xx text response for the calls that asked to capture it. */
  recordBody(calls: readonly CallRecord[], status: number, url: string, body: string): void {
    if (status < 200 || status >= 300) return;
    for (const c of calls) if (c.capture?.(url)) c.captured?.push({ url, body });
  }
}
