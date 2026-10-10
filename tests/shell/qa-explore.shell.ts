/**
 * Exploratory QA walk (scratch): every More/Settings screen and the Listen player's sheets, screenshotted, with
 * page errors collected. Screenshots: .cache/qa-shots/*.png
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'qa-shots');
let shell: PcShell;
let n = 0;
const shot = async (name: string): Promise<void> => {
  n += 1;
  await shell.page.waitForTimeout(450);
  await shell.page.screenshot({ path: path.join(shots, `${String(n).padStart(2, '0')}-${name}.png`) });
};

const voices = [
  { id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', blurb: 'warm', grade: 'A', gradeRank: 13 },
  { id: 'af_bella', name: 'Bella', language: 'en-US', gender: 'female', blurb: 'bright', grade: 'A-', gradeRank: 12 },
  { id: 'af_nicole', name: 'Nicole', language: 'en-US', gender: 'female', blurb: 'soft', grade: 'B-', gradeRank: 9 },
  { id: 'bf_emma', name: 'Emma', language: 'en-GB', gender: 'female', blurb: 'calm', grade: 'B-', gradeRank: 9 },
];
const delivery = {
  natural: true, performed: true, moods: true, sceneAI: false, breaths: false, studioSound: true, systemChime: true, systemTone: true,
  listenEngine: 'pocket-tts', pocketVoice: 'nephis', pocketInstalled: true, sceneAIAvailable: false,
};
const settings = (o: Record<string, unknown>): unknown => {
  const novel = o.pluginId && o.novelPath;
  return {
    voices,
    customVoices: [],
    narrator: { enabled: false, dialogueVoice: null, secondDialogueVoice: null, pacing: true, jitter: false, polish: true, roomTone: false, phraseBreaks: 'clauses', pacingStyle: 'relaxed' },
    defaultVoice: 'af_heart',
    kokoroEnabled: true,
    usePCAudio: false,
    carButtons: 'chapters',
    delivery: { ...delivery },
    kokoro: { bundled: true, status: 'Ready', ready: true, crashDisabled: false, crashes: 0, revision: 'abc', bytes: 108_900_000 },
    apple: { name: 'Zoe (Premium)', quality: 'premium', onlyDefault: false },
    ...(novel ? { novelVoice: null, effectiveVoice: 'af_heart' } : {}),
  };
};

describe('QA walk', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-qa');
    await buildAll({ flavor: 'personal', ads: false, dev: false, outDir: www });
    shell = await startPcShell({ wwwDir: www, core: {}, initStorage: { 'tachinovel.tips.reader': '1' } });
    shell.pluginReplies.set('Narration.voiceSettings', settings);
    shell.pluginReplies.set('Narration.setVoiceSettings', (o) => {
      const d = (o as { delivery?: Record<string, unknown> }).delivery;
      if (d) Object.assign(delivery, d);
      return {};
    });
    shell.pluginReplies.set('Narration.driveStatus', () => ({ novels: [], totalBytes: 0 }));
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = shell.page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('walks More and every screen under it', async () => {
    await shell.page.getByTestId('tab-more').click();
    await shot('more');
    const rows = await shell.page.locator('[data-testid^="more-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
    console.log('more rows', rows);
    for (const id of rows) {
      const el = shell.page.getByTestId(id);
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.scrollIntoViewIfNeeded();
      await el.click().catch((e: unknown) => console.log('click failed', id, String(e)));
      await shot(id);
      const back = await shell.page.evaluate(() => {
        const b = [...document.querySelectorAll('[data-testid="nav-back"]')].pop() as HTMLElement | undefined;
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const svg = b.querySelector('svg');
        return { r: [r.x, r.y, r.width, r.height], svg: svg ? svg.outerHTML.slice(0, 200) : null, color: getComputedStyle(b).color, opacity: getComputedStyle(b).opacity };
      });
      appendFileSync(path.join(shots, 'log.txt'), `back ${id} ${JSON.stringify(back)}
`);
      // Back: a panel's close button, else the nav back button.
      const close = shell.page.locator('[data-act="close"]:visible').last();
      if (await close.isVisible().catch(() => false)) await close.click();
      else await shell.page.locator('[data-testid="nav-back"]:visible, .nav-back:visible').last().click().catch(() => undefined);
      await shell.page.waitForTimeout(400);
    }
    console.log('page errors', shell.pageErrors);
    console.log('console errors', shell.consoleErrors);
    expect(shell.pageErrors).toEqual([]);
  });

  it('walks Voices in depth', async () => {
    await shell.page.getByTestId('tab-more').click();
    await shell.page.getByTestId('more-voices').click();
    const scr = shell.page.locator('[data-testid="screen-voices"]:not([inert])');
    await scr.locator('[data-testid="voices-engine"]').waitFor({ timeout: 5000 });
    await shot('voices-top');
    await scr.evaluate((e) => e.querySelector('.body, .panel-body')?.scrollTo(0, 99999));
    await shot('voices-bottom');
    const chip = await shell.page.evaluate(() => {
      const c = document.querySelector('[data-act="car-buttons"]') as HTMLElement;
      const cs = getComputedStyle(c);
      const rules: string[] = [];
      for (const sh of [...document.styleSheets]) {
        try {
          for (const r of [...sh.cssRules]) if (r instanceof CSSStyleRule && c.matches(r.selectorText)) rules.push(r.cssText.slice(0, 160));
        } catch { /* cross-origin */ }
      }
      return { ta: cs.textAlign, display: cs.display, jc: cs.justifyContent, rules };
    });
    appendFileSync(path.join(shots, 'log.txt'), `chip ${JSON.stringify(chip, null, 1)}
`);
    await scr.locator('[data-act="narrator-settings"]').click();
    await shot('narrator-settings');
    await shell.page.locator('[data-testid="narrator-settings"] [data-act="close"]').click();
    await scr.locator('[data-act="kokoro-all"]').click();
    await shot('kokoro-all');
    await shell.page.locator('[data-testid="kokoro-voices"] [data-act="close"]').click();
    await scr.locator('[data-act="expressive"]').click();
    await shot('voice-models');
    console.log('page errors', shell.pageErrors);
  });

  it('walks the Listen player while Nephis reads', async () => {
    await shell.page.locator('[data-act="close"]:visible').last().click().catch(() => undefined);
    await shell.page.locator('[data-testid="screen-voices"] [data-act="close"]').click().catch(() => undefined);
    shell.pluginReplies.set('Narration.state', () => ({
      status: 'playing', engine: 'speech', pluginId: 'demo-library', novelPath: 'novel/alpha', novelName: 'Alpha Story', chapterName: 'Chapter 1',
      position: 10, duration: 600,
      voice: { kokoroVoice: 'af_nephis', kokoroName: 'Nephis', source: 'kokoro', reader: 'Nephis' },
    }));
    await shell.page.getByTestId('tab-more').click();
    await shell.page.getByTestId('more-listen').click();
    await shot('listen-playing');
    await shell.page.getByTestId('car-player').locator('[data-act="voice"]').click();
    const picker = shell.page.locator('[data-testid="voice-picker"]:not([inert])');
    await picker.locator('[data-act="novel-kokoro"]').waitFor({ timeout: 5000 });
    await shot('voice-picker');
    await picker.locator('[data-act="novel-kokoro"]').click();
    await shot('novel-kokoro');
    await shell.page.locator('[data-testid="novel-kokoro"] [data-act="close"]').click();
    await picker.locator('[data-act="narrator-settings"]').click();
    await shot('narrator-settings-nephis');
    expect(shell.pageErrors).toEqual([]);
  });
});
