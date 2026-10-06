/**
 * Library entries + categories in synced `library.json`. Entries keep the remote cover URL; the wire
 * form swaps in the cached local cover path when there is one (so a synced library.json never points
 * at device-local files).
 */
import type { Category, LibraryEntry } from '../../shared/contracts/domain.ts';
import { novelKeyString } from '../../shared/contracts/domain.ts';
import { invalidArgs } from '../lib/errors.ts';
import { isRecord } from '../lib/validate.ts';
import { type DocSpec, JsonDoc } from '../storage/json-doc.ts';
import { type Ctx, inBackground } from './context.ts';
import type { CoverCache } from './covers.ts';

export interface LibraryDoc {
  schemaVersion: number;
  entries: LibraryEntry[];
  categories: Category[];
}

export const LIBRARY_SPEC: DocSpec<LibraryDoc> = {
  path: 'library.json',
  version: 1,
  create: () => ({ schemaVersion: 1, entries: [], categories: [] }),
  normalize(doc) {
    const seen = new Set<string>();
    const entries: LibraryEntry[] = [];
    for (const e of Array.isArray(doc.entries) ? doc.entries : []) {
      if (!isRecord(e) || typeof e.pluginId !== 'string' || typeof e.path !== 'string' || typeof e.name !== 'string') continue;
      const key = novelKeyString(e);
      if (seen.has(key)) continue;
      seen.add(key);
      e.key = key;
      if (!Array.isArray(e.categoryIds)) e.categoryIds = [];
      if (typeof e.chapterCount !== 'number') e.chapterCount = 0;
      if (typeof e.unreadCount !== 'number') e.unreadCount = 0;
      if (typeof e.downloadedCount !== 'number') e.downloadedCount = 0;
      if (typeof e.addedAt !== 'number') e.addedAt = 0;
      entries.push(e);
    }
    doc.entries = entries;
    doc.categories = (Array.isArray(doc.categories) ? doc.categories : []).filter(
      (c) => isRecord(c) && typeof c.id === 'string' && typeof c.name === 'string',
    );
    return doc;
  },
};

export class LibraryService {
  private readonly ctx: Ctx;
  private readonly covers: CoverCache;
  private readonly doc: JsonDoc<LibraryDoc>;
  private readonly byKey = new Map<string, LibraryEntry>();
  private eventScheduled = false;

  private constructor(ctx: Ctx, covers: CoverCache, doc: JsonDoc<LibraryDoc>) {
    this.ctx = ctx;
    this.covers = covers;
    this.doc = doc;
    for (const e of doc.value.entries) this.byKey.set(e.key, e);
  }

  static async load(ctx: Ctx, covers: CoverCache): Promise<LibraryService> {
    const doc = await JsonDoc.load(ctx.platform.synced, LIBRARY_SPEC, ctx.timing.libraryWriteMs, ctx.env);
    return new LibraryService(ctx, covers, doc);
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  get(key: string): LibraryEntry | undefined {
    return this.byKey.get(key);
  }

  all(): readonly LibraryEntry[] {
    return this.doc.value.entries;
  }

  get size(): number {
    return this.byKey.size;
  }

  wireEntry(e: LibraryEntry): LibraryEntry {
    const local = this.covers.localRef(e.cover);
    return local ? { ...e, cover: local } : e;
  }

  wire(): LibraryEntry[] {
    return this.doc.value.entries.map((e) => this.wireEntry(e));
  }

  add(entry: LibraryEntry): void {
    if (this.byKey.has(entry.key)) return;
    this.doc.value.entries.push(entry);
    this.byKey.set(entry.key, entry);
    this.doc.changed();
  }

  remove(key: string): LibraryEntry | undefined {
    const e = this.byKey.get(key);
    if (!e) return undefined;
    this.byKey.delete(key);
    this.doc.value.entries = this.doc.value.entries.filter((x) => x.key !== key);
    this.doc.changed();
    return e;
  }

  /**
   * Mutate an entry in place and persist (debounced). No-op if the novel isn't in the library.
   * `quiet`: don't schedule a write for this change alone (it rides on the next write or the close flush).
   */
  update(key: string, fn: (e: LibraryEntry) => void, quiet = false): LibraryEntry | undefined {
    const e = this.byKey.get(key);
    if (!e) return undefined;
    fn(e);
    if (quiet) this.doc.changedQuietly();
    else this.doc.changed();
    return e;
  }

  categories(): Category[] {
    return [...this.doc.value.categories].sort((a, b) => a.order - b.order);
  }

  saveCategories(categories: Category[]): Category[] {
    const ids = new Set<string>();
    for (const c of categories) {
      if (ids.has(c.id)) throw invalidArgs(`Duplicate category id "${c.id}"`);
      ids.add(c.id);
    }
    this.doc.value.categories = categories.map((c) => ({ id: c.id, name: c.name, order: c.order }));
    for (const e of this.doc.value.entries) {
      if (e.categoryIds.some((id) => !ids.has(id))) e.categoryIds = e.categoryIds.filter((id) => ids.has(id));
    }
    this.doc.changed();
    return this.categories();
  }

  setCategories(keys: readonly string[], categoryIds: readonly string[]): void {
    const known = new Set(this.doc.value.categories.map((c) => c.id));
    for (const id of categoryIds) if (!known.has(id)) throw invalidArgs(`Unknown category "${id}"`);
    for (const k of keys) {
      const e = this.byKey.get(k);
      if (e) e.categoryIds = [...categoryIds];
    }
    this.doc.changed();
  }

  /**
   * Backup restore. replace: entries and categories become the backup's. merge: union of novels (the
   * entry read more recently wins, category ids are unioned) and of categories (existing names kept).
   */
  restore(entries: LibraryEntry[], categories: Category[], mode: 'merge' | 'replace'): void {
    const v = this.doc.value;
    const cats = new Map<string, Category>();
    if (mode === 'merge') for (const c of v.categories) cats.set(c.id, c);
    for (const c of categories) if (!cats.has(c.id)) cats.set(c.id, { id: c.id, name: c.name, order: c.order });
    const byKey = new Map<string, LibraryEntry>();
    if (mode === 'merge') for (const e of v.entries) byKey.set(e.key, e);
    const stamp = (e: LibraryEntry): number => e.lastReadAt ?? e.addedAt;
    for (const raw of entries) {
      const e: LibraryEntry = { ...raw, key: novelKeyString(raw), categoryIds: [...raw.categoryIds] };
      const cur = byKey.get(e.key);
      if (!cur) {
        byKey.set(e.key, e);
        continue;
      }
      const winner = stamp(e) > stamp(cur) ? e : { ...cur };
      winner.categoryIds = [...new Set([...cur.categoryIds, ...e.categoryIds])];
      winner.addedAt = Math.min(cur.addedAt || e.addedAt, e.addedAt || cur.addedAt);
      byKey.set(e.key, winner);
    }
    for (const e of byKey.values()) e.categoryIds = e.categoryIds.filter((id) => cats.has(id));
    v.categories = [...cats.values()];
    v.entries = [...byKey.values()];
    this.byKey.clear();
    for (const e of v.entries) this.byKey.set(e.key, e);
    this.doc.changed();
  }

  /** Emit `library.changed` once for a burst of changes. */
  notifyChanged(): void {
    if (this.eventScheduled) return;
    this.eventScheduled = true;
    inBackground(
      this.ctx,
      'library.changed event',
      this.ctx.platform.sleep(this.ctx.timing.libraryEventMs).then(() => {
        this.eventScheduled = false;
        this.ctx.events.emit('library.changed', { library: this.wire() });
      }),
    );
  }

  /** Emit `library.changed` now (after bulk changes such as a restore). */
  emitChanged(): void {
    this.ctx.events.emit('library.changed', { library: this.wire() });
  }

  flush(): Promise<void> {
    return this.doc.flush();
  }
}
