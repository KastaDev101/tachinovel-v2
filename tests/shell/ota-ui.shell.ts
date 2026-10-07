/**
 * Web updates in the UI (personal flavor): More › About › "App Update" shows the running bundle and
 * checks for updates (core ota.check → native alert). The store flavor has neither the row nor the code.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
let shell: PcShell;
const top = () => shell.page.locator('.nav-root > .layer').last();
const waitStack = (n: number) =>
  shell.page.waitForFunction((d) => document.querySelectorAll('.nav-root > .layer').length === d && !document.querySelector('.nav-root.is-animating'), n);

describe('App Update row (personal flavor)', () => {
  let version = '';
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-ota-personal');
    await buildAll({ flavor: 'personal', ads: false, dev: false, outDir: www });
    version = (JSON.parse(readFileSync(path.join(www, 'build-info.json'), 'utf8')) as { version: string }).version;
    shell = await startPcShell({ wwwDir: www, core: { answers: [0, 0, 0] } });
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    await shell.page.getByTestId('onboarding-skip').click();
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('shows the running bundle and checks for updates', async () => {
    await shell.page.getByTestId('tab-more').click();
    await shell.page.getByTestId('more-about').click();
    await waitStack(2);
    const row = top().getByTestId('about-ota');
    await expect.poll(() => row.textContent(), { timeout: 5000 }).toContain(version);
    await row.click();
    // No public key in test builds: the core answers "not configured", the row shows the version again.
    await expect.poll(() => row.textContent(), { timeout: 5000 }).toContain(version);
    expect(shell.pageErrors).toEqual([]);
  });
});

describe('store flavor', () => {
  it('ships no web update code or row', async () => {
    const www = path.join(root, '.cache', 'shell-www-ota-store');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    const ui = readFileSync(path.join(www, 'index.html'), 'utf8');
    const core = readFileSync(path.join(www, 'core', 'core.js'), 'utf8');
    expect(ui).not.toContain('about-ota');
    expect(ui).not.toContain('ota.check');
    expect(core).not.toContain('tachinovel-ota');
  });
});
