/**
 * Phone QA loop on the PC: v1's Diagnostics screen shows the "Diagnostics Folder" row (build patch,
 * tools/v1-qa.ts), it opens the native menu (DiagFolder.menu), shows the linked folder's name (or that it is
 * disconnected), and the UI keeps its short event trail in localStorage for the native mirror. v1's Storage page
 * shows the native app's Voices & models row, its panel and Clean Up.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
let shell: PcShell;
const top = () => shell.page.locator('.nav-root > .layer').last();
const waitStack = (n: number) =>
  shell.page.waitForFunction((d) => document.querySelectorAll('.nav-root > .layer').length === d && !document.querySelector('.nav-root.is-animating'), n);

describe('Diagnostics folder (PC shell)', () => {
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-qa');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({ wwwDir: www, core: {} });
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    await shell.page.getByTestId('onboarding-skip').click();
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('shows the row (Off) on Diagnostics and opens the native menu', async () => {
    await shell.page.getByTestId('tab-more').click();
    await shell.page.getByTestId('more-about').click();
    await waitStack(2);
    await top().getByTestId('about-diagnostics').click();
    await waitStack(3);
    const row = top().getByTestId('diagnostics-folder');
    await expect.poll(() => row.textContent(), { timeout: 5000 }).toContain('Off');
    shell.pluginReplies.set('DiagFolder.menu', () => ({ linked: true, name: 'diagnostics', lastMirror: null }));
    await row.click();
    await expect.poll(() => shell.pluginCalls.some((c) => c.pluginId === 'DiagFolder' && c.methodName === 'menu')).toBe(true);
    await expect.poll(() => row.textContent(), { timeout: 5000 }).toContain('diagnostics');
  });

  it('keeps the screen trail for the mirror', async () => {
    const trail = await shell.page.evaluate(() => JSON.parse(localStorage.getItem('tachinovel.v2.trail') ?? '[]') as { e: string; d: string }[]);
    const lines = trail.map((t) => t.d);
    expect(lines).toContain('tab: more');
    expect(lines).toContain('settings: about');
    expect(lines).toContain('diagnostics');
    expect(shell.pageErrors).toEqual([]);
  });

  it('says when the folder stopped working', async () => {
    const row = top().getByTestId('diagnostics-folder');
    shell.pluginReplies.set('DiagFolder.menu', () => ({ linked: true, name: 'diagnostics', lastMirror: null, state: 'disconnected', problem: 'The folder isn’t there any more' }));
    await row.click();
    await expect.poll(() => row.textContent(), { timeout: 5000 }).toContain('Disconnected – tap to reconnect');
  });

  it('Storage › Voices & models lists the categories and cleans up only the leftovers', async () => {
    const entry = (key: string, bytes: number, leftover = false) => ({ key, label: key, note: '', bytes, count: 1, leftover });
    const kept = [entry('packActive', 455e6), entry('packsOther', 410e6), entry('modelPocket', 368e6), entry('reading', 30e6)];
    const report = (leftovers: ReturnType<typeof entry>[]) => ({ entries: [...kept, ...leftovers], totalBytes: 2e9, appBytes: 520e6 });
    shell.pluginReplies.set('DiagFolder.storage', () => report([entry('leftoverInbox', 440e6, true)]));
    shell.pluginReplies.set('DiagFolder.cleanStorage', () => ({ removed: 1, bytes: 440e6, report: report([entry('leftoverInbox', 0, true)]) }));
    await top().getByTestId('nav-back').click();
    await waitStack(2);
    await top().getByTestId('nav-back').click();
    await waitStack(1);
    await shell.page.getByTestId('more-storage').click();
    await waitStack(2);
    const row = top().getByTestId('storage-native');
    await expect.poll(() => row.textContent(), { timeout: 5000 }).toContain('440 MB to clean up');
    await row.click();
    const panel = shell.page.locator('[data-testid="native-storage"]');
    await expect.poll(() => panel.locator('[data-testid="native-storage-leftovers"]').count(), { timeout: 5000 }).toBe(1);
    await expect.poll(() => panel.textContent()).toContain('packActive');
    await panel.locator('[data-testid="native-storage-clean"]').click();
    await expect.poll(() => shell.pluginCalls.some((c) => c.pluginId === 'DiagFolder' && c.methodName === 'cleanStorage')).toBe(true);
    await expect.poll(() => panel.locator('[data-testid="native-storage-clean-none"]').count(), { timeout: 5000 }).toBe(1);
    expect(shell.pageErrors).toEqual([]);
  });
});
