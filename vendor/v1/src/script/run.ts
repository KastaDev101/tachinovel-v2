/**
 * One run of TachiNovel, platform-independent so it can be tested (main.ts wires in Scriptable).
 *
 * Boot: run lock → (state + UI in parallel) → bridge server until the view closes → flush.
 *
 * Second launch while another run holds a fresh lock ("busy"): re-running from the home-screen icon
 * usually means Scriptable already tore the old run down, so the newest launch wins, but only once
 * its own view is actually on screen. If present() is refused (WebViewPresentError: the old view is
 * still presented), this run yields quietly: no alert, the lock stays the old instance's, and nothing
 * is written (the half-created app is abandoned unflushed, the widget merge was deferred, and the
 * synced log mirror stays off).
 */
import type { LogLevel, Platform } from '../shared/contracts/platform.ts';
import type { App, AppOptions } from './app.ts';
import { type BridgeServer, type BridgeServerOptions, type BridgeTransport, createBridgeServer } from './bridge/server.ts';
import { sessionLine } from './bridge/session.ts';
import { errorMessage } from './lib/errors.ts';
import { type RunLock, takePendingLink } from './services/run-lock.ts';

export interface RunPlatform extends Platform {
  /** Buffered lines → device log; `mirror: false` skips the iCloud mirror refresh (default true). */
  flushLogs(opts?: { mirror?: boolean }): Promise<void>;
  complete(): void;
  launchQuery(): Record<string, string>;
  solveChallenge(url: string): Promise<boolean>;
  /** Mirror the log to synced storage (off while another instance may own the files). */
  setLogMirror?(on: boolean): void;
}

/** What run.ts needs from the WebView host (platform/webview-host.ts's WebViewHost fits). */
export interface RunHost {
  transport: BridgeTransport;
  /** Resolves when the user dismisses the view. */
  closed: Promise<unknown>;
  timeline: { presentedAt: number; loadedAt: number };
}

export interface RunDeps {
  platform: RunPlatform;
  lock: RunLock;
  buildVersion: string;
  createApp(opts: AppOptions): Promise<App>;
  /** Present the WebView and load the UI (rejects with a WebViewPresentError when present() is refused). */
  startHost(log: (level: LogLevel, message: string, data?: unknown) => void): Promise<RunHost>;
  createServer?(opts: BridgeServerOptions): BridgeServer;
}

/** How the run ended: the view was closed, it yielded to a running instance, or a fatal error (alerted). */
export type RunOutcome = 'closed' | 'yielded' | 'fatal';

const APP_SETTLE_MS = 3_000;

export function isPresentRefused(err: unknown): boolean {
  return err instanceof Error && err.name === 'WebViewPresentError';
}

export async function runTachiNovel(deps: RunDeps): Promise<RunOutcome> {
  const { platform, lock } = deps;
  const log = (level: LogLevel, message: string, data?: unknown): void => platform.log(level, message, data);
  let app: App | null = null;
  let outcome: RunOutcome = 'closed';
  const busy = (await lock.acquire()) === 'busy';
  // Until this run owns the lock, its log lines stay local (two writers on one iCloud file → conflict copies).
  if (busy) platform.setLogMirror?.(false);
  const t0 = platform.now();
  const appP = deps.createApp({
    platform,
    buildVersion: deps.buildVersion,
    launchQuery: platform.launchQuery(),
    solveChallenge: (url) => platform.solveChallenge(url),
    deferWidgetMerge: busy,
    flushLogs: () => platform.flushLogs({ mirror: false }),
  });
  try {
    const [created, host] = await Promise.all([appP, deps.startHost(log)]);
    app = created;
    if (busy) {
      await lock.takeOver();
      platform.setLogMirror?.(true);
      await app.mergeWidgetUpdates();
    }
    log('info', `TachiNovel ${deps.buildVersion} up in ${platform.now() - t0} ms`);
    const server = (deps.createServer ?? createBridgeServer)({
      transport: host.transport,
      handlers: app.handlers,
      closed: host.closed,
      sleep: (ms) => platform.sleep(ms),
      now: () => platform.now(),
      log,
    });
    app.attachEvents((event, payload) => server.emit(event, payload));
    const running = app;
    lock.startHeartbeat(
      () => server.stop(),
      async () => {
        const link = await takePendingLink(platform);
        if (link) running.deliverDeepLink(link);
        await running.mergeWidgetUpdates();
      },
    );
    await server.run();
    // One line per session: what was used, how fast, what failed, and the boot timeline (ms from start).
    const rel = (at: number | undefined): number | null => (at === undefined ? null : at - t0);
    const boot = {
      present: rel(host.timeline.presentedAt),
      uiLoaded: rel(host.timeline.loadedAt),
      firstPoll: rel(server.timeline.firstPollAt),
      bootServed: rel(server.timeline.bootServedAt),
    };
    log('info', `session ${sessionLine({ ...server.summary(), boot, polls: server.stats.polls, pollFailures: server.stats.failures })}`);
  } catch (err) {
    const message = errorMessage(err);
    if (busy && isPresentRefused(err)) {
      outcome = 'yielded';
      log('info', `Another TachiNovel view is still on screen; leaving it running (${message})`);
      // The other instance owns the files: the half-created app must not flush or start launch work.
      void appP.then(
        (a) => a.abandon(),
        () => undefined,
      );
    } else {
      outcome = 'fatal';
      log('error', `Fatal: ${message}`, err instanceof Error ? err.stack : undefined);
      await platform.flushLogs();
      try {
        await platform.native.alert({ title: 'TachiNovel stopped', message, actions: [{ title: 'OK' }] });
      } catch {
        // nothing else we can do
      }
    }
  } finally {
    if (outcome !== 'yielded') {
      // After a fatal error the app may exist without having been handed over: still flush it (it may
      // have merged the widget's file), but never wait long for one that is stuck.
      app ??= await Promise.race([appP.catch(() => null), platform.sleep(APP_SETTLE_MS).then(() => null)]);
      if (app) await app.close();
      await lock.release();
    }
    await platform.flushLogs();
    platform.complete();
  }
  return outcome;
}
