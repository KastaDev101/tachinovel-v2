/** Shared service context and tunables. */
import type { AppSettings } from '../../shared/contracts/domain.ts';
import type { Platform } from '../../shared/contracts/platform.ts';
import { errorMessage } from '../lib/errors.ts';
import type { DocEnv } from '../storage/json-doc.ts';
import type { EventHub } from './events.ts';

/** Debounce intervals and limits (ms unless noted). Overridable for tests. */
export interface Timing {
  /** Per-novel progress files. Also flushed on chapter change and close. */
  progressWriteMs: number;
  libraryWriteMs: number;
  historyWriteMs: number;
  updatesWriteMs: number;
  settingsWriteMs: number;
  /** Source registry, LRU indexes, plugin KV, download manifests, symbol cache. */
  indexWriteMs: number;
  /** Coalesces library.changed events. */
  libraryEventMs: number;
  /** Browsed (non-library) novels kept in memory this long. */
  novelMemoryTtlMs: number;
  /** Repo indexes are refetched after this long. */
  repoTtlMs: number;
  /** Delay before the update-on-open check starts after boot. */
  bootUpdateDelayMs: number;
}

export const DEFAULT_TIMING: Timing = {
  progressWriteMs: 2_000,
  libraryWriteMs: 1_000,
  historyWriteMs: 3_000,
  updatesWriteMs: 2_000,
  settingsWriteMs: 300,
  indexWriteMs: 2_000,
  libraryEventMs: 150,
  novelMemoryTtlMs: 10 * 60_000,
  repoTtlMs: 30 * 60_000,
  bootUpdateDelayMs: 1_500,
};

export interface Ctx {
  platform: Platform;
  env: DocEnv;
  timing: Timing;
  events: EventHub;
  settings(): AppSettings;
}

export const MB = 1024 * 1024;

/**
 * Background work nobody awaits: a failure is logged (warn) instead of becoming an unhandled rejection
 * (JavaScriptCore drops those silently, so the problem would be invisible in the logs).
 */
export function inBackground(ctx: { platform: Pick<Platform, 'log'> }, what: string, work: Promise<unknown> | undefined): void {
  if (!work) return;
  void work.then(undefined, (err: unknown) => {
    try {
      ctx.platform.log('warn', `${what} failed: ${errorMessage(err)}`);
    } catch {
      // Logging must never throw out of a background failure.
    }
  });
}
