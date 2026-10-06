/**
 * Platform implementation for Scriptable (JavaScriptCore, iOS). The ONLY module (with webview-host.ts)
 * that touches Scriptable globals; everything else depends on the Platform interface.
 *
 * - http: Request (timeoutInterval is in seconds; headers lower-cased from request.response;
 *   Set-Cookie values one per line, see lib/cookies.ts).
 * - local: FileManager.local() …/Documents/TachiNovel. synced: FileManager.iCloud() …/TachiNovel,
 *   falling back to local when iCloud is unavailable. Both via the shared atomic FileStore
 *   (lib/file-store.ts); iCloud reads always await downloadFileFromiCloud first (never for local files:
 *   it throws there). CP0 FileManager facts honoured by FileStore: write needs the parent folder,
 *   remove/listContents of missing paths throw, move onto an existing file throws, readString of a
 *   missing file returns null, fileSize is whole KB.
 * - log: console + buffered append to local logs/app.log (rotates to app.1.log), mirrored to synced
 *   logs/app.log in place at most once a minute and at session end (lib/log-file.ts).
 */
import type { DeviceInfo } from '../../shared/contracts/domain.ts';
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
} from '../../shared/contracts/platform.ts';
import type { NativeAction } from '../../shared/contracts/protocol.ts';
import { setCookieHeader } from '../lib/cookies.ts';
import { BrowserPostError, type BrowserPostMode, type PostInit, parsePostResult, postScript, runPolledPost } from '../lib/browser-post.ts';
import { type FileOps, createFileStore } from '../lib/file-store.ts';
import { LogFile, type LogMirror, formatLogLine } from '../lib/log-file.ts';
import { originOf } from '../lib/url.ts';
import { createViewPool } from '../lib/webview-pool.ts';

export const APP_DIR = 'TachiNovel';
const LOG_FLUSH_MS = 3000;
const LOG_BUFFER_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const BROWSER_FETCH_TIMEOUT_MS = 30_000;
/** A single evaluation in a hidden page normally takes a few ms. */
const HIDDEN_EVAL_MS = 5000;

export interface ScriptablePlatform extends Platform {
  /** Write buffered log lines now and refresh the iCloud mirror unless `mirror: false` (call before exiting). */
  flushLogs(opts?: { mirror?: boolean }): Promise<void>;
  /** Mirror the log to iCloud (off while another instance may own the files). */
  setLogMirror(on: boolean): void;
  /** How browserFetch runs POSTs: 'poll' (default) or 'callback' (comparison; flags.json "browserPostCallback"). */
  setBrowserPostMode(mode: BrowserPostMode): void;
  /** Script.complete(). */
  complete(): void;
  /** args.queryParameters when launched as scriptable:///run/TachiNovel?… ({} otherwise). */
  launchQuery(): Record<string, string>;
  /** Visible WebView on `url` until the user closes it; true if the last check saw no challenge. */
  solveChallenge(url: string): Promise<boolean>;
}

/** Evaluated in the challenge WebView every second: 'ok' once the page is no longer a Cloudflare check. */
const CHALLENGE_CHECK_JS =
  "(function(){var t=document.title||'';var cf=/just a moment|attention required|checking your browser|please wait|verify you are human/i.test(t)" +
  "||!!document.querySelector('#challenge-form,#challenge-stage,#cf-challenge-running,.cf-browser-verification,#turnstile-wrapper');" +
  "return (cf||document.readyState!=='complete')?'challenge':'ok';})()";

/** sources.solveChallenge: present FIRST, then load (CP1 rule), poll every 1 s, resolve when closed. */
async function solveChallenge(url: string): Promise<boolean> {
  const wv = new WebView();
  let closed = false;
  const closedSignal = wv.present(true).then(
    () => {
      closed = true;
      return 'closed' as const;
    },
    () => {
      closed = true;
      return 'closed' as const;
    },
  );
  await Promise.race([sleep(250), closedSignal]);
  if (closed) return false;
  wv.loadURL(url).catch(() => undefined);
  let solved = false;
  while (!closed) {
    const tick = await Promise.race([sleep(1000).then(() => 'tick' as const), closedSignal]);
    if (tick === 'closed' || closed) break;
    // Evaluations never resolve after dismissal (CP0): race them against the close.
    const check: unknown = await Promise.race([wv.evaluateJavaScript(CHALLENGE_CHECK_JS, false).catch(() => 'error'), closedSignal]);
    if (check === 'closed') break;
    solved = check === 'ok';
  }
  return solved;
}

/** Picked documents are copied here (local store) so the FileStore-based services can read them. */
export const IMPORTS_DIR = 'imports';

/** iOS shows an evicted iCloud file "x.json" as the placeholder ".x.json.icloud" next to it. */
function placeholderOf(p: string): string {
  const i = p.lastIndexOf('/');
  return `${p.slice(0, i + 1)}.${p.slice(i + 1)}.icloud`;
}

function fileOps(fm: FileManager, icloud: boolean): FileOps {
  /**
   * iCloud: an evicted file still exists (only as its placeholder). Treating it as missing would let a
   * read return "no file" and the next save write fresh data over the real file (or beside it, which
   * makes iCloud create a conflict copy). Removing it removes the placeholder.
   */
  const evicted = (p: string): boolean => icloud && !fm.fileExists(p) && fm.fileExists(placeholderOf(p));
  const ops: FileOps = {
    readString(p) {
      const s = fm.readString(p) as string | null;
      if (s === null || s === undefined) throw new Error(`Cannot read ${p}`);
      return s;
    },
    writeString: (p, text) => fm.writeString(p, text),
    readBase64(p) {
      const d = fm.read(p) as Data | null;
      if (!d) throw new Error(`Cannot read ${p}`);
      return d.toBase64String();
    },
    writeBase64(p, b64) {
      const d = Data.fromBase64String(b64) as Data | null;
      if (!d) throw new Error('Invalid base64 data');
      fm.write(p, d);
    },
    exists: (p) => fm.fileExists(p) || evicted(p),
    isDirectory: (p) => fm.isDirectory(p),
    remove: (p) => fm.remove(evicted(p) ? placeholderOf(p) : p),
    move: (from, to) => fm.move(from, to),
    list: (p) => fm.listContents(p),
    // FileManager.fileSize returns whole KB rounded down (CP0: 2000 bytes → 1). Report the middle of
    // that KB so sums over many small files aren't biased to 0.
    fileSizeBytes(p) {
      const kb: unknown = fm.fileSize(p); // typed number, but null when unreadable
      return (typeof kb === 'number' && Number.isFinite(kb) ? Math.floor(kb) : 0) * 1024 + 512;
    },
    modifiedAt(p) {
      const d = fm.modificationDate(p) as Date | null;
      return d ? d.getTime() : null;
    },
    mkdirp(p) {
      if (!fm.fileExists(p)) fm.createDirectory(p, true);
    },
    join: (base, rel) => fm.joinPath(base, rel),
  };
  if (icloud) ops.download = (p) => boundedDownload(fm, p);
  return ops;
}

/** iCloud downloads give up after this long (the widget uses the same bound). */
export const ICLOUD_DOWNLOAD_TIMEOUT_MS = 6000;
/** After a download timed out, further ones fail fast for this long (iCloud is offline or stuck). */
const ICLOUD_STALL_MS = 30_000;
let icloudStalledUntil = 0;

/**
 * downloadFileFromiCloud with a time limit: offline or stuck iCloud otherwise leaves the promise pending
 * forever (a blank app that Close can't end). Files already on the device skip the call entirely.
 * Rejects with an error whose name is "ICloudTimeout" (mapped to STORAGE by the FileStore readers).
 */
async function boundedDownload(fm: FileManager, p: string): Promise<void> {
  try {
    if (fm.fileExists(p) && fm.isFileDownloaded(p)) return;
  } catch {
    // unknown state: try the download
  }
  const timedOut = (): Error => Object.assign(new Error(`iCloud didn't deliver ${p.slice(p.lastIndexOf('/') + 1)} within ${ICLOUD_DOWNLOAD_TIMEOUT_MS / 1000} s (offline or iCloud busy)`), { name: 'ICloudTimeout' });
  if (Date.now() < icloudStalledUntil) throw timedOut();
  const TIMEOUT = Symbol('timeout');
  const r = await Promise.race([fm.downloadFileFromiCloud(p), sleep(ICLOUD_DOWNLOAD_TIMEOUT_MS).then(() => TIMEOUT)]);
  if (r === TIMEOUT) {
    icloudStalledUntil = Date.now() + ICLOUD_STALL_MS;
    throw timedOut();
  }
  icloudStalledUntil = 0;
}

/** The synced log mirror: read through the store, written in place with FileManager (no delete/rename). */
function icloudMirror(synced: FileStore, fm: FileManager): LogMirror {
  return {
    read: (path) => synced.readText(path),
    async write(path, text) {
      const abs = synced.absolute(path);
      synced.mkdirp(path.slice(0, path.lastIndexOf('/')));
      // Never write over an evicted placeholder (that is how iCloud ends up with conflict copies): if
      // the existing file can't be downloaded in time, skip this mirror refresh (the next one retries).
      if (fm.fileExists(abs)) await boundedDownload(fm, abs);
      fm.writeString(abs, text);
    },
  };
}

function createStores(): { local: FileStore; synced: FileStore; syncedFm: FileManager } {
  const localFm = FileManager.local();
  const local = createFileStore(fileOps(localFm, false), localFm.joinPath(localFm.documentsDirectory(), APP_DIR), false);
  local.mkdirp('');
  try {
    const fm = FileManager.iCloud();
    const docs = fm.documentsDirectory() as string | null;
    if (docs) {
      const synced = createFileStore(fileOps(fm, true), fm.joinPath(docs, APP_DIR), true);
      synced.mkdirp('');
      return { local, synced, syncedFm: fm };
    }
  } catch {
    // iCloud Drive disabled or unavailable → synced state stays on the device.
  }
  return { local, synced: local, syncedFm: localFm };
}

function lowerHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      const name = k.toLowerCase();
      if (typeof v === 'string') out[name] = v;
      else if (Array.isArray(v)) out[name] = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(name === 'set-cookie' ? '\n' : ', ');
      else out[name] = JSON.stringify(v);
    }
  }
  return out;
}

interface RawResponse {
  url?: unknown;
  statusCode?: unknown;
  headers?: unknown;
  /** [{name, value, domain, path, httpOnly, sessionOnly, …}] */
  cookies?: unknown;
}

function makeRequest(req: HttpRequest): Request {
  const r = new Request(req.url);
  r.method = req.method ?? 'GET';
  if (req.headers) r.headers = { ...req.headers };
  if (req.body !== undefined) r.body = req.body;
  r.timeoutInterval = Math.max(1, (req.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000);
  return r;
}

function responseMeta(r: Request, fallbackUrl: string): { url: string; status: number; headers: Record<string, string> } {
  const res = (r.response ?? {}) as RawResponse;
  const headers = lowerHeaders(res.headers);
  // iOS folds repeated Set-Cookie headers with ", "; the contract wants one cookie per line.
  const cookies = setCookieHeader(headers['set-cookie'], res.cookies);
  if (cookies) headers['set-cookie'] = cookies;
  else delete headers['set-cookie'];
  return {
    url: typeof res.url === 'string' && res.url ? res.url : fallbackUrl,
    status: typeof res.statusCode === 'number' ? res.statusCode : 0,
    headers,
  };
}

const http: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const r = makeRequest(req);
    const body = (await r.loadString()) as string | null;
    return { ...responseMeta(r, req.url), body: body ?? '' };
  },
  async requestBytes(req: HttpRequest): Promise<HttpBytesResponse> {
    const r = makeRequest(req);
    const data = (await r.load()) as Data | null;
    return { ...responseMeta(r, req.url), base64: data ? data.toBase64String() : '' };
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    Timer.schedule(Math.max(0, ms), false, () => resolve());
  });
}

function addActions(alert: Alert, actions: readonly NativeAction[]): void {
  for (const a of actions) {
    if (a.destructive) alert.addDestructiveAction(a.title);
    else alert.addAction(a.title);
  }
}

function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/[^A-Za-z0-9._-]/g, '_');
  return name || 'picked-file';
}

function createNative(local: FileStore): NativeUi {
  return {
    ...nativeBase,
    async shareImage(base64) {
      // Native decoding (Data.fromBase64String), not Scriptable's atob, which breaks on binary data.
      const data = Data.fromBase64String(base64) as Data | null;
      const image = data ? (Image.fromData(data) as Image | null) : null;
      if (!image) throw new Error('Not a decodable image');
      // An Image item makes the sheet offer "Save Image"; a dismissed sheet just resolves.
      await ShareSheet.present([image]);
    },
    async shareFile(absPath) {
      // ShareSheet has no documented file-path item; share the file's bytes (Data).
      const data = Data.fromFile(absPath) as Data | null;
      if (!data) throw new Error(`Cannot read ${absPath}`);
      await ShareSheet.present([data]);
    },
    async pickFile(types) {
      let picked: string[];
      try {
        picked = await DocumentPicker.open(types);
      } catch {
        return null; // cancelled
      }
      const src = picked[0];
      if (!src) return null;
      const fm = FileManager.local();
      try {
        // The picked document may be an un-downloaded iCloud file; this throws for non-iCloud files.
        await boundedDownload(FileManager.iCloud(), src);
      } catch (err) {
        // Not in iCloud: fine. In iCloud but not delivered in time: copying would copy a placeholder.
        if (err instanceof Error && err.name === 'ICloudTimeout') {
          throw Object.assign(new Error("The picked file isn't downloaded from iCloud yet; try again in a moment"), { code: 'STORAGE' });
        }
      }
      local.mkdirp(IMPORTS_DIR);
      const rel = `${IMPORTS_DIR}/${baseName(src)}`;
      const dst = local.absolute(rel);
      if (fm.fileExists(dst)) fm.remove(dst);
      fm.copy(src, dst);
      return dst;
    },
  };
}

const nativeBase: Omit<NativeUi, 'shareFile' | 'shareImage' | 'pickFile'> = {
  async actionSheet(opts) {
    const a = new Alert();
    if (opts.title) a.title = opts.title;
    if (opts.message) a.message = opts.message;
    addActions(a, opts.actions);
    a.addCancelAction(opts.cancel ?? 'Cancel');
    return a.presentSheet();
  },
  async alert(opts) {
    const a = new Alert();
    a.title = opts.title;
    if (opts.message) a.message = opts.message;
    addActions(a, opts.actions);
    if (opts.cancel) a.addCancelAction(opts.cancel);
    return a.presentAlert();
  },
  async share(opts) {
    const items: string[] = [];
    if (opts.text) items.push(opts.text);
    if (opts.url) items.push(opts.url);
    await ShareSheet.present(items);
  },
  openUrl(url) {
    Safari.open(url);
  },
  symbol(name, size) {
    try {
      const sym = SFSymbol.named(name) as SFSymbol | null;
      if (!sym) return null;
      sym.applyFont(Font.systemFont(size));
      const img = sym.image as Image | null;
      if (!img) return null;
      const data = Data.fromPNG(img) as Data | null;
      return data ? data.toBase64String() : null;
    } catch {
      return null;
    }
  },
  resizeImage(base64, maxWidth) {
    try {
      const data = Data.fromBase64String(base64) as Data | null;
      if (!data) return null;
      const img = Image.fromData(data) as Image | null;
      if (!img) return null;
      const { width, height } = img.size;
      if (!(width > 0 && height > 0)) return null;
      if (width <= maxWidth) return base64;
      const w = Math.round(maxWidth);
      const h = Math.max(1, Math.round((height * w) / width));
      const ctx = new DrawContext();
      ctx.size = new Size(w, h);
      ctx.respectScreenScale = false;
      ctx.opaque = false;
      ctx.drawImageInRect(img, new Rect(0, 0, w, h));
      const out = Data.fromJPEG(ctx.getImage()) as Data | null;
      return out ? out.toBase64String() : null;
    } catch {
      return null;
    }
  },
  device(): DeviceInfo {
    return {
      model: Device.model(),
      systemVersion: Device.systemVersion(),
      batteryLevel: Device.batteryLevel(),
      charging: Device.isCharging(),
      brightness: Device.screenBrightness(),
      dark: Device.isUsingDarkAppearance(),
    };
  },
  setBrightness(value) {
    Device.setScreenBrightness(Math.min(1, Math.max(0, value)));
  },
};

const CHALLENGE_TITLE_RE = /just a moment|attention required|checking your browser|please wait/i;

interface PageInfo {
  t?: string;
  ct?: string;
  u?: string;
}

/** One hidden-page evaluation that gives up after `ms` (a stuck page must never hang a fetch): undefined then. */
async function evalBounded(wv: WebView, js: string, ms = HIDDEN_EVAL_MS): Promise<unknown> {
  const TIMEOUT = Symbol('timeout');
  const r: unknown = await Promise.race([wv.evaluateJavaScript(js, false) as Promise<unknown>, sleep(ms).then(() => TIMEOUT)]);
  return r === TIMEOUT ? undefined : r;
}

/** Poll the page every second until it is no longer a challenge page (or the deadline passes). */
async function waitPastChallenge(wv: WebView, deadline: number, timedOut: () => Error): Promise<PageInfo> {
  for (;;) {
    const raw: unknown = await evalBounded(wv, 'JSON.stringify({t: document.title, ct: document.contentType, u: location.href})');
    const info = (typeof raw === 'string' ? JSON.parse(raw) : {}) as PageInfo;
    if (!CHALLENGE_TITLE_RE.test(info.t ?? '')) return info;
    if (Date.now() > deadline) throw timedOut();
    await sleep(1000);
  }
}

/** Views that must not be reused (a callback evaluation never completed on them). */
const brokenViews = new WeakSet<WebView>();

/**
 * Hidden WebViews per site origin (at most 3 kept), shared by GET and POST browserFetch: GETs navigate
 * an idle view of the origin (or a fresh one), POSTs run in-page on a view that is still on the origin.
 */
const viewPool = createViewPool<WebView>({
  max: 3,
  create: () => new WebView(),
  async isOn(wv, origin) {
    if (brokenViews.has(wv)) return false;
    const at: unknown = await evalBounded(wv, 'location.origin', 2000);
    return at === origin;
  },
  async open(wv, origin, deadline) {
    const timedOut = (): Error => new Error(`browserFetch timed out opening ${origin}`);
    const loaded = await Promise.race([wv.loadURL(`${origin}/`).then(() => true), sleep(Math.max(0, deadline - Date.now())).then(() => false)]);
    if (!loaded) throw timedOut();
    await waitPastChallenge(wv, deadline, timedOut);
  },
  now: () => Date.now(),
  timedOut: () => new Error('browserFetch timed out waiting for the site view'),
});

/**
 * Hidden WebView fetch through the site's own cookies (passes JS challenges such as Cloudflare that
 * plain Request can't). GET: load the URL in a pooled view of its origin, return the page. POST: run
 * fetch() inside a page on the URL's origin (see browserPost).
 */
async function browserFetch(url: string, opts?: BrowserFetchOptions): Promise<HttpResponse> {
  if (opts?.method === 'POST') return browserPost(url, opts);
  const timeoutMs = opts?.timeoutMs ?? BROWSER_FETCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const timedOut = (): Error => new Error(`browserFetch timed out after ${timeoutMs} ms: ${url}`);
  const origin = originOf(url);
  if (!origin) throw new Error(`browserFetch: not an absolute URL: ${url}`);
  return viewPool.navigate(origin, async (wv) => {
    const loaded = await Promise.race([wv.loadURL(url).then(() => true), sleep(timeoutMs).then(() => false)]);
    if (!loaded) throw timedOut();
    const info = await waitPastChallenge(wv, deadline, timedOut);
    const isHtml = !info.ct || /html|xml/i.test(info.ct);
    const TIMEOUT = Symbol('timeout');
    const body: unknown = isHtml
      ? await Promise.race([wv.getHTML() as Promise<unknown>, sleep(Math.max(1000, deadline - Date.now())).then(() => TIMEOUT)])
      : await evalBounded(wv, 'document.body ? document.body.innerText : ""');
    if (body === TIMEOUT) throw timedOut();
    const headers: Record<string, string> = info.ct ? { 'content-type': info.ct } : {};
    return { url: info.u ?? url, status: 200, headers, body: typeof body === 'string' ? body : '' };
  });
}

/** 'poll' unless flags.json "browserPostCallback" asks for the one-callback variant (comparison). */
let browserPostMode: BrowserPostMode = 'poll';
const POST_POLL_MS = 150;
/** 'callback' mode: one callback evaluation at a time per view. */
const callbackQueues = new WeakMap<WebView, Promise<unknown>>();

/**
 * POST via fetch() inside a hidden page on the URL's origin (credentials: 'include', so the WebView's
 * cookies, e.g. a solved Cloudflare clearance, go along); lib/browser-post.ts has the page scripts.
 * Default 'poll': only short non-callback evaluations, so a slow POST can never hold up the UI bridge
 * even if Scriptable serializes evaluations across WebViews.
 */
async function browserPost(url: string, opts: BrowserFetchOptions): Promise<HttpResponse> {
  const timeoutMs = opts.timeoutMs ?? BROWSER_FETCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const timedOut = (): Error => new Error(`browserFetch timed out after ${timeoutMs} ms: POST ${url}`);
  const origin = originOf(url);
  if (!origin) throw new Error(`browserFetch: not an absolute URL: ${url}`);
  const init: PostInit = {};
  if (opts.headers) init.headers = opts.headers;
  if (opts.body !== undefined) init.body = opts.body;
  const mapTimeout = (err: unknown): never => {
    if (err instanceof BrowserPostError && err.timeout) throw timedOut();
    throw err;
  };
  return viewPool.inPage(origin, deadline, async (wv) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    if (browserPostMode === 'poll') {
      // Each start/poll evaluation is bounded: a stuck one counts as "still pending" until the deadline.
      const deps = { evaluate: (js: string) => evalBounded(wv, js), sleep, now: () => Date.now() };
      return runPolledPost(deps, url, init, remaining, POST_POLL_MS).catch(mapTimeout);
    }
    const run = (callbackQueues.get(wv) ?? Promise.resolve()).then(async () => {
      const left = deadline - Date.now();
      if (left <= 0) throw timedOut();
      const STUCK = Symbol('stuck');
      const raw: unknown = await Promise.race([wv.evaluateJavaScript(postScript(url, init, left), true), sleep(left + 2000).then(() => STUCK)]);
      if (raw === STUCK) {
        brokenViews.add(wv); // the page never completed: the pool drops this view on its next check
        throw timedOut();
      }
      try {
        return parsePostResult(raw, url);
      } catch (err) {
        return mapTimeout(err);
      }
    });
    callbackQueues.set(wv, run.catch(() => undefined));
    return run;
  });
}

export function createScriptablePlatform(): ScriptablePlatform {
  const { local, synced, syncedFm } = createStores();

  let buffer: string[] = [];
  let bufferBytes = 0;
  let flushScheduled = false;
  let flushing: Promise<void> | null = null;

  const logFile = new LogFile({
    primary: local,
    mirror: synced.isSynced ? icloudMirror(synced, syncedFm) : null,
    now: () => Date.now(),
    onError: (err) => console.error(`TachiNovel: log write failed: ${err instanceof Error ? err.message : String(err)}`),
  });

  /** Buffered lines → device log; the mirror only when due (or forced at session end). */
  async function writeBuffer(forceMirror: boolean): Promise<void> {
    while (flushing) await flushing;
    if (buffer.length === 0) {
      if (forceMirror) await logFile.mirrorNow();
      return;
    }
    const chunk = `${buffer.join('\n')}\n`;
    buffer = [];
    bufferBytes = 0;
    flushing = logFile.append(chunk, { forceMirror });
    try {
      await flushing;
    } finally {
      flushing = null;
    }
  }

  const flushLogs = (o?: { mirror?: boolean }): Promise<void> => writeBuffer(o?.mirror ?? true);

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    Timer.schedule(LOG_FLUSH_MS, false, () => {
      flushScheduled = false;
      void writeBuffer(false);
    });
  }

  function log(level: LogLevel, message: string, data?: unknown): void {
    const line = formatLogLine(Date.now(), level, message, data);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (level === 'debug') return;
    buffer.push(line);
    bufferBytes += line.length;
    if (level === 'error' || bufferBytes > LOG_BUFFER_BYTES) void writeBuffer(false);
    else scheduleFlush();
  }

  async function importLazy<T>(name: 'plugin-host'): Promise<T> {
    const rel = `app/lib/${name}.js`;
    // Always resolve the absolute path: a freshly deployed file is often still an evicted iCloud
    // placeholder (".plugin-host.js.icloud"), which exists() doesn't see. importModule on a
    // placeholder yields an empty module (CP1: "does not export createPluginHost").
    const abs = synced.absolute(rel);
    if (synced.isSynced) {
      try {
        await boundedDownload(syncedFm, abs);
      } catch (err) {
        log('warn', `downloadFileFromiCloud(${rel}) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const mod = importModule(abs) as Record<string, unknown> | null;
    const keys = mod && typeof mod === 'object' ? Object.keys(mod) : [];
    if (keys.length === 0) {
      log('warn', `importModule(${rel}) returned no exports`, {
        exists: syncedFm.fileExists(abs),
        downloaded: synced.isSynced ? syncedFm.isFileDownloaded(abs) : true,
        sizeKB: syncedFm.fileExists(abs) ? syncedFm.fileSize(abs) : -1,
        type: typeof mod,
      });
    }
    return mod as T;
  }

  return {
    http,
    browserFetch,
    local,
    synced,
    native: createNative(local),
    now: () => Date.now(),
    sleep,
    log,
    importLazy,
    flushLogs,
    setLogMirror: (on) => logFile.setMirror(on),
    setBrowserPostMode: (mode) => {
      browserPostMode = mode;
    },
    complete() {
      Script.complete();
    },
    solveChallenge,
    launchQuery() {
      const q = (typeof args === 'object' && args ? (args.queryParameters as Record<string, unknown> | null | undefined) : null) ?? {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(q)) if (typeof v === 'string') out[k] = v;
      return out;
    },
  };
}
