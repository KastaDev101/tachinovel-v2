/**
 * Full stack on the PC: built v1 UI (unchanged) + v2 Capacitor transport + Capacitor's native-bridge.js
 * + the built core in a JSC-like vm. Browse a declarative source → novel → read → "Listen".
 * Screenshots: .cache/shell-shots/*.png
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { buildScript, htmlToBlocks } from '@v1tts/frontend.ts';
import { encodeSegments } from '@v1tts/manifest.ts';
import type { Route } from '../helpers/native-mock.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'shell-shots');
const fx = (n: string): string => readFileSync(path.join(root, 'tests', 'fixtures', 'demo-site', n), 'utf8');
const SITE = 'https://novels.example.test/';
const routes: Record<string, Route> = {
  [`${SITE}popular?page=1`]: { body: fx('popular.html') },
  [`${SITE}popular?page=2`]: { body: '<html><body></body></html>' },
  [`${SITE}latest?page=1`]: { body: fx('popular.html') },
  [`${SITE}novel/alpha`]: { body: fx('novel-alpha.html') },
  [`${SITE}novel/alpha/1`]: { body: fx('chapter-alpha-1.html') },
  [`${SITE}novel/alpha/2`]: { body: '<html><body><div id="content"><p>Chapter 2 - The Hall</p><p>The hall was long and very quiet tonight.</p></div></body></html>' },
};

let shell: PcShell;

const top = () => shell.page.locator('.nav-root > .layer').last();
const waitStack = (n: number) =>
  shell.page.waitForFunction((d) => document.querySelectorAll('.nav-root > .layer').length === d && !document.querySelector('.nav-root.is-animating'), n);

describe('v1 UI in the v2 shell (PC)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({
      wwwDir: www,
      core: { routes, answers: [0, 0, 0, 0] },
      beforeLoad: async (core) => {
        await core.call('sources.install', { code: fx('spec.json') });
      },
      // v1's one-time reader tips overlay (3a25883+) would cover the reader in this test.
      initStorage: { 'tachinovel.tips.reader': '1' },
    });
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('boots through Core.call, shows v1 onboarding on first run, paints the library', async () => {
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    // First run with an empty library: v1 (3a25883+) shows onboarding. Skip it like a user would.
    await shell.page.getByTestId('onboarding').waitFor({ timeout: 5000 });
    await shell.page.screenshot({ path: path.join(shots, '0-onboarding.png') });
    await shell.page.getByTestId('onboarding-skip').click();
    await shell.page.getByTestId('onboarding').waitFor({ state: 'detached', timeout: 5000 });
    await shell.page.screenshot({ path: path.join(shots, '1-library.png') });
    // The launch screen is hidden once the library painted its boot content (not by the 3 s fallback),
    // and the boot timing line reaches the core log (ci/ios-sim-smoke.sh reads it on the simulator).
    await expect.poll(() => shell.pluginCalls.some((c) => c.pluginId === 'SplashScreen' && c.methodName === 'hide'), { timeout: 5000 }).toBe(true);
    type Boot = { bootCall: number | null; content: number | null; splash: number | null; fallback: boolean }; // src/ui/native/boot-timing.ts
    const boot = await shell.page.evaluate(() => (window as unknown as { __tnBoot?: Boot }).__tnBoot);
    expect(boot?.fallback).toBe(false);
    expect(boot?.content).toBeGreaterThan(boot?.bootCall ?? Infinity);
    expect(boot?.splash).toBeGreaterThanOrEqual(boot?.content ?? Infinity);
    await expect
      .poll(() => shell.core.logs.find((l) => l.line.includes('boot: library visible'))?.line ?? '', { timeout: 5000 })
      .toMatch(/boot: library visible \+\d+ms after WebView start, html \+\d+ms, dom ready \+\d+ms, app\.boot call \+\d+ms, launch screen hidden \+\d+ms; nav=\d+ epoch=\d+$/);
  });

  it('browses the declarative source and opens a novel', async () => {
    await shell.page.getByTestId('tab-browse').click();
    await shell.page.getByTestId('source-demo-library').first().click();
    await waitStack(2);
    const card = shell.page.locator('[data-testid="browse-grid"] .grid-hit').first();
    await expect.poll(() => card.getAttribute('aria-label'), { timeout: 15_000 }).toBe('Alpha Story');
    await shell.page.screenshot({ path: path.join(shots, '2-browse.png') });
    await card.click();
    await waitStack(3);
    await expect.poll(() => top().getByTestId('novel-title').textContent(), { timeout: 15_000 }).toBe('Alpha Story');
    await expect.poll(() => top().getByTestId('chapter-row').count()).toBe(3);
    await shell.page.screenshot({ path: path.join(shots, '3-novel.png') });
  });

  it('reads chapter 1 (sanitized, hidden anti-theft line removed) and offers Listen', async () => {
    await top().getByTestId('resume').click();
    await waitStack(4);
    const body = shell.page.locator('[data-testid="reader-chapter"][data-status="ready"] [data-testid="reader-body"]').first();
    await body.waitFor({ timeout: 15_000 });
    const text = (await body.textContent()) ?? '';
    expect(text).toContain('Nobody answered');
    expect(text).not.toContain('stolen');
    await top().getByTestId('reader-listen').waitFor({ state: 'visible', timeout: 5000 });
    await shell.page.screenshot({ path: path.join(shots, '4-reader.png') });
    await top().getByTestId('reader-listen').click();
    await expect.poll(() => shell.pluginCalls.find((c) => c.pluginId === 'Narration' && c.methodName === 'play')?.options).toMatchObject({
      pluginId: 'demo-library',
      novelPath: 'novel/alpha',
      chapterPath: 'novel/alpha/1',
      start: { paragraph: 0 },
    });
    const play = shell.pluginCalls.find((c) => c.pluginId === 'Narration' && c.methodName === 'play');
    const paragraphs = play?.options.paragraphs as { index: number; text: string }[];
    expect(paragraphs.length).toBeGreaterThanOrEqual(4);
    expect(paragraphs.some((p) => p.text.includes('Nobody answered'))).toBe(true);
    // The sentence script for Kokoro/Apple, built from the reader's DOM by the v1 narration front-end.
    const script = play?.options.script as { textHash: string; items: { id: number; paragraph: number; text: string; pauseMs: number }[] };
    expect(script.items.length).toBeGreaterThanOrEqual(4);
    expect(script.items.some((i) => i.text.includes('Nobody answered'))).toBe(true);
    expect(script.items.every((i) => i.paragraph >= 0 && i.paragraph < paragraphs.length && i.pauseMs > 0)).toBe(true);
  });

  it('highlights the sentence Kokoro (or the Apple voice) is speaking', async () => {
    const play = shell.pluginCalls.find((c) => c.pluginId === 'Narration' && c.methodName === 'play');
    const script = play?.options.script as { items: { id: number; block: number; start: number; end: number; hash: number; paragraph: number; text: string }[] };
    const target = script.items.find((i) => i.text.includes('Nobody answered'));
    expect(target).toBeDefined();
    shell.emitPluginEvent('Narration', 'state', { status: 'playing', engine: 'speech', chapterPath: 'novel/alpha/1', chapterName: 'Chapter 1', voice: { kokoroVoice: 'af_heart', kokoroName: 'Heart', source: 'kokoro' } });
    shell.emitPluginEvent('Narration', 'progress', { chapterPath: 'novel/alpha/1', engine: 'speech', source: 'kokoro', segment: target?.id, block: target?.block, start: target?.start, end: target?.end, hash: target?.hash, paragraph: target?.paragraph, sentence: 0 });
    await expect
      .poll(
        () =>
          shell.page.evaluate(() => {
            const h = (CSS as unknown as { highlights?: Map<string, Iterable<Range>> }).highlights?.get('tn-spoken');
            return h ? [...h].map((r) => r.toString()).join('|') : (document.querySelector('.tn-speaking')?.textContent ?? '');
          }),
        { timeout: 5000 },
      )
      .toMatch(/Nobody answered/);
    await expect.poll(() => shell.page.locator('.tn-player small').textContent(), { timeout: 5000 }).toBe('Kokoro · Heart');
    shell.emitPluginEvent('Narration', 'state', { status: 'playing', engine: 'speech', voice: { kokoroVoice: 'af_heart', kokoroName: 'Heart', source: 'apple', appleName: 'Ava', fallback: 'queueDry' } });
    await expect.poll(() => shell.page.locator('.tn-player small').textContent(), { timeout: 5000 }).toBe('System voice (fallback) · Kokoro is catching up');
    await shell.page.screenshot({ path: path.join(shots, '5b-speech-highlight.png') });
    shell.emitPluginEvent('Narration', 'state', { status: 'idle' });
  });

  it('highlights the spoken SENTENCE from narrated-audio timestamps (re-aligned onto the reader DOM)', async () => {
    // What tachinovel-narrator would write next to the .m4a: segments over the chapter's canonical blocks.
    const ch = await shell.core.call<{ html: string; title: string }>('chapter.get', { pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1' });
    const script = buildScript(htmlToBlocks(ch.html), { title: ch.title });
    const manifest = {
      schemaVersion: 1,
      kind: 'tachinovel.narration',
      createdAt: '2026-10-06T00:00:00Z',
      engine: { name: 'test', runtime: 'test', voice: 'af_heart', speed: 1, frontendVersion: script.frontendVersion },
      chapter: { pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1', title: ch.title },
      audio: { file: '0001 - Chapter 1.m4a', durationMs: script.segments.length * 1000, codec: 'aac', sampleRate: 24000, bytes: 1 },
      textHash: script.textHash,
      blockCount: script.blocks.length,
      segments: encodeSegments(
        script,
        script.segments.map((s) => [s.id * 1000, s.id * 1000 + 900] as const),
      ),
    };
    shell.pluginReplies.set('Narration.audioTiming', () => ({ hasAudio: true, json: JSON.stringify(manifest) }));
    const target = script.segments.find((s) => /Nobody answered/.test(htmlToBlocks(ch.html)[s.block]?.text.slice(s.start, s.end) ?? ''));
    expect(target).toBeDefined();
    shell.emitPluginEvent('Narration', 'progress', { chapterPath: 'novel/alpha/1', engine: 'audio', segment: target?.id, paragraph: target?.block, t: 1 });
    await expect
      .poll(
        () =>
          shell.page.evaluate(() => {
            const h = (CSS as unknown as { highlights?: Map<string, Iterable<Range>> }).highlights?.get('tn-spoken');
            return h ? [...h].map((r) => r.toString()).join('|') : (document.querySelector('.tn-speaking')?.textContent ?? '');
          }),
        { timeout: 5000 },
      )
      .toMatch(/Nobody answered/);
    console.log('alignment', await shell.page.evaluate(() => document.documentElement.dataset.tnAlign));
    await shell.page.screenshot({ path: path.join(shots, '5-sentence-highlight.png') });
  });

  it('saved reading progress through the core', async () => {
    await shell.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect
      .poll(async () => {
        const r = await shell.core.call<{ chapterPath: string }[]>('history.list', { limit: 5 });
        return r[0]?.chapterPath;
      }, { timeout: 10_000 })
      .toBe('novel/alpha/1');
  });

  it('More › Voices lists the Kokoro voices, the Apple fallback hint, and keeps PC audio under Advanced (off)', async () => {
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
    // Leave the reader (back to the tab root), then More.
    for (let i = 0; i < 5 && (await shell.page.locator('.nav-root > .layer').count()) > 1; i++) {
      const back = top().locator('[data-testid="reader-back"], [data-testid="nav-back"]').first();
      await back.click({ force: true, timeout: 3000 });
      await shell.page.waitForTimeout(600);
    }
    await shell.page.getByTestId('tab-more').click();
    // The PC narrator's "Listen in the Car" screen is hidden (PC audio off); "Listen" opens the player.
    await shell.page.getByTestId('more-listen').waitFor({ timeout: 5000 });
    expect(await shell.page.getByTestId('more-narration').isVisible()).toBe(false);
    await shell.page.getByTestId('more-listen').click();
    const player = shell.page.getByTestId('car-player');
    await player.waitFor({ state: 'visible', timeout: 5000 });
    await expect.poll(() => player.textContent(), { timeout: 5000 }).toMatch(/Listen/);
    expect((await player.textContent()) ?? '').not.toMatch(/TachiNovel Audio|Narrated on the PC/);
    await player.locator('[data-act="close"]').click();
    await player.waitFor({ state: 'hidden', timeout: 5000 });
    const row = shell.page.getByTestId('more-voices');
    await row.waitFor({ timeout: 5000 });
    await row.click();
    const screen = shell.page.getByTestId('screen-voices');
    await screen.waitFor({ timeout: 5000 });
    await expect.poll(() => screen.textContent(), { timeout: 5000 }).toMatch(/Heart[\s\S]*George/);
    const text = (await screen.textContent()) ?? '';
    expect(text).toContain('download a Premium voice');
    expect(text).toContain('Use PC audio when available');
    expect(await screen.locator('input[data-act="pcaudio"]').isChecked()).toBe(false);
    expect(text).not.toContain('Audio folder');
    await shell.page.waitForTimeout(450); // slide-in
    await shell.page.screenshot({ path: path.join(shots, '7-voices.png') });
    await screen.locator('[data-act="sample"][data-voice="bm_george"]').click();
    await expect.poll(() => shell.pluginCalls.find((c) => c.methodName === 'sampleVoice')?.options).toMatchObject({ voice: 'bm_george' });
    await screen.locator('[data-act="close"]').click();
  });

  it('About › Open Source Licenses shows the voice components (from THIRD_PARTY_NOTICES.md) and keeps LNReader', async () => {
    await shell.page.getByTestId('more-about').click();
    await top().getByTestId('licenses').click();
    const licenses = shell.page.getByTestId('screen-licenses');
    await licenses.waitFor({ timeout: 5000 });
    await expect.poll(() => licenses.textContent(), { timeout: 5000 }).toMatch(/LNReader/);
    // Built from THIRD_PARTY_NOTICES.md at build time (tools/third-party.ts): the voice notices are listed.
    const text = (await licenses.textContent()) ?? '';
    for (const name of ['Kokoro-82M', 'Kokoro Core ML conversion', 'FluidAudio', 'misaki']) expect(text).toContain(name);
  });

  it('ran without page errors', () => {
    expect(shell.pageErrors).toEqual([]);
    // Remote covers are blocked on purpose (403), so only cover errors are tolerated.
    expect(shell.consoleErrors.filter((e) => !/403|Failed to load resource|blocked/i.test(e))).toEqual([]);
  });
});
