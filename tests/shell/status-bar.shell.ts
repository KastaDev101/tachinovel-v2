/**
 * Status bar text follows what is painted under it (src/ui/native/status-bar.ts): the system appearance,
 * a forced Appearance in Settings, and the reader's theme. In v1 (Scriptable) there was no status bar
 * over the page, so v1 never had to care.
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
/** The style of the last StatusBar.setStyle call ("DARK" = light text, "LIGHT" = dark text). */
const lastStyle = (): unknown => shell.pluginCalls.filter((c) => c.pluginId === 'StatusBar' && c.methodName === 'setStyle').at(-1)?.options.style;

describe('status bar style (PC shell, system appearance: dark)', () => {
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-statusbar');
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
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('light text on the dark app', async () => {
    await expect.poll(lastStyle, { timeout: 5000 }).toBe('DARK');
  });

  it('dark text once Settings › Appearance forces Light', async () => {
    await shell.page.getByTestId('tab-more').click();
    await shell.page.getByTestId('more-appearance').click();
    await waitStack(2);
    await top().getByTestId('appearance-light').click();
    await expect.poll(lastStyle, { timeout: 5000 }).toBe('LIGHT');
  });

  it('follows the reader theme: Black → light text, Sepia → dark text', async () => {
    await top().getByTestId('nav-back').click();
    await waitStack(1);
    await shell.page.getByTestId('tab-browse').click();
    await shell.page.getByTestId('source-demo-library').first().click();
    await waitStack(2);
    await shell.page.locator('[data-testid="browse-grid"] .grid-hit').first().click();
    await waitStack(3);
    await expect.poll(() => top().getByTestId('chapter-row').count(), { timeout: 15_000 }).toBe(3);
    await top().getByTestId('resume').click();
    await waitStack(4);
    await shell.page.locator('[data-testid="reader-chapter"][data-status="ready"]').first().waitFor({ timeout: 15_000 });
    // Reader in the app's (forced light) appearance: dark text.
    await expect.poll(lastStyle, { timeout: 5000 }).toBe('LIGHT');
    const settingsBtn = shell.page.getByTestId('reader-settings-btn');
    if (!(await settingsBtn.isVisible())) {
      const vp = shell.page.viewportSize() ?? { width: 390, height: 844 };
      await shell.page.mouse.click(vp.width / 2, vp.height / 2); // tap the middle: bars appear
    }
    await settingsBtn.click();
    await shell.page.getByTestId('theme-black').click();
    await expect.poll(lastStyle, { timeout: 5000 }).toBe('DARK');
    await shell.page.getByTestId('theme-sepia').click();
    await expect.poll(lastStyle, { timeout: 5000 }).toBe('LIGHT');
    expect(shell.pageErrors).toEqual([]);
  });
});
