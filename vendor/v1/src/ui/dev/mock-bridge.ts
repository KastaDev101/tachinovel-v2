/**
 * Mock BridgeClient for the dev server and e2e tests. Implements every BridgeMethods entry against an
 * in-memory fixture world, with configurable latency, random failures and an offline switch
 * (window.__tachiMock) so loading, error and offline states can be exercised.
 */
import type {
  ChapterMeta,
  ChapterView,
  HistoryEntry,
  LibraryEntry,
  NovelDetails,
  NovelSummary,
  ReadingStats,
  SourceInfo,
} from '../../shared/contracts/domain.ts';
import {
  BridgeCallError,
  type BridgeClient,
  type BackupInfo,
  type BridgeEvents,
  type BrowseItem,
  type BrowsePage,
  type CallOptions,
  type ErrorCode,
  type EventName,
  type MethodHandlers,
  type MethodName,
} from '../../shared/contracts/protocol.ts';
import { sameGenre } from '../lib/genre-match.ts';
import { deepMerge } from '../lib/merge.ts';
import { sourceIcon, pickHue } from './art.ts';
import {
  chapterHtml,
  chapterMeta,
  chapterNumberFromPath,
  chapterPath,
  createWorld,
  keyOf,
  localDayKey,
  PROXIED_COVERS,
  type FixtureNovel,
  type NovelState,
} from './fixtures.ts';
import type { Filters } from '../../shared/lnreader/filters.ts';
import type { DevFlags, MockCall, MockControls } from './flags.ts';
import { presentMockSheet } from './mock-sheet.ts';
import { chapterTitle } from './text-gen.ts';

const PAGE = 20;

/** Royal Road-like filter definitions (LNReader Filters shape): genres plus excludable tags. */
const RR_FILTERS: Filters = {
  orderBy: {
    type: 'Picker',
    label: 'Order by',
    value: 'popular',
    options: [
      { label: 'Popular this week', value: 'popular' },
      { label: 'Best rated', value: 'rating' },
      { label: 'Most followers', value: 'followers' },
      { label: 'Last update', value: 'updated' },
    ],
  },
  completed: { type: 'Switch', label: 'Completed only', value: false },
  genres: {
    type: 'Checkbox',
    label: 'Genres',
    value: [],
    options: [
      { label: 'Action', value: 'action' },
      { label: 'Adventure', value: 'adventure' },
      { label: 'Comedy', value: 'comedy' },
      { label: 'Drama', value: 'drama' },
      { label: 'Fantasy', value: 'fantasy' },
      { label: 'Horror', value: 'horror' },
      { label: 'Mystery', value: 'mystery' },
      { label: 'Psychological', value: 'psychological' },
      { label: 'Romance', value: 'romance' },
      { label: 'Sci-fi', value: 'sci_fi' },
      { label: 'Tragedy', value: 'tragedy' },
    ],
  },
  tags: {
    type: 'XCheckbox',
    label: 'Tags',
    value: {},
    options: [
      { label: 'LitRPG', value: 'litrpg' },
      { label: 'Magic', value: 'magic' },
      { label: 'Martial Arts', value: 'martial_arts' },
      { label: 'Portal Fantasy / Isekai', value: 'summoned_hero' },
      { label: 'Progression', value: 'progression' },
      { label: 'Romance', value: 'romance' },
      { label: 'Slice of Life', value: 'slice_of_life' },
      { label: 'Time loop', value: 'loop' },
    ],
  },
  author: { type: 'Text', label: 'Author', value: '' },
};

/** Stonescape-like: sort + status pickers and one Checkbox group of genre slugs. */
const STONESCAPE_LIKE_FILTERS: Filters = {
  sort: {
    type: 'Picker',
    label: 'Sort by',
    value: 'popular_month',
    options: [
      { label: 'Popular (month)', value: 'popular_month' },
      { label: 'Popular (year)', value: 'popular_year' },
      { label: 'Latest update', value: 'latest' },
      { label: 'Title A–Z', value: 'title' },
    ],
  },
  status: {
    type: 'Picker',
    label: 'Status',
    value: '',
    options: [
      { label: 'Any', value: '' },
      { label: 'Ongoing', value: 'ongoing' },
      { label: 'Completed', value: 'completed' },
      { label: 'Hiatus', value: 'hiatus' },
    ],
  },
  genres: {
    type: 'Checkbox',
    label: 'Genres (all of)',
    value: [],
    options: [
      { label: 'Action', value: 'action' },
      { label: 'Adventure', value: 'adventure' },
      { label: 'Comedy', value: 'comedy' },
      { label: 'Drama', value: 'drama' },
      { label: 'Fantasy', value: 'fantasy' },
      { label: 'Harem', value: 'harem' },
      { label: 'Horror', value: 'horror' },
      { label: 'Martial Arts', value: 'martialarts' },
      { label: 'Mystery', value: 'mystery' },
      { label: 'Psychological', value: 'psychological' },
      { label: 'Romance', value: 'romance' },
      { label: 'School Life', value: 'schoollife' },
      { label: 'Sci-Fi', value: 'sci-fi' },
      { label: 'Slice of Life', value: 'sliceoflife' },
      { label: 'Tragedy', value: 'tragedy' },
    ],
  },
};

/** Madara-like: a single genre Picker with an "All" option. */
const PICKER_FILTERS: Filters = {
  genre: {
    type: 'Picker',
    label: 'Genre',
    value: '',
    options: [
      { label: 'All', value: '' },
      { label: 'Action', value: 'action' },
      { label: 'Adventure', value: 'adventure' },
      { label: 'Comedy', value: 'comedy' },
      { label: 'Drama', value: 'drama' },
      { label: 'Fantasy', value: 'fantasy' },
      { label: 'Harem', value: 'harem' },
      { label: 'Martial Arts', value: 'martial-arts' },
      { label: 'Mystery', value: 'mystery' },
      { label: 'Romance', value: 'romance' },
      { label: 'Sci-fi', value: 'sci-fi' },
      { label: 'Xianxia', value: 'xianxia' },
    ],
  },
  order: {
    type: 'Picker',
    label: 'Order by',
    value: 'views',
    options: [
      { label: 'Most viewed', value: 'views' },
      { label: 'Latest', value: 'latest' },
    ],
  },
};

/** Filter definitions per mock source (sources without `hasFilters` have none, like Stonescape here). */
const SOURCE_FILTERS: Record<string, Filters> = {
  royalroad: RR_FILTERS,
  scribblehub: STONESCAPE_LIKE_FILTERS,
  novelbin: PICKER_FILTERS,
};

const GENRE_FILTER = /genre|tag|categor/i;

/**
 * Genre/tag selections in a `browse.list` filters map, as option labels: novels must have every
 * included genre and none of the excluded ones (like the sites do).
 */
function genreSelection(defs: Filters | undefined, values: Record<string, { value: unknown }>): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  if (!defs) return { include, exclude };
  for (const [key, v] of Object.entries(values)) {
    const def = defs[key];
    if (!def || !(GENRE_FILTER.test(key) || GENRE_FILTER.test(def.label))) continue;
    if (def.type !== 'Checkbox' && def.type !== 'XCheckbox' && def.type !== 'Picker') continue;
    const options = def.options;
    const label = (value: string): string => options.find((o) => o.value === value)?.label ?? value;
    if (def.type === 'Checkbox' && Array.isArray(v.value)) include.push(...(v.value as string[]).map(label));
    else if (def.type === 'Picker' && typeof v.value === 'string' && v.value !== '') include.push(label(v.value));
    else if (def.type === 'XCheckbox' && v.value && typeof v.value === 'object') {
      const x = v.value as { include?: string[]; exclude?: string[] };
      include.push(...(x.include ?? []).map(label));
      exclude.push(...(x.exclude ?? []).map(label));
    }
  }
  return { include, exclude };
}

/** Plugin customCSS with hostile bits mixed in (only the safe, scoped declarations survive). */
const PLUGIN_CSS = `@import url(https://evil.example/x.css);
img { border-radius: 12px; position: fixed; }
blockquote { border-left-color: #c0392b; background: url(https://evil.example/a.png); }
body { display: none; }
p::before { content: 'INJECTED'; }
.ad { position: fixed; z-index: 9999; }
td { padding: 4px 10px; }`;

const NETWORK_METHODS = new Set<MethodName>([
  'browse.list',
  'browse.search',
  'browse.globalSearch',
  'chapter.get',
  'sources.available',
  'sources.install',
  'sources.update',
  'repos.add',
  'library.checkUpdates',
  'sources.solveChallenge',
  'migrate.preview',
  'cleanup.test',
]);

/** Sources whose browse listings include chapter counts (the others leave them out). */
const SOURCES_WITH_COUNTS = new Set(['stonescape', 'royalroad', 'novelbin']);

function fail(code: ErrorCode, message: string, retryable = false): never {
  throw new BridgeCallError({ code, message, retryable });
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

export function createMockBridge(flags: DevFlags): BridgeClient {
  const world = createWorld(flags.seed ?? 7, flags.now ?? Date.now(), flags.empty ?? false);
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const calls: MockCall[] = [];
  const sheetAnswers: number[] = [];
  let offline = flags.offline ?? false;
  let latency: number | [number, number] = flags.latency ?? [80, 260];
  let failRate = flags.failRate ?? 0;
  let brightness = 0.6;
  const backups: BackupInfo[] = [
    { fileName: 'tachinovel-2026-10-01-2214.json', createdAt: world.now - 4 * 86_400_000 + 3_600_000 * 11.7, bytes: 61_440 },
    { fileName: 'tachinovel-2026-09-12-0930.json', createdAt: world.now - 23 * 86_400_000, bytes: 52_224 },
  ];
  let libraryChangedTimer = 0;
  /** Sources whose Cloudflare check was passed (sources.solveChallenge). */
  const solved = new Set<string>();
  /** The script's log (app.log / app.logs), oldest first, with a few problems from earlier sessions. */
  const logLines: { at: number; level: string; message: string }[] = flags.empty
    ? []
    : [
        { at: world.now - 26 * 3_600_000, level: 'warn', message: 'Royal Road: page 3 took 9.8 s (slow network)' },
        { at: world.now - 7 * 3_600_000, level: 'error', message: 'Scribble Hub: blocked by a Cloudflare check (HTTP 403)' },
        { at: world.now - 3 * 3_600_000, level: 'info', message: 'Library update: 2 new chapters' },
        { at: world.now - 40 * 60_000, level: 'warn', message: 'covers.fetch: 404 for /pub/covers/the-forgotten-tower.webp' },
      ];

  const controls: MockControls = {
    setOffline: (v) => {
      offline = v;
    },
    setLatency: (v) => {
      latency = v;
    },
    setFailRate: (v) => {
      failRate = v;
    },
    get flags() {
      return { ...flags, offline, latency, failRate };
    },
    calls,
    queueSheetAnswer: (i) => {
      sheetAnswers.push(i);
    },
  };
  window.__tachiMock = controls;

  const now = (): number => Date.now();

  function emit<E extends EventName>(event: E, payload: BridgeEvents[E]): void {
    window.setTimeout(() => {
      const set = listeners.get(event);
      if (set) for (const fn of set) fn(payload);
    }, 0);
  }

  function novel(pluginId: string, path: string): FixtureNovel {
    const n = world.novels.get(keyOf(pluginId, path));
    if (!n) fail('NOT_FOUND', `Novel not found: ${pluginId}:${path}`);
    return n;
  }

  function state(n: FixtureNovel): NovelState {
    const k = keyOf(n.pluginId, n.path);
    let st = world.states.get(k);
    if (!st) {
      st = { read: new Uint8Array(n.chapterCount), bookmarked: new Set(), downloaded: new Set() };
      world.states.set(k, st);
    }
    if (st.read.length < n.chapterCount) {
      const grown = new Uint8Array(n.chapterCount);
      grown.set(st.read);
      st.read = grown;
    }
    return st;
  }

  // Chapter metadata is generated once per novel (the real script reads it from stored meta files).
  const metaCache = new Map<string, ChapterMeta[]>();
  function metaList(n: FixtureNovel): ChapterMeta[] {
    const k = keyOf(n.pluginId, n.path);
    let list = metaCache.get(k);
    if (!list || list.length !== n.chapterCount) {
      list = Array.from({ length: n.chapterCount }, (_, i) => chapterMeta(n, i + 1));
      metaCache.set(k, list);
    }
    return list;
  }

  function unreadCount(n: FixtureNovel): number {
    const st = state(n);
    const last = n.lockedFrom !== undefined ? Math.min(n.chapterCount, n.lockedFrom - 1) : n.chapterCount;
    let c = 0;
    for (let i = 0; i < last; i++) if (st.read[i] !== 1) c++;
    return c;
  }

  function entry(key: string): LibraryEntry | null {
    const rec = world.library.get(key);
    const n = world.novels.get(key);
    if (!rec || !n) return null;
    const lastChapter = rec.lastChapter;
    return {
      key,
      pluginId: n.pluginId,
      path: n.path,
      name: n.name,
      ...(n.cover !== undefined ? { cover: n.cover } : {}),
      status: n.status,
      author: n.author,
      addedAt: rec.addedAt,
      ...(rec.lastReadAt !== undefined ? { lastReadAt: rec.lastReadAt } : {}),
      ...(rec.lastUpdatedAt !== undefined ? { lastUpdatedAt: rec.lastUpdatedAt } : {}),
      chapterCount: n.chapterCount,
      unreadCount: unreadCount(n),
      downloadedCount: state(n).downloaded.size,
      categoryIds: [...rec.categoryIds],
      ...(lastChapter !== undefined ? { lastChapterPath: chapterPath(n, lastChapter), lastChapterName: chapterTitle(n.seed, lastChapter) } : {}),
    };
  }

  function libraryList(): LibraryEntry[] {
    const out: LibraryEntry[] = [];
    for (const k of world.library.keys()) {
      const e = entry(k);
      if (e) out.push(e);
    }
    return out;
  }

  function libraryChanged(): void {
    window.clearTimeout(libraryChangedTimer);
    libraryChangedTimer = window.setTimeout(() => emit('library.changed', { library: libraryList() }), 150);
  }

  function browseItem(k: string): BrowseItem | null {
    const n = world.novels.get(k);
    if (!n) return null;
    return {
      pluginId: n.pluginId,
      path: n.path,
      name: n.name,
      ...(n.cover !== undefined ? { cover: n.cover } : {}),
      // Like real plugins: some listings carry the chapter count, others don't.
      ...(SOURCES_WITH_COUNTS.has(n.pluginId) ? { chapterCount: n.chapterCount } : {}),
      inLibrary: world.library.has(k),
    };
  }

  function page(keys: string[], p: number): BrowsePage {
    const slice = keys.slice((p - 1) * PAGE, p * PAGE);
    return { items: slice.map(browseItem).filter((x): x is BrowseItem => x !== null), hasMore: p * PAGE < keys.length };
  }

  function details(n: FixtureNovel): NovelDetails {
    return {
      pluginId: n.pluginId,
      path: n.path,
      name: n.name,
      ...(n.cover !== undefined ? { cover: n.cover } : {}),
      author: n.author,
      status: n.status,
      summary: n.summary,
      genres: n.genres,
      rating: n.rating,
      url: n.url,
    };
  }

  const lastSaveAt = new Map<string, number>();
  function upsertHistory(n: FixtureNovel, cp: string, percent: number): void {
    const num = chapterNumberFromPath(cp);
    const k = keyOf(n.pluginId, n.path);
    const prev = world.history.find((h) => h.pluginId === n.pluginId && h.path === n.path);
    // Reading time: sum of gaps between saves that are under a minute (like the script).
    const last = lastSaveAt.get(k);
    const gap = last !== undefined ? now() - last : 0;
    lastSaveAt.set(k, now());
    const readingMs = (prev?.readingMs ?? 0) + (gap > 0 && gap < 60_000 ? gap : 0);
    world.history = world.history.filter((h) => !(h.pluginId === n.pluginId && h.path === n.path));
    const h: HistoryEntry = {
      pluginId: n.pluginId,
      path: n.path,
      novelName: n.name,
      ...(n.cover !== undefined ? { cover: n.cover } : {}),
      chapterPath: cp,
      chapterName: chapterTitle(n.seed, num),
      readAt: now(),
      percent,
      ...(readingMs > 0 ? { readingMs } : {}),
    };
    world.history.unshift(h);
  }

  function findSource(id: string): SourceInfo {
    const s = world.sources.find((x) => x.id === id);
    if (!s) fail('NOT_FOUND', `Unknown source ${id}`);
    return s;
  }

  async function runUpdateCheck(keys: string[]): Promise<{ newChapters: number }> {
    let total = 0;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] ?? '';
      const n = world.novels.get(k);
      await sleep(140);
      if (n && n.status !== 'completed' && n.lockedFrom === undefined && i % 4 === 1) {
        const added = 1 + (i % 3);
        n.chapterCount += added;
        state(n);
        total += added;
        const rec = world.library.get(k);
        if (rec) rec.lastUpdatedAt = now();
        for (let c = 0; c < added; c++) {
          const num = n.chapterCount - c;
          world.updates.unshift({
            pluginId: n.pluginId,
            path: n.path,
            novelName: n.name,
            ...(n.cover !== undefined ? { cover: n.cover } : {}),
            chapterPath: chapterPath(n, num),
            chapterName: chapterTitle(n.seed, num),
            foundAt: now(),
            read: false,
          });
        }
      }
      emit('updates.progress', { done: i + 1, total: keys.length, ...(n ? { current: n.name } : {}), newChapters: total, finished: false });
    }
    emit('updates.progress', { done: keys.length, total: keys.length, newChapters: total, finished: true });
    libraryChanged();
    return { newChapters: total };
  }

  function knownCategoryIds(ids: readonly string[]): string[] {
    const known = new Set(world.categories.map((c) => c.id));
    return [...new Set(ids)].filter((id) => known.has(id));
  }

  // ---------- reading stats, migrate, cleanup ----------

  const lastReadingAt = new Map<string, number>();
  /** progress.save gaps under a minute count as reading time today (like the script). */
  function recordReading(k: string, finished: boolean): void {
    const last = lastReadingAt.get(k);
    const t = now();
    lastReadingAt.set(k, t);
    const gap = last !== undefined ? t - last : 0;
    const add = gap > 0 && gap < 60_000 ? gap : 0;
    if (add === 0 && !finished) return;
    const day = localDayKey(t);
    const d = world.reading.get(day) ?? { ms: 0, chapters: 0, byNovel: new Map<string, number>() };
    d.ms += add;
    d.byNovel.set(k, (d.byNovel.get(k) ?? 0) + add);
    if (finished) d.chapters++;
    world.reading.set(day, d);
  }

  function readingStats(count: number): ReadingStats {
    const n = Math.max(1, Math.min(3660, Math.round(count)));
    const base = new Date(now());
    base.setHours(12, 0, 0, 0);
    const days: ReadingStats['days'] = [];
    const byNovel = new Map<string, number>();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(base);
      d.setDate(d.getDate() - i);
      const key = localDayKey(d.getTime());
      const r = world.reading.get(key);
      days.push({ date: key, ms: r?.ms ?? 0, chapters: r?.chapters ?? 0 });
      if (r) for (const [k, ms] of r.byNovel) byNovel.set(k, (byNovel.get(k) ?? 0) + ms);
    }
    // Streak: consecutive reading days ending today (or yesterday, if nothing yet today).
    let streakDays = 0;
    const d = new Date(base);
    if (!(world.reading.get(localDayKey(d.getTime()))?.ms ?? 0)) d.setDate(d.getDate() - 1);
    while ((world.reading.get(localDayKey(d.getTime()))?.ms ?? 0) > 0) {
      streakDays++;
      d.setDate(d.getDate() - 1);
    }
    let totalMs = 0;
    for (const r of world.reading.values()) totalMs += r.ms;
    const topNovels = [...byNovel]
      .filter(([, ms]) => ms > 0)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 10)
      .map(([key, ms]) => {
        const nv = world.novels.get(key);
        return { key, name: nv?.name ?? key, ...(nv?.cover !== undefined ? { cover: nv.cover } : {}), ms };
      });
    return { days, streakDays, totalMs, topNovels };
  }

  /** Chapters of `from` that find a counterpart on `to` (same numbering; a few drop out on long novels). */
  function migrateMatched(from: FixtureNovel, to: FixtureNovel): number {
    const both = Math.min(from.chapterCount, to.chapterCount);
    return Math.max(0, both - (both > 200 ? hashStr(keyOf(to.pluginId, to.path)) % 4 : 0));
  }

  /**
   * The chapter's text blocks before cleanup: the chapter HTML plus the junk sites inject
   * (credits up top, "read at" and Patreon plugs, a "visit … for the latest chapters" footer).
   */
  function rawBlocks(n: FixtureNovel, num: number): string[] {
    const host = (world.sources.find((s) => s.id === n.pluginId)?.site ?? 'https://example.com').replace(/^https?:\/\/(?:www\.)?/, '');
    const paragraphs = (chapterHtml(n, num).match(/<p[^>]*>[\s\S]*?<\/p>/g) ?? [])
      .map((p) => p.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim())
      .filter((t) => t !== '');
    const mid = Math.floor(paragraphs.length / 2);
    return [
      'Translator: Mira · Editor: Kael',
      `Read at ${host} for the fastest updates!`,
      ...paragraphs.slice(0, mid),
      'Support us on Patreon for 10 advance chapters!',
      ...paragraphs.slice(mid),
      `Visit ${host} for the latest chapters.`,
    ];
  }

  const handlers: MethodHandlers = {
    'app.boot': () =>
      Promise.resolve({
        buildVersion: __BUILD_VERSION__,
        settings: structuredClone(world.settings),
        library: libraryList(),
        categories: [...world.categories],
        sources: world.sources.map((s) => ({ ...s })),
        recent: world.history.slice(0, 10),
        symbols: {},
        ...(flags.deepLink ? { deepLink: flags.deepLink } : {}),
      }),
    'app.log': (a) => {
      console.info(`[script log] ${a.level}: ${a.message}`, a.data ?? '');
      logLines.push({ at: now(), level: a.level, message: a.message });
      return Promise.resolve();
    },
    'app.logs': (a) => {
      const levels = a.level === 'error' ? ['error'] : ['warn', 'error'];
      const limit = Math.max(1, Math.min(100, a.limit ?? 20));
      return Promise.resolve(
        logLines
          .filter((l) => levels.includes(l.level))
          .reverse()
          .slice(0, limit)
          .map((l) => ({ ...l })),
      );
    },
    'app.flush': () => Promise.resolve(),
    'settings.set': (a) => {
      world.settings = deepMerge(world.settings, a.patch);
      return Promise.resolve(structuredClone(world.settings));
    },

    'sources.list': () => Promise.resolve(world.sources.map((s) => ({ ...s }))),
    'sources.filters': (a) => Promise.resolve(findSource(a.id).hasFilters ? structuredClone(SOURCE_FILTERS[a.id] ?? RR_FILTERS) : null),
    'sources.setEnabled': (a) => {
      findSource(a.id).enabled = a.enabled;
      return Promise.resolve(world.sources.map((s) => ({ ...s })));
    },
    'sources.setPinned': (a) => {
      findSource(a.id).pinned = a.pinned;
      return Promise.resolve(world.sources.map((s) => ({ ...s })));
    },
    'sources.available': (a) => {
      // Like the script: only the user's languages (installed sources always), known-good plugins first.
      const languages = new Set(world.settings.languages);
      const rank = (v: string | undefined): number => (v === 'works' ? 0 : v === 'partial' ? 1 : v === 'broken' ? 3 : 2);
      return Promise.resolve(
        world.available
          .filter((p) => !a.repoUrl || p.repoUrl === a.repoUrl)
          .map((p) => {
            const s = world.sources.find((x) => x.id === p.id);
            return { ...p, installed: s !== undefined, ...(s ? { installedVersion: s.version } : {}) };
          })
          .filter((p) => p.installed || a.allLanguages === true || languages.has(p.lang))
          .sort((x, y) => rank(x.verified) - rank(y.verified) || x.name.localeCompare(y.name)),
      );
    },
    'sources.install': (a) => {
      let id: string;
      let name: string;
      let version = '1.0.0';
      let site = '';
      let lang = 'English';
      if ('url' in a) {
        if (!/^https:\/\/\S+\.js$/i.test(a.url)) fail('INVALID_ARGS', 'Plugin URL must be an https:// link to a .js file.');
        id = (/([\w.-]+)\.js$/i.exec(a.url)?.[1] ?? 'plugin').toLowerCase();
        const avail = world.available.find((p) => p.id === id || p.url === a.url);
        name = avail?.name ?? id.replace(/[-_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        version = avail?.version ?? version;
        site = avail?.site ?? '';
        lang = avail?.lang ?? lang;
      } else {
        const m = /\bid\s*[:=]\s*['"]([\w.-]+)['"]/.exec(a.code);
        const nm = /\bname\s*[:=]\s*['"]([^'"]+)['"]/.exec(a.code);
        if (!m?.[1] || !/popularNovels/.test(a.code)) fail('PLUGIN', 'This doesn’t look like an LNReader plugin (missing id or popularNovels).');
        id = m[1];
        name = nm?.[1] ?? id;
        version = /\bversion\s*[:=]\s*['"]([\d.]+)['"]/.exec(a.code)?.[1] ?? version;
      }
      const existing = world.sources.find((s) => s.id === id);
      if (existing) {
        existing.version = version;
        return Promise.resolve({ ...existing });
      }
      const s: SourceInfo = {
        id,
        name,
        site: site || `https://${id}.example`,
        version,
        lang,
        iconUrl: sourceIcon(name, pickHue(name)),
        enabled: true,
        pinned: false,
        builtIn: false,
        hasFilters: false,
      };
      world.sources.push(s);
      if (!world.pools.has(id)) world.pools.set(id, []);
      return Promise.resolve({ ...s });
    },
    'sources.uninstall': (a) => {
      const s = findSource(a.id);
      if (s.builtIn) fail('INVALID_ARGS', `${s.name} is built in and can’t be removed.`);
      world.sources = world.sources.filter((x) => x.id !== a.id);
      return Promise.resolve(world.sources.map((x) => ({ ...x })));
    },
    'sources.update': (a) => {
      const s = findSource(a.id);
      if (s.updateAvailable) s.version = s.updateAvailable;
      delete s.updateAvailable;
      return Promise.resolve({ ...s });
    },
    'repos.list': () => Promise.resolve([...world.repos]),
    'repos.add': (a) => {
      if (!/^https:\/\/\S+\.json$/i.test(a.url)) fail('INVALID_ARGS', 'Repository URL must be an https:// link to a .json index.');
      if (!world.repos.some((r) => r.url === a.url)) {
        world.repos.push({ url: a.url, name: new URL(a.url).hostname, pluginCount: 12, fetchedAt: now() });
      }
      return Promise.resolve([...world.repos]);
    },
    'repos.remove': (a) => {
      world.repos = world.repos.filter((r) => r.url !== a.url);
      return Promise.resolve([...world.repos]);
    },

    'browse.list': (a) => {
      findSource(a.pluginId);
      let pool = world.pools.get(a.pluginId) ?? [];
      if (a.filters && Object.keys(a.filters).length > 0) {
        // Filters change the result set deterministically (Completed and genres/tags really filter).
        const f = a.filters as Record<string, { value: unknown }>;
        const seed = hashStr(JSON.stringify(a.filters));
        const genres = genreSelection(SOURCE_FILTERS[a.pluginId], f);
        const has = (k: string, g: string): boolean => (world.novels.get(k)?.genres ?? []).some((x) => sameGenre(x, g));
        pool = pool
          .filter((k) => f['completed']?.value !== true || world.novels.get(k)?.status === 'completed')
          .filter((k) => genres.include.every((g) => has(k, g)) && !genres.exclude.some((g) => has(k, g)))
          .map((k) => ({ k, h: hashStr(k) ^ seed }))
          .sort((x, y) => x.h - y.h)
          .map((x) => x.k);
      }
      const keys = a.mode === 'popular' ? pool : [...pool].sort((x, y) => (world.novels.get(y)?.releaseBase ?? 0) - (world.novels.get(x)?.releaseBase ?? 0));
      return Promise.resolve(page(keys, a.page));
    },
    'browse.search': async (a) => {
      // Sources answer at different speeds (global search streams in); one sits behind a browser check.
      await sleep((hashStr(a.pluginId) % 5) * 90);
      if (a.pluginId === 'scribblehub' && !solved.has(a.pluginId)) fail('CLOUDFLARE', 'Scribble Hub is behind a browser check right now.', true);
      const q = a.query.trim().toLowerCase();
      const matches = (k: string): boolean => (world.novels.get(k)?.name.toLowerCase() ?? '').includes(q);
      // Copies of library novels (Migrate) only turn up for a close title search, never for short queries.
      const mirrors = q.length >= 8 ? (world.mirrors.get(a.pluginId) ?? []).filter(matches) : [];
      const pool = [...mirrors, ...(world.pools.get(a.pluginId) ?? []).filter(matches)];
      return page(pool, a.page);
    },
    'browse.globalSearch': async (a) => {
      const q = a.query.trim().toLowerCase();
      await sleep(250);
      return {
        results: world.sources
          .filter((s) => s.enabled)
          .map((s) => {
            if (s.id === 'scribblehub' && !solved.has(s.id)) {
              return { pluginId: s.id, items: [], error: { code: 'CLOUDFLARE' as const, message: 'Blocked by a browser check', retryable: true } };
            }
            const items = (world.pools.get(s.id) ?? [])
              .filter((k) => (world.novels.get(k)?.name.toLowerCase() ?? '').includes(q))
              .slice(0, 12)
              .map(browseItem)
              .filter((x): x is BrowseItem => x !== null);
            return { pluginId: s.id, items };
          }),
      };
    },

    'novel.get': (a) => {
      const n = novel(a.pluginId, a.path);
      const k = keyOf(n.pluginId, n.path);
      const st = state(n);
      const chapters: ChapterView[] = new Array<ChapterView>(n.chapterCount);
      const metas = metaList(n);
      for (let i = 0; i < n.chapterCount; i++) {
        const meta = metas[i] ?? chapterMeta(n, i + 1);
        const pos = st.read[i] === 1 ? undefined : world.positions.get(`${k}|${meta.path}`);
        chapters[i] = {
          ...meta,
          read: st.read[i] === 1,
          bookmarked: st.bookmarked.has(i),
          downloaded: st.downloaded.has(i),
          ...(pos ? { progress: pos.percent } : {}),
        };
      }
      const rec = world.library.get(k);
      const h = world.history.find((x) => x.pluginId === n.pluginId && x.path === n.path);
      const lastPath = h?.chapterPath ?? (rec?.lastChapter !== undefined ? chapterPath(n, rec.lastChapter) : undefined);
      const lastPos = lastPath !== undefined ? world.positions.get(`${k}|${lastPath}`) : undefined;
      return Promise.resolve({
        details: details(n),
        chapters,
        inLibrary: rec !== undefined,
        categoryIds: rec ? [...rec.categoryIds] : [],
        ...(lastPath !== undefined ? { lastRead: { chapterPath: lastPath, ...(lastPos ? { position: lastPos } : {}) } } : {}),
        fetchedAt: now(),
        fromCache: rec !== undefined && !a.refresh,
      });
    },
    'chapter.get': (a) => {
      const n = novel(a.pluginId, a.novelPath);
      const num = chapterNumberFromPath(a.chapterPath);
      if (!Number.isInteger(num) || num < 1 || num > n.chapterCount) fail('NOT_FOUND', 'Chapter not found');
      const meta = chapterMeta(n, num);
      if (meta.locked) fail('LOCKED', 'This chapter is locked on the source site.');
      const pos = world.positions.get(`${keyOf(n.pluginId, n.path)}|${a.chapterPath}`);
      return Promise.resolve({
        pluginId: n.pluginId,
        novelPath: n.path,
        chapterPath: a.chapterPath,
        title: meta.name,
        html: chapterHtml(n, num),
        ...(num > 1 ? { prev: chapterMeta(n, num - 1) } : {}),
        ...(num < n.chapterCount ? { next: chapterMeta(n, num + 1) } : {}),
        ...(pos ? { position: pos } : {}),
        ...(n.pluginId === 'royalroad' ? { customCSS: PLUGIN_CSS } : {}),
        fromCache: num % 2 === 0,
      });
    },

    'library.list': () => Promise.resolve(libraryList()),
    'library.add': (a) => {
      const src: NovelSummary = a.novel;
      const k = keyOf(src.pluginId, src.path);
      if (!world.novels.has(k)) {
        // Unknown to the fixture world (e.g. installed plugin): synthesize a small novel.
        world.novels.set(k, {
          pluginId: src.pluginId,
          path: src.path,
          name: src.name,
          ...(src.cover !== undefined ? { cover: src.cover } : {}),
          author: 'Unknown',
          status: 'unknown',
          summary: '',
          genres: [],
          rating: 0,
          url: '',
          chapterCount: 12,
          seed: k.length,
          releaseBase: now() - 12 * 86_400_000,
          releaseStep: 86_400_000,
        });
      }
      const prev = world.library.get(k);
      // Like the script: an explicit choice is remembered; otherwise settings.library.addTo decides.
      let ids: string[];
      if (a.categoryIds) {
        ids = knownCategoryIds(a.categoryIds);
        world.settings.library.lastAddCategoryIds = ids;
      } else {
        const lib = world.settings.library;
        ids = lib.addTo === 'ask' ? [] : knownCategoryIds(lib.addTo === 'last' ? lib.lastAddCategoryIds : [lib.addTo]);
      }
      world.library.set(k, prev ?? { addedAt: now(), categoryIds: ids, lastUpdatedAt: now() });
      libraryChanged();
      const e = entry(k);
      if (!e) fail('STORAGE', 'Could not add');
      return Promise.resolve(e);
    },
    'library.remove': (a) => {
      world.library.delete(keyOf(a.pluginId, a.path));
      libraryChanged();
      return Promise.resolve();
    },
    'library.setCategories': (a) => {
      const ids = knownCategoryIds(a.categoryIds);
      for (const k of a.keys) {
        const rec = world.library.get(k);
        if (rec) rec.categoryIds = [...ids];
      }
      world.settings.library.lastAddCategoryIds = ids;
      libraryChanged();
      return Promise.resolve(libraryList());
    },
    'library.checkUpdates': (a) => runUpdateCheck(a.keys ?? [...world.library.keys()]),
    'library.markRead': async (a) => {
      await sleep(120);
      for (const k of a.keys) {
        const n = world.novels.get(k);
        if (!n || !world.library.has(k)) continue;
        const last = n.lockedFrom !== undefined ? Math.min(n.chapterCount, n.lockedFrom - 1) : n.chapterCount;
        state(n).read.fill(a.read ? 1 : 0, 0, last);
        for (const u of world.updates) if (keyOf(u.pluginId, u.path) === k) u.read = a.read;
      }
      libraryChanged();
      return libraryList();
    },
    'categories.list': () => Promise.resolve([...world.categories]),
    'categories.save': (a) => {
      world.categories = a.categories.map((c, i) => ({ ...c, order: i }));
      const ids = new Set(world.categories.map((c) => c.id));
      for (const rec of world.library.values()) rec.categoryIds = rec.categoryIds.filter((id) => ids.has(id));
      libraryChanged();
      return Promise.resolve([...world.categories]);
    },

    'progress.save': (a) => {
      const n = novel(a.pluginId, a.novelPath);
      const k = keyOf(n.pluginId, n.path);
      recordReading(k, a.finished === true);
      world.positions.set(`${k}|${a.chapterPath}`, a.position);
      const num = chapterNumberFromPath(a.chapterPath);
      if (a.finished && Number.isInteger(num)) state(n).read[num - 1] = 1;
      if (!world.settings.incognito) upsertHistory(n, a.chapterPath, a.finished ? 1 : a.position.percent);
      const rec = world.library.get(k);
      if (rec) {
        rec.lastReadAt = now();
        if (Number.isInteger(num)) rec.lastChapter = num;
        libraryChanged();
      }
      return Promise.resolve();
    },
    'progress.markRead': (a) => {
      const n = novel(a.pluginId, a.novelPath);
      const st = state(n);
      const paths = new Set(a.chapterPaths);
      for (const p of a.chapterPaths) {
        const num = chapterNumberFromPath(p);
        if (Number.isInteger(num) && num >= 1 && num <= n.chapterCount) st.read[num - 1] = a.read ? 1 : 0;
      }
      for (const u of world.updates) if (u.pluginId === n.pluginId && u.path === n.path && paths.has(u.chapterPath)) u.read = a.read;
      libraryChanged();
      return Promise.resolve();
    },
    'progress.bookmark': (a) => {
      const n = novel(a.pluginId, a.novelPath);
      const num = chapterNumberFromPath(a.chapterPath);
      if (a.bookmarked) state(n).bookmarked.add(num - 1);
      else state(n).bookmarked.delete(num - 1);
      return Promise.resolve();
    },

    'history.list': (a) => {
      const before = a.before ?? Infinity;
      return Promise.resolve(world.history.filter((h) => h.readAt < before).slice(0, a.limit ?? 100));
    },
    'history.remove': (a) => {
      world.history = world.history.filter((h) => !(h.pluginId === a.pluginId && h.path === a.path));
      return Promise.resolve();
    },
    'history.clear': () => {
      world.history = [];
      return Promise.resolve();
    },
    'updates.list': (a) =>
      Promise.resolve(
        world.updates.slice(0, a.limit ?? 200).map((u) => {
          // Like the script: whether the chapter is saved in downloads.
          const n = world.novels.get(keyOf(u.pluginId, u.path));
          const downloaded = n !== undefined && state(n).downloaded.has(chapterNumberFromPath(u.chapterPath) - 1);
          return { ...u, ...(downloaded ? { downloaded: true } : {}) };
        }),
      ),

    'backup.create': async () => {
      await sleep(400);
      const d = new Date(now());
      const pad = (n: number): string => String(n).padStart(2, '0');
      const b = {
        fileName: `tachinovel-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`,
        createdAt: now(),
        bytes: 40_000 + world.library.size * 2_100,
      };
      backups.unshift(b);
      return { ...b };
    },
    'backup.list': () => Promise.resolve(backups.map((b) => ({ ...b }))),
    'backup.restore': async (a) => {
      await sleep(500);
      if (a.fileName && !backups.some((b) => b.fileName === a.fileName)) fail('NOT_FOUND', 'Backup not found');
      libraryChanged();
      return { novels: world.library.size, sources: world.sources.length };
    },
    'backup.share': (a) => {
      console.info('[mock] share backup', a.fileName);
      return Promise.resolve();
    },
    'covers.fetch': async (a) => {
      await sleep(60);
      const art = PROXIED_COVERS.get(a.url);
      // One cover is simply gone on the source: the placeholder stays.
      if (!art || a.url.includes('/the-forgotten')) fail('NOT_FOUND', 'Cover not found');
      return { src: art };
    },
    'storage.usage': () => Promise.resolve(structuredClone(world.storage)),
    'storage.clear': (a) => {
      world.storage.bytes[a.category] = 0;
      return Promise.resolve(structuredClone(world.storage));
    },
    'downloads.enqueue': (a) => {
      const n = novel(a.pluginId, a.novelPath);
      const st = state(n);
      void (async () => {
        let done = 0;
        for (const p of a.chapterPaths) {
          await sleep(120);
          const num = chapterNumberFromPath(p);
          if (Number.isInteger(num)) st.downloaded.add(num - 1);
          done++;
          emit('downloads.progress', { pluginId: n.pluginId, novelPath: n.path, done, total: a.chapterPaths.length, finished: done === a.chapterPaths.length });
        }
        libraryChanged();
      })();
      return Promise.resolve();
    },
    'downloads.delete': (a) => {
      const n = novel(a.pluginId, a.novelPath);
      const st = state(n);
      if (!a.chapterPaths) st.downloaded.clear();
      else for (const p of a.chapterPaths) st.downloaded.delete(chapterNumberFromPath(p) - 1);
      libraryChanged();
      return Promise.resolve();
    },

    'native.actionSheet': async (a) => {
      const queued = sheetAnswers.shift();
      if (queued !== undefined) return { index: queued };
      return { index: await presentMockSheet(a, 'sheet') };
    },
    'native.alert': async (a) => {
      const queued = sheetAnswers.shift();
      if (queued !== undefined) return { index: queued };
      return { index: await presentMockSheet(a, 'alert') };
    },
    'native.share': (a) => {
      console.info('[mock] share', a);
      return Promise.resolve();
    },
    'native.openUrl': (a) => {
      console.info('[mock] open', a.url);
      return Promise.resolve();
    },
    'native.symbols': () => Promise.resolve({}),
    'native.device': () =>
      Promise.resolve({
        model: 'iPhone 16 Pro',
        systemVersion: '26.0',
        batteryLevel: 0.82,
        charging: false,
        brightness,
        dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      }),
    'sources.solveChallenge': async (a) => {
      findSource(a.pluginId);
      await sleep(400);
      solved.add(a.pluginId);
      return { solved: true };
    },
    'stats.get': (a) => Promise.resolve(readingStats(a.days ?? 30)),
    'migrate.preview': async (a) => {
      await sleep(180);
      const from = novel(a.from.pluginId, a.from.path);
      const to = novel(a.to.pluginId, a.to.path);
      const rec = world.library.get(keyOf(from.pluginId, from.path));
      const matched = migrateMatched(from, to);
      const read = state(from).read;
      let readCarried = 0;
      for (let i = 0; i < matched; i++) if (read[i] === 1) readCarried++;
      const resume = rec?.lastChapter !== undefined ? Math.min(rec.lastChapter, to.chapterCount) : undefined;
      return {
        matched,
        unmatched: from.chapterCount - matched,
        readCarried,
        ...(resume !== undefined ? { lastChapterName: chapterTitle(to.seed, resume) } : {}),
      };
    },
    'migrate.apply': async (a) => {
      await sleep(260);
      const from = novel(a.from.pluginId, a.from.path);
      const to = novel(a.to.pluginId, a.to.path);
      const fk = keyOf(from.pluginId, from.path);
      const tk = keyOf(to.pluginId, to.path);
      const rec = world.library.get(fk);
      if (!rec) fail('NOT_FOUND', 'That novel isn’t in your library anymore.');
      const fs = state(from);
      const ts = state(to);
      const matched = migrateMatched(from, to);
      for (let i = 0; i < matched; i++) if (fs.read[i] === 1) ts.read[i] = 1;
      for (const b of fs.bookmarked) if (b < to.chapterCount) ts.bookmarked.add(b);
      const last = rec.lastChapter !== undefined ? Math.min(rec.lastChapter, to.chapterCount) : undefined;
      const prev = world.library.get(tk);
      world.library.set(tk, {
        addedAt: prev?.addedAt ?? rec.addedAt,
        categoryIds: [...new Set([...(prev?.categoryIds ?? []), ...rec.categoryIds])],
        lastUpdatedAt: now(),
        ...(rec.lastReadAt !== undefined ? { lastReadAt: rec.lastReadAt } : {}),
        ...(last !== undefined ? { lastChapter: last } : {}),
      });
      if (last !== undefined && rec.lastChapter !== undefined) {
        const pos = world.positions.get(`${fk}|${chapterPath(from, rec.lastChapter)}`);
        if (pos) world.positions.set(`${tk}|${chapterPath(to, last)}`, pos);
      }
      if (!a.keepOld) {
        world.library.delete(fk);
        world.history = world.history.map((h) =>
          h.pluginId === from.pluginId && h.path === from.path
            ? {
                pluginId: to.pluginId,
                path: to.path,
                novelName: to.name,
                ...(to.cover !== undefined ? { cover: to.cover } : {}),
                chapterPath: chapterPath(to, last ?? 1),
                chapterName: chapterTitle(to.seed, last ?? 1),
                readAt: h.readAt,
                percent: h.percent,
                ...(h.readingMs !== undefined ? { readingMs: h.readingMs } : {}),
              }
            : h,
        );
      }
      libraryChanged();
      const e = entry(tk);
      if (!e) fail('STORAGE', 'Could not migrate');
      return e;
    },
    'cleanup.test': async (a) => {
      await sleep(120);
      const n = novel(a.pluginId, a.novelPath);
      const num = chapterNumberFromPath(a.chapterPath);
      if (!Number.isInteger(num) || num < 1 || num > n.chapterCount) fail('NOT_FOUND', 'Chapter not found');
      if (a.rule.scope !== '*' && a.rule.scope !== a.pluginId) return { removed: [] };
      let test: (text: string) => boolean;
      if (a.rule.regex) {
        let re: RegExp;
        try {
          re = new RegExp(a.rule.pattern, 'i');
        } catch {
          fail('INVALID_ARGS', 'That regular expression isn’t valid.');
        }
        test = (t) => re.test(t);
      } else {
        const p = a.rule.pattern.trim().toLowerCase();
        test = (t) => p !== '' && t.toLowerCase().includes(p);
      }
      return { removed: rawBlocks(n, num).filter(test) };
    },
    'native.setBrightness': (a) => {
      brightness = a.value;
      return Promise.resolve();
    },
  };

  function delayMs(): number {
    if (typeof latency === 'number') return latency;
    const [lo, hi] = latency;
    return lo + Math.random() * (hi - lo);
  }

  function isNetwork(method: MethodName, args: unknown): boolean {
    if (NETWORK_METHODS.has(method)) return true;
    if (method === 'novel.get') {
      const a = args as { pluginId: string; path: string; refresh?: boolean };
      return a.refresh === true || !world.library.has(keyOf(a.pluginId, a.path));
    }
    return false;
  }

  const client = {
    async call(method: MethodName, args?: unknown, _opts?: CallOptions): Promise<unknown> {
      calls.push({ method, args, at: Date.now() });
      if (calls.length > 500) calls.splice(0, calls.length - 500);
      const net = isNetwork(method, args);
      const ms = method.startsWith('native.') || method === 'app.log' ? 0 : delayMs() * (net ? 1 : 0.35);
      if (ms > 0) await sleep(ms);
      if (net && offline) fail('NETWORK', 'The Internet connection appears to be offline.', true);
      if (net && failRate > 0 && Math.random() < failRate) fail('TIMEOUT', 'The request timed out.', true);
      const handler = handlers[method] as (a: unknown) => Promise<unknown>;
      return handler(args);
    },
    on<E extends EventName>(event: E, fn: (payload: BridgeEvents[E]) => void): () => void {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const wrapped = fn as (payload: unknown) => void;
      set.add(wrapped);
      return () => set.delete(wrapped);
    },
  };
  return client as BridgeClient;
}
