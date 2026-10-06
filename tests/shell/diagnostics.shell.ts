/**
 * Settings › Diagnostics with MetricKit reports stored (PC shell): the crash summaries appear in v1's
 * "Recent problems", and the v2 button shares the full reports through the share sheet.
 * Screenshot: .cache/shell-shots/diagnostics.png. Fixture data is synthetic.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'shell-shots');
const PAYLOAD = readFileSync(path.join(root, 'tests', 'fixtures', 'metrickit', 'payload.json'), 'utf8');
let shell: PcShell;

describe('Diagnostics with crash reports (PC shell)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-diagnostics');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({
      wwwDir: www,
      core: { routes: {}, answers: [] },
      beforeLoad: async (core) => {
        await core.call('diagnostics.metricPayload', { json: PAYLOAD });
      },
    });
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('lists the MetricKit problems and shares the reports', async () => {
    const page = shell.page;
    await page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.getByTestId('tab-more').click();
    await page.getByTestId('more-about').click();
    await page.getByTestId('about-diagnostics').click();
    const screen = page.getByTestId('screen-diagnostics');
    await screen.waitFor({ timeout: 5000 });

    await expect.poll(() => screen.getByText(/MetricKit 2026-10-05 Crash: EXC_BAD_ACCESS \(SIGSEGV\)/).count(), { timeout: 5000 }).toBeGreaterThan(0);
    const share = page.getByTestId('diagnostics-share-crash-reports');
    await expect.poll(() => share.isVisible(), { timeout: 5000 }).toBe(true);
    expect(await share.textContent()).toBe('Share 5 Crash & Hang Reports');
    await page.screenshot({ path: path.join(shots, 'diagnostics.png') });

    await share.click();
    await expect.poll(() => existsSync(path.join(shell.core.localAppDir, 'logs', 'metrickit-export.json')), { timeout: 5000 }).toBe(true);

    // Leaving the screen hides the button.
    await screen.getByTestId('nav-back').click();
    await expect.poll(() => share.isVisible(), { timeout: 3000 }).toBe(false);
    expect(shell.pageErrors).toEqual([]);
  });
});
