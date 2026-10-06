/**
 * v2 wording in v1's screens (tools/v1-wording.ts + src/ui/native/v2-text.ts): the storage location comes
 * from the core (`v2.storage`), and nothing names Scriptable or BookPlayer. The PC shell's core has iCloud
 * (the native mock's default), so the texts say iCloud Drive › TachiNovel.
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

describe('v2 wording in the v1 UI', () => {
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-wording');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({ wwwDir: www, core: {} });
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    await shell.page.getByTestId('onboarding-skip').click();
    await shell.page.getByTestId('tab-more').click();
  });

  afterAll(async () => {
    await shell?.close();
  });

  const open = async (testId: string): Promise<string> => {
    await shell.page.getByTestId(testId).click();
    await waitStack(2);
    const text = (await top().textContent()) ?? '';
    await top().getByTestId('nav-back').click();
    await waitStack(1);
    return text;
  };

  it('Backup & Restore says where v2 keeps backups (from the core)', async () => {
    const text = await open('more-backup');
    expect(text).toContain('Backups are saved in iCloud Drive › TachiNovel › backups.');
    expect(text).not.toMatch(/Scriptable/);
  });

  it('About and Storage do not mention Scriptable', async () => {
    expect(await open('more-about')).toContain('A web-novel reader for iPhone. Sources come from the repositories you add.');
    const storage = await open('more-storage');
    expect(storage).toContain('Synced with iCloud');
  });

  it("What's New is v2's own list", async () => {
    const ids = await shell.page.evaluate(() => (globalThis as unknown as { __TN_WHATS_NEW__?: { id: string }[] }).__TN_WHATS_NEW__?.map((r) => r.id));
    expect(ids?.[0]).toMatch(/^v2-/);
    expect(shell.pageErrors).toEqual([]);
  });
});
