/**
 * The script-side app without any Scriptable specifics: services + handlers + boot payload +
 * flush/close. main.ts wires it to the Scriptable platform, the WebView host and the bridge server;
 * tests drive it directly with the Node platform.
 */
import type { AppSettings } from '../shared/contracts/domain.ts';
import type { BootPayload, MethodHandlers } from '../shared/contracts/protocol.ts';
import { errorMessage } from './lib/errors.ts';
import { inBackground } from './services/context.ts';
import type { EmitFn, EventHub } from './services/events.ts';
import { createHandlers } from './services/handlers.ts';
import { type Services, type ServicesOptions, applySettingsEffects, createServices, flushServices } from './services/services.ts';
import { applySettingsPatch } from './services/settings.ts';
import { findConflictCopies, sweepTempFiles } from './services/maintenance.ts';
import { mergeWidgetUpdates } from './services/widget-updates.ts';

export const RECENT_HISTORY = 10;

export interface App {
  readonly buildVersion: string;
  readonly services: Services;
  readonly handlers: MethodHandlers;
  readonly events: EventHub;
  /** Route events to the bridge (buffered until attached). */
  attachEvents(sink: EmitFn): void;
  boot(): BootPayload;
  setSettings(patch: unknown): AppSettings;
  /** Persist everything pending (debounced docs, LRU indexes, manifests, plugin storage). */
  flush(): Promise<void>;
  /** A deep link that arrived while running (second launch): pushed to the UI as `app.deepLink`. */
  deliverDeepLink(link: DeepLink): boolean;
  /** Resolves when the launch work (download resume, smart downloads, daily backup) is done (tests). */
  readonly launched: Promise<void>;
  /**
   * Resolves when the post-boot step is done: the launch merge of widget-updates.json (unless deferred)
   * and the download-queue load. It starts `timing.postBootDelayMs` after the first boot() (or after
   * `timing.launchWithoutBootMs` when the UI never boots), so none of it delays the first paint.
   */
  readonly postBoot: Promise<void>;
  /** Merge the widget's widget-updates.json (launch + heartbeat; one at a time). Returns new chapters recorded. */
  mergeWidgetUpdates(): Promise<number>;
  /**
   * The files are ours now (a busy launch took the lock over): do the launch merge in the post-boot
   * step like a normal launch (at once if that step already ran).
   */
  enableLaunchMerge(): void;
  /** Boot diagnostics: when (platform.now()) each startup step finished (session log line). */
  readonly marks: Record<string, number>;
  close(): Promise<void>;
  /**
   * Give up without writing anything (another instance owns the files): launch work that hasn't started
   * is skipped and events stop. Nothing is flushed.
   */
  abandon(): void;
}

export interface DeepLink {
  pluginId: string;
  novelPath: string;
  chapterPath?: string;
}

export interface AppOptions extends ServicesOptions {
  /**
   * Launch query (args.queryParameters) of scriptable:///run/TachiNovel?plugin=...&novel=...[&chapter=...].
   * Becomes BootPayload.deepLink on the first boot when the plugin is installed.
   */
  launchQuery?: Record<string, string>;
  /**
   * Skip the launch merge of widget-updates.json (it deletes the file and writes updates later):
   * set while another instance may still own the files. Call enableLaunchMerge() once they are ours.
   */
  deferWidgetMerge?: boolean;
  /** Write buffered log lines to the device log now (app.logs reads the file). */
  flushLogs?: () => Promise<void>;
}

/** Validate a launch query into a deep link (the installed-source check happens at boot). */
export function deepLinkFromQuery(q: Record<string, string> | undefined): DeepLink | null {
  if (!q) return null;
  const pluginId = q.plugin?.trim();
  const novelPath = q.novel;
  if (!pluginId || pluginId.includes(':') || !novelPath || novelPath.length > 4096) return null;
  const link: DeepLink = { pluginId, novelPath };
  if (q.chapter && q.chapter.length <= 4096) link.chapterPath = q.chapter;
  return link;
}

export const DAILY_BACKUP_MS = 24 * 60 * 60 * 1000;
/** close() waits this long at most for a widget merge in progress. */
export const CLOSE_MERGE_WAIT_MS = 2_000;

/** settings.autoBackup: write a backup when the newest one is over a day old (keeps the newest 10). */
export async function dailyBackup(s: Services): Promise<boolean> {
  if (!s.ctx.settings().autoBackup) return false;
  if (s.library.size === 0 && s.history.list(1).length === 0) return false; // nothing worth backing up yet
  const newest = s.backup.list()[0];
  if (newest && s.ctx.platform.now() - newest.createdAt < DAILY_BACKUP_MS) return false;
  await s.backup.create();
  return true;
}

export async function createApp(opts: AppOptions): Promise<App> {
  const marks: Record<string, number> = {};
  const s = await createServices(opts);
  const { ctx } = s;
  marks.services = ctx.platform.now();
  let updateOnOpenDone = false;
  let pendingDeepLink = deepLinkFromQuery(opts.launchQuery);
  let abandoned = false;
  // One merge at a time (launch, heartbeat, close): each one hands the widget's file off atomically.
  let mergeChain: Promise<number> = Promise.resolve(0);
  const mergeWidget = (): Promise<number> => {
    const run = (): Promise<number> =>
      mergeWidgetUpdates(ctx, s).catch((err: unknown) => {
        ctx.platform.log('warn', `Widget update merge failed: ${errorMessage(err)}`);
        return 0;
      });
    mergeChain = mergeChain.then(run, run);
    return mergeChain;
  };
  // iCloud didn't deliver the state in time: tell the user (the event waits for the bridge) and retry.
  s.icloud.announce();
  if (s.icloud.degraded().length > 0) {
    inBackground(ctx, 'iCloud retry', s.icloud.retryLoop());
  }

  // Nothing below is on the boot path (icon tap → library visible): it starts once the first app.boot
  // reply is out and the UI had a moment to paint it (or, if the UI never asks, after a while anyway).
  let bootCalled: () => void = () => undefined;
  const firstBoot = new Promise<void>((resolve) => {
    bootCalled = resolve;
  });
  const afterBoot: Promise<void> = Promise.race([firstBoot.then(() => ctx.platform.sleep(ctx.timing.postBootDelayMs)), ctx.platform.sleep(ctx.timing.launchWithoutBootMs)]);
  // The launch merge of the widget's findings: badges update via library.changed right after the first
  // paint. Deferred (deferWidgetMerge) until the files are ours (enableLaunchMerge).
  let launchMergeWanted = opts.deferWidgetMerge !== true;
  let launchMergeStarted = false;
  let afterBootReached = false;
  const launchMerge = async (): Promise<void> => {
    if (!launchMergeWanted || launchMergeStarted || abandoned) return;
    launchMergeStarted = true;
    await mergeWidget();
    marks.widgetMerge = ctx.platform.now();
  };
  const postBoot: Promise<void> = afterBoot.then(async () => {
    afterBootReached = true;
    if (abandoned) return;
    await launchMerge();
    // The download queue (a synced file): loaded now, so the resume below finds it ready.
    void s.downloads.init().then(() => {
      marks.downloadQueue = ctx.platform.now();
    });
  });
  // Launch work, in the background after the post-boot step: housekeeping, resume queued downloads,
  // top up smart downloads, and write the daily backup.
  const launchTasks: Promise<void> = Promise.all([ctx.platform.sleep(ctx.timing.bootUpdateDelayMs), postBoot]).then(async () => {
    const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      if (abandoned) return;
      try {
        await fn();
      } catch (err) {
        ctx.platform.log('warn', `Launch task "${name}" failed: ${errorMessage(err)}`);
      }
    };
    if (!abandoned) marks.launchTasks = ctx.platform.now();
    // Leftovers of saves cut short when the app was last closed or killed.
    await step('housekeeping', async () => {
      sweepTempFiles(ctx);
      findConflictCopies(ctx);
      await s.downloads.adoptOrphans(s.library.all().map((e) => e.key));
    });
    await step('resume downloads', () => s.downloads.resume());
    await step('smart downloads', () => s.autoDownload.run());
    await step('daily backup', () => dailyBackup(s));
  });

  const boot = (): BootPayload => {
    const settings = ctx.settings();
    if (settings.library.updateOnOpen && !updateOnOpenDone && s.library.size > 0) {
      updateOnOpenDone = true;
      // After the launch merge (the check then sees the widget's findings as already recorded).
      void Promise.all([ctx.platform.sleep(ctx.timing.bootUpdateDelayMs), postBoot])
        .then(() => s.novels.checkUpdates(undefined, { launch: true }))
        .catch((err: unknown) => ctx.platform.log('warn', `Update on open failed: ${errorMessage(err)}`));
    }
    const payload: BootPayload = {
      buildVersion: opts.buildVersion,
      settings,
      library: s.library.wire(),
      categories: s.library.categories(),
      sources: s.sources.list(),
      recent: s.history.list(RECENT_HISTORY).map((h) => {
        const cover = s.covers.localRef(h.cover);
        return cover ? { ...h, cover } : h;
      }),
      symbols: s.symbols.bootMap(),
    };
    // A deep link is handed to the UI once, and only for installed sources.
    if (pendingDeepLink) {
      if (s.sources.get(pendingDeepLink.pluginId)) payload.deepLink = pendingDeepLink;
      else ctx.platform.log('warn', `Deep link ignored: source "${pendingDeepLink.pluginId}" is not installed`);
      pendingDeepLink = null;
    }
    bootCalled();
    return payload;
  };

  const setSettings = (patch: unknown): AppSettings => {
    const next = applySettingsPatch(ctx.settings(), patch);
    s.settingsDoc.value = next;
    s.settingsDoc.changed();
    applySettingsEffects(s);
    return next;
  };

  const flush = (): Promise<void> => flushServices(s);

  return {
    buildVersion: opts.buildVersion,
    services: s,
    handlers: createHandlers(s, { boot, setSettings, flush, ...(opts.flushLogs ? { flushLogs: opts.flushLogs } : {}) }),
    events: ctx.events,
    attachEvents: (sink) => ctx.events.attach(sink),
    boot,
    setSettings,
    flush,
    launched: launchTasks,
    postBoot,
    marks,
    mergeWidgetUpdates: mergeWidget,
    enableLaunchMerge() {
      launchMergeWanted = true;
      if (afterBootReached) void launchMerge();
    },
    deliverDeepLink(link) {
      if (!s.sources.get(link.pluginId)) {
        ctx.platform.log('warn', `Deep link ignored: source "${link.pluginId}" is not installed`);
        return false;
      }
      const payload: DeepLink = { pluginId: link.pluginId, novelPath: link.novelPath };
      if (link.chapterPath) payload.chapterPath = link.chapterPath;
      ctx.events.emit('app.deepLink', payload);
      return true;
    },
    close: async () => {
      if (!abandoned) {
        // Closed before the post-boot step: the widget's findings are still taken over (as at any launch).
        void launchMerge();
        // A merge in progress finishes first (its update and count writes go out together), but a
        // stuck iCloud read never holds the close for long.
        await Promise.race([mergeChain, ctx.platform.sleep(CLOSE_MERGE_WAIT_MS)]);
      }
      abandoned = true; // launch work that hasn't started yet stays undone
      await flush();
      ctx.events.detach();
      s.logLimiter.flush();
    },
    abandon() {
      abandoned = true;
      ctx.events.detach();
    },
  };
}
