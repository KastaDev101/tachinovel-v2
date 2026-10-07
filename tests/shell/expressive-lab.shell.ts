/**
 * Voice Lab › Experimental engines (src/ui/native/expressive-lab.ts) in the PC shell, against a canned
 * ExpressiveVoice plugin: reachable only through the hidden Voice Lab, a model download needs two taps,
 * Play / Kokoro A/B / Speed test send the sample's lines with their acting (emotion, style, speaker), pasted
 * text is annotated, and deleting a model needs a second tap too.
 * Screenshots: .cache/shell-shots/expressive-lab-engines.png, expressive-lab.png
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'shell-shots');
let shell: PcShell;

const status = {
  available: true,
  freeMB: 52_000,
  memoryWarnings: 0,
  kokoro: 'ready',
  crashes: { total: 0, consecutive: 0, disabled: false, lastContext: null, lastAt: null },
  device: { thermal: 'nominal', memoryMB: 240, availableMB: 3100, lowPower: false, os: 'Version 26.6.1' },
  engines: [
    {
      id: 'chatterbox-nano', title: 'Chatterbox Nano', blurb: 'Acts on tags.', license: 'MIT', upstream: 'ResembleAI/chatterbox-nano',
      bytes: 745_800_000, gpu: true, supported: true, installed: false, bytesOnDisk: 0, download: { state: 'idle' }, load: { state: 'unloaded' },
    },
    {
      id: 'neutts-2e', title: 'NeuTTS-2E', blurb: 'Seven emotions.', license: 'NeuTTS Open License v1.0', upstream: 'neuphonic/neutts-2e',
      bytes: 1_370_200_000, gpu: true, supported: true, installed: true, bytesOnDisk: 1_370_200_000, download: { state: 'idle' }, load: { state: 'ready' },
      lastLoadMs: 4200, lastLoadCold: true,
    },
  ],
  session: { state: 'idle' },
};

type Call = { methodName: string; options: Record<string, unknown> };
const calls = (method: string): Call[] => shell.pluginCalls.filter((c) => c.pluginId === 'ExpressiveVoice' && c.methodName === method);

describe('Voice Lab › Experimental engines (PC shell)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-expressive');
    await buildAll({ flavor: 'personal', ads: false, dev: false, outDir: www });
    shell = await startPcShell({ wwwDir: www, core: { routes: {}, answers: [] } });
    for (const m of ['status', 'download', 'cancelDownload', 'play', 'stop', 'speedTest', 'unload']) shell.pluginReplies.set(`ExpressiveVoice.${m}`, () => status);
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('opens from the hidden Voice Lab and drives the plugin', async () => {
    const page = shell.page;
    await page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.getByTestId('tab-more').click();
    await page.getByTestId('more-about').click();
    const version = page.locator('[data-testid="screen-about"] .about-version');
    for (let i = 0; i < 5; i++) await version.click();
    await page.getByTestId('voice-lab').waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: /Experimental engines/ }).click();
    const lab = page.getByTestId('expressive-lab');
    await lab.waitFor({ timeout: 5000 });
    await expect.poll(() => lab.locator('[data-engine]').count(), { timeout: 5000 }).toBe(2);
    await lab.locator('[data-engine="chatterbox-nano"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, 'expressive-lab-engines.png') });

    // A download needs a second tap that names the size and Wi-Fi.
    const cb = lab.locator('[data-engine="chatterbox-nano"]');
    await cb.getByRole('button', { name: 'Download 746 MB' }).click();
    expect(calls('download')).toEqual([]);
    await cb.getByRole('button', { name: /Tap again: download 746 MB on Wi-Fi/ }).click();
    await expect.poll(() => calls('download').map((c) => c.options.engine)).toEqual(['chatterbox-nano']);

    // Play the emotional dialogue with NeuTTS-2E: every line carries its acting.
    await lab.locator('[data-engine="neutts-2e"]').getByRole('button', { name: '▶ Play sample' }).click();
    await expect.poll(() => calls('play').length).toBe(1);
    const play = calls('play')[0]?.options as { engine: string; sample: string; lines: { text: string; emotion: string; role: string; style?: string }[] };
    expect(play.engine).toBe('neutts-2e');
    expect(play.sample).toBe('dialogue');
    expect(play.lines.length).toBe(11);
    expect(new Set(play.lines.map((l) => l.emotion)).size).toBeGreaterThanOrEqual(5);
    expect(play.lines.some((l) => l.style === 'whisper')).toBe(true);

    // The same sample with Kokoro (A/B), then a speed test.
    await lab.getByRole('button', { name: /Same sample with Kokoro/ }).click();
    await expect.poll(() => calls('play').map((c) => c.options.engine)).toEqual(['neutts-2e', 'kokoro']);
    await lab.locator('[data-engine="neutts-2e"]').getByRole('button', { name: 'Speed test' }).click();
    await expect.poll(() => calls('speedTest').map((c) => c.options.engine)).toEqual(['neutts-2e']);

    // Pasted text is annotated with guessed emotions and speakers.
    await lab.getByRole('button', { name: 'Your text' }).click();
    await lab.locator('textarea').fill('“Get out!” she shouted.\n“I’m sorry,” he whispered.');
    await lab.locator('[data-engine="neutts-2e"]').getByRole('button', { name: '▶ Play sample' }).click();
    await expect.poll(() => calls('play').length).toBe(3);
    const custom = calls('play')[2]?.options as { sample: string; lines: { emotion: string; role: string; style?: string }[] };
    expect(custom.sample).toBe('custom');
    expect(custom.lines.map((l) => [l.role, l.emotion, l.style ?? null])).toEqual([
      ['female', 'angry', null],
      ['male', 'neutral', 'whisper'],
    ]);

    // Deleting needs a second tap too, and says what happened.
    const neutts = lab.locator('[data-engine="neutts-2e"]');
    await neutts.getByRole('button', { name: 'Delete model' }).click();
    expect(calls('remove')).toEqual([]);
    await neutts.getByRole('button', { name: /Tap again: delete 1370 MB/ }).click();
    await expect.poll(() => calls('remove').map((c) => c.options.engine)).toEqual(['neutts-2e']);
    await expect.poll(() => lab.getByTestId('xlab-message').textContent(), { timeout: 5000 }).toBe('Model deleted.');

    await page.screenshot({ path: path.join(shots, 'expressive-lab.png') });
    expect(shell.pageErrors).toEqual([]);
  });
});
