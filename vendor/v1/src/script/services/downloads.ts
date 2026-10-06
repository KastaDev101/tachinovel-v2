/**
 * Opt-in downloads: local `downloads/<hash(novelKey)>/<hash(chapterPath)>.json` plus a per-novel
 * manifest (`index.json`, path → file + exact size). A single sequential worker runs (background lane)
 * while the app is open; the queue is persisted in synced `downloads-queue.json` and resumed on the
 * next launch. Locked chapters are never fetched.
 */
import type { NovelKey } from '../../shared/contracts/domain.ts';
import { novelKeyString } from '../../shared/contracts/domain.ts';
import { AppError, errorCode, errorMessage, storageError } from '../lib/errors.ts';
import { hashKey } from '../lib/hash.ts';
import { utf8Length } from '../lib/text.ts';
import { isRecord } from '../lib/validate.ts';
import { type DocSpec, JsonDoc } from '../storage/json-doc.ts';
import type { Ctx } from './context.ts';
import type { LibraryService } from './library.ts';
import type { StorageAlarm } from './storage-alarm.ts';
import { type NovelStore, chapterIndex } from './novel-store.ts';

interface ManifestEntry {
  file: string;
  title: string;
  bytes: number;
  at: number;
}

interface ManifestDoc {
  schemaVersion: number;
  key: string;
  chapters: Record<string, ManifestEntry>;
}

interface DownloadFile {
  path: string;
  title: string;
  html: string;
}

interface Job {
  key: string;
  novel: NovelKey;
  chapterPath: string;
}

interface QueueDoc {
  schemaVersion: number;
  jobs: { pluginId: string; novelPath: string; chapterPath: string }[];
}

export const QUEUE_PATH = 'downloads-queue.json';

export const QUEUE_SPEC: DocSpec<QueueDoc> = {
  path: QUEUE_PATH,
  version: 1,
  create: () => ({ schemaVersion: 1, jobs: [] }),
  normalize: (d) => ({
    schemaVersion: 1,
    jobs: (Array.isArray(d.jobs) ? (d.jobs as unknown[]) : []).filter(
      (j): j is QueueDoc['jobs'][number] => isRecord(j) && typeof j.pluginId === 'string' && typeof j.novelPath === 'string' && typeof j.chapterPath === 'string',
    ),
  }),
};

/** Download files are `<hash>.json` inside the novel's folder (never a path elsewhere). */
const DOWNLOAD_FILE_RE = /^[A-Za-z0-9_-]{1,64}\.json$/;

/** Manifest entries made safe to use: a bad entry is dropped (its file is then re-downloadable). */
function manifestChapters(raw: Record<string, unknown>): Record<string, ManifestEntry> {
  const out: Record<string, ManifestEntry> = {};
  for (const [path, e] of Object.entries(raw)) {
    if (!path || !isRecord(e) || typeof e.file !== 'string' || !DOWNLOAD_FILE_RE.test(e.file)) continue;
    const bytes = typeof e.bytes === 'number' && Number.isFinite(e.bytes) && e.bytes > 0 ? e.bytes : 0;
    const at = typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : 0;
    out[path] = { file: e.file, title: typeof e.title === 'string' ? e.title : '', bytes, at };
  }
  return out;
}
/** Consecutive network failures after which the queue pauses (kept; resumes on the next enqueue or launch). */
export const PAUSE_AFTER_NETWORK_FAILURES = 3;
const NETWORK_CODES = new Set(['NETWORK', 'TIMEOUT', 'CLOUDFLARE']);

interface NovelRun {
  novel: NovelKey;
  done: number;
  total: number;
  remaining: number;
}

export type ChapterFetcher = (key: string, novel: NovelKey, chapterPath: string) => Promise<{ html: string; title?: string }>;

export const DOWNLOADS_DIR = 'downloads';

export function downloadDir(key: string): string {
  return `${DOWNLOADS_DIR}/${hashKey(key)}`;
}

export class DownloadService {
  private readonly ctx: Ctx;
  private readonly library: LibraryService;
  private readonly novels: NovelStore;
  private readonly docs = new Map<string, Promise<JsonDoc<ManifestDoc> | null>>();
  private queue: Job[] = [];
  private readonly queued = new Set<string>();
  private readonly runs = new Map<string, NovelRun>();
  private worker: Promise<void> | null = null;
  private fetcher: ChapterFetcher | null = null;
  private current: Job | null = null;
  private queueDoc: JsonDoc<QueueDoc> | null = null;
  private queueLoad: Promise<void> | null = null;
  /** Jobs loaded from the previous session that resume() hasn't queued yet (still persisted). */
  private pendingResume: Job[] = [];
  /** Paused after repeated network failures (offline, source down) or a failed save: jobs stay queued. */
  private paused = false;
  /** Tells the user once when downloads can't be saved (set by services). */
  storageAlarm: StorageAlarm | null = null;

  constructor(ctx: Ctx, library: LibraryService, novels: NovelStore) {
    this.ctx = ctx;
    this.library = library;
    this.novels = novels;
  }

  setFetcher(fetcher: ChapterFetcher): void {
    this.fetcher = fetcher;
  }

  /** Load the persisted queue (small synced file). Idempotent. */
  init(): Promise<void> {
    this.queueLoad ??= JsonDoc.load<QueueDoc>(
      this.ctx.platform.synced,
      QUEUE_SPEC,
      this.ctx.timing.indexWriteMs,
      this.ctx.env,
    ).then(
      (doc) => {
        this.pendingResume = [];
        for (const j of doc.value.jobs) {
          if (j && typeof j.pluginId === 'string' && typeof j.novelPath === 'string' && typeof j.chapterPath === 'string') {
            const novel = { pluginId: j.pluginId, path: j.novelPath };
            this.pendingResume.push({ key: novelKeyString(novel), novel, chapterPath: j.chapterPath });
          }
        }
        doc.beforeWrite = () => {
          const ids = new Set<string>();
          const jobs: QueueDoc['jobs'] = [];
          for (const j of [...(this.current ? [this.current] : []), ...this.queue, ...this.pendingResume]) {
            const id = `${j.key}\n${j.chapterPath}`;
            if (ids.has(id)) continue;
            ids.add(id);
            jobs.push({ pluginId: j.novel.pluginId, novelPath: j.novel.path, chapterPath: j.chapterPath });
          }
          doc.value = { schemaVersion: 1, jobs };
        };
        this.queueDoc = doc;
        if (this.queue.length > 0) doc.changed();
      },
      (err: unknown) => {
        this.ctx.platform.log('warn', `Download queue unavailable: ${errorMessage(err)}`);
      },
    );
    return this.queueLoad;
  }

  /** Re-queue the downloads left over from the previous session. */
  async resume(): Promise<number> {
    await this.init();
    const jobs = this.pendingResume;
    this.pendingResume = [];
    const byNovel = new Map<string, { novel: NovelKey; paths: string[] }>();
    for (const j of jobs) {
      let g = byNovel.get(j.key);
      if (!g) {
        g = { novel: j.novel, paths: [] };
        byNovel.set(j.key, g);
      }
      g.paths.push(j.chapterPath);
    }
    for (const g of byNovel.values()) this.enqueue(g.novel, g.paths);
    if (jobs.length > 0) this.ctx.platform.log('info', `Resuming ${jobs.length} queued download(s)`);
    return jobs.length;
  }

  private queueChanged(): void {
    // Not loaded yet (the app loads it after the first paint): loading it saves the queue right away.
    if (this.queueDoc) this.queueDoc.changed();
    else void this.init();
  }

  /** Queued + running jobs (tests/diagnostics). */
  get pending(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  /** Resolves when the queue is empty (tests). */
  idle(): Promise<void> {
    return this.worker ?? Promise.resolve();
  }

  private manifest(key: string, create: boolean): Promise<JsonDoc<ManifestDoc> | null> {
    let p = this.docs.get(key);
    if (p) {
      return p.then((doc) => (doc || !create ? doc : this.openManifest(key, true)));
    }
    p = this.openManifest(key, create);
    return p;
  }

  private openManifest(key: string, create: boolean): Promise<JsonDoc<ManifestDoc> | null> {
    const path = `${downloadDir(key)}/index.json`;
    if (!create && !this.ctx.platform.local.exists(path)) return Promise.resolve(null);
    const p = JsonDoc.load<ManifestDoc>(
      this.ctx.platform.local,
      {
        path,
        version: 1,
        create: () => ({ schemaVersion: 1, key, chapters: {} }),
        normalize: (doc) => (doc.key === key && isRecord(doc.chapters) ? { schemaVersion: doc.schemaVersion, key, chapters: manifestChapters(doc.chapters) } : { schemaVersion: 1, key, chapters: {} }),
      },
      this.ctx.timing.indexWriteMs,
      this.ctx.env,
    );
    this.docs.set(key, p);
    void p.catch(() => {
      if (this.docs.get(key) === p) this.docs.delete(key);
    });
    return p;
  }

  async downloadedSet(key: string): Promise<ReadonlySet<string>> {
    const doc = await this.manifest(key, false);
    return new Set(doc ? Object.keys(doc.value.chapters) : []);
  }

  async isDownloaded(key: string, chapterPath: string): Promise<boolean> {
    const doc = await this.manifest(key, false);
    return !!doc && Object.hasOwn(doc.value.chapters, chapterPath);
  }

  async count(key: string): Promise<number> {
    const doc = await this.manifest(key, false);
    return doc ? Object.keys(doc.value.chapters).length : 0;
  }

  async read(key: string, chapterPath: string): Promise<{ title: string; html: string } | null> {
    const doc = await this.manifest(key, false);
    const entry = doc && Object.hasOwn(doc.value.chapters, chapterPath) ? doc.value.chapters[chapterPath] : undefined;
    if (!doc || !entry) return null;
    const text = await this.ctx.platform.local.readText(`${downloadDir(key)}/${entry.file}`);
    if (text === null) {
      delete doc.value.chapters[chapterPath];
      doc.changed();
      return null;
    }
    try {
      const f = JSON.parse(text) as Partial<DownloadFile> | null;
      if (!f || typeof f.html !== 'string') return null; // damaged copy: served from the source instead
      return { title: typeof f.title === 'string' ? f.title : '', html: f.html };
    } catch {
      return null;
    }
  }

  enqueue(novel: NovelKey, chapterPaths: readonly string[]): void {
    this.paused = false; // a new request (or the launch resume) tries the network again
    const key = novelKeyString(novel);
    let run = this.runs.get(key);
    if (!run) {
      run = { novel, done: 0, total: 0, remaining: 0 };
      this.runs.set(key, run);
    }
    for (const chapterPath of chapterPaths) {
      const id = `${key}\n${chapterPath}`;
      if (this.queued.has(id)) continue;
      this.queued.add(id);
      this.queue.push({ key, novel, chapterPath });
      run.total++;
      run.remaining++;
    }
    if (run.remaining === 0) this.runs.delete(key);
    this.queueChanged();
    this.kick();
  }

  /** True while the queue waits for the network (see PAUSE_AFTER_NETWORK_FAILURES). */
  get isPaused(): boolean {
    return this.paused;
  }

  private kick(): void {
    if (this.worker || this.queue.length === 0 || this.paused) return;
    this.worker = this.work().finally(() => {
      this.worker = null;
      this.kick();
    });
  }

  private async work(): Promise<void> {
    let networkFailures = 0;
    for (;;) {
      const job = this.queue.shift();
      if (!job) return;
      this.queued.delete(`${job.key}\n${job.chapterPath}`);
      this.current = job;
      let retryLater = false;
      try {
        await this.downloadOne(job);
        networkFailures = 0;
      } catch (err) {
        this.ctx.platform.log('warn', `Download failed for ${job.key} ${job.chapterPath}: ${errorMessage(err)}`);
        if (errorCode(err) === 'STORAGE') {
          // Can't save (usually a full iPhone): every next chapter would fail the same way. Keep the job,
          // pause, tell the user once.
          this.queue.unshift(job);
          this.queued.add(`${job.key}\n${job.chapterPath}`);
          this.paused = true;
          this.storageAlarm?.downloadWriteFailed(err);
          return; // (finally: current cleared, queue saved)
        }
        if (NETWORK_CODES.has(errorCode(err) ?? '')) {
          // Not this chapter's fault: keep it queued, and stop hammering after a few in a row.
          networkFailures++;
          retryLater = true;
          this.queue.unshift(job);
          this.queued.add(`${job.key}\n${job.chapterPath}`);
        } else {
          networkFailures = 0;
        }
      } finally {
        this.current = null;
        this.queueChanged();
      }
      if (retryLater) {
        if (networkFailures >= PAUSE_AFTER_NETWORK_FAILURES) {
          this.paused = true;
          this.ctx.platform.log('warn', `Downloads paused after ${networkFailures} network failures; ${this.queue.length} chapter(s) kept for later`);
          this.ctx.events.emit('app.error', { message: 'Downloads paused: the source or network is unavailable. They resume next time.' });
          return;
        }
        continue;
      }
      const run = this.runs.get(job.key);
      if (!run) continue; // deleted meanwhile
      run.done++;
      run.remaining--;
      const finished = run.remaining <= 0;
      this.ctx.events.emit('downloads.progress', {
        pluginId: run.novel.pluginId,
        novelPath: run.novel.path,
        done: run.done,
        total: run.total,
        finished,
      });
      if (finished) {
        this.runs.delete(job.key);
        await this.syncLibraryCount(job.key);
      }
    }
  }

  private async downloadOne(job: Job): Promise<void> {
    if (await this.isDownloaded(job.key, job.chapterPath)) return;
    const known = await this.novels.known(job.key);
    const idx = known ? chapterIndex(known.chapters, job.chapterPath) : -1;
    const meta = known && idx >= 0 ? known.chapters[idx] : undefined;
    if (meta?.locked) throw new AppError('LOCKED', `Chapter is locked: ${job.chapterPath}`);
    if (!this.fetcher) throw new Error('No chapter fetcher');
    const got = await this.fetcher(job.key, job.novel, job.chapterPath);
    if (!this.runs.has(job.key)) return; // deleted while fetching
    const title = meta?.name ?? got.title ?? '';
    const file = `${hashKey(job.chapterPath)}.json`;
    const text = JSON.stringify({ path: job.chapterPath, title, html: got.html } satisfies DownloadFile);
    try {
      await this.ctx.platform.local.writeText(`${downloadDir(job.key)}/${file}`, text);
    } catch (err) {
      throw storageError('write', `${downloadDir(job.key)}/${file}`, err);
    }
    const doc = await this.manifest(job.key, true);
    if (!doc) return;
    // Exact size of what was written (FileManager only reports whole KB).
    doc.value.chapters[job.chapterPath] = { file, title, bytes: utf8Length(text), at: this.ctx.platform.now() };
    doc.changed();
  }

  /**
   * Re-index downloads that finished just before the app was closed or killed: the chapter file was
   * written but the manifest entry (saved a moment later) never was. Only files that are complete,
   * well-formed downloads of a chapter the manifest doesn't list are adopted; nothing is deleted.
   * `keys`: the novels to look at (their folders are named by a hash of the key).
   */
  async adoptOrphans(keys: readonly string[]): Promise<number> {
    const { local } = this.ctx.platform;
    let total = 0;
    for (const key of keys) {
      const dir = downloadDir(key);
      const files = local.list(dir).filter((f) => f !== 'index.json' && DOWNLOAD_FILE_RE.test(f));
      if (files.length === 0) continue;
      const doc = await this.manifest(key, true);
      if (!doc) continue;
      const listed = new Set(Object.values(doc.value.chapters).map((e) => e.file));
      let adopted = 0;
      for (const file of files) {
        if (listed.has(file)) continue;
        let text: string | null = null;
        let f: Partial<DownloadFile> | null = null;
        try {
          text = await local.readText(`${dir}/${file}`);
          if (text) f = JSON.parse(text) as Partial<DownloadFile> | null;
        } catch {
          // unreadable or not JSON: left alone
        }
        if (!text || !f || typeof f.path !== 'string' || typeof f.html !== 'string') continue;
        if (`${hashKey(f.path)}.json` !== file || Object.hasOwn(doc.value.chapters, f.path)) continue;
        doc.value.chapters[f.path] = { file, title: typeof f.title === 'string' ? f.title : '', bytes: utf8Length(text), at: local.modifiedAt(`${dir}/${file}`) ?? this.ctx.platform.now() };
        adopted++;
      }
      if (adopted > 0) {
        doc.changed();
        await this.syncLibraryCount(key);
        total += adopted;
      }
    }
    if (total > 0) this.ctx.platform.log('info', `Recovered ${total} download(s) finished just before the app closed`);
    return total;
  }

  private async syncLibraryCount(key: string): Promise<void> {
    if (!this.library.has(key)) return;
    const n = await this.count(key);
    this.library.update(key, (e) => {
      e.downloadedCount = n;
    });
    this.library.notifyChanged();
  }

  /** Delete some or all downloads of a novel (and drop queued jobs for them). */
  async delete(novel: NovelKey, chapterPaths?: readonly string[]): Promise<void> {
    const key = novelKeyString(novel);
    const only = chapterPaths ? new Set(chapterPaths) : null;
    const before = this.queue.length;
    this.queue = this.queue.filter((j) => {
      const drop = j.key === key && (!only || only.has(j.chapterPath));
      if (drop) this.queued.delete(`${j.key}\n${j.chapterPath}`);
      return !drop;
    });
    // A full delete also stops an in-flight job for this novel from writing its result.
    if (!only || (this.queue.length !== before && !this.queue.some((j) => j.key === key))) this.runs.delete(key);
    this.pendingResume = this.pendingResume.filter((j) => j.key !== key || (only !== null && !only.has(j.chapterPath)));
    this.queueChanged();

    const doc = await this.manifest(key, false);
    if (doc) {
      if (!only) {
        doc.delete();
        this.docs.delete(key);
        this.ctx.platform.local.remove(downloadDir(key));
      } else {
        for (const p of only) {
          const entry = Object.hasOwn(doc.value.chapters, p) ? doc.value.chapters[p] : undefined;
          if (!entry) continue;
          this.ctx.platform.local.remove(`${downloadDir(key)}/${entry.file}`);
          delete doc.value.chapters[p];
        }
        doc.changed();
      }
    }
    await this.syncLibraryCount(key);
  }

  // ---------- downloads of novels no longer in the library ----------

  /** Folder names (hash of the novel key) the queue still works on: never treated as orphans. */
  private busyDirs(): Set<string> {
    const keys = new Set<string>([...this.runs.keys(), ...this.queue.map((j) => j.key), ...this.pendingResume.map((j) => j.key)]);
    if (this.current) keys.add(this.current.key);
    return new Set([...keys].map((k) => hashKey(k)));
  }

  /** Folders whose novel is in the library right now (library entries are the source of truth). */
  private libraryDirs(): Set<string> {
    return new Set(this.library.all().map((e) => hashKey(e.key)));
  }

  /** Download folders of novels not in the library (and not being downloaded), with their key and size. */
  private async orphans(): Promise<{ dir: string; key: string | null; bytes: number }[]> {
    await this.flushAll();
    const { local } = this.ctx.platform;
    const keep = this.libraryDirs();
    const busy = this.busyDirs();
    const out: { dir: string; key: string | null; bytes: number }[] = [];
    for (const dir of local.list(DOWNLOADS_DIR)) {
      if (keep.has(dir) || busy.has(dir)) continue;
      const path = `${DOWNLOADS_DIR}/${dir}`;
      let key: string | null = null;
      let bytes = 0;
      try {
        const text = await local.readText(`${path}/index.json`);
        const doc: unknown = text ? JSON.parse(text) : null;
        if (isRecord(doc) && typeof doc.key === 'string' && hashKey(doc.key) === dir && isRecord(doc.chapters)) {
          key = doc.key;
          for (const e of Object.values(doc.chapters)) if (isRecord(e) && typeof e.bytes === 'number' && Number.isFinite(e.bytes)) bytes += e.bytes;
          bytes += text ? utf8Length(text) : 0;
        } else {
          bytes = local.size(path);
        }
      } catch {
        bytes = local.size(path);
      }
      out.push({ dir, key, bytes });
    }
    return out;
  }

  /** storage.usage: downloads kept for novels no longer in the library (counted in bytes.downloads too). */
  async orphanUsage(): Promise<{ novels: number; bytes: number }> {
    const list = await this.orphans();
    return { novels: list.length, bytes: list.reduce((n, o) => n + o.bytes, 0) };
  }

  /**
   * downloads.deleteOrphans: delete the downloads of novels that are not in the library at this moment.
   * Membership is checked again right before each novel is deleted (an Undo of a removal that lands
   * meanwhile keeps its downloads), and each novel goes in one step: its manifest's pending writes are
   * cancelled and its folder is removed with nothing awaited in between. Progress, history and every
   * other state file are untouched.
   */
  async deleteOrphans(): Promise<{ novels: number; bytes: number }> {
    const { local } = this.ctx.platform;
    let novels = 0;
    let bytes = 0;
    for (const o of await this.orphans()) {
      o.key ??= [...this.docs.keys()].find((k) => hashKey(k) === o.dir) ?? null;
      const pending = o.key ? this.docs.get(o.key) : undefined;
      const doc = pending ? await pending.catch(() => null) : null;
      // Re-check now (synchronously from here on): the library or the queue may have changed meanwhile.
      if (this.libraryDirs().has(o.dir) || this.busyDirs().has(o.dir)) continue;
      if (o.key) {
        doc?.delete();
        this.docs.delete(o.key);
      }
      try {
        local.remove(`${DOWNLOADS_DIR}/${o.dir}`);
      } catch (err) {
        this.ctx.platform.log('warn', `Couldn't delete downloads in ${o.dir}: ${errorMessage(err)}`);
        continue;
      }
      novels++;
      bytes += o.bytes;
    }
    if (novels > 0) this.ctx.platform.log('info', `Deleted downloads of ${novels} novel(s) no longer in the library (${Math.round(bytes / 1024)} KB)`);
    return { novels, bytes };
  }

  /** storage.clear('downloads'). */
  async clearAll(): Promise<void> {
    this.queue = [];
    this.pendingResume = [];
    this.queued.clear();
    this.runs.clear();
    this.queueChanged();
    for (const p of this.docs.values()) {
      const doc = await p.catch(() => null);
      doc?.delete();
    }
    this.docs.clear();
    this.ctx.platform.local.remove(DOWNLOADS_DIR);
    let changed = false;
    for (const e of this.library.all()) {
      if (e.downloadedCount !== 0) {
        this.library.update(e.key, (x) => {
          x.downloadedCount = 0;
        });
        changed = true;
      }
    }
    if (changed) this.library.notifyChanged();
  }

  async flushAll(): Promise<void> {
    for (const p of this.docs.values()) {
      const doc = await p.catch(() => null);
      await doc?.flush();
    }
    await this.queueDoc?.flush();
  }

  /** Bytes of all downloads, from the manifests' recorded sizes (exact, unlike FileManager.fileSize). */
  async totalBytes(): Promise<number> {
    await this.flushAll();
    const { local } = this.ctx.platform;
    let total = 0;
    for (const dir of local.list(DOWNLOADS_DIR)) {
      try {
        const text = await local.readText(`${DOWNLOADS_DIR}/${dir}/index.json`);
        const doc: unknown = text ? JSON.parse(text) : null;
        if (isRecord(doc) && isRecord(doc.chapters)) {
          for (const e of Object.values(doc.chapters)) if (isRecord(e) && typeof e.bytes === 'number') total += e.bytes;
          total += text ? utf8Length(text) : 0;
        } else {
          total += local.size(`${DOWNLOADS_DIR}/${dir}`);
        }
      } catch {
        total += local.size(`${DOWNLOADS_DIR}/${dir}`);
      }
    }
    return total;
  }
}
