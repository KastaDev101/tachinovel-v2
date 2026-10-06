/**
 * Backup & restore.
 *
 * Backups are single JSON files in the synced store: `backups/tachinovel-backup-YYYY-MM-DD-HHmm.json`
 * (local time; "-2", "-3"… within the same minute), newest 10 kept. They hold settings, library +
 * categories, per-novel progress (read sets, bookmarks, positions), history (with reading time),
 * updates, installed sources (no code: re-downloaded on restore) and repos. Built-in sources are skipped.
 *
 * Restore validates the whole file before writing anything. `replace` makes the backup the state;
 * `merge` keeps current data and folds the backup in (newer timestamps win, read sets are unioned,
 * current settings are kept). Afterwards library counts are recomputed in the background (chapter
 * lists missing on this device are fetched).
 */
import type {
  AppSettings,
  Category,
  ChapterPosition,
  HistoryEntry,
  LibraryEntry,
  NovelStatus,
  RepoInfo,
  UpdateEntry,
} from '../../shared/contracts/domain.ts';
import { parseNovelKey } from '../../shared/contracts/domain.ts';
import type { BackupInfo } from '../../shared/contracts/protocol.ts';
import { mapLimit } from '../lib/async.ts';
import { errorMessage, invalidArgs, notFound, storageError } from '../lib/errors.ts';
import { isHttpUrl, isRecord } from '../lib/validate.ts';
import type { JsonDoc } from '../storage/json-doc.ts';
import type { Ctx } from './context.ts';
import type { CoverCache } from './covers.ts';
import type { HistoryService } from './history.ts';
import type { LibraryService } from './library.ts';
import type { NovelStore } from './novel-store.ts';
import { type NovelService, countUnread } from './novels.ts';
import type { ProgressService, ProgressSnapshot } from './progress.ts';
import { sanitizeSettings } from './settings.ts';
import type { SourceBackup, SourceService } from './sources.ts';
import type { UpdatesService } from './updates.ts';

export const BACKUP_DIR = 'backups';
export const BACKUP_VERSION = 1;
export const KEEP_BACKUPS = 10;
const NAME_RE = /^tachinovel-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-(\d+))?\.json$/;
const SAFE_FILE_RE = /^[A-Za-z0-9._-]{1,200}\.json$/;
const STATUSES: readonly NovelStatus[] = ['ongoing', 'completed', 'hiatus', 'cancelled', 'unknown'];

export interface BackupFile {
  schemaVersion: number;
  app: 'tachinovel';
  createdAt: number;
  buildVersion: string;
  settings: AppSettings;
  library: LibraryEntry[];
  categories: Category[];
  /** novelKey → progress */
  progress: Record<string, ProgressSnapshot>;
  history: HistoryEntry[];
  updates: UpdateEntry[];
  sources: SourceBackup[];
  repos: RepoInfo[];
}

export type RestoreMode = 'merge' | 'replace';

// ---------- validation ----------

type Rec = Record<string, unknown>;

function fail(message: string): never {
  throw invalidArgs(`Invalid backup: ${message}`);
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strArray = (v: unknown): string[] | null => (Array.isArray(v) && v.every(isNonEmpty) ? [...v] : null);

function copyOptional<T extends object>(target: T, src: Rec, keys: readonly string[], check: (v: unknown) => boolean): void {
  for (const k of keys) if (check(src[k])) (target as Rec)[k] = src[k];
}

function validKey(pluginId: unknown, path: unknown): boolean {
  return isNonEmpty(pluginId) && !pluginId.includes(':') && isNonEmpty(path);
}

function keyIsValid(key: string): boolean {
  try {
    const k = parseNovelKey(key);
    return validKey(k.pluginId, k.path);
  } catch {
    return false;
  }
}

function libraryEntry(v: unknown): LibraryEntry | null {
  if (!isRecord(v) || !validKey(v.pluginId, v.path) || !isStr(v.name)) return null;
  const pluginId = v.pluginId as string;
  const path = v.path as string;
  const e: LibraryEntry = {
    key: `${pluginId}:${path}`,
    pluginId,
    path,
    name: v.name,
    addedAt: isNum(v.addedAt) ? v.addedAt : 0,
    chapterCount: isNum(v.chapterCount) ? v.chapterCount : 0,
    unreadCount: isNum(v.unreadCount) ? v.unreadCount : 0,
    downloadedCount: 0, // downloads are device-local, never in backups
    categoryIds: strArray(v.categoryIds) ?? [],
  };
  copyOptional(e, v, ['cover', 'author', 'lastChapterPath', 'lastChapterName'], isStr);
  copyOptional(e, v, ['lastReadAt', 'lastUpdatedAt'], isNum);
  if (STATUSES.includes(v.status as NovelStatus)) e.status = v.status as NovelStatus;
  return e;
}

function category(v: unknown): Category | null {
  if (!isRecord(v) || !isNonEmpty(v.id) || !isStr(v.name) || !isNum(v.order)) return null;
  return { id: v.id, name: v.name, order: v.order };
}

function progressSnapshot(v: unknown): ProgressSnapshot | null {
  if (!isRecord(v)) return null;
  const read = strArray(v.read ?? []);
  const bookmarks = strArray(v.bookmarks ?? []);
  if (!read || !bookmarks || (v.positions !== undefined && !isRecord(v.positions))) return null;
  const positions: Record<string, ChapterPosition> = {};
  const rawPositions: Rec = isRecord(v.positions) ? v.positions : {};
  for (const [path, p] of Object.entries(rawPositions)) {
    if (!isRecord(p) || !isNum(p.percent) || !isNum(p.paragraph)) return null;
    const pos: ChapterPosition = { percent: p.percent, paragraph: p.paragraph };
    if (isNum(p.offset)) pos.offset = p.offset;
    positions[path] = pos;
  }
  const out: ProgressSnapshot = { read, bookmarks, positions };
  copyOptional(out, v, ['lastChapterPath', 'lastChapterName', 'novelName', 'cover'], isStr);
  copyOptional(out, v, ['lastReadAt'], isNum);
  return out;
}

function historyEntry(v: unknown): HistoryEntry | null {
  if (!isRecord(v) || !validKey(v.pluginId, v.path) || !isStr(v.novelName) || !isNonEmpty(v.chapterPath) || !isStr(v.chapterName)) return null;
  if (!isNum(v.readAt) || !isNum(v.percent)) return null;
  const h: HistoryEntry = {
    pluginId: v.pluginId as string,
    path: v.path as string,
    novelName: v.novelName,
    chapterPath: v.chapterPath,
    chapterName: v.chapterName,
    readAt: v.readAt,
    percent: v.percent,
  };
  copyOptional(h, v, ['cover'], isStr);
  if (isNum(v.readingMs) && v.readingMs > 0) h.readingMs = v.readingMs;
  return h;
}

function updateEntry(v: unknown): UpdateEntry | null {
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

function sourceBackup(v: unknown): SourceBackup | null {
  if (!isRecord(v) || !isNonEmpty(v.id) || !isStr(v.name)) return null;
  const b: SourceBackup = {
    id: v.id,
    name: v.name,
    site: isStr(v.site) ? v.site : '',
    lang: isStr(v.lang) ? v.lang : 'Unknown',
    version: isStr(v.version) ? v.version : '',
    enabled: v.enabled !== false,
    pinned: v.pinned === true,
  };
  if (isStr(v.installUrl) && isHttpUrl(v.installUrl)) b.installUrl = v.installUrl;
  if (isStr(v.repoUrl) && isHttpUrl(v.repoUrl)) b.repoUrl = v.repoUrl;
  return b;
}

function repoInfo(v: unknown): RepoInfo | null {
  if (!isRecord(v) || !isStr(v.url) || !isHttpUrl(v.url)) return null;
  const r: RepoInfo = { url: v.url, name: isStr(v.name) ? v.name : v.url, pluginCount: isNum(v.pluginCount) ? v.pluginCount : 0 };
  if (isNum(v.fetchedAt)) r.fetchedAt = v.fetchedAt;
  return r;
}

function list<T>(raw: Rec, key: string, item: (v: unknown) => T | null, dropped: string[]): T[] {
  const v = raw[key] ?? [];
  if (!Array.isArray(v)) fail(`"${key}" must be an array`);
  const out: T[] = [];
  for (const x of v) {
    const ok = item(x);
    if (ok) out.push(ok);
    else dropped.push(key);
  }
  return out;
}

/** Parse and validate a backup. Throws INVALID_ARGS for files that can't be restored; drops malformed items. */
export function parseBackup(text: string): { backup: BackupFile; dropped: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('not valid JSON');
  }
  if (!isRecord(raw) || raw.app !== 'tachinovel') fail('not a TachiNovel backup');
  const version = raw.schemaVersion;
  if (!isNum(version) || !Number.isInteger(version) || version < 1) fail('missing schemaVersion');
  if (version > BACKUP_VERSION) fail(`made by a newer version of the app (schema ${version})`);
  if (!isRecord(raw.settings)) fail('"settings" must be an object');
  if (raw.progress !== undefined && !isRecord(raw.progress)) fail('"progress" must be an object');
  const dropped: string[] = [];
  const progress: Record<string, ProgressSnapshot> = {};
  const rawProgress: Rec = isRecord(raw.progress) ? raw.progress : {};
  for (const [key, v] of Object.entries(rawProgress)) {
    const snap = keyIsValid(key) ? progressSnapshot(v) : null;
    if (snap) progress[key] = snap;
    else dropped.push('progress');
  }
  const backup: BackupFile = {
    schemaVersion: version,
    app: 'tachinovel',
    createdAt: isNum(raw.createdAt) ? raw.createdAt : 0,
    buildVersion: isStr(raw.buildVersion) ? raw.buildVersion : '',
    settings: sanitizeSettings(raw.settings),
    library: list(raw, 'library', libraryEntry, dropped),
    categories: list(raw, 'categories', category, dropped),
    progress,
    history: list(raw, 'history', historyEntry, dropped),
    updates: list(raw, 'updates', updateEntry, dropped),
    sources: list(raw, 'sources', sourceBackup, dropped),
    repos: list(raw, 'repos', repoInfo, dropped),
  };
  return { backup, dropped };
}

// ---------- names ----------

const p2 = (n: number): string => String(n).padStart(2, '0');

export function backupFileName(ms: number, n = 1): string {
  const d = new Date(ms);
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  return `tachinovel-backup-${stamp}${n > 1 ? `-${n}` : ''}.json`;
}

function parseName(name: string): { createdAt: number; seq: number } | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, seq] = m;
  return { createdAt: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime(), seq: seq ? Number(seq) : 1 };
}

// ---------- service ----------

export interface BackupDeps {
  buildVersion: string;
  settingsDoc: JsonDoc<AppSettings>;
  library: LibraryService;
  history: HistoryService;
  updates: UpdatesService;
  progress: ProgressService;
  sources: SourceService;
  novels: NovelService;
  store: NovelStore;
  covers: CoverCache;
  /** Persist every pending debounced write. */
  flush(): Promise<void>;
  /** Apply caps etc. after settings were replaced. */
  settingsChanged(): void;
}

export class BackupService {
  private readonly ctx: Ctx;
  private readonly d: BackupDeps;
  private reconciling: Promise<void> | null = null;

  constructor(ctx: Ctx, deps: BackupDeps) {
    this.ctx = ctx;
    this.d = deps;
  }

  /** Resolves when the post-restore background recount/refresh is done (tests). */
  idle(): Promise<void> {
    return this.reconciling ?? Promise.resolve();
  }

  async create(): Promise<BackupInfo> {
    const { synced } = this.ctx.platform;
    await this.d.flush();
    const progress: Record<string, ProgressSnapshot> = {};
    for (const key of (await this.d.progress.allKeys()).sort()) progress[key] = (await this.d.progress.get(key)).snapshot();
    const createdAt = this.ctx.platform.now();
    const backup: BackupFile = {
      schemaVersion: BACKUP_VERSION,
      app: 'tachinovel',
      createdAt,
      buildVersion: this.d.buildVersion,
      settings: this.d.settingsDoc.value,
      library: this.d.library.all().map((e) => ({ ...e, downloadedCount: 0 })),
      categories: this.d.library.categories(),
      progress,
      history: this.d.history.all(),
      updates: await this.d.updates.all(),
      sources: this.d.sources.backupSources(),
      repos: this.d.sources.repos(),
    };
    let n = 1;
    while (synced.exists(`${BACKUP_DIR}/${backupFileName(createdAt, n)}`)) n++;
    const fileName = backupFileName(createdAt, n);
    const text = JSON.stringify(backup);
    try {
      await synced.writeText(`${BACKUP_DIR}/${fileName}`, text);
    } catch (err) {
      throw storageError('write', `${BACKUP_DIR}/${fileName}`, err);
    }
    this.prune();
    this.ctx.platform.log('info', `Backup written: ${fileName} (${text.length} bytes)`);
    return { fileName, createdAt, bytes: text.length };
  }

  /** Newest first. */
  list(): BackupInfo[] {
    const { synced } = this.ctx.platform;
    const out: (BackupInfo & { seq: number })[] = [];
    for (const name of synced.list(BACKUP_DIR)) {
      const parsed = parseName(name);
      if (parsed) out.push({ fileName: name, createdAt: parsed.createdAt, bytes: synced.size(`${BACKUP_DIR}/${name}`), seq: parsed.seq });
    }
    out.sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
    return out.map(({ fileName, createdAt, bytes }) => ({ fileName, createdAt, bytes }));
  }

  private prune(): void {
    for (const old of this.list().slice(KEEP_BACKUPS)) {
      try {
        this.ctx.platform.synced.remove(`${BACKUP_DIR}/${old.fileName}`);
      } catch (err) {
        this.ctx.platform.log('warn', `Failed to delete old backup ${old.fileName}: ${errorMessage(err)}`);
      }
    }
  }

  private backupPath(fileName: string): string {
    if (!SAFE_FILE_RE.test(fileName)) throw invalidArgs(`Invalid backup file name "${fileName}"`);
    const rel = `${BACKUP_DIR}/${fileName}`;
    if (!this.ctx.platform.synced.exists(rel)) throw notFound(`No backup named ${fileName}`);
    return rel;
  }

  async share(fileName: string): Promise<void> {
    const rel = this.backupPath(fileName);
    await this.ctx.platform.native.shareFile(this.ctx.platform.synced.absolute(rel));
  }

  /** Read a picked file (absolute path) through whichever store contains it. */
  private async readPicked(abs: string): Promise<string | null> {
    const { local, synced } = this.ctx.platform;
    const norm = (p: string): string => p.replace(/\\/g, '/');
    for (const store of [local, synced]) {
      const root = norm(store.root).replace(/\/+$/, '');
      const p = norm(abs);
      if (p.startsWith(`${root}/`)) return store.readText(p.slice(root.length + 1));
    }
    throw invalidArgs('The picked file is outside the app storage');
  }

  async restore(a: { fileName?: string; mode: RestoreMode }): Promise<{ novels: number; sources: number }> {
    const { platform } = this.ctx;
    let text: string | null;
    if (a.fileName !== undefined) {
      text = await platform.synced.readText(this.backupPath(a.fileName));
    } else {
      const picked = await platform.native.pickFile(['public.json']);
      if (!picked) return { novels: 0, sources: 0 }; // cancelled
      text = await this.readPicked(picked);
    }
    if (text === null) throw notFound('Backup file is missing');
    // Validate everything before touching any state.
    const { backup, dropped } = parseBackup(text);
    if (dropped.length > 0) platform.log('warn', `Restore: skipped ${dropped.length} malformed item(s)`, [...new Set(dropped)]);
    await this.apply(backup, a.mode);
    const sources = await this.d.sources.restore(backup.sources, backup.repos, a.mode);
    await this.d.flush();
    this.reconciling = this.reconcileLibrary().finally(() => {
      this.reconciling = null;
    });
    platform.log('info', `Restored backup (${a.mode}): ${backup.library.length} novels, ${sources} sources`);
    return { novels: backup.library.length, sources };
  }

  private async apply(b: BackupFile, mode: RestoreMode): Promise<void> {
    const d = this.d;
    if (mode === 'replace') {
      d.settingsDoc.value = b.settings;
      d.settingsDoc.changed();
      d.settingsChanged();
    }
    const before = new Map(d.library.all().map((e) => [e.key, e] as const));
    d.library.restore(b.library, b.categories, mode);
    for (const [key, old] of before) {
      if (d.library.has(key)) continue;
      d.store.delete(key);
      d.covers.remove(old.cover);
    }
    if (mode === 'replace') {
      for (const key of await d.progress.allKeys()) if (!Object.hasOwn(b.progress, key)) await d.progress.remove(key);
    }
    for (const [key, snap] of Object.entries(b.progress)) (await d.progress.get(key)).restore(snap, mode);
    d.history.restore(b.history, mode);
    await d.updates.restore(b.updates, mode);
    await d.flush();
    d.library.emitChanged();
  }

  /** Recount unread chapters from stored chapter lists; fetch the lists this device doesn't have yet. */
  private async reconcileLibrary(): Promise<void> {
    const d = this.d;
    await mapLimit(
      d.library.all().map((e) => e.key),
      3,
      async (key) => {
        try {
          const known = d.store.hasStored(key) ? await d.store.loadStored(key) : null;
          if (!known) {
            await d.novels.refreshLibraryNovel(key, { recordUpdates: false, lane: 'background' });
            return;
          }
          const prog = await d.progress.get(key);
          d.library.update(key, (e) => {
            e.chapterCount = known.chapters.length;
            e.unreadCount = countUnread(known.chapters, prog.read);
          });
        } catch (err) {
          this.ctx.platform.log('warn', `Restore: couldn't refresh ${parseNovelKey(key).path}: ${errorMessage(err)}`);
        }
      },
    );
    d.library.notifyChanged();
  }
}
