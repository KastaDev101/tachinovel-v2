/**
 * v2's car player (src/ui/native/car-mode.ts) in the PC shell. It polls Narration.state every second;
 * that poll used to rebuild the whole player, so the novel list jumped back to the top every second (you
 * couldn't scroll to a novel further down) and a tap that straddled a rebuild was lost.
 * Regression test for the UI crawler finding of 2026-10-06 (docs/qa.md). The list is "Continue listening" (the
 * reading history; the PC narrator's "Narrated on the PC" list went on 2026-10-16).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
let shell: PcShell;
let position = 0;
let dataDir = '';

/** The car player lists the 12 novels read last (history.list, limit 12). */
const ROWS = 12;

/** A core data folder whose synced store already holds a reading history of ROWS novels. */
function dataDirWithHistory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tn2-car-'));
  const synced = path.join(dir, 'icloud', 'TachiNovel');
  mkdirSync(synced, { recursive: true });
  const now = Date.now();
  const entries = Array.from({ length: ROWS }, (_, i) => ({
    pluginId: 'demo-library', path: `novel/n${i}`, novelName: `Novel ${i + 1}`, chapterPath: `novel/n${i}/1`, chapterName: 'Chapter 1',
    readAt: now - i * 60_000, percent: 0.5,
  }));
  writeFileSync(path.join(synced, 'history.json'), JSON.stringify({ schemaVersion: 1, entries }));
  return dir;
}

describe('car player (PC shell)', () => {
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-car');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({ wwwDir: www, core: { dataDir: (dataDir = dataDirWithHistory()) }, initStorage: { 'tachinovel.tips.reader': '1' } });
    shell.pluginReplies.set('Narration.voiceSettings', () => ({
      voices: [],
      defaultVoice: 'af_heart',
      kokoroEnabled: false,
      kokoro: { bundled: false, status: 'missing', ready: false, crashDisabled: false, crashes: 0, revision: null, bytes: null },
      apple: { name: 'Samantha', quality: 'default', onlyDefault: true },
    }));
    // A chapter's audio file playing: the position advances on every poll, like the real player.
    shell.pluginReplies.set('Narration.state', () => ({
      status: 'playing',
      engine: 'audio',
      prepared: true,
      pluginId: 'demo-library',
      novelPath: 'novel/n0',
      chapterPath: 'novel/n0/1',
      chapterName: 'Chapter 1',
      position: (position += 1),
      duration: 600,
    }));
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = shell.page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await shell.page.getByTestId('tab-more').click();
    await shell.page.getByTestId('more-listen').click();
    await shell.page.locator('.tn-car .row').nth(ROWS - 1).waitFor({ timeout: 5000 });
  });

  afterAll(async () => {
    await shell?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
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
    await shell.page.locator('.tn-car .row').nth(ROWS - 1).click();
    await expect.poll(() => shell.pluginCalls.find((c) => c.pluginId === 'Narration' && c.methodName === 'playNovel')?.options.novelPath).toBe(`novel/n${ROWS - 1}`);
  });

  it('shows no PC-narrator folder or list', async () => {
    expect((await shell.page.locator('.tn-car').textContent()) ?? '').not.toMatch(/TachiNovel Audio|Narrated on the PC|audio folder/i);
    expect(shell.pluginCalls.filter((c) => c.pluginId === 'Narration' && /audio(Library|Folder)/.test(c.methodName))).toEqual([]);
  });

  it('ran without page errors', () => {
    expect(shell.pageErrors).toEqual([]);
  });
});
