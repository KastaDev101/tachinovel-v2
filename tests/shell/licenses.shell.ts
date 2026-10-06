/**
 * More › About › Open Source Licenses in the built UI (PC shell): the page lists THIRD_PARTY_NOTICES.md
 * (v1's screen, its list replaced at build time) and opens a notice's full text.
 * Screenshot: .cache/shell-shots/licenses.png
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { readNotices } from '../../tools/third-party.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'shell-shots');
let shell: PcShell;

describe('Open Source Licenses (PC shell)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-licenses');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({ wwwDir: www, core: { routes: {}, answers: [] } });
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('lists every notice and shows its text', async () => {
    const page = shell.page;
    await page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.getByTestId('tab-more').click();
    await page.getByTestId('more-about').click();
    await page.getByTestId('licenses').click();
    const screen = page.getByTestId('screen-licenses');
    await screen.waitFor({ timeout: 5000 });

    for (const n of readNotices()) await expect.poll(() => screen.getByText(n.name, { exact: true }).count(), { timeout: 5000 }).toBeGreaterThan(0);
    // The first entry (LNReader) starts open, like v1's page did.
    await expect.poll(() => screen.locator('.license-text').first().textContent()).toContain('Rajarshee Chatterjee');
    await screen.getByText('Capacitor', { exact: true }).click();
    await expect.poll(() => screen.locator('.license-text').first().textContent()).toContain('Drifty Co.');
    await page.screenshot({ path: path.join(shots, 'licenses.png') });
    expect(shell.pageErrors).toEqual([]);
  });
});
