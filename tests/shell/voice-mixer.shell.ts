/**
 * More › Voices › Backup Voice and the voice mixer (src/ui/native/voices-ui.ts) in the PC shell, against a Narration
 * mock that keeps the backup voice and mixes like native does (VoicePreferences.backupVoice / customVoices):
 *  - Backup Voice (cleanup 2, 2026-10-16): her matched Kokoro voice until another is picked; its list shows the three
 *    best first (her matched voice, then the best graded) with ▶ samples, then All Voices; a pick is saved
 *    (setVoiceSettings {backupVoice}) and the Voices row names it;
 *  - All Voices: every voice by accent and gender and "Your Mixes"; Mix a Voice and Edit only with Developer options;
 *  - the mixer (More › Developer › Mix a Voice): two voices, the blend slider dragged for real (the screen updates in
 *    place, the slider is never rebuilt under the finger), ▶ plays the blend string, Save stores it;
 *  - a mix can be the backup voice; Edit keeps its id; the same voice twice can't be saved; Delete asks with the native
 *    alert and sends the backup voice back to her matched voice.
 * Screenshots: .cache/shell-shots/backup-voice.png, all-voices.png, voice-mixer.png
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

interface Mix {
  id: string;
  name: string;
  a: string;
  b: string;
  percent: number;
}
const prefs = { backupVoice: null as string | null, customVoices: [] as Mix[] };
const voices = [
  { id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', blurb: 'warm', grade: 'A', gradeRank: 13 },
  { id: 'af_bella', name: 'Bella', language: 'en-US', gender: 'female', blurb: 'bright', grade: 'A-', gradeRank: 12 },
  { id: 'af_nephis', name: 'Nephis', language: 'en-US', gender: 'female', blurb: 'Nephis’s voice, read fast by Kokoro.', grade: 'B', gradeRank: 10 },
  { id: 'bf_emma', name: 'Emma', language: 'en-GB', gender: 'female', blurb: 'calm', grade: 'B-', gradeRank: 9 },
  { id: 'am_michael', name: 'Michael', language: 'en-US', gender: 'male', blurb: 'steady', grade: 'C+', gradeRank: 8 },
];

describe('More › Voices › Backup Voice and the voice mixer (PC shell)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-mixer');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({
      wwwDir: www,
      core: {
        ui: {
          alert: (json, cb) => {
            alerts.push(JSON.parse(json) as { title: string; message: string });
            setImmediate(() => cb(null, 0));
          },
        },
      },
      initStorage: { 'tachinovel.tips.reader': '1' },
    });
    shell.pluginReplies.set('Narration.voiceSettings', () => ({
      voices,
      customVoices: prefs.customVoices.map((m) => ({ ...m })),
      defaultVoice: 'af_heart',
      backupVoice: prefs.backupVoice,
      kokoroEnabled: true,
      kokoro: { bundled: true, status: 'Ready', ready: true, crashDisabled: false, crashes: 0, revision: 'abc', bytes: 108_900_000 },
      apple: { name: 'Zoe (Premium)', quality: 'premium', onlyDefault: false },
      delivery: { listenEngine: 'pocket-tts', pocketVoice: 'nephis', pocketInstalled: true },
    }));
    // Like NarrationPlugin.setVoiceSettings: an unknown backup voice (or "") goes back to her matched voice.
    shell.pluginReplies.set('Narration.setVoiceSettings', (o) => {
      const b = (o as { backupVoice?: string }).backupVoice;
      if (typeof b === 'string') prefs.backupVoice = voices.some((v) => v.id === b) || prefs.customVoices.some((m) => m.id === b) ? b : null;
      return {};
    });
    shell.pluginReplies.set('Narration.saveCustomVoice', (o) => {
      const a = o as Partial<Mix>;
      const fields = { name: a.name ?? '', a: a.a ?? '', b: a.b ?? '', percent: a.percent ?? 50 };
      const old = prefs.customVoices.find((m) => m.id === a.id);
      const mix = old ? Object.assign(old, fields) : { id: `mix_${String(prefs.customVoices.length + 1).padStart(8, '0')}`, ...fields };
      if (!old) prefs.customVoices.push(mix);
      return { mix: { ...mix } };
    });
    // Like VoicePreferences.deleteCustomVoice: the backup voice goes back to her matched voice.
    shell.pluginReplies.set('Narration.deleteCustomVoice', (o) => {
      const id = (o as { id: string }).id;
      prefs.customVoices = prefs.customVoices.filter((m) => m.id !== id);
      if (prefs.backupVoice === id) prefs.backupVoice = null;
      return {};
    });
    shell.pluginReplies.set('Narration.sampleVoice', () => ({ ms: 120, source: 'kokoro' }));
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = shell.page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
  });

  afterAll(async () => {
    await shell?.close();
  });

  const live = (id: string) => shell.page.locator(`[data-testid="${id}"]:not([inert])`);
  const calls = (method: string) => shell.pluginCalls.filter((c) => c.methodName === method).map((c) => c.options);
  /** The ids of a list's rows, the checked one marked "✓". */
  const ids = (el: ReturnType<typeof live>) =>
    el.locator('.row[data-voice]').evaluateAll((rows) => rows.map((r) => `${(r as HTMLElement).dataset.voice ?? ''}${r.querySelector('.check.on') ? ' ✓' : ''}`));
  const settled = async (el: ReturnType<typeof live>) => {
    await el.waitFor({ timeout: 5000 });
    await expect.poll(() => el.evaluate((n) => Math.round(n.getBoundingClientRect().left)), { timeout: 3000 }).toBe(0);
  };
  const back = async (id: string) => {
    await live(id).locator('[data-act="close"]').click();
    await expect.poll(() => live(id).count(), { timeout: 3000 }).toBe(0);
  };

  it('Backup Voice: her matched voice until another is picked; the three best first, ▶ samples, a pick is saved', async () => {
    await shell.page.getByTestId('tab-more').click();
    await shell.page.getByTestId('more-voices').click();
    const row = live('screen-voices').getByTestId('voices-backup-voice');
    await expect.poll(() => row.textContent(), { timeout: 5000 }).toBe('NephisKokoro');
    await row.click();
    const backup = live('backup-voice');
    await settled(backup);
    await expect.poll(() => ids(backup.getByTestId('backup-best'))).toEqual(['af_nephis ✓', 'af_heart', 'af_bella']);
    await shell.page.screenshot({ path: path.join(shots, 'backup-voice.png') });

    await backup.locator('.row[data-voice="af_heart"] [data-act="sample"]').click();
    await expect.poll(() => calls('sampleVoice').at(-1)).toMatchObject({ voice: 'af_heart' });
    await backup.locator('.row[data-voice="af_bella"] [data-act="pick"]').click();
    await expect.poll(() => prefs.backupVoice).toBe('af_bella');
    await expect.poll(() => ids(backup.getByTestId('backup-best'))).toEqual(['af_nephis', 'af_heart', 'af_bella ✓']);
    await back('backup-voice');
    await expect.poll(() => row.textContent(), { timeout: 5000 }).toBe('BellaKokoro');
  });

  it('All Voices: every voice by accent and gender; Mix a Voice and Edit only with Developer options', async () => {
    await live('screen-voices').getByTestId('voices-backup-voice').click();
    await live('backup-voice').getByTestId('backup-all').click();
    const all = live('kokoro-voices');
    await settled(all);
    expect(await all.locator('.sec').allTextContents()).toEqual(['American women', 'American men', 'British women']);
    await expect.poll(() => ids(all)).toEqual(['af_heart', 'af_bella ✓', 'af_nephis', 'am_michael', 'bf_emma']);
    expect(await all.locator('[data-act="mix-new"], [data-act="mix-edit"]').count()).toBe(0);
    await all.locator('.row[data-voice="bf_emma"] [data-act="pick"]').click();
    await expect.poll(() => prefs.backupVoice).toBe('bf_emma');
    await shell.page.screenshot({ path: path.join(shots, 'all-voices.png') });
    await back('kokoro-voices');
    // The list behind it shows the pick too (it isn't among the three best: it is added under them).
    await expect.poll(() => ids(live('backup-voice').getByTestId('backup-best'))).toEqual(['af_nephis', 'af_heart', 'af_bella', 'bf_emma ✓']);
    await back('backup-voice');
    await back('screen-voices');
  });

  it('More › Developer › Mix a Voice: real slider drag updates in place, ▶ plays the blend, Save stores it', async () => {
    await setDeveloperOptions(shell);
    await openDeveloper(shell);
    await live('screen-developer').getByTestId('dev-mix').click();
    const m = live('voice-mixer');
    await settled(m);
    // Starts from the backup voice and the best voice of another accent or gender.
    expect(await m.locator('select[data-act="mix-a"]').inputValue()).toBe('bf_emma');
    expect(await m.locator('select[data-act="mix-b"]').inputValue()).toBe('af_heart');
    await m.locator('select[data-act="mix-a"]').selectOption('af_heart');
    await m.locator('select[data-act="mix-b"]').selectOption('am_michael');
    expect(await m.locator('[data-shares]').textContent()).toBe('Heart 50 % · Michael 50 %');

    // Drag the blend toward the first voice with the mouse, through WebKit's range control.
    const range = m.locator('input[data-act="mix-blend"]');
    await range.evaluate((el) => ((window as unknown as { __range: Element }).__range = el));
    const box = await range.boundingBox();
    if (!box) throw new Error('no slider');
    const x = (f: number) => box.x + 8 + (box.width - 16) * f;
    await shell.page.mouse.move(x(0.5), box.y + box.height / 2);
    await shell.page.mouse.down();
    for (let i = 1; i <= 5; i++) await shell.page.mouse.move(x(0.5 - (0.3 * i) / 5), box.y + box.height / 2, { steps: 2 });
    const during = await m.locator('[data-shares]').textContent();
    await shell.page.mouse.up();
    expect(during, 'the shares follow the finger').not.toBe('Heart 50 % · Michael 50 %');
    expect(await range.evaluate((el) => el === (window as unknown as { __range: Element }).__range), 'never rebuilt under the finger').toBe(true);
    const percent = Number(await range.inputValue());
    expect(percent).toBeGreaterThan(10);
    expect(percent).toBeLessThan(30);
    expect(await m.locator('[data-shares]').textContent()).toBe(`Heart ${String(100 - percent)} % · Michael ${String(percent)} %`);
    expect(await m.locator('input[data-act="mix-name"]').getAttribute('placeholder')).toBe(`Heart + Michael (${String(percent)} %)`);
    await shell.page.screenshot({ path: path.join(shots, 'voice-mixer.png') });

    await m.locator('[data-act="mix-play"]').click();
    await expect.poll(() => calls('sampleVoice').at(-1)).toMatchObject({ voice: `af_heart+am_michael@${String(percent)}` });

    await m.locator('input[data-act="mix-name"]').fill('  Warm narrator ');
    await m.locator('[data-act="mix-save"]').click();
    await expect.poll(() => calls('saveCustomVoice').at(-1)).toEqual({ name: 'Warm narrator', a: 'af_heart', b: 'am_michael', percent });
    await expect.poll(() => live('voice-mixer').count(), { timeout: 3000 }).toBe(0);
    await back('screen-developer');
  });

  it('a mix can be the backup voice; Edit keeps its id; the same voice twice can’t be saved; Delete asks first', async () => {
    await shell.page.getByTestId('more-voices').click();
    await live('screen-voices').getByTestId('voices-backup-voice').click();
    await live('backup-voice').getByTestId('backup-all').click();
    const all = live('kokoro-voices');
    await settled(all);
    // Developer options on: Edit on each mix and Mix a Voice.
    const row = all.locator('[data-testid="voice-mixes"] .row[data-voice="mix_00000001"]');
    await row.waitFor({ timeout: 5000 });
    expect(await row.textContent()).toContain('Warm narrator');
    expect(await all.locator('[data-act="mix-new"]').count()).toBe(1);
    await row.locator('[data-act="pick"]').click();
    await expect.poll(() => prefs.backupVoice).toBe('mix_00000001');
    await expect.poll(() => ids(all.getByTestId('voice-mixes'))).toEqual(['mix_00000001 ✓']);

    await row.locator('[data-act="mix-edit"]').click();
    const m = live('voice-mixer');
    await settled(m);
    expect(await m.locator('input[data-act="mix-name"]').inputValue()).toBe('Warm narrator');
    await m.locator('select[data-act="mix-b"]').selectOption('af_heart');
    expect(await m.locator('[data-problem]').textContent()).toMatch(/different voices/);
    expect(await m.locator('[data-act="mix-save"]').isDisabled()).toBe(true);
    await m.locator('select[data-act="mix-b"]').selectOption('bf_emma');
    expect(await m.locator('[data-problem]').isHidden()).toBe(true);
    await m.locator('input[data-act="mix-blend"]').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '70';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await m.locator('[data-act="mix-save"]').click();
    await expect.poll(() => calls('saveCustomVoice').at(-1)).toEqual({ id: 'mix_00000001', name: 'Warm narrator', a: 'af_heart', b: 'bf_emma', percent: 70 });
    await expect.poll(() => row.textContent(), { timeout: 5000 }).toContain('Heart 30 % · Emma 70 %');
    expect(prefs.customVoices).toHaveLength(1);

    // Delete: the native alert asks; then the backup voice is her matched voice again.
    await row.locator('[data-act="mix-edit"]').click();
    await settled(live('voice-mixer'));
    await live('voice-mixer').locator('[data-act="mix-delete"]').click();
    await expect.poll(() => calls('deleteCustomVoice').at(-1)).toEqual({ id: 'mix_00000001' });
    expect(alerts.at(-1)?.title).toBe('Delete “Warm narrator”?');
    await expect.poll(() => all.locator('.row[data-voice="mix_00000001"]').count(), { timeout: 5000 }).toBe(0);
    expect(prefs.backupVoice).toBeNull();
    await expect.poll(() => ids(all)).toContain('af_nephis ✓');
    expect(shell.pageErrors).toEqual([]);
  });
});
