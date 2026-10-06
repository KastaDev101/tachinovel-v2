/**
 * Mock world for the dev server and e2e tests: sources, browse pools, a ~12-novel library (one with
 * 3,024 chapters and coin-locked tail), history, updates, settings and storage numbers.
 * Deterministic for a given seed and "now".
 */
import type {
  AppSettings,
  AvailablePlugin,
  Category,
  ChapterMeta,
  ChapterPosition,
  HistoryEntry,
  NovelStatus,
  RepoInfo,
  SourceFailureReason,
  SourceInfo,
  StorageUsage,
  UpdateEntry,
} from '../../shared/contracts/domain.ts';
import { DEFAULT_SETTINGS } from '../state/defaults.ts';
import { coverArt, illustration, pickHue, sourceIcon } from './art.ts';
import { authorName, chapterTitle, genres, hash, int, novelTitle, paragraph, pick, rng, summary } from './text-gen.ts';

export const BIG_NOVEL = { pluginId: 'stonescape', path: 'shadow-of-the-ninth-gate' } as const;
export const SANITIZE_NOVEL = { pluginId: 'royalroad', path: '81234-the-lantern-makers-ledger' } as const;
export const LIBRARY_REPO = 'https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json';

export interface FixtureNovel {
  pluginId: string;
  path: string;
  name: string;
  cover?: string;
  author: string;
  status: NovelStatus;
  summary: string;
  genres: string[];
  rating: number;
  url: string;
  chapterCount: number;
  /** Chapters with number >= lockedFrom are coin-locked. */
  lockedFrom?: number;
  /** Chapters per volume ("Book One", "Book Two"…), like Royal Road with volumes on. */
  volumeSize?: number;
  seed: number;
  /** Release time of chapter 1 and spacing (ms). */
  releaseBase: number;
  releaseStep: number;
}

export interface NovelState {
  read: Uint8Array;
  bookmarked: Set<number>;
  downloaded: Set<number>;
}

export interface LibraryRecord {
  addedAt: number;
  categoryIds: string[];
  lastReadAt?: number;
  lastUpdatedAt?: number;
  lastChapter?: number;
}

export interface World {
  now: number;
  settings: AppSettings;
  sources: SourceInfo[];
  repos: RepoInfo[];
  available: AvailablePlugin[];
  novels: Map<string, FixtureNovel>;
  pools: Map<string, string[]>;
  states: Map<string, NovelState>;
  library: Map<string, LibraryRecord>;
  categories: Category[];
  history: HistoryEntry[];
  updates: UpdateEntry[];
  positions: Map<string, ChapterPosition>;
  storage: StorageUsage;
  /** Reading time per local day ("YYYY-MM-DD"), for stats.get. */
  reading: Map<string, ReadingDay>;
  /** Copies of library novels on other sources (pluginId → keys), found only by close title searches (Migrate). */
  mirrors: Map<string, string[]>;
}

/**
 * Stonescape covers live on a host that refuses direct <img> loads from the app (Cross-Origin-Resource-
 * Policy on the phone; an unresolvable .invalid host here), so they only show through covers.fetch.
 * Other sources serve inline art that loads directly.
 */
export const PROXIED_COVERS = new Map<string, string>();

function remoteCover(pluginId: string, path: string, art: string): string {
  if (pluginId !== 'stonescape') return art;
  const url = `https://cdn.stonescape.invalid/pub/covers/${path}.webp`;
  PROXIED_COVERS.set(url, art);
  return url;
}

export function keyOf(pluginId: string, path: string): string {
  return `${pluginId}:${path}`;
}

const SITES: Record<string, string> = {
  stonescape: 'https://stonescape.xyz',
  royalroad: 'https://www.royalroad.com',
  scribblehub: 'https://www.scribblehub.com',
  novelbin: 'https://novelbin.example',
  wuxiaworld: 'https://www.wuxiaworld.com',
  syosetu: 'https://syosetu.com',
};

function source(id: string, name: string, extra: Partial<SourceInfo>): SourceInfo {
  return {
    id,
    name,
    site: SITES[id] ?? `https://${id}.example`,
    version: '1.0.0',
    lang: 'English',
    iconUrl: sourceIcon(name, pickHue(name)),
    enabled: true,
    pinned: false,
    builtIn: false,
    hasFilters: false,
    ...extra,
  };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function chapterPath(n: FixtureNovel, num: number): string {
  return `${n.path}/${num}`;
}

export function chapterNumberFromPath(path: string): number {
  const m = /\/(\d+)$/.exec(path);
  return m?.[1] !== undefined ? Number(m[1]) : NaN;
}

export function chapterMeta(n: FixtureNovel, num: number): ChapterMeta {
  return {
    path: chapterPath(n, num),
    name: chapterTitle(n.seed, num),
    number: num,
    releaseTime: new Date(n.releaseBase + (num - 1) * n.releaseStep).toISOString(),
    ...(n.lockedFrom !== undefined && num >= n.lockedFrom ? { locked: true } : {}),
    ...(n.volumeSize ? { volume: volumeName(Math.floor((num - 1) / n.volumeSize)) } : {}),
  };
}

const VOLUME_WORDS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

function volumeName(i: number): string {
  return `Book ${VOLUME_WORDS[i] ?? String(i + 1)}`;
}

function makeNovel(pluginId: string, name: string, r: () => number, now: number, opts: Partial<FixtureNovel> = {}): FixtureNovel {
  const author = opts.author ?? authorName(r);
  const path = opts.path ?? (pluginId === 'royalroad' ? `${int(r, 10000, 99999)}-${slug(name)}` : slug(name));
  const chapterCount = opts.chapterCount ?? int(r, 24, 860);
  const status: NovelStatus = opts.status ?? pick(r, ['ongoing', 'ongoing', 'ongoing', 'completed', 'hiatus'] as const);
  const releaseStep = 86_400_000 * (status === 'completed' ? 1.3 : 0.9);
  return {
    pluginId,
    path,
    name,
    author,
    cover: r() < 0.94 ? remoteCover(pluginId, path, coverArt(name, author)) : undefined,
    status,
    summary: summary(r, name),
    genres: genres(r),
    rating: Math.round((3.4 + r() * 1.6) * 10) / 10,
    url: `${SITES[pluginId] ?? 'https://example.com'}/novel/${path}`,
    chapterCount,
    seed: hash(name),
    releaseBase: now - chapterCount * releaseStep - 86_400_000 * (status === 'completed' ? 200 : 0.4),
    releaseStep,
    ...opts,
  };
}

export function createWorld(seed: number, now: number, empty: boolean): World {
  const r = rng(seed);
  const sources: SourceInfo[] = [
    source('stonescape', 'Stonescape', { builtIn: true, pinned: true, version: '1.2.0', lastUsedAt: now - 3_600_000 }),
    source('royalroad', 'Royal Road', { version: '2.3.1', repoUrl: LIBRARY_REPO, lastUsedAt: now - 2 * 86_400_000, hasFilters: true, hasSettings: true }),
    source('scribblehub', 'Scribble Hub', { version: '1.4.0', repoUrl: LIBRARY_REPO, updateAvailable: '1.5.0', lastUsedAt: now - 9 * 86_400_000, hasFilters: true }),
    source('novelbin', 'NovelBin', { version: '1.0.3', repoUrl: LIBRARY_REPO, hasFilters: true, hasSettings: true }),
    source('wuxiaworld', 'Wuxiaworld', { version: '3.0.0', repoUrl: LIBRARY_REPO, enabled: false }),
    // LNReader index language names (what settings.languages holds), not ISO codes.
    source('syosetu', 'Syosetu', { version: '1.1.0', lang: '日本語', repoUrl: LIBRARY_REPO }),
  ];

  const novels = new Map<string, FixtureNovel>();
  const pools = new Map<string, string[]>();
  const add = (n: FixtureNovel): string => {
    const k = keyOf(n.pluginId, n.path);
    novels.set(k, n);
    const pool = pools.get(n.pluginId) ?? [];
    pool.push(k);
    pools.set(n.pluginId, pool);
    return k;
  };

  const big = makeNovel('stonescape', 'Shadow of the Ninth Gate', r, now, {
    path: BIG_NOVEL.path,
    author: 'Wren Calder',
    status: 'ongoing',
    chapterCount: 3024,
    lockedFrom: 3001,
  });
  big.releaseStep = 86_400_000 * 0.33;
  big.releaseBase = now - 3024 * big.releaseStep;
  big.genres = ['Action', 'Dark Fantasy', 'Adventure', 'Mystery', 'Psychological'];
  add(big);
  add(
    makeNovel('royalroad', 'The Lantern Maker’s Ledger', r, now, {
      path: SANITIZE_NOVEL.path,
      chapterCount: 64,
      status: 'ongoing',
      volumeSize: 20,
    }),
  );

  const used = new Set<string>([big.name, 'The Lantern Maker’s Ledger']);
  for (const s of sources) {
    const count = s.id === 'stonescape' || s.id === 'royalroad' ? 58 : 40;
    let made = 0;
    let guard = 0;
    while (made < count && guard++ < 2000) {
      const name = novelTitle(r);
      if (used.has(name)) continue;
      used.add(name);
      add(makeNovel(s.id, name, r, now));
      made++;
    }
  }

  const states = new Map<string, NovelState>();
  const stateOf = (k: string): NovelState => {
    let st = states.get(k);
    if (!st) {
      const n = novels.get(k);
      st = { read: new Uint8Array(n?.chapterCount ?? 0), bookmarked: new Set(), downloaded: new Set() };
      states.set(k, st);
    }
    return st;
  };

  const categories: Category[] = [
    { id: 'reading', name: 'Reading', order: 0 },
    { id: 'later', name: 'Plan to Read', order: 1 },
    { id: 'done', name: 'Finished', order: 2 },
  ];

  const library = new Map<string, LibraryRecord>();
  const history: HistoryEntry[] = [];
  const updates: UpdateEntry[] = [];
  const positions = new Map<string, ChapterPosition>();

  if (!empty) {
    const picks: { key: string; readUpTo: number; cats: string[]; lastReadAgo?: number; downloaded?: number }[] = [];
    const bigKey = keyOf(big.pluginId, big.path);
    // Like a typical library: most novels in Default (no category), a few sorted into categories.
    picks.push({ key: bigKey, readUpTo: 1250, cats: [], lastReadAgo: 25 * 60_000, downloaded: 3 });
    picks.push({ key: keyOf(SANITIZE_NOVEL.pluginId, SANITIZE_NOVEL.path), readUpTo: 1, cats: [], lastReadAgo: 5 * 3_600_000 });
    const candidates = [...(pools.get('stonescape') ?? []).slice(1, 6), ...(pools.get('royalroad') ?? []).slice(1, 4), ...(pools.get('scribblehub') ?? []).slice(0, 2)];
    candidates.forEach((k, i) => {
      const n = novels.get(k);
      if (!n) return;
      const ratio = [0.92, 0.4, 1, 0, 0.75, 0.15, 1, 0.55, 0, 0.3][i] ?? 0.5;
      const cats = n.status === 'completed' && ratio === 1 ? ['done'] : ratio === 0 ? ['later'] : i === 1 || i === 4 ? ['reading'] : [];
      picks.push({
        key: k,
        readUpTo: Math.floor(n.chapterCount * ratio),
        cats,
        ...(ratio > 0 ? { lastReadAgo: (i + 1) * 7.3 * 3_600_000 } : {}),
        ...(i === 2 ? { downloaded: 12 } : {}),
      });
    });

    picks.forEach((p, i) => {
      const n = novels.get(p.key);
      if (!n) return;
      const st = stateOf(p.key);
      st.read.fill(1, 0, Math.min(p.readUpTo, n.chapterCount));
      for (let d = 0; d < (p.downloaded ?? 0); d++) st.downloaded.add(Math.min(n.chapterCount - 1, p.readUpTo + d));
      if (p.key === bigKey) {
        st.bookmarked.add(41);
        st.bookmarked.add(512);
        st.bookmarked.add(1199);
      }
      const lastChapter = p.lastReadAgo !== undefined ? Math.min(n.chapterCount, p.readUpTo + 1) : undefined;
      library.set(p.key, {
        addedAt: now - (40 - i * 3) * 86_400_000,
        categoryIds: p.cats,
        ...(p.lastReadAgo !== undefined ? { lastReadAt: now - p.lastReadAgo } : {}),
        lastUpdatedAt: n.status === 'completed' ? now - (60 + i) * 86_400_000 : now - (i % 5) * 86_400_000 - 3_600_000 * (i + 1),
        ...(lastChapter !== undefined ? { lastChapter } : {}),
      });
      if (p.lastReadAgo !== undefined && lastChapter !== undefined) {
        const cp = chapterPath(n, lastChapter);
        const percent = p.key === bigKey ? 0.38 : 0.12 + (i % 4) * 0.2;
        positions.set(`${p.key}|${cp}`, { percent, paragraph: Math.floor(percent * 40), offset: 0 });
        history.push({
          pluginId: n.pluginId,
          path: n.path,
          novelName: n.name,
          ...(n.cover !== undefined ? { cover: n.cover } : {}),
          chapterPath: cp,
          chapterName: chapterTitle(n.seed, lastChapter),
          readAt: now - p.lastReadAgo,
          percent,
          ...(i % 3 !== 2 ? { readingMs: Math.round((p.readUpTo * 6 + 17) * 60_000 * (1 + (i % 4) * 0.3)) } : {}),
        });
      }
      // Recent chapters show up in Updates.
      if (n.status !== 'completed') {
        const count = 1 + (i % 3);
        for (let c = 0; c < count; c++) {
          const num = (n.lockedFrom ? n.lockedFrom - 1 : n.chapterCount) - c;
          if (num < 1) break;
          updates.push({
            pluginId: n.pluginId,
            path: n.path,
            novelName: n.name,
            ...(n.cover !== undefined ? { cover: n.cover } : {}),
            chapterPath: chapterPath(n, num),
            chapterName: chapterTitle(n.seed, num),
            foundAt: now - (i % 5) * 86_400_000 - 3_600_000 * (i + 1) - c * 600_000,
            read: st.read[num - 1] === 1,
          });
        }
      }
    });
    history.sort((a, b) => b.readAt - a.readAt);
    updates.sort((a, b) => b.foundAt - a.foundAt);
  }

  const repos: RepoInfo[] = [{ url: LIBRARY_REPO, name: 'LNReader plugins', pluginCount: 214, fetchedAt: now - 86_400_000 }];
  // Repo plugins in several languages, with the PC verification sweep's verdicts and, where it found
  // one, why (plugins/verified.json).
  const AVAILABLE: [id: string, name: string, lang: string, version: string, verified?: AvailablePlugin['verified'], reason?: SourceFailureReason][] = [
    ['royalroad', 'Royal Road', 'English', '2.3.1', 'works'],
    ['scribblehub', 'Scribble Hub', 'English', '1.5.0', 'partial', 'bot-check'],
    ['novelbin', 'NovelBin', 'English', '1.0.3', 'works'],
    ['wuxiaworld', 'Wuxiaworld', 'English', '3.0.0', 'works'],
    ['syosetu', 'Syosetu', '日本語', '1.1.0', 'works'],
    ['lightnovelpub', 'LightNovelPub', 'English', '1.2.2', 'broken', 'bot-check'],
    ['novelfull', 'NovelFull', 'English', '1.0.9', 'works'],
    ['freewebnovel', 'FreeWebNovel', 'English', '1.1.0', 'partial', 'layout-changed'],
    ['readlightnovel', 'ReadLightNovel', 'English', '2.0.1', 'broken', 'site-gone'],
    ['allnovel', 'AllNovel', 'English', '2.2.2'],
    ['kakuyomu', 'Kakuyomu', '日本語', '1.0.1', 'partial', 'rate-limited'],
    ['centralnovel', 'Central Novel', 'Português', '1.0.0', 'works'],
    ['novelasligeras', 'Novelas Ligeras', 'Español', '1.0.4', 'broken', 'tls'],
    ['ranobes', 'Ranobes', 'Русский', '2.1.0', 'works'],
  ];
  const available: AvailablePlugin[] = AVAILABLE.map(([id, name, lang, version, verified, reason]) => {
    const installed = sources.find((s) => s.id === id);
    return {
      id,
      name,
      lang,
      version,
      site: SITES[id] ?? `https://${id}.example`,
      url: `https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.js/src/plugins/${id}.js`,
      iconUrl: sourceIcon(name, pickHue(name)),
      repoUrl: LIBRARY_REPO,
      installed: installed !== undefined,
      ...(installed ? { installedVersion: installed.version } : {}),
      ...(verified ? { verified } : {}),
      ...(reason ? { verifiedReason: reason } : {}),
    };
  });

  const MB = 1024 * 1024;
  const storage: StorageUsage = {
    bytes: { state: 0.21 * MB, meta: 0.86 * MB, cache: 6.4 * MB, covers: 3.1 * MB, downloads: 12.8 * MB, logs: 0.12 * MB },
    caps: { cacheBytes: 10 * MB, coverBytes: 10 * MB },
    // Two novels not in the library still have downloads (counted in downloads above).
    ...(empty ? {} : { orphanDownloads: { novels: 2, bytes: 4.6 * MB } }),
  };

  return {
    now,
    settings: extraSettings(structuredClone(DEFAULT_SETTINGS), empty),
    sources,
    repos,
    available,
    novels,
    pools,
    states,
    library,
    categories,
    history,
    updates,
    positions,
    storage,
    ...readingAndMirrors(seed, now, empty, novels, library),
  };
}

/** Raw (unsanitized) chapter HTML, like a source plugin would return. */
export function chapterHtml(n: FixtureNovel, num: number): string {
  const r = rng(n.seed ^ Math.imul(num, 0x9e3779b1));
  if (n.pluginId === SANITIZE_NOVEL.pluginId && n.path === SANITIZE_NOVEL.path && num === 2) return hostileChapter(r);
  if (n.pluginId === SANITIZE_NOVEL.pluginId && n.path === SANITIZE_NOVEL.path && num >= 40 && num <= 44) return edgeChapter(num, r);
  const long = num % 100 === 0;
  const count = long ? 320 : 46 + (num % 7) * 6;
  const parts: string[] = [];
  const avoid = new Set<number>();
  for (let i = 0; i < count; i++) {
    if (i > 0 && i % 37 === 0 && !long) parts.push('<p style="text-align:center">* * *</p>');
    else parts.push(`<p>${paragraph(r, avoid)}</p>`);
  }
  // Stonescape-style sources repeat the title as the first paragraph ("Ch 12 - The Gate").
  const echo = n.pluginId === 'stonescape' ? `<p>Ch ${num} - ${chapterTitle(n.seed, num).replace(/^Chapter \d+: /, '')}</p>` : '';
  // Chapter 44 of Stonescape novels comes back empty (an image-only page the source can't serve as text).
  if (n.pluginId === 'stonescape' && num === 44) return '<div class="chapter-inner chapter-content"><p>&nbsp;</p></div>';
  // Chapter 33 of Stonescape novels carries illustrations from the site's CDN (blocked for direct
  // loads like its covers): one the script can fetch, one that is gone.
  if (n.pluginId === 'stonescape' && num === 33) {
    parts.splice(3, 0, `<p><img src="https://cdn.stonescape.invalid/illustrations/${n.path}-33.webp" alt="The valley at dusk" width="600" height="400"></p>`);
    parts.splice(12, 0, `<p><img src="https://cdn.stonescape.invalid/missing/${n.path}-33b.webp" alt="A lost sketch"></p>`);
  }
  return `<div class="chapter-inner chapter-content">${echo}${parts.join('\n')}</div>`;
}

/**
 * Content edge cases real sources serve (The Lantern Maker's Ledger, chapters 40–44): a ~200 KB
 * chapter, an images-only chapter, a table wider than the screen, unbroken words and URLs, and
 * nested blockquotes with <hr> scene breaks.
 */
function edgeChapter(num: number, r: () => number): string {
  const avoid = new Set<number>();
  const p = (): string => paragraph(r, avoid);
  switch (num) {
    case 40: {
      const parts: string[] = [];
      let size = 0;
      while (size < 200_000) {
        const t = `<p>${p()} ${p()}</p>`;
        parts.push(t);
        size += t.length;
      }
      return `<div>${parts.join('\n')}</div>`;
    }
    case 41:
      return `<div>${[1, 2, 3, 4].map((i) => `<p><img src="${illustration(i * 11)}" alt="Page ${i} of the comic" width="800" height="1200"></p>`).join('\n')}</div>`;
    case 42: {
      const head = ['Name', 'Rank', 'Element', 'Strength', 'Agility', 'Spirit', 'Weapon', 'Notes'].map((h) => `<th>${h}</th>`).join('');
      const rows = ['Mira', 'Kael', 'Doran', 'Iskra', 'Vela']
        .map((name, i) => `<tr><td>${name}</td><td>S${i}</td><td>Ash</td><td>${40 + i * 7}</td><td>${55 - i * 3}</td><td>${30 + i * 9}</td><td>Glass-edged halberd of the drowned kings</td><td>Carries the ledger; trusts no one past the Ashen Gate</td></tr>`)
        .join('');
      return `<div><p>${p()}</p><p>[Status window]</p><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table><p>${p()}</p></div>`;
    }
    case 43:
      return `<div><p>${p()}</p><p>The ward read: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!</p><p>Source: https://www.royalroad.com/fiction/81234/the-lantern-makers-ledger/chapter/1999999/an-extremely-long-chapter-slug-that-never-breaks-anywhere-at-all</p><p>${p()}</p></div>`;
    default:
      return `<div><p>${p()}</p><blockquote><p>${p()}</p><blockquote><p>${p()}</p><blockquote><p>“Deeper still,” the letter said.</p></blockquote></blockquote></blockquote><hr><p>${p()}</p><hr/><p>${p()}</p></div>`;
  }
}

/** A chapter with the kind of junk and hostile markup real sites serve. */
function hostileChapter(r: () => number): string {
  const avoid = new Set<number>();
  const p = (): string => paragraph(r, avoid);
  return `<div id="chapter" style="font-family: Comic Sans MS; color: red" onclick="window.__xss=1">
<script>window.__xss = 1</script>
<style>body { display: none }</style>
<p class="author-note" style="font-size:40px" onmouseover="window.__xss=1">${p()}</p>
<p>${p()} <a href="javascript:window.__xss=1">a link</a> and <a href="https://example.com">another</a>.</p>
<img src="x" onerror="window.__xss=1">
<img src="http://insecure.example/a.png">
<img src="${illustration(7)}" alt="An illustration of a valley at dusk" width="320" height="180">
<iframe src="https://evil.example"></iframe>
<p>${p()}<br><br>${p()}</p>
<blockquote>${p()}</blockquote>
<p>&nbsp;</p><p> </p>
<table><tr><th>Stat</th><th>Value</th></tr><tr><td>Strength</td><td>12</td></tr><tr><td>Will</td><td>19</td></tr></table>
<hr>
<svg onload="window.__xss=1"><circle r="5"/></svg>
<form action="https://evil.example"><input name="q" value="x"><button>Go</button></form>
<math><mi xlink:href="javascript:window.__xss=1">x</mi></math>
<p>${p()}</p>
Some trailing text without a paragraph tag.<br><br>And one more line after a double break.
<object data="javascript:window.__xss=1"></object><embed src="javascript:window.__xss=1">
<p>${p()}</p>
</div>`;
}

// ---------- Reading Insights, Migrate, Text Cleanup ----------

export interface ReadingDay {
  ms: number;
  chapters: number;
  /** Novel key → ms read that day. */
  byNovel: Map<string, number>;
}

/** Local calendar day key, "2026-10-05". */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Settings added for auto-download, daily backup, cleanup rules and recent searches. */
function extraSettings(base: AppSettings, empty: boolean): AppSettings {
  return {
    ...base,
    autoDownload: { enabled: false, ahead: 3 },
    autoBackup: true,
    cleanupRules: empty ? [] : [{ id: 'rule-novelbin', pattern: 'This chapter is updated by', regex: false, scope: 'novelbin', enabled: true }],
    recentSearches: empty ? [] : ['ninth gate', 'lantern'],
  };
}

const MIRROR_SOURCES = ['stonescape', 'royalroad', 'scribblehub', 'novelbin'] as const;

/**
 * ~13 months of reading (a 12-day streak up to today, a gap before it, then most days) spread over
 * the novels being read, plus copies of each library novel on other sources (same chapters, a few
 * more or fewer) so Migrate finds real matches. Uses its own RNG so the base world is unchanged.
 */
function readingAndMirrors(
  seed: number,
  now: number,
  empty: boolean,
  novels: Map<string, FixtureNovel>,
  library: Map<string, LibraryRecord>,
): { reading: Map<string, ReadingDay>; mirrors: Map<string, string[]> } {
  const reading = new Map<string, ReadingDay>();
  const mirrors = new Map<string, string[]>();
  if (empty) return { reading, mirrors };
  const r = rng(seed * 7919 + 17);
  const keys = [...library.keys()];
  const active = keys.filter((k) => library.get(k)?.lastReadAt !== undefined);
  const pickFrom = active.length > 0 ? active : keys;
  for (let d = 400; d >= 0; d--) {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - d);
    const roll = r();
    const extra = r();
    const share = r();
    let min = 0;
    if (d === 0) min = 38;
    else if (d <= 11 || (d !== 12 && roll < 0.62)) {
      const weekend = date.getDay() === 0 || date.getDay() === 6;
      min = Math.round(12 + extra * (weekend ? 95 : 58));
    }
    if (min === 0 || pickFrom.length === 0) continue;
    const ms = min * 60_000;
    const primary = pickFrom[Math.floor(d / 9) % pickFrom.length] ?? '';
    const secondary = share < 0.4 ? pickFrom[(Math.floor(d / 5) + 3) % pickFrom.length] : undefined;
    const byNovel = new Map<string, number>();
    if (secondary && secondary !== primary) {
      byNovel.set(primary, Math.round(ms * 0.7));
      byNovel.set(secondary, ms - Math.round(ms * 0.7));
    } else byNovel.set(primary, ms);
    reading.set(localDayKey(date.getTime()), { ms, chapters: Math.max(1, Math.round(min / 8.5)), byNovel });
  }

  keys.forEach((k, i) => {
    const n = novels.get(k);
    if (!n) return;
    MIRROR_SOURCES.filter((id) => id !== n.pluginId).forEach((pid, j) => {
      if ((i + j) % 3 === 2) return;
      const delta = [0, -3, 2, -1][(i + j) % 4] ?? 0;
      const name = j === 1 && n.name.length > 12 ? `${n.name} (Web Novel)` : n.name;
      const path = `${pid === 'royalroad' ? `${10000 + ((n.seed + j * 977) % 89999)}-` : ''}${slug(n.name)}-${pid.slice(0, 2)}`;
      const mirror: FixtureNovel = {
        ...n,
        pluginId: pid,
        path,
        name,
        cover: remoteCover(pid, path, coverArt(n.name, n.author)),
        url: `${SITES[pid] ?? 'https://example.com'}/novel/${path}`,
        chapterCount: Math.max(1, Math.min(n.lockedFrom !== undefined ? n.lockedFrom - 1 : n.chapterCount, n.chapterCount) + delta),
      };
      delete mirror.lockedFrom;
      const mk = keyOf(pid, path);
      novels.set(mk, mirror);
      mirrors.set(pid, [...(mirrors.get(pid) ?? []), mk]);
    });
  });
  return { reading, mirrors };
}

/**
 * Load-test data (perf specs, `DevFlags.stress`): many Updates and History entries and extra
 * browsable sources. Deterministic, added after the normal world so nothing else changes.
 */
export function addStress(world: World, stress: { updates?: number; history?: number; sources?: number }): void {
  const lib = [...world.library.keys()].map((k) => world.novels.get(k)).filter((n): n is FixtureNovel => n !== undefined);
  const DAY = 86_400_000;
  if (stress.updates && lib.length > 0) {
    const span = 60 * DAY;
    const next = new Map<string, number>(lib.map((n) => [keyOf(n.pluginId, n.path), n.lockedFrom ? n.lockedFrom - 1 : n.chapterCount]));
    const out: UpdateEntry[] = [];
    for (let i = 0; i < stress.updates; i++) {
      const n = lib[i % lib.length] as FixtureNovel;
      const k = keyOf(n.pluginId, n.path);
      const num = Math.max(1, next.get(k) ?? 1);
      next.set(k, num - 1);
      out.push({
        pluginId: n.pluginId,
        path: n.path,
        novelName: n.name,
        ...(n.cover !== undefined ? { cover: n.cover } : {}),
        chapterPath: chapterPath(n, num),
        chapterName: chapterTitle(n.seed, num),
        foundAt: world.now - Math.floor((i / stress.updates) * span) - 60_000,
        read: i % 3 === 0,
      });
    }
    world.updates = out;
  }
  if (stress.history) {
    const novels = [...world.novels.values()];
    const span = 120 * DAY;
    world.history = Array.from({ length: stress.history }, (_, i) => {
      const n = novels[i % novels.length] as FixtureNovel;
      return {
        pluginId: n.pluginId,
        path: `${n.path}-stress-${i}`,
        novelName: `${n.name} ${i + 1}`,
        ...(n.cover !== undefined ? { cover: n.cover } : {}),
        chapterPath: `${n.path}-stress-${i}/1`,
        chapterName: chapterTitle(n.seed, (i % 300) + 1),
        readAt: world.now - Math.floor((i / stress.history!) * span) - 120_000,
        percent: (i % 10) / 10,
        ...(i % 2 === 0 ? { readingMs: (i % 50) * 600_000 + 60_000 } : {}),
      };
    });
  }
  if (stress.sources) {
    const pools = [...world.pools.values()].filter((p) => p.length > 0);
    for (let i = 1; i <= stress.sources; i++) {
      const id = `extra${String(i).padStart(2, '0')}`;
      const name = `Novel Source ${String(i).padStart(2, '0')}`;
      world.sources.push(source(id, name, { version: '1.0.0' }));
      world.pools.set(id, [...(pools[i % pools.length] ?? [])]);
    }
  }
}
