/**
 * VoiceOver names (PC shell): on the main screens, every visible control (button, link, tab, switch,
 * input…) has an accessible name, so VoiceOver never announces a bare "button". Covers v1's screens and
 * v2's own overlays (Listen button, mini player, the car player). The same rule is checked on the
 * simulator by AppUITests (assertControlsLabeled), where the names come from WebKit's real accessibility
 * tree; this PC version runs on every PR in the shell job and names the offending element.
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
const top = () => shell.page.locator('.nav-root > .layer').last();
const waitStack = (n: number) =>
  shell.page.waitForFunction((d) => document.querySelectorAll('.nav-root > .layer').length === d && !document.querySelector('.nav-root.is-animating'), n);

/** Visible controls without an accessible name (simplified accname: aria-label(ledby), content, title, alt, label, placeholder). */
function unnamed(): Promise<{ checked: number; missing: string[] }> {
  return shell.page.evaluate(() => {
    const sel = 'button, a[href], [role=button], [role=tab], [role=switch], [role=link], [role=checkbox], [role=slider], input:not([type=hidden]), select, textarea';
    const missing: string[] = [];
    let checked = 0;
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || el.closest('[hidden],[aria-hidden="true"],[inert]')) continue;
      checked++;
      const by = el.getAttribute('aria-labelledby');
      const input = el as HTMLInputElement;
      const name = [
        el.getAttribute('aria-label'),
        by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : '',
        el.innerText,
        el.getAttribute('title'),
        el.querySelector('img[alt]')?.getAttribute('alt'),
        input.labels ? [...input.labels].map((l) => l.innerText).join(' ') : '',
        el.getAttribute('placeholder'),
      ].find((s) => s?.trim());
      if (!name) missing.push(el.outerHTML.slice(0, 200));
    }
    return { checked, missing };
  });
}

const findings: Record<string, string[]> = {};
async function audit(screen: string): Promise<void> {
  const r = await unnamed();
  expect(r.checked, `${screen}: no controls found (wrong screen?)`).toBeGreaterThan(0);
  if (r.missing.length) findings[screen] = r.missing;
}

describe('VoiceOver names on the main screens (PC shell)', () => {
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-a11y');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({
      wwwDir: www,
      core: { routes, answers: [0, 0, 0, 0] },
      beforeLoad: async (core) => {
        await core.call('sources.install', { code: fx('spec.json') });
      },
      initStorage: { 'tachinovel.tips.reader': '1' },
    });
    // The car player lists PC-narrated audio (none linked here).
    shell.pluginReplies.set('Narration.audioLibrary', () => ({ linked: false, novels: [] }));
    shell.pluginReplies.set('Narration.audioFolder', () => ({ linked: false, name: null }));
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('names every control from first launch to listening', async () => {
    const page = shell.page;
    await page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    await page.getByTestId('onboarding').waitFor({ timeout: 5000 });
    // The audit itself: an icon-only button without a label is caught.
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<button id="tn-a11y-probe" style="position:fixed;top:0;left:0;width:40px;height:40px"><svg aria-hidden="true" width="20" height="20"></svg></button>'));
    expect((await unnamed()).missing.join('\n')).toContain('tn-a11y-probe');
    await page.evaluate(() => document.getElementById('tn-a11y-probe')?.remove());
    await audit('onboarding');
    await page.getByTestId('onboarding-skip').click();
    await page.getByTestId('onboarding').waitFor({ state: 'detached', timeout: 5000 });
    await audit('library');
    for (const tab of ['updates', 'history', 'more']) {
      await page.getByTestId(`tab-${tab}`).click();
      await page.getByTestId(`screen-${tab}`).waitFor({ timeout: 5000 });
      await audit(tab);
    }

    // The Listen player: More › Listen opens it directly where that row exists (on-device voices);
    // otherwise through v1's Listen in the Car screen › Open the player.
    const listenRow = page.getByTestId('more-listen');
    const viaCarScreen = !(await listenRow.isVisible());
    if (viaCarScreen) {
      await page.getByTestId('more-narration').click();
      await waitStack(2);
      await page.getByTestId('open-car-player').waitFor({ state: 'visible', timeout: 5000 });
      await audit('Listen in the Car');
      await page.getByTestId('open-car-player').click();
    } else {
      await listenRow.click();
    }
    await page.getByTestId('car-player').waitFor({ state: 'visible', timeout: 5000 });
    await audit('Listen player');
    await page.getByTestId('car-player').locator('[data-act="close"]').click();
    if (viaCarScreen) {
      await top().getByTestId('nav-back').click();
      await waitStack(1);
    }

    await page.getByTestId('tab-browse').click();
    await audit('browse');
    await page.getByTestId('source-demo-library').first().click();
    await waitStack(2);
    const card = page.locator('[data-testid="browse-grid"] .grid-hit').first();
    await expect.poll(() => card.getAttribute('aria-label'), { timeout: 15_000 }).toBe('Alpha Story');
    await audit('source');
    await card.click();
    await waitStack(3);
    await expect.poll(() => top().getByTestId('chapter-row').count(), { timeout: 15_000 }).toBe(3);
    await audit('novel');
    await top().getByTestId('resume').click();
    await waitStack(4);
    await page.locator('.tn-listen').waitFor({ state: 'visible', timeout: 15_000 });
    await audit('reader');
    await page.locator('.tn-listen').click();
    shell.emitPluginEvent('Narration', 'state', { status: 'playing', chapterPath: 'novel/alpha/1', novelName: 'Alpha Story', chapterName: 'Chapter 1', paragraph: 0 });
    await page.getByTestId('mini-player').waitFor({ state: 'visible', timeout: 5000 });
    await audit('reader with the mini player');

    expect(findings, 'controls VoiceOver would announce without a name (add an aria-label or visible text)').toEqual({});
    expect(shell.pageErrors).toEqual([]);
  });
});
