/**
 * Platform interface: everything script-side services need from the outside world.
 * Implemented by src/script/platform/scriptable.ts (phone) and a Node implementation for tests/dev.
 * Services depend ONLY on this interface, never on Scriptable globals.
 * Owned by the coordinator; agents request changes instead of editing.
 */
import type { DeviceInfo } from './domain.ts';
import type { NativeAction } from './protocol.ts';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  /** Already-encoded body (form-encoded, JSON, ...). */
  body?: string;
  /** Default 15 000 ms. */
  timeoutMs?: number;
}

export interface HttpResponse {
  /** Final URL after redirects. */
  url: string;
  status: number;
  /** Lower-cased header names. Multiple Set-Cookie values are joined with "\n". */
  headers: Record<string, string>;
  body: string;
}

export interface HttpBytesResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  base64: string;
}

export interface BrowserFetchOptions {
  timeoutMs?: number;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Already-encoded body (form-encoded, JSON, ...). */
  body?: string;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
  requestBytes(req: HttpRequest): Promise<HttpBytesResponse>;
}

/**
 * A file store rooted at one directory. Paths are relative ("library.json", "cache/x.json").
 * Writes are atomic (temp file + rename). Missing files read as null.
 */
export interface FileStore {
  /** Absolute path of the root directory. */
  readonly root: string;
  /** False for the synced store when iCloud is unavailable and it fell back to local. */
  readonly isSynced: boolean;
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  readBase64(path: string): Promise<string | null>;
  writeBase64(path: string, base64: string): Promise<void>;
  exists(path: string): boolean;
  remove(path: string): void;
  move(from: string, to: string): void;
  /** Names (not paths) of entries in a directory; [] if missing. */
  list(dir: string): string[];
  /** Bytes; 0 if missing. Directories: recursive total. */
  size(path: string): number;
  /** Epoch ms or null if missing. */
  modifiedAt(path: string): number | null;
  mkdirp(dir: string): void;
  /** Absolute path for a relative one (e.g. for WebView.loadFile or relative image refs). */
  absolute(path: string): string;
}

export interface NativeUi {
  actionSheet(opts: { title?: string; message?: string; actions: NativeAction[]; cancel?: string }): Promise<number>;
  alert(opts: { title: string; message?: string; actions: NativeAction[]; cancel?: string }): Promise<number>;
  share(opts: { text?: string; url?: string }): Promise<void>;
  /** Share a file (absolute path) through the native share sheet. */
  shareFile(absPath: string): Promise<void>;
  /** Native document picker; resolves to the picked file's absolute path, or null if cancelled. */
  pickFile(types: string[]): Promise<string | null>;
  openUrl(url: string): void;
  /** PNG base64 (white glyph, transparent background) or null if the symbol doesn't exist. */
  symbol(name: string, size: number): string | null;
  /**
   * Downscale an image natively (any format iOS decodes, incl. WebP). If the image is wider than
   * `maxWidth`, returns a JPEG (base64) `maxWidth` px wide with the aspect ratio kept; if it is not
   * wider, returns the input unchanged (same string); null if the data can't be decoded.
   * Added for covers (CP: an 8.5 MB Stonescape WebP cover).
   */
  resizeImage(base64: string, maxWidth: number): string | null;
  device(): DeviceInfo;
  setBrightness(value: number): void;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Platform {
  http: HttpClient;
  /** Fallback fetch through a hidden WebView (passes JS challenges). Optional on platforms without one. */
  /** Fetch through a (hidden) WebView that shares the site's cookies; POST runs as an in-page fetch() on the site's origin. */
  browserFetch?: (url: string, opts?: BrowserFetchOptions) => Promise<HttpResponse>;
  /** Device-only storage root (…/Documents/TachiNovel on the phone). */
  local: FileStore;
  /** iCloud storage root (…/iCloud/Scriptable/TachiNovel); falls back to local. */
  synced: FileStore;
  native: NativeUi;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(level: LogLevel, message: string, data?: unknown): void;
  /** Load a lazily-built bundle (dist/scriptable/TachiNovel/app/lib/<name>.js). */
  importLazy<T>(name: 'plugin-host'): Promise<T>;
}
