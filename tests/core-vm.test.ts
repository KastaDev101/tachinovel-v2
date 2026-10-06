/**
 * The BUILT core (www/core/core.js + lazy bundles) running in a bare JSC-like `vm` context with the
 * Node native mock: proves the v1 services + v2 platform + dispatcher work end to end without a
 * Mac, and that the bundle needs nothing beyond the native host API.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll, type Flavor } from '../tools/build.ts';
import { type CoreHarness, type Route, startCoreInVm } from './helpers/native-mock.ts';

const root = path.resolve(import.meta.dirname, '..');
const fx = (name: string): string => readFileSync(path.join(root, 'tests', 'fixtures', 'demo-site', name), 'utf8');
const SITE = 'https://novels.example.test/';

const routes: Record<string, Route> = {
  [`${SITE}popular?page=1`]: { body: fx('popular.html') },
  [`${SITE}search?q=alpha%20story&page=1`]: { body: fx('popular.html') },
  [`${SITE}novel/alpha`]: { body: fx('novel-alpha.html') },
  [`${SITE}novel/alpha/1`]: { body: fx('chapter-alpha-1.html') },
  [`${SITE}novel/alpha/2`]: { body: '<html><body><div id="content"><p>Chapter 2 - The Hall</p><p>The hall was long and very quiet tonight.</p></div></body></html>' },
  [`${SITE}novel/alpha/3`]: { body: fx('chapter-alpha-3.html') },
};

async function built(flavor: Flavor): Promise<string> {
  const outDir = path.join(root, '.cache', `test-www-${flavor}`);
  await buildAll({ flavor, ads: false, dev: false, outDir });
  return outDir;
}

async function waitFor(fn: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('core startup', () => {
  it('answers requests sent before core.js runs once it is ready', async () => {
    const core = startCoreInVm({ wwwDir: await built('store'), routes, deferEvaluate: true });
    try {
      const early = core.call<{ flavor: string }>('v2.info');
      const boot = core.call<{ library: unknown[] }>('app.boot');
      core.evaluate();
      await expect(early).resolves.toMatchObject({ flavor: 'store' });
      await expect(boot).resolves.toMatchObject({ library: [] });
    } finally {
      core.dispose();
    }
  });

  it('rejects every request with the reason when the core cannot start (no hanging calls)', async () => {
    const core = startCoreInVm({ wwwDir: await built('store'), routes, deferEvaluate: true, fsFault: (op, p) => op === 'mkdirp' && p.split('\\').join('/').endsWith('/local/TachiNovel') });
    try {
      const early = core.callRaw('app.boot');
      core.evaluate();
      const late = core.callRaw('library.list');
      for (const r of await Promise.all([early, late])) {
        expect(r.ok).toBe(false);
        expect(r.error?.message).toMatch(/failed to start: .*Injected mkdirp failure/);
      }
    } finally {
      core.dispose();
    }
  });
});

describe.each(['store', 'personal'] as const)('core.js in a bare JS context (%s flavor)', (flavor) => {
  let core: CoreHarness;

  beforeAll(async () => {
    const www = await built(flavor);
    // answers: install confirmation → 0 ("Install")
    core = startCoreInVm({ wwwDir: www, routes, answers: [0, 0, 0] });
    await waitFor(() => core.logs.some((l) => l.line.includes('ready')) || core.logs.some((l) => l.level === 'error'));
  });

  afterAll(() => core?.dispose());

  it('removed __native from the global scope and booted', async () => {
    expect((core.context as { __native?: unknown }).__native).toBeUndefined();
    expect(core.logs.filter((l) => l.level === 'error')).toEqual([]);
    const info = await core.call<{ flavor: string; jsPlugins: boolean }>('v2.info');
    expect(info.flavor).toBe(flavor);
    expect(info.jsPlugins).toBe(flavor === 'personal');
  });

  it('serves the v1 boot payload', async () => {
    const boot = await core.call<{ library: unknown[]; sources: { id: string; builtIn: boolean }[]; settings: { schemaVersion: number } }>('app.boot');
    expect(boot.library).toEqual([]);
    expect(boot.settings.schemaVersion).toBeGreaterThan(0);
    const builtIns = boot.sources.filter((s) => s.builtIn).map((s) => s.id);
    expect(builtIns).toEqual(flavor === 'personal' ? ['stonescape'] : []);
  });

  it('seeds the LNReader repo only in the personal flavor', async () => {
    const repos = await core.call<{ url: string }[]>('repos.list');
    expect(repos.some((r) => r.url.includes('LNReader/lnreader-plugins'))).toBe(flavor === 'personal');
  });

  it('installs a declarative source and browses, searches, opens a novel and a chapter', async () => {
    const info = await core.call<{ id: string; name: string }>('sources.install', { code: fx('spec.json') });
    expect(info).toMatchObject({ id: 'demo-library', name: 'Demo Library' });

    const page = await core.call<{ items: { path: string; name: string; cover?: string }[] }>('browse.list', { pluginId: 'demo-library', page: 1, mode: 'popular' });
    expect(page.items.map((i) => [i.path, i.name, i.cover])).toEqual([
      ['novel/alpha', 'Alpha Story', `${SITE}covers/alpha.jpg`],
      ['novel/beta?ref=list', 'Beta & Friends', 'https://cdn.example.test/beta.webp'],
    ]);

    const search = await core.call<{ items: unknown[] }>('browse.search', { pluginId: 'demo-library', query: 'alpha story', page: 1 });
    expect(search.items.length).toBe(2);

    const novel = await core.call<{ details: Record<string, unknown>; chapters: { path: string; name: string; locked?: boolean; number?: number }[] }>('novel.get', {
      pluginId: 'demo-library',
      path: 'novel/alpha',
    });
    expect(novel.details).toMatchObject({ name: 'Alpha Story', author: 'Jane Writer', status: 'ongoing', genres: ['Fantasy', 'Adventure'] });
    expect(String(novel.details.summary)).toContain('A girl finds a door.');
    expect(novel.chapters.map((c) => c.path)).toEqual(['novel/alpha/1', 'novel/alpha/2', 'novel/alpha/3']);
    expect(novel.chapters[2]?.locked).toBe(true);

    const ch = await core.call<{ html: string }>('chapter.get', { pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1' });
    expect(ch.html).toContain('Nightmare Begins');
    expect(ch.html).not.toContain('stolen');
    expect(ch.html).not.toContain('Buy now');
    expect(ch.html).not.toContain('<script');
  });

  it('builds a narration script for native TTS', async () => {
    const n = await core.call<{ paragraphs: { text: string; sentences: string[]; pause?: string }[] }>('narration.chapterText', {
      pluginId: 'demo-library',
      novelPath: 'novel/alpha',
      chapterPath: 'novel/alpha/1',
    });
    const texts = n.paragraphs.map((p) => p.pause ?? p.text);
    expect(texts[0]).toBe('Chapter 1. Nightmare Begins.');
    expect(texts[1]).toBe('"Mr. Smith?" she asked… Nobody answered!');
    expect(texts).toContain('scene');
    expect(texts).toContain('System: Aspirant awakened');
    expect(n.paragraphs[2]?.text).toBe('Well. The door — old and grey — creaked.');
    // "Well." is shorter than 12 chars: merged into the next sentence for intonation.
    expect(n.paragraphs[2]?.sentences).toEqual(['Well. The door — old and grey — creaked.']);
  });

  it('adds the sentence script (v1 front-end + the novel lexicon) for Kokoro / Apple, and stores lexicons', async () => {
    const args = { pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1' };
    type Script = { items: { text: string; paragraph: number; runs?: { t?: string; p?: string }[]; pauseMs: number; kind: string }[] };
    const before = await core.call<{ script: Script }>('narration.chapterText', args);
    expect(before.script.items[0]).toMatchObject({ text: 'Chapter 1. Nightmare Begins.', kind: 'title', paragraph: 0 });
    expect(before.script.items.some((i) => i.text.includes('Mister Smith'))).toBe(true);
    expect(before.script.items.some((i) => i.runs)).toBe(false);
    await expect(core.call('narration.lexicon.set', { novelKey: 'demo-library:novel/alpha', lexicon: { schemaVersion: 1, entries: [{ match: 'Aspirant', ipa: 'ɐspˈIɹᵊnt' }] } })).resolves.toEqual({ entries: 1 });
    await expect(core.call('narration.lexicon.set', { lexicon: { schemaVersion: 1, entries: [{ match: '', say: 'x' }] } })).rejects.toThrow(/Invalid pronunciation/);
    const after = await core.call<{ script: Script }>('narration.chapterText', args);
    const aspirant = after.script.items.find((i) => i.text.includes('Aspirant'));
    expect(aspirant?.runs?.some((r) => r.p === 'ɐspˈIɹᵊnt')).toBe(true);
    const lex = await core.call<{ global: { entries: unknown[] }; novel: { entries: { match: string }[] } | null }>('narration.lexicon.get', { novelKey: 'demo-library:novel/alpha' });
    expect(lex.global.entries).toEqual([]);
    expect(lex.novel?.entries[0]?.match).toBe('Aspirant');
    await core.call('narration.lexicon.set', { novelKey: 'demo-library:novel/alpha', lexicon: { schemaVersion: 1, entries: [] } });
    await expect(core.call('narration.lexicon.get', { novelKey: 'demo-library:novel/alpha' })).resolves.toMatchObject({ novel: null });
  });

  it('resume point for narration/CarPlay: saved paragraph, or the next chapter once finished', async () => {
    await expect(core.call('narration.resumePoint', { pluginId: 'demo-library', novelPath: 'novel/nothing' })).resolves.toBeNull();
    await core.call('progress.save', { pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1', position: { percent: 0.4, paragraph: 3, offset: 12 } });
    await expect(core.call('narration.resumePoint', { pluginId: 'demo-library', novelPath: 'novel/alpha' })).resolves.toMatchObject({ chapterPath: 'novel/alpha/1', paragraph: 3 });
    await core.call('progress.save', { pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1', position: { percent: 1, paragraph: 6, offset: 0 }, finished: true });
    await expect(core.call('narration.resumePoint', { pluginId: 'demo-library', novelPath: 'novel/alpha' })).resolves.toMatchObject({ chapterPath: 'novel/alpha/2', paragraph: 0 });
  });

  it('maps a paywalled chapter to LOCKED and never fakes content', async () => {
    const r = await core.callRaw('chapter.get', { pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/3' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('LOCKED');
  });

  it('rejects JavaScript plugins in the store flavor', async () => {
    const r = await core.callRaw('sources.install', { code: 'exports.default = { id: "x", name: "X", site: "https://x.test", version: "1" };' });
    if (flavor === 'store') {
      expect(r.ok).toBe(false);
      expect(r.error?.message).toMatch(/only supports source definitions/);
    } else {
      // Personal flavor hands JS to v1's plugin host (this stub is not a valid plugin, so it fails there).
      expect(r.ok).toBe(false);
      expect(r.error?.message).not.toMatch(/only supports source definitions/);
    }
  });

  it('answers unknown methods with UNKNOWN_METHOD and keeps serving', async () => {
    const r = await core.callRaw('nope.nothing');
    expect(r).toMatchObject({ ok: false, error: { code: 'UNKNOWN_METHOD' } });
    await expect(core.call('sources.list')).resolves.toBeInstanceOf(Array);
  });

  it('flushes on app.background and persists state to the synced store', async () => {
    await core.call('app.background');
    const registry = JSON.parse(readFileSync(path.join(core.dir, 'icloud', 'TachiNovel', 'sources', 'index.json'), 'utf8')) as { sources: { id: string }[] };
    expect(registry.sources.map((s) => s.id)).toContain('demo-library');
  });

  it('emits core events to native (updates.progress from a library update check)', async () => {
    await core.call('library.add', { novel: { pluginId: 'demo-library', path: 'novel/alpha', name: 'Alpha Story' } });
    const r = await core.call<{ newChapters: number }>('library.checkUpdates', {});
    expect(r.newChapters).toBeGreaterThanOrEqual(0);
    await waitFor(() => core.events.some((e) => e.event === 'updates.progress' && (e.payload as { finished?: boolean }).finished === true));
  });

  it('delivers deep links for installed sources as app.deepLink events', async () => {
    await expect(core.call('app.openLink', { pluginId: 'nope', novelPath: 'x' })).resolves.toEqual({ delivered: false });
    await expect(core.call('app.openLink', { pluginId: 'demo-library', novelPath: 'novel/alpha' })).resolves.toEqual({ delivered: true });
    await waitFor(() => core.events.some((e) => e.event === 'app.deepLink'));
  });

  it('runs the background-refresh entry point within its budget', async () => {
    const r = await core.call<{ checked: boolean; newChapters: number }>('updates.backgroundCheck', { budgetMs: 10_000 });
    expect(r.checked).toBe(true);
  });
});
