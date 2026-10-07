/**
 * v2's narration overlay over the v1 UI (src/ui/native/narration-overlay.ts), in the PC shell:
 *  - "Listen" lives in the reader's bottom bar with v1's tools (same style, one row) and shows and hides
 *    with the bars; while listening, the mini player follows the bars in the reader too;
 *  - the mini player says which voice speaks ("Kokoro · Heart", or "System voice (fallback) · why");
 *  - the Listen player's speed slider + chips and "Voice volume" slider, saved natively (survive a reload);
 *    dragged for real (mouse through WebKit's range control) across the player's 1 s state polls, they
 *    apply while dragging and on release (the phone build ignored the speed slider: the poll rebuilt it);
 *  - no floating Listen button anywhere, and v1's toasts never overlap the Listen tool or the mini player;
 *  - the mini player must not cover v1's bottom UI: the tab bar (it covered all five tabs while
 *    listening), the reader's bottom bar, the novel page's Resume button;
 *  - scrolling content gets room at its end, so nothing stays under the player;
 *  - "Open the player" on Listen in the Car leaves the screen's last rows reachable, with centered text.
 * Regression test for the UI crawler findings of 2026-10-06 (docs/qa.md).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import type { Route } from '../helpers/native-mock.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const fx = (n: string): string => readFileSync(path.join(root, 'tests', 'fixtures', 'demo-site', n), 'utf8');
const SITE = 'https://novels.example.test/';
const routes: Record<string, Route> = {
  [`${SITE}popular?page=1`]: { body: fx('popular.html') },
  [`${SITE}popular?page=2`]: { body: '<html><body></body></html>' },
  [`${SITE}novel/alpha`]: { body: fx('novel-alpha.html') },
  [`${SITE}novel/alpha/1`]: { body: fx('chapter-alpha-1.html') },
  [`${SITE}novel/alpha/2`]: { body: '<html><body><div id="content"><p>Chapter 2 - The Hall</p><p>The hall was long.</p></div></body></html>' },
};

let shell: PcShell;
const top = () => shell.page.locator('.nav-root > .layer').last();
/** What the native side saved through Narration.setVoiceSettings (the mock persists it like UserDefaults). */
const saved: { speed: number; volume: number; usePCAudio: boolean } = { speed: 1, volume: 1, usePCAudio: false };

const readerBars = (): Promise<boolean> => shell.page.evaluate(() => !!document.querySelector('[data-testid="screen-reader"].bars-visible'));
/** Toggle the reader's bars like a reader does: a tap in the middle of the page. */
async function tapPageMiddle(): Promise<void> {
  const vp = shell.page.viewportSize() ?? { width: 393, height: 852 };
  await shell.page.mouse.click(vp.width / 2, vp.height / 2);
}
/** Where an element is relative to the viewport: on screen, or pushed below it (v1 slides hidden bars away). */
function placement(selector: string): Promise<{ top: number; bottom: number; right: number; vh: number; vw: number } | null> {
  return shell.page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right), vh: innerHeight, vw: innerWidth };
  }, selector);
}
async function setRange(testSel: string, value: number): Promise<void> {
  await shell.page.locator(testSel).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, value);
}
const waitStack = (n: number) =>
  shell.page.waitForFunction((d) => document.querySelectorAll('.nav-root > .layer').length === d && !document.querySelector('.nav-root.is-animating'), n);

/** Vertical gap between the mini player and the top of `selector` (≥ 0 = no overlap), and what a tap there hits. */
function playerVs(selector: string): Promise<{ gap: number; hit: string } | null> {
  return shell.page.evaluate((sel) => {
    const layers = document.querySelectorAll('.nav-root > .layer');
    const el = layers[layers.length - 1]?.querySelector(sel);
    const p = document.querySelector('.tn-player');
    if (!el || !p || p.hasAttribute('hidden')) return null;
    const a = p.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(b.height / 2, 20));
    return { gap: Math.round(b.top - a.bottom), hit: hit?.closest('.tn-player') ? 'mini player' : (hit?.className.toString() ?? '') };
  }, selector);
}

describe('narration overlay over v1 screens (PC shell)', () => {
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-overlay');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({
      wwwDir: www,
      core: { routes, answers: [0, 0, 0, 0] },
      beforeLoad: async (core) => {
        await core.call('sources.install', { code: fx('spec.json') });
      },
      initStorage: { 'tachinovel.tips.reader': '1' },
    });
    shell.pluginReplies.set('Narration.voiceSettings', () => ({
      ...saved,
      defaultVoice: 'af_heart',
      voices: [
        { id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', blurb: 'warm' },
        { id: 'bm_george', name: 'George', language: 'en-GB', gender: 'male', blurb: 'classic' },
      ],
    }));
    shell.pluginReplies.set('Narration.setVoiceSettings', (o) => {
      const a = o as { speed?: number; volume?: number; usePCAudio?: boolean };
      if (typeof a.speed === 'number') saved.speed = a.speed;
      if (typeof a.volume === 'number') saved.volume = a.volume;
      if (typeof a.usePCAudio === 'boolean') saved.usePCAudio = a.usePCAudio;
      return {};
    });
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    await shell.page.getByTestId('onboarding-skip').click();
    await shell.page.getByTestId('tab-browse').click();
    await shell.page.getByTestId('source-demo-library').first().click();
    await waitStack(2);
    await shell.page.locator('[data-testid="browse-grid"] .grid-hit').first().click();
    await waitStack(3);
    await top().getByTestId('resume').click();
    await waitStack(4);
    await shell.page.locator('[data-testid="reader-chapter"][data-status="ready"]').first().waitFor({ timeout: 15_000 });
  });

  afterAll(async () => {
    await shell?.close();
  });

  it("puts Listen in the reader's bottom bar, styled and laid out like v1's tools", async () => {
    const tool = top().getByTestId('reader-listen');
    await tool.waitFor({ timeout: 5000 });
    expect(await tool.evaluate((el) => el.parentElement?.classList.contains('rd-tools') && el.closest('.rd-bottom') !== null)).toBe(true);
    expect(await tool.textContent()).toBe('Listen');
    const looks = await shell.page.evaluate(() => {
      const tools = [...document.querySelectorAll<HTMLElement>('[data-testid="screen-reader"] .rd-tools > .rd-tool')];
      const css = (el: HTMLElement) => {
        const c = getComputedStyle(el);
        return `${c.fontSize} ${c.fontWeight} ${c.color} ${c.flexDirection}`;
      };
      return {
        count: tools.length,
        sameStyle: new Set(tools.map(css)).size === 1,
        oneRow: new Set(tools.map((t) => Math.round(t.getBoundingClientRect().top))).size === 1,
        fits: tools.every((t) => t.getBoundingClientRect().right <= innerWidth && t.getBoundingClientRect().left >= 0),
        icon: !!document.querySelector('[data-testid="reader-listen"] i.icon'),
      };
    });
    expect(looks).toEqual({ count: 5, sameStyle: true, oneRow: true, fits: true, icon: true });
    // No floating button over the page any more.
    expect(await shell.page.locator('.tn-listen').count()).toBe(0);
  });

  it('shows and hides with the bars', async () => {
    expect(await readerBars()).toBe(true);
    await tapPageMiddle();
    await expect.poll(readerBars, { timeout: 3000 }).toBe(false);
    await expect.poll(async () => { const p = await placement('[data-testid="reader-listen"]'); return p ? p.top >= p.vh - 1 : null; }, { timeout: 3000 }).toBe(true);
    await tapPageMiddle();
    await expect.poll(readerBars, { timeout: 3000 }).toBe(true);
    await expect.poll(async () => { const p = await placement('[data-testid="reader-listen"]'); return p ? p.bottom <= p.vh && p.right <= p.vw : null; }, { timeout: 3000 }).toBe(true);
  });

  it('starts listening from the page; while listening it opens the player and the mini player follows the bars', async () => {
    await top().getByTestId('reader-listen').click();
    await expect.poll(() => shell.pluginCalls.filter((c) => c.pluginId === 'Narration' && c.methodName === 'play').length, { timeout: 5000 }).toBe(1);
    // NarrationPlugin answers play() and then reports its state, which shows the mini player.
    shell.emitPluginEvent('Narration', 'state', {
      status: 'playing', engine: 'speech', pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1', chapterName: 'Chapter 1 - Nightmare Begins',
      voice: { kokoroVoice: 'af_heart', kokoroName: 'Heart', source: 'kokoro' },
    });
    await shell.page.locator('.tn-player').waitFor({ state: 'visible', timeout: 5000 });
    await expect.poll(() => top().getByTestId('reader-listen').textContent()).toBe('Player');
    await tapPageMiddle();
    await expect.poll(readerBars, { timeout: 3000 }).toBe(false);
    await shell.page.locator('.tn-player').waitFor({ state: 'hidden', timeout: 3000 });
    await tapPageMiddle();
    await expect.poll(readerBars, { timeout: 3000 }).toBe(true);
    await shell.page.locator('.tn-player').waitFor({ state: 'visible', timeout: 3000 });
  });

  it("no floating Listen button anywhere, and toasts stay clear of the Listen tool and the mini player", async () => {
    // Only the bar tool carries "Listen from here"; nothing floats over the page.
    expect(await shell.page.evaluate(() => [...document.querySelectorAll('[aria-label="Listen from here"], .tn-listen')].every((e) => !!e.closest('.rd-tools')))).toBe(true);
    // A reader toast (bookmark), while listening with the bars up: v1's toast band vs our UI.
    await top().locator('.rd-top button[aria-label="Bookmark chapter"]').click();
    const toast = shell.page.locator('.toast').first();
    await toast.waitFor({ state: 'visible', timeout: 3000 });
    // Measured where it settles (it slides up 24 px as it appears).
    await toast.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
    // Measured until settled: the mini player may still be sliding (it follows the bars) when the toast appears.
    const measure = () => shell.page.evaluate(() => {
      const t = document.querySelector('.toast')?.getBoundingClientRect();
      const boxes = { listen: document.querySelector('[data-testid="screen-reader"] [data-testid="reader-listen"]'), player: document.querySelector('.tn-player:not([hidden])') };
      const out: Record<string, string> = {};
      for (const [k, el] of Object.entries(boxes)) {
        if (!el || !t) {
          out[k] = 'missing';
          continue;
        }
        const r = el.getBoundingClientRect();
        const overlaps = r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        out[k] = overlaps ? 'overlaps the toast' : hit && el.contains(hit) ? 'clear' : `covered by ${hit?.className.toString() ?? '?'}`;
      }
      return out;
    });
    await expect.poll(measure, { timeout: 2000 }).toEqual({ listen: 'clear', player: 'clear' });
    await toast.waitFor({ state: 'hidden', timeout: 8000 });
    await top().locator('.rd-top button[aria-label="Remove bookmark"]').click();
  });

  it('says which voice speaks, and why the system voice stands in', async () => {
    const sub = shell.page.locator('.tn-player .tn-title small');
    await expect.poll(() => sub.textContent()).toBe('Kokoro · Heart');
    shell.emitPluginEvent('Narration', 'state', { status: 'playing', voice: { kokoroVoice: 'af_heart', kokoroName: 'Heart', source: 'apple', appleName: 'Samantha', fallback: 'modelLoading' } });
    await expect.poll(() => sub.textContent()).toBe('System voice (fallback) · Kokoro is starting');
    shell.emitPluginEvent('Narration', 'state', { status: 'playing', voice: { kokoroVoice: 'af_heart', kokoroName: 'Heart', source: 'apple', fallback: 'modelUnavailable', kokoroStatus: 'Turned off after crashing twice' } });
    await expect.poll(() => sub.textContent()).toBe('System voice (fallback) · Kokoro unavailable: Turned off after crashing twice');
    shell.emitPluginEvent('Narration', 'state', { status: 'playing', voice: { kokoroVoice: 'af_heart', kokoroName: 'Heart', source: 'kokoro' } });
    await expect.poll(() => sub.textContent()).toBe('Kokoro · Heart');
  });

  it('Listen player: the speed slider and its chips agree, and "Voice volume" goes to 150 %', async () => {
    await shell.page.locator('.tn-player .tn-title').click();
    const player = shell.page.getByTestId('car-player');
    await player.locator('[data-testid="listen-controls"]').waitFor({ timeout: 5000 });
    const speed = '[data-testid="car-player"] [data-act="speed-slider"]';
    const volume = '[data-testid="car-player"] [data-act="volume"]';
    expect(await shell.page.locator(speed).evaluate((el) => [(el as HTMLInputElement).min, (el as HTMLInputElement).max, (el as HTMLInputElement).step])).toEqual(['0.5', '2.5', '0.05']);
    const onChip = () => player.locator('[data-act="speed"].on').allTextContents();
    expect(await onChip()).toEqual(['1×']);
    // The slider lights up the chip it sits on, and nothing between chips.
    await setRange(speed, 1.25);
    await expect.poll(onChip).toEqual(['1.25×']);
    expect(await player.locator('[data-speed-val]').textContent()).toBe('1.25×');
    await expect.poll(() => saved.speed).toBe(1.25);
    await setRange(speed, 1.35);
    await expect.poll(onChip).toEqual([]);
    await expect.poll(() => saved.speed).toBe(1.35);
    // A chip snaps the slider.
    await player.locator('[data-act="speed"][data-v="1.5"]').click();
    await expect.poll(() => shell.page.locator(speed).inputValue()).toBe('1.5');
    await expect.poll(() => saved.speed).toBe(1.5);
    // Voice volume, 0–150 %.
    expect(await shell.page.locator(volume).evaluate((el) => [(el as HTMLInputElement).min, (el as HTMLInputElement).max])).toEqual(['0', '150']);
    await setRange(volume, 130);
    expect(await player.locator('[data-volume-val]').textContent()).toBe('130%');
    await expect.poll(() => saved.volume).toBe(1.3);
    await player.locator('[data-act="close"]').click();
  });

  it('Listen player: dragging the sliders for real applies speed and volume while dragging and on release, across the 1 s polls', async () => {
    // The player polls Narration.state every second; report a playing chapter so it re-renders meanwhile.
    shell.pluginReplies.set('Narration.state', () => ({ status: 'playing', engine: 'speech', pluginId: 'demo-library', novelPath: 'novel/alpha', chapterName: 'Chapter 1', position: Date.now() / 1000 % 600, duration: 600 }));
    await shell.page.locator('.tn-player .tn-title').click();
    const player = shell.page.getByTestId('car-player');
    await player.locator('[data-testid="listen-controls"]').waitFor({ timeout: 5000 });
    // Let the player finish sliding up before pressing on its sliders.
    await expect.poll(() => player.evaluate((el) => el.getBoundingClientRect().top), { timeout: 3000 }).toBe(0);
    const speedSends = () => shell.pluginCalls.filter((c) => c.methodName === 'setVoiceSettings' && typeof c.options.speed === 'number').map((c) => c.options.speed as number);
    const volumeSends = () => shell.pluginCalls.filter((c) => c.methodName === 'setVoiceSettings' && typeof c.options.volume === 'number').map((c) => c.options.volume as number);
    /** Press on the slider's thumb, move in steps (holding through state polls), release at `to` (0…1). */
    async function drag(selector: string, from: number, to: number): Promise<void> {
      const input = shell.page.locator(selector);
      await input.evaluate((el) => ((el as HTMLElement).dataset.tnMark = '1'));
      const box = await input.boundingBox();
      if (!box) throw new Error('no slider');
      const x = (f: number) => box.x + 8 + (box.width - 16) * f;
      const y = box.y + box.height / 2;
      await shell.page.mouse.move(x(from), y);
      await shell.page.mouse.down();
      for (let i = 1; i <= 6; i++) {
        await shell.page.mouse.move(x(from + ((to - from) * i) / 6), y, { steps: 3 });
        await shell.page.waitForTimeout(300); // ≥ 1.8 s held in total: two state polls re-render the player
      }
      await shell.page.mouse.up();
      // The element under the finger was never replaced (a rebuilt slider loses its change event on iOS).
      expect(await input.evaluate((el) => (el as HTMLElement).dataset.tnMark === '1')).toBe(true);
    }
    const speedBefore = speedSends().length;
    await drag('[data-testid="car-player"] [data-act="speed-slider"]', 0.25, 0.75); // ≈1.0× → ≈2.0×
    const speeds = speedSends().slice(speedBefore);
    expect(speeds.length, 'sent while dragging, not only on release').toBeGreaterThanOrEqual(3);
    const finalSpeed = Number(await shell.page.locator('[data-testid="car-player"] [data-act="speed-slider"]').inputValue());
    expect(finalSpeed).toBeGreaterThan(1.8);
    expect(speeds.at(-1)).toBe(finalSpeed);
    await expect.poll(() => saved.speed).toBe(finalSpeed);
    expect(await player.locator('[data-speed-val]').textContent()).toBe(`${String(finalSpeed)}×`);
    expect(await player.locator('[data-act="speed"].on').allTextContents()).toEqual(finalSpeed === 2 ? ['2×'] : []);
    // Voice volume the same way.
    const volumeBefore = volumeSends().length;
    await drag('[data-testid="car-player"] [data-act="volume"]', 0.6, 0.95);
    expect(volumeSends().length - volumeBefore).toBeGreaterThanOrEqual(3);
    const finalVolume = Number(await shell.page.locator('[data-testid="car-player"] [data-act="volume"]').inputValue());
    expect(finalVolume).toBeGreaterThan(130);
    await expect.poll(() => saved.volume).toBe(finalVolume / 100);
    // Back to the values the next tests expect (chips/slider set them).
    await player.locator('[data-act="speed"][data-v="1.5"]').click();
    await shell.page.locator('[data-testid="car-player"] [data-act="volume"]').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '130';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => saved.volume).toBe(1.3);
    await expect.poll(() => saved.speed).toBe(1.5);
    shell.pluginReplies.delete('Narration.state');
    await player.locator('[data-act="close"]').click();
  });

  it("Listen player: with touch, iOS may never fire change on a range control: lifting the finger applies the value", async () => {
    await shell.page.locator('.tn-player .tn-title').click();
    const player = shell.page.getByTestId('car-player');
    await expect.poll(() => player.evaluate((el) => el.getBoundingClientRect().top), { timeout: 3000 }).toBe(0);
    const input = shell.page.locator('[data-testid="car-player"] [data-act="speed-slider"]');
    const box = await input.boundingBox();
    if (!box) throw new Error('no slider');
    const touch = { identifier: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await input.dispatchEvent('touchstart', { touches: [touch], targetTouches: [touch], changedTouches: [touch] });
    for (const v of [1.6, 1.7, 1.85]) {
      await input.evaluate((el, value) => {
        (el as HTMLInputElement).value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, v);
      await shell.page.waitForTimeout(450); // across a state poll
    }
    await input.dispatchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [touch] });
    await expect.poll(() => saved.speed).toBe(1.85);
    expect(await player.locator('[data-speed-val]').textContent()).toBe('1.85×');
    // Back to 1.5 for the next tests.
    await player.locator('[data-act="speed"][data-v="1.5"]').click();
    await expect.poll(() => saved.speed).toBe(1.5);
    await player.locator('[data-act="close"]').click();
  });

  it('Listen player: speed and volume are kept (reopen, and after a reload)', async () => {
    const player = shell.page.getByTestId('car-player');
    await shell.page.locator('.tn-player .tn-title').click();
    await expect.poll(() => shell.page.locator('[data-testid="car-player"] [data-act="speed-slider"]').inputValue()).toBe('1.5');
    expect(await shell.page.locator('[data-testid="car-player"] [data-act="volume"]').inputValue()).toBe('130');
    await player.locator('[data-act="close"]').click();
  });

  it('the voice picker never covers the Listen player once it is closing (crawler: "obscured by voice-picker")', async () => {
    // The player refreshes its state from Narration.state every second: report the novel being read.
    shell.pluginReplies.set('Narration.state', () => ({
      status: 'playing', engine: 'speech', pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1', chapterName: 'Chapter 1 - Nightmare Begins',
      voice: { kokoroVoice: 'af_heart', kokoroName: 'Heart', source: 'kokoro' },
    }));
    await shell.page.locator('.tn-player .tn-title').click();
    const player = shell.page.getByTestId('car-player');
    await player.locator('[data-act="voice"]').click();
    // The open picker (a closing one stays in the DOM, inert, for its 340 ms slide-out).
    const picker = shell.page.locator('[data-testid="voice-picker"]:not([inert])');
    await picker.waitFor({ state: 'visible' });
    /** Which dialog a tap in the middle of the player's Close button reaches. */
    const hitAtPlayerClose = () =>
      shell.page.evaluate(() => {
        const b = document.querySelector('[data-testid="car-player"] [data-act="close"]')?.getBoundingClientRect();
        if (!b) return 'no player';
        const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return el?.closest('[data-testid]')?.getAttribute('data-testid') ?? 'nothing';
      });
    // Opened from the player, the picker sits on top of it.
    await expect.poll(hitAtPlayerClose).toBe('voice-picker');
    // Back: the picker slides out, and the player gets taps at once (not 340 ms later).
    await picker.locator('[data-act="close"]').click();
    expect(await hitAtPlayerClose()).toBe('car-player');
    expect(await shell.page.locator('[data-testid="voice-picker"]').first().evaluate((el) => (el as HTMLElement).inert)).toBe(true);
    // Open it again and close the player underneath: no picker outlives the player or covers it next time.
    await player.locator('[data-act="voice"]').click();
    await picker.waitFor({ state: 'visible' });
    await shell.page.evaluate(() => (document.querySelector('[data-testid="car-player"] [data-act="close"]') as HTMLElement).click());
    await expect.poll(() => shell.page.getByTestId('voice-picker').count(), { timeout: 3000 }).toBe(0);
    await shell.page.locator('.tn-player .tn-title').click();
    await expect.poll(hitAtPlayerClose).toBe('car-player');
    await player.locator('[data-act="close"]').click();
    shell.pluginReplies.delete('Narration.state');
  });

  it('sits above the reader bottom bar and gives the chapter room at its end', async () => {
    await expect.poll(() => playerVs('.reader.bars-visible .rd-bottom'), { timeout: 3000 }).toMatchObject({ gap: 8 });
    expect(await shell.page.evaluate(() => document.documentElement.classList.contains('tn-player-on'))).toBe(true);
    const room = await shell.page.evaluate(() => {
      const c = document.querySelector('.reader-content');
      return c ? getComputedStyle(c, '::after').height : '';
    });
    expect(room).toBe('72px');
  });

  it("doesn't cover the novel page's Resume button", async () => {
    await top().getByTestId('reader-back').click();
    await waitStack(3);
    await expect.poll(() => playerVs('.fab'), { timeout: 3000 }).toMatchObject({ gap: 8 });
  });

  it("doesn't cover the tab bar: every tab stays tappable while listening", async () => {
    await top().getByTestId('nav-back').click();
    await waitStack(2);
    await top().getByTestId('nav-back').click();
    await waitStack(1);
    await expect.poll(() => playerVs('.tabbar'), { timeout: 3000 }).toMatchObject({ gap: 8 });
    for (const tab of ['library', 'updates', 'history', 'more', 'browse']) {
      // A real hit test (Playwright refuses to click an element covered by another one).
      await shell.page.getByTestId(`tab-${tab}`).click({ timeout: 3000 });
      await expect.poll(() => shell.page.getByTestId(`tab-${tab}`).getAttribute('aria-selected')).toBe('true');
    }
  });

  it('goes away (and so does the extra room) when narration stops', async () => {
    shell.emitPluginEvent('Narration', 'state', { status: 'idle' });
    await shell.page.locator('.tn-player').waitFor({ state: 'hidden', timeout: 3000 });
    await expect.poll(() => shell.page.evaluate(() => document.documentElement.classList.contains('tn-player-on'))).toBe(false);
  });

  it('after a reload, More › Listen opens the player with the saved speed and volume', async () => {
    await shell.page.reload();
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    await shell.page.getByTestId('tab-more').click();
    await shell.page.getByTestId('more-listen').click();
    await expect.poll(() => shell.page.locator('[data-testid="car-player"] [data-act="speed-slider"]').inputValue(), { timeout: 5000 }).toBe('1.5');
    expect(await shell.page.locator('[data-testid="car-player"] [data-act="volume"]').inputValue()).toBe('130');
    expect(await shell.page.getByTestId('car-player').locator('[data-act="speed"].on').allTextContents()).toEqual(['1.5×']);
    await shell.page.getByTestId('car-player').locator('[data-act="close"]').click();
  });

  it('Listen in the Car: "Open the player" is centered and leaves the last rows reachable', async () => {
    // That screen is the PC narrator's: More lists it only with Settings › Voices › Advanced › "Use PC audio
    // when available" on (src/ui/native/v1-hooks.ts); otherwise More › Listen opens the player directly.
    saved.usePCAudio = true;
    await shell.page.evaluate(() => window.dispatchEvent(new Event('tn-voice-settings')));
    await shell.page.getByTestId('tab-more').click();
    await shell.page.getByTestId('more-narration').waitFor({ state: 'visible', timeout: 3000 });
    await shell.page.getByTestId('more-narration').click();
    await waitStack(2);
    const button = shell.page.getByTestId('open-car-player');
    await button.waitFor({ state: 'visible', timeout: 3000 });
    expect(await button.evaluate((b) => getComputedStyle(b).textAlign)).toBe('center');
    const covered = await shell.page.evaluate(async () => {
      const scroller = document.querySelector('.nav-root > .layer:last-child .screen-scroll');
      if (!scroller) return 'no scroller';
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const leaves = [...scroller.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e as HTMLElement).innerText?.trim());
      const last = leaves.reduce<Element | null>((a, e) => (!a || e.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? e : a), null);
      if (!last) return 'no content';
      const r = last.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit?.closest('.tn-open-car') ? `"${(last as HTMLElement).innerText}" is under the button` : '';
    });
    expect(covered).toBe('');
  });

  it('ran without page errors', () => {
    expect(shell.pageErrors).toEqual([]);
    expect(shell.consoleErrors.filter((e) => !/403|Failed to load resource|blocked/i.test(e))).toEqual([]);
  });
});
