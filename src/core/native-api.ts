/**
 * The native host API (`__native`) that the iOS CoreHost (Swift, ios/App/App/Native/Core/) exposes to
 * the core JavaScriptCore context. This file is THE contract between Swift and the JS core: every
 * member here has exactly one Swift implementation (NativeHostAPI.swift) and one Node mock
 * (tests/helpers/native-mock.ts).
 *
 * Design rules (mirroring what v1 learned about Scriptable's JSC, see v1 CLAUDE.md "Phone facts"):
 * - Only strings, numbers, booleans, string arrays and callbacks cross the boundary. Structured data
 *   travels as JSON strings. No JS objects are retained by Swift except callbacks (released after use).
 * - Synchronous members are cheap, local and run on the core thread (file IO on the app container,
 *   SF Symbol rendering, image downscaling via ImageIO). They throw a JS Error on failure.
 * - Anything slow or UI-bound (HTTP, alerts, share sheets, document picker, iCloud download) is
 *   callback-based: `cb(error, result)` with `error === null` on success. Swift always invokes callbacks
 *   on the core thread, exactly once.
 * - The core removes `globalThis.__native` right after reading it (core/main.ts), so plugin code that
 *   later runs in the same context cannot reach native capabilities through globals.
 */

export type NativeCallback<T> = (error: string | null, result: T | null) => void;

export interface NativeFs {
  /** UTF-8 text, or null when the file is missing/unreadable. */
  readText(absPath: string): string | null;
  /** Creates or replaces the file. Throws if the parent directory is missing (FileManager semantics). */
  writeText(absPath: string, text: string): void;
  readBase64(absPath: string): string | null;
  writeBase64(absPath: string, base64: string): void;
  exists(absPath: string): boolean;
  isDirectory(absPath: string): boolean;
  /** Recursive for directories. Throws if the path is missing. */
  remove(absPath: string): void;
  /** Throws if `to` exists. */
  move(from: string, to: string): void;
  copy(from: string, to: string): void;
  /** Entry names. Throws if the directory is missing. */
  list(absPath: string): string[];
  /** Exact bytes (unlike Scriptable's whole-KB fileSize); 0 if missing. */
  size(absPath: string): number;
  /** Epoch ms or null. */
  modifiedAt(absPath: string): number | null;
  /** mkdir -p; no-op when it exists. */
  mkdirp(absPath: string): void;
  /**
   * iCloud only: make sure an evicted file is materialized (NSFileManager.startDownloadingUbiquitousItem
   * + NSFileCoordinator read). Calls back immediately for local or already-downloaded files.
   */
  download(absPath: string, cb: NativeCallback<true>): void;
}

/** JSON of HttpRequest (contracts/platform.ts) plus `responseType`. */
export interface NativeHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** 'text' (default): body decoded with the response charset (fallback UTF-8, then Latin-1). */
  responseType?: 'text' | 'base64';
}

/** JSON the http callback receives. Header names lower-cased; Set-Cookie values joined with "\n". */
export interface NativeHttpResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body?: string;
  base64?: string;
}

export interface NativeUiApi {
  /** JSON {title?, message?, actions:[{title, destructive?}], cancel?} → chosen index, -1 = cancel. */
  actionSheet(optsJson: string, cb: NativeCallback<number>): void;
  alert(optsJson: string, cb: NativeCallback<number>): void;
  /** JSON {text?, url?}. */
  share(optsJson: string, cb: NativeCallback<true>): void;
  shareFile(absPath: string, cb: NativeCallback<true>): void;
  /** Share PNG/JPEG bytes as an image ("Save Image"); error if the bytes aren't a decodable image. */
  shareImage(base64: string, cb: NativeCallback<true>): void;
  /** UTType identifiers or file extensions; the picked file is copied into the app's local store first. */
  pickFile(typesJson: string, destDir: string, cb: NativeCallback<string>): void;
  openUrl(url: string): void;
  /** PNG base64 of an SF Symbol, white on transparent; null if no such symbol. */
  symbol(name: string, size: number): string | null;
  /** JPEG base64 when wider than maxWidth, the input when not, null when undecodable (ImageIO). */
  resizeImage(base64: string, maxWidth: number): string | null;
  /** JSON DeviceInfo (snapshot refreshed by the main thread on battery/brightness/appearance changes). */
  device(): string;
  setBrightness(value: number): void;
  /** Present the site in a visible WKWebView sheet until closed; true if no challenge was seen last. */
  solveChallenge(url: string, cb: NativeCallback<boolean>): void;
}

export interface NativeHostInfo {
  platform: 'ios' | 'android' | 'node-mock';
  appVersion: string;
  /** Absolute path of the device-only base folder (Library/Application Support); the core appends TachiNovel/. */
  localRoot: string;
  /** Absolute path of the iCloud base folder (ubiquity container Documents), or null; the core appends TachiNovel/. */
  syncedRoot: string | null;
  /**
   * Absolute path of the app's Documents folder (shown in Files as On My iPhone › TachiNovel). Holds the
   * synced store when there is no iCloud (free sideload), directly (no TachiNovel/ subfolder). Optional: older
   * hosts don't send it (the synced store then falls back to the local one).
   */
  documentsRoot?: string | null;
  /** How the native side launched the core: foreground UI, BGAppRefreshTask, narration-only, … */
  launchReason: 'ui' | 'background-refresh' | 'narration';
  /**
   * The web update bundle this launch runs (UI and core), chosen by WebBundle.swift before anything loads;
   * null or missing = the bundle shipped inside the app (src/core/ota/ota.ts).
   */
  webBundle?: string | null;
}

/** CryptoKit, synchronous (small inputs). */
export interface NativeCrypto {
  /** SHA-256 of the UTF-8 bytes of `text`, lowercase hex. */
  sha256Hex(text: string): string;
  /** Ed25519: is `signatureBase64` (64 bytes) a signature of the UTF-8 `message` under the raw 32-byte key? */
  verifyEd25519(publicKeyBase64: string, message: string, signatureBase64: string): boolean;
}

export interface NativeHost {
  readonly info: NativeHostInfo;
  readonly fs: NativeFs;
  /** JSON NativeHttpRequest → JSON NativeHttpResponse. Uses URLSession: no CORS, no CORP, shared cookies. */
  http(requestJson: string, cb: NativeCallback<string>): void;
  /**
   * Fetch through a hidden WKWebView that shares the site's cookies (Cloudflare JS challenges).
   * JSON {url, timeoutMs, method: 'GET'|'POST', headers?, body?}: GET loads the page; POST runs fetch()
   * inside a page on the URL's origin with credentials included. Callback: JSON NativeHttpResponse.
   */
  browserFetch(requestJson: string, cb: NativeCallback<string>): void;
  readonly timers: {
    set(ms: number, cb: () => void): number;
    clear(id: number): void;
  };
  readonly ui: NativeUiApi;
  readonly crypto: NativeCrypto;
  log(level: string, line: string): void;
  /** Read-only files shipped in the app bundle under public/core/ (relative path), or null. */
  readonly bundle: {
    read(relPath: string): string | null;
    /**
     * Compile `(function (module, exports, require) { <file> \n})` with the file as source URL (good
     * stack traces / Web Inspector) and return the function. Throws if missing or on a syntax error.
     */
    loadModule(relPath: string): (module: { exports: unknown }, exports: unknown, require: (id: string) => never) => void;
  };
  /** Core → UI (Capacitor listener "event") and → native observers (narration). */
  emit(event: string, payloadJson: string): void;
  /**
   * Install the request handler. Requests from the UI (CorePlugin.call) and from native code
   * (narration, background refresh) arrive as RequestEnvelope JSON; `done` gets a ResponseEnvelope JSON.
   * Native queues requests that arrive before this is called.
   */
  register(handler: (requestJson: string, done: (responseJson: string) => void) => void): void;
}

declare global {
  // Installed by the native host before core.js is evaluated; core/main.ts reads it and deletes it.
  var __native: NativeHost | undefined;
}
