/**
 * progress.save / markRead / bookmark.
 *
 * progress.save is on the hot path (the UI sends it every ~2 s while reading), so it only touches
 * memory: position + last chapter in the novel's progress doc (debounced write, immediate on chapter
 * change), the library entry, and the history entry (skipped in incognito). Crossing
 * settings.reader.markReadAt (or `finished`) marks the chapter read, which recounts unread chapters.
 *
 * Reading time: the gap since the previous save for the same novel is added to the history entry's
 * `readingMs` when it is under READING_GAP_MS (longer gaps = the reader was idle/away). The last-save
 * times live in memory only, so the first save of a session adds nothing. Not tracked in incognito.
 */

export const READING_GAP_MS = 60_000;
import type { ChapterPosition, HistoryEntry } from '../../shared/contracts/domain.ts';
import { novelKeyString, parseNovelKey } from '../../shared/contracts/domain.ts';
import { errorMessage } from '../lib/errors.ts';
import type { ChapterService } from './chapters.ts';
import { type Ctx, inBackground } from './context.ts';
import type { DownloadService } from './downloads.ts';
import type { HistoryService } from './history.ts';
import type { LibraryService } from './library.ts';
import { type NovelStore, chapterIndex } from './novel-store.ts';
import { countUnread } from './novels.ts';
import type { NovelProgress, ProgressService } from './progress.ts';
import type { StatsService } from './stats.ts';
import type { UpdatesService } from './updates.ts';

export class ReadingService {
  private readonly ctx: Ctx;
  private readonly progress: ProgressService;
  private readonly history: HistoryService;
  private readonly library: LibraryService;
  private readonly updates: UpdatesService;
  private readonly novels: NovelStore;
  private readonly downloads: DownloadService;
  private readonly chapters: ChapterService;
  /** Called (not awaited) when the reader moves to another chapter: smart downloads. */
  onChapterChange: ((key: string) => void) | null = null;
  /**
   * Called (not awaited) the first time in this session that progress is saved for a chapter: read-ahead
   * starts from the chapter actually being read.
   */
  onChapterRead: ((key: string, novel: { pluginId: string; path: string }, chapterPath: string) => void) | null = null;
  /** novelKey → chapter read-ahead was last started for (this session). */
  private readonly readingNow = new Map<string, string>();
  /** Reading stats sink (per-day ms and finished chapters); skipped in incognito. */
  stats: StatsService | null = null;
  /** novelKey → time of the previous progress.save (reading-time accounting). */
  private readonly lastSaveAt = new Map<string, number>();

  constructor(
    ctx: Ctx,
    deps: {
      progress: ProgressService;
      history: HistoryService;
      library: LibraryService;
      updates: UpdatesService;
      novels: NovelStore;
      downloads: DownloadService;
      chapters: ChapterService;
    },
  ) {
    this.ctx = ctx;
    this.progress = deps.progress;
    this.history = deps.history;
    this.library = deps.library;
    this.updates = deps.updates;
    this.novels = deps.novels;
    this.downloads = deps.downloads;
    this.chapters = deps.chapters;
  }

  async save(a: { pluginId: string; novelPath: string; chapterPath: string; position: ChapterPosition; finished?: boolean }): Promise<void> {
    const key = novelKeyString({ pluginId: a.pluginId, path: a.novelPath });
    const prog = this.progress.peek(key) ?? (await this.progress.get(key));
    const now = this.ctx.platform.now();
    const settings = this.ctx.settings();

    const mem = this.novels.peek(key);
    const idx = mem ? chapterIndex(mem.chapters, a.chapterPath) : -1;
    const chapterName = (mem && idx >= 0 ? mem.chapters[idx]?.name : undefined) ?? this.chapters.titleFor(key, a.chapterPath);

    prog.setPosition(a.chapterPath, a.position);
    const switched = prog.touch(a.chapterPath, chapterName, now);

    const libEntry = this.library.get(key);
    const chapterChanged = libEntry !== undefined && libEntry.lastChapterPath !== a.chapterPath;
    const entry = this.library.update(
      key,
      (e) => {
        e.lastReadAt = now;
        e.lastChapterPath = a.chapterPath;
        if (chapterName) e.lastChapterName = chapterName;
        else delete e.lastChapterName;
      },
      !chapterChanged,
    );
    const novelName = entry?.name ?? mem?.details.name ?? prog.value.novelName ?? a.novelPath;
    const cover = entry?.cover ?? mem?.details.cover ?? prog.value.cover;
    prog.setNovelInfo(novelName, cover);

    if (settings.incognito) {
      this.lastSaveAt.delete(key);
    } else {
      const previous = this.lastSaveAt.get(key);
      const gap = previous === undefined ? 0 : now - previous;
      this.lastSaveAt.set(key, now);
      const h: HistoryEntry = {
        pluginId: a.pluginId,
        path: a.novelPath,
        novelName,
        chapterPath: a.chapterPath,
        chapterName: chapterName ?? a.chapterPath,
        readAt: now,
        percent: Math.min(1, Math.max(0, a.position.percent)),
      };
      if (cover) h.cover = cover;
      const readingMs = gap > 0 && gap < READING_GAP_MS ? gap : 0;
      this.history.record(h, readingMs);
      if (readingMs > 0) inBackground(this.ctx, 'Reading stats', this.stats?.addReading(key, readingMs, cover ? { name: novelName, cover } : { name: novelName }, now));
    }

    if ((a.finished || a.position.percent >= settings.reader.markReadAt) && !prog.read.has(a.chapterPath)) {
      await this.applyRead(key, prog, [a.chapterPath], true);
      if (!settings.incognito) inBackground(this.ctx, 'Chapter stats', this.stats?.addChapter(now));
    }
    if (switched) {
      inBackground(this.ctx, 'Progress write', prog.flush());
      this.onChapterChange?.(key);
    }
    if (this.readingNow.get(key) !== a.chapterPath) {
      this.readingNow.set(key, a.chapterPath);
      this.onChapterRead?.(key, { pluginId: a.pluginId, path: a.novelPath }, a.chapterPath);
    }
  }

  async markRead(a: { pluginId: string; novelPath: string; chapterPaths: string[]; read: boolean }): Promise<void> {
    const key = novelKeyString({ pluginId: a.pluginId, path: a.novelPath });
    const prog = await this.progress.get(key);
    await this.applyRead(key, prog, a.chapterPaths, a.read);
  }

  async bookmark(a: { pluginId: string; novelPath: string; chapterPath: string; bookmarked: boolean }): Promise<void> {
    const key = novelKeyString({ pluginId: a.pluginId, path: a.novelPath });
    const prog = await this.progress.get(key);
    prog.setBookmark(a.chapterPath, a.bookmarked);
  }

  /**
   * library.markRead: every non-locked chapter of these library novels, from stored chapter lists only
   * (no network). Novels without a stored list are skipped. Emits one library.changed.
   */
  async markLibraryRead(keys: readonly string[], read: boolean): Promise<void> {
    for (const key of keys) {
      if (!this.library.has(key)) continue;
      const known = await this.novels.known(key);
      if (!known) {
        this.ctx.platform.log('warn', `library.markRead: no stored chapter list for ${key}; skipped`);
        continue;
      }
      const paths: string[] = [];
      for (const c of known.chapters) if (!c.locked) paths.push(c.path);
      await this.applyRead(key, await this.progress.get(key), paths, read, false);
    }
    this.library.emitChanged();
  }

  private async applyRead(key: string, prog: NovelProgress, paths: readonly string[], read: boolean, notify = true): Promise<void> {
    const changed = prog.setRead(paths, read);
    if (changed.length === 0) return;
    if (!read) for (const p of changed) prog.clearPosition(p);
    void this.updates.markRead(key, changed, read).catch((err: unknown) => {
      this.ctx.platform.log('warn', `Failed to update update records: ${errorMessage(err)}`);
    });
    if (this.library.has(key)) {
      const known = await this.novels.known(key);
      this.library.update(key, (e) => {
        if (known) {
          e.chapterCount = known.chapters.length;
          e.unreadCount = countUnread(known.chapters, prog.read);
        } else {
          e.unreadCount = Math.max(0, e.unreadCount + (read ? -changed.length : changed.length));
        }
      });
      if (notify) this.library.notifyChanged();
    }
    if (read && this.ctx.settings().deleteDownloadsAfterRead) {
      void this.downloads.delete(parseNovelKey(key), changed).catch((err: unknown) => {
        this.ctx.platform.log('warn', `Failed to delete read downloads: ${errorMessage(err)}`);
      });
    }
  }
}
