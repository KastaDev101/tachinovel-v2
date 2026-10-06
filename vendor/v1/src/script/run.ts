/**
 * One run of TachiNovel, platform-independent so it can be tested (main.ts wires in Scriptable).
 *
 * Boot: run lock → (present the view, then load the state while the UI loads) → bridge server until
 * the view closes → flush. Launch work that the first paint doesn't need (widget merge, download queue,
 * housekeeping, backups) waits for the first app.boot reply (app.ts).
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
import { createLogLimiter } from './lib/log-limit.ts';
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

/**
 * The lock owner's view was refused: is another launch's view on screen? It announced itself (or took
 * the lock) before presenting; give it a moment in case the refusal raced the announcement.
 */
async function otherRunStarting(lock: RunLock, platform: RunPlatform): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    if (await lock.otherRunLive()) return true;
    await platform.sleep(200);
  }
  return false;
}

export function isPresentRefused(err: unknown): boolean {
  return err instanceof Error && err.name === 'WebViewPresentError';
}

export async function runTachiNovel(deps: RunDeps): Promise<RunOutcome> {
  const { platform, lock } = deps;
  const log = (level: LogLevel, message: string, data?: unknown): void => platform.log(level, message, data);
  let app: App | null = null;
  let outcome: RunOutcome = 'closed';
  const startedAt = platform.now();
  const busy = (await lock.acquire()) === 'busy';
  // Until this run owns the lock, its log lines stay local (two writers on one iCloud file → conflict copies).
  if (busy) {
    platform.setLogMirror?.(false);
    await lock.announce(); // the owner may now see our view first: it must yield, not fail
  }
  const t0 = platform.now();
  // Present first: the view appears (and its settle wait runs) while the state loads, instead of
  // after createApp's synchronous parsing.
  let hostP: Promise<RunHost>;
  try {
    hostP = deps.startHost(log);
  } catch (err) {
    hostP = Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  hostP.catch(() => undefined); // awaited below, after createApp has started
  const appP = deps.createApp({
    platform,
    buildVersion: deps.buildVersion,
    launchQuery: platform.launchQuery(),
    solveChallenge: (url) => platform.solveChallenge(url),
    deferWidgetMerge: busy,
    flushLogs: () => platform.flushLogs({ mirror: false }),
  });
  appP.catch(() => undefined); // handled below (awaited or raced); never an unhandled rejection meanwhile
  let stateReadyAt: number | undefined;
  void appP.then(
    () => {
      stateReadyAt = platform.now();
    },
    () => undefined,
  );
  try {
    const host = await hostP;
    const hostReadyAt = platform.now();
    // Close may be tapped while the state is still loading (e.g. iCloud is slow): then stop right here.
    const first: App | 'closed' = await Promise.race([appP, host.closed.then(() => 'closed' as const)]);
    if (first === 'closed') {
      log('info', `Closed while starting (${platform.now() - t0} ms after launch)`);
      return outcome;
    }
    app = first;
    if (busy) {
      await lock.takeOver();
      platform.setLogMirror?.(true);
      app.enableLaunchMerge(); // after the first boot reply, like a normal launch
    }
    log('info', `TachiNovel ${deps.buildVersion} up in ${platform.now() - t0} ms`);
    // Failed/slow call warnings are rate-limited like the services' (a broken screen can repeat one call).
    const bridgeLog = createLogLimiter(log, { now: () => platform.now() });
    const server = (deps.createServer ?? createBridgeServer)({
      transport: host.transport,
      handlers: app.handlers,
      closed: host.closed,
      sleep: (ms) => platform.sleep(ms),
      now: () => platform.now(),
      log: bridgeLog.log,
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
    bridgeLog.flush();
    // One line per session: what was used, how fast, what failed, and the boot timeline (ms from start).
    const rel = (at: number | undefined): number | null => (at === undefined ? null : at - t0);
    // lock: before t0. state: services loaded / app ready; host: view presented + UI loaded; after
    // bootServed: launch work moved off the boot path (app.marks).
    const boot: Record<string, number | null> = {
      lock: t0 - startedAt,
      present: rel(host.timeline.presentedAt),
      services: rel(running.marks.services),
      stateReady: rel(stateReadyAt),
      uiLoaded: rel(host.timeline.loadedAt),
      hostReady: rel(hostReadyAt),
      firstPoll: rel(server.timeline.firstPollAt),
      bootServed: rel(server.timeline.bootServedAt),
    };
    for (const [step, at] of Object.entries(running.marks)) if (!(step in boot)) boot[step] = rel(at);
    log('info', `session ${sessionLine({ ...server.summary(), boot, polls: server.stats.polls, pollFailures: server.stats.failures })}`);
  } catch (err) {
    const message = errorMessage(err);
    if (isPresentRefused(err) && (busy || (await otherRunStarting(lock, platform)))) {
      outcome = 'yielded';
      log('info', `Another TachiNovel view is still on screen; leaving it running (${message})`);
      if (busy) {
        // The other instance owns the files: the half-created app must not flush or start launch work.
        void appP.then(
          (a) => a.abandon(),
          () => undefined,
        );
      } else {
        // We held the lock, but a newer launch's view got the screen first: hand over cleanly. Save
        // what this run already changed (normally nothing) and free the lock for it.
        const created = await Promise.race([appP.catch(() => null), platform.sleep(APP_SETTLE_MS).then(() => null)]);
        if (created) await created.close();
        await lock.release();
      }
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
