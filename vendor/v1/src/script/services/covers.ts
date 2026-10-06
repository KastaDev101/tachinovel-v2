/**
 * Cover cache: local `covers/<hash(url)>.<ext>`, byte-capped LRU (settings.coverCapMB), for library
 * covers and for every cover the UI loads through `covers.fetch` (browse results included — sources
 * like Stonescape block cross-origin <img> loads). Large covers are downscaled natively to 480 px JPEGs.
 * The UI references cached covers by relative path ("covers/<file>", relative to local index.html);
 * uncached or evicted library covers fall back to the remote URL.
 */
import type { HttpClient } from '../../shared/contracts/platform.ts';
import { Inflight } from '../lib/async.ts';
import { AppError, errorCode, errorMessage, notFound } from '../lib/errors.ts';
import { hashKey } from '../lib/hash.ts';
import { extensionOf } from '../lib/url.ts';
import { isHttpUrl } from '../lib/validate.ts';
import { LruStore } from '../storage/lru.ts';
import { type Ctx, MB } from './context.ts';

/** Largest cover we download (sources serve multi-MB originals, e.g. an 8.5 MB WebP). */
export const MAX_COVER_DOWNLOAD_BYTES = 16 * MB;
/** Largest cover we store as-is (when it can't be or needn't be downscaled). */
export const MAX_COVER_BYTES = 2 * MB;
/** Covers are downscaled to this width (JPEG): plenty for a 2:3 grid tile on a 3× screen. */
export const COVER_MAX_WIDTH = 480;
/** How long a cover that answered NOT_FOUND is not asked for again. */
export const FAILED_COVER_TTL_MS = 10 * 60 * 1000;
/** Bound on remembered missing covers (long sessions of browsing). */
export const MAX_FAILED_COVERS = 500;
const TYPE_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
const URL_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);

export const COVERS_DIR = 'covers';

export class CoverCache {
  private readonly ctx: Ctx;
  private readonly net: HttpClient;
  readonly lru: LruStore;
  private readonly byHash = new Map<string, string>();
  private readonly inflight = new Inflight<string>();
  /** URLs that answered NOT_FOUND (404, not an image, too big): not retried for a while this session. */
  private readonly failed = new Map<string, { at: number; message: string }>();

  constructor(ctx: Ctx, net: HttpClient) {
    this.ctx = ctx;
    this.net = net;
    this.lru = new LruStore({
      store: ctx.platform.local,
      dir: COVERS_DIR,
      capBytes: () => ctx.settings().coverCapMB * MB,
      env: ctx.env,
      indexDelayMs: ctx.timing.indexWriteMs,
      onRemove: (file) => {
        const h = file.slice(0, file.indexOf('.'));
        if (this.byHash.get(h) === file) this.byHash.delete(h);
      },
    });
  }

  async init(): Promise<void> {
    await this.lru.init();
    for (const file of this.lru.files()) {
      const dot = file.indexOf('.');
      if (dot > 0) this.byHash.set(file.slice(0, dot), file);
    }
  }

  /** "covers/<file>" if cached, else undefined. */
  localRef(url: string | undefined): string | undefined {
    if (!url || !isHttpUrl(url)) return undefined;
    const file = this.byHash.get(hashKey(url));
    return file ? `${COVERS_DIR}/${file}` : undefined;
  }

  /** Cover for display: cached relative path, else the original URL. */
  resolve(url: string | undefined): string | undefined {
    return this.localRef(url) ?? url;
  }

  /** Download and cache a cover in the background (deduped). Resolves to the relative path, or null on failure. */
  ensure(url: string | undefined, headers: Record<string, string> = {}): Promise<string | null> {
    if (!url || !isHttpUrl(url)) return Promise.resolve(null);
    return this.fetch(url, headers).catch((err: unknown) => {
      this.ctx.platform.log('warn', `Cover download failed for ${url}: ${errorMessage(err)}`);
      return null;
    });
  }

  /**
   * covers.fetch: the cover as a file next to the UI ("covers/<file>"), fetched by the script (no
   * CORS/CORP in the way) with the plugin's image headers. Cache hits return without network;
   * concurrent requests for one URL share a download. Covers wider than 480 px are downscaled natively to a
   * JPEG; non-image responses, downloads over 16 MB, and undecodable/unscaled files over 2 MB → NOT_FOUND.
   */
  fetch(url: string, headers: Record<string, string>): Promise<string> {
    const existing = this.localRef(url);
    if (existing) {
      this.lru.touch(existing.slice(COVERS_DIR.length + 1));
      return Promise.resolve(existing);
    }
    // A broken cover in a scrolling grid would otherwise be requested on every redraw.
    const miss = this.failed.get(url);
    if (miss && this.ctx.platform.now() - miss.at < FAILED_COVER_TTL_MS) return Promise.reject(notFound(miss.message));
    return this.inflight.run(url, () =>
      this.download(url, headers).catch((err: unknown) => {
        if (errorCode(err) === 'NOT_FOUND') this.rememberFailure(url, errorMessage(err));
        throw err;
      }),
    );
  }

  private rememberFailure(url: string, message: string): void {
    const now = this.ctx.platform.now();
    if (this.failed.size >= MAX_FAILED_COVERS) {
      for (const [u, f] of this.failed) if (now - f.at >= FAILED_COVER_TTL_MS) this.failed.delete(u);
      // Still full: drop the oldest (Map keeps insertion order).
      while (this.failed.size >= MAX_FAILED_COVERS) {
        const oldest = this.failed.keys().next().value;
        if (oldest === undefined) break;
        this.failed.delete(oldest);
      }
    }
    this.failed.delete(url);
    this.failed.set(url, { at: now, message });
  }

  /** Remembered missing covers (diagnostics/tests). */
  get failedCount(): number {
    return this.failed.size;
  }

  remove(url: string | undefined): void {
    if (!url) return;
    const file = this.byHash.get(hashKey(url));
    if (file) this.lru.remove(file);
  }

  clear(): void {
    this.lru.clear();
    this.byHash.clear();
  }

  get bytes(): number {
    return this.lru.bytes;
  }

  flush(): Promise<void> {
    return this.lru.flush();
  }

  private async download(url: string, extraHeaders: Record<string, string>): Promise<string> {
    await this.lru.init();
    const headers: Record<string, string> = { Accept: 'image/webp,image/avif,image/*;q=0.8', ...extraHeaders };
    const res = await this.net.requestBytes({ url, headers, timeoutMs: 20_000 });
    if (res.status !== 200 || !res.base64) throw notFound(`Cover unavailable (HTTP ${res.status})`);
    const type = (res.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const urlExt = extensionOf(url);
    if (type ? !type.startsWith('image/') : !URL_EXT.has(urlExt)) throw notFound(`Cover is not an image (${type || 'no content-type'})`);
    if (res.base64.length * 0.75 > MAX_COVER_DOWNLOAD_BYTES) throw notFound('Cover is larger than 16 MB');
    let base64 = res.base64;
    let ext = TYPE_EXT[type] ?? (URL_EXT.has(urlExt) ? (urlExt === 'jpeg' ? 'jpg' : urlExt) : 'jpg');
    const resized = this.ctx.platform.native.resizeImage(base64, COVER_MAX_WIDTH);
    if (resized !== null && resized !== base64) {
      base64 = resized;
      ext = 'jpg';
    } else if (base64.length * 0.75 > MAX_COVER_BYTES) {
      throw notFound(resized === null ? 'Cover could not be decoded and is larger than 2 MB' : 'Cover is larger than 2 MB');
    }
    const h = hashKey(url);
    const file = `${h}.${ext}`;
    const old = this.byHash.get(h);
    if (old && old !== file) this.lru.remove(old);
    await this.lru.writeBase64(file, base64);
    if (!this.lru.has(file)) throw new AppError('STORAGE', 'Cover cache is disabled (coverCapMB = 0)', false);
    this.byHash.set(h, file);
    return `${COVERS_DIR}/${file}`;
  }
}
