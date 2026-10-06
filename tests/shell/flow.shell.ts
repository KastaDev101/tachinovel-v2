/**
 * Full stack on the PC: built v1 UI (unchanged) + v2 Capacitor transport + Capacitor's native-bridge.js
 * + the built core in a JSC-like vm. Browse a declarative source → novel → read → "Listen".
 * Screenshots: .cache/shell-shots/*.png
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import type { Route } from '../helpers/native-mock.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'shell-shots');
const fx = (n: string): string => readFileSync(path.join(root, 'tests', 'fixtures', 'demo-site', n), 'utf8');
const SITE = 'https://novels.example.test/';
const routes: Record<string, Route> = {
  [`${SITE}popular?page=1`]: { body: fx('popular.html') },
  [`${SITE}popular?page=2`]: { body: '<html><body></body></html>' },
  [`${SITE}latest?page=1`]: { body: fx('popular.html') },
  [`${SITE}novel/alpha`]: { body: fx('novel-alpha.html') },
  [`${SITE}novel/alpha/1`]: { body: fx('chapter-alpha-1.html') },
  [`${SITE}novel/alpha/2`]: { body: '<html><body><div id="content"><p>Chapter 2 - The Hall</p><p>The hall was long and very quiet tonight.</p></div></body></html>' },
};

let shell: PcShell;

const top = () => shell.page.locator('.nav-root > .layer').last();
const waitStack = (n: number) =>
  shell.page.waitForFunction((d) => document.querySelectorAll('.nav-root > .layer').length === d && !document.querySelector('.nav-root.is-animating'), n);

describe('v1 UI in the v2 shell (PC)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({
      wwwDir: www,
      core: { routes, answers: [0, 0, 0, 0] },
      beforeLoad: async (core) => {
        await core.call('sources.install', { code: fx('spec.json') });
      },
      // v1's one-time reader tips overlay (3a25883+) would cover the reader in this test.
      initStorage: { 'tachinovel.tips.reader': '1' },
    });
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('boots through Core.call, shows v1 onboarding on first run, paints the library', async () => {
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    // First run with an empty library: v1 (3a25883+) shows onboarding. Skip it like a user would.
    await shell.page.getByTestId('onboarding').waitFor({ timeout: 5000 });
    await shell.page.screenshot({ path: path.join(shots, '0-onboarding.png') });
    await shell.page.getByTestId('onboarding-skip').click();
    await shell.page.getByTestId('onboarding').waitFor({ state: 'detached', timeout: 5000 });
    await shell.page.screenshot({ path: path.join(shots, '1-library.png') });
    // The splash is hidden once app.boot went through the Capacitor bridge.
    await expect.poll(() => shell.pluginCalls.some((c) => c.pluginId === 'SplashScreen' && c.methodName === 'hide'), { timeout: 5000 }).toBe(true);
  });

  it('browses the declarative source and opens a novel', async () => {
    await shell.page.getByTestId('tab-browse').click();
    await shell.page.getByTestId('source-demo-library').first().click();
    await waitStack(2);
    const card = shell.page.locator('[data-testid="browse-grid"] .grid-hit').first();
    await expect.poll(() => card.getAttribute('aria-label'), { timeout: 15_000 }).toBe('Alpha Story');
    await shell.page.screenshot({ path: path.join(shots, '2-browse.png') });
    await card.click();
    await waitStack(3);
    await expect.poll(() => top().getByTestId('novel-title').textContent(), { timeout: 15_000 }).toBe('Alpha Story');
    await expect.poll(() => top().getByTestId('chapter-row').count()).toBe(3);
    await shell.page.screenshot({ path: path.join(shots, '3-novel.png') });
  });

  it('reads chapter 1 (sanitized, hidden anti-theft line removed) and offers Listen', async () => {
    await top().getByTestId('resume').click();
    await waitStack(4);
    const body = shell.page.locator('[data-testid="reader-chapter"][data-status="ready"] [data-testid="reader-body"]').first();
    await body.waitFor({ timeout: 15_000 });
    const text = (await body.textContent()) ?? '';
    expect(text).toContain('Nobody answered');
    expect(text).not.toContain('stolen');
    await shell.page.locator('.tn-listen').waitFor({ state: 'visible', timeout: 5000 });
    await shell.page.screenshot({ path: path.join(shots, '4-reader.png') });
    await shell.page.locator('.tn-listen').click();
    await expect.poll(() => shell.pluginCalls.find((c) => c.pluginId === 'Narration' && c.methodName === 'play')?.options).toMatchObject({
      pluginId: 'demo-library',
      novelPath: 'novel/alpha',
      chapterPath: 'novel/alpha/1',
      start: { paragraph: 0 },
    });
    const play = shell.pluginCalls.find((c) => c.pluginId === 'Narration' && c.methodName === 'play');
    const paragraphs = play?.options.paragraphs as { index: number; text: string }[];
    expect(paragraphs.length).toBeGreaterThanOrEqual(4);
    expect(paragraphs.some((p) => p.text.includes('Nobody answered'))).toBe(true);
  });

  it('saved reading progress through the core', async () => {
    await shell.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect
      .poll(async () => {
        const r = await shell.core.call<{ chapterPath: string }[]>('history.list', { limit: 5 });
        return r[0]?.chapterPath;
      }, { timeout: 10_000 })
      .toBe('novel/alpha/1');
  });

  it('ran without page errors', () => {
    expect(shell.pageErrors).toEqual([]);
    // Remote covers are blocked on purpose (403), so only cover errors are tolerated.
    expect(shell.consoleErrors.filter((e) => !/403|Failed to load resource|blocked/i.test(e))).toEqual([]);
  });
});
