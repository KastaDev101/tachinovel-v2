/**
 * Migrate a library novel to another source. Chapters are matched by chapter number (ChapterMeta.number,
 * else parsed from the name), then by normalized name. Carries read marks, bookmarks, the last chapter
 * and its position, categories, the history entry with its reading time, and reading stats.
 */
import type { ChapterMeta, LibraryEntry, NovelDetails, NovelKey } from '../../shared/contracts/domain.ts';
import { novelKeyString } from '../../shared/contracts/domain.ts';
import { invalidArgs, notFound } from '../lib/errors.ts';
import type { ChapterService } from './chapters.ts';
import type { Ctx } from './context.ts';
import type { HistoryService } from './history.ts';
import type { LibraryService } from './library.ts';
import type { NovelStore } from './novel-store.ts';
import { type NovelService, countUnread } from './novels.ts';
import type { ProgressService } from './progress.ts';
import type { StatsService } from './stats.ts';

const NUMBER_RES = [/(?:chapter|chap\.?|ch\.?|episode|ep\.?|part)\s*#?\s*(\d+(?:\.\d+)?)/i, /第\s*(\d+(?:\.\d+)?)/, /^\s*(\d+(?:\.\d+)?)(?:\s|[:.\-–—]|$)/];

export function chapterNumber(c: ChapterMeta): number | undefined {
  if (typeof c.number === 'number' && Number.isFinite(c.number)) return c.number;
  for (const re of NUMBER_RES) {
    const m = re.exec(c.name);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** Name without a leading "Chapter 12:" prefix, lower-case letters/digits only ('' if nothing is left). */
export function normalizedName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^\s*(?:chapter|chap\.?|ch\.?|episode|ep\.?)?\s*#?\s*\d+(?:\.\d+)?\s*[:.\-–—)]*\s*/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** from.path → matching chapter of `to` (number first, then name). */
export function matchChapters(from: readonly ChapterMeta[], to: readonly ChapterMeta[]): Map<string, ChapterMeta> {
  const byNumber = new Map<number, ChapterMeta>();
  const byName = new Map<string, ChapterMeta>();
  for (const c of to) {
    const n = chapterNumber(c);
    if (n !== undefined && !byNumber.has(n)) byNumber.set(n, c);
    const k = normalizedName(c.name);
    if (k && !byName.has(k)) byName.set(k, c);
  }
  const out = new Map<string, ChapterMeta>();
  for (const c of from) {
    const n = chapterNumber(c);
    let target = n !== undefined ? byNumber.get(n) : undefined;
    if (!target) {
      const k = normalizedName(c.name);
      if (k) target = byName.get(k);
    }
    if (target) out.set(c.path, target);
  }
  return out;
}

interface Plan {
  fromKey: string;
  toKey: string;
  fromChapters: readonly ChapterMeta[];
  to: { details: NovelDetails; chapters: ChapterMeta[] };
  map: Map<string, ChapterMeta>;
}

export class MigrateService {
  private readonly ctx: Ctx;
  private readonly d: {
    novels: NovelService;
    store: NovelStore;
    chapters: ChapterService;
    library: LibraryService;
    progress: ProgressService;
    history: HistoryService;
    stats: StatsService;
  };

  constructor(ctx: Ctx, deps: MigrateService['d']) {
    this.ctx = ctx;
    this.d = deps;
  }

  private async plan(from: NovelKey, to: NovelKey): Promise<Plan> {
    const fromKey = novelKeyString(from);
    const toKey = novelKeyString(to);
    if (fromKey === toKey) throw invalidArgs('Source and target are the same novel');
    if (!this.d.library.has(fromKey)) throw notFound('The novel to migrate is not in the library');
    const [fromChapters, data] = await Promise.all([this.d.chapters.chapterList(fromKey, from, 'interactive'), this.d.novels.fetchNovel(to, 'interactive')]);
    this.d.store.remember(toKey, data);
    return { fromKey, toKey, fromChapters, to: data, map: matchChapters(fromChapters, data.chapters) };
  }

  async preview(from: NovelKey, to: NovelKey): Promise<{ matched: number; unmatched: number; readCarried: number; lastChapterName?: string }> {
    const p = await this.plan(from, to);
    const prog = await this.d.progress.get(p.fromKey);
    let readCarried = 0;
    for (const path of prog.read) if (p.map.has(path)) readCarried++;
    const out: { matched: number; unmatched: number; readCarried: number; lastChapterName?: string } = {
      matched: p.map.size,
      unmatched: p.fromChapters.length - p.map.size,
      readCarried,
    };
    const last = prog.value.lastChapterPath ? p.map.get(prog.value.lastChapterPath) : undefined;
    if (last) out.lastChapterName = last.name;
    return out;
  }

  async apply(from: NovelKey, to: NovelKey, keepOld: boolean): Promise<LibraryEntry> {
    const p = await this.plan(from, to);
    const { library, progress, history, novels, stats } = this.d;
    const fromEntry = library.get(p.fromKey);
    if (!fromEntry) throw notFound('The novel to migrate is not in the library');
    const fromProg = await progress.get(p.fromKey);
    const toProg = await progress.get(p.toKey);
    const details = p.to.details;

    // Progress: read marks, bookmarks, last chapter + position.
    const read: string[] = [];
    for (const path of fromProg.read) {
      const t = p.map.get(path);
      if (t) read.push(t.path);
    }
    toProg.setRead(read, true);
    for (const path of fromProg.bookmarks) {
      const t = p.map.get(path);
      if (t) toProg.setBookmark(t.path, true);
    }
    const lastFrom = fromProg.value.lastChapterPath;
    const lastTo = lastFrom ? p.map.get(lastFrom) : undefined;
    if (lastFrom && lastTo) {
      const pos = fromProg.position(lastFrom);
      if (pos) toProg.setPosition(lastTo.path, pos);
      toProg.touch(lastTo.path, lastTo.name, fromProg.value.lastReadAt ?? this.ctx.platform.now());
    }
    toProg.setNovelInfo(details.name, details.cover);

    // Library entry with the old categories (merged when the target was already there).
    const existing = library.get(p.toKey);
    await novels.addToLibrary(details, existing ? undefined : [...fromEntry.categoryIds]);
    library.update(p.toKey, (e) => {
      e.categoryIds = [...new Set([...e.categoryIds, ...fromEntry.categoryIds])];
      e.chapterCount = p.to.chapters.length;
      e.unreadCount = countUnread(p.to.chapters, toProg.read);
      if (fromEntry.addedAt && (!e.addedAt || fromEntry.addedAt < e.addedAt)) e.addedAt = fromEntry.addedAt;
      if (lastTo) {
        e.lastChapterPath = lastTo.path;
        e.lastChapterName = lastTo.name;
      }
      if (fromEntry.lastReadAt && (!e.lastReadAt || fromEntry.lastReadAt > e.lastReadAt)) e.lastReadAt = fromEntry.lastReadAt;
    });

    // History (with its reading time) and stats follow the novel.
    const fromHist = history.all().find((h) => h.pluginId === from.pluginId && h.path === from.path);
    if (fromHist) {
      const chapter = lastTo ?? p.to.chapters[0];
      if (chapter) {
        const entry = { pluginId: to.pluginId, path: to.path, novelName: details.name, chapterPath: chapter.path, chapterName: chapter.name, readAt: fromHist.readAt, percent: fromHist.percent };
        history.record(details.cover ? { ...entry, cover: details.cover } : entry, fromHist.readingMs ?? 0);
      }
    }
    await stats.renameNovel(p.fromKey, p.toKey);

    if (!keepOld) {
      await novels.removeFromLibrary(from);
      history.remove(from);
    }
    library.emitChanged();
    const result = library.get(p.toKey);
    if (!result) throw notFound('Migration target missing from the library');
    this.ctx.platform.log('info', `Migrated ${p.fromKey} → ${p.toKey}: ${p.map.size}/${p.fromChapters.length} chapters matched, ${read.length} read carried`);
    return library.wireEntry(result);
  }
}
