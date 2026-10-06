/**
 * Node implementation of the native host API (src/core/native-api.ts) + a JSC-like `vm` context, so
 * the BUILT core.js runs on the PC exactly as the iOS CoreHost would run it:
 *  - the context has only ECMAScript built-ins + Intl (like a bare JSContext: no console, timers,
 *    URL, TextEncoder, fetch, atob, structuredClone, queueMicrotask);
 *  - `__native` semantics mirror NativeHostAPI.swift: FileManager-like fs (write needs the parent
 *    folder, remove/list of missing paths throw, move onto an existing file throws), callbacks once.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { NativeCallback, NativeHost, NativeHttpRequest, NativeHttpResponse } from '../../src/core/native-api.ts';

export interface Route {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface MockOptions {
  /** Built www/ directory (core.js + lib/). */
  wwwDir: string;
  routes?: Record<string, Route | ((req: NativeHttpRequest) => Route)>;
  /** Answers for actionSheet/alert in order (default 0 = first action). */
  answers?: number[];
  syncedAvailable?: boolean;
  launchReason?: 'ui' | 'background-refresh' | 'narration';
  /** Called for every core event (the PC shell forwards them to the page like CorePlugin does). */
  onEmit?: (event: string, payloadJson: string) => void;
  /** Fault injection: make an fs operation throw (e.g. mkdirp of the local root → boot failure). */
  fsFault?: (op: string, absPath: string) => boolean;
  /** Don't evaluate core.js yet: calls made before `evaluate()` are queued like CoreHost does. */
  deferEvaluate?: boolean;
  /**
   * Document-picker answers, in order: an absolute source file (copied into the core's imports folder,
   * like UIDocumentPickerViewController(asCopy:) + NativeUI.documentPicker do) or null = cancelled.
   */
  picks?: (string | null)[];
}

export interface CoreHarness {
  readonly dir: string;
  readonly logs: { level: string; line: string }[];
  readonly events: { event: string; payload: unknown }[];
  readonly requests: NativeHttpRequest[];
  readonly context: vm.Context;
  call<T = unknown>(method: string, args?: unknown): Promise<T>;
  /** Raw response envelope. */
  callRaw(method: string, args?: unknown): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }>;
  /** RequestEnvelope JSON in, ResponseEnvelope JSON out (what CorePlugin.call does). */
  callJson(requestJson: string): Promise<string>;
  /** Local store root (…/local/TachiNovel). */
  readonly localAppDir: string;
  /** Evaluate core.js now (only with deferEvaluate). */
  evaluate(): void;
  dispose(): void;
}

function fsApi(fault?: (op: string, absPath: string) => boolean): NativeHost['fs'] {
  const api: NativeHost['fs'] = {
    readText: (p) => (existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf8') : null),
    writeText(p, text) {
      if (!existsSync(path.dirname(p))) throw new Error(`No such directory: ${path.dirname(p)}`);
      writeFileSync(p, text, 'utf8');
    },
    readBase64: (p) => (existsSync(p) && statSync(p).isFile() ? readFileSync(p).toString('base64') : null),
    writeBase64(p, b64) {
      if (!existsSync(path.dirname(p))) throw new Error(`No such directory: ${path.dirname(p)}`);
      writeFileSync(p, Buffer.from(b64, 'base64'));
    },
    exists: (p) => existsSync(p),
    isDirectory: (p) => existsSync(p) && statSync(p).isDirectory(),
    remove(p) {
      if (!existsSync(p)) throw new Error(`No such file: ${p}`);
      rmSync(p, { recursive: true, force: true });
    },
    move(from, to) {
      if (existsSync(to)) throw new Error(`Destination exists: ${to}`);
      renameSync(from, to);
    },
    copy(from, to) {
      if (existsSync(to)) throw new Error(`Destination exists: ${to}`);
      copyFileSync(from, to);
    },
    list: (p) => readdirSync(p),
    size: (p) => (existsSync(p) ? statSync(p).size : 0),
    modifiedAt: (p) => (existsSync(p) ? statSync(p).mtimeMs : null),
    mkdirp(p) {
      mkdirSync(p, { recursive: true });
    },
    download(_p, cb) {
      setImmediate(() => cb(null, true));
    },
  };
  if (!fault) return api;
  const wrapped = { ...api } as Record<string, unknown>;
  for (const [op, fn] of Object.entries(api)) {
    wrapped[op] = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && fault(op, args[0])) throw new Error(`Injected ${op} failure: ${args[0]}`);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return wrapped as unknown as NativeHost['fs'];
}

export function startCoreInVm(opts: MockOptions): CoreHarness {
  const dir = mkdtempSync(path.join(tmpdir(), 'tn2-core-'));
  const localRoot = path.join(dir, 'local');
  const syncedRoot = path.join(dir, 'icloud');
  mkdirSync(localRoot, { recursive: true });
  mkdirSync(syncedRoot, { recursive: true });
  const logs: CoreHarness['logs'] = [];
  const events: CoreHarness['events'] = [];
  const requests: NativeHttpRequest[] = [];
  const answers = [...(opts.answers ?? [])];
  const picks = [...(opts.picks ?? [])];
  const timers = new Map<number, NodeJS.Timeout>();
  let nextTimer = 1;
  let handler: ((req: string, done: (res: string) => void) => void) | null = null;
  const queued: [string, (res: string) => void][] = [];

  // A bare context: ECMAScript + Intl only (Node adds nothing else to a fresh vm context).
  const context = vm.createContext({});
  const coreDir = path.join(opts.wwwDir, 'core');

  const answer = (cb: NativeCallback<number>): void => {
    const a = answers.length > 0 ? (answers.shift() as number) : 0;
    setImmediate(() => cb(null, a));
  };

  const host: NativeHost = {
    info: {
      platform: 'node-mock',
      appVersion: 'test',
      localRoot,
      syncedRoot: opts.syncedAvailable === false ? null : syncedRoot,
      launchReason: opts.launchReason ?? 'ui',
    },
    fs: fsApi(opts.fsFault),
    http(requestJson, cb) {
      const req = JSON.parse(requestJson) as NativeHttpRequest;
      requests.push(req);
      setImmediate(() => {
        const route = opts.routes?.[req.url] ?? opts.routes?.[`${req.method ?? 'GET'} ${req.url}`];
        const r: Route = typeof route === 'function' ? route(req) : (route ?? { status: 404, body: 'not found' });
        const res: NativeHttpResponse = { url: req.url, status: r.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8', ...(r.headers ?? {}) } };
        if (req.responseType === 'base64') res.base64 = Buffer.from(r.body ?? '').toString('base64');
        else res.body = r.body ?? '';
        cb(null, JSON.stringify(res));
      });
    },
    browserFetch(_requestJson, cb) {
      setImmediate(() => cb('browserFetch is not available in the mock', null));
    },
    timers: {
      set(ms, cb) {
        const id = nextTimer++;
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            cb();
          }, ms),
        );
        return id;
      },
      clear(id) {
        const t = timers.get(id);
        if (t) clearTimeout(t);
        timers.delete(id);
      },
    },
    ui: {
      actionSheet: (_json, cb) => answer(cb),
      alert: (_json, cb) => answer(cb),
      share: (_json, cb) => setImmediate(() => cb(null, true)),
      shareFile: (_p, cb) => setImmediate(() => cb(null, true)),
      shareImage: (b64, cb) => setImmediate(() => (b64 ? cb(null, true) : cb('not an image', null))),
      pickFile: (_t, destDir, cb) =>
        setImmediate(() => {
          const src = picks.length > 0 ? picks.shift() : null;
          if (!src) return cb('cancelled', null);
          mkdirSync(destDir, { recursive: true });
          const dst = path.join(destDir, path.basename(src).replace(/[^A-Za-z0-9._-]/g, '_'));
          copyFileSync(src, dst);
          cb(null, dst);
        }),
      openUrl: () => undefined,
      symbol: (name) => (name.startsWith('missing') ? null : Buffer.from(`png:${name}`).toString('base64')),
      resizeImage: (b64) => b64,
      device: () => JSON.stringify({ model: 'iPhone', systemVersion: '26.0', batteryLevel: 0.8, charging: false, brightness: 0.5, dark: true }),
      setBrightness: () => undefined,
      solveChallenge: (_u, cb) => setImmediate(() => cb(null, false)),
    },
    log(level, line) {
      logs.push({ level, line });
    },
    bundle: {
      read(rel) {
        const p = path.join(coreDir, rel);
        return existsSync(p) ? readFileSync(p, 'utf8') : null;
      },
      loadModule(rel) {
        const p = path.join(coreDir, rel);
        if (!existsSync(p)) throw new Error(`Bundled module missing: ${rel}`);
        const code = readFileSync(p, 'utf8');
        return vm.runInContext(`(function (module, exports, require) {${code}\n})`, context, { filename: rel }) as ReturnType<NativeHost['bundle']['loadModule']>;
      },
    },
    emit(event, payloadJson) {
      events.push({ event, payload: JSON.parse(payloadJson) as unknown });
      opts.onEmit?.(event, payloadJson);
    },
    register(h) {
      handler = h;
      for (const [req, done] of queued.splice(0)) h(req, done);
    },
  };

  let evaluated = false;
  const evaluate = (): void => {
    if (evaluated) return;
    evaluated = true;
    (context as { __native?: NativeHost }).__native = host;
    vm.runInContext(readFileSync(path.join(coreDir, 'core.js'), 'utf8'), context, { filename: 'core.js' });
  };
  if (!opts.deferEvaluate) evaluate();

  let id = 1;
  const callRaw: CoreHarness['callRaw'] = (method, args) =>
    new Promise((resolve) => {
      const req = JSON.stringify({ kind: 'req', id: id++, method, args: args ?? null });
      const done = (res: string): void => resolve(JSON.parse(res) as Awaited<ReturnType<CoreHarness['callRaw']>>);
      if (handler) handler(req, done);
      else queued.push([req, done]);
    });

  const callJson = (requestJson: string): Promise<string> =>
    new Promise((resolve) => {
      if (handler) handler(requestJson, resolve);
      else queued.push([requestJson, resolve]);
    });

  return {
    dir,
    localAppDir: path.join(localRoot, 'TachiNovel'),
    callJson,
    evaluate,
    logs,
    events,
    requests,
    context,
    callRaw,
    async call<T>(method: string, args?: unknown): Promise<T> {
      const r = await callRaw(method, args);
      if (!r.ok) throw new Error(`${method} failed: ${r.error?.code} ${r.error?.message}`);
      return r.result as T;
    },
    dispose() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
