/**
 * v2's car player (src/ui/native/car-mode.ts) in the PC shell. It polls Narration.state every second;
 * that poll used to rebuild the whole player, so the novel list jumped back to the top every second (you
 * couldn't scroll to a novel further down) and a tap that straddled a rebuild was lost.
 * Regression test for the UI crawler finding of 2026-10-06 (docs/qa.md).
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
let shell: PcShell;
let position = 0;

const novels = Array.from({ length: 14 }, (_, i) => ({
  key: `demo-library:novel/n${i}`,
  pluginId: 'demo-library',
  novelPath: `novel/n${i}`,
  name: `Narrated Novel ${i + 1}`,
  chapters: [{ chapterPath: `novel/n${i}/1`, title: 'Chapter 1', number: 1, hasTiming: true }],
  saved: null,
}));

describe('car player (PC shell)', () => {
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-car');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({ wwwDir: www, core: {}, initStorage: { 'tachinovel.tips.reader': '1' } });
    // PC-narrated audio is opt-in (Settings › Voices › Advanced): on, so the narrated list is shown.
    shell.pluginReplies.set('Narration.voiceSettings', () => ({
      voices: [],
      defaultVoice: 'af_heart',
      kokoroEnabled: false,
      usePCAudio: true,
      kokoro: { bundled: false, status: 'missing', ready: false, crashDisabled: false, crashes: 0, revision: null, bytes: null },
      apple: { name: 'Samantha', quality: 'default', onlyDefault: true },
    }));
    shell.pluginReplies.set('Narration.audioLibrary', () => ({ linked: true, novels }));
    shell.pluginReplies.set('Narration.audioFolder', () => ({ linked: true, name: 'TachiNovel Audio' }));
    // Narrated audio playing: the position advances on every poll, like the real player.
    shell.pluginReplies.set('Narration.state', () => ({
      status: 'playing',
      engine: 'audio',
      pluginId: 'demo-library',
      novelPath: 'novel/n0',
      chapterPath: 'novel/n0/1',
      chapterName: 'Chapter 1',
      position: (position += 1),
      duration: 600,
    }));
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    await shell.page.getByTestId('onboarding-skip').click();
    await shell.page.getByTestId('tab-more').click();
    // More › Listen opens the player (the PC-narrator screen is only listed with PC audio on at launch).
    await shell.page.getByTestId('more-listen').click();
    await shell.page.locator('.tn-car .row').nth(13).waitFor({ timeout: 5000 });
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('keeps the list where the user scrolled it and its rows in place while the state poll runs', async () => {
    const list = shell.page.locator('.tn-car .list');
    await list.evaluate((l) => {
      l.scrollTop = 200;
      const w = window as unknown as { __row: Element | null; __toggle: Element | null };
      w.__row = l.querySelector('.row');
      w.__toggle = document.querySelector('.tn-car [data-act="toggle"]');
    });
    const before = await shell.page.locator('.tn-car .tm span').first().textContent();
    await shell.page.waitForTimeout(2600); // two or three polls
    expect(await list.evaluate((l) => l.scrollTop)).toBe(200);
    const same = await shell.page.evaluate(() => {
      const w = window as unknown as { __row: Element | null; __toggle: Element | null };
      return { row: !!w.__row?.isConnected, toggle: !!w.__toggle?.isConnected };
    });
    expect(same).toEqual({ row: true, toggle: true });
    // The clock still moves (updated in place).
    expect(await shell.page.locator('.tn-car .tm span').first().textContent()).not.toBe(before);
  });

  it('a row far down the list can be tapped', async () => {
    await shell.page.locator('.tn-car .row').nth(13).click();
    await expect.poll(() => shell.pluginCalls.find((c) => c.pluginId === 'Narration' && c.methodName === 'playNovel')?.options.novelPath).toBe('novel/n13');
  });

  it('ran without page errors', () => {
    expect(shell.pageErrors).toEqual([]);
  });
});
