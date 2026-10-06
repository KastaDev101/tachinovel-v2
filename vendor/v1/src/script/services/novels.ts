/**
 * Novel pages, library membership and update checks.
 *
 * novel.get refresh policy:
 * - Library novel with stored metadata, no `refresh` → served from `meta/` (fromCache: true); the UI
 *   may then ask again with `refresh: true`.
 * - Library novel without metadata, or `refresh` → fetched, stored, entry counts updated, newly seen
 *   chapters recorded as updates.
 * - Browsed-only novel → memory copy if younger than novelMemoryTtlMs (fromCache: true), else fetched.
 */
import type {
  ChapterMeta,
  ChapterView,
  LibraryEntry,
  NovelDetails,
  NovelKey,
  NovelSummary,
  UpdateEntry,
} from '../../shared/contracts/domain.ts';
import { novelKeyString, parseNovelKey } from '../../shared/contracts/domain.ts';
import type { NovelPage } from '../../shared/contracts/protocol.ts';
import { Inflight, type Lane, mapLimit } from '../lib/async.ts';
import { AppError, errorCode, errorMessage, invalidArgs } from '../lib/errors.ts';
import type { Ctx } from './context.ts';
import type { CoverCache } from './covers.ts';
import type { DownloadService } from './downloads.ts';
import type { LibraryService } from './library.ts';
import { type NovelData, type NovelStore, trimChapters } from './novel-store.ts';
import type { NovelProgress, ProgressService } from './progress.ts';
import type { SourceService } from './sources.ts';
import type { UpdatesService } from './updates.ts';

export const UPDATE_CONCURRENCY = 3;
const SOURCE_FAILURE_CODES = new Set(['NETWORK', 'TIMEOUT', 'CLOUDFLARE', 'PLUGIN']);

/** Unread = not read and not locked (locked chapters can't be read, so they never count). */
export function countUnread(chapters: readonly ChapterMeta[], read: ReadonlySet<string>): number {
  let n = 0;
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i] as ChapterMeta;
    if (!c.locked && !read.has(c.path)) n++;
  }
  return n;
}

export function chapterViews(chapters: readonly ChapterMeta[], prog: NovelProgress, downloaded: ReadonlySet<string>): ChapterView[] {
  const out = new Array<ChapterView>(chapters.length);
  const positions = prog.value.positions;
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i] as ChapterMeta;
    const read = prog.read.has(c.path);
    const v: ChapterView = { path: c.path, name: c.name, read, bookmarked: prog.bookmarks.has(c.path), downloaded: downloaded.has(c.path) };
    if (c.number !== undefined) v.number = c.number;
    if (c.releaseTime) v.releaseTime = c.releaseTime;
    if (c.locked) v.locked = true;
    if (!read && Object.hasOwn(positions, c.path)) v.progress = (positions[c.path] as { percent: number }).percent;
    out[i] = v;
  }
  return out;
}

/** One novel that got new chapters in an update check. */
export interface UpdateCheckNovel {
  key: string;
  name: string;
  newChapters: number;
}

/**
 * library.checkUpdates result. The wire contract currently declares only `newChapters`; `novels` and
 * `failed` ride along as extras the UI can read once protocol.ts lists them (as optional fields).
 */
export interface UpdateCheckResult {
  newChapters: number;
  /** Novels with new chapters, most first (ties by name). */
  novels: UpdateCheckNovel[];
  /** Novels that couldn't be checked (errors, or their source is paused after repeated failures). */
  failed: number;
}

export interface RefreshResult {
  data: NovelData;
  newChapters: ChapterMeta[];
}

export class NovelService {
  private readonly ctx: Ctx;
  private readonly sources: SourceService;
  private readonly store: NovelStore;
  private readonly library: LibraryService;
  private readonly progress: ProgressService;
  private readonly updates: UpdatesService;
  private readonly covers: CoverCache;
  private readonly downloads: DownloadService;
  private readonly fetches = new Inflight<NovelData>();
  private readonly refreshes = new Inflight<RefreshResult>();
  private updateRun: Promise<UpdateCheckResult> | null = null;

  constructor(
    ctx: Ctx,
    deps: {
      sources: SourceService;
      store: NovelStore;
      library: LibraryService;
      progress: ProgressService;
      updates: UpdatesService;
      covers: CoverCache;
      downloads: DownloadService;
    },
  ) {
    this.ctx = ctx;
    this.sources = deps.sources;
    this.store = deps.store;
    this.library = deps.library;
    this.progress = deps.progress;
    this.updates = deps.updates;
    this.covers = deps.covers;
    this.downloads = deps.downloads;
  }

  /**
   * Network fetch (deduped per novel and lane), normalized. Callers decide where it is kept (memory for
   * browsed novels, meta/ for library novels after diffing against the previous list).
   */
  fetchNovel(key: NovelKey, lane: Lane = 'interactive'): Promise<NovelData> {
    const ks = novelKeyString(key);
    return this.fetches.run(`${lane}|${ks}`, async () => {
      const adapter = await this.sources.adapter(key.pluginId, lane);
      const res = await adapter.novel(key.path);
      if (!res || typeof res !== 'object' || !res.details) throw new AppError('PLUGIN', 'Source returned no novel details');
      const details: NovelDetails = { ...res.details, pluginId: key.pluginId, path: key.path };
      if (!Array.isArray(details.genres)) details.genres = [];
      if (!details.status) details.status = 'unknown';
      return { details, chapters: trimChapters(Array.isArray(res.chapters) ? res.chapters : []), fetchedAt: this.ctx.platform.now() };
    });
  }

  async getPage(a: NovelKey & { refresh?: boolean }): Promise<NovelPage> {
    const key: NovelKey = { pluginId: a.pluginId, path: a.path };
    const ks = novelKeyString(key);
    const inLibrary = this.library.has(ks);
    let data: NovelData | null = null;
    let fromCache = false;
    if (!a.refresh) {
      data = inLibrary ? await this.store.known(ks) : (this.store.peek(ks, this.ctx.timing.novelMemoryTtlMs) ?? null);
      fromCache = data !== null;
    }
    if (!data) {
      if (inLibrary) {
        data = (await this.refreshLibraryNovel(ks, { recordUpdates: true, lane: 'interactive' })).data;
      } else {
        data = await this.fetchNovel(key, 'interactive');
        this.store.remember(ks, data);
      }
    }
    const [prog, downloaded] = await Promise.all([this.progress.get(ks), this.downloads.downloadedSet(ks)]);
    const entry = this.library.get(ks);
    const details = inLibrary && data.details.cover ? { ...data.details, cover: this.covers.resolve(data.details.cover) as string } : data.details;
    const page: NovelPage = {
      details,
      chapters: chapterViews(data.chapters, prog, downloaded),
      inLibrary: !!entry,
      categoryIds: entry ? [...entry.categoryIds] : [],
      fetchedAt: data.fetchedAt,
      fromCache,
    };
    const last = prog.value.lastChapterPath;
    if (last) {
      const position = prog.position(last);
      page.lastRead = position ? { chapterPath: last, position } : { chapterPath: last };
    }
    return page;
  }

  /**
   * Fetch a library novel, store its metadata, update the entry, record new chapters. Deduped per lane.
   * The previous list is read after the fetch, so concurrent refreshes (e.g. an interactive one during
   * an update check) never record the same new chapters twice.
   */
  refreshLibraryNovel(ks: string, opts: { recordUpdates: boolean; lane: Lane }): Promise<RefreshResult> {
    return this.refreshes.run(`${opts.lane}|${ks}`, async () => {
      const key = parseNovelKey(ks);
      const data = await this.fetchNovel(key, opts.lane);
      const old = await this.store.known(ks);
      const oldChapters = old?.chapters ?? [];
      const newChapters: ChapterMeta[] = [];
      if (oldChapters.length > 0 && old !== data) {
        const seen = new Set<string>();
        for (const c of oldChapters) seen.add(c.path);
        for (const c of data.chapters) if (!seen.has(c.path)) newChapters.push(c);
      }
      if (!this.library.has(ks)) {
        this.store.remember(ks, data);
        return { data, newChapters };
      }
      await this.store.persist(ks, data);
      const prog = await this.progress.get(ks);
      const now = this.ctx.platform.now();
      const d = data.details;
      const entry = this.library.update(ks, (e) => {
        if (d.name) e.name = d.name;
        if (d.cover) e.cover = d.cover;
        if (d.author) e.author = d.author;
        e.status = d.status;
        e.chapterCount = data.chapters.length;
        e.unreadCount = countUnread(data.chapters, prog.read);
        if (newChapters.length > 0) e.lastUpdatedAt = now;
      });
      if (entry && opts.recordUpdates && newChapters.length > 0) {
        const records: UpdateEntry[] = [];
        for (let i = newChapters.length - 1; i >= 0; i--) {
          const c = newChapters[i] as ChapterMeta;
          const u: UpdateEntry = { pluginId: key.pluginId, path: key.path, novelName: entry.name, chapterPath: c.path, chapterName: c.name, foundAt: now, read: prog.read.has(c.path) };
          if (entry.cover) u.cover = entry.cover;
          records.push(u);
        }
        await this.updates.add(records);
      }
      if (d.cover) void this.covers.ensure(d.cover, this.sources.imageRequestHeaders(key.pluginId));
      return { data, newChapters };
    });
  }

  async addToLibrary(novel: NovelSummary | NovelDetails, categoryIds?: string[]): Promise<LibraryEntry> {
    const ks = novelKeyString(novel);
    const known = new Set(this.library.categories().map((c) => c.id));
    for (const id of categoryIds ?? []) if (!known.has(id)) throw invalidArgs(`Unknown category "${id}"`);
    const existing = this.library.get(ks);
    if (existing) {
      if (categoryIds) this.library.setCategories([ks], categoryIds);
      return this.library.wireEntry(existing);
    }
    const mem = this.store.peek(ks);
    const [prog, downloadedCount] = await Promise.all([this.progress.get(ks), this.downloads.count(ks)]);
    const details = mem?.details;
    const entry: LibraryEntry = {
      key: ks,
      pluginId: novel.pluginId,
      path: novel.path,
      name: novel.name || details?.name || novel.path,
      addedAt: this.ctx.platform.now(),
      chapterCount: mem ? mem.chapters.length : 0,
      unreadCount: mem ? countUnread(mem.chapters, prog.read) : 0,
      downloadedCount,
      categoryIds: categoryIds ? [...categoryIds] : [],
    };
    const cover = novel.cover ?? details?.cover;
    if (cover) entry.cover = cover;
    const full = 'status' in novel ? novel : details;
    if (full?.status) entry.status = full.status;
    if (full?.author) entry.author = full.author;
    const pv = prog.value;
    if (pv.lastReadAt) entry.lastReadAt = pv.lastReadAt;
    if (pv.lastChapterPath) entry.lastChapterPath = pv.lastChapterPath;
    if (pv.lastChapterName) entry.lastChapterName = pv.lastChapterName;
    this.library.add(entry);

    if (mem) {
      await this.store.persist(ks, mem);
    } else {
      // Added straight from a browse result: fetch the chapter list in the background.
      void this.refreshLibraryNovel(ks, { recordUpdates: false, lane: 'background' }).then(
        () => this.library.notifyChanged(),
        (err: unknown) => this.ctx.platform.log('warn', `Initial fetch failed for ${ks}: ${errorMessage(err)}`),
      );
    }
    if (cover) {
      void this.covers.ensure(cover, this.sources.imageRequestHeaders(novel.pluginId)).then((ref) => {
        if (ref) this.library.notifyChanged();
      });
    }
    return this.library.wireEntry(entry);
  }

  async removeFromLibrary(key: NovelKey): Promise<void> {
    const ks = novelKeyString(key);
    const e = this.library.remove(ks);
    if (!e) return;
    this.store.delete(ks);
    this.covers.remove(e.cover);
    await this.updates.removeNovel(ks);
  }

  /**
   * Update check over the library (or `keys`), concurrency 3, with `updates.progress` events.
   * The result also lists the novels that got chapters (most first) and how many couldn't be checked,
   * so the UI can say "3 new · Shadow Slave" or "2 couldn't be checked".
   */
  checkUpdates(keys?: string[]): Promise<UpdateCheckResult> {
    this.updateRun ??= this.runCheck(keys).finally(() => {
      this.updateRun = null;
    });
    return this.updateRun;
  }

  private async runCheck(keys?: string[]): Promise<UpdateCheckResult> {
    const targets = (keys ?? this.library.all().map((e) => e.key)).filter((k) => this.library.has(k));
    const total = targets.length;
    let done = 0;
    let newChapters = 0;
    let failed = 0;
    const novels: UpdateCheckNovel[] = [];
    const { events } = this.ctx;
    events.emit('updates.progress', { done, total, newChapters, finished: false });
    const skipped = new Set<string>();
    await mapLimit(targets, UPDATE_CONCURRENCY, async (ks) => {
      const name = this.library.get(ks)?.name;
      const { pluginId } = parseNovelKey(ks);
      if (this.sources.updateCheckPaused(pluginId)) {
        // A source that kept failing (down, blocked) is left alone for a while instead of timing out per novel.
        if (!skipped.has(pluginId)) {
          skipped.add(pluginId);
          this.ctx.platform.log('info', `Update check: skipping ${pluginId} (recent failures)`);
        }
        failed++;
      } else {
        try {
          const r = await this.refreshLibraryNovel(ks, { recordUpdates: true, lane: 'background' });
          newChapters += r.newChapters.length;
          if (r.newChapters.length > 0) novels.push({ key: ks, name: this.library.get(ks)?.name ?? name ?? ks, newChapters: r.newChapters.length });
          this.sources.recordUpdateCheck(pluginId, true);
        } catch (err) {
          failed++;
          this.ctx.platform.log('warn', `Update check failed for ${ks}: ${errorMessage(err)}`);
          // Only source-level trouble counts against the source (not e.g. one removed novel).
          if (SOURCE_FAILURE_CODES.has(errorCode(err) ?? '')) this.sources.recordUpdateCheck(pluginId, false);
        }
      }
      done++;
      const p: { done: number; total: number; current?: string; newChapters: number; finished: boolean } = { done, total, newChapters, finished: false };
      if (name) p.current = name;
      events.emit('updates.progress', p);
    });
    events.emit('updates.progress', { done, total, newChapters, finished: true });
    this.library.notifyChanged();
    novels.sort((a, b) => b.newChapters - a.newChapters || a.name.localeCompare(b.name));
    this.ctx.platform.log('info', `Update check: ${newChapters} new in ${novels.length}/${total} novels${failed ? `, ${failed} not checked` : ''}`);
    return { newChapters, novels, failed };
  }
}
