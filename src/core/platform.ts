/**
 * v2 Platform implementation: the v1 `Platform` contract (vendor/v1/src/shared/contracts/platform.ts)
 * over the native host API (`__native`, see native-api.ts). This is the v2 replacement for v1's
 * src/script/platform/scriptable.ts; everything above it (services, handlers, plugin host) is v1 code,
 * reused unchanged.
 *
 * Differences from the Scriptable platform:
 * - File sizes are exact (Scriptable only reported whole KB).
 * - HTTP is URLSession (no CORS/CORP limits, shared cookie jar, real total timeouts).
 * - importLazy compiles bundled modules from the app bundle (public/core/lib/<name>.js) instead of
 *   importModule() on an iCloud file, so there is no evicted-placeholder failure mode.
 * - Logs: native os_log line, plus v1's LogFile: local logs/app.log, mirrored to iCloud ≤ once a minute.
 */
import { createFileStore, type FileOps } from '@v1/script/lib/file-store.ts';
import { formatLogLine, LogFile, type LogMirror } from '@v1/script/lib/log-file.ts';
import type { DeviceInfo } from '@v1/shared/contracts/domain.ts';
import type {
  BrowserFetchOptions,
  FileStore,
  HttpBytesResponse,
  HttpClient,
  HttpRequest,
  HttpResponse,
  LogLevel,
  NativeUi,
  Platform,
} from '@v1/shared/contracts/platform.ts';
import type { NativeAction } from '@v1/shared/contracts/protocol.ts';
import type { NativeCallback, NativeHost, NativeHttpRequest, NativeHttpResponse } from './native-api.ts';
import { type LayoutResult, prepareDocumentsLayout } from './storage/documents-layout.ts';

export const APP_DIR = 'TachiNovel';
export const IMPORTS_DIR = 'imports';
const LOG_FLUSH_MS = 3000;
const LOG_BUFFER_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const BROWSER_FETCH_TIMEOUT_MS = 30_000;

export interface NativePlatform extends Platform {
  /** Write buffered log lines now; refreshes the iCloud mirror unless `mirror: false`. */
  flushLogs(opts?: { mirror?: boolean }): Promise<void>;
  /** Visible WebView on `url` until closed (sources.solveChallenge). */
  solveChallenge(url: string): Promise<boolean>;
  readonly host: NativeHost;
  /** Free-sideload layout (synced store in Documents) when there is no iCloud; null with iCloud. */
  readonly layout: LayoutResult | null;
}

/** Promise wrapper for a callback-style native call. */
export function call<T>(fn: (cb: NativeCallback<T>) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    try {
      fn((error, result) => {
        if (settled) return;
        settled = true;
        if (error !== null && error !== undefined) reject(new Error(error));
        else resolve(result as T);
      });
    } catch (err) {
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function joinPath(base: string, rel: string): string {
  if (!rel) return base;
  return base.endsWith('/') ? base + rel : `${base}/${rel}`;
}

function fileOps(host: NativeHost, icloud: boolean): FileOps {
  const { fs } = host;
  const ops: FileOps = {
    readString(p) {
      const s = fs.readText(p);
      if (s === null || s === undefined) throw new Error(`Cannot read ${p}`);
      return s;
    },
    writeString: (p, text) => fs.writeText(p, text),
    readBase64(p) {
      const s = fs.readBase64(p);
      if (s === null || s === undefined) throw new Error(`Cannot read ${p}`);
      return s;
    },
    writeBase64: (p, b64) => fs.writeBase64(p, b64),
    exists: (p) => fs.exists(p),
    isDirectory: (p) => fs.isDirectory(p),
    remove: (p) => fs.remove(p),
    move: (from, to) => fs.move(from, to),
    list: (p) => fs.list(p),
    fileSizeBytes: (p) => fs.size(p),
    modifiedAt: (p) => fs.modifiedAt(p),
    mkdirp: (p) => fs.mkdirp(p),
    join: joinPath,
  };
  if (icloud) ops.download = (p) => call<true>((cb) => fs.download(p, cb)).then(() => undefined);
  return ops;
}

/**
 * The two stores. Synced: iCloud when the app has the container (entitled builds); otherwise the app's
 * Documents folder itself (free sideload: visible in Files as On My iPhone › TachiNovel, see
 * storage/documents-layout.ts, which also moves data written by older builds); the local store as a
 * last resort. `log` receives the layout's messages (the platform log isn't up yet).
 */
export function createStores(
  host: NativeHost,
  log: (level: 'info' | 'warn', message: string) => void = (level, message) => host.log(level, message),
): { local: FileStore; synced: FileStore; layout: LayoutResult | null } {
  const localDir = joinPath(host.info.localRoot, APP_DIR);
  const local = createFileStore(fileOps(host, false), localDir, false);
  local.mkdirp('');
  const syncedRoot = host.info.syncedRoot;
  if (syncedRoot) {
    try {
      const synced = createFileStore(fileOps(host, true), joinPath(syncedRoot, APP_DIR), true);
      synced.mkdirp('');
      return { local, synced, layout: null };
    } catch (err) {
      log('warn', `iCloud store unavailable, using local: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const documentsRoot = host.info.documentsRoot;
  if (documentsRoot) {
    // Documents itself (no TachiNovel/ subfolder): Files shows On My iPhone › TachiNovel › backups, logs, …
    const docsDir = documentsRoot;
    const layout = prepareDocumentsLayout(host.fs, { localDir, docsDir, now: () => Date.now(), log });
    if (layout.useDocuments) {
      const synced = createFileStore(fileOps(host, false), docsDir, false);
      synced.mkdirp('');
      return { local, synced, layout };
    }
    return { local, synced: local, layout };
  }
  return { local, synced: local, layout: null };
}

function toNativeRequest(req: HttpRequest, responseType: 'text' | 'base64'): string {
  const r: NativeHttpRequest = {
    url: req.url,
    method: req.method ?? 'GET',
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    responseType,
  };
  if (req.headers) r.headers = { ...req.headers };
  if (req.body !== undefined) r.body = req.body;
  return JSON.stringify(r);
}

function parseResponse(json: string, fallbackUrl: string): NativeHttpResponse {
  const r = JSON.parse(json) as Partial<NativeHttpResponse>;
  return {
    url: typeof r.url === 'string' && r.url ? r.url : fallbackUrl,
    status: typeof r.status === 'number' ? r.status : 0,
    headers: r.headers && typeof r.headers === 'object' ? r.headers : {},
    ...(typeof r.body === 'string' ? { body: r.body } : {}),
    ...(typeof r.base64 === 'string' ? { base64: r.base64 } : {}),
  };
}

export function createHttp(host: NativeHost): HttpClient {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const json = await call<string>((cb) => host.http(toNativeRequest(req, 'text'), cb));
      const r = parseResponse(json, req.url);
      return { url: r.url, status: r.status, headers: r.headers, body: r.body ?? '' };
    },
    async requestBytes(req: HttpRequest): Promise<HttpBytesResponse> {
      const json = await call<string>((cb) => host.http(toNativeRequest(req, 'base64'), cb));
      const r = parseResponse(json, req.url);
      return { url: r.url, status: r.status, headers: r.headers, base64: r.base64 ?? '' };
    },
  };
}

function actionsJson(opts: { title?: string; message?: string; actions: NativeAction[]; cancel?: string }): string {
  return JSON.stringify({
    title: opts.title,
    message: opts.message,
    actions: opts.actions.map((a) => ({ title: a.title, destructive: a.destructive === true })),
    cancel: opts.cancel,
  });
}

const FALLBACK_DEVICE: DeviceInfo = { model: 'iPhone', systemVersion: '', batteryLevel: 1, charging: false, brightness: 0.5, dark: true };

export function createNative(host: NativeHost, local: FileStore): NativeUi {
  const ui = host.ui;
  return {
    actionSheet: (opts) => call<number>((cb) => ui.actionSheet(actionsJson({ ...opts, cancel: opts.cancel ?? 'Cancel' }), cb)),
    alert: (opts) => call<number>((cb) => ui.alert(actionsJson(opts), cb)),
    share: (opts) => call<true>((cb) => ui.share(JSON.stringify({ text: opts.text, url: opts.url }), cb)).then(() => undefined),
    shareFile: (absPath) => call<true>((cb) => ui.shareFile(absPath, cb)).then(() => undefined),
    shareImage: (base64) => call<true>((cb) => ui.shareImage(base64, cb)).then(() => undefined),
    async pickFile(types) {
      local.mkdirp(IMPORTS_DIR);
      try {
        const picked = await call<string>((cb) => ui.pickFile(JSON.stringify(types), local.absolute(IMPORTS_DIR), cb));
        return picked || null;
      } catch {
        return null; // cancelled
      }
    },
    openUrl: (url) => ui.openUrl(url),
    symbol: (name, size) => ui.symbol(name, size),
    resizeImage: (base64, maxWidth) => ui.resizeImage(base64, maxWidth),
    device() {
      try {
        return { ...FALLBACK_DEVICE, ...(JSON.parse(ui.device()) as Partial<DeviceInfo>) };
      } catch {
        return FALLBACK_DEVICE;
      }
    },
    setBrightness: (value) => ui.setBrightness(Math.min(1, Math.max(0, value))),
  };
}

/**
 * Log mirror in the synced store (iCloud, or Documents in the free sideload): overwritten in place (no
 * temp/rename); an iCloud file is materialized first in case it was evicted.
 */
function syncedMirror(host: NativeHost, synced: FileStore): LogMirror {
  return {
    read: (path) => synced.readText(path),
    async write(path, text) {
      const abs = synced.absolute(path);
      synced.mkdirp(path.slice(0, path.lastIndexOf('/')));
      if (synced.isSynced && host.fs.exists(abs)) await call<true>((cb) => host.fs.download(abs, cb)).catch(() => undefined);
      host.fs.writeText(abs, text);
    },
  };
}

export function createNativePlatform(host: NativeHost): NativePlatform {
  const layoutLog: [level: 'info' | 'warn', message: string][] = [];
  const { local, synced, layout } = createStores(host, (level, message) => layoutLog.push([level, message]));
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      host.timers.set(Math.max(0, ms), resolve);
    });

  // ---- logs: native os_log line + v1's LogFile (device log, mirrored to iCloud ≤ once a minute) ----
  // Same file format and policy as v1 (lib/log-file.ts), so v1's app.logs (Diagnostics screen) reads it.
  const logFile = new LogFile({
    primary: local,
    mirror: synced === local ? null : syncedMirror(host, synced),
    now: () => Date.now(),
    onError: (err) => host.log('error', `log write failed: ${err instanceof Error ? err.message : String(err)}`),
  });
  let buffer: string[] = [];
  let bufferBytes = 0;
  let flushScheduled = false;

  function flushLogs(opts: { mirror?: boolean } = {}): Promise<void> {
    if (buffer.length === 0) return opts.mirror === false ? Promise.resolve() : logFile.mirrorNow();
    return logFile.append(takeChunk(), { forceMirror: opts.mirror !== false });
  }

  function takeChunk(): string {
    const chunk = `${buffer.join('\n')}\n`;
    buffer = [];
    bufferBytes = 0;
    return chunk;
  }

  function log(level: LogLevel, message: string, data?: unknown): void {
    const line = formatLogLine(Date.now(), level, message, data);
    host.log(level, line);
    if (level === 'debug') return;
    buffer.push(line);
    bufferBytes += line.length;
    if (level === 'error' || bufferBytes > LOG_BUFFER_BYTES) void flushLogs({ mirror: level === 'error' });
    else if (!flushScheduled) {
      flushScheduled = true;
      host.timers.set(LOG_FLUSH_MS, () => {
        flushScheduled = false;
        if (buffer.length === 0) return;
        void logFile.append(takeChunk());
      });
    }
  }

  /** Loads a lazy bundle; any failure (including the store-flavor refusal) is a rejected promise. */
  function importLazy<T>(name: 'plugin-host'): Promise<T> {
    try {
      // Store builds ship no JS plugin host at all; refuse explicitly (defense in depth for 2.5.2).
      if (__FLAVOR__ === 'store') throw new Error(`${name} is not part of this build`);
      const factory = host.bundle.loadModule(`lib/${name}.js`);
      const mod: { exports: unknown } = { exports: {} };
      factory(mod, mod.exports, (id: string) => {
        throw new Error(`${name}.js: require("${id}") is not available in the core context`);
      });
      return Promise.resolve(mod.exports as T);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** GET: hidden WKWebView loads the page; POST: fetch() inside a page on the URL's origin (v1 parity). */
  async function browserFetch(url: string, opts?: BrowserFetchOptions): Promise<HttpResponse> {
    const req = {
      url,
      timeoutMs: opts?.timeoutMs ?? BROWSER_FETCH_TIMEOUT_MS,
      method: opts?.method ?? 'GET',
      ...(opts?.headers ? { headers: opts.headers } : {}),
      ...(opts?.body !== undefined ? { body: opts.body } : {}),
    };
    const json = await call<string>((cb) => host.browserFetch(JSON.stringify(req), cb));
    const r = parseResponse(json, url);
    return { url: r.url, status: r.status, headers: r.headers, body: r.body ?? '' };
  }

  // The storage layout's messages, now that the log is up (os_log + the in-app log Diagnostics reads).
  for (const [level, message] of layoutLog) log(level, message);

  return {
    host,
    http: createHttp(host),
    browserFetch,
    local,
    synced,
    native: createNative(host, local),
    now: () => Date.now(),
    sleep,
    log,
    importLazy,
    flushLogs,
    solveChallenge: (url) => call<boolean>((cb) => host.ui.solveChallenge(url, cb)),
    layout,
  };
}
