/**
 * Plugin host contract. Implemented in src/plugin-host (portable: Node, Scriptable JSC, WebView).
 * Entry: `src/plugin-host/index.ts` must `export const createPluginHost: CreatePluginHost`.
 * Owned by the coordinator; agents request changes instead of editing.
 */
import type { Filters } from '../lnreader/filters.ts';
import type { ChapterMeta, NovelDetails, NovelSummary } from './domain.ts';
import type { BrowserFetchOptions, HttpClient, HttpResponse, LogLevel } from './platform.ts';

/** Synchronous key/value store per plugin (LNReader's @libs/storage is sync). Host persists it. */
export interface PluginKV {
  get(key: string): unknown;
  set(key: string, value: unknown, expires?: number | Date): void;
  delete(key: string): void;
  clearAll(): void;
  getAllKeys(): string[];
}

export interface PluginHostDeps {
  http: HttpClient;
  /** Fetch through a (hidden) WebView that shares the site's cookies; POST runs as an in-page fetch() on the site's origin. */
  browserFetch?: (url: string, opts?: BrowserFetchOptions) => Promise<HttpResponse>;
  storageFor(pluginId: string): PluginKV;
  log(level: LogLevel, message: string, data?: unknown): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface SourceMeta {
  id: string;
  name: string;
  site: string;
  version: string;
  /** Absolute icon URL if resolvable. */
  iconUrl?: string;
  lang?: string;
  filters?: Filters;
  /** Ignored by the app, surfaced for diagnostics. */
  hasCustomJS: boolean;
  customCSS?: string;
}

/**
 * Normalized, domain-typed view of a loaded plugin. All URLs absolute, statuses mapped,
 * genres split, page-based chapter lists flattened (fetched with bounded concurrency).
 */
export interface SourceAdapter {
  meta: SourceMeta;
  popular(page: number, opts: { latest: boolean; filters?: Record<string, unknown> }): Promise<NovelSummary[]>;
  search(query: string, page: number): Promise<NovelSummary[]>;
  novel(path: string): Promise<{ details: NovelDetails; chapters: ChapterMeta[] }>;
  /** Raw chapter HTML (unsanitized). Throws a LOCKED error for locked chapters. */
  chapter(path: string): Promise<string>;
  /** Absolute URL for a novel or chapter path (for "Open in Safari"). */
  resolveUrl(path: string, isNovel: boolean): string;
}

export interface PluginHost {
  /** Load plugin source code (CommonJS, `exports.default`). Throws PluginLoadError on failure. */
  load(code: string, opts?: { expectedId?: string; sourceUrl?: string }): SourceAdapter;
  /** Library modules provided to plugins via require(). */
  readonly providedModules: readonly string[];
}

export type CreatePluginHost = (deps: PluginHostDeps) => PluginHost;

export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginLoadError';
  }
}

/** Thrown by adapters; maps to bridge ErrorCode. */
export class SourceError extends Error {
  readonly code: 'NETWORK' | 'TIMEOUT' | 'CLOUDFLARE' | 'NOT_FOUND' | 'LOCKED' | 'PLUGIN';
  constructor(code: SourceError['code'], message: string) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
  }
}
