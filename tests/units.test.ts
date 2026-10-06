/** Unit tests for the v2-only pure modules (run in Node; no build needed). */
import { describe, expect, it } from 'vitest';
import { createDeclarativeAdapter, jsonPath, toPath } from '../src/core/declarative/engine.ts';
import { looksLikeSpec, parseSpec, SpecError, type SourceSpec } from '../src/core/declarative/spec.ts';
import { htmlToParagraphs, narrationScript, normalizeForSpeech, splitSentences } from '../src/core/narration/text.ts';
import { AdPolicy, DEFAULT_AD_POLICY, emptyAdState } from '../src/ui/monetization/ad-policy.ts';
import { allowed, FEATURES, NO_ENTITLEMENTS, remaining } from '../src/ui/monetization/entitlements.ts';
import { BridgeCallError } from '@v1/shared/contracts/protocol.ts';
import { createBridgeClient, type CoreTransport } from '../src/ui/capacitor-client.ts';
import type { PluginHostDeps } from '@v1/shared/contracts/plugin-host.ts';
import type { HttpRequest, HttpResponse } from '@v1/shared/contracts/platform.ts';
import { createNet } from '@v1/plugin-host/net.ts';

// ---------- declarative specs ----------

const MIN_SPEC = {
  format: 'tachinovel-source/1',
  id: 'api-demo',
  name: 'API Demo',
  site: 'https://api.example.test/',
  version: '1.0.0',
  minIntervalMs: 0,
  popular: { url: 'v1/series?page={page}', type: 'json', list: { item: 'data', name: { json: 'title' }, path: { json: 'slug', prefix: 'series/' }, cover: { json: 'cover' } } },
  novel: {
    url: 'v1/{path}',
    type: 'json',
    name: { json: 'title' },
    author: { json: 'author.name' },
    genres: { json: 'tags[*].name', all: true },
    status: { json: 'status' },
    chapters: {
      item: 'chapters',
      request: { url: 'v1/{path}/chapters', type: 'json' },
      name: { json: 'title' },
      path: { json: 'number', prefix: 'chapter/' },
      number: { json: 'number' },
      locked: { json: 'locked' },
    },
  },
  chapter: { url: 'v1/{path}', type: 'json', content: 'contentHtml' },
};

function fakeDeps(routes: Record<string, unknown>): PluginHostDeps & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    http: {
      async request(req: HttpRequest): Promise<HttpResponse> {
        seen.push(req.url);
        const body = routes[req.url];
        if (body === undefined) return { url: req.url, status: 404, headers: {}, body: 'nope' };
        return { url: req.url, status: 200, headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) };
      },
      async requestBytes(req: HttpRequest) {
        return { url: req.url, status: 404, headers: {}, base64: '' };
      },
    },
    storageFor: () => ({ get: () => undefined, set: () => undefined, delete: () => undefined, clearAll: () => undefined, getAllKeys: () => [] }),
    log: () => undefined,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

describe('declarative spec validation', () => {
  it('accepts a minimal JSON-API spec and recognises it', () => {
    const text = JSON.stringify(MIN_SPEC);
    expect(looksLikeSpec(text)).toBe(true);
    expect(looksLikeSpec('exports.default = {}')).toBe(false);
    expect(parseSpec(text).id).toBe('api-demo');
  });

  it('rejects bad specs with precise messages', () => {
    expect(() => parseSpec('{')).toThrow(SpecError);
    expect(() => parseSpec(JSON.stringify({ ...MIN_SPEC, site: 'http://insecure.test/' }))).toThrow(/https/);
    expect(() => parseSpec(JSON.stringify({ ...MIN_SPEC, id: 'has space' }))).toThrow(/id/);
    expect(() => parseSpec(JSON.stringify({ ...MIN_SPEC, popular: { ...MIN_SPEC.popular, list: { ...MIN_SPEC.popular.list, name: { regex: '(' } } } }))).toThrow(/regular expression/);
  });
});

describe('declarative engine (JSON API source)', () => {
  const routes = {
    'https://api.example.test/v1/series?page=1': { data: [{ title: 'Shadowed', slug: 'shadowed', cover: '/c/s.webp' }] },
    'https://api.example.test/v1/series/shadowed': { title: 'Shadowed', author: { name: 'G.' }, status: 'Completed', tags: [{ name: 'Dark' }, { name: 'Fantasy' }] },
    'https://api.example.test/v1/series/shadowed/chapters': {
      chapters: [
        { title: 'One', number: '1.00', locked: false },
        { title: 'Two', number: '2.00', locked: true },
      ],
    },
    'https://api.example.test/v1/chapter/1.00': { contentHtml: '<p>Hello</p>' },
  };

  it('lists, details, chapters (with lock flags) and chapter HTML', async () => {
    const deps = fakeDeps(routes);
    const a = createDeclarativeAdapter(parseSpec(JSON.stringify(MIN_SPEC)), deps, createNet(deps));
    const list = await a.popular(1, { latest: false });
    expect(list).toEqual([{ pluginId: 'api-demo', path: 'series/shadowed', name: 'Shadowed', cover: 'https://api.example.test/c/s.webp' }]);
    const { details, chapters } = await a.novel('series/shadowed');
    expect(details).toMatchObject({ name: 'Shadowed', author: 'G.', status: 'completed', genres: ['Dark', 'Fantasy'], chapterCount: 2 });
    expect(chapters).toEqual([
      { path: 'chapter/1.00', name: 'One', number: 1 },
      { path: 'chapter/2.00', name: 'Two', number: 2, locked: true },
    ]);
    expect(await a.chapter('chapter/1.00')).toBe('<p>Hello</p>');
    await expect(a.search('x', 1)).rejects.toThrow(/no search/);
  });

  it('json paths and site-relative paths', () => {
    expect(jsonPath({ a: { b: [{ c: 1 }, { c: 2 }] } }, 'a.b[*].c')).toEqual([1, 2]);
    expect(jsonPath({ a: [10, 20] }, 'a[1]')).toBe(20);
    expect(toPath('/x/y?z=1', 'https://s.test/')).toBe('x/y?z=1');
    expect(toPath('https://other.test/p', 'https://s.test/')).toBe('https://other.test/p');
  });

  it('honours minIntervalMs politeness between requests', async () => {
    const deps = fakeDeps(routes);
    const spec = parseSpec(JSON.stringify({ ...MIN_SPEC, minIntervalMs: 120 }));
    const a = createDeclarativeAdapter(spec as SourceSpec, deps, createNet(deps));
    const t0 = Date.now();
    await a.popular(1, { latest: false });
    await a.popular(1, { latest: false });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });
});

// ---------- narration text ----------

describe('narration text', () => {
  it('flattens blocks, splits <br><br>, skips scripts', () => {
    expect(htmlToParagraphs('<div><p>A</p><p>B<br>C<br><br>D</p><script>x</script><hr><p>E</p></div>')).toEqual(['A', 'B C', 'D', '***', 'E']);
  });
  it('normalizes text for speech', () => {
    expect(normalizeForSpeech('“Hi”... it’s - done!!!')).toBe('"Hi"… it\'s — done!');
  });
  it('keeps abbreviations and merges tiny fragments', () => {
    expect(splitSentences('Mr. Smith arrived late. Well. He sat down quietly.')).toEqual(['Mr. Smith arrived late.', 'Well. He sat down quietly.']);
  });
  it('marks scene breaks as pauses', () => {
    const s = narrationScript('<p>One sentence here.</p><p>* * *</p><p>Another sentence.</p>');
    expect(s.map((p) => p.pause ?? p.text)).toEqual(['One sentence here.', 'scene', 'Another sentence.']);
  });
});

// ---------- ads + entitlements ----------

describe('ad policy', () => {
  function setup(opts: { pro?: boolean; narrating?: boolean; sessions?: number } = {}) {
    let now = 1_000_000_000;
    const state = { ...emptyAdState(), sessions: opts.sessions ?? 1 };
    const p = new AdPolicy(DEFAULT_AD_POLICY, state, { now: () => now, isPro: () => opts.pro === true, isNarrating: () => opts.narrating === true });
    p.startSession();
    const browseThenOpen = (): boolean => {
      p.onCall('browse.list');
      p.onCall('browse.search');
      p.onCall('browse.list');
      return p.onCall('novel.get');
    };
    return { p, browseThenOpen, tick: (ms: number) => (now += ms) };
  }

  it('shows at most one interstitial per N browse→novel opens, never in the first session', () => {
    const first = setup({ sessions: 0 });
    for (let i = 0; i < 6; i++) expect(first.browseThenOpen()).toBe(false);
    const { p, browseThenOpen } = setup();
    expect([browseThenOpen(), browseThenOpen(), browseThenOpen()]).toEqual([false, false, true]);
    p.recordShown();
    expect(browseThenOpen()).toBe(false);
  });

  it('never right after reading, never while narrating, never for Pro', () => {
    const a = setup();
    a.p.onCall('chapter.get');
    expect([a.browseThenOpen(), a.browseThenOpen(), a.browseThenOpen()]).toEqual([false, false, false]);
    a.tick(DEFAULT_AD_POLICY.readingQuietMs + 1);
    expect(a.browseThenOpen()).toBe(true);
    const n = setup({ narrating: true });
    expect([n.browseThenOpen(), n.browseThenOpen(), n.browseThenOpen()]).toEqual([false, false, false]);
    const pro = setup({ pro: true });
    expect([pro.browseThenOpen(), pro.browseThenOpen(), pro.browseThenOpen()]).toEqual([false, false, false]);
    expect(pro.p.rewardedAvailable()).toBe(false);
  });

  it('enforces the minimum gap and the daily cap', () => {
    const { p, browseThenOpen, tick } = setup();
    let shown = 0;
    for (let i = 0; i < 200; i++) {
      tick(60_000);
      if (browseThenOpen()) {
        p.recordShown();
        shown++;
      }
    }
    // 200 minutes of continuous browsing: gap 12 min and 4/day cap → 4.
    expect(shown).toBe(DEFAULT_AD_POLICY.maxPerDay);
  });

  it('opening a novel from the library (no browse burst) never triggers an ad', () => {
    const { p } = setup();
    for (let i = 0; i < 10; i++) expect(p.onCall('novel.get')).toBe(false);
  });
});

describe('entitlements', () => {
  it('free users keep reading and sources; Pro unlocks extras', () => {
    expect(allowed('reading', NO_ENTITLEMENTS)).toBe(true);
    expect(allowed('sources', NO_ENTITLEMENTS)).toBe(true);
    expect(allowed('adFree', NO_ENTITLEMENTS)).toBe(false);
    expect(allowed('adFree', { pro: true, source: 'lifetime' })).toBe(true);
    expect(remaining('hdVoices', NO_ENTITLEMENTS, 10)).toBe(20);
    expect(remaining('hdVoices', { pro: true, source: 'subscription' }, 1000)).toBe(Number.POSITIVE_INFINITY);
  });
  it('never gates access to third-party content', () => {
    expect(FEATURES.sources.tier).toBe('free');
    expect(FEATURES.reading.tier).toBe('free');
  });
});

// ---------- bridge client ----------

function fakeTransport(handler: (req: { id: number; method: string; args: unknown }) => Promise<unknown> | 'hang') {
  let emit: ((e: string, p: string) => void) | null = null;
  const t: CoreTransport & { push(e: string, p: unknown): void } = {
    call(json) {
      const req = JSON.parse(json) as { id: number; method: string; args: unknown };
      const r = handler(req);
      if (r === 'hang') return new Promise(() => undefined);
      return r.then(
        (result) => JSON.stringify({ kind: 'res', id: req.id, ok: true, result }),
        (err: Error) => JSON.stringify({ kind: 'res', id: req.id, ok: false, error: { code: 'NETWORK', message: err.message, retryable: true } }),
      );
    },
    onEvent(fn) {
      emit = fn;
    },
    push(e, p) {
      emit?.(e, JSON.stringify(p));
    },
  };
  return t;
}

describe('capacitor bridge client', () => {
  it('runs calls concurrently and maps errors', async () => {
    const order: string[] = [];
    const t = fakeTransport(async (req) => {
      const ms = req.method === 'browse.list' ? 30 : 5;
      await new Promise((r) => setTimeout(r, ms));
      order.push(req.method);
      if (req.method === 'chapter.get') throw new Error('offline');
      return { m: req.method };
    });
    const c = createBridgeClient({ transport: t });
    const slow = c.call('browse.list', { pluginId: 'x', page: 1, mode: 'popular' });
    const fast = c.call('sources.list');
    await expect(fast).resolves.toEqual({ m: 'sources.list' });
    await expect(slow).resolves.toEqual({ m: 'browse.list' });
    expect(order).toEqual(['sources.list', 'browse.list']);
    const err = await c.call('chapter.get', { pluginId: 'p', novelPath: 'n', chapterPath: 'c' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeCallError);
    expect((err as BridgeCallError).code).toBe('NETWORK');
  });

  it('times out hung calls and delivers events', async () => {
    const t = fakeTransport(() => 'hang');
    const c = createBridgeClient({ transport: t });
    const err = await c.call('sources.list', undefined, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect((err as BridgeCallError).code).toBe('TIMEOUT');
    const got: unknown[] = [];
    const off = c.on('updates.progress', (p) => got.push(p));
    t.push('updates.progress', { done: 1, total: 2, newChapters: 0, finished: false });
    off();
    t.push('updates.progress', { done: 2, total: 2, newChapters: 0, finished: true });
    expect(got).toEqual([{ done: 1, total: 2, newChapters: 0, finished: false }]);
  });
});
