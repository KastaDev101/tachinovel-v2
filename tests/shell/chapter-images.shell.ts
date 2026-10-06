/**
 * Chapter illustrations the page can't load directly (CORP, hotlink checks, here: an unreachable host)
 * are fetched by the core (v1 images.fetch) and loaded from "cache/img-<hash>.<ext>", relative to the
 * page. On iOS that path is served by TachiRouter (MainViewController.swift); the PC shell's server
 * mirrors it. Without the route the image silently collapses (v1 hides failed images).
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
const IMAGE = 'https://images.example.test/door.bmp';

/**
 * A 1×1 24-bit BMP whose bytes are all < 0x80, so it survives the mock's string bodies unchanged.
 * Header (14) + BITMAPINFOHEADER (40) + one padded pixel row (4) = 58 bytes.
 */
const BMP = String.fromCharCode(
  ...[0x42, 0x4d, 58, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0],
  ...[40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 24, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0x13, 0x0b, 0, 0, 0x13, 0x0b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ...[0x40, 0x50, 0x60, 0],
);

const routes: Record<string, Route> = {
  [`${SITE}popular?page=1`]: { body: fx('popular.html') },
  [`${SITE}popular?page=2`]: { body: '<html><body></body></html>' },
  [`${SITE}latest?page=1`]: { body: fx('popular.html') },
  [`${SITE}novel/alpha`]: { body: fx('novel-alpha.html') },
  [`${SITE}novel/alpha/1`]: {
    body: `<html><body><div id="content"><p>Chapter 1 - The Door</p><p>The door was painted blue.</p><p><img src="${IMAGE}" width="1" height="1" alt="the door"></p><p>Nobody answered.</p></div></body></html>`,
  },
  [IMAGE]: { body: BMP, headers: { 'content-type': 'image/bmp' } },
};

let shell: PcShell;
const top = () => shell.page.locator('.nav-root > .layer').last();
const waitStack = (n: number) =>
  shell.page.waitForFunction((d) => document.querySelectorAll('.nav-root > .layer').length === d && !document.querySelector('.nav-root.is-animating'), n);

describe('chapter illustrations fetched by the core', () => {
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-images');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({
      wwwDir: www,
      core: { routes, answers: [0, 0, 0, 0] },
      beforeLoad: async (core) => {
        await core.call('sources.install', { code: fx('spec.json') });
      },
      initStorage: { 'tachinovel.tips.reader': '1' },
    });
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('loads them from cache/img-* next to the page', async () => {
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    await shell.page.getByTestId('onboarding-skip').click();
    await shell.page.getByTestId('tab-browse').click();
    await shell.page.getByTestId('source-demo-library').first().click();
    await waitStack(2);
    await shell.page.locator('[data-testid="browse-grid"] .grid-hit').first().click();
    await waitStack(3);
    await expect.poll(() => top().getByTestId('chapter-row').count(), { timeout: 15_000 }).toBe(3);
    await top().getByTestId('resume').click();
    await waitStack(4);
    const body = shell.page.locator('[data-testid="reader-chapter"][data-status="ready"] [data-testid="reader-body"]').first();
    await body.waitFor({ timeout: 15_000 });
    const img = body.locator('img').first();
    // The direct load fails (unreachable host), the core fetches it, and the copy comes from cache/img-*.
    await expect.poll(() => img.getAttribute('src'), { timeout: 15_000 }).toMatch(/^cache\/img-[A-Za-z0-9_-]+\.[a-z]+$/);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 10_000 }).toBe(1);
    expect(await img.evaluate((el) => el.classList.contains('is-gone'))).toBe(false);
    expect(shell.pageErrors).toEqual([]);
  });
});
