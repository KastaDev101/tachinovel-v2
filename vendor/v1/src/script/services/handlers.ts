/**
 * Bridge method handlers: argument validation + dispatch to services. Every method in BridgeMethods
 * is implemented (the MethodHandlers type enforces it).
 */
import type { AppSettings, Category, ChapterPosition, NovelDetails, NovelSummary, StorageCategory, UpdateEntry } from '../../shared/contracts/domain.ts';
import { novelKeyString } from '../../shared/contracts/domain.ts';
import type { LogLevel } from '../../shared/contracts/platform.ts';
import type { BootPayload, MethodHandlers, NativeAction } from '../../shared/contracts/protocol.ts';
import { invalidArgs } from '../lib/errors.ts';
import { readLogEntries } from '../lib/log-file.ts';
import {
  type Obj,
  bool,
  httpUrl,
  isHttpUrl,
  num,
  obj,
  oneOf,
  optBool,
  optNum,
  optObj,
  optStr,
  optStrArray,
  str,
  strArray,
} from '../lib/validate.ts';
import type { Services } from './services.ts';
import { isCleanupRule } from './settings.ts';
import { storageUsage } from './storage-usage.ts';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const LOG_VIEW_LEVELS = ['warn', 'error'] as const;
const STATUSES = ['ongoing', 'completed', 'hiatus', 'cancelled', 'unknown'] as const;
const CLEARABLE = ['cache', 'covers', 'downloads', 'logs'] as const;
const MAX_CHAPTER_PATHS = 20_000;

function run<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * UpdateEntry.downloaded from the download manifests: one lookup per novel in the list (a cached
 * manifest, or a single exists() check for novels without downloads). Stored entries are not touched.
 */
async function withDownloaded(s: Services, entries: readonly UpdateEntry[]): Promise<UpdateEntry[]> {
  const sets = new Map<string, Promise<ReadonlySet<string>>>();
  return Promise.all(
    entries.map(async (e) => {
      const key = novelKeyString(e);
      let set = sets.get(key);
      if (!set) {
        set = s.downloads.downloadedSet(key).catch(() => new Set<string>());
        sets.set(key, set);
      }
      return { ...e, downloaded: (await set).has(e.chapterPath) };
    }),
  );
}

/** Methods whose args are an optional object. */
function optArgs(args: unknown): Obj {
  return args === undefined || args === null ? {} : obj(args);
}

function novelKeyArgs(o: Obj): { pluginId: string; path: string } {
  return { pluginId: str(o, 'pluginId', { max: 200 }), path: str(o, 'path') };
}

function novelKeyArg(o: Obj, k: string): { pluginId: string; path: string } {
  const v = optObj(o, k);
  if (!v) throw invalidArgs(`${k} must be {pluginId, path}`);
  return novelKeyArgs(v);
}

function chapterArgs(o: Obj): { pluginId: string; novelPath: string; chapterPath: string } {
  return { pluginId: str(o, 'pluginId', { max: 200 }), novelPath: str(o, 'novelPath'), chapterPath: str(o, 'chapterPath') };
}

function position(o: Obj): ChapterPosition {
  const p = optObj(o, 'position');
  if (!p) throw invalidArgs('position must be an object');
  const out: ChapterPosition = {
    percent: Math.min(1, Math.max(0, num(p, 'percent'))),
    paragraph: num(p, 'paragraph', { min: 0 }),
  };
  const offset = optNum(p, 'offset');
  if (offset !== undefined) out.offset = offset;
  return out;
}

function actions(o: Obj): NativeAction[] {
  const v = o.actions;
  if (!Array.isArray(v) || v.length > 30) throw invalidArgs('actions must be an array (max 30)');
  return v.map((a, i) => {
    const ao = obj(a, `actions[${i}]`);
    const action: NativeAction = { title: str(ao, 'title', { max: 200 }) };
    if (optBool(ao, 'destructive')) action.destructive = true;
    return action;
  });
}

/** Anything that isn't one of the given actions (cancel, dismissal, odd platform values) is -1. */
function actionIndex(index: number, count: number): number {
  return Number.isInteger(index) && index >= 0 && index < count ? index : -1;
}

function novelArg(o: Obj): NovelSummary | NovelDetails {
  const n = optObj(o, 'novel');
  if (!n) throw invalidArgs('novel must be an object');
  const summary: NovelSummary = { pluginId: str(n, 'pluginId', { max: 200 }), path: str(n, 'path'), name: str(n, 'name', { max: 1000 }) };
  // Only remote covers are stored (a local "covers/…" path from a wire entry would go stale).
  const cover = optStr(n, 'cover', { max: 4096, allowEmpty: true });
  if (cover && isHttpUrl(cover)) summary.cover = cover;
  const author = optStr(n, 'author', { max: 1000, allowEmpty: true });
  const status = n.status === undefined || n.status === null ? undefined : oneOf(n, 'status', STATUSES);
  if (author === undefined && status === undefined) return summary;
  const details: NovelDetails = { ...summary, status: status ?? 'unknown', genres: [] };
  if (author) details.author = author;
  return details;
}

function categoriesArg(o: Obj): Category[] {
  const v = o.categories;
  if (!Array.isArray(v) || v.length > 200) throw invalidArgs('categories must be an array (max 200)');
  return v.map((c, i) => {
    const co = obj(c, `categories[${i}]`);
    return { id: str(co, 'id', { max: 64 }), name: str(co, 'name', { max: 100 }), order: num(co, 'order') };
  });
}

/** Only categories that exist; unknown ids fall back to Default (no category). */
function knownCategories(s: Services, ids: readonly string[]): string[] {
  const known = new Set(s.library.categories().map((c) => c.id));
  return [...new Set(ids)].filter((id) => known.has(id));
}

/** Categories for library.add without an explicit choice (settings.library.addTo). */
function defaultAddCategories(s: Services): string[] {
  const lib = s.ctx.settings().library;
  if (lib.addTo === 'last') return knownCategories(s, lib.lastAddCategoryIds);
  if (lib.addTo === 'ask') return []; // the UI asks; without an answer the novel goes to Default
  return knownCategories(s, [lib.addTo]);
}

/** Explicit category choices become the 'last' used ones. */
function rememberAddCategories(s: Services, ids: string[]): void {
  const lib = s.settingsDoc.value.library;
  if (lib.lastAddCategoryIds.length === ids.length && lib.lastAddCategoryIds.every((id, i) => id === ids[i])) return;
  lib.lastAddCategoryIds = [...ids];
  s.settingsDoc.changed();
}

export interface AppControl {
  boot(): BootPayload;
  setSettings(patch: unknown): AppSettings;
  /** Persist every pending debounced write now. */
  flush(): Promise<void>;
  /** Write buffered log lines to the device log (before app.logs reads it). */
  flushLogs?(): Promise<void>;
}

export function createHandlers(s: Services, app: AppControl): MethodHandlers {
  const { platform } = s.ctx;
  return {
    // ---------- app ----------
    'app.boot': () => run(() => app.boot()),
    'app.log': (args) =>
      run(() => {
        const o = obj(args);
        const level = oneOf(o, 'level', LEVELS);
        const message = str(o, 'message', { max: 20_000, allowEmpty: true });
        platform.log(level, `[ui] ${message}`, o.data);
      }),
    'app.logs': (args) =>
      run(async () => {
        const o = optArgs(args);
        const level = o.level === undefined ? 'warn' : oneOf(o, 'level', LOG_VIEW_LEVELS);
        const limit = optNum(o, 'limit', { min: 1, max: 100, int: true }) ?? 20;
        try {
          await app.flushLogs?.();
        } catch {
          // Show what is on disk.
        }
        // Messages only (≤300 chars), never data payloads.
        return readLogEntries(platform.local, { minLevel: level, limit, maxMessage: 300 });
      }),
    // UI: visibilitychange → hidden (iOS may kill a backgrounded Scriptable before debounces fire).
    'app.flush': () => run(() => app.flush()),
    'settings.set': (args) => run(() => app.setSettings(obj(args).patch)),

    // ---------- sources & repos ----------
    'sources.list': () => run(() => s.sources.list()),
    'sources.setEnabled': (args) =>
      run(() => {
        const o = obj(args);
        return s.sources.setEnabled(str(o, 'id'), bool(o, 'enabled'));
      }),
    'sources.setPinned': (args) =>
      run(() => {
        const o = obj(args);
        return s.sources.setPinned(str(o, 'id'), bool(o, 'pinned'));
      }),
    'sources.filters': (args) => run(() => s.sources.filters(str(obj(args), 'id', { max: 200 }))),
    'sources.available': (args) =>
      run(() => {
        const o = optArgs(args);
        const repoUrl = optStr(o, 'repoUrl', { max: 4096 });
        return s.sources.available(repoUrl, optBool(o, 'allLanguages') === true);
      }),
    'sources.install': (args) =>
      run(() => {
        const o = obj(args);
        if (typeof o.url === 'string') return s.sources.install({ url: httpUrl(o, 'url') });
        if (typeof o.code === 'string') return s.sources.install({ code: str(o, 'code', { max: 2 * 1024 * 1024 }) });
        throw invalidArgs('Provide url or code');
      }),
    'sources.uninstall': (args) => run(() => s.sources.uninstall(str(obj(args), 'id'))),
    'sources.update': (args) => run(() => s.sources.update(str(obj(args), 'id'))),
    'repos.list': () => run(() => s.sources.repos()),
    'repos.add': (args) => run(() => s.sources.addRepo(httpUrl(obj(args), 'url'))),
    'repos.remove': (args) => run(() => s.sources.removeRepo(str(obj(args), 'url', { max: 4096 }))),

    // ---------- browse ----------
    'browse.list': (args) =>
      run(() => {
        const o = obj(args);
        const a: { pluginId: string; page: number; mode: 'popular' | 'latest'; filters?: Record<string, unknown> } = {
          pluginId: str(o, 'pluginId', { max: 200 }),
          page: num(o, 'page', { min: 1, int: true }),
          mode: oneOf(o, 'mode', ['popular', 'latest'] as const),
        };
        const filters = optObj(o, 'filters');
        if (filters) a.filters = filters;
        return s.browse.list(a);
      }),
    'browse.search': (args) =>
      run(() => {
        const o = obj(args);
        return s.browse.search({
          pluginId: str(o, 'pluginId', { max: 200 }),
          query: str(o, 'query', { max: 500 }),
          page: num(o, 'page', { min: 1, int: true }),
        });
      }),
    'browse.globalSearch': (args) => run(() => s.browse.globalSearch(str(obj(args), 'query', { max: 500 }))),

    // ---------- novel & chapters ----------
    'novel.get': (args) =>
      run(() => {
        const o = obj(args);
        const refresh = optBool(o, 'refresh');
        return s.novels.getPage(refresh === undefined ? novelKeyArgs(o) : { ...novelKeyArgs(o), refresh });
      }),
    'chapter.get': (args) => run(() => s.chapters.get(chapterArgs(obj(args)))),

    // ---------- library ----------
    'library.list': () => run(() => s.library.wire()),
    'library.add': (args) =>
      run(() => {
        const o = obj(args);
        const novel = novelArg(o);
        const explicit = optStrArray(o, 'categoryIds', { max: 200, maxLen: 64 });
        if (explicit) {
          const ids = knownCategories(s, explicit);
          rememberAddCategories(s, ids);
          return s.novels.addToLibrary(novel, ids);
        }
        // No explicit choice: an existing entry keeps its categories; a new one follows settings.library.addTo.
        const existing = s.library.has(novelKeyString(novel));
        return s.novels.addToLibrary(novel, existing ? undefined : defaultAddCategories(s));
      }),
    'library.remove': (args) => run(() => s.novels.removeFromLibrary(novelKeyArgs(obj(args)))),
    'library.setCategories': (args) =>
      run(() => {
        const o = obj(args);
        const ids = knownCategories(s, strArray(o, 'categoryIds', { max: 200, maxLen: 64 }));
        s.library.setCategories(strArray(o, 'keys', { max: 10_000 }), ids);
        rememberAddCategories(s, ids);
        return s.library.wire();
      }),
    'library.markRead': (args) =>
      run(async () => {
        const o = obj(args);
        await s.reading.markLibraryRead(strArray(o, 'keys', { max: 10_000 }), bool(o, 'read'));
        return s.library.wire();
      }),
    'library.checkUpdates': (args) => run(() => s.novels.checkUpdates(optStrArray(optArgs(args), 'keys', { max: 10_000 }))),
    'categories.list': () => run(() => s.library.categories()),
    'categories.save': (args) => run(() => s.library.saveCategories(categoriesArg(obj(args)))),

    // ---------- progress ----------
    'progress.save': (args) =>
      run(() => {
        const o = obj(args);
        const a: { pluginId: string; novelPath: string; chapterPath: string; position: ChapterPosition; finished?: boolean } = {
          ...chapterArgs(o),
          position: position(o),
        };
        const finished = optBool(o, 'finished');
        if (finished !== undefined) a.finished = finished;
        return s.reading.save(a);
      }),
    'progress.markRead': (args) =>
      run(() => {
        const o = obj(args);
        return s.reading.markRead({
          pluginId: str(o, 'pluginId', { max: 200 }),
          novelPath: str(o, 'novelPath'),
          chapterPaths: strArray(o, 'chapterPaths', { max: MAX_CHAPTER_PATHS }),
          read: bool(o, 'read'),
        });
      }),
    'progress.bookmark': (args) =>
      run(() => {
        const o = obj(args);
        return s.reading.bookmark({ ...chapterArgs(o), bookmarked: bool(o, 'bookmarked') });
      }),

    // ---------- history & updates ----------
    'history.list': (args) =>
      run(() => {
        const o = optArgs(args);
        const recent = s.history.list(optNum(o, 'limit', { min: 1, max: 1000, int: true }) ?? 50, optNum(o, 'before'));
        return recent.map((h) => {
          const cover = s.covers.localRef(h.cover);
          return cover ? { ...h, cover } : h;
        });
      }),
    'history.remove': (args) => run(() => s.history.remove(novelKeyArgs(obj(args)))),
    'history.clear': () => run(() => s.history.clear()),
    'updates.list': (args) => run(async () => withDownloaded(s, await s.updates.list(optNum(optArgs(args), 'limit', { min: 1, max: 1000, int: true }) ?? 100))),

    // ---------- storage & downloads ----------
    'storage.usage': () => run(() => storageUsage(s)),
    'storage.clear': (args) =>
      run(async () => {
        const category: Exclude<StorageCategory, 'state' | 'meta'> = oneOf(obj(args), 'category', CLEARABLE);
        if (category === 'cache') s.chapters.clearCache();
        else if (category === 'covers') {
          s.covers.clear();
          s.library.notifyChanged();
        } else if (category === 'downloads') await s.downloads.clearAll();
        else {
          // The device log and its iCloud mirror (lib/log-file.ts).
          platform.local.remove('logs');
          if (platform.synced.root !== platform.local.root) platform.synced.remove('logs');
        }
        return storageUsage(s);
      }),
    'downloads.enqueue': (args) =>
      run(() => {
        const o = obj(args);
        const pluginId = str(o, 'pluginId', { max: 200 });
        const novelPath = str(o, 'novelPath');
        const paths = strArray(o, 'chapterPaths', { max: MAX_CHAPTER_PATHS });
        if (!s.sources.get(pluginId)) throw invalidArgs(`Source "${pluginId}" is not installed`);
        s.downloads.enqueue({ pluginId, path: novelPath }, paths);
      }),
    'downloads.delete': (args) =>
      run(() => {
        const o = obj(args);
        return s.downloads.delete({ pluginId: str(o, 'pluginId', { max: 200 }), path: str(o, 'novelPath') }, optStrArray(o, 'chapterPaths', { max: MAX_CHAPTER_PATHS }));
      }),

    // ---------- backup & restore ----------
    'backup.create': () => run(() => s.backup.create()),
    'backup.list': () => run(() => s.backup.list()),
    'backup.restore': (args) =>
      run(() => {
        const o = obj(args);
        const mode = oneOf(o, 'mode', ['merge', 'replace'] as const);
        const fileName = optStr(o, 'fileName', { max: 255 });
        return s.backup.restore(fileName === undefined ? { mode } : { fileName, mode });
      }),
    'backup.share': (args) => run(() => s.backup.share(str(obj(args), 'fileName', { max: 255 }))),

    // ---------- stats, migrate, cleanup, Cloudflare ----------
    'stats.get': (args) => run(() => s.stats.get(optNum(optArgs(args), 'days', { min: 1, max: 400, int: true }) ?? 30)),
    'migrate.preview': (args) =>
      run(() => {
        const o = obj(args);
        return s.migrate.preview(novelKeyArg(o, 'from'), novelKeyArg(o, 'to'));
      }),
    'migrate.apply': (args) =>
      run(() => {
        const o = obj(args);
        return s.migrate.apply(novelKeyArg(o, 'from'), novelKeyArg(o, 'to'), bool(o, 'keepOld'));
      }),
    'cleanup.test': (args) =>
      run(async () => {
        const o = obj(args);
        const rule = o.rule;
        if (!isCleanupRule(rule)) throw invalidArgs('rule must be {id, pattern, regex, scope, enabled}');
        const removed = await s.chapters.cleanupPreview(chapterArgs(o), rule);
        return { removed };
      }),
    'sources.solveChallenge': (args) => run(() => s.sources.solveChallenge(str(obj(args), 'pluginId', { max: 200 }))),

    // ---------- covers ----------
    'covers.fetch': (args) =>
      run(async () => {
        const o = obj(args);
        const pluginId = str(o, 'pluginId', { max: 200 });
        const url = httpUrl(o, 'url');
        return { src: await s.covers.fetch(url, s.sources.imageRequestHeaders(pluginId)) };
      }),

    // ---------- native ----------
    'native.actionSheet': (args) =>
      run(async () => {
        const o = obj(args);
        const opts: { title?: string; message?: string; actions: NativeAction[]; cancel?: string } = { actions: actions(o) };
        const title = optStr(o, 'title', { max: 500, allowEmpty: true });
        const message = optStr(o, 'message', { max: 2000, allowEmpty: true });
        const cancel = optStr(o, 'cancel', { max: 100 });
        if (title) opts.title = title;
        if (message) opts.message = message;
        if (cancel) opts.cancel = cancel;
        return { index: actionIndex(await platform.native.actionSheet(opts), opts.actions.length) };
      }),
    'native.alert': (args) =>
      run(async () => {
        const o = obj(args);
        const opts: { title: string; message?: string; actions: NativeAction[]; cancel?: string } = {
          title: str(o, 'title', { max: 500, allowEmpty: true }),
          actions: actions(o),
        };
        const message = optStr(o, 'message', { max: 2000, allowEmpty: true });
        const cancel = optStr(o, 'cancel', { max: 100 });
        if (message) opts.message = message;
        if (cancel) opts.cancel = cancel;
        return { index: actionIndex(await platform.native.alert(opts), opts.actions.length) };
      }),
    'native.share': (args) =>
      run(() => {
        const o = obj(args);
        const opts: { text?: string; url?: string } = {};
        const text = optStr(o, 'text', { max: 10_000 });
        if (text) opts.text = text;
        if (o.url !== undefined && o.url !== null) opts.url = httpUrl(o, 'url');
        if (!opts.text && !opts.url) throw invalidArgs('Provide text or url');
        return platform.native.share(opts);
      }),
    'native.openUrl': (args) => run(() => platform.native.openUrl(httpUrl(obj(args), 'url'))),
    'native.symbols': (args) =>
      run(() => {
        const o = obj(args);
        const names = strArray(o, 'names', { max: 300, maxLen: 100 });
        for (const n of names) if (!/^[a-z0-9.]+$/.test(n)) throw invalidArgs(`Invalid SF Symbol name "${n}"`);
        const size = optNum(o, 'size', { min: 8, max: 256 });
        return s.symbols.render(names, size);
      }),
    'native.device': () => run(() => platform.native.device()),
    'native.setBrightness': (args) => run(() => platform.native.setBrightness(num(obj(args), 'value', { min: 0, max: 1 }))),
  };
}
