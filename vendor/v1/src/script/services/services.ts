/**
 * Composition root for the script-side services (pure TS over Platform; runs in Node tests).
 * Boot loads only small state files (settings, library, history, source registry, cover index,
 * symbol cache) — no network, no plugin host.
 */
import type { AppSettings } from '../../shared/contracts/domain.ts';
import { novelKeyString } from '../../shared/contracts/domain.ts';
import type { Platform } from '../../shared/contracts/platform.ts';
import type { CreatePluginHost, SourceAdapter } from '../../shared/contracts/plugin-host.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import { type DocEnv, JsonDoc } from '../storage/json-doc.ts';
import { AutoDownloadService } from './auto-download.ts';
import { BackupService } from './backup.ts';
import { BrowseService } from './browse.ts';
import { ChapterService } from './chapters.ts';
import { type Ctx, DEFAULT_TIMING, type Timing, inBackground } from './context.ts';
import { CoverCache } from './covers.ts';
import { DownloadService } from './downloads.ts';
import { EventHub } from './events.ts';
import { HistoryService } from './history.ts';
import { LibraryService } from './library.ts';
import { type Net, type NetOptions, createNet } from './net.ts';
import { NovelStore } from './novel-store.ts';
import { NovelService } from './novels.ts';
import { PluginKvStore } from './plugin-kv.ts';
import { ProgressService } from './progress.ts';
import { ReadingService } from './reading.ts';
import { SETTINGS_SPEC } from './settings.ts';
import { type LoadPluginHost, SourceService } from './sources.ts';
import { MigrateService } from './migrate.ts';
import { StatsService } from './stats.ts';
import { ICloudState } from './icloud-state.ts';
import { ImageCache } from './images.ts';
import { StorageAlarm } from './storage-alarm.ts';
import { LibraryExport } from './library-export.ts';
import { type LogLimiter, createLogLimiter } from '../lib/log-limit.ts';
import { NarrationService } from './narration.ts';
import { SymbolService } from './symbols.ts';
import { UpdatesService } from './updates.ts';

export interface ServicesOptions {
  platform: Platform;
  buildVersion: string;
  /** Defaults to importing the lazy `plugin-host` bundle via platform.importLazy. */
  loadPluginHost?: LoadPluginHost;
  timing?: Partial<Timing>;
  net?: Partial<NetOptions>;
  /** Keep the last N emitted events in `events.recent` (tests/diagnostics). Default 0. */
  keepRecentEvents?: number;
  /**
   * Show a site in a visible WebView until the user closes it; true if the page was no longer a
   * Cloudflare challenge when closed (sources.solveChallenge). Absent where there is no such UI.
   */
  solveChallenge?: (url: string) => Promise<boolean>;
}

export interface Services {
  ctx: Ctx;
  settingsDoc: JsonDoc<AppSettings>;
  net: Net;
  covers: CoverCache;
  library: LibraryService;
  history: HistoryService;
  updates: UpdatesService;
  progress: ProgressService;
  store: NovelStore;
  sources: SourceService;
  kv: PluginKvStore;
  downloads: DownloadService;
  chapters: ChapterService;
  novels: NovelService;
  reading: ReadingService;
  browse: BrowseService;
  symbols: SymbolService;
  backup: BackupService;
  autoDownload: AutoDownloadService;
  stats: StatsService;
  migrate: MigrateService;
  narration: NarrationService;
  images: ImageCache;
  /** Repeated info/warn lines are rate-limited; flush() writes what was suppressed (session end). */
  logLimiter: LogLimiter;
  /** Boot documents not backed by iCloud this session (iCloud didn't deliver them in time). */
  icloud: ICloudState;
  libraryExport: LibraryExport;
  /** Tells the user (once per session) when saving fails, e.g. the iPhone is out of storage. */
  storageAlarm: StorageAlarm;
}

/** Persist every pending debounced write (docs, progress, LRU indexes, manifests, plugin storage). */
export async function flushServices(s: Services): Promise<void> {
  const tasks: [string, () => Promise<void>][] = [
    ['settings', () => s.settingsDoc.flush()],
    ['library', () => s.library.flush()],
    ['history', () => s.history.flush()],
    ['updates', () => s.updates.flush()],
    ['progress', () => s.progress.flushAll()],
    ['sources', () => s.sources.flush()],
    ['plugin storage', () => s.kv.flushAll()],
    ['covers', () => s.covers.flush()],
    ['cache', () => s.chapters.flush()],
    ['downloads', () => s.downloads.flushAll()],
    ['symbols', () => s.symbols.flush()],
    ['stats', () => s.stats.flush()],
    ['narration', () => s.narration.flush()],
    ['update checks', () => s.novels.flush()],
  ];
  const results = await Promise.allSettled(tasks.map(([, fn]) => fn()));
  results.forEach((r, i) => {
    if (r.status === 'rejected') s.ctx.platform.log('error', `Flush failed (${tasks[i]?.[0] ?? '?'}): ${errorMessage(r.reason)}`);
  });
}

/** Re-apply settings side effects (cache caps) after settings changed. */
export function applySettingsEffects(s: Services): void {
  s.chapters.cache.enforceCap();
  s.covers.lru.enforceCap();
}

export function lazyPluginHost(platform: Platform): LoadPluginHost {
  return async (deps) => {
    const mod = await platform.importLazy<{
      createPluginHost?: CreatePluginHost;
      pluginInfo?: (adapter: SourceAdapter) => { imageRequestInit?: { headers?: Record<string, string> } } | undefined;
    }>('plugin-host');
    if (!mod || typeof mod.createPluginHost !== 'function') throw new AppError('PLUGIN', `The plugin-host bundle does not export createPluginHost (got: ${mod && typeof mod === 'object' ? Object.keys(mod).join(',') || 'no keys' : typeof mod})`);
    const host = mod.createPluginHost(deps);
    const info = mod.pluginInfo;
    if (typeof info !== 'function') return host;
    return {
      providedModules: host.providedModules,
      load: (code, o) => host.load(code, o),
      imageRequestInit: (adapter) => info(adapter)?.imageRequestInit,
    };
  };
}

/**
 * The platform as services see it: the same object (prototype-linked, so every property and getter is
 * the original's) with a rate-limited `log` (lib/log-limit.ts).
 */
function withLogLimit(base: Platform): { platform: Platform; limiter: LogLimiter } {
  const limiter = createLogLimiter((level, message, data) => base.log(level, message, data), { now: () => base.now() });
  const platform = Object.create(base) as Platform;
  platform.log = limiter.log;
  return { platform, limiter };
}

export async function createServices(opts: ServicesOptions): Promise<Services> {
  const { platform, limiter } = withLogLimit(opts.platform);
  const timing: Timing = { ...DEFAULT_TIMING, ...opts.timing };
  const storageAlarm = new StorageAlarm();
  const env: DocEnv = {
    sleep: (ms) => platform.sleep(ms),
    now: () => platform.now(),
    log: (level, message, data) => platform.log(level, message, data),
    writeFailed: (_path, err) => storageAlarm.stateWriteFailed(err),
  };
  const settingsDoc = await JsonDoc.load(platform.synced, SETTINGS_SPEC, timing.settingsWriteMs, env, { mirror: platform.local });
  const ctx: Ctx = { platform, env, timing, events: new EventHub(opts.keepRecentEvents ?? 0), settings: () => settingsDoc.value };
  storageAlarm.attach(ctx.events);
  const net = createNet(platform, opts.net);
  const covers = new CoverCache(ctx, net.lane('cover'));
  const kv = new PluginKvStore(ctx);

  const [library, history, sources, symbols] = await Promise.all([
    LibraryService.load(ctx, covers),
    HistoryService.load(ctx),
    SourceService.load(ctx, net, kv, opts.loadPluginHost ?? lazyPluginHost(platform), opts.solveChallenge),
    SymbolService.load(ctx, opts.buildVersion),
    covers.init().catch((err: unknown) => platform.log('warn', `Cover index unavailable: ${errorMessage(err)}`)),
  ]);

  const progress = new ProgressService(ctx);
  const updates = new UpdatesService(ctx);
  const store = new NovelStore(ctx);
  // Settings change what a source's pages contain: forget its cached novel pages.
  sources.onSettingsChanged = (id) => {
    store.forgetSource(id);
  };
  const downloads = new DownloadService(ctx, library, store);
  downloads.storageAlarm = storageAlarm;
  const chapters = new ChapterService(ctx, sources, store, progress, downloads);
  const novels = new NovelService(ctx, { sources, store, library, progress, updates, covers, downloads, history });
  const reading = new ReadingService(ctx, { progress, history, library, updates, novels: store, downloads, chapters });
  const browse = new BrowseService(sources, library, store);
  // Chapter lists for lock checks when a chapter's novel isn't known yet (kept for the session).
  chapters.setChapterListLoader(async (novel, lane) => {
    const ks = novelKeyString(novel);
    if (library.has(ks)) return (await novels.refreshLibraryNovel(ks, { recordUpdates: true, lane })).data.chapters;
    const data = await novels.fetchNovel(novel, lane);
    store.remember(ks, data);
    return data.chapters;
  });

  const services: Services = {
    ctx,
    settingsDoc,
    net,
    covers,
    library,
    history,
    updates,
    progress,
    store,
    sources,
    kv,
    downloads,
    chapters,
    novels,
    reading,
    browse,
    symbols,
    backup: undefined as unknown as BackupService, // set right below (it needs the services object)
    autoDownload: new AutoDownloadService(ctx, { history, progress, downloads, chapters }),
    stats: new StatsService(ctx),
    narration: new NarrationService(ctx),
    images: new ImageCache(ctx, net.lane('cover'), chapters.cache),
    logLimiter: limiter,
    storageAlarm,
    libraryExport: new LibraryExport(ctx, { library, sources }),
    icloud: new ICloudState(ctx, [settingsDoc, library.syncDoc, history.syncDoc, sources.syncDoc]),
    migrate: undefined as unknown as MigrateService, // needs `stats`: set right below
  };
  services.migrate = new MigrateService(ctx, { novels, store, chapters, library, progress, history, stats: services.stats });
  reading.stats = services.stats;
  reading.onChapterChange = (key) => inBackground(ctx, 'Smart downloads', services.autoDownload.run([key]));
  reading.onChapterRead = (key, novel, chapterPath) => inBackground(ctx, `Read-ahead from ${chapterPath}`, chapters.readAheadFrom(key, novel, chapterPath));
  services.backup = new BackupService(ctx, {
    buildVersion: opts.buildVersion,
    settingsDoc,
    library,
    history,
    updates,
    progress,
    sources,
    novels,
    store,
    covers,
    flush: () => flushServices(services),
    settingsChanged: () => applySettingsEffects(services),
  });
  // iCloud delivered the real settings after a session started on defaults: apply their side effects.
  settingsDoc.onReloaded = () => applySettingsEffects(services);
  return services;
}
