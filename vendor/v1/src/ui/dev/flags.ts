/**
 * Dev/test switches (types only, so Node tests can import them). `window.__TACHI_DEV__` is set by the dev server (tools/dev-ui.ts) and by the e2e
 * tests (Playwright addInitScript) BEFORE the app script runs. On the phone it is never set, so the
 * real phone bridge is used.
 */
import type { SourceFailureReason } from '../../shared/contracts/domain.ts';

export interface DevFlags {
  /** Simulated bridge latency in ms (number or [min, max]). Default [80, 260]. */
  latency?: number | [number, number];
  /** 0..1 probability that a network-ish call fails with a retryable error. */
  failRate?: number;
  /** Network-ish calls fail with NETWORK errors. */
  offline?: boolean;
  /** Simulated safe-area insets (px) so layouts look like the phone in a desktop browser. */
  safeArea?: { top?: number; bottom?: number; left?: number; right?: number };
  /** Start with an empty library / history. */
  empty?: boolean;
  /** A fresh install: empty, and only the built-in source installed (the rest are in the catalog). */
  freshInstall?: boolean;
  /** Load testing: this many Updates / History entries and extra browsable sources (perf specs). */
  stress?: { updates?: number; history?: number; sources?: number };
  /** Seed for the fixture generator. */
  seed?: number;
  /** Time used by fixtures as "now" (epoch ms). Defaults to Date.now() at startup. */
  now?: number;
  /** Disable all UI transitions (screenshots). */
  noAnimations?: boolean;
  /** Scribble Hub chapters sit behind a browser check (CLOUDFLARE) until sources.solveChallenge. */
  cloudflareChapters?: boolean;
  /** Simulated BootPayload.deepLink (home-screen widget). */
  deepLink?: { pluginId: string; novelPath: string; chapterPath?: string };
}

export interface MockCall {
  method: string;
  args: unknown;
  at: number;
}

/** Handle exposed on window.__tachiMock for tests and the in-app Developer settings. */
export interface MockControls {
  setOffline(offline: boolean): void;
  setLatency(latency: number | [number, number]): void;
  setFailRate(rate: number): void;
  readonly flags: DevFlags;
  readonly calls: MockCall[];
  /** Resolve the next native action sheet / alert with this index instead of showing it. */
  queueSheetAnswer(index: number): void;
  /** Send an `app.error` event, like the script does for user-facing problems. */
  emitError(message: string): void;
  /** Make every network call to a source fail with this reason (null = working again). */
  failSource(pluginId: string, reason: SourceFailureReason | null): void;
  /** Make every call of one bridge method fail (e.g. a local read like `history.list`); null = working again. */
  failMethod(method: string, message: string | null): void;
}

declare global {
  interface Window {
    __TACHI_DEV__?: DevFlags;
    __tachiMock?: MockControls;
    /** Test hooks (dev builds only). */
    __tachiTest?: Record<string, unknown>;
  }
}
