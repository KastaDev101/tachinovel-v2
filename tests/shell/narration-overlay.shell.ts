/**
 * v2's narration overlay over the v1 UI (src/ui/native/narration-overlay.ts), in the PC shell:
 *  - the mini player must not cover v1's bottom UI: the tab bar (it covered all five tabs while
 *    listening), the reader's bottom bar, the novel page's Resume button;
 *  - scrolling content gets room at its end, so nothing stays under the player;
 *  - "Open the player" on Listen in the Car leaves the screen's last rows reachable, with centered text.
 * Regression test for the UI crawler findings of 2026-10-06 (docs/qa.md).
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
  [`${SITE}novel/alpha`]: { body: fx('novel-alpha.html') },
  [`${SITE}novel/alpha/1`]: { body: fx('chapter-alpha-1.html') },
  [`${SITE}novel/alpha/2`]: { body: '<html><body><div id="content"><p>Chapter 2 - The Hall</p><p>The hall was long.</p></div></body></html>' },
};

let shell: PcShell;
const top = () => shell.page.locator('.nav-root > .layer').last();
const waitStack = (n: number) =>
  shell.page.waitForFunction((d) => document.querySelectorAll('.nav-root > .layer').length === d && !document.querySelector('.nav-root.is-animating'), n);

/** Vertical gap between the mini player and the top of `selector` (≥ 0 = no overlap), and what a tap there hits. */
function playerVs(selector: string): Promise<{ gap: number; hit: string } | null> {
  return shell.page.evaluate((sel) => {
    const layers = document.querySelectorAll('.nav-root > .layer');
    const el = layers[layers.length - 1]?.querySelector(sel);
    const p = document.querySelector('.tn-player');
    if (!el || !p || p.hasAttribute('hidden')) return null;
    const a = p.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(b.height / 2, 20));
    return { gap: Math.round(b.top - a.bottom), hit: hit?.closest('.tn-player') ? 'mini player' : (hit?.className.toString() ?? '') };
  }, selector);
}

describe('narration overlay over v1 screens (PC shell)', () => {
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-overlay');
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
    await shell.page.getByTestId('tab-browse').click();
    await shell.page.getByTestId('source-demo-library').first().click();
    await waitStack(2);
    await shell.page.locator('[data-testid="browse-grid"] .grid-hit').first().click();
    await waitStack(3);
    await top().getByTestId('resume').click();
    await waitStack(4);
    await shell.page.locator('[data-testid="reader-chapter"][data-status="ready"]').first().waitFor({ timeout: 15_000 });
    await shell.page.locator('.tn-listen').click();
    // NarrationPlugin answers play() and then reports its state, which shows the mini player.
    shell.emitPluginEvent('Narration', 'state', { status: 'playing', engine: 'speech', pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1', chapterName: 'Chapter 1 - Nightmare Begins' });
    await shell.page.locator('.tn-player').waitFor({ state: 'visible', timeout: 5000 });
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('sits above the reader bottom bar and gives the chapter room at its end', async () => {
    await expect.poll(() => playerVs('.reader.bars-visible .rd-bottom'), { timeout: 3000 }).toMatchObject({ gap: 8 });
    expect(await shell.page.evaluate(() => document.documentElement.classList.contains('tn-player-on'))).toBe(true);
    const room = await shell.page.evaluate(() => {
      const c = document.querySelector('.reader-content');
      return c ? getComputedStyle(c, '::after').height : '';
    });
    expect(room).toBe('72px');
  });

  it("doesn't cover the novel page's Resume button", async () => {
    await top().getByTestId('reader-back').click();
    await waitStack(3);
    await expect.poll(() => playerVs('.fab'), { timeout: 3000 }).toMatchObject({ gap: 8 });
  });

  it("doesn't cover the tab bar: every tab stays tappable while listening", async () => {
    await top().getByTestId('nav-back').click();
    await waitStack(2);
    await top().getByTestId('nav-back').click();
    await waitStack(1);
    await expect.poll(() => playerVs('.tabbar'), { timeout: 3000 }).toMatchObject({ gap: 8 });
    for (const tab of ['library', 'updates', 'history', 'more', 'browse']) {
      // A real hit test (Playwright refuses to click an element covered by another one).
      await shell.page.getByTestId(`tab-${tab}`).click({ timeout: 3000 });
      await expect.poll(() => shell.page.getByTestId(`tab-${tab}`).getAttribute('aria-selected')).toBe('true');
    }
  });

  it('goes away (and so does the extra room) when narration stops', async () => {
    shell.emitPluginEvent('Narration', 'state', { status: 'idle' });
    await shell.page.locator('.tn-player').waitFor({ state: 'hidden', timeout: 3000 });
    await expect.poll(() => shell.page.evaluate(() => document.documentElement.classList.contains('tn-player-on'))).toBe(false);
  });

  it('Listen in the Car: "Open the player" is centered and leaves the last rows reachable', async () => {
    // That screen is the PC narrator's: More lists it only with Settings › Voices › Advanced › "Use PC audio
    // when available" on (src/ui/native/v1-hooks.ts); otherwise More › Listen opens the player directly.
    shell.pluginReplies.set('Narration.voiceSettings', () => ({ usePCAudio: true }));
    await shell.page.evaluate(() => window.dispatchEvent(new Event('tn-voice-settings')));
    await shell.page.getByTestId('tab-more').click();
    await shell.page.getByTestId('more-narration').waitFor({ state: 'visible', timeout: 3000 });
    await shell.page.getByTestId('more-narration').click();
    await waitStack(2);
    const button = shell.page.getByTestId('open-car-player');
    await button.waitFor({ state: 'visible', timeout: 3000 });
    expect(await button.evaluate((b) => getComputedStyle(b).textAlign)).toBe('center');
    const covered = await shell.page.evaluate(async () => {
      const scroller = document.querySelector('.nav-root > .layer:last-child .screen-scroll');
      if (!scroller) return 'no scroller';
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const leaves = [...scroller.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e as HTMLElement).innerText?.trim());
      const last = leaves.reduce<Element | null>((a, e) => (!a || e.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? e : a), null);
      if (!last) return 'no content';
      const r = last.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit?.closest('.tn-open-car') ? `"${(last as HTMLElement).innerText}" is under the button` : '';
    });
    expect(covered).toBe('');
  });

  it('ran without page errors', () => {
    expect(shell.pageErrors).toEqual([]);
    expect(shell.consoleErrors.filter((e) => !/403|Failed to load resource|blocked/i.test(e))).toEqual([]);
  });
});
