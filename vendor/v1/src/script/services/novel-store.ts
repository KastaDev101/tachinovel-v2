/**
 * Novel details + trimmed chapter lists.
 * - Library novels: local `meta/<hash(key)>.json` (deleted when the novel leaves the library).
 * - Browsed-only novels: memory only (small LRU), never written to disk.
 */
import type { ChapterMeta, NovelDetails } from '../../shared/contracts/domain.ts';
import { errorMessage, storageError } from '../lib/errors.ts';
import { hashKey } from '../lib/hash.ts';
import { isRecord } from '../lib/validate.ts';
import { readDoc } from '../storage/json-doc.ts';
import type { Ctx } from './context.ts';

export interface NovelData {
  details: NovelDetails;
  chapters: ChapterMeta[];
  fetchedAt: number;
}

interface MetaDoc extends NovelData {
  schemaVersion: number;
  key: string;
}

export const META_VERSION = 1;
const MEMORY_CAP = 6;

export function metaPath(key: string): string {
  return `meta/${hashKey(key)}.json`;
}

const indexMemo = new WeakMap<readonly ChapterMeta[], Map<string, number>>();

/** O(1) after the first call per list (memoized path → index map). */
export function chapterIndex(chapters: readonly ChapterMeta[], path: string): number {
  let m = indexMemo.get(chapters);
  if (!m) {
    m = new Map();
    for (let i = 0; i < chapters.length; i++) m.set((chapters[i] as ChapterMeta).path, i);
    indexMemo.set(chapters, m);
  }
  return m.get(path) ?? -1;
}

/** Strip to ChapterMeta fields only when a source returned extras (keeps stored lists small). */
export function trimChapters(chapters: readonly ChapterMeta[]): ChapterMeta[] {
  const first = chapters[0];
  if (!first) return [];
  const allowed = new Set(['path', 'name', 'number', 'releaseTime', 'locked']);
  if (Object.keys(first).every((k) => allowed.has(k))) return chapters as ChapterMeta[];
  return chapters.map((c) => {
    const out: ChapterMeta = { path: c.path, name: c.name };
    if (c.number !== undefined) out.number = c.number;
    if (c.releaseTime) out.releaseTime = c.releaseTime;
    if (c.locked) out.locked = true;
    return out;
  });
}

export class NovelStore {
  private readonly ctx: Ctx;
  private readonly memory = new Map<string, NovelData>();

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  remember(key: string, data: NovelData): void {
    this.memory.delete(key);
    this.memory.set(key, data);
    while (this.memory.size > MEMORY_CAP) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  /** Memory copy, refreshed in LRU order. `maxAgeMs` filters stale copies. */
  peek(key: string, maxAgeMs?: number): NovelData | undefined {
    const d = this.memory.get(key);
    if (!d) return undefined;
    if (maxAgeMs !== undefined && this.ctx.platform.now() - d.fetchedAt > maxAgeMs) return undefined;
    this.memory.delete(key);
    this.memory.set(key, d);
    return d;
  }

  hasStored(key: string): boolean {
    return this.ctx.platform.local.exists(metaPath(key));
  }

  /** Stored metadata (library novels). */
  async loadStored(key: string): Promise<NovelData | null> {
    const path = metaPath(key);
    if (!this.ctx.platform.local.exists(path)) return null;
    const loaded = await readDoc<MetaDoc>(
      this.ctx.platform.local,
      {
        path,
        version: META_VERSION,
        create: () => ({ schemaVersion: META_VERSION, key, fetchedAt: 0, details: { pluginId: '', path: '', name: '', status: 'unknown', genres: [] }, chapters: [] }),
      },
      this.ctx.env,
    );
    const doc = loaded.value;
    if (loaded.fresh || doc.key !== key || !isRecord(doc.details) || !Array.isArray(doc.chapters)) return null;
    const data: NovelData = { details: doc.details, chapters: doc.chapters, fetchedAt: doc.fetchedAt };
    this.remember(key, data);
    return data;
  }

  /** Memory, then stored metadata. Never touches the network. */
  async known(key: string): Promise<NovelData | null> {
    return this.peek(key) ?? (await this.loadStored(key));
  }

  async persist(key: string, data: NovelData): Promise<void> {
    this.remember(key, data);
    const doc: MetaDoc = { schemaVersion: META_VERSION, key, fetchedAt: data.fetchedAt, details: data.details, chapters: data.chapters };
    try {
      await this.ctx.platform.local.writeText(metaPath(key), JSON.stringify(doc));
    } catch (err) {
      throw storageError('write', metaPath(key), err);
    }
  }

  delete(key: string): void {
    this.memory.delete(key);
    try {
      this.ctx.platform.local.remove(metaPath(key));
    } catch (err) {
      this.ctx.platform.log('warn', `Failed to delete ${metaPath(key)}: ${errorMessage(err)}`);
    }
  }
}
