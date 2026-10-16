/**
 * More › Developer › Voice Test (src/ui/native/voice-test.ts) in the PC shell, personal flavor (Developer options on): the
 * one page for testing Nephis. Against canned ExpressiveVoice / Narration plugins:
 *  - the top says which pack is installed, that it has her studio and whether the studio is on; the page has no studio
 *    switch any more: More › Developer › Studio (Automatic / Off) sends ExpressiveVoice.studioEnable;
 *  - Run the test runs the studio speed test when her studio is on (native returns with Nephis warm again; with it
 *    off the speed test is skipped and the result says so), then the listening test
 *    (Narration.play), in that order, and says how it went in plain words; where her studio's models run is its own
 *    button ("Where her studio runs": studioTest {placement: true});
 *  - Copy report copies one combined report (pack, studio state and test, the listening test, notes);
 *  - none of the Voice Lab's developer controls appear, and every control has a name for VoiceOver;
 *  - Nephis switched off after real crashes of her model: More › Voices and the Voice Test say why in plain words
 *    and one tap ("Turn Nephis Back On", ExpressiveVoice.resetCrashes) turns her back on; so does the Listen player's
 *    Voice panel (car mode).
 * Screenshots: .cache/shell-shots/voice-test-top.png, voice-test.png, voice-test-nephis-off.png
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { openDeveloper, type PcShell, setDeveloperOptions, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'shell-shots');
let shell: PcShell;
let studioOn = false;
let nephisOff = false;
const OFF_LINE = 'Nephis was switched off after crashing twice in a row, last at 2:32 PM, chapter 1026, phone warm.';

const crashes = (): Record<string, unknown> =>
  nephisOff
    ? {
        total: 2, consecutive: 2, disabled: true, notCounted: 1, lastContext: 'nephis 120 chars', lastAt: '2026-10-12T14:32:00Z', offLine: OFF_LINE,
        lastEnd: { kind: 'crashed', counted: true, inFlight: true, line: 'Nephis crashed at 2:32 PM, chapter 1026, phone warm.' },
        appLastEnd: { kind: 'fault', line: 'The app crashed at 2:32 PM, chapter 1026, phone warm.' },
      }
    : { total: 0, consecutive: 0, disabled: false, lastContext: null, lastAt: null };

const status = (): Record<string, unknown> => ({
  available: true,
  app: '2.0.0-alpha.8 (8)',
  crashes: crashes(),
  device: { thermal: 'nominal', memoryMB: 240, availableMB: 3100, lowPower: false, os: 'Version 26.6.1' },
  engines: [],
  session: { state: 'idle' },
  nephisPack: { name: 'nephis-r9', made: '2026-10-11', studio: true, studioOn },
  flow: { active: true, calls: 12, perAudioSecond: { call: 0.1 }, renderX: 10, listen: { breaks: 0, breakSeconds: 0, otherVoiceSentences: 0 } },
});

const calls = (plugin: string, method: string): Record<string, unknown>[] =>
  shell.pluginCalls.filter((c) => c.pluginId === plugin && c.methodName === method).map((c) => c.options);

describe('More › Developer › Voice Test (PC shell)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-voice-test');
    await buildAll({ flavor: 'personal', ads: false, dev: false, outDir: www });
    shell = await startPcShell({ wwwDir: www, core: { routes: {}, answers: [] }, initStorage: { 'tachinovel.tips.reader': '1' } });
    shell.pluginReplies.set('Narration.voiceSettings', () => ({
      voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', blurb: 'Warm.' }],
      defaultVoice: 'af_heart',
      kokoroEnabled: true,
      usePCAudio: false,
      kokoro: { bundled: true, status: 'ready', ready: true, crashDisabled: false, crashes: 0, revision: 'abc', bytes: 97_400_000 },
      apple: { name: 'Samantha', quality: 'default', onlyDefault: true },
      delivery: { listenEngine: 'pocket-tts', pocketVoice: 'nephis', nephisOff, nephisOffLine: nephisOff ? OFF_LINE : null },
    }));
    shell.pluginReplies.set('ExpressiveVoice.resetCrashes', () => {
      nephisOff = false;
      return status();
    });
    for (const m of ['status', 'resetStats', 'unload']) shell.pluginReplies.set(`ExpressiveVoice.${m}`, status);
    shell.pluginReplies.set('ExpressiveVoice.recordStart', () => ({ recording: true }));
    shell.pluginReplies.set('ExpressiveVoice.recordStop', () => ({ saved: false, bytes: 0 }));
    shell.pluginReplies.set('ExpressiveVoice.studioEnable', (o) => {
      studioOn = o.on === true;
      return { enabled: studioOn };
    });
    // The speed test (memory at each step), and where its models run on its own (placement: true).
    shell.pluginReplies.set('ExpressiveVoice.studioTest', (o) =>
      o.placement === true
        ? { placementOnly: true, placement: { 'blueprint.ane': 40, 'vocoder.ane': 90, 'vocoder.cpu': 10 }, memory: [{ step: 'placement', usedMB: 300, freeMB: 2900 }] }
        : {
            ran: true, loadMs: 900, audioSeconds: 10, resampleMs: 20, blueprintMs: 1500, refinerMs: 0, vocoderMs: 2400, restMs: 0, bypassed: false,
            timesRealTime: 2.34, thermalBefore: 0, thermalAfter: 1, enabled: studioOn,
            memory: [{ step: 'start', usedMB: 240, freeMB: 3100 }, { step: 'loaded', usedMB: 700, freeMB: 2650 }, { step: 'released', usedMB: 260, freeMB: 3080 }],
          },
    );
    // The passage "plays": her first word, then the end.
    shell.pluginReplies.set('Narration.play', () => {
      setTimeout(() => shell.emitPluginEvent('Narration', 'progress', { paragraph: 0 }), 150);
      setTimeout(() => shell.emitPluginEvent('Narration', 'state', { status: 'ended' }), 1400);
      return {};
    });
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('shows the pack and her studio, switches it, runs the whole test and copies one report', async () => {
    const page = shell.page;
    await page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await setDeveloperOptions(shell);
    await openDeveloper(shell);
    const dev = page.locator('[data-testid="screen-developer"]:not([inert])');
    await dev.getByTestId('dev-test').click();
    const screen = page.getByTestId('voice-test');
    await screen.waitFor({ timeout: 5000 });

    // The status block (the pack has a studio, which is off); its switch is in More › Developer now.
    const pack = screen.getByTestId('voice-test-pack');
    await expect.poll(() => pack.textContent(), { timeout: 5000 }).toContain('Nephis pack in use: nephis-r9 (made 2026-10-11).');
    expect(await pack.textContent()).toContain('Her studio: in this pack.');
    expect(await pack.textContent()).toContain('Studio: off.');
    // Studio off (2026-10-13: pack 7's studio, switched off, still loaded for the speed test, which never finished):
    // no speed test, straight to the listening test, and the result says it was skipped.
    expect(await screen.getByRole('checkbox', { name: 'Her studio' }).count()).toBe(0);
    await screen.getByRole('button', { name: 'Run the Test' }).click();
    await expect.poll(() => calls('Narration', 'play').length, { timeout: 5000 }).toBe(1);
    const skipped = screen.getByTestId('voice-test-result');
    await skipped.waitFor({ timeout: 10_000 });
    expect(await skipped.textContent()).toContain('Studio off: speed test skipped.');
    expect(calls('ExpressiveVoice', 'studioTest')).toEqual([]);

    // More › Developer › Studio: Automatic (for the pack in use).
    await screen.getByRole('button', { name: 'Back', exact: true }).click();
    await expect.poll(() => page.getByTestId('voice-test').count()).toBe(0);
    // A segmented control (Automatic | Off), like v1's.
    const automatic = dev.getByRole('tab', { name: 'Automatic', exact: true });
    await expect.poll(() => automatic.getAttribute('aria-selected'), { timeout: 5000 }).toBe('false');
    await automatic.click();
    await expect.poll(() => calls('ExpressiveVoice', 'studioEnable')).toEqual([{ on: true }]);
    await expect.poll(() => dev.getByRole('tab', { name: 'Automatic', exact: true }).getAttribute('aria-selected')).toBe('true');
    await dev.getByTestId('dev-test').click();
    await screen.waitFor({ timeout: 5000 });
    await expect.poll(() => pack.textContent(), { timeout: 5000 }).toContain('Studio: on (she reads at 44.1 kHz).');
    await page.waitForTimeout(450); // slide-in
    await page.screenshot({ path: path.join(shots, 'voice-test-top.png') });

    // One button runs the studio speed test, then the listening test (crash plan a2: native's studio test frees its own
    // studio and returns with Nephis warm again, so nothing is released in between and the start is Listen's).
    await screen.getByRole('button', { name: 'Run the Test' }).click();
    await expect.poll(() => calls('ExpressiveVoice', 'studioTest').length, { timeout: 5000 }).toBe(1);
    await expect.poll(() => calls('Narration', 'play').length, { timeout: 5000 }).toBe(2);
    const steps = shell.pluginCalls
      .map((c) => `${c.pluginId}.${c.methodName}`)
      .filter((s) => ['ExpressiveVoice.studioTest', 'ExpressiveVoice.unload', 'Narration.play'].includes(s));
    expect(steps).toEqual(['Narration.play', 'ExpressiveVoice.studioTest', 'Narration.play']);
    expect(calls('ExpressiveVoice', 'studioTestStop')).toEqual([]);
    const result = screen.getByTestId('voice-test-result');
    await result.waitFor({ timeout: 10_000 });
    expect(await result.textContent()).toContain('Studio: 2.3× real time — fast enough for live reading.');
    // Where her studio's models run is its own check now (crash plan a1), on its own button.
    expect(await result.textContent()).not.toContain('Chips:');
    await screen.getByTestId('voice-test-placement').click();
    await expect.poll(() => calls('ExpressiveVoice', 'studioTest').at(-1)).toEqual({ placement: true });
    await expect.poll(() => screen.getByTestId('voice-test-result').textContent()).toContain('Chips: blueprint 100% Neural Engine; vocoder 90% Neural Engine, 10% CPU.');
    expect(await screen.getByTestId('voice-test-placement').count()).toBe(0);
    const text = (await screen.getByTestId('voice-test-result').textContent()) ?? '';
    expect(text).toContain('Studio heat: nominal → fair.');
    expect(text).toContain('Studio is on for Nephis.');
    expect(text).toContain('No breaks: it never stopped to wait for the voice.');
    expect(text).toContain('Speed: 10.0× real time (goal 8×).');
    expect(await screen.getByTestId('voice-test-progress').textContent()).toBe('Done. Copy the report below.');
    expect(await screen.getByRole('button', { name: 'Run It Again' }).count()).toBe(1);

    // No developer controls on this page.
    const all = (await screen.textContent()) ?? '';
    expect(all).not.toMatch(/Speed test|Import voice|Mix a voice|Experimental|Free the model|Studio off|Use studio for Nephis/);

    // One Copy report: everything in one JSON.
    await screen.getByRole('textbox', { name: 'What did you hear?' }).fill('a click at 0:40');
    await page.evaluate(() => {
      const w = window as unknown as { __copied?: string };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t: string) => Promise.resolve(void (w.__copied = t)) } });
    });
    await screen.getByTestId('voice-test-copy').click();
    await expect.poll(() => screen.getByTestId('voice-test-copy').textContent()).toBe('Copied');
    const copied = JSON.parse(await page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? '{}')) as Record<string, unknown>;
    expect(copied.kind).toBe('nephis-test');
    expect(copied.pack).toEqual({ name: 'nephis-r9', made: '2026-10-11', studio: true, studioOn: true });
    expect(copied.studio).toMatchObject({ has: true, on: true, test: { ran: true, timesRealTime: 2.34, placement: { 'vocoder.cpu': 10 } } });
    expect((copied.studio as { test: { memory: unknown[] } }).test.memory).toHaveLength(3);
    expect(copied.voiceTest).toMatchObject({ kind: 'voice-test', ended: true });
    expect(copied.notes).toBe('a click at 0:40');
    expect(copied.device).toMatchObject({ thermal: 'nominal' });

    // Every control has a name VoiceOver can read.
    const unnamed = await screen.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('button, input, textarea, [role="button"]')]
        .filter((c) => !(c.getAttribute('aria-label') ?? c.textContent ?? '').trim())
        .map((c) => c.outerHTML.slice(0, 80)),
    );
    expect(unnamed).toEqual([]);

    await page.screenshot({ path: path.join(shots, 'voice-test.png'), fullPage: true });
    expect(shell.pageErrors).toEqual([]);
  });

  it('says why Nephis is switched off, in plain words, and one tap turns her back on', async () => {
    const page = shell.page;
    nephisOff = true;
    // Open More › Voices (it reads the voice settings when it opens): her card offers to turn her back on.
    await page.getByTestId('voice-test').getByRole('button', { name: 'Back' }).click();
    await expect.poll(() => page.getByTestId('voice-test').count()).toBe(0);
    await page.getByTestId('screen-developer').getByRole('button', { name: 'Back', exact: true }).click();
    await expect.poll(() => page.getByTestId('screen-developer').count()).toBe(0);
    await page.getByTestId('more-voices').click();
    const voices = page.getByTestId('screen-voices');
    const offRow = voices.getByTestId('voices-nephis-on');
    await expect.poll(() => offRow.textContent(), { timeout: 5000 }).toContain(OFF_LINE);
    expect(await offRow.textContent()).toContain('Turn Nephis Back On');
    await voices.getByRole('button', { name: 'Back', exact: true }).click();
    await expect.poll(() => page.getByTestId('screen-voices').count()).toBe(0);

    // The Voice test says it too, with her last cut-off and how the app last closed.
    await openDeveloper(shell);
    await page.getByTestId('screen-developer').getByTestId('dev-test').click();
    const screen = page.getByTestId('voice-test');
    const safety = screen.getByTestId('voice-test-safety');
    await expect.poll(() => safety.textContent(), { timeout: 5000 }).toContain(`${OFF_LINE} Her backup voice reads meanwhile.`);
    expect(await safety.textContent()).toContain('Her last cut-off: Nephis crashed at 2:32 PM, chapter 1026, phone warm.');
    expect(await safety.textContent()).toContain('Last time the app closed: The app crashed at 2:32 PM, chapter 1026, phone warm.');
    await page.waitForTimeout(450); // slide-in
    await page.screenshot({ path: path.join(shots, 'voice-test-nephis-off.png') });

    // One tap: native turns her back on and the page says so.
    await screen.getByTestId('voice-test-nephis-on').click();
    await expect.poll(() => calls('ExpressiveVoice', 'resetCrashes').length).toBe(1);
    await expect.poll(() => screen.getByTestId('voice-test-safety').count()).toBe(0);
    expect(await screen.getByTestId('voice-test-nephis-on').count()).toBe(0);
    expect(shell.pageErrors).toEqual([]);
  });

  it('the Listen player’s Voice panel (car mode) turns Nephis back on too', async () => {
    const page = shell.page;
    nephisOff = true;
    await page.getByTestId('voice-test').getByRole('button', { name: 'Back', exact: true }).click();
    await expect.poll(() => page.getByTestId('voice-test').count()).toBe(0);
    await page.getByTestId('screen-developer').getByRole('button', { name: 'Back', exact: true }).click();
    await expect.poll(() => page.getByTestId('screen-developer').count()).toBe(0);
    // She reads a novel aloud: the player offers Voice for it.
    shell.pluginReplies.set('Narration.state', () => ({
      status: 'playing', engine: 'speech', pluginId: 'demo-library', novelPath: 'novel/alpha', novelName: 'Alpha Story',
      chapterPath: 'novel/alpha/1', chapterName: 'Chapter 1', position: 10, duration: 600,
    }));
    await page.getByTestId('more-listen').click();
    await page.getByTestId('car-player').locator('[data-act="voice"]').click();
    const picker = page.locator('[data-testid="voice-picker"]:not([inert])');
    const offRow = picker.getByTestId('voices-nephis-on');
    await expect.poll(() => offRow.textContent(), { timeout: 5000 }).toContain(OFF_LINE);
    await offRow.click();
    await expect.poll(() => calls('ExpressiveVoice', 'resetCrashes').length).toBe(2);
    await expect.poll(() => picker.getByTestId('voices-nephis-on').count(), { timeout: 5000 }).toBe(0);
    expect(shell.pageErrors).toEqual([]);
  });
});
