/**
 * The script-side app without any Scriptable specifics: services + handlers + boot payload +
 * flush/close. main.ts wires it to the Scriptable platform, the WebView host and the bridge server;
 * tests drive it directly with the Node platform.
 */
import type { AppSettings } from '../shared/contracts/domain.ts';
import type { BootPayload, MethodHandlers } from '../shared/contracts/protocol.ts';
import { errorMessage } from './lib/errors.ts';
import type { EmitFn, EventHub } from './services/events.ts';
import { createHandlers } from './services/handlers.ts';
import { type Services, type ServicesOptions, applySettingsEffects, createServices, flushServices } from './services/services.ts';
import { applySettingsPatch } from './services/settings.ts';
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
  /** Merge the widget's widget-updates.json (launch + heartbeat). Returns new chapters recorded. */
  mergeWidgetUpdates(): Promise<number>;
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
   * Skip the pre-boot merge of widget-updates.json (it deletes the file and writes updates later):
   * set while another instance may still own the files. Call mergeWidgetUpdates() once it is ours.
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
  const s = await createServices(opts);
  const { ctx } = s;
  let updateOnOpenDone = false;
  let pendingDeepLink = deepLinkFromQuery(opts.launchQuery);
  const mergeWidget = (): Promise<number> =>
    mergeWidgetUpdates(ctx, s).catch((err: unknown) => {
      ctx.platform.log('warn', `Widget update merge failed: ${errorMessage(err)}`);
      return 0;
    });
  let abandoned = false;
  // Before the boot payload: badges include what the widget found while the app was closed.
  if (!opts.deferWidgetMerge) await mergeWidget();
  // Launch work, shortly after boot and in the background (never on the boot path): resume queued
  // downloads, top up smart downloads, and write the daily backup.
  void s.downloads.init();
  const launchTasks: Promise<void> = ctx.platform.sleep(ctx.timing.bootUpdateDelayMs).then(async () => {
    const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      if (abandoned) return;
      try {
        await fn();
      } catch (err) {
        ctx.platform.log('warn', `Launch task "${name}" failed: ${errorMessage(err)}`);
      }
    };
    await step('resume downloads', () => s.downloads.resume());
    await step('smart downloads', () => s.autoDownload.run());
    await step('daily backup', () => dailyBackup(s));
  });

  const boot = (): BootPayload => {
    const settings = ctx.settings();
    if (settings.library.updateOnOpen && !updateOnOpenDone && s.library.size > 0) {
      updateOnOpenDone = true;
      void ctx.platform
        .sleep(ctx.timing.bootUpdateDelayMs)
        .then(() => s.novels.checkUpdates())
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
    mergeWidgetUpdates: mergeWidget,
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
      await flush();
      ctx.events.detach();
    },
    abandon() {
      abandoned = true;
      ctx.events.detach();
    },
  };
}
