/**
 * chapter.get: downloads → read-ahead cache → network. Read-ahead of the next chapters
 * (settings.readAhead) is anchored to the chapter actually being read — it starts from progress.save
 * (readAheadFrom), never from chapter.get, so the UI's own prefetch calls don't cascade into more
 * downloads. The plugin's stylesheet
 * text (customCSS; raw, the UI sanitizes/scopes it) is attached when the source has one.
 *
 * Cache: local `cache/<hash(novelKey + "\n" + chapterPath)>.json` = {k, p, t, h}, byte-capped LRU
 * (settings.cacheCapMB).
 *
 * Access rule: content is only ever requested for a chapter whose ChapterMeta we have seen unlocked.
 * When the chapter list isn't known (browsed novel after a relaunch, deep link), it is fetched first
 * (and kept for the session); chapters missing from the list are refused. Already downloaded/cached
 * chapters are served without a list (nothing is requested from the source).
 */

export type ChapterListLoader = (novel: NovelKey, lane: Lane) => Promise<readonly ChapterMeta[]>;

interface ChapterRef {
  chapters: readonly ChapterMeta[];
  idx: number;
  meta: ChapterMeta;
}
import type { ChapterMeta, CleanupRule, NovelKey } from '../../shared/contracts/domain.ts';
import { novelKeyString } from '../../shared/contracts/domain.ts';
import type { ChapterContent } from '../../shared/contracts/protocol.ts';
import { Inflight, type Lane } from '../lib/async.ts';
import { AppError, errorMessage, notFound } from '../lib/errors.ts';
import { hashKey } from '../lib/hash.ts';
import { LruStore } from '../storage/lru.ts';
import { applyCleanup, compileRule, rulesFor } from './cleanup.ts';
import { type Ctx, MB } from './context.ts';
import type { DownloadService } from './downloads.ts';
import { type NovelStore, chapterIndex } from './novel-store.ts';
import { polishChapterHtml } from './polish.ts';
import type { ProgressService } from './progress.ts';
import type { SourceService } from './sources.ts';

interface CacheFile {
  k: string;
  p: string;
  t: string;
  h: string;
}

export const CACHE_DIR = 'cache';

/** Read-ahead never goes beyond this many chapters (the settings maximum). */
export const MAX_READ_AHEAD = 3;
/** Chapters read faster than this (median of the last ones) count as fast reading. */
export const FAST_CHAPTER_MS = 3 * 60_000;
/** Chapters smaller than this (cached HTML) are short: one ahead may not cover a minute of reading. */
export const SHORT_CHAPTER_BYTES = 6 * 1024;
/** Time on a chapter longer than this isn't reading pace (the app sat open, or a break). */
const MAX_PACE_SAMPLE_MS = 60 * 60_000;

export function cacheFileName(key: string, chapterPath: string): string {
  return `${hashKey(`${key}\n${chapterPath}`)}.json`;
}

export class ChapterService {
  private readonly ctx: Ctx;
  private readonly sources: SourceService;
  private readonly novels: NovelStore;
  private readonly progress: ProgressService;
  private readonly downloads: DownloadService;
  readonly cache: LruStore;
  private readonly fetches = new Inflight<string>();
  /** Last opened chapter title per novel (history names when the chapter list isn't in memory). */
  private readonly titles = new Map<string, { path: string; title: string }>();
  private readonly prefetching = new Set<string>();
  /** novelKey → read-ahead generation: skipping through chapters cancels the older loops. */
  private readonly aheadGen = new Map<string, number>();
  /** Reading pace per novel: chapter being read, when it was started, recent time per chapter (ms). */
  private readonly pace = new Map<string, { path: string; at: number; recent: number[] }>();
  private listLoader: ChapterListLoader | null = null;

  constructor(ctx: Ctx, sources: SourceService, novels: NovelStore, progress: ProgressService, downloads: DownloadService) {
    this.ctx = ctx;
    this.sources = sources;
    this.novels = novels;
    this.progress = progress;
    this.downloads = downloads;
    this.cache = new LruStore({
      store: ctx.platform.local,
      dir: CACHE_DIR,
      capBytes: () => ctx.settings().cacheCapMB * MB,
      env: ctx.env,
      indexDelayMs: ctx.timing.indexWriteMs,
    });
    downloads.setFetcher(async (key, novel, chapterPath) => {
      const cached = await this.readCache(key, chapterPath);
      if (cached) return cached;
      const ref = await this.resolveChapter(key, novel, chapterPath, 'background');
      return { html: await this.fetchChapter(key, novel.pluginId, chapterPath, ref.meta.name, false, 'background'), title: ref.meta.name };
    });
  }

  /** How to fetch a novel's chapter list when it isn't known (wired by the composition root). */
  setChapterListLoader(loader: ChapterListLoader): void {
    this.listLoader = loader;
  }

  /** The novel's chapter list: known (memory/meta), else fetched on `lane` and kept for the session. */
  async chapterList(key: string, novel: NovelKey, lane: Lane): Promise<readonly ChapterMeta[]> {
    const known = await this.novels.known(key);
    if (known) return known.chapters;
    if (!this.listLoader) throw notFound(`Unknown novel ${key}`);
    return this.listLoader(novel, lane);
  }

  /** The chapter in the list we already have (memory or stored meta), without network. */
  private async knownChapter(key: string, chapterPath: string): Promise<ChapterRef | null> {
    const known = await this.novels.known(key);
    if (!known) return null;
    const idx = chapterIndex(known.chapters, chapterPath);
    const meta = idx >= 0 ? known.chapters[idx] : undefined;
    return meta ? { chapters: known.chapters, idx, meta } : null;
  }

  /**
   * The chapter's metadata, fetching the novel's chapter list if needed. Throws LOCKED for locked
   * chapters and NOT_FOUND for chapters the source doesn't list.
   */
  async resolveChapter(key: string, novel: NovelKey, chapterPath: string, lane: Lane): Promise<ChapterRef> {
    let ref = await this.knownChapter(key, chapterPath);
    if (!ref) {
      if (!this.listLoader) throw notFound(`Unknown chapter ${chapterPath}`);
      const chapters = await this.listLoader(novel, lane);
      const idx = chapterIndex(chapters, chapterPath);
      const meta = idx >= 0 ? chapters[idx] : undefined;
      if (!meta) throw notFound(`Chapter ${chapterPath} is not in the novel's chapter list`);
      ref = { chapters, idx, meta };
    }
    if (ref.meta.locked) throw new AppError('LOCKED', `"${ref.meta.name}" is locked on the source`);
    return ref;
  }

  titleFor(key: string, chapterPath: string): string | undefined {
    const t = this.titles.get(key);
    return t && t.path === chapterPath ? t.title : undefined;
  }

  /** Raw content (downloaded/cached copy first, else a lock-checked fetch) and the chapter's metadata. */
  private async content(
    a: { pluginId: string; novelPath: string; chapterPath: string },
    novel: NovelKey,
    key: string,
  ): Promise<{ ref: ChapterRef | null; loaded: { html: string; title?: string; fromCache: boolean } }> {
    let ref = await this.knownChapter(key, a.chapterPath);
    if (ref?.meta.locked) throw new AppError('LOCKED', `"${ref.meta.name}" is locked on the source`);
    let loaded: { html: string; title?: string; fromCache: boolean } | null = await this.loadLocal(key, a.chapterPath);
    if (!loaded) {
      // About to request content: the lock state must be known first.
      ref ??= await this.resolveChapter(key, novel, a.chapterPath, 'interactive');
      loaded = { html: await this.fetchChapter(key, a.pluginId, a.chapterPath, ref.meta.name, true, 'interactive'), fromCache: false };
    }
    return { ref, loaded };
  }

  /** cleanup.test: the text of the blocks `rule` would hide in this chapter (max 20, each ≤ 200 chars). */
  async cleanupPreview(a: { pluginId: string; novelPath: string; chapterPath: string }, rule: CleanupRule): Promise<string[]> {
    const problems: string[] = [];
    if (!compileRule(rule, (m) => problems.push(m))) throw new AppError('INVALID_ARGS', problems[0] ?? 'Invalid cleanup rule', false);
    const novel: NovelKey = { pluginId: a.pluginId, path: a.novelPath };
    const { loaded } = await this.content(a, novel, novelKeyString(novel));
    const { removed } = applyCleanup(loaded.html, [{ ...rule, enabled: true }], { now: () => this.ctx.platform.now() });
    return removed.slice(0, 20).map((t) => (t.length > 200 ? `${t.slice(0, 199)}…` : t));
  }

  async get(a: { pluginId: string; novelPath: string; chapterPath: string }): Promise<ChapterContent> {
    const novel: NovelKey = { pluginId: a.pluginId, path: a.novelPath };
    const key = novelKeyString(novel);
    const progP = this.progress.get(key);
    const { ref, loaded } = await this.content(a, novel, key);
    const prog = await progP;
    // Cleanup rules apply at serve time, so cached/downloaded copies follow rule changes too.
    const rules = rulesFor(this.ctx.settings().cleanupRules, a.pluginId);
    if (rules.length > 0) {
      loaded.html = applyCleanup(loaded.html, rules, { now: () => this.ctx.platform.now(), log: (m) => this.ctx.platform.log('warn', m) }).html;
    }
    // Text quality pass after the rules (mojibake, empty paragraphs, <br> runs, nbsp/zero-width).
    try {
      loaded.html = polishChapterHtml(loaded.html);
    } catch (e) {
      this.ctx.platform.log('warn', `chapter polish failed for ${a.chapterPath}: ${errorMessage(e)}`);
    }
    const chapters = ref?.chapters;
    const idx = ref?.idx ?? -1;
    const meta = ref?.meta;
    const title = meta?.name || loaded.title || '';
    const out: ChapterContent = {
      pluginId: a.pluginId,
      novelPath: a.novelPath,
      chapterPath: a.chapterPath,
      title,
      html: loaded.html,
      fromCache: loaded.fromCache,
    };
    if (chapters && idx >= 0) {
      if (idx > 0) out.prev = chapters[idx - 1];
      if (idx < chapters.length - 1) out.next = chapters[idx + 1];
    }
    const position = prog.position(a.chapterPath);
    if (position) out.position = position;
    // Stored stylesheet text (fetched in the background when the plugin loads; never awaited here).
    const customCSS = this.sources.customCSSText(a.pluginId);
    if (customCSS) out.customCSS = customCSS;
    if (title) this.titles.set(key, { path: a.chapterPath, title });

    return out;
  }

  /** Read ahead after the chapter the user is reading (called from progress.save). Background lane. */
  async readAheadFrom(key: string, novel: NovelKey, chapterPath: string): Promise<void> {
    this.notePace(key, chapterPath);
    if (this.ctx.settings().readAhead <= 0) return;
    const known = await this.novels.known(key);
    if (!known) return; // no list in hand: never fetch one just to read ahead
    const idx = chapterIndex(known.chapters, chapterPath);
    if (idx < 0) return;
    const gen = (this.aheadGen.get(key) ?? 0) + 1;
    this.aheadGen.set(key, gen);
    await this.readAhead(key, novel, known.chapters, idx, this.readAheadCount(key, chapterPath), () => this.aheadGen.get(key) !== gen);
  }

  /** A chapter was started (first progress.save): the previous one took `now - at`. */
  private notePace(key: string, chapterPath: string): void {
    const now = this.ctx.platform.now();
    const p = this.pace.get(key);
    if (!p) {
      this.pace.set(key, { path: chapterPath, at: now, recent: [] });
      if (this.pace.size > 20) {
        const oldest = this.pace.keys().next().value;
        if (oldest !== undefined) this.pace.delete(oldest);
      }
      return;
    }
    if (p.path === chapterPath) return;
    const took = now - p.at;
    if (took > 0 && took < MAX_PACE_SAMPLE_MS) {
      p.recent.push(took);
      if (p.recent.length > 3) p.recent.shift();
    } else {
      p.recent = []; // a long break: the old pace says nothing about now
    }
    p.path = chapterPath;
    p.at = now;
  }

  /**
   * How many chapters to read ahead: the setting, raised to 2 (never above 3, never from 0) while the
   * user reads fast (median of the last 2–3 chapters under 3 min) or the current chapter is short.
   */
  readAheadCount(key: string, chapterPath: string): number {
    const n = this.ctx.settings().readAhead;
    if (n <= 0) return 0;
    const recent = [...(this.pace.get(key)?.recent ?? [])].sort((a, b) => a - b);
    const fast = recent.length >= 2 && (recent[Math.floor(recent.length / 2)] as number) < FAST_CHAPTER_MS;
    const size = this.cache.loaded ? this.cache.sizeOf(cacheFileName(key, chapterPath)) : undefined;
    const short = size !== undefined && size < SHORT_CHAPTER_BYTES;
    return fast || short ? Math.min(MAX_READ_AHEAD, Math.max(n, 2)) : n;
  }

  /** Downloaded or cached copy (no network). */
  private async loadLocal(key: string, chapterPath: string): Promise<{ html: string; title?: string; fromCache: boolean } | null> {
    const dl = await this.downloads.read(key, chapterPath);
    if (dl) return { html: dl.html, title: dl.title, fromCache: true };
    const cached = await this.readCache(key, chapterPath);
    return cached ? { ...cached, fromCache: true } : null;
  }

  async readCache(key: string, chapterPath: string): Promise<{ html: string; title?: string } | null> {
    const file = cacheFileName(key, chapterPath);
    let text: string | null;
    try {
      text = await this.cache.readText(file);
    } catch (err) {
      this.ctx.platform.log('warn', `Cache read failed (${file}): ${errorMessage(err)}`);
      return null;
    }
    if (text === null) return null;
    try {
      const f = JSON.parse(text) as CacheFile;
      if (f.k !== key || f.p !== chapterPath || typeof f.h !== 'string') return null;
      return f.t ? { html: f.h, title: f.t } : { html: f.h };
    } catch {
      this.cache.remove(file);
      return null;
    }
  }

  /**
   * Network fetch (deduped per chapter and lane, so an interactive open never queues behind a background
   * prefetch of the same chapter). Writes the read-ahead cache when `cacheIt`. Callers check locks first.
   */
  fetchChapter(key: string, pluginId: string, chapterPath: string, title: string | undefined, cacheIt: boolean, lane: Lane): Promise<string> {
    const file = cacheFileName(key, chapterPath);
    return this.fetches.run(`${lane}|${file}`, async () => {
      const adapter = await this.sources.adapter(pluginId, lane);
      const html = await adapter.chapter(chapterPath);
      if (typeof html !== 'string') throw new AppError('PLUGIN', 'The source returned an empty chapter.');
      if (cacheIt) {
        const body: CacheFile = { k: key, p: chapterPath, t: title ?? '', h: html };
        void this.cache.writeText(file, JSON.stringify(body)).catch((err: unknown) => {
          this.ctx.platform.log('warn', `Cache write failed (${file}): ${errorMessage(err)}`);
        });
      }
      return html;
    });
  }

  private async readAhead(key: string, novel: NovelKey, chapters: readonly ChapterMeta[], idx: number, n: number, superseded: () => boolean): Promise<void> {
    if (n <= 0) return;
    try {
      await this.cache.init();
      for (let i = idx + 1, slots = 0; i < chapters.length && slots < n; i++, slots++) {
        if (superseded()) return; // the reader moved on: a newer read-ahead takes over
        const c = chapters[i] as ChapterMeta;
        if (c.locked) return;
        const file = cacheFileName(key, c.path);
        if (this.cache.has(file) || this.prefetching.has(file)) continue;
        if (await this.downloads.isDownloaded(key, c.path)) continue;
        this.prefetching.add(file);
        try {
          await this.fetchChapter(key, novel.pluginId, c.path, c.name, true, 'background');
        } finally {
          this.prefetching.delete(file);
        }
        this.ctx.events.emit('chapter.prefetched', { pluginId: novel.pluginId, novelPath: novel.path, chapterPath: c.path });
      }
    } catch (err) {
      this.ctx.platform.log('info', `Read-ahead stopped for ${key}: ${errorMessage(err)}`);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  flush(): Promise<void> {
    return this.cache.loaded ? this.cache.flush() : Promise.resolve();
  }
}
