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
  RepoInfo,
  UpdateEntry,
} from '../../shared/contracts/domain.ts';
import { parseNovelKey } from '../../shared/contracts/domain.ts';
import type { BackupInfo, BackupPreview } from '../../shared/contracts/protocol.ts';
import { mapLimit } from '../lib/async.ts';
import { pad2 as p2 } from '../lib/dates.ts';
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
import { type Rec, category, copyOptional, historyEntry, isNum, isStr, isNonEmpty, keyIsValid, libraryEntry, repoInfo, strArray, updateEntry } from './records.ts';

export const BACKUP_DIR = 'backups';
export const BACKUP_VERSION = 1;
export const KEEP_BACKUPS = 10;
/** A picked backup stays restorable by importId this long after its preview. */
export const IMPORT_TTL_MS = 10 * 60 * 1000;
/** Picked backups kept in memory at once (each can be a few MB of JSON). */
const MAX_IMPORTS = 3;
const NAME_RE = /^tachinovel-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-(\d+))?\.json$/;
const SAFE_FILE_RE = /^[A-Za-z0-9._-]{1,200}\.json$/;

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
  /**
   * Plugin setting values (raw plugin-storage items, setting keys only; no other plugin storage),
   * per source id, built-ins included. Optional: older backups have none.
   */
  pluginSettings?: Record<string, Record<string, unknown>>;
}

export type RestoreMode = 'merge' | 'replace';

// ---------- validation ----------

function fail(message: string): never {
  throw invalidArgs(`Invalid backup: ${message}`);
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
const MAX_SETTINGS_KEYS = 200;
const MAX_SETTINGS_JSON = 64 * 1024;

/** Backed-up plugin settings: valid source ids, string keys, JSON values of bounded size per source. */
function parsePluginSettings(v: unknown, dropped: string[]): Record<string, Record<string, unknown>> | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) {
    dropped.push('pluginSettings');
    return undefined;
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, values] of Object.entries(v)) {
    let size = Infinity;
    try {
      size = JSON.stringify(values).length;
    } catch {
      // not serializable: dropped below
    }
    if (!isNonEmpty(id) || id.includes(':') || id.length > 200 || !isRecord(values) || Object.keys(values).length > MAX_SETTINGS_KEYS || size > MAX_SETTINGS_JSON) {
      dropped.push('pluginSettings');
      continue;
    }
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(values)) if (key.length > 0 && key.length <= 200 && item !== undefined && item !== null) clean[key] = item;
    out[id] = clean;
  }
  return out;
}

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
  const pluginSettings = parsePluginSettings(raw.pluginSettings, dropped);
  if (pluginSettings) backup.pluginSettings = pluginSettings;
  return { backup, dropped };
}

// ---------- names ----------

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

  /** Backups picked for a preview (backup.preview without fileName), restorable by importId. */
  private readonly imports = new Map<string, { text: string; at: number }>();

  constructor(ctx: Ctx, deps: BackupDeps) {
    this.ctx = ctx;
    this.d = deps;
  }

  /**
   * backup.preview: what a backup holds and what a restore would bring in, without changing anything.
   * A listed backup is named by fileName; otherwise the user picks a file, which is kept in memory for
   * this session under an importId (single use, expires after IMPORT_TTL_MS) so restore needn't ask again.
   * A cancelled pick → NOT_FOUND "No backup was picked".
   */
  async preview(a: { fileName?: string }): Promise<BackupPreview> {
    const { platform } = this.ctx;
    this.dropExpiredImports();
    let text: string | null;
    let importId: string | undefined;
    if (a.fileName !== undefined) {
      text = await platform.synced.readText(this.backupPath(a.fileName));
    } else {
      const picked = await platform.native.pickFile(['public.json']);
      if (!picked) throw notFound('No backup was picked');
      text = await this.readPicked(picked);
    }
    if (text === null) throw notFound('Backup file is missing');
    const { backup, dropped } = parseBackup(text); // INVALID_ARGS for files that aren't usable backups
    if (a.fileName === undefined) {
      importId = `imp-${platform.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      this.imports.set(importId, { text, at: platform.now() });
      while (this.imports.size > MAX_IMPORTS) {
        const oldest = this.imports.keys().next().value;
        if (oldest === undefined) break;
        this.imports.delete(oldest);
      }
    }
    const preview: BackupPreview = {
      createdAt: backup.createdAt,
      counts: {
        novels: backup.library.length,
        categories: backup.categories.length,
        progress: Object.keys(backup.progress).length,
        history: backup.history.length,
        updates: backup.updates.length,
        sources: backup.sources.length,
        repos: backup.repos.length,
        pluginSettings: Object.keys(backup.pluginSettings ?? {}).length,
      },
      newNovels: backup.library.filter((e) => !this.d.library.has(e.key)).length,
      skipped: dropped.length,
    };
    if (a.fileName !== undefined) preview.fileName = a.fileName;
    if (importId) preview.importId = importId;
    if (backup.buildVersion) preview.buildVersion = backup.buildVersion;
    return preview;
  }

  private dropExpiredImports(): void {
    const now = this.ctx.platform.now();
    for (const [id, imp] of this.imports) if (now - imp.at > IMPORT_TTL_MS) this.imports.delete(id);
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
    const pluginSettings = await this.d.sources.backupSettings();
    if (Object.keys(pluginSettings).length > 0) backup.pluginSettings = pluginSettings;
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

  async restore(a: { fileName?: string; importId?: string; mode: RestoreMode }): Promise<{ novels: number; sources: number }> {
    const { platform } = this.ctx;
    let text: string | null;
    if (a.importId !== undefined) {
      this.dropExpiredImports();
      const imp = this.imports.get(a.importId);
      if (!imp) throw notFound('That picked backup has expired; pick it again');
      text = imp.text;
      this.imports.delete(a.importId); // single use
    } else if (a.fileName !== undefined) {
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
    if (backup.pluginSettings) await this.d.sources.restoreSettings(backup.pluginSettings, a.mode);
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
