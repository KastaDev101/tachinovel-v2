/**
 * Personal flavor: v1's LNReader plugin host + the built-in Stonescape plugin running INSIDE the v2
 * core (JSC-like vm, native mock), replaying v1's recorded HTTP fixtures (read-only from the v1 repo;
 * skipped when it isn't next to this repo, e.g. in CI).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../tools/build.ts';
import { type CoreHarness, type Route, startCoreInVm } from './helpers/native-mock.ts';

const root = path.resolve(import.meta.dirname, '..');
const fixturesDir = path.resolve(root, '..', 'tachinovel', 'tests', 'fixtures', 'http', 'stonescape.xyz');

function v1Routes(): Record<string, Route> {
  const routes: Record<string, Route> = {};
  for (const f of readdirSync(fixturesDir).filter((n) => n.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(path.join(fixturesDir, f), 'utf8')) as {
      request: { method: string; url: string };
      response: { status: number; headers: Record<string, string>; bodyBase64?: string; body?: string };
    };
    const body = j.response.bodyBase64 !== undefined ? Buffer.from(j.response.bodyBase64, 'base64').toString('utf8') : (j.response.body ?? '');
    routes[j.request.url] = { status: j.response.status, body, headers: { 'content-type': j.response.headers['content-type'] ?? 'application/json' } };
  }
  return routes;
}

describe.skipIf(!existsSync(fixturesDir))('personal flavor: v1 JS plugin host inside the v2 core', () => {
  let core: CoreHarness;

  beforeAll(async () => {
    const www = path.join(root, '.cache', 'test-www-personal-v1fx');
    await buildAll({ flavor: 'personal', ads: false, dev: false, outDir: www });
    core = startCoreInVm({ wwwDir: www, routes: v1Routes() });
  });

  afterAll(() => core?.dispose());

  it('lists Stonescape (built-in plugin from the app bundle) with real recorded data', async () => {
    const page = await core.call<{ items: { name: string; path: string }[] }>('browse.list', { pluginId: 'stonescape', page: 1, mode: 'latest' });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]?.path).toBeTruthy();
  });

  it('opens a novel and a chapter through the plugin', async () => {
    const novel = await core.call<{ details: { name: string }; chapters: { path: string; locked?: boolean }[] }>('novel.get', {
      pluginId: 'stonescape',
      path: 'the-ex-inquisitors-exorcism-broadcast',
    });
    expect(novel.details.name).toBeTruthy();
    expect(novel.chapters.length).toBeGreaterThan(0);
    const first = novel.chapters.find((c) => !c.locked);
    expect(first).toBeTruthy();
    const ch = await core.call<{ html: string }>('chapter.get', {
      pluginId: 'stonescape',
      novelPath: 'the-ex-inquisitors-exorcism-broadcast',
      chapterPath: (first as { path: string }).path,
    });
    expect(ch.html.length).toBeGreaterThan(200);
    const narration = await core.call<{ paragraphs: { text: string }[] }>('narration.chapterText', {
      pluginId: 'stonescape',
      novelPath: 'the-ex-inquisitors-exorcism-broadcast',
      chapterPath: (first as { path: string }).path,
    });
    expect(narration.paragraphs.length).toBeGreaterThan(5);
  });
});
