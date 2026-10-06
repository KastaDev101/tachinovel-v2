/**
 * browse.list / browse.search / browse.globalSearch with "in library" marking and chapter counts
 * (the source's own count, else what we already know: library entry, then the in-memory novel).
 */
import type { NovelSummary } from '../../shared/contracts/domain.ts';
import { novelKeyString } from '../../shared/contracts/domain.ts';
import type { BridgeError, BrowseItem, BrowsePage } from '../../shared/contracts/protocol.ts';
import { mapLimit } from '../lib/async.ts';
import { AppError, toBridgeError } from '../lib/errors.ts';
import type { LibraryService } from './library.ts';
import type { NovelStore } from './novel-store.ts';
import type { SourceService } from './sources.ts';

export const GLOBAL_SEARCH_CONCURRENCY = 3;

export class BrowseService {
  private readonly sources: SourceService;
  private readonly library: LibraryService;
  private readonly store: NovelStore;

  constructor(sources: SourceService, library: LibraryService, store: NovelStore) {
    this.sources = sources;
    this.library = library;
    this.store = store;
  }

  /** Known chapter count without I/O: library entry (mirrors stored meta), else a novel in memory. */
  private knownChapterCount(key: string): number | undefined {
    const entry = this.library.get(key);
    if (entry && entry.chapterCount > 0) return entry.chapterCount;
    const mem = this.store.peek(key);
    return mem && mem.chapters.length > 0 ? mem.chapters.length : undefined;
  }

  private mark(pluginId: string, raw: unknown): BrowseItem[] {
    if (!Array.isArray(raw)) throw new AppError('PLUGIN', 'Source returned an invalid novel list');
    const items = raw as readonly (NovelSummary | null | undefined)[];
    const out: BrowseItem[] = [];
    for (const n of items) {
      if (!n || typeof n.path !== 'string' || typeof n.name !== 'string') continue;
      const key = novelKeyString({ pluginId, path: n.path });
      const item: BrowseItem = { pluginId, path: n.path, name: n.name, inLibrary: this.library.has(key) };
      if (n.cover) item.cover = n.cover;
      const count = typeof n.chapterCount === 'number' && Number.isFinite(n.chapterCount) && n.chapterCount >= 0 ? n.chapterCount : this.knownChapterCount(key);
      if (count !== undefined) item.chapterCount = count;
      out.push(item);
    }
    return out;
  }

  async list(a: { pluginId: string; page: number; mode: 'popular' | 'latest'; filters?: Record<string, unknown> }): Promise<BrowsePage> {
    this.sources.requireEnabled(a.pluginId);
    const adapter = await this.sources.adapter(a.pluginId);
    this.sources.markUsed(a.pluginId);
    const opts: { latest: boolean; filters?: Record<string, unknown> } = { latest: a.mode === 'latest' };
    if (a.filters) opts.filters = a.filters;
    const items = this.mark(a.pluginId, await adapter.popular(a.page, opts));
    return { items, hasMore: items.length > 0 };
  }

  async search(a: { pluginId: string; query: string; page: number }): Promise<BrowsePage> {
    this.sources.requireEnabled(a.pluginId);
    const adapter = await this.sources.adapter(a.pluginId);
    this.sources.markUsed(a.pluginId);
    const items = this.mark(a.pluginId, await adapter.search(a.query, a.page));
    return { items, hasMore: items.length > 0 };
  }

  async globalSearch(query: string): Promise<{ results: { pluginId: string; items: BrowseItem[]; error?: BridgeError }[] }> {
    const ids = this.sources.enabledIds();
    const results = await mapLimit(ids, GLOBAL_SEARCH_CONCURRENCY, async (pluginId) => {
      try {
        const adapter = await this.sources.adapter(pluginId);
        return { pluginId, items: this.mark(pluginId, await adapter.search(query, 1)) };
      } catch (err) {
        return { pluginId, items: [] as BrowseItem[], error: toBridgeError(err) };
      }
    });
    return { results };
  }
}
