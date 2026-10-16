/**
 * Voice speed test (src/ui/native/voice-speed.ts) in the PC shell, personal flavor, against a canned ExpressiveVoice
 * plugin: one tap from More › Developer and (Developer options on) the Listen player's Voice panel, not there without them; Run shows native's progress, then
 * the result in plain words, where the time went and the phone; Play result and Copy report work; Stop asks native
 * to stop.
 * Screenshot: .cache/shell-shots/voice-speed.png
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { openDeveloper, type PcShell, setDeveloperOptions, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'shell-shots');
let shell: PcShell;

const REPORT = {
  kind: 'voice-speed-test', ran: true, error: null, keepsUp: true, breaks: 0, breakSeconds: 0, failedCalls: 0, firstAudioMs: 1840,
  audioSeconds: 46.2, renderSeconds: 21.4, timesRealTime: 2.16,
  stages: { pocketGenerationMs: 9800, analysisMs: 600, recognizeMs: 0, mimiDecodeMs: 2100, studioBlueprintMs: 3300, studioVocoderMs: 5200, studioRestMs: 100, eqPostMs: 240 },
  studio: { read: true, calls: 5, used: 5, skipped: 0, reasons: {}, everyCall: true, studioEQCalls: 5 },
  chain: { clipFrames: 113, carryFrames: 12, studioEQPresent: true },
  slowestCall: { n: 2, x: 1.4, totalMs: 9000, audioS: 12.6, studio: 'used' },
  device: { model: 'iPhone17,3', ios: '26.6.1', lowPower: false, thermalStart: 'nominal', thermalEnd: 'fair', memoryStart: { freeMB: 2210 } },
  pack: { installed: true, name: 'Nephis narrator (clear, deeper)', weightsSha256: '17304f8de9e678571194205f6fc85eb54699cd9fddb248fd444cf0de043e3b27' },
  audioSamples: 2_037_420, saved: 'in TachiNovel-Diagnostics',
};

const calls = (plugin: string, method: string): Record<string, unknown>[] =>
  shell.pluginCalls.filter((c) => c.pluginId === plugin && c.methodName === method).map((c) => c.options);

describe('Voice speed test (PC shell)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-voice-speed');
    await buildAll({ flavor: 'personal', ads: false, dev: false, outDir: www });
    shell = await startPcShell({ wwwDir: www, core: { routes: {}, answers: [] }, initStorage: { 'tachinovel.tips.reader': '1' } });
    shell.pluginReplies.set('Narration.voiceSettings', () => ({
      voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', blurb: 'Warm.' }],
      defaultVoice: 'af_heart',
      kokoroEnabled: true,
      usePCAudio: false,
      kokoro: { bundled: true, status: 'ready', ready: true, crashDisabled: false, crashes: 0, revision: 'abc', bytes: 97_400_000 },
      apple: { name: 'Samantha', quality: 'default', onlyDefault: true },
      delivery: { listenEngine: 'pocket-tts', pocketVoice: 'nephis' },
    }));
    shell.pluginReplies.set('ExpressiveVoice.status', () => ({
      available: true, engines: [], crashes: { total: 0, disabled: false }, nephisPack: { name: 'Nephis narrator (clear, deeper)', studio: true, studioOn: true },
    }));
    // The test says how it goes, then answers its report.
    shell.pluginReplies.set('ExpressiveVoice.voiceSpeedTest', () => {
      shell.emitPluginEvent('ExpressiveVoice', 'voiceSpeedTest', { step: 'calls', text: 'Rendering call 2 (sentences 2–4 of 9)…', done: 1, total: 9 });
      return REPORT;
    });
    shell.pluginReplies.set('ExpressiveVoice.voiceSpeedTestPlay', (o) => (o.stop === true ? { playing: false } : { playing: true, seconds: 46.2 }));
    shell.pluginReplies.set('ExpressiveVoice.voiceSpeedTestStop', () => ({ stopping: true }));
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('is one tap from More › Developer, runs, says how it went, plays the result and copies the report', async () => {
    const page = shell.page;
    await page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await setDeveloperOptions(shell);
    await openDeveloper(shell);
    await page.getByTestId('screen-developer').getByTestId('dev-speed').click();
    const screen = page.getByTestId('voice-speed');
    await screen.waitFor({ timeout: 5000 });
    await expect.poll(() => screen.textContent(), { timeout: 5000 }).toContain('Nephis pack: Nephis narrator (clear, deeper), studio on.');

    await screen.getByRole('button', { name: 'Run the Speed Test' }).click();
    await expect.poll(() => calls('ExpressiveVoice', 'voiceSpeedTest').length).toBe(1);
    const result = screen.getByTestId('voice-speed-result');
    await result.waitFor({ timeout: 10_000 });
    const text = (await result.textContent()) ?? '';
    expect(text).toContain('Keeps up: yes.');
    expect(text).toContain('First audio after 1.8 s.');
    expect(text).toContain('Her studio rendered all 5 calls.');
    expect(text).toContain('Saved in TachiNovel-Diagnostics.');
    expect(await screen.getByTestId('voice-speed-stages').textContent()).toContain('Studio vocoder');
    expect(await screen.textContent()).toContain('weights 17304f8de9e6');

    await screen.getByRole('button', { name: 'Play Result' }).click();
    await expect.poll(() => calls('ExpressiveVoice', 'voiceSpeedTestPlay')).toEqual([{}]);
    await screen.getByRole('button', { name: 'Stop Playing' }).click();
    await expect.poll(() => calls('ExpressiveVoice', 'voiceSpeedTestPlay').length).toBe(2);
    await screen.getByTestId('voice-speed-copy').click();
    await expect.poll(() => screen.getByTestId('voice-speed-copy').textContent()).toMatch(/Copied|Copy Report/);
    await page.waitForTimeout(450); // slide-in
    await page.screenshot({ path: path.join(shots, 'voice-speed.png') });

    // Every control has a name for VoiceOver.
    for (const b of await screen.getByRole('button').all()) expect(((await b.getAttribute('aria-label')) ?? (await b.textContent()) ?? '').trim()).not.toBe('');
    expect(shell.pageErrors).toEqual([]);
  });

  it('is one tap from the Listen player’s Voice panel too, with Developer options on only', async () => {
    const page = shell.page;
    await page.getByTestId('voice-speed').getByRole('button', { name: 'Back', exact: true }).click();
    await expect.poll(() => page.getByTestId('voice-speed').count()).toBe(0);
    await page.getByTestId('screen-developer').getByRole('button', { name: 'Back', exact: true }).click();
    await expect.poll(() => page.getByTestId('screen-developer').count()).toBe(0);
    shell.pluginReplies.set('Narration.state', () => ({
      status: 'playing', engine: 'speech', pluginId: 'demo-library', novelPath: 'novel/alpha', novelName: 'Alpha Story',
      chapterPath: 'novel/alpha/1', chapterName: 'Chapter 1', position: 10, duration: 600,
    }));
    await page.getByTestId('more-listen').click();
    await page.getByTestId('car-player').locator('[data-act="voice"]').click();
    const picker = page.locator('[data-testid="voice-picker"]:not([inert])');
    // Titled with the novel; Voice Settings and the novel's pronunciations (Title Case rows).
    await expect.poll(() => picker.locator('h1').textContent(), { timeout: 5000 }).toBe('Alpha Story');
    expect(await picker.textContent()).toMatch(/Voice Settings[\s\S]*Voice Speed Test[\s\S]*Pronunciations for This Novel/);
    await picker.getByTestId('voices-speed').click();
    await page.getByTestId('voice-speed').waitFor({ timeout: 5000 });
    await page.getByTestId('voice-speed').getByRole('button', { name: 'Back', exact: true }).click();
    await expect.poll(() => page.getByTestId('voice-speed').count()).toBe(0);
    await picker.getByRole('button', { name: 'Back', exact: true }).click();
    // Without Developer options the panel has no speed test.
    await setDeveloperOptions(shell, { on: false });
    await page.getByTestId('car-player').locator('[data-act="voice"]').click();
    await expect.poll(() => picker.getByTestId('voices-settings').count(), { timeout: 5000 }).toBe(1);
    expect(await picker.getByTestId('voices-speed').count()).toBe(0);
    expect(shell.pageErrors).toEqual([]);
  });
});
