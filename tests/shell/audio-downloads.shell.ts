/**
 * "Download with audio" part 2 in the PC shell (src/ui/native/audio-ui.tsx, audio-sheet.tsx, the v1 patches of
 * tools/v1-audio.ts), personal flavor, the demo source's three-chapter novel, a canned Narration plugin:
 *  - the novel card replaces Prepare for the Drive; it opens the download sheet (medium detent, Next 5 · Next 10 ·
 *    Unread, Include Narration Audio with her packs, size and time, Now · While Charging), which downloads the text
 *    first, asks about the notification once, then queues the audio (remembering the switch and timing);
 *  - the selection's Download opens it for the selected chapters; the ••• menu has Download… and Remove Downloaded Audio;
 *  - not enough space refuses; Nephis missing offers Download Her Voice;
 *  - chapter rows: headphones for text + audio, a ring for the chapter being made; the card line follows the events;
 *  - More › Downloads: the queue (Pause All, ✕ asks while a chapter is half made, Retry), Narration Audio (its list,
 *    Edit → delete asks, the switches, Delete All); More › Storage's row;
 *  - efficiency: the audio listener is there only while a screen shows the audio; no status reads while idle.
 * Screenshots (light and dark): .cache/shell-shots/audio-*.png
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
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
  [`${SITE}novel/alpha/2`]: { body: '<html><body><div id="content"><p>Chapter 2</p><p>The hall was quiet.</p></div></body></html>' },
  [`${SITE}novel/alpha/3`]: { body: fx('chapter-alpha-3.html') },
};
const KEY = 'demo-library:novel/alpha';

let shell: PcShell;
const alerts: { title: string; message: string }[] = [];
let answer = 0;
const menus: { title: string; destructive?: boolean }[][] = [];
let pick = '';
const state = {
  free: 50e9 as number | null,
  installed: true,
  notify: { status: 'notDetermined', asked: false },
  status: { jobs: [] as Record<string, unknown>[], audio: [] as Record<string, unknown>[], totalBytes: 0, deleteAfterListening: false, autoDownloadAudio: false },
};

const calls = (plugin: string, method: string): Record<string, unknown>[] =>
  shell.pluginCalls.filter((c) => c.pluginId === plugin && c.methodName === method).map((c) => c.options);
const top = () => shell.page.locator('.nav-root > .layer').last();
const sheet = () => shell.page.getByTestId('audio-sheet');
const live = (id: string) => shell.page.locator(`[data-testid="${id}"]:not([inert])`);

/** Light and dark screenshots of what's on screen now. */
async function shoot(name: string): Promise<void> {
  await shell.page.waitForTimeout(450); // after the push / sheet animation
  for (const scheme of ['light', 'dark'] as const) {
    await shell.page.emulateMedia({ colorScheme: scheme });
    await shell.page.waitForTimeout(80);
    await shell.page.screenshot({ path: path.join(shots, `audio-${name}-${scheme}.png`) });
  }
}

function emit(): void {
  shell.emitPluginEvent('Narration', 'audio', state.status);
}

const running = (sentence: number) => ({
  key: `${KEY}\u001fdownload`, novelKey: KEY, kind: 'download', pluginId: 'demo-library', novelPath: 'novel/alpha', novelName: 'Alpha Story',
  count: 2, done: 1, titles: ['Chapter 1'], when: 'now', voice: 'nephis', state: 'running', chapters: ['novel/alpha/1', 'novel/alpha/2'],
  current: { chapterPath: 'novel/alpha/2', title: 'Chapter 2', sentence, sentences: 100, step: 'rendering' },
});
const ready1 = { novelKey: KEY, chapterPath: 'novel/alpha/1', title: 'Chapter 1', voice: 'v', kind: 'download', bytes: 16_000_000, durationSec: 1000, createdAt: 1, fresh: true, novelName: 'Alpha Story' };

async function closeSheet(): Promise<void> {
  await sheet().getByTestId('sheet-close').click();
  await expect.poll(() => sheet().count(), { timeout: 3000 }).toBe(0);
}

describe('Download with audio (PC shell)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-audio');
    await buildAll({ flavor: 'personal', ads: false, dev: false, outDir: www });
    shell = await startPcShell({
      wwwDir: www,
      core: {
        routes,
        ui: {
          symbol: () => null,
          alert: (json, cb) => {
            alerts.push(JSON.parse(json) as { title: string; message: string });
            setImmediate(() => cb(null, answer));
          },
          actionSheet: (json, cb) => {
            const s = JSON.parse(json) as { actions: { title: string; destructive?: boolean }[] };
            menus.push(s.actions);
            setImmediate(() => cb(null, s.actions.findIndex((a) => a.title === pick)));
          },
        },
      },
      beforeLoad: async (core) => {
        await core.call('sources.install', { code: fx('spec.json') });
      },
      initStorage: { 'tachinovel.tips.reader': '1' },
    });
    shell.pluginReplies.set('Narration.audioStatus', () => state.status);
    shell.pluginReplies.set('Narration.audioEstimate', (o) => ({
      minutes: 16 * Number(o.chapters), megabytes: 16 * Number(o.chapters), renderMinutes: 11 * Number(o.chapters), bitRate: 128_000,
      megabytesPerMinute: 0.96, speedX: 1.5, measured: true, freeBytes: state.free,
    }));
    shell.pluginReplies.set('Narration.audioNotifications', (o) => {
      if (o.ask) state.notify = { status: 'authorized', asked: true };
      return state.notify;
    });
    shell.pluginReplies.set('Narration.audioEnqueue', () => {
      state.status = { ...state.status, jobs: [running(0)] };
      return state.status;
    });
    shell.pluginReplies.set('Narration.audioSetOptions', (o) => {
      state.status = { ...state.status, ...o };
      return state.status;
    });
    shell.pluginReplies.set('Narration.audioCancel', () => {
      state.status = { ...state.status, jobs: [] };
      return state.status;
    });
    shell.pluginReplies.set('Narration.audioDelete', () => {
      state.status = { ...state.status, audio: [], totalBytes: 0 };
      return state.status;
    });
    shell.pluginReplies.set('ExpressiveVoice.status', () => ({
      nephisPack: { name: 'nephis-r10', studio: true, studioOn: true },
      dialoguePack: { name: 'nephis-dialogue' },
      engines: [{ id: 'pocket-tts', installed: state.installed, bytes: 372_000_000, download: { state: 'idle' } }],
    }));
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = shell.page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('the card replaces Prepare for the Drive and listens to the audio status while it shows', async () => {
    await shell.page.getByTestId('tab-browse').click();
    await shell.page.getByTestId('source-demo-library').first().click();
    const grid = shell.page.locator('[data-testid="browse-grid"] .grid-hit').first();
    await expect.poll(() => grid.getAttribute('aria-label'), { timeout: 15_000 }).toBe('Alpha Story');
    await grid.click();
    await expect.poll(() => top().getByTestId('chapter-row').count(), { timeout: 15_000 }).toBe(3);
    const card = top().getByTestId('audio-card');
    await expect.poll(() => card.textContent(), { timeout: 5000 }).toBe('Download with AudioNephis reads chapters into audio ahead of time');
    expect(await top().getByTestId('drive-card').count()).toBe(0);
    expect(calls('Narration', 'audioStatus').length).toBeGreaterThanOrEqual(1);
    // Idle: no reads after the first (no polling).
    const reads = calls('Narration', 'audioStatus').length;
    await shell.page.waitForTimeout(1500);
    expect(calls('Narration', 'audioStatus').length).toBe(reads);
    await shoot('card');
  });

  it('the sheet: Next 5 · Next 10 · Unread, her voice, size and time; downloads the text, asks once, queues the audio', async () => {
    await top().getByTestId('audio-card').locator('button').click();
    await sheet().waitFor({ timeout: 5000 });
    expect(await sheet().locator('.sheet-title').textContent()).toBe('Download 2 Chapters');
    expect(await sheet().getByRole('tablist', { name: 'Which chapters' }).getByRole('tab').allTextContents()).toEqual(['Next 5', 'Next 10', 'Unread (2)']);
    await expect.poll(() => sheet().getByTestId('audio-include').textContent()).toBe('Include Narration AudioNephis · nephis-r10 + nephis-dialogue');
    await expect.poll(() => sheet().getByTestId('audio-size').textContent()).toBe('Audio SizeAbout 16 MB a chapter · ready in about 22 min32 MB');
    // Sized to its content: Download is in view without dragging the sheet up.
    expect(await sheet().getByRole('button', { name: 'Download', exact: true }).isVisible()).toBe(true);
    await shell.page.waitForTimeout(500); // the sheet's slide-in
    const view = shell.page.viewportSize();
    const btn = await sheet().getByRole('button', { name: 'Download', exact: true }).boundingBox();
    expect((btn?.y ?? 9999) + (btn?.height ?? 0)).toBeLessThanOrEqual(view?.height ?? 0);
    expect(await sheet().locator('.group-footer').first().textContent()).toBe('Audio is made on this iPhone, never while you’re listening. It pauses if the iPhone gets hot.');
    await shoot('sheet');
    await sheet().getByRole('tab', { name: 'While Charging' }).click();
    answer = 0; // "Continue" on the notification explanation
    await sheet().getByRole('button', { name: 'Download', exact: true }).click();
    await expect.poll(() => calls('Narration', 'audioEnqueue').length, { timeout: 5000 }).toBe(1);
    expect(calls('Narration', 'audioEnqueue')[0]).toMatchObject({
      pluginId: 'demo-library', novelPath: 'novel/alpha', novelName: 'Alpha Story', chapters: ['novel/alpha/1', 'novel/alpha/2'], when: 'charging', notify: true,
    });
    expect(alerts.find((a) => a.title === 'Notify You When It’s Ready?')).toBeDefined();
    expect(calls('Narration', 'audioNotifications').at(-1)).toEqual({ ask: true });
    await expect.poll(() => sheet().count(), { timeout: 3000 }).toBe(0);
    // Remembered: While Charging next time; the notification isn't asked about again.
    await top().getByTestId('audio-card').locator('button').click();
    await sheet().waitFor();
    expect(await sheet().getByRole('tab', { name: 'While Charging' }).getAttribute('aria-selected')).toBe('true');
    await closeSheet();
    expect(alerts.filter((a) => a.title === 'Notify You When It’s Ready?')).toHaveLength(1);
  });

  it('the card and the chapter rows follow the events: a ring for the chapter being made, headphones when ready', async () => {
    state.status = { ...state.status, jobs: [running(40)], audio: [ready1], totalBytes: 16_000_000 };
    emit();
    const card = top().getByTestId('audio-card');
    await expect.poll(() => card.locator('[data-audio-line]').textContent(), { timeout: 3000 }).toBe('Downloading 2 of 2 · Audio 70 %');
    const rows = top().getByTestId('chapter-row');
    await expect.poll(() => rows.nth(0).locator('.tn-audio-badge').count()).toBe(1);
    expect(await rows.nth(1).locator('svg.tn-ring').getAttribute('aria-label')).toBe('Making audio, 40 percent');
    expect(await rows.nth(2).locator('.tn-audio-badge, svg.tn-ring').count()).toBe(0);
    await rows.nth(2).scrollIntoViewIfNeeded();
    await shoot('badges');
    // A progress step that doesn't move a badge doesn't re-render the list (same ring element).
    const ring = await rows.nth(1).locator('svg.tn-ring').elementHandle();
    state.status = { ...state.status, jobs: [running(43)] };
    emit();
    await expect.poll(() => card.locator('[data-audio-line]').textContent()).toBe('Downloading 2 of 2 · Audio 72 %');
    expect(await ring?.evaluate((n) => n.isConnected)).toBe(true);
  });

  it('the selection’s Download opens the sheet for the selected chapters; the ••• menu has the audio items', async () => {
    const rows = top().getByTestId('chapter-row');
    await rows.nth(1).scrollIntoViewIfNeeded();
    const box = await rows.nth(1).boundingBox();
    if (!box) throw new Error('no row');
    await shell.page.mouse.move(box.x + 40, box.y + 20);
    await shell.page.mouse.down();
    await shell.page.waitForTimeout(700);
    await shell.page.mouse.up();
    await top().getByTestId('chapter-toolbar').getByRole('button', { name: 'Download' }).click();
    await sheet().waitFor({ timeout: 5000 });
    expect(await sheet().locator('.sheet-title').textContent()).toBe('Download 1 Chapter');
    expect(await sheet().getByRole('tab', { name: 'Next 5' }).count()).toBe(0);
    await closeSheet();

    // ••• menu (the native action sheet): Download… opens the sheet with the chapter choices.
    pick = 'Download…';
    await top().getByTestId('novel-more').click();
    await sheet().waitFor({ timeout: 5000 });
    expect(menus.at(-1)?.slice(-2).map((a) => [a.title, a.destructive === true])).toEqual([['Download…', false], ['Remove Downloaded Audio', true]]);
    expect(await sheet().getByRole('tab', { name: 'Next 5' }).count()).toBe(1);
    await closeSheet();
  });

  it('not enough space refuses; without her voice it offers Download Her Voice', async () => {
    state.free = 1.02e9;
    await top().getByTestId('audio-card').locator('button').click();
    await sheet().waitFor();
    await expect.poll(() => sheet().getByTestId('audio-space').textContent(), { timeout: 3000 }).toContain('Not Enough Space');
    expect(await sheet().getByRole('button', { name: 'Download', exact: true }).isDisabled()).toBe(true);
    await shoot('sheet-space');
    await closeSheet();
    state.free = 50e9;
    state.installed = false;
    await top().getByTestId('audio-card').locator('button').click();
    await sheet().waitFor();
    await expect.poll(() => sheet().getByTestId('audio-no-voice').textContent(), { timeout: 3000 }).toContain('Nephis Isn’t Available');
    expect(await sheet().getByRole('button', { name: 'Download Her Voice' }).count()).toBe(1);
    expect(await sheet().getByTestId('audio-size').count()).toBe(0);
    await closeSheet();
    state.installed = true;
  });

  it('stops listening when the novel page goes', async () => {
    const before = calls('Narration', 'removeListener').length;
    for (let i = 0; i < 2; i++) {
      await top().getByTestId('nav-back').click();
      await shell.page.waitForTimeout(500);
    }
    await expect.poll(() => calls('Narration', 'removeListener').length, { timeout: 3000 }).toBe(before + 1);
  });

  it('More › Downloads: the queue, Narration Audio and its list; More › Storage', async () => {
    await shell.page.getByTestId('tab-more').click();
    await shell.page.getByText('Downloads', { exact: true }).first().click();
    const page = shell.page.getByTestId('screen-downloads');
    await page.waitFor({ timeout: 5000 });
    const row = page.getByTestId('audio-queue-row');
    await expect.poll(() => row.textContent(), { timeout: 3000 }).toContain('Alpha StoryChapter 2 · Text ✓ · Audio 43 %');
    await shoot('queue');
    await page.getByTestId('audio-queue-all').click();
    await expect.poll(() => calls('Narration', 'audioPause')).toEqual([{ pluginId: 'demo-library', novelPath: 'novel/alpha', kind: 'download' }]);
    // ✕ while a chapter is half made: asks first.
    answer = 1; // Cancel
    await page.getByTestId('audio-queue-cancel').click();
    await expect.poll(() => alerts.at(-1)?.title).toBe('Stop Making Audio?');
    expect(calls('Narration', 'audioCancel')).toEqual([]);
    // A failed request: Retry queues its chapters again.
    state.status = { ...state.status, jobs: [{ ...running(0), state: 'failed', error: 'Couldn’t load novel/alpha/2', current: undefined }] };
    emit();
    await expect.poll(() => row.textContent()).toContain('Stopped after 3 tries: Couldn’t load novel/alpha/2');
    await row.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => calls('Narration', 'audioEnqueue').at(-1)?.chapters).toEqual(['novel/alpha/1', 'novel/alpha/2']);

    // Narration Audio: the value, the switches.
    state.status = { ...state.status, jobs: [], audio: [ready1], totalBytes: 16_000_000 };
    emit();
    await expect.poll(() => page.getByTestId('audio-storage').textContent()).toBe('Narration Audio16 MB · 1 chapter');
    await page.getByTestId('audio-auto').locator('input').click();
    await expect.poll(() => calls('Narration', 'audioSetOptions').at(-1)).toEqual({ autoDownloadAudio: true });
    await shoot('downloads');

    // Its list: Edit → delete asks first.
    await page.getByTestId('audio-storage').click();
    await live('audio-library').waitFor({ timeout: 3000 });
    await expect.poll(() => live('audio-library').getByTestId('audio-novels').textContent()).toContain('Alpha Story');
    await shoot('library');
    await live('audio-library').locator('[data-act="edit"]').click();
    answer = 0;
    await live('audio-library').getByRole('button', { name: 'Delete Alpha Story' }).click();
    await expect.poll(() => alerts.at(-1)?.title).toBe('Remove Downloaded Audio?');
    await expect.poll(() => calls('Narration', 'audioDelete').at(-1)).toEqual({ pluginId: 'demo-library', novelPath: 'novel/alpha' });
    await expect.poll(() => live('audio-library').getByTestId('audio-empty').textContent()).toContain('No Audio Yet');
    await shoot('library-empty');
    await live('audio-library').locator('[data-act="close"]').click();

    // More › Storage: its row.
    const removed = calls('Narration', 'removeListener').length;
    await top().getByTestId('nav-back').click();
    await expect.poll(() => calls('Narration', 'removeListener').length, { timeout: 3000 }).toBe(removed + 1);
    await shell.page.getByText('Storage', { exact: true }).first().click();
    await shell.page.getByTestId('screen-storage').waitFor({ timeout: 5000 });
    await expect.poll(() => shell.page.getByTestId('storage-audio').textContent(), { timeout: 5000 }).toContain('Narration Audio');
    expect(shell.pageErrors).toEqual([]);
  });
});
