/**
 * WebContent recovery (src/ui/native/recovery.ts + WebContentRecovery.swift): when iOS kills the web
 * view's content process, Capacitor reloads the page; the reloaded UI must land on the screen the user
 * was on (here: the reader, on the same chapter), not on a blank page or the library. A normal reload
 * (no termination reported) starts on the library as usual.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import type { Route } from '../helpers/native-mock.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const fx = (n: string): string => readFileSync(path.join(root, 'tests', 'fixtures', 'demo-site', n), 'utf8');
const SITE = 'https://novels.example.test/';
const routes: Record<string, Route> = {
  [`${SITE}popular?page=1`]: { body: fx('popular.html') },
  [`${SITE}popular?page=2`]: { body: '<html><body></body></html>' },
  [`${SITE}latest?page=1`]: { body: fx('popular.html') },
  [`${SITE}novel/alpha`]: { body: fx('novel-alpha.html') },
  [`${SITE}novel/alpha/1`]: { body: fx('chapter-alpha-1.html') },
};

let shell: PcShell;
const layers = () => shell.page.locator('.nav-root > .layer');
const waitStack = (n: number) =>
  shell.page.waitForFunction((d) => document.querySelectorAll('.nav-root > .layer').length === d && !document.querySelector('.nav-root.is-animating'), n);
const readerReady = () => shell.page.locator('[data-testid="reader-chapter"][data-status="ready"]').first();

describe('recovery after the web content process was killed', () => {
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-recovery');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({
      wwwDir: www,
      core: { routes, answers: [0, 0, 0, 0] },
      beforeLoad: async (core) => {
        await core.call('sources.install', { code: fx('spec.json') });
      },
      initStorage: { 'tachinovel.tips.reader': '1' },
    });
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    await shell.page.getByTestId('onboarding-skip').click();
    // Browse → source → novel → read chapter 1.
    await shell.page.getByTestId('tab-browse').click();
    await shell.page.getByTestId('source-demo-library').first().click();
    await waitStack(2);
    await shell.page.locator('[data-testid="browse-grid"] .grid-hit').first().click();
    await waitStack(3);
    await layers().last().getByTestId('chapter-row').nth(2).waitFor({ timeout: 15_000 });
    await layers().last().getByTestId('resume').click();
    await waitStack(4);
    await readerReady().waitFor({ timeout: 15_000 });
    await shell.page.waitForTimeout(600); // the screen stack is saved 250 ms after it changes
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('reopens the reader on the same chapter when native reports a termination', async () => {
    shell.pluginReplies.set('TachiNative.consumeRecovery', () => ({ terminations: 1 }));
    await shell.page.reload();
    await waitStack(4);
    await readerReady().waitFor({ timeout: 15_000 });
    expect(await layers().last().getAttribute('class')).toContain('layer-reader');
    expect((await readerReady().textContent()) ?? '').toContain('Nobody answered');
    expect(shell.pageErrors).toEqual([]);
  });

  it('a normal reload starts on the library', async () => {
    shell.pluginReplies.set('TachiNative.consumeRecovery', () => ({ terminations: 0 }));
    await shell.page.reload();
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    await shell.page.waitForTimeout(800);
    expect(await layers().count()).toBe(1);
  });
});
