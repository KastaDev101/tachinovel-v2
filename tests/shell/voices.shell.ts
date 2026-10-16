/**
 * More › Voices in v1's grouped-list look (src/ui/native/voices-ui.ts + panel.ts, cleanup 2, 2026-10-16), PC shell,
 * personal flavor, against canned Narration / ExpressiveVoice plugins:
 *  - Nephis: "Narrator · <pack> · Studio", "Dialogue · Uses the narrator" (then her dialogue pack's name), Voice Settings;
 *  - Download Her Voice while her model is missing: the native alert asks (size, Wi-Fi), the row shows the progress in
 *    place while ExpressiveVoice.status() is read once a second, and only then; when it's done the row goes away;
 *  - In the Car: Car Buttons as v1's segmented control, Prepared Audio's Remove All asks first;
 *  - Pronunciations: one title, "All Novels | This Novel" from a novel's Voice panel, each list its own;
 *  - the screens in light and dark mode, with v1's design tokens (no hard-coded dark panel colours).
 * Screenshots: .cache/shell-shots/voices-{light,dark}.png, voice-settings-*.png, backup-voice-*.png,
 * pronunciations-*.png, developer-*.png, voice-packs-*.png, drive-sheet-*.png
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { openDeveloper, type PcShell, setDeveloperOptions, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'shell-shots');
let shell: PcShell;
const alerts: { title: string; message: string }[] = [];

const novel = { pluginId: 'demo-library', novelPath: 'novel/alpha' };
const state = {
  pocketInstalled: true,
  download: { state: 'idle' } as Record<string, unknown>,
  dialoguePack: null as Record<string, unknown> | null,
  carButtons: 'chapters',
  prepared: [{ novelKey: 'demo-library:novel/alpha', chapterPath: 'novel/alpha/1', title: 'Chapter 1', durationSec: 900, bytes: 14_000_000 }],
};

const status = (): Record<string, unknown> => ({
  available: true,
  nephisPack: { name: 'nephis-r10', made: '2026-10-12', studio: true, studioOn: true },
  dialoguePack: state.dialoguePack,
  engines: [{ id: 'pocket-tts', title: 'Pocket TTS', bytes: 372_000_000, installed: state.pocketInstalled, download: state.download, load: { state: 'unloaded' } }],
  crashes: { total: 0, consecutive: 0, disabled: false },
  device: { thermal: 'nominal' },
  session: { state: 'idle' },
});

const calls = (plugin: string, method: string): Record<string, unknown>[] =>
  shell.pluginCalls.filter((c) => c.pluginId === plugin && c.methodName === method).map((c) => c.options);

describe('More › Voices (PC shell)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-voices');
    await buildAll({ flavor: 'personal', ads: false, dev: false, outDir: www });
    shell = await startPcShell({
      wwwDir: www,
      core: {
        ui: {
          // v1's drawn icons (the mock's SF Symbols aren't images), so the screenshots show the chevrons and checkmarks.
          symbol: () => null,
          alert: (json, cb) => {
            alerts.push(JSON.parse(json) as { title: string; message: string });
            setImmediate(() => cb(null, 0));
          },
        },
      },
      initStorage: { 'tachinovel.tips.reader': '1' },
    });
    shell.pluginReplies.set('Narration.voiceSettings', () => ({
      voices: [
        { id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', blurb: 'Warm.', grade: 'A', gradeRank: 13 },
        { id: 'af_nephis', name: 'Nephis', language: 'en-US', gender: 'female', blurb: 'Nephis’s voice, read fast by Kokoro.', grade: 'B', gradeRank: 10 },
      ],
      defaultVoice: 'af_heart',
      backupVoice: null,
      kokoroEnabled: true,
      carButtons: state.carButtons,
      kokoro: { bundled: true, status: 'ready', ready: true, crashDisabled: false, crashes: 0, revision: 'abc', bytes: 97_400_000 },
      apple: { name: 'Samantha', quality: 'default', onlyDefault: true },
      delivery: { listenEngine: 'pocket-tts', pocketVoice: 'nephis', pocketInstalled: state.pocketInstalled, natural: true, moods: true, sceneAI: true, sceneAIAvailable: false },
    }));
    shell.pluginReplies.set('Narration.setVoiceSettings', (o) => {
      if (typeof o.carButtons === 'string') state.carButtons = o.carButtons;
      return {};
    });
    shell.pluginReplies.set('Narration.driveStatus', () => ({ jobs: [], prepared: state.prepared, totalBytes: state.prepared.reduce((a, c) => a + c.bytes, 0) }));
    shell.pluginReplies.set('Narration.clearDrive', () => {
      state.prepared = [];
      return { jobs: [], prepared: [], totalBytes: 0 };
    });
    shell.pluginReplies.set('ExpressiveVoice.status', status);
    shell.pluginReplies.set('ExpressiveVoice.download', () => {
      state.download = { state: 'downloading', fraction: 0.3, filesDone: 1, filesTotal: 4 };
      return status();
    });
    shell.pluginReplies.set('ExpressiveVoice.nephisPacks', () => ({ packs: [], totalBytes: 0 }));
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = shell.page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
  });

  afterAll(async () => {
    await shell?.close();
  });

  const live = (id: string) => shell.page.locator(`[data-testid="${id}"]:not([inert])`);
  const settled = async (id: string) => {
    await live(id).waitFor({ timeout: 5000 });
    await expect.poll(() => live(id).evaluate((n) => Math.round(n.getBoundingClientRect().left)), { timeout: 3000 }).toBe(0);
  };
  const back = async (id: string) => {
    await live(id).locator('[data-act="close"]').click();
    await expect.poll(() => live(id).count(), { timeout: 3000 }).toBe(0);
  };
  /** Light and dark screenshots of what's on screen now. */
  const shoot = async (name: string) => {
    for (const scheme of ['light', 'dark'] as const) {
      await shell.page.emulateMedia({ colorScheme: scheme });
      await shell.page.waitForTimeout(60);
      await shell.page.screenshot({ path: path.join(shots, `${name}-${scheme}.png`) });
    }
    await shell.page.emulateMedia({ colorScheme: 'light' });
  };
  const colours = (id: string) =>
    live(id).evaluate((el) => {
      const card = el.querySelector('.card');
      return { panel: getComputedStyle(el).backgroundColor, card: card ? getComputedStyle(card).backgroundColor : '', text: getComputedStyle(el).color };
    });

  it('Nephis: her narrator and dialogue packs, Voice Settings; light and dark follow v1’s tokens', async () => {
    await shell.page.getByTestId('tab-more').click();
    await shell.page.getByTestId('more-voices').click();
    await settled('screen-voices');
    const voices = live('screen-voices');
    await expect.poll(() => voices.getByTestId('voices-narrator').textContent(), { timeout: 5000 }).toBe('Narratornephis-r10 · Studio');
    expect(await voices.getByTestId('voices-dialogue').textContent()).toBe('DialogueUses the narrator');
    expect(await voices.locator('.sec').allTextContents()).toEqual(['Nephis', 'Backup Voice', 'Pronunciations', 'In the Car']);
    expect(await voices.getByTestId('voices-download').count()).toBe(0);
    // Footers, not subtitles under every row.
    expect(await voices.locator('.note').first().textContent()).toBe('Her own voice, with moods for the scene.');
    await shoot('voices');

    // Light: v1's grouped background and white cards, dark text; dark: black and #1c1c1e cards, light text.
    await shell.page.emulateMedia({ colorScheme: 'light' });
    expect(await colours('screen-voices')).toEqual({ panel: 'rgb(255, 255, 255)', card: 'rgb(243, 242, 248)', text: 'rgb(27, 27, 31)' });
    await shell.page.emulateMedia({ colorScheme: 'dark' });
    expect(await colours('screen-voices')).toEqual({ panel: 'rgb(0, 0, 0)', card: 'rgb(28, 28, 30)', text: 'rgb(242, 240, 246)' });
    await shell.page.emulateMedia({ colorScheme: 'light' });

    await voices.getByTestId('voices-settings').click();
    await settled('narrator-settings');
    expect(await live('narrator-settings').locator('.sec').allTextContents()).toEqual(['Scene', '[System] Messages']);
    await shoot('voice-settings');
    await back('narrator-settings');
    await voices.getByTestId('voices-backup-voice').click();
    await settled('backup-voice');
    await shoot('backup-voice');
    await back('backup-voice');

    // Her dialogue pack, once she has one (read when the screen opens).
    state.dialoguePack = { name: 'nephis-dialogue', made: '2026-10-15', role: 'dialogue' };
    await back('screen-voices');
    await shell.page.getByTestId('more-voices').click();
    await expect.poll(() => live('screen-voices').getByTestId('voices-dialogue').textContent(), { timeout: 5000 }).toBe('Dialoguenephis-dialogue');
    expect(shell.pageErrors).toEqual([]);
  });

  it('Download Her Voice: asks first, shows its progress in place, reads the status only while it downloads', async () => {
    state.pocketInstalled = false;
    await back('screen-voices');
    await shell.page.getByTestId('more-voices').click();
    const voices = live('screen-voices');
    const row = voices.getByTestId('voices-download');
    await expect.poll(() => row.textContent(), { timeout: 5000 }).toBe('Download Her Voice~372 MB');
    expect(await voices.locator('.note').first().textContent()).toBe('Her voice downloads once, on Wi-Fi. Until then her backup voice reads.');
    // No download going on: one status read when the screen opened, none after.
    const reads = () => calls('ExpressiveVoice', 'status').length;
    const before = reads();
    await shell.page.waitForTimeout(1500);
    expect(reads()).toBe(before);

    await row.click();
    await expect.poll(() => calls('ExpressiveVoice', 'download')).toEqual([{ engine: 'pocket-tts' }]);
    expect(alerts.at(-1)).toMatchObject({ title: 'Download Her Voice?', message: '372 MB on this iPhone. Use Wi-Fi and keep TachiNovel open until it’s done.' });
    await expect.poll(() => row.textContent()).toBe('Downloading Her Voice…30%');
    const el = await row.elementHandle();
    state.download = { state: 'downloading', fraction: 0.8, filesDone: 3, filesTotal: 4 };
    await expect.poll(() => row.textContent(), { timeout: 4000 }).toBe('Downloading Her Voice…80%');
    expect(await row.locator('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('80');
    expect(await el?.evaluate((n) => n.isConnected), 'updated in place, not rebuilt').toBe(true);
    await shoot('voices-downloading');

    // Done: the row goes away (her model is on the phone) and the reads stop.
    state.download = { state: 'idle' };
    state.pocketInstalled = true;
    await expect.poll(() => voices.getByTestId('voices-download').count(), { timeout: 4000 }).toBe(0);
    const after = reads();
    await shell.page.waitForTimeout(2500);
    expect(reads()).toBe(after);
    expect(shell.pageErrors).toEqual([]);
  });

  it('In the Car: Car Buttons as a segmented control; Remove All prepared audio asks first', async () => {
    const voices = live('screen-voices');
    const seg = voices.getByRole('tablist', { name: 'Car Buttons' });
    expect(await seg.getByRole('tab', { name: 'Chapters' }).getAttribute('aria-selected')).toBe('true');
    await seg.getByRole('tab', { name: '15 Seconds' }).click();
    await expect.poll(() => calls('Narration', 'setVoiceSettings').at(-1)).toEqual({ carButtons: 'skip15' });
    await expect.poll(() => voices.getByRole('tab', { name: '15 Seconds' }).getAttribute('aria-selected')).toBe('true');

    const prepared = voices.getByTestId('voices-prepared');
    await expect.poll(() => prepared.textContent(), { timeout: 5000 }).toContain('1 chapter · 14 MB');
    await prepared.getByRole('button', { name: 'Remove All' }).click();
    await expect.poll(() => calls('Narration', 'clearDrive').length).toBe(1);
    expect(alerts.at(-1)?.title).toBe('Remove All Prepared Audio?');
    await expect.poll(() => prepared.textContent()).toContain('Nothing prepared');
    expect(await prepared.getByRole('button', { name: 'Remove All' }).count()).toBe(0);
    await shell.page.locator('[data-testid="screen-voices"] .body').evaluate((b) => b.scrollTo(0, b.scrollHeight));
    await shoot('voices-bottom');
  });

  it('Pronunciations: one title, "All Novels | This Novel" from a novel, each list its own', async () => {
    await live('screen-voices').getByTestId('voices-lexicon').click();
    await settled('lexicon-editor');
    const editor = live('lexicon-editor');
    expect(await editor.locator('.hd h1').textContent()).toBe('Pronunciations');
    expect(await editor.getByRole('tablist').count(), 'every novel: no switch').toBe(0);
    await editor.locator('[data-f="match"]').fill('Nephis');
    await editor.locator('[data-f="say"]').fill('NEF-iss');
    await editor.getByRole('button', { name: 'Add to All Novels' }).click();
    await expect.poll(() => editor.getByTestId('lexicon-words').textContent()).toContain('Nephis');
    await shoot('pronunciations');
    await back('lexicon-editor');
    await back('screen-voices');

    // A novel's Voice panel (the Listen player): titled with the novel, "Voice" first.
    shell.pluginReplies.set('Narration.state', () => ({
      status: 'playing', engine: 'speech', ...novel, novelName: 'Alpha Story', chapterPath: 'novel/alpha/1', chapterName: 'Chapter 1', position: 10, duration: 600,
    }));
    await shell.page.getByTestId('more-listen').click();
    await shell.page.getByTestId('car-player').locator('[data-act="voice"]').click();
    await settled('voice-picker');
    const picker = live('voice-picker');
    expect(await picker.locator('.sec').first().textContent()).toBe('Voice');
    await picker.locator('[data-act="lexicon"]').click();
    await settled('lexicon-editor');
    const tabs = editor.getByRole('tablist', { name: 'Which list' });
    expect(await tabs.getByRole('tab', { name: 'This Novel' }).getAttribute('aria-selected')).toBe('true');
    expect(await editor.locator('.sec').first().textContent()).toBe('0 Words');
    await editor.locator('[data-f="match"]').fill('Sunny');
    await editor.locator('[data-f="say"]').fill('SUN-ee');
    await editor.getByRole('button', { name: 'Add to This Novel' }).click();
    await expect.poll(() => editor.getByTestId('lexicon-words').textContent()).toContain('Sunny');
    const lists = await shell.core.call<{ global: { entries: { match: string }[] }; novel: { entries: { match: string }[] } | null }>('narration.lexicon.get', {
      novelKey: `${novel.pluginId}:${novel.novelPath}`,
    });
    expect(lists.novel?.entries.map((e) => e.match)).toEqual(['Sunny']);
    expect(lists.global.entries.map((e) => e.match)).toEqual(['Nephis']);
    await tabs.getByRole('tab', { name: 'All Novels' }).click();
    await expect.poll(() => editor.getByTestId('lexicon-words').textContent()).toContain('Nephis');
    expect(await editor.getByTestId('lexicon-words').textContent()).not.toContain('Sunny');
    // Delete asks first.
    await editor.getByRole('button', { name: 'Delete Nephis' }).click();
    await expect.poll(() => alerts.at(-1)?.title).toBe('Delete “Nephis”?');
    await expect.poll(() => editor.getByTestId('lexicon-words').count()).toBe(0);
    await shoot('pronunciations-novel');
    await back('lexicon-editor');
    await back('voice-picker');
    await shell.page.getByTestId('car-player').locator('[data-act="close"]').click();
    shell.pluginReplies.delete('Narration.state');
    expect(shell.pageErrors).toEqual([]);
  });

  it('More › Developer and Voice Packs in both themes', async () => {
    await setDeveloperOptions(shell);
    await openDeveloper(shell);
    await settled('screen-developer');
    await shoot('developer');
    await live('screen-developer').getByTestId('dev-packs').click();
    await settled('voice-packs');
    await shoot('voice-packs');
    await back('voice-packs');
    await back('screen-developer');
    expect(shell.pageErrors).toEqual([]);
  });
});
