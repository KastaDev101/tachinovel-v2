/**
 * Stonescape (https://stonescape.xyz) — TachiNovel's own LNReader-format plugin.
 *
 * The site is a Vue SPA with a public JSON API (mapped 2026-10-05, see CLAUDE.md):
 *   GET /api/series?page&limit&contentType=novel[&sort][&genres][&status][&search]  → { data, pagination }
 *       sort: (none = latest) | popular_month | popular_year | title | title_desc
 *   GET /api/series/by-slug/{slug}                                   → series details
 *   GET /api/series/by-slug/{slug}/chapters                          → { chapters } (unpaginated, ascending)
 *   GET /api/series/by-slug/{slug}/chapters/{chapterNumber}/novel-content → { contentHtml, noteBeforeHtml, … }
 *       (402 for paywalled chapters)
 * Access rules: only free, logged-out content. Never calls unlock/purchase/login/view-tracking
 * endpoints and never requests the content of a chapter it has seen marked as locked.
 *
 * novelPath = slug; chapterPath = `${slug}/${chapterNumber}` with the API's chapterNumber string ("12.00").
 */
import { fetchApi } from '@libs/fetch';
import { FilterTypes, type Filters } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';
import type { Plugin } from '../src/shared/lnreader/plugin.ts';

const SITE = 'https://stonescape.xyz';
const API = `${SITE}/api`;
const PAGE_SIZE = 20;

/** Genre slugs → labels, from GET /api/genres (2026-10-05). */
const GENRES: Record<string, string> = {
  action: 'Action',
  adaptation: 'Adaptation',
  adventure: 'Adventure',
  comedy: 'Comedy',
  demons: 'Demons',
  drama: 'Drama',
  ecchi: 'Ecchi',
  fantasy: 'Fantasy',
  genderbender: 'Gender Bender',
  gore: 'Gore',
  harem: 'Harem',
  historical: 'Historical',
  horror: 'Horror',
  isekai: 'Isekai',
  josei: 'Josei',
  magic: 'Magic',
  martialarts: 'Martial Arts',
  mature: 'Mature',
  mecha: 'Mecha',
  military: 'Military',
  monsters: 'Monsters',
  mystery: 'Mystery',
  'post-apocalyptic': 'Post-Apocalyptic',
  psychological: 'Psychological',
  romance: 'Romance',
  schoollife: 'School Life',
  'sci-fi': 'Sci-Fi',
  seinen: 'Seinen',
  shoujo: 'Shoujo',
  shoujoai: 'Shoujo Ai',
  shounen: 'Shounen',
  shounenai: 'Shounen Ai',
  sliceoflife: 'Slice of Life',
  smut: 'Smut',
  sports: 'Sports',
  supernatural: 'Supernatural',
  thriller: 'Thriller',
  tragedy: 'Tragedy',
  'video-games': 'Video Games',
  webtoons: 'Webtoons',
  wuxia: 'Wuxia',
  yaoi: 'Yaoi',
  yuri: 'Yuri',
};

const filters = {
  sort: {
    type: FilterTypes.Picker,
    label: 'Sort by',
    value: 'popular_month',
    options: [
      { label: 'Popular (month)', value: 'popular_month' },
      { label: 'Popular (year)', value: 'popular_year' },
      { label: 'Latest update', value: 'latest' },
      { label: 'Title A–Z', value: 'title' },
      { label: 'Title Z–A', value: 'title_desc' },
    ],
  },
  status: {
    type: FilterTypes.Picker,
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
    type: FilterTypes.CheckboxGroup,
    label: 'Genres (all of)',
    value: [] as string[],
    options: Object.entries(GENRES).map(([value, label]) => ({ label, value })),
  },
} satisfies Filters;

// ---------- API shapes (only the fields we use) ----------

interface ApiSeries {
  slug: string;
  title: string;
  coverUrl?: string | null;
  author?: string | null;
  artist?: string | null;
  description?: string | null;
  publicationStatus?: string | null;
  genres?: string[] | null;
  contentType?: string | null;
  averageRating?: number | string | null;
  chapterCount?: number | null;
}

interface ApiPagination {
  page: number;
  totalPages: number;
}

interface ApiChapter {
  chapterNumber: string;
  title?: string | null;
  status?: string | null;
  publishedAt?: string | null;
  createdAt?: string | null;
  accessMode?: string | null;
  locked?: boolean | null;
  isFreeNow?: boolean | null;
}

interface ApiContent {
  contentHtml?: string | null;
  noteBeforeHtml?: string | null;
  noteAfterHtml?: string | null;
  isFreeNow?: boolean | null;
}

class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/** Errors with code LOCKED surface as SourceError('LOCKED') in the host. */
class LockedChapterError extends Error {
  readonly code = 'LOCKED';
  constructor(path: string) {
    super(`Stonescape: chapter ${path} is locked (paid or not yet free)`);
    this.name = 'LockedChapterError';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isSeries(v: unknown): v is ApiSeries {
  return isObject(v) && typeof v.slug === 'string' && typeof v.title === 'string';
}

function isChapter(v: unknown): v is ApiChapter {
  return isObject(v) && typeof v.chapterNumber === 'string' && v.chapterNumber !== '';
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetchApi(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new HttpStatusError(res.status, url);
  return res.json();
}

function absolute(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  return SITE + (path.startsWith('/') ? path : '/' + path);
}

/** "12.00" → "12", "12.50" → "12.5" (as the site shows it). */
function displayNumber(chapterNumber: string): string {
  const n = parseFloat(chapterNumber);
  return Number.isFinite(n) ? String(n) : chapterNumber;
}

function mapStatus(s: string | null | undefined): string {
  switch ((s ?? '').toLowerCase()) {
    case 'ongoing':
      return NovelStatus.Ongoing;
    case 'completed':
      return NovelStatus.Completed;
    case 'hiatus':
      return NovelStatus.OnHiatus;
    case 'cancelled':
    case 'canceled':
    case 'dropped':
      return NovelStatus.Cancelled;
    default:
      return NovelStatus.Unknown;
  }
}

function genreLabel(slug: string): string {
  return GENRES[slug] ?? slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Locked unless the API says it is free to read right now, logged out. Errs on the side of locked. */
function isChapterLocked(c: ApiChapter): boolean {
  if (c.locked === true) return true;
  if (c.status && c.status !== 'published') return true;
  if (c.accessMode && c.accessMode !== 'free' && c.isFreeNow !== true) return true;
  if (c.isFreeNow === false) return true;
  return false;
}

function splitChapterPath(path: string): { slug: string; number: string } {
  const i = path.lastIndexOf('/');
  const slug = i > 0 ? path.slice(0, i) : '';
  const number = i > 0 ? path.slice(i + 1) : '';
  if (!slug || !number) throw new Error(`Stonescape: invalid chapter path "${path}"`);
  return { slug, number };
}

class StonescapePlugin implements Plugin.PluginBase {
  id = 'stonescape';
  name = 'Stonescape';
  version = '1.0.0';
  site = SITE;
  icon = 'https://stonescape.xyz/logo.png';
  filters = filters;

  /** slug → chapter numbers seen as locked (so parseChapter never requests them). */
  private lockedChapters = new Map<string, Set<string>>();

  private toNovelItems(list: unknown): Plugin.NovelItem[] {
    const data = isObject(list) && Array.isArray(list.data) ? list.data : [];
    return data
      .filter(isSeries)
      .filter((s) => !s.contentType || s.contentType === 'novel')
      .map((s) => {
        const item: Plugin.NovelItem = { name: s.title, path: s.slug, cover: absolute(s.coverUrl) };
        if (typeof s.chapterCount === 'number' && Number.isFinite(s.chapterCount) && s.chapterCount >= 0) item.chapterCount = s.chapterCount;
        return item;
      });
  }

  private async listPage(params: string[], page: number): Promise<Plugin.NovelItem[]> {
    if (!Number.isInteger(page) || page < 1) return [];
    const url = `${API}/series?${[`page=${page}`, `limit=${PAGE_SIZE}`, 'contentType=novel', ...params].join('&')}`;
    const json = await getJson(url);
    const pagination = isObject(json) && isObject(json.pagination) ? (json.pagination as unknown as ApiPagination) : undefined;
    if (pagination && typeof pagination.totalPages === 'number' && page > pagination.totalPages) return [];
    return this.toNovelItems(json);
  }

  async popularNovels(page: number, { showLatestNovels, filters: values }: Plugin.PopularNovelsOptions<typeof filters>): Promise<Plugin.NovelItem[]> {
    const params: string[] = [];
    const sort = showLatestNovels ? 'latest' : values?.sort?.value || 'popular_month';
    if (sort !== 'latest') params.push(`sort=${encodeURIComponent(sort)}`);
    const status = values?.status?.value;
    if (status) params.push(`status=${encodeURIComponent(status)}`);
    const genres = values?.genres?.value;
    if (Array.isArray(genres) && genres.length) params.push(`genres=${genres.map(encodeURIComponent).join(',')}`);
    return this.listPage(params, page);
  }

  async searchNovels(searchTerm: string, page: number): Promise<Plugin.NovelItem[]> {
    const term = searchTerm.trim();
    if (!term) return [];
    return this.listPage([`search=${encodeURIComponent(term)}`], page);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const slug = encodeURIComponent(novelPath);
    const [seriesJson, chaptersJson] = await Promise.all([getJson(`${API}/series/by-slug/${slug}`), getJson(`${API}/series/by-slug/${slug}/chapters`)]);
    if (!isSeries(seriesJson)) throw new Error(`Stonescape: unexpected series response for "${novelPath}"`);
    if (seriesJson.contentType && seriesJson.contentType !== 'novel') {
      throw new Error(`Stonescape: "${novelPath}" is a ${seriesJson.contentType}, not a novel`);
    }
    const raw = isObject(chaptersJson) && Array.isArray(chaptersJson.chapters) ? chaptersJson.chapters.filter(isChapter) : [];
    // Trim to what we keep right away (lists can be thousands of rows).
    const locked = new Set<string>();
    const chapters: Plugin.ChapterItem[] = raw
      .map((c, i) => ({ c, i, n: parseFloat(c.chapterNumber) }))
      .sort((a, b) => (Number.isFinite(a.n) && Number.isFinite(b.n) && a.n !== b.n ? a.n - b.n : a.i - b.i))
      .map(({ c, n }) => {
        const isLocked = isChapterLocked(c);
        if (isLocked) locked.add(c.chapterNumber);
        const title = (c.title ?? '').trim();
        const item: Plugin.ChapterItem = {
          name: `Chapter ${displayNumber(c.chapterNumber)}${title ? ` - ${title}` : ''}`,
          path: `${novelPath}/${c.chapterNumber}`,
          releaseTime: c.publishedAt ?? c.createdAt ?? null,
          locked: isLocked,
        };
        if (Number.isFinite(n)) item.chapterNumber = n;
        return item;
      });
    this.lockedChapters.set(novelPath, locked);

    const rating = typeof seriesJson.averageRating === 'string' ? parseFloat(seriesJson.averageRating) : seriesJson.averageRating;
    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: seriesJson.title,
      cover: absolute(seriesJson.coverUrl),
      author: seriesJson.author ?? undefined,
      artist: seriesJson.artist ?? undefined,
      summary: (seriesJson.description ?? '').replace(/\r\n?/g, '\n'),
      status: mapStatus(seriesJson.publicationStatus),
      genres: (seriesJson.genres ?? []).map(genreLabel).join(', '),
      chapters,
    };
    if (typeof rating === 'number' && Number.isFinite(rating) && rating > 0 && rating <= 5) novel.rating = rating;
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const { slug, number } = splitChapterPath(chapterPath);
    if (this.lockedChapters.get(slug)?.has(number)) throw new LockedChapterError(chapterPath);
    const url = `${API}/series/by-slug/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(number)}/novel-content`;
    const res = await fetchApi(url, { headers: { Accept: 'application/json' } });
    if (res.status === 402) throw new LockedChapterError(chapterPath);
    if (!res.ok) throw new HttpStatusError(res.status, url);
    const json = await res.json();
    const data: ApiContent = isObject(json) ? json : {};
    const body = typeof data.contentHtml === 'string' ? data.contentHtml.trim() : '';
    if (!body) {
      if (data.isFreeNow === false) throw new LockedChapterError(chapterPath);
      throw new Error(`Stonescape: chapter ${chapterPath} has no text`);
    }
    const parts: string[] = [];
    if (data.noteBeforeHtml?.trim()) parts.push(`<div class="author-note-before">${data.noteBeforeHtml}</div>`, '<hr>');
    parts.push(body);
    if (data.noteAfterHtml?.trim()) parts.push('<hr>', `<div class="author-note-after">${data.noteAfterHtml}</div>`);
    return parts.join('\n');
  }

  resolveUrl(path: string, isNovel?: boolean): string {
    if (isNovel) return `${SITE}/series/${path}`;
    const { slug, number } = splitChapterPath(path);
    return `${SITE}/novels/${slug}/ch-${displayNumber(number)}`;
  }
}

export default new StonescapePlugin();
