/**
 * A deterministic, synthetic "internet" for the UI crawler (tests/crawler). Everything the core fetches
 * is answered here, so the crawl never touches the network and every run sees the same data:
 *
 *  - https://novels.example.test/   an HTML novel site read by a declarative source spec ("Demo Library");
 *  - https://stonescape.xyz/api/…   the JSON API the built-in Stonescape plugin uses (personal flavor);
 *  - LNReader's repository index    a tiny index whose plugins are small CommonJS LNReader plugins;
 *  - covers and icons               generated PNGs (solid gradients), so screenshots show real covers.
 *
 * All titles, authors and texts are invented. `publish()` releases extra chapters so the seed can
 * produce Updates entries the same way a real update check would.
 */
import { deflateSync, crc32 } from 'node:zlib';
import type { NativeHttpRequest } from '../../src/core/native-api.ts';
import type { Route } from '../helpers/native-mock.ts';

/** The crawl's "now": every clock (page, core, generated dates) starts here. */
export const FIXED_NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

export const DEMO_SITE = 'https://novels.example.test/';
export const STONESCAPE = 'https://stonescape.xyz';
export const LNREADER_REPO = 'https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json';
const REPO_PLUGINS = 'https://plugins.example.test/';

/** Small seeded PRNG (mulberry32) so generated text is identical on every run and every OS. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- PNG covers

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** A w×h RGB PNG with a vertical gradient from `top` to `bottom` and a lighter band (a "title"). */
export function gradientPng(w: number, h: number, top: [number, number, number], bottom: [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const f = y / Math.max(1, h - 1);
    const band = y > h * 0.62 && y < h * 0.7;
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      for (let c = 0; c < 3; c++) {
        const v = Math.round((top[c] as number) * (1 - f) + (bottom[c] as number) * f);
        raw[i + c] = band && x > w * 0.12 && x < w * 0.88 ? Math.min(255, v + 90) : v;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- novels

export interface FakeChapter {
  n: number;
  title: string;
  /** ISO date. */
  date: string;
  locked: boolean;
}

export interface FakeNovel {
  slug: string;
  name: string;
  author: string;
  status: 'ongoing' | 'completed' | 'hiatus';
  genres: string[];
  summary: string[];
  /** Chapters released right now (grows with publish()). */
  chapters: FakeChapter[];
  /** Chapters held back until publish() (become Updates). */
  pending: FakeChapter[];
  colors: [[number, number, number], [number, number, number]];
}

const WORDS =
  'the a door lantern road river night city old quiet storm silver map harbor tower glass winter ember shadow letter bell bridge forest garden market station signal ' +
  'she he they walked waited listened opened closed remembered whispered laughed counted carried followed turned watched answered ' +
  'slowly again before after under over beyond inside outside almost never always suddenly finally'.split(' ').join(' ');
const WORD_LIST = WORDS.split(/\s+/);

function sentence(r: () => number): string {
  const n = 6 + Math.floor(r() * 12);
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(WORD_LIST[Math.floor(r() * WORD_LIST.length)] as string);
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + (r() < 0.15 ? '?' : '.');
}

function paragraph(r: () => number): string {
  const n = 2 + Math.floor(r() * 4);
  return Array.from({ length: n }, () => sentence(r)).join(' ');
}

const DAY = 86_400_000;

interface NovelSeed {
  slug: string;
  name: string;
  author: string;
  status: FakeNovel['status'];
  genres: string[];
  chapters: number;
  locked?: number;
  pending?: number;
}

/** Demo Library (HTML site). Titles exercise wrapping: one very long title, accents, an ampersand. */
const DEMO_SEEDS: NovelSeed[] = [
  { slug: 'alpha', name: 'Alpha Story', author: 'Jane Writer', status: 'ongoing', genres: ['Fantasy', 'Adventure'], chapters: 24, locked: 2, pending: 2 },
  { slug: 'lantern', name: 'The Lantern Keeper', author: 'Mara Ellison', status: 'ongoing', genres: ['Fantasy', 'Mystery'], chapters: 60, pending: 3 },
  { slug: 'seven-moons', name: 'Beneath Seven Moons', author: 'Tomas Reyes', status: 'completed', genres: ['Sci-Fi', 'Adventure'], chapters: 40 },
  { slug: 'ashes', name: 'Ashes of the Old Kingdom', author: 'R. Okafor', status: 'ongoing', genres: ['Fantasy', 'Drama', 'Romance'], chapters: 120, pending: 1 },
  {
    slug: 'cartographer',
    name: 'The Cartographer Who Mapped Every Forgotten Road in the Northern Wastes and Never Once Got Lost',
    author: 'Ilse Brandvold-Marchetti',
    status: 'hiatus',
    genres: ['Adventure', 'Slice of Life'],
    chapters: 12,
  },
  { slug: 'cafe-etoile', name: 'Café Étoile', author: 'Noémie Laurent', status: 'completed', genres: ['Romance', 'Comedy'], chapters: 18 },
  { slug: 'iron-ivy', name: 'Iron & Ivy', author: 'Dev Patel', status: 'ongoing', genres: ['Sci-Fi', 'Romance'], chapters: 30, locked: 3 },
  { slug: 'signal-lost', name: 'Signal Lost', author: 'K. Morrow', status: 'ongoing', genres: ['Horror', 'Mystery', 'Sci-Fi'], chapters: 9 },
  { slug: 'quiet-harbor', name: 'Quiet Harbor', author: 'Ana Sousa', status: 'completed', genres: ['Slice of Life', 'Drama'], chapters: 6 },
  { slug: 'zero-hour', name: 'Zero Hour', author: 'Sam Achebe', status: 'ongoing', genres: ['Action', 'Sci-Fi'], chapters: 15 },
];

/** Stonescape (JSON API). */
const STONE_SEEDS: NovelSeed[] = [
  { slug: 'shadow-tide', name: 'Shadow Tide', author: 'Guiltythree-like Author', status: 'ongoing', genres: ['action', 'fantasy', 'mystery'], chapters: 80, locked: 5, pending: 2 },
  { slug: 'glass-orchard', name: 'The Glass Orchard', author: 'Hana Ito', status: 'completed', genres: ['romance', 'drama'], chapters: 25 },
  { slug: 'bellfounder', name: 'Bellfounder', author: 'Pieter Vos', status: 'ongoing', genres: ['fantasy', 'adventure'], chapters: 33, locked: 2 },
  { slug: 'winter-station', name: 'Winter Station', author: 'L. Haddad', status: 'hiatus', genres: ['sci-fi', 'psychological'], chapters: 14 },
  { slug: 'ember-court', name: 'Ember Court', author: 'Yuki Tanaka', status: 'ongoing', genres: ['fantasy', 'romance', 'martialarts'], chapters: 48 },
];

function buildNovel(s: NovelSeed, r: () => number, idx: number): FakeNovel {
  const total = s.chapters + (s.pending ?? 0);
  const all: FakeChapter[] = [];
  for (let n = 1; n <= total; n++) {
    const title = WORD_LIST[Math.floor(r() * WORD_LIST.length)] as string;
    // Newest chapter released "yesterday" (pending ones: today), one chapter per day before that.
    const daysAgo = s.chapters - n + 1;
    all.push({ n, title: title.charAt(0).toUpperCase() + title.slice(1), date: new Date(FIXED_NOW - daysAgo * DAY - idx * 3_600_000).toISOString(), locked: false });
  }
  const released = all.slice(0, s.chapters);
  for (let i = 0; i < (s.locked ?? 0); i++) {
    const c = released[released.length - 1 - i];
    if (c) c.locked = true;
  }
  const hue = (idx * 47) % 360;
  const rgb = (h: number, l: number): [number, number, number] => {
    const a = 0.55 * Math.min(l, 1 - l);
    const f = (k: number): number => Math.round(255 * (l - a * Math.max(-1, Math.min((k + h / 30) % 12 - 3, 9 - ((k + h / 30) % 12), 1))));
    return [f(0), f(8), f(4)];
  };
  return {
    slug: s.slug,
    name: s.name,
    author: s.author,
    status: s.status,
    genres: s.genres,
    summary: [paragraph(r), paragraph(r)],
    chapters: released,
    pending: all.slice(s.chapters),
    colors: [rgb(hue, 0.55), rgb((hue + 40) % 360, 0.22)],
  };
}

export interface FakeWeb {
  readonly demo: FakeNovel[];
  readonly stone: FakeNovel[];
  /** The Demo Library declarative source spec (JSON text for sources.install). */
  readonly demoSpec: string;
  /** Release the held-back chapters (the next update check finds them). */
  publish(): void;
  /** Answer one core HTTP request. */
  route(req: NativeHttpRequest): Route;
  /** URLs requested that had no route (reported by the crawler; should stay empty). */
  readonly misses: string[];
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function chapterParagraphs(novel: FakeNovel, n: number): string[] {
  const r = prng(n * 7919 + novel.slug.length * 104_729 + novel.slug.charCodeAt(0));
  const count = 8 + Math.floor(r() * 10);
  const out = [`Chapter ${n} - ${novel.chapters[n - 1]?.title ?? novel.pending.find((c) => c.n === n)?.title ?? ''}`];
  for (let i = 0; i < count; i++) {
    out.push(paragraph(r));
    if (i === 4) out.push('***');
  }
  return out;
}

const DEMO_SPEC = {
  format: 'tachinovel-source/1',
  id: 'demo-library',
  name: 'Demo Library',
  site: DEMO_SITE,
  version: '1.0.0',
  lang: 'English',
  attribution: 'Synthetic test site (tests only)',
  minIntervalMs: 0,
  popular: {
    url: 'popular?page={page}',
    list: { item: '.novel-item', name: 'a.title', path: { selector: 'a.title', attr: 'href' }, cover: { selector: 'img', attr: 'src' } },
  },
  latest: { url: 'latest?page={page}' },
  search: { url: 'search?q={query}&page={page}' },
  novel: {
    url: '{path}',
    name: 'h1.novel-title',
    cover: { selector: '.cover img', attr: 'src' },
    author: '.author a',
    summary: { selector: '.summary', html: true },
    status: { selector: '.status', map: { Publishing: 'ongoing', Finished: 'completed', Paused: 'hiatus' } },
    genres: { selector: '.tags a', all: true },
    chapters: {
      item: 'ul.chapters li',
      name: 'a',
      path: { selector: 'a', attr: 'href' },
      releaseTime: { selector: 'time', attr: 'datetime' },
      locked: { selector: '.lock' },
      order: 'desc',
    },
  },
  chapter: { url: '{path}', content: '#content', remove: ['.ad'], removeHiddenByStyle: true, lockedWhen: { selector: '.paywall' } },
};

/** A minimal LNReader plugin (CommonJS) with static data, served by the fake repo. */
function lnreaderPluginCode(id: string, name: string, version: string): string {
  return `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var novelStatus = require("@libs/novelStatus");
var P = function () {
  this.id = ${JSON.stringify(id)}; this.name = ${JSON.stringify(name)}; this.version = ${JSON.stringify(version)};
  this.site = "https://${id}.example.test/"; this.icon = "";
};
P.prototype.popularNovels = async function (page) {
  if (page > 1) return [];
  return [{ name: ${JSON.stringify(`${name} Sampler`)}, path: "n/1" }, { name: "Paper Kites", path: "n/2" }];
};
P.prototype.searchNovels = async function (term, page) {
  if (page > 1) return [];
  return [{ name: ${JSON.stringify(`${name} Sampler`)}, path: "n/1" }].filter(function (n) { return n.name.toLowerCase().indexOf(String(term).toLowerCase()) >= 0; });
};
P.prototype.parseNovel = async function (path) {
  return { path: path, name: path === "n/2" ? "Paper Kites" : ${JSON.stringify(`${name} Sampler`)}, author: "Test Author",
    status: novelStatus.NovelStatus.Ongoing, genres: "Fantasy, Adventure", summary: "A short synthetic novel.",
    chapters: [1, 2, 3].map(function (n) { return { name: "Chapter " + n, path: path + "/" + n, releaseTime: "2026-10-0" + n }; }) };
};
P.prototype.parseChapter = async function (path) { return "<p>Synthetic chapter " + path + ".</p><p>It is short.</p>"; };
exports.default = new P();
`;
}

const REPO_INDEX = [
  { id: 'qa-scrolls', name: 'QA Scrolls', site: 'https://qa-scrolls.example.test/', lang: 'English', version: '1.2.0', url: `${REPO_PLUGINS}qa-scrolls.js`, iconUrl: `${REPO_PLUGINS}qa-scrolls.png` },
  { id: 'qa-lanterns', name: 'QA Lanterns', site: 'https://qa-lanterns.example.test/', lang: 'English', version: '0.9.1', url: `${REPO_PLUGINS}qa-lanterns.js`, iconUrl: `${REPO_PLUGINS}qa-lanterns.png` },
  { id: 'qa-ecrits', name: 'QA Écrits', site: 'https://qa-ecrits.example.test/', lang: 'French', version: '2.0.0', url: `${REPO_PLUGINS}qa-ecrits.js` },
];

export function createFakeWeb(seed = 1): FakeWeb {
  const r = prng(seed);
  const demo = DEMO_SEEDS.map((s, i) => buildNovel(s, r, i));
  const stone = STONE_SEEDS.map((s, i) => buildNovel(s, r, i + DEMO_SEEDS.length));
  const misses: string[] = [];
  const pngCache = new Map<string, Buffer>();
  const png = (key: string, novel?: FakeNovel): Buffer => {
    let b = pngCache.get(key);
    if (!b) {
      const colors = novel?.colors ?? [
        [90, 100, 190],
        [30, 30, 60],
      ];
      b = novel ? gradientPng(120, 180, colors[0], colors[1]) : gradientPng(64, 64, colors[0], colors[1]);
      pngCache.set(key, b);
    }
    return b;
  };
  const image = (b: Buffer): Route => ({ status: 200, bytes: b, headers: { 'content-type': 'image/png' } });
  const html = (body: string): Route => ({ status: 200, body });
  const json = (v: unknown, status = 200): Route => ({ status, body: JSON.stringify(v), headers: { 'content-type': 'application/json; charset=utf-8' } });

  const novelItemHtml = (n: FakeNovel): string =>
    `<div class="novel-item"><a class="title" href="/novel/${n.slug}">${esc(n.name)}</a><img src="/covers/${n.slug}.png"></div>`;
  const demoList = (list: FakeNovel[], page: number): Route => html(`<!doctype html><html><body>${page === 1 ? list.map(novelItemHtml).join('\n') : ''}</body></html>`);
  const lastDate = (n: FakeNovel): string => n.chapters[n.chapters.length - 1]?.date ?? '';

  function demoRoute(url: URL): Route | null {
    const p = url.pathname;
    const page = Number(url.searchParams.get('page') ?? '1');
    if (p === '/popular') return demoList(demo, page);
    if (p === '/latest') return demoList([...demo].sort((a, b) => lastDate(b).localeCompare(lastDate(a))), page);
    if (p === '/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return demoList(
        demo.filter((n) => n.name.toLowerCase().includes(q) || n.author.toLowerCase().includes(q)),
        page,
      );
    }
    let m = /^\/covers\/([a-z0-9-]+)\.png$/.exec(p);
    if (m) {
      const n = demo.find((x) => x.slug === m?.[1]);
      return n ? image(png(`demo:${n.slug}`, n)) : null;
    }
    m = /^\/novel\/([a-z0-9-]+)$/.exec(p);
    if (m) {
      const n = demo.find((x) => x.slug === m?.[1]);
      if (!n) return { status: 404, body: 'not found' };
      const status = n.status === 'completed' ? 'Finished' : n.status === 'hiatus' ? 'Paused' : 'Publishing';
      const chapters = [...n.chapters]
        .reverse()
        .map((c) => `<li><a href="/novel/${n.slug}/${c.n}">Chapter ${c.n} - ${esc(c.title)}</a>${c.locked ? '<span class="lock">coins</span>' : ''}<time datetime="${c.date.slice(0, 10)}">${c.date.slice(0, 10)}</time></li>`)
        .join('\n');
      return html(`<!doctype html><html><body>
<div class="cover"><img src="/covers/${n.slug}.png"></div>
<h1 class="novel-title">${esc(n.name)}</h1>
<div class="author">by <a href="/u/${n.slug}">${esc(n.author)}</a></div>
<div class="status">${status}</div>
<div class="tags">${n.genres.map((g) => `<a>${esc(g)}</a>`).join('')}</div>
<div class="summary">${n.summary.map((s) => `<p>${esc(s)}</p>`).join('')}</div>
<ul class="chapters">${chapters}</ul>
</body></html>`);
    }
    m = /^\/novel\/([a-z0-9-]+)\/(\d+)$/.exec(p);
    if (m) {
      const n = demo.find((x) => x.slug === m?.[1]);
      const c = n?.chapters.find((x) => x.n === Number(m?.[2]));
      if (!n || !c) return { status: 404, body: 'not found' };
      if (c.locked) return html('<html><body><div class="paywall">Unlock with coins</div></body></html>');
      const ps = chapterParagraphs(n, c.n).map((t) => `<p>${esc(t)}</p>`);
      ps.splice(3, 0, '<p class="x9z">This story was stolen from its original site.</p><div class="ad">Buy now</div>');
      return html(`<!doctype html><html><head><style>.x9z { display: none; }</style></head><body><div id="content">${ps.join('\n')}</div></body></html>`);
    }
    return null;
  }

  const seriesJson = (n: FakeNovel): Record<string, unknown> => ({
    slug: n.slug,
    title: n.name,
    coverUrl: `/pub/covers/${n.slug}.webp`,
    author: n.author,
    description: n.summary.join('\n\n'),
    publicationStatus: n.status,
    genres: n.genres,
    contentType: 'novel',
    averageRating: '4.40',
    chapterCount: n.chapters.length,
  });

  function stoneRoute(url: URL): Route | null {
    const p = url.pathname;
    if (p === '/logo.png') return image(png('stone:logo'));
    const ill = /^\/pub\/illustrations\/([a-z0-9-]+)-(\d+)\.png$/.exec(p);
    if (ill) return image(png(`stone:ill:${ill[1]}:${ill[2]}`, stone.find((x) => x.slug === ill[1])));
    let m = /^\/pub\/covers\/([a-z0-9-]+)\.webp$/.exec(p);
    if (m) {
      const n = stone.find((x) => x.slug === m?.[1]);
      return n ? image(png(`stone:${n.slug}`, n)) : null;
    }
    if (p === '/api/series') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const search = (url.searchParams.get('search') ?? '').toLowerCase();
      const status = url.searchParams.get('status') ?? '';
      const genres = (url.searchParams.get('genres') ?? '').split(',').filter(Boolean);
      let list = stone.filter((n) => (!search || n.name.toLowerCase().includes(search)) && (!status || n.status === status) && genres.every((g) => n.genres.includes(g)));
      const sort = url.searchParams.get('sort');
      if (sort === 'title') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
      else if (sort === 'title_desc') list = [...list].sort((a, b) => b.name.localeCompare(a.name));
      else if (!sort) list = [...list].sort((a, b) => lastDate(b).localeCompare(lastDate(a)));
      return json({ data: page === 1 ? list.map(seriesJson) : [], pagination: { page, totalPages: 1 } });
    }
    m = /^\/api\/series\/by-slug\/([a-z0-9-]+)(\/chapters(?:\/([0-9.]+)\/novel-content)?)?$/.exec(p);
    if (m) {
      const n = stone.find((x) => x.slug === m?.[1]);
      if (!n) return json({ message: 'Not found' }, 404);
      if (!m[2]) return json(seriesJson(n));
      if (!m[3])
        return json({
          chapters: n.chapters.map((c) => ({
            chapterNumber: `${c.n}.00`,
            title: c.title,
            status: 'published',
            publishedAt: c.date,
            accessMode: c.locked ? 'coins' : 'free',
            coinPrice: c.locked ? 30 : 0,
            locked: c.locked,
            isFreeNow: !c.locked,
          })),
        });
      const c = n.chapters.find((x) => `${x.n}.00` === m?.[3]);
      if (!c) return json({ message: 'Not found' }, 404);
      if (c.locked) return json({ paywalled: true }, 402);
      return json({
        contentHtml: chapterParagraphs(n, c.n).map((t) => `<p>${esc(t)}</p>`).join('\n'),
        isFreeNow: true,
        noteAfterHtml: c.n === 1 ? '<p>Thanks for reading!</p>' : null,
        // Every fifth chapter has an illustration (the reader gets it through the core: images.fetch).
        illustrations: c.n % 5 === 0 ? [{ pageId: c.n, pageNumber: 1, imageUrl: `/pub/illustrations/${n.slug}-${c.n}.png` }] : [],
      });
    }
    return null;
  }

  function repoRoute(url: URL): Route | null {
    const m = /^\/(qa-[a-z]+)\.(js|png)$/.exec(url.pathname);
    const item = m ? REPO_INDEX.find((x) => x.id === m[1]) : undefined;
    if (!m || !item) return null;
    if (m[2] === 'png') return image(png(`repo:${item.id}`));
    return { status: 200, body: lnreaderPluginCode(item.id, item.name, item.version), headers: { 'content-type': 'text/javascript' } };
  }

  return {
    demo,
    stone,
    demoSpec: JSON.stringify(DEMO_SPEC),
    misses,
    publish() {
      for (const n of [...demo, ...stone]) {
        n.chapters.push(...n.pending.splice(0));
      }
    },
    route(req) {
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        misses.push(req.url);
        return { status: 400, body: 'bad url' };
      }
      let res: Route | null = null;
      if (req.url === LNREADER_REPO) res = json(REPO_INDEX);
      else if (url.origin === new URL(DEMO_SITE).origin) res = demoRoute(url);
      else if (url.origin === STONESCAPE) res = stoneRoute(url);
      else if (url.origin === new URL(REPO_PLUGINS).origin) res = repoRoute(url);
      if (res) return res;
      misses.push(`${req.method ?? 'GET'} ${req.url}`);
      return { status: 404, body: 'not found' };
    },
  };
}
