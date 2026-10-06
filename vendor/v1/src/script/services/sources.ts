/**
 * Installed sources (LNReader plugins) and plugin repos.
 *
 * - Registry: synced `sources/index.json` (sources + repos). Plugin code: synced `sources/plugins/<id>.js`.
 * - Built-in Stonescape is registered on first run and loaded straight from the deployed
 *   `app/plugins/stonescape.js` (so deploys update it). Built-ins can be disabled, not uninstalled.
 * - The plugin host (and its parser libraries) loads lazily on first source use.
 */
import type { AvailablePlugin, PluginSettingValues, RepoInfo, SourceInfo, SourceSettings } from '../../shared/contracts/domain.ts';
import type { Filters } from '../../shared/lnreader/filters.ts';
import type { PluginHost, PluginHostDeps, SourceAdapter, SourceMeta } from '../../shared/contracts/plugin-host.ts';
import { Inflight, type Lane, mapLimit } from '../lib/async.ts';
import { AppError, errorMessage, invalidArgs, notFound } from '../lib/errors.ts';
import { safeName } from '../lib/hash.ts';
import { hostOf, repoNameOf } from '../lib/url.ts';
import { isHttpUrl, isRecord } from '../lib/validate.ts';
import { compareVersions } from '../lib/version.ts';
import { type DocSpec, JsonDoc } from '../storage/json-doc.ts';
import type { Ctx } from './context.ts';
import type { Net } from './net.ts';
import type { PluginKvStore } from './plugin-kv.ts';
import { copyOptional, isNonEmpty, isNum, isStr, repoInfo, validItems } from './records.ts';
import { verifiedRank, verifiedReason, verifiedStatus } from './verified.ts';

export interface InstalledSource extends SourceInfo {
  /** Plugin code, relative to the synced store. */
  file: string;
  /** URL the code was downloaded from (for updates without a repo). */
  installUrl?: string;
  /** SourceMeta.customCSS: URL of the plugin's reader stylesheet. */
  customCSSUrl?: string;
  /** Fetched stylesheet text (≤ 64 KB) sent with chapters. */
  customCSS?: string;
  /** `${customCSSUrl}#${version}` the text was fetched for (refetched when either changes). */
  customCSSFrom?: string;
  /** Headers from the plugin's imageRequestInit (cover requests), cached when the plugin loads. */
  imageHeaders?: Record<string, string>;
  /** Update-check health: consecutive source failures, and checks skipped until this time. */
  checkFailures?: number;
  checkSkipUntil?: number;
  /** The plugin's filter definitions (null = none), cached for `filtersVersion`. */
  filters?: Filters | null;
  filtersVersion?: string;
  /** meta.settings has at least one setting (SourceInfo.hasSettings). */
  hasSettings?: boolean;
  /** Keys of meta.settings: which plugin-storage keys are settings (backups keep only these). */
  settingKeys?: string[];
}

interface RegistryDoc {
  schemaVersion: number;
  sources: InstalledSource[];
  repos: RepoInfo[];
  /** Default repos were added once (the user may remove them). */
  seeded: boolean;
}

export interface RepoPlugin {
  id: string;
  name: string;
  site: string;
  lang: string;
  version: string;
  url: string;
  iconUrl?: string;
}

/** What a backup keeps per installed (non-built-in) source; the code is re-downloaded on restore. */
export interface SourceBackup {
  id: string;
  name: string;
  site: string;
  lang: string;
  version: string;
  enabled: boolean;
  pinned: boolean;
  installUrl?: string;
  repoUrl?: string;
}

export const LNREADER_REPO = 'https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json';

export const BUILTIN_SOURCES: readonly Omit<InstalledSource, 'enabled' | 'pinned' | 'builtIn' | 'hasFilters'>[] = [
  { id: 'stonescape', name: 'Stonescape', site: 'https://stonescape.xyz/', lang: 'English', version: '', file: 'app/plugins/stonescape.js' },
];

const DEFAULT_REPOS: readonly { url: string; name: string }[] = [{ url: LNREADER_REPO, name: 'LNReader' }];

const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;
export const MAX_CUSTOM_CSS_BYTES = 64 * 1024;
/** Update checks skip a source for UPDATE_CHECK_SKIP_MS after this many failures in a row. */
export const UPDATE_CHECK_FAILURE_LIMIT = 3;
export const UPDATE_CHECK_SKIP_MS = 60 * 60 * 1000;
const CSS_TYPES = new Set(['text/css', 'text/plain']);

function settingKeysOf(meta: SourceMeta): string[] {
  return meta.settings ? Object.keys(meta.settings) : [];
}

function sameKeys(a: readonly string[] | undefined, b: readonly string[]): boolean {
  const x = a ?? [];
  return x.length === b.length && x.every((k, i) => k === b[i]);
}

function setSettingKeys(s: InstalledSource, keys: string[]): void {
  if (keys.length > 0) {
    s.hasSettings = true;
    s.settingKeys = keys;
  } else {
    delete s.hasSettings;
    delete s.settingKeys;
  }
}

/** Plugin code lives only here (written by install, or deployed for built-ins). */
const PLUGIN_FILE_RE = /^(?:sources|app)\/plugins\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,80}\.js$/;

/** A stored registry source made safe to use (records.ts style): null drops it. */
export function storedSource(v: unknown): InstalledSource | null {
  if (!isRecord(v) || !isNonEmpty(v.id) || v.id.includes(':') || !isStr(v.file) || !PLUGIN_FILE_RE.test(v.file)) return null;
  const s: InstalledSource = {
    id: v.id,
    name: isNonEmpty(v.name) ? v.name : v.id,
    site: isStr(v.site) ? v.site : '',
    version: isStr(v.version) ? v.version : '',
    lang: isNonEmpty(v.lang) ? v.lang : 'Unknown',
    enabled: v.enabled !== false,
    pinned: v.pinned === true,
    builtIn: v.builtIn === true,
    hasFilters: v.hasFilters === true,
    file: v.file,
  };
  copyOptional(s, v, ['iconUrl', 'repoUrl', 'updateAvailable', 'installUrl', 'customCSSUrl', 'customCSS', 'customCSSFrom', 'filtersVersion'], isStr);
  copyOptional(s, v, ['lastUsedAt', 'checkSkipUntil'], isNum);
  if (isNum(v.checkFailures) && v.checkFailures > 0) s.checkFailures = Math.floor(v.checkFailures);
  if (isRecord(v.imageHeaders)) {
    const headers: Record<string, string> = {};
    for (const [k, h] of Object.entries(v.imageHeaders)) if (isStr(h)) headers[k] = h;
    s.imageHeaders = headers;
  }
  if (v.filters === null || isRecord(v.filters)) s.filters = v.filters as Filters | null;
  if (v.hasSettings === true) s.hasSettings = true;
  if (Array.isArray(v.settingKeys)) s.settingKeys = v.settingKeys.filter(isNonEmpty).slice(0, 200);
  // Early registries stored the stylesheet URL in `customCSS`.
  if (s.customCSS !== undefined && s.customCSSFrom === undefined) {
    if (s.customCSSUrl === undefined && isHttpUrl(s.customCSS)) s.customCSSUrl = s.customCSS;
    delete s.customCSS;
  }
  return s;
}

export const REGISTRY_SPEC: DocSpec<RegistryDoc> = {
  path: 'sources/index.json',
  version: 1,
  create: () => ({ schemaVersion: 1, sources: [], repos: [], seeded: false }),
  normalize(doc) {
    const ids = new Set<string>();
    const sources = validItems(doc.sources, (v) => {
      const s = storedSource(v);
      if (!s || ids.has(s.id)) return null;
      ids.add(s.id);
      return s;
    });
    const urls = new Set<string>();
    const repos = validItems(doc.repos, (v) => {
      const r = repoInfo(v);
      if (!r || urls.has(r.url)) return null;
      urls.add(r.url);
      return r;
    });
    return { schemaVersion: doc.schemaVersion, sources, repos, seeded: doc.seeded === true };
  },
};

/** A plugin host, optionally able to report a loaded plugin's `imageRequestInit` (agent C's pluginInfo). */
export interface PluginHostWithInfo extends PluginHost {
  imageRequestInit?(adapter: SourceAdapter): { headers?: Record<string, string> } | undefined;
}

export type LoadPluginHost = (deps: PluginHostDeps) => Promise<PluginHostWithInfo>;

/** `version = '1.0.0'` / `version: "1.0.0"` in plugin source (built class field or object literal). */
export function builtInVersion(code: string): string | undefined {
  return /\bversion\s*[:=]\s*["']([0-9][^"'\s]{0,39})["']/.exec(code)?.[1];
}

function parseRepoItem(v: unknown): RepoPlugin | null {
  if (!isRecord(v)) return null;
  const { id, name, site, lang, version, url, iconUrl } = v;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof url !== 'string' || !isHttpUrl(url)) return null;
  const item: RepoPlugin = {
    id,
    name,
    site: typeof site === 'string' ? site : '',
    lang: typeof lang === 'string' ? lang : 'Unknown',
    version: typeof version === 'string' ? version : '0',
    url,
  };
  if (typeof iconUrl === 'string' && isHttpUrl(iconUrl)) item.iconUrl = iconUrl;
  return item;
}

export class SourceService {
  private readonly ctx: Ctx;
  private readonly net: Net;
  private readonly kv: PluginKvStore;
  private readonly doc: JsonDoc<RegistryDoc>;
  private readonly loadHost: LoadPluginHost;
  private readonly solver: ((url: string) => Promise<boolean>) | undefined;
  /** One plugin host per network lane, so background work can't take interactive slots. */
  private readonly hosts = new Map<Lane, Promise<PluginHostWithInfo>>();
  /** `${lane}:${id}` → adapter */
  private readonly adapters = new Map<string, Promise<SourceAdapter>>();
  private readonly repoCache = new Map<string, { at: number; items: RepoPlugin[] }>();
  private readonly repoFetches = new Inflight<RepoPlugin[]>();
  /** In-flight stylesheet fetch per source id (and the registry object it is for). */
  private readonly cssFetches = new Map<string, { target: InstalledSource; done: Promise<void> }>();
  /** `${id}|${from}` already attempted this session (failures are retried next launch, not per call). */
  private readonly cssTried = new Set<string>();

  private constructor(
    ctx: Ctx,
    net: Net,
    kv: PluginKvStore,
    doc: JsonDoc<RegistryDoc>,
    loadHost: LoadPluginHost,
    solver: ((url: string) => Promise<boolean>) | undefined,
  ) {
    this.solver = solver;
    this.ctx = ctx;
    this.net = net;
    this.kv = kv;
    this.doc = doc;
    this.loadHost = loadHost;
  }

  static async load(
    ctx: Ctx,
    net: Net,
    kv: PluginKvStore,
    loadHost: LoadPluginHost,
    solver?: (url: string) => Promise<boolean>,
  ): Promise<SourceService> {
    const doc = await JsonDoc.load(ctx.platform.synced, REGISTRY_SPEC, ctx.timing.indexWriteMs, ctx.env, { mirror: ctx.platform.local });
    const svc = new SourceService(ctx, net, kv, doc, loadHost, solver);
    svc.ensureDefaults();
    // iCloud delivered the real registry after a session started on defaults: built-ins stay listed.
    doc.onReloaded = () => svc.ensureDefaults();
    await svc.fillBuiltInVersions();
    return svc;
  }

  /** The synced registry document (iCloud state checks). */
  get syncDoc(): JsonDoc<RegistryDoc> {
    return this.doc;
  }

  // ---------- registry ----------

  private ensureDefaults(): void {
    const v = this.doc.value;
    let changed = false;
    for (const b of BUILTIN_SOURCES) {
      const existing = v.sources.find((s) => s.id === b.id);
      if (!existing) {
        v.sources.push({ ...b, enabled: true, pinned: false, builtIn: true, hasFilters: false });
        changed = true;
      } else if (!existing.builtIn || existing.file !== b.file) {
        existing.builtIn = true;
        existing.file = b.file;
        changed = true;
      }
    }
    if (!v.seeded) {
      for (const r of DEFAULT_REPOS) if (!v.repos.some((x) => x.url === r.url)) v.repos.push({ url: r.url, name: r.name, pluginCount: 0 });
      v.seeded = true;
      changed = true;
    }
    if (changed) this.doc.changed();
  }

  /**
   * A built-in that has never been loaded has no version yet ("v · Built in"). Read it from the
   * deployed plugin file (only then: one small read on the first launch); loading the plugin later
   * refreshes it from the plugin's own metadata.
   */
  private async fillBuiltInVersions(): Promise<void> {
    for (const s of this.doc.value.sources) {
      if (!s.builtIn || s.version) continue;
      try {
        const code = await this.ctx.platform.synced.readText(s.file);
        const version = code ? builtInVersion(code) : undefined;
        if (version) {
          s.version = version;
          this.doc.changed();
        }
      } catch (err) {
        this.ctx.platform.log('warn', `Built-in ${s.id}: version unreadable: ${errorMessage(err)}`);
      }
    }
  }

  get(id: string): InstalledSource | undefined {
    return this.doc.value.sources.find((s) => s.id === id);
  }

  private require(id: string): InstalledSource {
    const s = this.get(id);
    if (!s) throw notFound(`Source "${id}" is not installed`);
    return s;
  }

  info(s: InstalledSource): SourceInfo {
    const out: SourceInfo = {
      id: s.id,
      name: s.name,
      site: s.site,
      version: s.version,
      lang: s.lang,
      enabled: s.enabled,
      pinned: s.pinned,
      builtIn: s.builtIn,
      hasFilters: s.hasFilters,
    };
    if (s.iconUrl) out.iconUrl = s.iconUrl;
    if (s.repoUrl) out.repoUrl = s.repoUrl;
    if (s.updateAvailable) out.updateAvailable = s.updateAvailable;
    if (s.lastUsedAt) out.lastUsedAt = s.lastUsedAt;
    if (s.hasSettings) out.hasSettings = true;
    return out;
  }

  /** Pinned first, then by name. */
  list(): SourceInfo[] {
    return [...this.doc.value.sources]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))
      .map((s) => this.info(s));
  }

  enabledIds(): string[] {
    return this.list()
      .filter((s) => s.enabled)
      .map((s) => s.id);
  }

  setEnabled(id: string, enabled: boolean): SourceInfo[] {
    this.require(id).enabled = enabled;
    this.doc.changed();
    return this.list();
  }

  setPinned(id: string, pinned: boolean): SourceInfo[] {
    this.require(id).pinned = pinned;
    this.doc.changed();
    return this.list();
  }

  markUsed(id: string): void {
    const s = this.get(id);
    if (!s) return;
    s.lastUsedAt = this.ctx.platform.now();
    this.doc.changed();
  }

  /** For browse: installed and enabled. */
  requireEnabled(id: string): InstalledSource {
    const s = this.require(id);
    if (!s.enabled) throw invalidArgs(`Source "${s.name}" is disabled`);
    return s;
  }

  flush(): Promise<void> {
    return this.doc.flush();
  }

  // ---------- plugin host & adapters ----------

  /** Whether the lazy plugin host has been loaded (boot must not load it). */
  get hostLoaded(): boolean {
    return this.hosts.size > 0;
  }

  private host(lane: Lane): Promise<PluginHostWithInfo> {
    let hostPromise = this.hosts.get(lane);
    if (!hostPromise) {
      const { platform } = this.ctx;
      const deps: PluginHostDeps = {
        http: this.net.lane(lane),
        storageFor: (id) => this.kv.kvFor(id),
        log: (level, message, data) => platform.log(level, message, data),
        now: () => platform.now(),
        sleep: (ms) => platform.sleep(ms),
      };
      if (platform.browserFetch) deps.browserFetch = platform.browserFetch;
      const p = this.loadHost(deps);
      hostPromise = p;
      this.hosts.set(lane, p);
      void p.catch(() => {
        if (this.hosts.get(lane) === p) this.hosts.delete(lane);
      });
    }
    return hostPromise;
  }

  /**
   * The source's adapter for a network lane: 'interactive' (what the user waits for: browse, novel
   * pages, the opened chapter) or 'background' (update checks, read-ahead, downloads). Each lane has
   * its own plugin instance whose requests go through that lane's per-host limits.
   */
  adapter(id: string, lane: Lane = 'interactive'): Promise<SourceAdapter> {
    const key = `${lane}:${id}`;
    let p = this.adapters.get(key);
    if (!p) {
      p = this.loadAdapter(id, lane);
      this.adapters.set(key, p);
      const current = p;
      void current.catch(() => {
        if (this.adapters.get(key) === current) this.adapters.delete(key);
      });
    }
    return p;
  }

  private dropAdapters(id: string): void {
    this.adapters.delete(`interactive:${id}`);
    this.adapters.delete(`background:${id}`);
  }

  private async loadAdapter(id: string, lane: Lane): Promise<SourceAdapter> {
    const src = this.require(id);
    let code: string | null;
    try {
      code = await this.ctx.platform.synced.readText(src.file);
    } catch (err) {
      throw new AppError('STORAGE', `Couldn't read the code of ${src.name}: ${errorMessage(err)}`);
    }
    if (code === null) throw new AppError('PLUGIN', src.builtIn ? `The built-in source ${src.name} is missing its code; deploy the app again` : `The code of ${src.name} is missing; reinstall the source`);
    const host = await this.host(lane);
    await this.kv.preload(id);
    const opts: { expectedId: string; sourceUrl?: string } = { expectedId: id };
    if (src.installUrl) opts.sourceUrl = src.installUrl;
    const adapter = host.load(code, opts);
    this.applyMeta(src, adapter.meta);
    this.cacheFilters(src, adapter.meta);
    this.cacheImageHeaders(src, host, adapter);
    this.syncCustomCSS(src, false);
    return adapter;
  }

  private cacheImageHeaders(s: InstalledSource, host: PluginHostWithInfo, adapter: SourceAdapter): void {
    let headers: Record<string, string> | undefined;
    try {
      const raw = host.imageRequestInit?.(adapter)?.headers;
      if (raw && typeof raw === 'object') {
        headers = {};
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') headers[k] = v;
      }
    } catch (err) {
      this.ctx.platform.log('warn', `imageRequestInit of ${s.id} unreadable: ${errorMessage(err)}`);
    }
    if (JSON.stringify(s.imageHeaders ?? null) === JSON.stringify(headers ?? null)) return;
    if (headers && Object.keys(headers).length > 0) s.imageHeaders = headers;
    else delete s.imageHeaders;
    this.doc.changed();
  }

  /** Headers for fetching this source's images: its imageRequestInit headers plus Referer: <site>. */
  imageRequestHeaders(id: string): Record<string, string> {
    const s = this.get(id);
    const out: Record<string, string> = {};
    if (s?.site) out.Referer = s.site;
    if (s?.imageHeaders) Object.assign(out, s.imageHeaders);
    return out;
  }

  private cacheFilters(s: InstalledSource, meta: SourceMeta): void {
    const filters = meta.filters && Object.keys(meta.filters).length > 0 ? meta.filters : null;
    if (s.filtersVersion === meta.version && JSON.stringify(s.filters ?? null) === JSON.stringify(filters)) return;
    s.filters = filters;
    s.filtersVersion = meta.version;
    this.doc.changed();
  }

  /** The plugin's filter definitions (null if none). Cached in the registry; loads the plugin only when needed. */
  async filters(id: string): Promise<Filters | null> {
    const s = this.require(id);
    if (s.filters !== undefined && s.filtersVersion === s.version) return s.filters;
    await this.adapter(id);
    return this.get(id)?.filters ?? null;
  }

  // ---------- plugin settings ----------

  /** Called after a source's settings changed (services drop that source's cached novel pages). */
  onSettingsChanged: ((id: string) => void) | null = null;

  private settingsOf(adapter: SourceAdapter): SourceSettings {
    const schema = adapter.meta.settings ?? {};
    const values = Object.keys(schema).length > 0 && adapter.getSettings ? adapter.getSettings() : {};
    return { schema, values };
  }

  /** sources.settings.get: the plugin's settings and current values ({} / {} when it has none). */
  async settings(id: string): Promise<SourceSettings> {
    this.require(id);
    return this.settingsOf(await this.adapter(id));
  }

  /**
   * sources.settings.set: saved through the loaded (interactive) instance, which reloads itself with
   * them (SettingsError → INVALID_ARGS; nothing changes then). The background instance is dropped so
   * it reloads with the new values, and cached novel pages of the source are forgotten.
   */
  async setSettings(id: string, values: unknown): Promise<SourceSettings> {
    const s = this.require(id);
    if (!isRecord(values)) throw invalidArgs('values must be an object of setting key → value');
    const adapter = await this.adapter(id);
    const schema = adapter.meta.settings ?? {};
    if (Object.keys(schema).length === 0 || !adapter.setSettings) throw invalidArgs(`${s.name} has no settings`);
    adapter.setSettings(values as Partial<PluginSettingValues>);
    this.adapters.delete(`background:${id}`);
    const current = this.get(id);
    if (current) {
      this.applyMeta(current, adapter.meta);
      this.cacheFilters(current, adapter.meta);
    }
    try {
      this.onSettingsChanged?.(id);
    } catch (err) {
      this.ctx.platform.log('warn', `After settings of ${id} changed: ${errorMessage(err)}`);
    }
    this.ctx.platform.log('info', `Settings of ${id} changed: ${Object.keys(values).join(', ')}`);
    return this.settingsOf(adapter);
  }

  /**
   * Setting values as stored in plugin storage (raw items), per source, for backups. Only keys that
   * are settings are included; no other plugin storage. Sources never loaded with settings are absent.
   */
  async backupSettings(): Promise<Record<string, Record<string, unknown>>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const s of this.doc.value.sources) {
      if (!s.settingKeys?.length) continue;
      try {
        await this.kv.preload(s.id);
      } catch (err) {
        this.ctx.platform.log('warn', `Backup: settings of ${s.id} unreadable: ${errorMessage(err)}`);
        continue;
      }
      const kv = this.kv.kvFor(s.id);
      const values: Record<string, unknown> = {};
      for (const key of s.settingKeys) {
        const item = kv.get(key);
        if (item !== undefined && item !== null) values[key] = item;
      }
      if (Object.keys(values).length > 0) out[s.id] = values;
    }
    return out;
  }

  /**
   * Put backed-up setting values back into plugin storage (sources installed now; others skipped).
   * merge: keys already set on this device are kept. Loaded instances reload on next use.
   */
  async restoreSettings(all: Record<string, Record<string, unknown>>, mode: 'merge' | 'replace'): Promise<number> {
    let restored = 0;
    for (const [id, values] of Object.entries(all)) {
      if (!this.get(id)) continue;
      try {
        await this.kv.preload(id);
      } catch (err) {
        this.ctx.platform.log('warn', `Restore: settings of ${id} not restored: ${errorMessage(err)}`);
        continue;
      }
      const kv = this.kv.kvFor(id);
      for (const [key, item] of Object.entries(values)) {
        if (mode === 'merge' && kv.get(key) !== undefined) continue;
        kv.set(key, item);
      }
      this.dropAdapters(id);
      restored++;
    }
    return restored;
  }

  // ---------- update-check health ----------

  /** Whether update checks should skip this source right now (it kept failing recently). */
  updateCheckPaused(id: string): boolean {
    const s = this.get(id);
    return !!s?.checkSkipUntil && this.ctx.platform.now() < s.checkSkipUntil;
  }

  /** Record one novel's update-check outcome for its source. */
  recordUpdateCheck(id: string, ok: boolean): void {
    const s = this.get(id);
    if (!s) return;
    if (ok) {
      if (s.checkFailures || s.checkSkipUntil) {
        delete s.checkFailures;
        delete s.checkSkipUntil;
        this.doc.changed();
      }
      return;
    }
    s.checkFailures = (s.checkFailures ?? 0) + 1;
    if (s.checkFailures >= UPDATE_CHECK_FAILURE_LIMIT) {
      s.checkSkipUntil = this.ctx.platform.now() + UPDATE_CHECK_SKIP_MS;
      s.checkFailures = 0;
      this.ctx.platform.log('warn', `Update checks skip ${s.name} for an hour after ${UPDATE_CHECK_FAILURE_LIMIT} failures in a row`);
    }
    this.doc.changed();
  }

  // ---------- Cloudflare: solve in a visible WebView ----------

  /**
   * Let the user pass the site's check in a visible WebView. If the page was no longer a challenge when
   * they closed it, this host's GETs go through the hidden-WebView fetch for the rest of the session
   * (works if Scriptable WebViews share cookies — unverified, so the first routed response is logged).
   */
  async solveChallenge(id: string): Promise<{ solved: boolean }> {
    const s = this.require(id);
    if (!isHttpUrl(s.site)) throw invalidArgs(`"${s.name}" has no website to open`);
    if (!this.solver) throw new AppError('PLUGIN', 'Solving a browser check is not available here', false);
    const host = hostOf(s.site);
    this.ctx.platform.log('info', `Cloudflare: opening ${s.site} for the user`);
    const solved = await this.solver(s.site);
    if (solved) {
      this.net.preferBrowser(host);
      this.ctx.platform.log('info', `Cloudflare: ${host} passed; its requests now go through the WebView fetch this session`);
    } else {
      this.ctx.platform.log('info', `Cloudflare: ${host} still shows a challenge (or the check couldn't run)`);
    }
    return { solved };
  }

  // ---------- plugin stylesheet (customCSS) ----------

  /** Fetch the plugin's stylesheet when the stored text is missing or stale (once per session). */
  private syncCustomCSS(s: InstalledSource, force: boolean): void {
    const url = s.customCSSUrl;
    if (!url) {
      if (s.customCSS !== undefined || s.customCSSFrom !== undefined) {
        delete s.customCSS;
        delete s.customCSSFrom;
        this.doc.changed();
      }
      return;
    }
    const from = `${url}#${s.version}`;
    if (!force && s.customCSSFrom === from) return;
    const inflight = this.cssFetches.get(s.id);
    if (inflight && inflight.target === s && !force) return;
    const tryKey = `${s.id}|${from}`;
    if (!force && this.cssTried.has(tryKey)) return;
    this.cssTried.add(tryKey);
    const entry = { target: s, done: Promise.resolve() };
    entry.done = this.fetchCustomCSS(s, url, from).finally(() => {
      if (this.cssFetches.get(s.id) === entry) this.cssFetches.delete(s.id);
    });
    this.cssFetches.set(s.id, entry);
  }

  private async fetchCustomCSS(s: InstalledSource, url: string, from: string): Promise<void> {
    try {
      if (!isHttpUrl(url)) throw new Error('not an http(s) URL');
      const res = await this.net.lane('background').request({ url, headers: { Accept: 'text/css,text/plain;q=0.9' } });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!CSS_TYPES.has(type)) throw new Error(`unexpected content-type "${type || 'none'}"`);
      if (res.body.length > MAX_CUSTOM_CSS_BYTES) throw new Error(`stylesheet larger than ${MAX_CUSTOM_CSS_BYTES / 1024} KB`);
      if (this.get(s.id) !== s) return; // uninstalled or replaced meanwhile
      s.customCSS = res.body;
      s.customCSSFrom = from;
      this.doc.changed();
    } catch (err) {
      this.ctx.platform.log('warn', `customCSS for ${s.id} not loaded (${url}): ${errorMessage(err)}`);
      if (this.get(s.id) === s && (s.customCSS !== undefined || s.customCSSFrom !== undefined)) {
        delete s.customCSS;
        delete s.customCSSFrom;
        this.doc.changed();
      }
    }
  }

  /** Stylesheet text to send with chapters: whatever is stored now (fetches run in the background). */
  customCSSText(id: string): string | undefined {
    return this.get(id)?.customCSS;
  }

  /** Resolves when no stylesheet fetch is running (tests). */
  async cssIdle(): Promise<void> {
    await Promise.all([...this.cssFetches.values()].map((f) => f.done));
  }

  // ---------- install confirmation ----------

  /** Display name for a plugin URL: its name in a cached repo listing, else the file name. */
  private pluginLabel(url: string): string {
    for (const cached of this.repoCache.values()) {
      const item = cached.items.find((p) => p.url === url);
      if (item) return item.name;
    }
    const file = url.split(/[?#]/)[0]?.split('/').pop();
    return file || url;
  }

  /**
   * Native confirmation before any plugin code is evaluated. The WebView can't answer a native alert,
   * so a compromised UI can't install code silently. Throws INVALID_ARGS "cancelled" on Cancel.
   */
  private async confirmInstall(title: string, items: { name: string; host: string; bytes?: number }[]): Promise<void> {
    const lines = items.map((i) => `${i.name} — ${i.bytes !== undefined ? `${Math.max(1, Math.round(i.bytes / 1024))} KB, ` : ''}from ${i.host}`);
    const index = await this.ctx.platform.native.alert({
      title,
      message: `${lines.join('\n')}\n\nPlugins are code that runs inside TachiNovel. Only install plugins you trust.`,
      actions: [{ title: items.length > 1 ? `Install ${items.length}` : 'Install' }],
      cancel: 'Cancel',
    });
    if (index !== 0) throw new AppError('INVALID_ARGS', 'Plugin install cancelled', false);
  }

  private applyMeta(s: InstalledSource, meta: SourceMeta): void {
    const hasFilters = !!meta.filters && Object.keys(meta.filters).length > 0;
    const lang = meta.lang ?? s.lang;
    const settingKeys = settingKeysOf(meta);
    if (
      s.name === meta.name &&
      s.site === meta.site &&
      s.version === meta.version &&
      s.lang === lang &&
      s.iconUrl === meta.iconUrl &&
      s.hasFilters === hasFilters &&
      s.customCSSUrl === meta.customCSS &&
      sameKeys(s.settingKeys, settingKeys)
    ) {
      return;
    }
    setSettingKeys(s, settingKeys);
    s.name = meta.name;
    s.site = meta.site;
    s.version = meta.version;
    s.lang = lang;
    s.hasFilters = hasFilters;
    if (meta.iconUrl) s.iconUrl = meta.iconUrl;
    else delete s.iconUrl;
    if (meta.customCSS) s.customCSSUrl = meta.customCSS;
    else delete s.customCSSUrl;
    this.doc.changed();
  }

  // ---------- install / uninstall / update ----------

  /**
   * Install or replace a plugin. A native confirmation (name, size, origin) is shown before the code is
   * evaluated, unless the caller already confirmed (restore shows one alert for all plugins).
   */
  async install(input: { url: string } | { code: string }, opts: { confirmed?: boolean; title?: string } = {}): Promise<SourceInfo> {
    let code: string;
    let url: string | undefined;
    if ('url' in input) {
      url = input.url;
      const res = await this.net.request({ url, headers: { Accept: 'application/javascript, text/plain, */*' } });
      if (res.status !== 200) throw new AppError('NETWORK', `Couldn't download the source from ${hostOf(url) || url} (HTTP ${res.status})`, res.status >= 500);
      code = res.body;
    } else {
      code = input.code;
    }
    if (!code.trim()) throw invalidArgs('Plugin code is empty');
    if (code.length > MAX_PLUGIN_BYTES) throw invalidArgs('Plugin code is too large');
    if (!opts.confirmed) {
      await this.confirmInstall(opts.title ?? 'Install plugin?', [
        url ? { name: this.pluginLabel(url), host: hostOf(url) || url, bytes: code.length } : { name: 'Pasted plugin code', host: 'the clipboard', bytes: code.length },
      ]);
    }

    const host = await this.host('interactive');
    const adapter = host.load(code, url ? { sourceUrl: url } : undefined);
    const meta = adapter.meta;
    if (BUILTIN_SOURCES.some((b) => b.id === meta.id)) throw invalidArgs(`"${meta.id}" is a built-in source and can't be replaced`);

    const file = `sources/plugins/${safeName(meta.id)}.js`;
    try {
      await this.ctx.platform.synced.writeText(file, code);
    } catch (err) {
      throw new AppError('STORAGE', `Couldn't save the source: ${errorMessage(err)}`);
    }
    const existing = this.get(meta.id);
    const entry: InstalledSource = {
      id: meta.id,
      name: meta.name,
      site: meta.site,
      version: meta.version,
      lang: meta.lang ?? 'Unknown',
      enabled: existing?.enabled ?? true,
      pinned: existing?.pinned ?? false,
      builtIn: false,
      hasFilters: !!meta.filters && Object.keys(meta.filters).length > 0,
      file,
    };
    if (meta.iconUrl) entry.iconUrl = meta.iconUrl;
    if (meta.customCSS) entry.customCSSUrl = meta.customCSS;
    setSettingKeys(entry, settingKeysOf(meta));
    entry.filters = meta.filters && Object.keys(meta.filters).length > 0 ? meta.filters : null;
    entry.filtersVersion = meta.version;
    if (existing?.lastUsedAt) entry.lastUsedAt = existing.lastUsedAt;
    if (url) {
      entry.installUrl = url;
      const repo = this.repoOfPluginUrl(url);
      if (repo) entry.repoUrl = repo;
    }
    this.cacheImageHeaders(entry, host, adapter);
    const sources = this.doc.value.sources;
    const i = sources.findIndex((s) => s.id === meta.id);
    if (i >= 0) sources[i] = entry;
    else sources.push(entry);
    await this.doc.save(this.doc.value);
    await this.kv.preload(meta.id);
    this.dropAdapters(meta.id);
    this.adapters.set(`interactive:${meta.id}`, Promise.resolve(adapter));
    this.syncCustomCSS(entry, true); // new/updated plugin: always refetch its stylesheet
    this.ctx.platform.log('info', `Installed source ${meta.id} ${meta.version}${url ? ` from ${url}` : ''}`);
    return this.info(entry);
  }

  async uninstall(id: string): Promise<SourceInfo[]> {
    const s = this.require(id);
    if (s.builtIn) throw invalidArgs(`"${s.name}" is built in; disable it instead`);
    this.doc.value.sources = this.doc.value.sources.filter((x) => x.id !== id);
    await this.doc.save(this.doc.value);
    try {
      this.ctx.platform.synced.remove(s.file);
    } catch (err) {
      this.ctx.platform.log('warn', `Failed to delete ${s.file}: ${errorMessage(err)}`);
    }
    this.kv.remove(id);
    this.dropAdapters(id);
    return this.list();
  }

  async update(id: string): Promise<SourceInfo> {
    const s = this.require(id);
    if (s.builtIn) throw invalidArgs(`"${s.name}" is built in and updates with the app`);
    let url: string | undefined;
    const repos = s.repoUrl ? [s.repoUrl] : this.doc.value.repos.map((r) => r.url);
    for (const repo of repos) {
      try {
        const item = (await this.fetchRepo(repo, true)).find((p) => p.id === id);
        if (item) {
          url = item.url;
          break;
        }
      } catch (err) {
        this.ctx.platform.log('warn', `Repo ${repo} unavailable while updating ${id}: ${errorMessage(err)}`);
      }
    }
    url ??= s.installUrl;
    if (!url) throw invalidArgs(`No update source for "${s.name}" (installed from pasted code)`);
    return this.install({ url }, { title: 'Update plugin?' });
  }

  // ---------- backup / restore ----------

  isBuiltIn(id: string): boolean {
    return BUILTIN_SOURCES.some((b) => b.id === id);
  }

  backupSources(): SourceBackup[] {
    return this.doc.value.sources
      .filter((s) => !s.builtIn)
      .map((s) => {
        const b: SourceBackup = { id: s.id, name: s.name, site: s.site, lang: s.lang, version: s.version, enabled: s.enabled, pinned: s.pinned };
        if (s.installUrl) b.installUrl = s.installUrl;
        if (s.repoUrl) b.repoUrl = s.repoUrl;
        return b;
      });
  }

  /**
   * Restore repos and installed sources from a backup. Missing plugins are re-downloaded from their
   * install URL (or found by id in their repo); built-ins are skipped. replace: repos and the set of
   * installed sources become the backup's. Returns how many backed-up sources are installed afterwards.
   */
  async restore(sources: SourceBackup[], repos: RepoInfo[], mode: 'merge' | 'replace'): Promise<number> {
    const v = this.doc.value;
    const repoMap = new Map<string, RepoInfo>();
    if (mode === 'merge') for (const r of v.repos) repoMap.set(r.url, r);
    for (const r of repos) if (!repoMap.has(r.url)) repoMap.set(r.url, { ...r });
    v.repos = [...repoMap.values()];
    this.doc.changed();

    const wanted = new Map<string, SourceBackup>();
    for (const b of sources) if (!this.isBuiltIn(b.id)) wanted.set(b.id, b);
    if (mode === 'replace') {
      for (const s of [...v.sources]) if (!s.builtIn && !wanted.has(s.id)) await this.uninstall(s.id);
    }
    // Resolve what has to be downloaded, then ask once for all of them.
    const toInstall: { b: SourceBackup; url: string }[] = [];
    for (const b of wanted.values()) {
      if (this.get(b.id)) continue;
      const url = b.installUrl ?? (await this.urlInRepos(b.id, b.repoUrl));
      if (url) toInstall.push({ b, url });
      else this.ctx.platform.log('warn', `Restore: source ${b.id} has no install URL (installed from pasted code?)`);
    }
    let confirmed = toInstall.length > 0;
    if (confirmed) {
      try {
        await this.confirmInstall(
          'Reinstall plugins from the backup?',
          toInstall.map(({ b, url }) => ({ name: b.name || b.id, host: hostOf(url) || url })),
        );
      } catch {
        confirmed = false;
        this.ctx.platform.log('info', 'Restore: plugin reinstall cancelled');
      }
    }
    if (confirmed) {
      for (const { b, url } of toInstall) {
        try {
          await this.install({ url }, { confirmed: true });
        } catch (err) {
          this.ctx.platform.log('warn', `Restore: source ${b.id} not reinstalled: ${errorMessage(err)}`);
        }
      }
    }
    let restored = 0;
    for (const b of wanted.values()) {
      const s = this.get(b.id);
      if (!s) continue;
      s.enabled = b.enabled;
      s.pinned = b.pinned;
      restored++;
    }
    this.doc.changed();
    return restored;
  }

  private async urlInRepos(id: string, repoUrl?: string): Promise<string | undefined> {
    for (const repo of repoUrl ? [repoUrl] : this.doc.value.repos.map((r) => r.url)) {
      try {
        const item = (await this.fetchRepo(repo)).find((p) => p.id === id);
        if (item) return item.url;
      } catch (err) {
        this.ctx.platform.log('warn', `Repo ${repo} unavailable: ${errorMessage(err)}`);
      }
    }
    return undefined;
  }

  // ---------- repos ----------

  repos(): RepoInfo[] {
    return this.doc.value.repos.map((r) => ({ ...r }));
  }

  async addRepo(url: string): Promise<RepoInfo[]> {
    if (!isHttpUrl(url)) throw invalidArgs('Repo URL must be http(s)');
    if (!this.doc.value.repos.some((r) => r.url === url)) {
      const items = await this.fetchRepo(url, true);
      this.doc.value.repos.push({ url, name: repoNameOf(url), pluginCount: items.length, fetchedAt: this.ctx.platform.now() });
      this.doc.changed();
    }
    return this.repos();
  }

  removeRepo(url: string): RepoInfo[] {
    this.doc.value.repos = this.doc.value.repos.filter((r) => r.url !== url);
    this.repoCache.delete(url);
    this.doc.changed();
    return this.repos();
  }

  private repoOfPluginUrl(url: string): string | undefined {
    for (const [repo, cached] of this.repoCache) {
      if (cached.items.some((p) => p.url === url)) return repo;
    }
    return undefined;
  }

  private fetchRepo(url: string, force = false): Promise<RepoPlugin[]> {
    const cached = this.repoCache.get(url);
    if (!force && cached && this.ctx.platform.now() - cached.at < this.ctx.timing.repoTtlMs) return Promise.resolve(cached.items);
    return this.repoFetches.run(url, async () => {
      const res = await this.net.request({ url, headers: { Accept: 'application/json' } });
      if (res.status !== 200) throw new AppError('NETWORK', `Couldn't load the repository at ${hostOf(url) || url} (HTTP ${res.status})`, res.status >= 500);
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        throw new AppError('PLUGIN', `${repoNameOf(url)} isn't a repository file (it isn't valid JSON)`);
      }
      if (!Array.isArray(parsed)) throw new AppError('PLUGIN', `${repoNameOf(url)} isn't a repository file (no list of sources in it)`);
      const items: RepoPlugin[] = [];
      for (const raw of parsed) {
        const item = parseRepoItem(raw);
        if (item) items.push(item);
      }
      const now = this.ctx.platform.now();
      this.repoCache.set(url, { at: now, items });
      const info = this.doc.value.repos.find((r) => r.url === url);
      if (info) {
        info.pluginCount = items.length;
        info.fetchedAt = now;
        this.doc.changed();
      }
      return items;
    });
  }

  /** Plugins in the repos; filtered to settings.languages unless `allLanguages` (installed ones always listed). */
  async available(repoUrl?: string, allLanguages = false): Promise<AvailablePlugin[]> {
    const repos = repoUrl ? this.doc.value.repos.filter((r) => r.url === repoUrl) : this.doc.value.repos;
    if (repoUrl && repos.length === 0) throw invalidArgs(`Unknown repo ${repoUrl}`);
    const results = await mapLimit(repos, 3, async (r): Promise<{ repo: string; items?: RepoPlugin[]; error?: unknown }> => {
      try {
        return { repo: r.url, items: await this.fetchRepo(r.url) };
      } catch (err) {
        this.ctx.platform.log('warn', `Repo ${r.url} failed: ${errorMessage(err)}`);
        return { repo: r.url, error: err };
      }
    });
    const firstError = results.find((r) => !r.items);
    if (firstError && results.every((r) => !r.items)) throw firstError.error;

    const out: AvailablePlugin[] = [];
    let changed = false;
    // Only the user's languages (settings.languages); installed and built-in sources are always listed.
    const languages = new Set(this.ctx.settings().languages);
    for (const r of results) {
      if (!r.items) continue;
      for (const p of r.items) {
        const installed = this.get(p.id);
        if (!installed && !allLanguages && !languages.has(p.lang)) continue;
        const ap: AvailablePlugin = { id: p.id, name: p.name, site: p.site, lang: p.lang, version: p.version, url: p.url, repoUrl: r.repo, installed: !!installed };
        if (p.iconUrl) ap.iconUrl = p.iconUrl;
        const verified = verifiedStatus(p.id, p.version);
        if (verified) ap.verified = verified;
        const why = verified && verified !== 'works' ? verifiedReason(p.id, p.version) : undefined;
        if (why) ap.verifiedReason = why;
        if (installed) {
          ap.installedVersion = installed.version;
          if (!installed.builtIn && (!installed.repoUrl || installed.repoUrl === r.repo)) {
            const newer = compareVersions(p.version, installed.version) > 0 ? p.version : undefined;
            if (installed.updateAvailable !== newer) {
              if (newer) installed.updateAvailable = newer;
              else delete installed.updateAvailable;
              changed = true;
            }
          }
        }
        out.push(ap);
      }
    }
    if (changed) this.doc.changed();
    // Known-good plugins first: works, partial, unverified, broken; then by name.
    return out.sort((a, b) => verifiedRank(a.verified) - verifiedRank(b.verified) || a.name.localeCompare(b.name));
  }
}
