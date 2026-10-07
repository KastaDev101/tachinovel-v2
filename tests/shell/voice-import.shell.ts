/**
 * Narrator voices for Chatterbox Nano (src/ui/native/voice-import.ts in expressive-lab.ts; docs/voice-import.md)
 * in the PC shell, personal flavor, against an ExpressiveVoice mock that keeps voices like native does
 * (ImportedVoiceStore + BundledVoices):
 *  - Settings › Voices › Expressive voices: "Narrator voice" lists the voice that ships with the app (the
 *    default, in use), Chatterbox's own voice; shipped voices can't be renamed or deleted;
 *  - Import voice… : a refused file shows native's reason; a good one appears in the list;
 *  - Use makes it the narrator voice; ▶ Play when its file turned out missing at load time: Chatterbox Nano
 *    falls back to the default voice and the screen says so (section note + Now playing);
 *  - Use on Chatterbox's own voice sends "builtin"; Rename (inline field, Enter saves), Delete (second tap);
 *  - "Open in TachiNovel" (native event voiceImport) opens the screen with the result, success or failure;
 *  - the Kokoro/Apple voice settings are never written.
 * Screenshot: .cache/shell-shots/voice-import.png
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'shell-shots');
let shell: PcShell;

interface Voice {
  id: string;
  name: string;
  engine: string;
  createdAt: string;
  importedAt?: string;
  hasPreview: boolean;
  bundled: boolean;
  isDefault?: boolean;
}

const SHIPPED = 'b977be3f26cb8d509';
const MOMMY = 'v0a1b2c3d4e5f6a7b';
const KNIGHT = 'v1111222233334444';
const shipped: Voice = { id: SHIPPED, name: 'Narrator', engine: 'chatterbox-nano', createdAt: '2026-10-07T07:00:00Z', hasPreview: true, bundled: true, isDefault: true };
const state = {
  list: [] as Voice[],
  selected: null as string | null,
  loaded: null as string | null,
  note: null as string | null,
  session: { state: 'idle' } as Record<string, unknown>,
  importAttempts: 0,
  /** At the next Chatterbox load, the chosen voice's file is gone (deleted behind the app's back). */
  fileMissing: false,
};
const exists = (id: string): boolean => id === 'builtin' || id === SHIPPED || state.list.some((v) => v.id === id);
const nameOf = (id: string): string => (id === 'builtin' ? 'Original Chatterbox voice' : id === SHIPPED ? 'Narrator' : (state.list.find((v) => v.id === id)?.name ?? ''));

const status = (): Record<string, unknown> => ({
  available: true,
  freeMB: 40_000,
  memoryWarnings: 0,
  kokoro: 'ready',
  crashes: { total: 0, consecutive: 0, disabled: false, lastContext: null, lastAt: null },
  device: { thermal: 'nominal', memoryMB: 240, availableMB: 3100, lowPower: false, os: 'Version 26.6.1' },
  engines: [
    {
      id: 'chatterbox-nano', title: 'Chatterbox Nano', blurb: 'Acts on tags.', license: 'MIT', upstream: 'ResembleAI/chatterbox-nano',
      bytes: 745_800_000, gpu: true, supported: true, installed: true, bytesOnDisk: 745_800_000, download: { state: 'idle' }, load: { state: 'unloaded' },
    },
  ],
  session: state.session,
  voices: {
    engine: 'chatterbox-nano',
    engineTitle: 'Chatterbox Nano',
    importEnabled: true,
    default: SHIPPED,
    selected: state.selected,
    selectedMissing: false,
    loaded: state.loaded,
    note: state.note,
    list: [shipped, ...state.list].map((v) => ({ ...v })),
  },
});

const imported = (id: string, name: string): Voice => ({
  id, name, engine: 'chatterbox-nano', createdAt: '2026-10-06T23:50:00Z', importedAt: '2026-10-07T08:00:00Z', hasPreview: false, bundled: false,
});

const reject = (message: string, code: string): never => {
  throw Object.assign(new Error(message), { code });
};

describe('narrator voices: shipped and imported (PC shell)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-voice-import');
    await buildAll({ flavor: 'personal', ads: false, dev: false, outDir: www });
    shell = await startPcShell({ wwwDir: www, core: { routes: {}, answers: [] }, initStorage: { 'tachinovel.tips.reader': '1' } });
    shell.pluginReplies.set('Narration.voiceSettings', () => ({
      voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', blurb: 'warm', grade: 'A', gradeRank: 13 }],
      customVoices: [],
      defaultVoice: 'af_heart',
      kokoroEnabled: true,
      usePCAudio: false,
      kokoro: { bundled: true, status: 'Ready', ready: true, crashDisabled: false, crashes: 0, revision: 'abc', bytes: 108_900_000 },
      apple: { name: 'Zoe (Premium)', quality: 'premium', onlyDefault: false },
    }));
    for (const m of ['status', 'stop', 'play', 'unload']) shell.pluginReplies.set(`ExpressiveVoice.${m}`, status);
    shell.pluginReplies.set('ExpressiveVoice.importVoice', () => {
      state.importAttempts += 1;
      if (state.importAttempts === 1) return reject('This voice file is damaged (voice.safetensors doesn’t match its checksum).', 'INVALID_VOICE');
      const v = imported(MOMMY, 'Mommy');
      state.list.push(v);
      return { voice: { ...v }, replaced: false, status: status() };
    });
    shell.pluginReplies.set('ExpressiveVoice.selectVoice', (o) => {
      const id = (o as { id: string | null }).id;
      if (id !== null && !exists(id)) return reject('That voice isn’t on this iPhone any more.', 'NOT_FOUND');
      state.selected = id;
      state.note = null;
      return status();
    });
    shell.pluginReplies.set('ExpressiveVoice.playVoiceSample', (o) => {
      const id = (o as { id: string | null }).id ?? SHIPPED;
      // Like ExpressiveService.loadChatterbox: a voice that can't be read at load time → the default voice, and why.
      if (id === MOMMY && state.fileMissing) {
        state.loaded = SHIPPED;
        state.note = `Couldn’t use “Mommy”: The voice “${MOMMY}” isn’t on this iPhone any more. Using “Narrator” instead.`;
      } else {
        state.loaded = id;
      }
      state.session = {
        state: 'playing', engine: 'chatterbox-nano', title: 'Chatterbox Nano', sample: 'voice', total: 1, current: 0, rows: [],
        voice: { id: state.loaded, name: nameOf(state.loaded), loaded: true, note: state.note },
      };
      return { ...status(), played: 'chatterbox-nano' };
    });
    shell.pluginReplies.set('ExpressiveVoice.renameVoice', (o) => {
      const a = o as { id: string; name: string };
      const v = state.list.find((x) => x.id === a.id);
      if (!v) return reject('Voices that come with TachiNovel can’t be renamed or deleted.', 'INVALID_ARGS');
      v.name = a.name;
      return status();
    });
    shell.pluginReplies.set('ExpressiveVoice.deleteVoice', (o) => {
      const id = (o as { id: string }).id;
      state.list = state.list.filter((v) => v.id !== id);
      if (state.selected === id) state.selected = null;
      return status();
    });

    const page = shell.page;
    await page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.getByTestId('tab-more').click();
    await page.getByTestId('more-voices').click();
    await page.getByTestId('screen-voices').locator('[data-act="expressive"]').click();
    await page.getByTestId('xvoices').waitFor({ timeout: 5000 });
  });

  afterAll(async () => {
    await shell?.close();
  });

  const lab = () => shell.page.getByTestId('expressive-lab');
  const section = () => shell.page.getByTestId('xvoices');
  const row = (id: string) => section().locator(`[data-voice="${id}"]`);
  const message = () => lab().getByTestId('xlab-message');
  const calls = (method: string) => shell.pluginCalls.filter((c) => c.pluginId === 'ExpressiveVoice' && c.methodName === method).map((c) => c.options);

  it('starts with the shipped default voice as the narrator; shipped voices can be chosen but not renamed or deleted', async () => {
    await expect.poll(() => section().locator('.xv-row').count()).toBe(2);
    expect(await row(SHIPPED).textContent()).toContain('Narrator voice');
    expect(await row(SHIPPED).textContent()).toContain('Default');
    expect(await row(SHIPPED).textContent()).toContain('Comes with TachiNovel');
    expect(await row('builtin').textContent()).toContain('Original Chatterbox voice');
    for (const id of [SHIPPED, 'builtin']) {
      expect(await row(id).getByRole('button', { name: /^Rename/ }).count()).toBe(0);
      expect(await row(id).getByRole('button', { name: /^Delete/ }).count()).toBe(0);
    }
    expect(await row(SHIPPED).getByRole('button', { name: /^Use/ }).count()).toBe(0);
  });

  it('imports a voice, makes it the narrator voice, falls back to the default voice when its file is gone', async () => {
    // A refused file: native's reason is shown as an error, nothing is added.
    await section().getByRole('button', { name: 'Import voice…' }).click();
    await expect.poll(() => message().textContent()).toBe('This voice file is damaged (voice.safetensors doesn’t match its checksum).');
    expect(await message().getAttribute('data-error')).toBe('1');
    expect(await section().locator('.xv-row').count()).toBe(2);

    // A good file.
    await section().getByRole('button', { name: 'Import voice…' }).click();
    await expect.poll(() => message().textContent()).toBe('Imported “Mommy”. Tap Use to make it the narrator voice.');
    expect(await message().getAttribute('data-error')).toBe('0');
    await expect.poll(() => row(MOMMY).count()).toBe(1);
    expect(await row(MOMMY).textContent()).toContain('Imported 7 Oct 2026');

    // Use it: the narrator voice moves to Mommy, the shipped voice gets a Use button.
    await row(MOMMY).getByRole('button', { name: 'Use Mommy as the narrator voice' }).click();
    await expect.poll(() => calls('selectVoice')).toEqual([{ id: MOMMY }]);
    await expect.poll(() => row(MOMMY).textContent()).toContain('Narrator voice');
    expect(await row(SHIPPED).getByRole('button', { name: 'Use Narrator as the narrator voice' }).count()).toBe(1);

    // Listen while its file has gone missing: Chatterbox Nano reads with the default voice and says why.
    state.fileMissing = true;
    await row(MOMMY).getByRole('button', { name: 'Play a sample of Mommy' }).click();
    await expect.poll(() => calls('playVoiceSample')).toEqual([{ id: MOMMY }]);
    await expect.poll(() => section().getByTestId('xvoices-note').textContent()).toContain('Couldn’t use “Mommy”');
    expect(await section().getByTestId('xvoices-note').textContent()).toContain('Using “Narrator” instead.');
    const nowPlaying = lab().locator('.kv').first();
    await expect.poll(() => nowPlaying.textContent()).toContain('Narrator');
    expect(await row(SHIPPED).textContent()).toContain('loaded');
    await shell.page.screenshot({ path: path.join(shots, 'voice-import.png') });
  });

  it('chooses Chatterbox’s own voice by id, renames inline and deletes with a second tap', async () => {
    await row('builtin').getByRole('button', { name: 'Use Original Chatterbox voice as the narrator voice' }).click();
    await expect.poll(() => calls('selectVoice').at(-1)).toEqual({ id: 'builtin' });
    await expect.poll(() => row('builtin').textContent()).toContain('Narrator voice');

    await row(MOMMY).getByRole('button', { name: 'Rename Mommy' }).click();
    const field = section().getByRole('textbox', { name: 'New name for Mommy' });
    expect(await field.inputValue()).toBe('Mommy');
    await field.fill('Warm  Mommy');
    await field.press('Enter');
    await expect.poll(() => calls('renameVoice')).toEqual([{ id: MOMMY, name: 'Warm Mommy' }]);
    await expect.poll(() => row(MOMMY).locator('b').textContent()).toBe('Warm Mommy');

    await row(MOMMY).getByRole('button', { name: 'Delete Warm Mommy' }).click();
    expect(calls('deleteVoice')).toEqual([]);
    await row(MOMMY).getByRole('button', { name: 'Tap again: delete “Warm Mommy”' }).click();
    await expect.poll(() => calls('deleteVoice')).toEqual([{ id: MOMMY }]);
    await expect.poll(() => row(MOMMY).count()).toBe(0);

    // Back to the shipped default voice.
    await row(SHIPPED).getByRole('button', { name: 'Use Narrator as the narrator voice' }).click();
    await expect.poll(() => calls('selectVoice').at(-1)).toEqual({ id: SHIPPED });
    await expect.poll(() => row(SHIPPED).textContent()).toContain('Narrator voice');
  });

  it('shows the result of "Open in TachiNovel", even when the screen is closed', async () => {
    await lab().getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => lab().count()).toBe(0);
    state.list.push(imported(KNIGHT, 'Knight'));
    shell.emitPluginEvent('ExpressiveVoice', 'voiceImport', { ok: true, message: '“Knight” imported. Tap Use to make it the narrator voice.', id: KNIGHT });
    await lab().waitFor({ timeout: 5000 });
    await expect.poll(() => message().textContent()).toBe('“Knight” imported. Tap Use to make it the narrator voice.');
    await expect.poll(() => row(KNIGHT).count()).toBe(1);
    shell.emitPluginEvent('ExpressiveVoice', 'voiceImport', { ok: false, message: 'This voice is for “kokoro”, which TachiNovel can’t use.' });
    await expect.poll(() => message().getAttribute('data-error')).toBe('1');
    expect(await message().textContent()).toBe('This voice is for “kokoro”, which TachiNovel can’t use.');
  });

  it('never touches the Kokoro or Apple voice settings, and raises no page errors', () => {
    expect(shell.pluginCalls.filter((c) => c.pluginId === 'Narration' && c.methodName === 'setVoiceSettings')).toEqual([]);
    expect(shell.pageErrors).toEqual([]);
  });
});
