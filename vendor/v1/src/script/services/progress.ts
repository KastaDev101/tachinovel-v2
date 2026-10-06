/**
 * Per-novel reading progress, in two small synced files per novel:
 * - `progress/<hash(novelKey)>.json`      read set + bookmarks (changes rarely; can be ~70 KB for a
 *                                          fully read 3,000-chapter novel)
 * - `progress/<hash(novelKey)>.pos.json`  positions + last chapter (the hot path while reading; a few KB)
 * so saving the position every couple of seconds rewrites only the tiny file (debounced; flushed on
 * chapter change and close). Read/bookmark Sets are only re-serialized when they changed.
 */
import type { ChapterPosition } from '../../shared/contracts/domain.ts';
import { hashKey } from '../lib/hash.ts';
import { isRecord } from '../lib/validate.ts';
import { type DocSpec, JsonDoc } from '../storage/json-doc.ts';
import type { Ctx } from './context.ts';

export interface MarksDoc {
  schemaVersion: number;
  key: string;
  read: string[];
  bookmarks: string[];
}

export interface PositionsDoc {
  schemaVersion: number;
  key: string;
  /** chapterPath → position, least recently saved first; capped. */
  positions: Record<string, ChapterPosition>;
  lastChapterPath?: string;
  lastChapterName?: string;
  lastReadAt?: number;
  /** Denormalized so history works for browsed-only novels. */
  novelName?: string;
  cover?: string;
}

/** Portable per-novel progress (backups). */
export interface ProgressSnapshot {
  read: string[];
  bookmarks: string[];
  positions: Record<string, ChapterPosition>;
  lastChapterPath?: string;
  lastChapterName?: string;
  lastReadAt?: number;
  novelName?: string;
  cover?: string;
}

export const PROGRESS_VERSION = 1;
/** Progress docs kept in memory before idle ones are dropped (every novel page viewed loads one). */
export const MAX_LOADED_PROGRESS = 64;
/** Only entries untouched this long, with nothing left to write, are dropped. */
export const PROGRESS_IDLE_MS = 10 * 60 * 1000;
export const MAX_POSITIONS = 100;

export function progressPath(key: string): string {
  return `progress/${hashKey(key)}.json`;
}

export function positionsPath(key: string): string {
  return `progress/${hashKey(key)}.pos.json`;
}

function marksSpec(key: string): DocSpec<MarksDoc> {
  const create = (): MarksDoc => ({ schemaVersion: PROGRESS_VERSION, key, read: [], bookmarks: [] });
  return {
    path: progressPath(key),
    version: PROGRESS_VERSION,
    create,
    normalize(doc) {
      if (doc.key !== key) return create(); // hash collision or foreign file
      if (!Array.isArray(doc.read)) doc.read = [];
      if (!Array.isArray(doc.bookmarks)) doc.bookmarks = [];
      return doc;
    },
  };
}

function positionsSpec(key: string): DocSpec<PositionsDoc> {
  const create = (): PositionsDoc => ({ schemaVersion: PROGRESS_VERSION, key, positions: {} });
  return {
    path: positionsPath(key),
    version: PROGRESS_VERSION,
    create,
    normalize(doc) {
      if (doc.key !== key) return create();
      if (!isRecord(doc.positions)) doc.positions = {};
      return doc;
    },
  };
}

function validPosition(p: ChapterPosition): ChapterPosition {
  const out: ChapterPosition = {
    percent: Math.min(1, Math.max(0, p.percent)),
    paragraph: Math.max(0, Math.floor(p.paragraph)),
  };
  if (typeof p.offset === 'number' && Number.isFinite(p.offset)) out.offset = p.offset;
  return out;
}

export class NovelProgress {
  readonly key: string;
  readonly read: Set<string>;
  readonly bookmarks: Set<string>;
  private readonly marks: JsonDoc<MarksDoc>;
  private readonly pos: JsonDoc<PositionsDoc>;
  private setsDirty = false;

  constructor(key: string, marks: JsonDoc<MarksDoc>, pos: JsonDoc<PositionsDoc>) {
    this.key = key;
    this.marks = marks;
    this.pos = pos;
    this.read = new Set(marks.value.read);
    this.bookmarks = new Set(marks.value.bookmarks);
    marks.beforeWrite = () => {
      if (!this.setsDirty) return;
      this.setsDirty = false;
      marks.value.read = [...this.read];
      marks.value.bookmarks = [...this.bookmarks];
    };
  }

  /** Positions and last-read info. */
  get value(): Readonly<PositionsDoc> {
    return this.pos.value;
  }

  /** Completed writes of both files (diagnostics/tests). */
  get writeCount(): number {
    return this.marks.writeCount + this.pos.writeCount;
  }

  position(chapterPath: string): ChapterPosition | undefined {
    return Object.hasOwn(this.pos.value.positions, chapterPath) ? this.pos.value.positions[chapterPath] : undefined;
  }

  setPosition(chapterPath: string, position: ChapterPosition): void {
    const positions = this.pos.value.positions;
    if (Object.hasOwn(positions, chapterPath)) delete positions[chapterPath];
    positions[chapterPath] = validPosition(position);
    const keys = Object.keys(positions);
    for (let i = 0; i < keys.length - MAX_POSITIONS; i++) delete positions[keys[i] as string];
    this.pos.changed();
  }

  clearPosition(chapterPath: string): void {
    if (!Object.hasOwn(this.pos.value.positions, chapterPath)) return;
    delete this.pos.value.positions[chapterPath];
    this.pos.changed();
  }

  /** Returns the paths whose state actually changed. */
  setRead(paths: readonly string[], read: boolean): string[] {
    const changed: string[] = [];
    for (const p of paths) {
      if (this.read.has(p) === read) continue;
      if (read) this.read.add(p);
      else this.read.delete(p);
      changed.push(p);
    }
    if (changed.length > 0) {
      this.setsDirty = true;
      this.marks.changed();
    }
    return changed;
  }

  setBookmark(path: string, bookmarked: boolean): boolean {
    if (this.bookmarks.has(path) === bookmarked) return false;
    if (bookmarked) this.bookmarks.add(path);
    else this.bookmarks.delete(path);
    this.setsDirty = true;
    this.marks.changed();
    return true;
  }

  /** Record the chapter being read. Returns true if it differs from the previous one. */
  touch(chapterPath: string, chapterName: string | undefined, at: number): boolean {
    const v = this.pos.value;
    const switched = v.lastChapterPath !== chapterPath;
    v.lastChapterPath = chapterPath;
    if (chapterName) v.lastChapterName = chapterName;
    else if (switched) delete v.lastChapterName;
    v.lastReadAt = at;
    this.pos.changed();
    return switched;
  }

  setNovelInfo(name: string, cover: string | undefined): void {
    const v = this.pos.value;
    if (v.novelName === name && v.cover === cover) return;
    v.novelName = name;
    if (cover) v.cover = cover;
    else delete v.cover;
    this.pos.changed();
  }

  async flush(): Promise<void> {
    await Promise.all([this.marks.flush(), this.pos.flush()]);
  }

  /** Changes not yet written (including quiet ones). */
  get dirty(): boolean {
    return this.marks.dirty || this.pos.dirty;
  }

  snapshot(): ProgressSnapshot {
    const v = this.pos.value;
    const out: ProgressSnapshot = { read: [...this.read], bookmarks: [...this.bookmarks], positions: { ...v.positions } };
    if (v.lastChapterPath !== undefined) out.lastChapterPath = v.lastChapterPath;
    if (v.lastChapterName !== undefined) out.lastChapterName = v.lastChapterName;
    if (v.lastReadAt !== undefined) out.lastReadAt = v.lastReadAt;
    if (v.novelName !== undefined) out.novelName = v.novelName;
    if (v.cover !== undefined) out.cover = v.cover;
    return out;
  }

  /**
   * Apply a backup. replace: the snapshot becomes the state. merge: read sets and bookmarks are unioned;
   * the side with the newer lastReadAt wins for the last chapter and conflicting positions.
   */
  restore(b: ProgressSnapshot, mode: 'merge' | 'replace'): void {
    const v = this.pos.value;
    if (mode === 'replace') {
      this.read.clear();
      this.bookmarks.clear();
    }
    for (const p of b.read) this.read.add(p);
    for (const p of b.bookmarks) this.bookmarks.add(p);
    const backupNewer = mode === 'replace' || (b.lastReadAt ?? 0) > (v.lastReadAt ?? 0);
    const positions: Record<string, ChapterPosition> = mode === 'replace' ? {} : { ...v.positions };
    for (const [path, pos] of Object.entries(b.positions)) {
      if (backupNewer || !Object.hasOwn(positions, path)) positions[path] = validPosition(pos);
    }
    const keys = Object.keys(positions);
    for (let i = 0; i < keys.length - MAX_POSITIONS; i++) delete positions[keys[i] as string];
    const next: PositionsDoc = { schemaVersion: PROGRESS_VERSION, key: this.key, positions };
    const src = backupNewer ? b : v;
    const other = backupNewer ? v : b;
    for (const k of ['lastChapterPath', 'lastChapterName', 'lastReadAt', 'novelName', 'cover'] as const) {
      const val = src[k] ?? (mode === 'replace' ? undefined : other[k]);
      if (val !== undefined) (next as unknown as Record<string, unknown>)[k] = val;
    }
    this.pos.value = next;
    this.setsDirty = true;
    this.marks.changed();
    this.pos.changed();
  }

  /** Remove both files (pending writes are dropped). */
  deleteFiles(): void {
    this.marks.delete();
    this.pos.delete();
  }
}

export class ProgressService {
  private readonly ctx: Ctx;
  private readonly loading = new Map<string, Promise<NovelProgress>>();
  private readonly loaded = new Map<string, NovelProgress>();
  /** key → last get/peek (for dropping idle entries in long sessions). */
  private readonly lastUsed = new Map<string, number>();

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  get(key: string): Promise<NovelProgress> {
    this.lastUsed.set(key, this.ctx.platform.now());
    let p = this.loading.get(key);
    if (!p) {
      this.evictIdle();
      p = this.load(key);
      this.loading.set(key, p);
      void p.catch(() => {
        this.loading.delete(key);
      });
    }
    return p;
  }

  /** Already-loaded progress, without I/O. */
  peek(key: string): NovelProgress | undefined {
    const np = this.loaded.get(key);
    if (np) this.lastUsed.set(key, this.ctx.platform.now());
    return np;
  }

  /** Loaded entries (diagnostics/tests). */
  get loadedCount(): number {
    return this.loaded.size;
  }

  /**
   * Hours of browsing load one progress doc per novel page. Beyond MAX_LOADED_PROGRESS, drop entries
   * idle for PROGRESS_IDLE_MS with nothing to write (a later get() reloads them from disk).
   */
  private evictIdle(): void {
    if (this.loaded.size < MAX_LOADED_PROGRESS) return;
    const cutoff = this.ctx.platform.now() - PROGRESS_IDLE_MS;
    const idle = [...this.loaded].filter(([key, np]) => (this.lastUsed.get(key) ?? 0) < cutoff && !np.dirty).sort((a, b) => (this.lastUsed.get(a[0]) ?? 0) - (this.lastUsed.get(b[0]) ?? 0));
    for (const [key] of idle) {
      if (this.loaded.size < MAX_LOADED_PROGRESS) break;
      this.loaded.delete(key);
      this.loading.delete(key);
      this.lastUsed.delete(key);
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.loaded.values()].map((p) => p.flush()));
  }

  /** Every novel key with progress in memory or on disk. */
  async allKeys(): Promise<string[]> {
    const { synced } = this.ctx.platform;
    const keys = new Set(this.loaded.keys());
    const fileByHash = new Map<string, string>();
    for (const name of synced.list('progress')) {
      const m = /^([0-9a-z]+)(?:\.pos)?\.json$/.exec(name);
      if (m && !fileByHash.has(m[1] as string)) fileByHash.set(m[1] as string, name);
    }
    for (const name of fileByHash.values()) {
      try {
        const text = await synced.readText(`progress/${name}`);
        const v: unknown = text ? JSON.parse(text) : null;
        if (isRecord(v) && typeof v.key === 'string') keys.add(v.key);
      } catch (err) {
        this.ctx.platform.log('warn', `Unreadable progress file ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return [...keys];
  }

  /** Delete a novel's progress (memory and disk). */
  async remove(key: string): Promise<void> {
    const np = await this.get(key);
    np.deleteFiles();
    this.loaded.delete(key);
    this.loading.delete(key);
  }

  private async load(key: string): Promise<NovelProgress> {
    const { platform, timing, env } = this.ctx;
    const [marks, pos] = await Promise.all([
      JsonDoc.load(platform.synced, marksSpec(key), timing.progressWriteMs, env),
      JsonDoc.load(platform.synced, positionsSpec(key), timing.progressWriteMs, env),
    ]);
    const np = new NovelProgress(key, marks, pos);
    this.loaded.set(key, np);
    return np;
  }
}
