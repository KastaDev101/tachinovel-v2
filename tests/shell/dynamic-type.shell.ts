/**
 * Dynamic Type and VoiceOver on v2's own overlays (PC shell): the mini player, the Listen player, the
 * Voices screen and the Voice Lab size their text with fs() (src/ui/native/type.ts), so at the largest
 * text size the app follows (root 1.6 × 17 px; on the phone html's `font: -apple-system-body` sets it)
 * their text grows like v1's and nothing that holds text clips. The mini player's title button tells
 * VoiceOver what is playing. Screenshots: .cache/shell-shots/large-text-*.png.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'shell-shots');
const LARGEST = 1.6; // src/ui/native/type.ts MAX_SCALE
let shell: PcShell;

/** Computed font size (px) of the first match, and whether any matched element clips its content. */
function measure(selector: string): Promise<{ font: number; clipped: string[] }> {
  return shell.page.evaluate((sel) => {
    const els = [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => e.getClientRects().length > 0);
    const clipped = els.filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.outerHTML.slice(0, 120));
    return { font: els[0] ? parseFloat(getComputedStyle(els[0]).fontSize) : 0, clipped };
  }, selector);
}

describe('Dynamic Type on the v2 overlays (PC shell)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-dynamic-type');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({ wwwDir: www, core: { routes: {}, answers: [] } });
    shell.pluginReplies.set('Narration.audioLibrary', () => ({ linked: false, novels: [] }));
    shell.pluginReplies.set('Narration.audioFolder', () => ({ linked: false, name: null }));
    shell.pluginReplies.set('Narration.voiceSettings', () => ({
      voices: [
        { id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', blurb: 'Warm.' },
        { id: 'bm_george', name: 'George', language: 'en-GB', gender: 'male', blurb: 'Classic.' },
      ],
      defaultVoice: 'af_heart',
      kokoroEnabled: true,
      usePCAudio: false,
      kokoro: { bundled: true, status: 'ready', ready: true, crashDisabled: false, crashes: 0, revision: 'abc', bytes: 97_400_000 },
      apple: { name: 'Samantha', quality: 'default', onlyDefault: true },
    }));
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = shell.page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('mini player: "<novel>, <chapter>" for VoiceOver, text that follows the text size', async () => {
    const page = shell.page;
    shell.emitPluginEvent('Narration', 'state', { status: 'playing', engine: 'speech', novelName: 'Alpha Story', chapterName: 'Chapter 1 - Nightmare Begins' });
    const player = page.getByTestId('mini-player');
    await player.waitFor({ state: 'visible', timeout: 5000 });
    const title = player.locator('.tn-title');
    await expect.poll(() => title.getAttribute('aria-label')).toBe('Alpha Story, Chapter 1 - Nightmare Begins');
    const hint = await title.getAttribute('aria-describedby');
    expect(await page.locator(`#${hint ?? 'missing'}`).textContent()).toBe('Opens the player');
    expect((await measure('.tn-player')).font).toBeCloseTo(14, 1);

    await page.addStyleTag({ content: 'html{font-size:27.2px !important}' });
    await expect.poll(async () => (await measure('.tn-player')).font).toBeCloseTo(14 * LARGEST, 1);
    expect((await measure('.tn-player .tn-title small')).font).toBeCloseTo(12 * LARGEST, 1);
    expect((await measure('.tn-player, .tn-player .tn-title')).clipped).toEqual([]);
    // The room left under scrolling content follows the (taller) player.
    await expect
      .poll(() => page.evaluate(() => [document.documentElement.style.getPropertyValue('--tn-float-h'), `${(document.querySelector('.tn-player') as HTMLElement).offsetHeight}px`]))
      .toSatisfy(([v, h]: string[]) => v === h);
    await page.screenshot({ path: path.join(shots, 'large-text-mini-player.png') });
  });

  it('Listen player and Voices screen at the largest text size', async () => {
    const page = shell.page;
    await page.getByTestId('mini-player').locator('.tn-title').click();
    const car = page.getByTestId('car-player');
    await car.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400); // slide-in
    expect((await measure('.tn-car .hd h1')).font).toBeCloseTo(20 * LARGEST, 1);
    expect((await measure('.tn-car .hd, .tn-car .t1, .tn-car .voice')).clipped).toEqual([]);
    await page.screenshot({ path: path.join(shots, 'large-text-listen-player.png') });
    await car.locator('[data-act="close"]').click();
    await car.waitFor({ state: 'hidden', timeout: 5000 });

    await page.getByTestId('tab-more').click();
    await page.getByTestId('more-voices').click();
    const voices = page.getByTestId('screen-voices');
    await voices.waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    expect((await measure('.tn-v .hd h1')).font).toBeCloseTo(20 * LARGEST, 1);
    expect((await measure('.tn-v .hd, .tn-v .row')).clipped).toEqual([]);
    await page.screenshot({ path: path.join(shots, 'large-text-voices.png') });
    await voices.locator('[data-act="close"]').click();
  });

  it('Voice Lab at the largest text size', async () => {
    const page = shell.page;
    await page.getByTestId('more-about').click();
    const version = page.locator('[data-testid="screen-about"] .about-version');
    await version.waitFor({ timeout: 5000 });
    for (let i = 0; i < 5; i++) await version.click();
    const lab = page.getByTestId('voice-lab');
    await lab.waitFor({ state: 'visible', timeout: 5000 });
    expect((await measure('.tn-lab')).font).toBeCloseTo(14 * LARGEST, 1);
    expect((await measure('.tn-lab .hd')).clipped).toEqual([]);
    await page.screenshot({ path: path.join(shots, 'large-text-voice-lab.png') });
    expect(shell.pageErrors).toEqual([]);
  });
});
