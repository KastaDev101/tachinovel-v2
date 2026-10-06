/** New-chapter records found by update checks (newest first) in synced `updates.json`. Loaded lazily. */
import type { UpdateEntry } from '../../shared/contracts/domain.ts';
import { novelKeyString } from '../../shared/contracts/domain.ts';
import { type DocSpec, JsonDoc } from '../storage/json-doc.ts';
import type { Ctx } from './context.ts';

export interface UpdatesDoc {
  schemaVersion: number;
  entries: UpdateEntry[];
}

export const UPDATES_CAP = 500;

export const UPDATES_SPEC: DocSpec<UpdatesDoc> = {
  path: 'updates.json',
  version: 1,
  create: () => ({ schemaVersion: 1, entries: [] }),
  normalize(doc) {
    if (!Array.isArray(doc.entries)) doc.entries = [];
    return doc;
  },
};

export class UpdatesService {
  private readonly ctx: Ctx;
  private doc: Promise<JsonDoc<UpdatesDoc>> | null = null;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  private load(): Promise<JsonDoc<UpdatesDoc>> {
    this.doc ??= JsonDoc.load(this.ctx.platform.synced, UPDATES_SPEC, this.ctx.timing.updatesWriteMs, this.ctx.env);
    return this.doc;
  }

  /**
   * Entries in display order (newest chapter first). Chapters already recorded for the novel are
   * skipped (the widget and the app's own update check can both find the same chapter).
   * Returns the entries actually added.
   */
  async add(entries: UpdateEntry[]): Promise<UpdateEntry[]> {
    if (entries.length === 0) return [];
    const doc = await this.load();
    const seen = new Set<string>();
    for (const e of doc.value.entries) seen.add(`${novelKeyString(e)}\n${e.chapterPath}`);
    const fresh: UpdateEntry[] = [];
    for (const e of entries) {
      const id = `${novelKeyString(e)}\n${e.chapterPath}`;
      if (seen.has(id)) continue;
      seen.add(id);
      fresh.push(e);
    }
    if (fresh.length === 0) return [];
    const merged = (fresh.length > UPDATES_CAP ? fresh.slice(0, UPDATES_CAP) : fresh).concat(doc.value.entries);
    if (merged.length > UPDATES_CAP) merged.length = UPDATES_CAP;
    doc.value.entries = merged;
    doc.changed();
    return fresh;
  }

  async list(limit = 100): Promise<UpdateEntry[]> {
    const doc = await this.load();
    return doc.value.entries.slice(0, limit);
  }

  async markRead(key: string, chapterPaths: readonly string[], read: boolean): Promise<void> {
    if (chapterPaths.length === 0) return;
    const doc = await this.load();
    const paths = new Set(chapterPaths);
    let changed = false;
    for (const e of doc.value.entries) {
      if (e.read !== read && paths.has(e.chapterPath) && novelKeyString(e) === key) {
        e.read = read;
        changed = true;
      }
    }
    if (changed) doc.changed();
  }

  async removeNovel(key: string): Promise<void> {
    const doc = await this.load();
    const next = doc.value.entries.filter((e) => novelKeyString(e) !== key);
    if (next.length === doc.value.entries.length) return;
    doc.value.entries = next;
    doc.changed();
  }

  async all(): Promise<UpdateEntry[]> {
    const doc = await this.load();
    return doc.value.entries.map((e) => ({ ...e }));
  }

  /** Backup restore. merge: union per (novel, chapter), newer foundAt wins, read if read on either side. */
  async restore(entries: UpdateEntry[], mode: 'merge' | 'replace'): Promise<void> {
    const doc = await this.load();
    const byKey = new Map<string, UpdateEntry>();
    const id = (e: UpdateEntry): string => `${novelKeyString(e)}\n${e.chapterPath}`;
    if (mode === 'merge') for (const e of doc.value.entries) byKey.set(id(e), e);
    for (const e of entries) {
      const cur = byKey.get(id(e));
      if (!cur) {
        byKey.set(id(e), { ...e });
        continue;
      }
      byKey.set(id(e), { ...(e.foundAt > cur.foundAt ? e : cur), read: e.read || cur.read });
    }
    const merged = [...byKey.values()].sort((a, b) => b.foundAt - a.foundAt);
    if (merged.length > UPDATES_CAP) merged.length = UPDATES_CAP;
    doc.value.entries = merged;
    doc.changed();
  }

  async flush(): Promise<void> {
    if (this.doc) await (await this.doc).flush();
  }
}
