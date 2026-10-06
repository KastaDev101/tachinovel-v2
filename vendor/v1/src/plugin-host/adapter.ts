/**
 * SourceAdapter: a normalized, domain-typed view of a loaded plugin.
 *   - all URLs absolute (covers, icon, customCSS); LNReader's placeholder cover → no cover
 *   - NovelStatus → domain status, genres split, summary → plain text
 *   - chapters → ChapterMeta; page plugins (totalPages + parsePage) flattened, ≤ 3 pages in flight
 *   - filters passed to popularNovels as LNReader's { key: { value, type } }
 *   - every failure surfaces as a SourceError with the most specific code we can infer
 */
import type { ChapterMeta, NovelDetails, NovelSummary } from '../shared/contracts/domain.ts';
import { SourceError } from '../shared/contracts/plugin-host.ts';
import type { SourceAdapter, SourceMeta } from '../shared/contracts/plugin-host.ts';
import type { Filters } from '../shared/lnreader/filters.ts';
import type { Plugin } from '../shared/lnreader/plugin.ts';
import type { CallRecord, PluginContext } from './context.ts';
import { BROWSE_ENRICHERS } from './enrich.ts';
import { failureReason, looksLikeBotCheck, looksLikeLayoutChange, statusReason, withReason } from './failure.ts';
import { isUrlAbsolute } from './libs/isAbsoluteUrl.ts';
import type { LoadedPlugin } from './loader.ts';
import { cleanPerson, cleanSummary, cleanText, coverUrl, fixChapterHtml, joinSitePath, mapStatus, splitGenres, staticAssetUrl, toChapterMetas } from './normalize.ts';
import { normalizeSettings, type PluginSettings } from './settings.ts';

/** Extra facts about a loaded plugin that are not part of the SourceAdapter contract. */
export interface PluginInfo {
  hasParsePage: boolean;
  hasResolveUrl: boolean;
  hasImageRequestInit: boolean;
  imageRequestInit?: Plugin.ImageRequestInit;
  webStorageUtilized: boolean;
  hasPluginSettings: boolean;
  /** The plugin's settings schema (LNReader `pluginSettings`, normalized), if it declares any. */
  settings?: PluginSettings;
  /** Declared settings left out because they sign in to the site (see settings.ts). */
  loginSettings?: string[];
}

const infos = new WeakMap<SourceAdapter, PluginInfo>();
/** Adapters that stand for another one (the reloadable source from host.load → its current adapter). */
const aliases = new WeakMap<SourceAdapter, () => SourceAdapter>();

export function pluginInfo(adapter: SourceAdapter): PluginInfo | undefined {
  const target = aliases.get(adapter);
  return infos.get(target ? target() : adapter);
}

/** Makes pluginInfo(outer) report the facts of whatever adapter `current()` returns. */
export function aliasPluginInfo(outer: SourceAdapter, current: () => SourceAdapter): void {
  aliases.set(outer, current);
}

/**
 * Pages fetched at once when flattening page plugins. Page plugins often pause between their own
 * requests (lnmtl sleeps 1 s), so this is higher than the per-host request cap (3, net.ts), which
 * still bounds what reaches the site.
 */
const PAGE_CONCURRENCY = 6;

/** Strings identifying a novel/chapter call's requests: the path and its last segment. */
export function pathHints(path: string): string[] {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return [...new Set([trimmed, last].filter((h) => h.length >= 3))];
}

/** Strings identifying a search call's requests: the query as plugins usually encode it. */
export function queryHints(query: string): string[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const enc = encodeURIComponent(q);
  return [...new Set([q, enc, q.replace(/ /g, '+'), enc.replace(/%20/g, '+')])];
}
const MAX_PAGES = 1000;

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ends infinite scroll for plugins that ignore the page number: when page N of a list returns nothing
 * but the novels of page N−1 of the same list, the list is over (returns []). Only the previous page
 * of each list is remembered.
 */
export class PageTracker {
  readonly #last = new Map<string, { page: number; paths: Set<string> }>();

  next(key: string, page: number, items: NovelSummary[]): NovelSummary[] {
    const prev = this.#last.get(key);
    const repeated = prev !== undefined && page === prev.page + 1 && items.length > 0 && items.every((i) => prev.paths.has(i.path));
    if (this.#last.size > 50 && !prev) this.#last.clear();
    this.#last.set(key, { page, paths: new Set(items.map((i) => i.path)) });
    return repeated ? [] : items;
  }
}

/**
 * Builds the filters argument of popularNovels: LNReader's `{ key: { value, type } }`, carrying the rest
 * of each definition (label, options) too, exactly like the LNReader app, which starts from the
 * plugin's `filters` object itself.
 */
export function filterValues(defs: Filters | undefined, input: Record<string, unknown> | undefined): Record<string, { value: unknown; type: string }> | undefined {
  if (!defs || typeof defs !== 'object') return undefined;
  const out: Record<string, { value: unknown; type: string }> = {};
  for (const [key, def] of Object.entries(defs)) {
    if (!def || typeof def !== 'object') continue;
    let value: unknown = def.value;
    const given = input?.[key];
    if (given !== undefined) {
      value = typeof given === 'object' && given !== null && 'value' in given && 'type' in given ? (given as { value: unknown }).value : given;
    }
    // As the LNReader app does: the plugin's own filter definition (label, options, …) with the value.
    out[key] = { ...clone(def), value: clone(value), type: def.type };
  }
  return out;
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed: { err: unknown } | undefined;
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        failed ??= { err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failed.err;
  return results;
}

export function createAdapter(plugin: LoadedPlugin, ctx: PluginContext): SourceAdapter {
  const site = plugin.site;
  const lockedPaths = new Set<string>();

  const meta: SourceMeta = {
    id: plugin.id,
    name: plugin.name,
    site,
    version: plugin.version,
    hasCustomJS: typeof plugin.customJS === 'string' && plugin.customJS.trim() !== '',
  };
  const iconUrl = staticAssetUrl(plugin.icon);
  if (iconUrl) meta.iconUrl = iconUrl;
  if (typeof plugin.lang === 'string' && plugin.lang) meta.lang = plugin.lang;
  if (plugin.filters && typeof plugin.filters === 'object' && Object.keys(plugin.filters).length) meta.filters = clone(plugin.filters);
  const customCSS = staticAssetUrl(plugin.customCSS);
  if (customCSS) meta.customCSS = customCSS;
  const loginSettings: string[] = [];
  const settings = normalizeSettings(plugin.pluginSettings, loginSettings);
  if (settings) meta.settings = settings;

  /** Maps any error from a plugin call to a SourceError, using what the network did for that call. */
  function mapError(err: unknown, rec: CallRecord, what: string): SourceError {
    if (err instanceof SourceError) return err;
    const code = (err as { code?: unknown })?.code;
    if (code === 'LOCKED') return new SourceError('LOCKED', errorMessage(err));
    const parked = parkedError(rec);
    if (parked) return parked;
    if (rec.failure) return copyFailure(rec.failure);
    const status = rec.lastStatus;
    if (status === 404 || status === 410) return withReason(new SourceError('NOT_FOUND', `${plugin.name}: ${what}: not found (HTTP ${status})`), 'not-found');
    // No page loaded: the status explains it. Pages loaded: the plugin could not read them.
    const reason = !rec.ok ? statusReason(status) : undefined;
    if (!reason && rec.movedTo) {
      // Templates report a cross-site redirect as "Captcha error"; the site moved or was replaced.
      return withReason(new SourceError('PLUGIN', `${plugin.name}: the site now redirects to ${rec.movedTo}; the plugin needs an update (${errorMessage(err)})`), 'layout-changed');
    }
    const fallback = looksLikeBotCheck(err) ? 'bot-check' : rec.ok && looksLikeLayoutChange(err) ? 'layout-changed' : undefined;
    return withReason(new SourceError('PLUGIN', `${plugin.name}: ${what} failed: ${errorMessage(err)}`), reason ?? fallback);
  }

  function copyFailure(f: SourceError): SourceError {
    return withReason(new SourceError(f.code, f.message), failureReason(f));
  }

  function parkedError(rec: CallRecord): SourceError | undefined {
    if (!rec.parked) return undefined;
    return withReason(new SourceError('PLUGIN', `${plugin.name}: ${rec.parked} shows a parked or for-sale domain page; the site is gone`), 'parked');
  }

  /**
   * For results that came back empty: if this call's requests failed and none of them succeeded,
   * the failure is the real answer (plugins often swallow errors and return []). The same for a
   * parking page, or when every response was an error status that explains itself (5xx, 429, 403, 401).
   */
  function failIfNetworkFailed(rec: CallRecord): void {
    const parked = parkedError(rec);
    if (parked) throw parked;
    if (rec.ok) return;
    if (rec.failure) throw copyFailure(rec.failure);
    const status = rec.lastStatus;
    const reason = statusReason(status);
    if (status === undefined || !reason || reason === 'not-found') return;
    const host = hostOfSite();
    const text =
      reason === 'site-down'
        ? `${host} is down (HTTP ${status})`
        : reason === 'rate-limited'
          ? `${host} is limiting requests (HTTP 429); try again later`
          : reason === 'needs-account'
            ? `${host} requires signing in (HTTP 401)`
            : `${host} refused the request (HTTP ${status})`;
    throw withReason(new SourceError(reason === 'needs-account' ? 'PLUGIN' : 'NETWORK', `${plugin.name}: ${text}`), reason);
  }

  function hostOfSite(): string {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(site);
    return m?.[1] ?? site;
  }

  /** Runs one plugin method as a tracked call (see context.ts CallRecord). */
  async function call<T>(
    what: string,
    hints: readonly string[],
    fn: () => T | Promise<T>,
    capture?: (url: string) => boolean,
  ): Promise<{ value: T; rec: CallRecord }> {
    const { record, end } = ctx.beginCall(what, hints, capture);
    try {
      return { value: await fn(), rec: record };
    } catch (err) {
      throw mapError(err, record, what);
    } finally {
      end();
    }
  }

  const enricher = Object.prototype.hasOwnProperty.call(BROWSE_ENRICHERS, plugin.id) ? BROWSE_ENRICHERS[plugin.id] : undefined;

  /** Host-side extras for pinned published plugins (enrich.ts); never fails the call. */
  function enrich(items: NovelSummary[], rec: CallRecord): void {
    if (!enricher || !rec.captured?.length || !items.length) return;
    try {
      enricher.enrich(items, rec.captured);
    } catch (err) {
      ctx.log('warn', `[${plugin.id}] browse enrichment failed: ${errorMessage(err)}`);
    }
  }

  function toSummaries(items: unknown, what: string): NovelSummary[] {
    if (!Array.isArray(items)) throw new SourceError('PLUGIN', `${plugin.name}: ${what} did not return a list`);
    const seen = new Set<string>();
    const out: NovelSummary[] = [];
    for (const raw of items as Partial<Plugin.NovelItem>[]) {
      if (!raw || typeof raw !== 'object') continue;
      const path = typeof raw.path === 'string' ? raw.path : typeof raw.path === 'number' ? String(raw.path) : '';
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const item: NovelSummary = { pluginId: plugin.id, path, name: cleanText(raw.name) || path };
      const cover = coverUrl(raw.cover, site);
      if (cover) item.cover = cover;
      const count = raw.chapterCount;
      if (typeof count === 'number' && Number.isFinite(count) && count >= 0) item.chapterCount = Math.floor(count);
      out.push(item);
    }
    return out;
  }

  async function chaptersOf(path: string, src: Plugin.SourceNovel & { totalPages?: unknown }): Promise<unknown[]> {
    const first = Array.isArray(src.chapters) ? (src.chapters as unknown[]) : [];
    const total = typeof src.totalPages === 'number' && Number.isFinite(src.totalPages) ? Math.floor(src.totalPages) : 0;
    const parsePage = plugin.parsePage;
    if (typeof parsePage !== 'function' || total < 1) return first;
    if (total > MAX_PAGES) ctx.log('warn', `[${plugin.id}] ${path}: ${total} pages; only the first ${MAX_PAGES} are fetched`);
    const startPage = first.length ? 2 : 1;
    const pages: number[] = [];
    for (let p = startPage; p <= Math.min(total, MAX_PAGES); p++) pages.push(p);
    const lists = await mapLimit(pages, PAGE_CONCURRENCY, async (p) => {
      const { value } = await call(`parsePage(${p})`, pathHints(path), () => parsePage.call(plugin, path, String(p)));
      return value && Array.isArray(value.chapters) ? value.chapters : [];
    });
    return first.concat(...lists);
  }

  const pages = new PageTracker();

  const adapter: SourceAdapter = {
    meta,

    async popular(page, opts) {
      const filters = filterValues(plugin.filters, opts.filters);
      const options = { showLatestNovels: opts.latest, filters } as Plugin.PopularNovelsOptions<Filters>;
      const { value, rec } = await call('popularNovels', [], () => plugin.popularNovels(page, options), enricher?.capture);
      const items = toSummaries(value, 'popularNovels');
      if (items.length === 0) failIfNetworkFailed(rec);
      enrich(items, rec);
      return pages.next(`popular|${String(opts.latest)}|${JSON.stringify(filters ?? null)}`, page, items);
    },

    async search(rawQuery, page) {
      // Typed/pasted queries often carry stray whitespace that sites match literally.
      const query = rawQuery.replace(/\s+/g, ' ').trim();
      const { value, rec } = await call('searchNovels', queryHints(query), () => plugin.searchNovels(query, page), enricher?.capture);
      const items = toSummaries(value, 'searchNovels');
      if (items.length === 0) failIfNetworkFailed(rec);
      enrich(items, rec);
      return pages.next(`search|${query}`, page, items);
    },

    async novel(path) {
      const release = ctx.shareGets();
      try {
        return await loadNovel(path);
      } finally {
        release();
      }
    },

    async chapter(path) {
      return loadChapter(path);
    },

    resolveUrl(path, isNovel) {
      return resolve(path, isNovel);
    },
  };

  async function loadNovel(path: string): Promise<{ details: NovelDetails; chapters: ChapterMeta[] }> {
    const { value: src, rec } = await call('parseNovel', pathHints(path), () => plugin.parseNovel(path));
    if (!src || typeof src !== 'object') throw new SourceError('PLUGIN', `${plugin.name}: parseNovel did not return an object`);
    const rawChapters = await chaptersOf(path, src);
    const name = cleanText(src.name);
    const chapters: ChapterMeta[] = toChapterMetas(rawChapters, name);
    if (!name && chapters.length === 0) {
      failIfNetworkFailed(rec);
      const status = rec.lastStatus;
      throw withReason(new SourceError('NOT_FOUND', `${plugin.name}: novel not found: ${path}${status ? ` (HTTP ${status})` : ''}`), status === 404 || status === 410 ? 'not-found' : undefined);
    }
    const details: NovelDetails = { pluginId: plugin.id, path, name: name || path, status: mapStatus(src.status), genres: splitGenres(src.genres) };
    const cover = coverUrl(src.cover, site);
    if (cover) details.cover = cover;
    const author = cleanPerson(src.author);
    if (author) details.author = author;
    const artist = cleanPerson(src.artist);
    if (artist) details.artist = artist;
    const summary = cleanSummary(src.summary);
    if (summary) details.summary = summary;
    const rating = typeof src.rating === 'number' ? src.rating : typeof src.rating === 'string' ? parseFloat(src.rating) : NaN;
    if (Number.isFinite(rating) && rating > 0) details.rating = Math.min(5, Math.max(0, rating));
    details.url = resolve(path, true);

    for (const c of chapters) {
      if (c.locked) lockedPaths.add(c.path);
      else lockedPaths.delete(c.path);
    }
    return { details, chapters };
  }

  async function loadChapter(path: string): Promise<string> {
    if (lockedPaths.has(path)) throw new SourceError('LOCKED', `${plugin.name}: chapter is locked: ${path}`);
    const { value, rec } = await call('parseChapter', pathHints(path), () => plugin.parseChapter(path));
    if (typeof value !== 'string') throw new SourceError('PLUGIN', `${plugin.name}: parseChapter did not return HTML`);
    if (value.trim() === '') {
      failIfNetworkFailed(rec);
      const status = rec.lastStatus;
      if (status === 404 || status === 410) throw withReason(new SourceError('NOT_FOUND', `${plugin.name}: chapter not found: ${path}`), 'not-found');
      throw new SourceError('PLUGIN', `${plugin.name}: chapter is empty: ${path}`);
    }
    let base = site;
    try {
      const u = resolve(path, false);
      if (/^https?:\/\//i.test(u)) base = u;
    } catch {
      // keep the site as base
    }
    return fixChapterHtml(value, base);
  }

  function resolve(path: string, isNovel: boolean): string {
    if (isUrlAbsolute(path)) return path.startsWith('//') ? 'https:' + path : path;
    if (typeof plugin.resolveUrl === 'function') {
      try {
        const r = plugin.resolveUrl(path, isNovel);
        if (typeof r === 'string' && r) return r;
      } catch (err) {
        ctx.log('warn', `[${plugin.id}] resolveUrl threw: ${errorMessage(err)}`);
      }
    }
    return joinSitePath(site, path);
  }

  const init = plugin.imageRequestInit;
  const info: PluginInfo = {
    hasParsePage: typeof plugin.parsePage === 'function',
    hasResolveUrl: typeof plugin.resolveUrl === 'function',
    hasImageRequestInit: Boolean(init && typeof init === 'object'),
    webStorageUtilized: plugin.webStorageUtilized === true,
    hasPluginSettings: settings !== undefined,
  };
  if (settings) info.settings = clone(settings);
  if (loginSettings.length) info.loginSettings = loginSettings;
  if (init && typeof init === 'object') info.imageRequestInit = clone(init);
  infos.set(adapter, info);
  return adapter;
}
