/** Reading history (one entry per novel, newest first) in synced `history.json`. */
import type { HistoryEntry, NovelKey } from '../../shared/contracts/domain.ts';
import { novelKeyString } from '../../shared/contracts/domain.ts';
import { type DocSpec, JsonDoc } from '../storage/json-doc.ts';
import type { Ctx } from './context.ts';

export interface HistoryDoc {
  schemaVersion: number;
  entries: HistoryEntry[];
}

export const HISTORY_CAP = 300;

export const HISTORY_SPEC: DocSpec<HistoryDoc> = {
  path: 'history.json',
  version: 1,
  create: () => ({ schemaVersion: 1, entries: [] }),
  normalize(doc) {
    if (!Array.isArray(doc.entries)) doc.entries = [];
    return doc;
  },
};

function setReadingMs(entry: HistoryEntry, previous: number | undefined, add: number): void {
  const total = (typeof previous === 'number' && Number.isFinite(previous) ? previous : 0) + add;
  if (total > 0) entry.readingMs = total;
  else delete entry.readingMs;
}

export class HistoryService {
  private readonly doc: JsonDoc<HistoryDoc>;

  private constructor(doc: JsonDoc<HistoryDoc>) {
    this.doc = doc;
  }

  static async load(ctx: Ctx): Promise<HistoryService> {
    return new HistoryService(await JsonDoc.load(ctx.platform.synced, HISTORY_SPEC, ctx.timing.historyWriteMs, ctx.env));
  }

  /**
   * Upsert the novel's entry and move it to the front, carrying its total reading time forward plus
   * `addReadingMs`. Cheap when it already is the newest; then only a chapter change schedules a write
   * (percent/time updates ride on the next debounced write, app.flush or the close flush).
   */
  record(entry: HistoryEntry, addReadingMs = 0): void {
    const entries = this.doc.value.entries;
    const first = entries[0];
    const sameNovel = (e: HistoryEntry): boolean => e.pluginId === entry.pluginId && e.path === entry.path;
    if (first && sameNovel(first)) {
      setReadingMs(entry, first.readingMs, addReadingMs);
      entries[0] = entry;
      if (first.chapterPath === entry.chapterPath) {
        this.doc.changedQuietly();
        return;
      }
    } else {
      const i = entries.findIndex(sameNovel);
      setReadingMs(entry, i >= 0 ? entries[i]?.readingMs : undefined, addReadingMs);
      if (i >= 0) entries.splice(i, 1);
      entries.unshift(entry);
      if (entries.length > HISTORY_CAP) entries.length = HISTORY_CAP;
    }
    this.doc.changed();
  }

  list(limit = 50, before?: number): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    for (const e of this.doc.value.entries) {
      if (before !== undefined && e.readAt >= before) continue;
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  remove(key: NovelKey): void {
    const k = novelKeyString(key);
    const entries = this.doc.value.entries;
    const next = entries.filter((e) => novelKeyString(e) !== k);
    if (next.length === entries.length) return;
    this.doc.value.entries = next;
    this.doc.changed();
  }

  clear(): void {
    this.doc.value.entries = [];
    this.doc.changed();
  }

  all(): HistoryEntry[] {
    return this.doc.value.entries.map((e) => ({ ...e }));
  }

  /** Backup restore. merge: union per novel, the newer readAt wins, reading time keeps the larger total. */
  restore(entries: HistoryEntry[], mode: 'merge' | 'replace'): void {
    const byKey = new Map<string, HistoryEntry>();
    if (mode === 'merge') for (const e of this.doc.value.entries) byKey.set(novelKeyString(e), e);
    for (const e of entries) {
      const k = novelKeyString(e);
      const cur = byKey.get(k);
      if (!cur) {
        byKey.set(k, { ...e });
        continue;
      }
      const winner = { ...(e.readAt > cur.readAt ? e : cur) };
      const ms = Math.max(cur.readingMs ?? 0, e.readingMs ?? 0);
      if (ms > 0) winner.readingMs = ms;
      byKey.set(k, winner);
    }
    const merged = [...byKey.values()].sort((a, b) => b.readAt - a.readAt);
    if (merged.length > HISTORY_CAP) merged.length = HISTORY_CAP;
    this.doc.value.entries = merged;
    this.doc.changed();
  }

  flush(): Promise<void> {
    return this.doc.flush();
  }
}
