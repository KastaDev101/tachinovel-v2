/**
 * Bridge protocol between the UI (WebView) and the script (Scriptable).
 * Owned by the coordinator; agents request changes instead of editing.
 *
 * WIRE FORMAT (phone transport) — revised after CP0 on the phone (iOS 26.6.1):
 *   `completion` is NOT a global (it is lexical inside the evaluated code), and Scriptable SERIALIZES
 *   evaluateJavaScript calls (nothing else runs while a callback evaluation is pending).
 * - UI exposes `window.__bridge = { next(deliveriesJson?: string, done?: (json: string) => void): void, deliver(json): void }`.
 * - Script long-polls: `await wv.evaluateJavaScript("__bridge.next(" + JSON.stringify(outJson) + ", completion)", true)`.
 *   `next` applies piggybacked deliveries (a JSON array of Response/Event envelopes, or ""), then calls
 *   `done(json)` with a JSON array of RequestEnvelopes as soon as one is queued. The poll ALWAYS completes
 *   within a bounded time: after ~50 ms with "[]" while UI calls await results (so the script can
 *   piggyback them), and after ~1 s with "[]" when idle (so script-pushed events still flow).
 * - Results and events travel ONLY as piggybacked deliveries on the next poll. `deliver` exists for
 *   platforms with concurrent evaluation (the PC harness) and must not be relied on in the app.
 * - The script races every evaluation against the view's `closed` promise (evaluations never resolve
 *   after dismissal).
 * - Strings are always double-encoded (JSON inside a JS string literal) — never interpolate raw JSON.
 */
import type {
  AppSettings,
  AvailablePlugin,
  Category,
  ChapterMeta,
  ChapterPosition,
  ChapterView,
  DeviceInfo,
  HistoryEntry,
  LibraryEntry,
  NovelDetails,
  NovelKey,
  NovelSummary,
  ReadingStats,
  SourceSettings,
  PluginSettingValues,
  NarrationConfig,
  NarrationStatus,
  CleanupRule,
  RepoInfo,
  SourceFailureReason,
  SourceInfo,
  StorageCategory,
  StorageUsage,
  UpdateEntry,
} from './domain.ts';
import type { Filters } from '../lnreader/filters.ts';

// ---------- envelopes ----------

export interface RequestEnvelope {
  kind: 'req';
  id: number;
  method: string;
  args: unknown;
}

export type ErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'CLOUDFLARE'
  | 'NOT_FOUND'
  | 'LOCKED'
  | 'PLUGIN'
  | 'STORAGE'
  | 'INVALID_ARGS'
  | 'UNKNOWN_METHOD'
  | 'UNKNOWN';

export interface BridgeError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /** Source failures only: why the site failed (UI picks plain wording + action from it). */
  reason?: SourceFailureReason;
}

export type ResponseEnvelope =
  | { kind: 'res'; id: number; ok: true; result: unknown }
  | { kind: 'res'; id: number; ok: false; error: BridgeError };

export interface EventEnvelope {
  kind: 'evt';
  event: string;
  payload: unknown;
}

export type ToUiEnvelope = ResponseEnvelope | EventEnvelope;

// ---------- payload types ----------

export interface BootPayload {
  buildVersion: string;
  settings: AppSettings;
  library: LibraryEntry[];
  categories: Category[];
  sources: SourceInfo[];
  /** Most recent history entries for "continue reading". */
  recent: HistoryEntry[];
  /** Pre-rendered SF Symbols the UI asked for last time: name → data URL. */
  symbols: Record<string, string>;
  /**
   * Set when the app was launched from a link (home-screen widget, Shortcut):
   * scriptable:///run/TachiNovel?plugin=<id>&novel=<path>[&chapter=<path>]. The UI opens it after boot.
   */
  deepLink?: { pluginId: string; novelPath: string; chapterPath?: string };
}

export interface BackupInfo {
  fileName: string;
  createdAt: number;
  bytes: number;
}

export interface BrowseItem extends NovelSummary {
  inLibrary: boolean;
}

export interface BrowsePage {
  items: BrowseItem[];
  /** False once a page comes back empty. */
  hasMore: boolean;
}

export interface BackupPreview {
  fileName?: string;
  /** Set when the file was picked (not one of backup.list); pass to backup.restore. */
  importId?: string;
  createdAt: number;
  buildVersion?: string;
  counts: { novels: number; categories: number; progress: number; history: number; updates: number; sources: number; repos: number; pluginSettings: number };
  /** Novels in the backup that aren't in the current library. */
  newNovels: number;
  /** Records that couldn't be read and would be skipped. */
  skipped: number;
}

export interface NovelPage {
  details: NovelDetails;
  chapters: ChapterView[];
  inLibrary: boolean;
  categoryIds: string[];
  /** Where to resume. */
  lastRead?: { chapterPath: string; position?: ChapterPosition };
  fetchedAt: number;
  /** True if served from stored metadata (library novels) while a refresh may be pending. */
  fromCache: boolean;
}

export interface ChapterContent {
  pluginId: string;
  novelPath: string;
  chapterPath: string;
  title: string;
  /** RAW source HTML. The UI must sanitize (DOMPurify) before inserting. */
  html: string;
  prev?: ChapterMeta;
  next?: ChapterMeta;
  /** Saved position to restore, if any. */
  position?: ChapterPosition;
  fromCache: boolean;
  /** Plugin-provided reader CSS (raw). The UI must sanitize/scope it to the chapter content before use. */
  customCSS?: string;
}

export interface NativeAction {
  title: string;
  destructive?: boolean;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ---------- methods (UI → script) ----------

type M<A, R> = { args: A; result: R };

export interface BridgeMethods {
  // app
  'app.boot': M<void, BootPayload>;
  'app.log': M<{ level: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown }, void>;
  /** Recent app.log lines for the Diagnostics screen (newest first; default level 'warn' = warn+error, limit 20, max 100). */
  'app.logs': M<{ level?: 'error' | 'warn'; limit?: number }, { at: number; level: string; message: string }[]>;
  /** Persist all pending debounced writes now (UI calls it on visibilitychange → hidden, after progress.save). */
  'app.flush': M<void, void>;
  'settings.set': M<{ patch: DeepPartial<AppSettings> }, AppSettings>;

  // sources & repos
  'sources.list': M<void, SourceInfo[]>;
  'sources.setEnabled': M<{ id: string; enabled: boolean }, SourceInfo[]>;
  'sources.setPinned': M<{ id: string; pinned: boolean }, SourceInfo[]>;
  /** Plugin settings (LNReader pluginSettings): schema + current values. */
  'sources.settings.get': M<{ id: string }, SourceSettings>;
  /** Save some setting values; the plugin reloads. SettingsError → INVALID_ARGS. */
  'sources.settings.set': M<{ id: string; values: Partial<PluginSettingValues> }, SourceSettings>;
  /** The plugin's filter definitions (LNReader Filters shape), or null if it has none. */
  'sources.filters': M<{ id: string }, Filters | null>;
  /** Filtered by settings.languages unless allLanguages is true (the language picker needs every language). */
  'sources.available': M<{ repoUrl?: string; allLanguages?: boolean }, AvailablePlugin[]>;
  'sources.install': M<{ url: string } | { code: string }, SourceInfo>;
  'sources.uninstall': M<{ id: string }, SourceInfo[]>;
  'sources.update': M<{ id: string }, SourceInfo>;
  /**
   * Cloudflare "solve in browser": present the source's site in a visible WebView so the user can pass
   * the check; afterwards that host's requests go through the (cookie-sharing) WebView fetch path.
   */
  'sources.solveChallenge': M<{ pluginId: string }, { solved: boolean }>;
  'repos.list': M<void, RepoInfo[]>;
  'repos.add': M<{ url: string }, RepoInfo[]>;
  'repos.remove': M<{ url: string }, RepoInfo[]>;

  // browse
  'browse.list': M<
    { pluginId: string; page: number; mode: 'popular' | 'latest'; filters?: Record<string, unknown> },
    BrowsePage
  >;
  'browse.search': M<{ pluginId: string; query: string; page: number }, BrowsePage>;
  'browse.globalSearch': M<
    { query: string },
    { results: { pluginId: string; items: BrowseItem[]; error?: BridgeError }[] }
  >;

  // novel & chapters
  'novel.get': M<NovelKey & { refresh?: boolean }, NovelPage>;
  'chapter.get': M<{ pluginId: string; novelPath: string; chapterPath: string }, ChapterContent>;

  // library
  'library.list': M<void, LibraryEntry[]>;
  'library.add': M<{ novel: NovelSummary | NovelDetails; categoryIds?: string[] }, LibraryEntry>;
  'library.remove': M<NovelKey, void>;
  'library.setCategories': M<{ keys: string[]; categoryIds: string[] }, LibraryEntry[]>;
  /** Mark every non-locked chapter of these library novels read/unread (bulk, no per-novel novel.get). */
  'library.markRead': M<{ keys: string[]; read: boolean }, LibraryEntry[]>;
  /** novels: per-novel new-chapter counts, most-new first; failed: novels that errored or whose source is paused. */
  'library.checkUpdates': M<{ keys?: string[] }, { newChapters: number; novels?: { key: string; name: string; newChapters: number }[]; failed?: number }>;
  'categories.list': M<void, Category[]>;
  'categories.save': M<{ categories: Category[] }, Category[]>;

  // progress
  'progress.save': M<
    { pluginId: string; novelPath: string; chapterPath: string; position: ChapterPosition; finished?: boolean },
    void
  >;
  'progress.markRead': M<{ pluginId: string; novelPath: string; chapterPaths: string[]; read: boolean }, void>;
  'progress.bookmark': M<{ pluginId: string; novelPath: string; chapterPath: string; bookmarked: boolean }, void>;

  // history & updates
  'history.list': M<{ limit?: number; before?: number }, HistoryEntry[]>;
  'history.remove': M<NovelKey, void>;
  'history.clear': M<void, void>;
  'updates.list': M<{ limit?: number }, UpdateEntry[]>;

  // storage & downloads
  'storage.usage': M<void, StorageUsage>;
  'storage.clear': M<{ category: Exclude<StorageCategory, 'state' | 'meta'> }, StorageUsage>;
  'downloads.enqueue': M<{ pluginId: string; novelPath: string; chapterPaths: string[] }, void>;
  'downloads.delete': M<{ pluginId: string; novelPath: string; chapterPaths?: string[] }, void>;
  /** User-confirmed: delete downloads of novels not in the library (never touches library novels). Returns what was removed. */
  'downloads.deleteOrphans': M<void, { novels: number; bytes: number }>;

  // backup & restore (files live in iCloud TachiNovel/backups/, so they're also visible on the PC)
  /** Write a backup (settings, library, categories, progress, history, updates, installed sources + repos). */
  'backup.create': M<void, BackupInfo>;
  'backup.list': M<void, BackupInfo[]>;
  /** Restore from a listed backup, or (no fileName) let the user pick a .json file with the native document picker. */
  /**
   * Read a backup without applying it: what it holds and what a restore would add. With no fileName the user picks a
   * file; the returned importId then restores exactly that file without picking again. Bad files → INVALID_ARGS.
   */
  'backup.preview': M<{ fileName?: string }, BackupPreview>;
  'backup.restore': M<{ fileName?: string; importId?: string; mode: 'merge' | 'replace' }, { novels: number; sources: number }>;
  /** Share a backup file through the native share sheet. */
  'backup.share': M<{ fileName: string }, void>;
  /** Write local exports/tachinovel-library-YYYY-MM-DD.<csv|txt> (name, source, URL, read/total, status, categories, last read) and open the share sheet. */
  'library.export': M<{ format: 'csv' | 'text' }, { fileName: string; novels: number }>;

  // stats, migrate, cleanup
  /** days = range for `days` and `topNovels` (default 30); `totalMs` and `streakDays` are all-time. */
  'stats.get': M<{ days?: number }, ReadingStats>;
  /** Match chapters between two sources by chapter number/name and report what would carry over. */
  'migrate.preview': M<{ from: NovelKey; to: NovelKey }, { matched: number; unmatched: number; readCarried: number; lastChapterName?: string }>;
  /** Move a library novel to another source, carrying read marks, bookmarks, position, categories, history. */
  'migrate.apply': M<{ from: NovelKey; to: NovelKey; keepOld: boolean }, LibraryEntry>;
  /**
   * Preview a cleanup rule on one chapter: which text blocks it would hide. Rules match per top-level
   * block (paragraph), case-insensitively: plain text = "contains", regex = compiled with the `i` flag.
   */
  'cleanup.test': M<{ rule: CleanupRule; pluginId: string; novelPath: string; chapterPath: string }, { removed: string[] }>;

  // PC narration (tachinovel-narrator reads audio.json and writes narration-status.json in the synced folder)
  'narration.get': M<void, { config: NarrationConfig; status: NarrationStatus | null }>;
  'narration.set': M<{ config: NarrationConfig }, NarrationConfig>;

  // covers
  /**
   * Fetch a cover through the script (native Request: no CORS/CORP, plugin image headers + Referer applied),
   * cache it in local covers/ (LRU), and return a src the UI can load: a path relative to the UI file
   * ("covers/<file>"). Used when a direct <img> load fails (CP1: Stonescape sends Cross-Origin-Resource-Policy).
   */
  'covers.fetch': M<{ pluginId: string; url: string }, { src: string }>;
  /**
   * Same as covers.fetch for in-chapter images (illustrations) whose direct <img> load failed: cached in
   * local cache/ (the read-ahead LRU, not covers/), downscaled natively only when wider than 1320 px.
   */
  'images.fetch': M<{ pluginId: string; url: string }, { src: string }>;

  // native iOS pieces
  'native.actionSheet': M<{ title?: string; message?: string; actions: NativeAction[]; cancel?: string }, { index: number }>;
  'native.alert': M<{ title: string; message?: string; actions: NativeAction[]; cancel?: string }, { index: number }>;
  'native.share': M<{ text?: string; url?: string }, void>;
  /** Share a UI-rendered image (`data:image/png|jpeg;base64,…`, ≤ 8 MB) via the native share sheet (Save Image, Messages, …). */
  'native.shareImage': M<{ dataUrl: string; fileName?: string }, void>;
  'native.openUrl': M<{ url: string }, void>;
  /** SF Symbol names → data:image/png;base64 URLs (rendered white on transparent; tint via CSS mask). */
  'native.symbols': M<{ names: string[]; size?: number }, Record<string, string>>;
  'native.device': M<void, DeviceInfo>;
  'native.setBrightness': M<{ value: number }, void>;
}

export type MethodName = keyof BridgeMethods;
export type MethodArgs<K extends MethodName> = BridgeMethods[K]['args'];
export type MethodResult<K extends MethodName> = BridgeMethods[K]['result'];

// ---------- events (script → UI) ----------

export interface BridgeEvents {
  'library.changed': { library: LibraryEntry[] };
  'updates.progress': { done: number; total: number; current?: string; newChapters: number; finished: boolean };
  'downloads.progress': { pluginId: string; novelPath: string; done: number; total: number; finished: boolean };
  'chapter.prefetched': { pluginId: string; novelPath: string; chapterPath: string };
  'app.error': { message: string };
  /** A deep link arrived while the app was already open (e.g. from the widget). */
  'app.deepLink': { pluginId: string; novelPath: string; chapterPath?: string };
}

export type EventName = keyof BridgeEvents;

// ---------- client interface (UI side) ----------

export interface CallOptions {
  /** Default 30 s; chapter/novel calls typically use 60 s. */
  timeoutMs?: number;
}

export interface BridgeClient {
  call<K extends MethodName>(
    method: K,
    ...args: MethodArgs<K> extends void ? [args?: undefined, opts?: CallOptions] : [args: MethodArgs<K>, opts?: CallOptions]
  ): Promise<MethodResult<K>>;
  on<E extends EventName>(event: E, fn: (payload: BridgeEvents[E]) => void): () => void;
}

/** Error thrown by BridgeClient.call when the script returns ok:false or the call times out. */
export class BridgeCallError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly reason?: SourceFailureReason;
  constructor(err: BridgeError) {
    super(err.message);
    this.name = 'BridgeCallError';
    this.code = err.code;
    this.retryable = err.retryable;
    if (err.reason) this.reason = err.reason;
  }
}

// ---------- server interface (script side) ----------

export type MethodHandlers = {
  [K in MethodName]: (args: MethodArgs<K>) => Promise<MethodResult<K>>;
};
