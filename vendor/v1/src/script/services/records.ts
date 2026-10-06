/**
 * Validators for stored records (library entries, categories, history, updates, repos), shared by
 * load-time cleanup (the JsonDoc `normalize` of each service) and backup restore. Each returns a clean
 * copy or null; nothing here throws.
 *
 * Load-time cleanup is lenient where a single bad field shouldn't cost a record (e.g. one bad category
 * id); restore is strict about the shape of what it imports.
 */
import type { Category, HistoryEntry, LibraryEntry, NovelStatus, RepoInfo, UpdateEntry } from '../../shared/contracts/domain.ts';
import { parseNovelKey } from '../../shared/contracts/domain.ts';
import { isHttpUrl, isRecord } from '../lib/validate.ts';

export type Rec = Record<string, unknown>;

export const STATUSES: readonly NovelStatus[] = ['ongoing', 'completed', 'hiatus', 'cancelled', 'unknown'];

export const isStr = (v: unknown): v is string => typeof v === 'string';
export const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** All non-empty strings, or null (strict). */
export const strArray = (v: unknown): string[] | null => (Array.isArray(v) && v.every(isNonEmpty) ? [...v] : null);
/** The non-empty strings of an array, deduplicated, order kept ([] for anything else; lenient). */
export const strings = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter(isNonEmpty))] : []);

export function copyOptional<T extends object>(target: T, src: Rec, keys: readonly string[], check: (v: unknown) => boolean): void {
  for (const k of keys) if (check(src[k])) (target as Rec)[k] = src[k];
}

export function validKey(pluginId: unknown, path: unknown): boolean {
  return isNonEmpty(pluginId) && !pluginId.includes(':') && isNonEmpty(path);
}

export function keyIsValid(key: string): boolean {
  try {
    const k = parseNovelKey(key);
    return validKey(k.pluginId, k.path);
  } catch {
    return false;
  }
}

/**
 * A library entry. `downloadedCount` is kept only for load-time cleanup (downloads are device-local,
 * so a restored entry starts at 0). Category ids are filtered leniently.
 */
export function libraryEntry(v: unknown, opts: { keepDownloadedCount?: boolean } = {}): LibraryEntry | null {
  if (!isRecord(v) || !validKey(v.pluginId, v.path) || !isStr(v.name)) return null;
  const pluginId = v.pluginId as string;
  const path = v.path as string;
  const count = (x: unknown): number => (isNum(x) && x > 0 ? Math.floor(x) : 0);
  const e: LibraryEntry = {
    key: `${pluginId}:${path}`,
    pluginId,
    path,
    name: v.name,
    addedAt: isNum(v.addedAt) ? v.addedAt : 0,
    chapterCount: count(v.chapterCount),
    unreadCount: count(v.unreadCount),
    downloadedCount: opts.keepDownloadedCount ? count(v.downloadedCount) : 0,
    categoryIds: strings(v.categoryIds),
  };
  copyOptional(e, v, ['cover', 'author', 'lastChapterPath', 'lastChapterName'], isStr);
  copyOptional(e, v, ['lastReadAt', 'lastUpdatedAt'], isNum);
  if (STATUSES.includes(v.status as NovelStatus)) e.status = v.status as NovelStatus;
  return e;
}

/** A category; a missing/invalid `order` takes `fallbackOrder` when given (load), else the record is invalid. */
export function category(v: unknown, fallbackOrder?: number): Category | null {
  if (!isRecord(v) || !isNonEmpty(v.id) || !isStr(v.name)) return null;
  const order = isNum(v.order) ? v.order : fallbackOrder;
  return order === undefined ? null : { id: v.id, name: v.name, order };
}

export function historyEntry(v: unknown): HistoryEntry | null {
  if (!isRecord(v) || !validKey(v.pluginId, v.path) || !isStr(v.novelName) || !isNonEmpty(v.chapterPath) || !isStr(v.chapterName)) return null;
  if (!isNum(v.readAt) || !isNum(v.percent)) return null;
  const h: HistoryEntry = {
    pluginId: v.pluginId as string,
    path: v.path as string,
    novelName: v.novelName,
    chapterPath: v.chapterPath,
    chapterName: v.chapterName,
    readAt: v.readAt,
    percent: Math.min(1, Math.max(0, v.percent)),
  };
  copyOptional(h, v, ['cover'], isStr);
  if (isNum(v.readingMs) && v.readingMs > 0) h.readingMs = v.readingMs;
  return h;
}

export function updateEntry(v: unknown): UpdateEntry | null {
  if (!isRecord(v) || !validKey(v.pluginId, v.path) || !isStr(v.novelName) || !isNonEmpty(v.chapterPath) || !isStr(v.chapterName)) return null;
  if (!isNum(v.foundAt) || typeof v.read !== 'boolean') return null;
  const u: UpdateEntry = {
    pluginId: v.pluginId as string,
    path: v.path as string,
    novelName: v.novelName,
    chapterPath: v.chapterPath,
    chapterName: v.chapterName,
    foundAt: v.foundAt,
    read: v.read,
  };
  copyOptional(u, v, ['cover'], isStr);
  return u;
}

export function repoInfo(v: unknown): RepoInfo | null {
  if (!isRecord(v) || !isStr(v.url) || !isHttpUrl(v.url)) return null;
  const r: RepoInfo = { url: v.url, name: isStr(v.name) ? v.name : v.url, pluginCount: isNum(v.pluginCount) ? v.pluginCount : 0 };
  if (isNum(v.fetchedAt)) r.fetchedAt = v.fetchedAt;
  return r;
}

/** Valid items of an array (anything else → []). */
export function validItems<T>(v: unknown, item: (x: unknown, index: number) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  v.forEach((x, i) => {
    const r = item(x, i);
    if (r !== null) out.push(r);
  });
  return out;
}
