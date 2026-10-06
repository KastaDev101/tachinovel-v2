/**
 * Smart downloads (settings.autoDownload): keep the next `ahead` unread, non-locked chapters downloaded
 * for every novel read in the last 14 days. Runs after a chapter change and on launch, on the background
 * lane (through the normal download queue), and stops adding once downloads reach AUTO_DOWNLOAD_MAX_BYTES.
 * Scriptable can't tell Wi-Fi from cellular, so there is no Wi-Fi-only option.
 * Read chapters are removed by the existing deleteDownloadsAfterRead rule.
 */
import type { ChapterMeta } from '../../shared/contracts/domain.ts';
import { novelKeyString, parseNovelKey } from '../../shared/contracts/domain.ts';
import { errorMessage } from '../lib/errors.ts';
import type { ChapterService } from './chapters.ts';
import { type Ctx, MB } from './context.ts';
import type { DownloadService } from './downloads.ts';
import type { HistoryService } from './history.ts';
import { chapterIndex } from './novel-store.ts';
import type { ProgressService } from './progress.ts';

export const AUTO_DOWNLOAD_RECENT_MS = 14 * 24 * 60 * 60 * 1000;
/** Smart downloads stop adding chapters once all downloads take this much space. */
export const AUTO_DOWNLOAD_MAX_BYTES = 200 * MB;

/** The next `ahead` unread, non-locked chapters after the last-read one (from the start if none). */
export function nextToKeep(chapters: readonly ChapterMeta[], lastChapterPath: string | undefined, read: ReadonlySet<string>, ahead: number): string[] {
  const out: string[] = [];
  const last = lastChapterPath ? chapterIndex(chapters, lastChapterPath) : -1;
  for (let i = last + 1; i < chapters.length && out.length < ahead; i++) {
    const c = chapters[i] as ChapterMeta;
    if (!c.locked && !read.has(c.path)) out.push(c.path);
  }
  return out;
}

export class AutoDownloadService {
  private readonly ctx: Ctx;
  private readonly history: HistoryService;
  private readonly progress: ProgressService;
  private readonly downloads: DownloadService;
  private readonly chapters: ChapterService;
  private running: Promise<number> | null = null;

  constructor(ctx: Ctx, deps: { history: HistoryService; progress: ProgressService; downloads: DownloadService; chapters: ChapterService }) {
    this.ctx = ctx;
    this.history = deps.history;
    this.progress = deps.progress;
    this.downloads = deps.downloads;
    this.chapters = deps.chapters;
  }

  /** Top up one novel (after a chapter change) or all recently read novels (launch). Returns chapters queued. */
  run(keys?: readonly string[]): Promise<number> {
    if (!this.ctx.settings().autoDownload.enabled) return Promise.resolve(0);
    const previous = this.running ?? Promise.resolve(0);
    const next = previous.then(() => this.topUp(keys)).catch((err: unknown) => {
      this.ctx.platform.log('warn', `Smart downloads failed: ${errorMessage(err)}`);
      return 0;
    });
    this.running = next.finally(() => {
      if (this.running === next) this.running = null;
    });
    return next;
  }

  private async topUp(keys?: readonly string[]): Promise<number> {
    const { autoDownload } = this.ctx.settings();
    if (!autoDownload.enabled) return 0;
    const used = await this.downloads.totalBytes();
    if (used >= AUTO_DOWNLOAD_MAX_BYTES) {
      this.ctx.platform.log('info', `Smart downloads paused: downloads use ${Math.round(used / MB)} MB (cap ${AUTO_DOWNLOAD_MAX_BYTES / MB} MB)`);
      return 0;
    }
    const cutoff = this.ctx.platform.now() - AUTO_DOWNLOAD_RECENT_MS;
    const targets = keys ?? this.history.all().filter((h) => h.readAt >= cutoff).map((h) => novelKeyString(h));
    let queued = 0;
    for (const key of targets) {
      try {
        const novel = parseNovelKey(key);
        const prog = await this.progress.get(key);
        const chapters = await this.chapters.chapterList(key, novel, 'background');
        const wanted = nextToKeep(chapters, prog.value.lastChapterPath, prog.read, autoDownload.ahead);
        const missing: string[] = [];
        for (const p of wanted) if (!(await this.downloads.isDownloaded(key, p))) missing.push(p);
        if (missing.length > 0) {
          this.downloads.enqueue(novel, missing);
          queued += missing.length;
        }
      } catch (err) {
        this.ctx.platform.log('info', `Smart downloads skipped ${key}: ${errorMessage(err)}`);
      }
    }
    return queued;
  }
}
