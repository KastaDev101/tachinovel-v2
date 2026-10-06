/**
 * images.fetch: in-chapter images (illustrations) the UI couldn't load directly (CORP, hotlink checks).
 * Like covers.fetch: fetched by the script with the plugin's image headers + Referer, http(s) only,
 * concurrent requests for one URL share a download, NOT_FOUND answers are remembered for a while.
 * Stored in local `cache/img-<hash(url)>.<ext>`, inside the read-ahead LRU (settings.cacheCapMB), not
 * in covers/. Images wider than 1320 px are downscaled natively to a JPEG (a 3× phone screen is ~1320 px
 * wide); smaller ones are kept as they are. Non-images and downloads over 16 MB → NOT_FOUND.
 * Images may use at most IMAGE_CACHE_SHARE of the cache's bytes (older images go first), so
 * illustrations never push the read-ahead chapters out; a single image bigger than that → STORAGE.
 * The UI loads them by the returned path, relative to its own file ("cache/<file>").
 */
import type { HttpClient } from '../../shared/contracts/platform.ts';
import { Inflight } from '../lib/async.ts';
import { AppError, errorCode, errorMessage, notFound } from '../lib/errors.ts';
import { hashKey } from '../lib/hash.ts';
import type { LruStore } from '../storage/lru.ts';
import { CACHE_DIR } from './chapters.ts';
import { type Ctx, MB } from './context.ts';
import { MAX_COVER_DOWNLOAD_BYTES, downloadImage } from './covers.ts';

export const IMAGE_MAX_WIDTH = 1320;
export const MAX_IMAGE_DOWNLOAD_BYTES = MAX_COVER_DOWNLOAD_BYTES;
export const FAILED_IMAGE_TTL_MS = 10 * 60 * 1000;
const MAX_FAILED_IMAGES = 300;
const PREFIX = 'img-';
/** Share of the chapter cache (settings.cacheCapMB) images may take; the rest stays for chapters. */
export const IMAGE_CACHE_SHARE = 0.5;

function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export class ImageCache {
  private readonly ctx: Ctx;
  private readonly net: HttpClient;
  private readonly lru: LruStore;
  /** hash → file, rebuilt from the LRU on first use (entries are re-checked: the LRU evicts on its own). */
  private byHash: Map<string, string> | null = null;
  private readonly inflight = new Inflight<string>();
  private readonly failed = new Map<string, { at: number; message: string }>();

  constructor(ctx: Ctx, net: HttpClient, lru: LruStore) {
    this.ctx = ctx;
    this.net = net;
    this.lru = lru;
  }

  private async index(): Promise<Map<string, string>> {
    if (!this.byHash) {
      await this.lru.init();
      const m = new Map<string, string>();
      for (const file of this.lru.files()) {
        if (!file.startsWith(PREFIX)) continue;
        const dot = file.indexOf('.');
        if (dot > PREFIX.length) m.set(file.slice(PREFIX.length, dot), file);
      }
      this.byHash = m;
    }
    return this.byHash;
  }

  async fetch(url: string, headers: Record<string, string>): Promise<string> {
    const byHash = await this.index();
    const h = hashKey(url);
    const cached = byHash.get(h);
    if (cached) {
      if (this.lru.has(cached)) {
        this.lru.touch(cached);
        return `${CACHE_DIR}/${cached}`;
      }
      byHash.delete(h); // evicted
    }
    const miss = this.failed.get(url);
    if (miss && this.ctx.platform.now() - miss.at < FAILED_IMAGE_TTL_MS) throw notFound(miss.message);
    return this.inflight.run(url, () =>
      this.download(url, h, headers).catch((err: unknown) => {
        if (errorCode(err) === 'NOT_FOUND') this.rememberFailure(url, errorMessage(err));
        throw err;
      }),
    );
  }

  private rememberFailure(url: string, message: string): void {
    while (this.failed.size >= MAX_FAILED_IMAGES) {
      const oldest = this.failed.keys().next().value;
      if (oldest === undefined) break;
      this.failed.delete(oldest);
    }
    this.failed.delete(url);
    this.failed.set(url, { at: this.ctx.platform.now(), message });
  }

  private async download(url: string, h: string, extraHeaders: Record<string, string>): Promise<string> {
    let { base64, ext } = await downloadImage(this.net, url, extraHeaders, { timeoutMs: 30_000, what: 'Image', notImageMessage: 'Not an image' });
    // Only images wider than the screen are re-encoded; null (not decodable natively) keeps the original.
    const resized = this.ctx.platform.native.resizeImage(base64, IMAGE_MAX_WIDTH);
    if (resized !== null && resized !== base64) {
      base64 = resized;
      ext = 'jpg';
    }
    const file = `${PREFIX}${h}.${ext}`;
    const share = this.share();
    if (decodedBytes(base64) > share) throw new AppError('STORAGE', 'This image is too big for the chapter cache. Raise the cache size in Settings → Storage.', false);
    const byHash = await this.index();
    const old = byHash.get(h);
    if (old && old !== file) this.lru.remove(old);
    await this.lru.writeBase64(file, base64);
    if (!this.lru.has(file)) throw new AppError('STORAGE', 'This image is too big for the chapter cache. Raise the cache size in Settings → Storage.', false);
    byHash.set(h, file);
    this.keepWithinShare(file, share);
    return `${CACHE_DIR}/${file}`;
  }

  /** Bytes images may use (IMAGE_CACHE_SHARE of the chapter cache cap). */
  private share(): number {
    return Math.max(0, this.ctx.settings().cacheCapMB * MB * IMAGE_CACHE_SHARE);
  }

  /** Drop the least recently used images (never `keep`) until images fit in their share. */
  private keepWithinShare(keep: string, share: number): void {
    const images = this.lru.files().filter((f) => f.startsWith(PREFIX)); // least recently used first
    let total = images.reduce((sum, f) => sum + (this.lru.sizeOf(f) ?? 0), 0);
    for (const f of images) {
      if (total <= share) break;
      if (f === keep) continue;
      total -= this.lru.sizeOf(f) ?? 0;
      this.lru.remove(f);
      const dot = f.indexOf('.');
      if (dot > PREFIX.length) this.byHash?.delete(f.slice(PREFIX.length, dot));
    }
  }
}
