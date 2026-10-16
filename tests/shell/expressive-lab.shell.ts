/**
 * Voice Models (src/ui/native/expressive-lab.ts) in the PC shell, against a canned ExpressiveVoice plugin: reachable
 * through More › Developer › Voice Models (Developer options), a model download asks first (the native alert, with its
 * size and Wi-Fi), Play / Kokoro A/B / Speed test send the sample's lines with their acting (emotion, style, speaker),
 * pasted text is annotated, and deleting a model asks first too (cleanup 2: one confirmation style). One engine: hers.
 * Screenshots: .cache/shell-shots/expressive-lab-engines.png, expressive-lab.png
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { openDeveloper, type PcShell, setDeveloperOptions, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'shell-shots');
let shell: PcShell;
/** Native alerts the page asked for, and the answers (0 = the action, 1 = Cancel). */
const alerts: { title: string; message: string }[] = [];
const alertAnswers: number[] = [];

/** Her model: not downloaded until the download is asked for, then installed and loaded (what a finished download looks like). */
let installed = false;
const status = () => ({
  available: true,
  freeMB: 52_000,
  memoryWarnings: 0,
  kokoro: 'ready',
  crashes: { total: 0, consecutive: 0, disabled: false, lastContext: null, lastAt: null },
  device: { thermal: 'nominal', memoryMB: 240, availableMB: 3100, lowPower: false, os: 'Version 26.6.1' },
  engines: [
    {
      id: 'pocket-tts', title: 'Pocket TTS', blurb: 'Kyutai, 100M.', license: 'CC-BY-4.0', upstream: 'kyutai/pocket-tts',
      bytes: 367_500_000, installed, bytesOnDisk: installed ? 367_500_000 : 0, download: { state: 'idle' },
      load: { state: installed ? 'ready' : 'unloaded' }, ...(installed ? { lastLoadMs: 4200, lastLoadCold: true } : {}),
    },
  ],
  session: { state: 'idle' },
});

type Call = { methodName: string; options: Record<string, unknown> };
const calls = (method: string): Call[] => shell.pluginCalls.filter((c) => c.pluginId === 'ExpressiveVoice' && c.methodName === method);

describe('More › Developer › Voice Models (PC shell)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-expressive');
    await buildAll({ flavor: 'personal', ads: false, dev: false, outDir: www });
    shell = await startPcShell({
      wwwDir: www,
      core: {
        routes: {},
        answers: [],
        ui: {
          alert: (json, cb) => {
            alerts.push(JSON.parse(json) as { title: string; message: string });
            const a = alertAnswers.shift() ?? 0;
            setImmediate(() => cb(null, a));
          },
        },
      },
    });
    for (const m of ['status', 'cancelDownload', 'play', 'stop', 'speedTest', 'unload']) shell.pluginReplies.set(`ExpressiveVoice.${m}`, status);
    shell.pluginReplies.set('ExpressiveVoice.download', () => {
      installed = true;
      return status();
    });
    shell.pluginReplies.set('ExpressiveVoice.remove', () => {
      installed = false;
      return status();
    });
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('opens from More › Developer and drives the plugin', async () => {
    const page = shell.page;
    await page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await setDeveloperOptions(shell);
    await openDeveloper(shell);
    await page.getByTestId('screen-developer').getByTestId('dev-models').click();
    const lab = page.getByTestId('expressive-lab');
    await lab.waitFor({ timeout: 5000 });
    // One engine: hers (Chatterbox Nano and NeuTTS-2E were removed on 2026-10-16).
    await expect.poll(() => lab.locator('[data-engine]').count(), { timeout: 5000 }).toBe(1);
    const pocket = lab.locator('[data-engine="pocket-tts"]');
    await pocket.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, 'expressive-lab-engines.png') });
    expect(await lab.textContent()).not.toMatch(/Chatterbox|NeuTTS|Narrator voice|Import Voice/i);

    // A download asks first, naming the size and Wi-Fi; Cancel downloads nothing.
    alertAnswers.push(1);
    await pocket.getByRole('button', { name: 'Download 368 MB' }).click();
    await expect.poll(() => alerts.length).toBe(1);
    expect(alerts[0]?.title).toBe('Download Pocket TTS?');
    expect(alerts[0]?.message).toMatch(/368 MB.*Wi-Fi/);
    expect(calls('download')).toEqual([]);
    await pocket.getByRole('button', { name: 'Download 368 MB' }).click();
    await expect.poll(() => calls('download').map((c) => c.options.engine)).toEqual(['pocket-tts']);

    // Play the emotional dialogue with her: every line carries its acting.
    await pocket.getByRole('button', { name: 'Play Sample' }).click();
    await expect.poll(() => calls('play').length).toBe(1);
    const play = calls('play')[0]?.options as { engine: string; sample: string; lines: { text: string; emotion: string; role: string; style?: string }[] };
    expect(play.engine).toBe('pocket-tts');
    expect(play.sample).toBe('dialogue');
    expect(play.lines.length).toBe(11);
    expect(new Set(play.lines.map((l) => l.emotion)).size).toBeGreaterThanOrEqual(5);
    expect(play.lines.some((l) => l.style === 'whisper')).toBe(true);

    // The same sample with Kokoro (A/B), then a speed test.
    await lab.getByRole('button', { name: /Same Sample With Kokoro/ }).click();
    await expect.poll(() => calls('play').map((c) => c.options.engine)).toEqual(['pocket-tts', 'kokoro']);
    await pocket.getByRole('button', { name: 'Speed Test' }).click();
    await expect.poll(() => calls('speedTest').map((c) => c.options.engine)).toEqual(['pocket-tts']);

    // Pasted text is annotated with guessed emotions and speakers.
    await lab.getByRole('button', { name: 'Your text' }).click();
    await lab.locator('textarea').fill('“Get out!” she shouted.\n“I’m sorry,” he whispered.');
    await pocket.getByRole('button', { name: 'Play Sample' }).click();
    await expect.poll(() => calls('play').length).toBe(3);
    const custom = calls('play')[2]?.options as { sample: string; lines: { emotion: string; role: string; style?: string }[] };
    expect(custom.sample).toBe('custom');
    expect(custom.lines.map((l) => [l.role, l.emotion, l.style ?? null])).toEqual([
      ['female', 'angry', null],
      ['male', 'neutral', 'whisper'],
    ]);

    // Deleting asks first too (the size it frees), and says what happened.
    await pocket.getByRole('button', { name: 'Delete Model' }).click();
    await expect.poll(() => calls('remove').map((c) => c.options.engine)).toEqual(['pocket-tts']);
    expect(alerts.at(-1)).toMatchObject({ title: 'Delete Pocket TTS?', message: 'Frees 368 MB. You can download it again.' });
    await expect.poll(() => lab.getByTestId('xlab-message').textContent(), { timeout: 5000 }).toBe('Model deleted.');

    await page.screenshot({ path: path.join(shots, 'expressive-lab.png') });
    expect(shell.pageErrors).toEqual([]);
  });
});
