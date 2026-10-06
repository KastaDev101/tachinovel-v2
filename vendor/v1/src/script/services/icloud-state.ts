/**
 * The app's state when iCloud can't deliver its files at launch (offline, iCloud stuck: downloads are
 * bounded, see platform/scriptable.ts). The boot documents (settings, library, history, sources) then
 * start from their device copies (JsonDoc mirror) or defaults, and none of them is written to iCloud
 * until iCloud has been read again. The user is told through the existing `app.error` event; iCloud is
 * retried in the background.
 */
import type { JsonDoc, Versioned } from '../storage/json-doc.ts';
import type { Ctx } from './context.ts';

export const ICLOUD_RETRY_MS = 15_000;
export const ICLOUD_RETRIES = 8;

export class ICloudState {
  private readonly ctx: Ctx;
  private readonly docs: readonly JsonDoc<Versioned>[];
  private reopenNeeded = false;

  constructor(ctx: Ctx, docs: readonly JsonDoc<Versioned>[]) {
    this.ctx = ctx;
    this.docs = docs;
  }

  /** Paths of documents not backed by iCloud this session. */
  degraded(): string[] {
    return this.docs.filter((d) => d.degraded !== null).map((d) => d.path);
  }

  /** What to tell the user (null when all is well). */
  notice(): string | null {
    const docs = this.docs.filter((d) => d.degraded !== null);
    if (docs.length === 0) return null;
    if (docs.some((d) => d.degraded === 'defaults')) {
      return "iCloud isn't ready, so your library couldn't load. Changes you make now won't be saved — close and reopen TachiNovel in a minute.";
    }
    return "iCloud isn't ready, so TachiNovel is using the copy saved on this iPhone. Changes are kept and saved to iCloud once it's back.";
  }

  /** Emit the notice (if any) through the bridge's error event. */
  announce(): void {
    const message = this.notice();
    if (message) this.ctx.events.emit('app.error', { message });
  }

  /**
   * Try iCloud again a few times in the background; true once every document is backed by iCloud again.
   * Documents that started on defaults are replaced by their iCloud content when it arrives; the user is
   * then told the library is loaded (settings shown in the UI catch up at the next launch).
   */
  async retryLoop(retries = ICLOUD_RETRIES, intervalMs = ICLOUD_RETRY_MS): Promise<boolean> {
    let reloaded = false;
    for (let i = 0; i < retries && this.degraded().length > 0 && !this.reopenNeeded; i++) {
      await this.ctx.platform.sleep(intervalMs);
      for (const d of this.docs) {
        if (d.degraded === null) continue;
        const r = await d.retrySynced();
        if (r === 'reopen') this.reopenNeeded = true;
        if (r === 'reloaded') reloaded = true;
      }
    }
    if (this.reopenNeeded) {
      this.ctx.events.emit('app.error', { message: 'iCloud is back. Close TachiNovel and open it again to load your latest library.' });
      return false;
    }
    const ok = this.degraded().length === 0;
    if (ok && this.docs.length > 0) this.ctx.platform.log('info', 'iCloud state readable again');
    if (ok && reloaded) this.ctx.events.emit('app.error', { message: 'iCloud is back — your library is loaded.' });
    return ok;
  }
}
