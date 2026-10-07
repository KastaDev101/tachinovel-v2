/**
 * The voice mixer (src/ui/native/voices-ui.ts openMixer) in the PC shell, against a Narration mock that
 * keeps mixes like native does (VoicePreferences.customVoices):
 *  - More › Voices › Mix a voice: two voices, the blend slider dragged for real (the screen updates in
 *    place, the slider is never rebuilt under the finger), ▶ plays the blend string, Save stores it;
 *  - the mix is listed under "Your mixes", can be the default voice, and is offered for one novel (Listen
 *    player › Voice, without Edit there);
 *  - Edit keeps the mix's id; the same voice twice can't be saved; Delete needs a second tap and sends
 *    the default back to Heart;
 *  - Narrator mode: its switches and dialogue voice are saved, and ▶ Without / ▶ With play the test passage
 *    with narrator mode off / on.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
let shell: PcShell;

interface Mix {
  id: string;
  name: string;
  a: string;
  b: string;
  percent: number;
}
const prefs = {
  defaultVoice: 'af_heart',
  novelVoices: {} as Record<string, string>,
  customVoices: [] as Mix[],
  narrator: {
    enabled: false,
    dialogueVoice: null as string | null,
    secondDialogueVoice: null as string | null,
    pacing: true,
    jitter: false,
    polish: true,
    roomTone: false,
    phraseBreaks: 'clauses' as 'off' | 'clauses',
    pacingStyle: 'relaxed' as 'relaxed' | 'natural',
  },
};
const voices = [
  { id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', blurb: 'warm', grade: 'A', gradeRank: 13 },
  { id: 'af_bella', name: 'Bella', language: 'en-US', gender: 'female', blurb: 'bright', grade: 'A-', gradeRank: 12 },
  { id: 'bf_emma', name: 'Emma', language: 'en-GB', gender: 'female', blurb: 'calm', grade: 'B-', gradeRank: 9 },
  { id: 'am_michael', name: 'Michael', language: 'en-US', gender: 'male', blurb: 'steady', grade: 'C+', gradeRank: 8 },
];
const novel = { pluginId: 'demo-library', novelPath: 'novel/alpha' };

describe('voice mixer (PC shell)', () => {
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-mixer');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({ wwwDir: www, core: {}, initStorage: { 'tachinovel.tips.reader': '1' } });
    shell.pluginReplies.set('Narration.voiceSettings', (o) => {
      const opts = o as { pluginId?: string; novelPath?: string };
      const key = opts.pluginId && opts.novelPath ? `${opts.pluginId}:${opts.novelPath}` : null;
      return {
        voices,
        customVoices: prefs.customVoices.map((m) => ({ ...m })),
        narrator: { ...prefs.narrator },
        defaultVoice: prefs.defaultVoice,
        kokoroEnabled: true,
        usePCAudio: false,
        kokoro: { bundled: true, status: 'Ready', ready: true, crashDisabled: false, crashes: 0, revision: 'abc', bytes: 108_900_000 },
        apple: { name: 'Zoe (Premium)', quality: 'premium', onlyDefault: false },
        ...(key ? { novelVoice: prefs.novelVoices[key] ?? null, effectiveVoice: prefs.novelVoices[key] ?? prefs.defaultVoice } : {}),
      };
    });
    shell.pluginReplies.set('Narration.setVoiceSettings', (o) => {
      const a = o as { defaultVoice?: string; novel?: { pluginId: string; novelPath: string; voice: string | null }; narrator?: Partial<typeof prefs.narrator> };
      if (a.defaultVoice) prefs.defaultVoice = a.defaultVoice;
      if (a.narrator) Object.assign(prefs.narrator, a.narrator);
      if (a.novel) {
        const key = `${a.novel.pluginId}:${a.novel.novelPath}`;
        if (a.novel.voice && a.novel.voice !== prefs.defaultVoice) prefs.novelVoices[key] = a.novel.voice;
        else delete prefs.novelVoices[key];
      }
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
    shell.pluginReplies.set('Narration.deleteCustomVoice', (o) => {
      const id = (o as { id: string }).id;
      prefs.customVoices = prefs.customVoices.filter((m) => m.id !== id);
      if (prefs.defaultVoice === id) prefs.defaultVoice = 'af_heart';
      for (const [k, v] of Object.entries(prefs.novelVoices)) if (v === id) delete prefs.novelVoices[k];
      return {};
    });
    shell.pluginReplies.set('Narration.sampleVoice', () => ({ ms: 120, source: 'kokoro' }));
    shell.pluginReplies.set('Narration.play', () => ({}));
    await shell.page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    await shell.page.getByTestId('onboarding-skip').click();
    await shell.page.getByTestId('tab-more').click();
    await shell.page.getByTestId('more-voices').click();
    await shell.page.getByTestId('screen-voices').locator('[data-act="mix-new"]').waitFor({ timeout: 5000 });
  });

  afterAll(async () => {
    await shell?.close();
  });

  const screen = () => shell.page.locator('[data-testid="screen-voices"]:not([inert])');
  const mixer = () => shell.page.locator('[data-testid="voice-mixer"]:not([inert])');
  const calls = (method: string) => shell.pluginCalls.filter((c) => c.methodName === method).map((c) => c.options);
  const settled = async (el: ReturnType<typeof mixer>) => {
    await el.waitFor({ timeout: 5000 });
    await expect.poll(() => el.evaluate((n) => Math.round(n.getBoundingClientRect().left)), { timeout: 3000 }).toBe(0);
  };

  it('mixes two voices: real slider drag updates in place, ▶ plays the blend, Save stores it under "Your mixes"', async () => {
    await screen().locator('[data-act="mix-new"]').click();
    const m = mixer();
    await settled(m);
    // Starts from the default voice and the best voice of another accent or gender.
    expect(await m.locator('select[data-act="mix-a"]').inputValue()).toBe('af_heart');
    expect(await m.locator('select[data-act="mix-b"]').inputValue()).toBe('bf_emma');
    expect(await m.locator('[data-shares]').textContent()).toBe('Heart 50 % · Emma 50 %');
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

    await m.locator('[data-act="mix-play"]').click();
    await expect.poll(() => calls('sampleVoice').at(-1)).toMatchObject({ voice: `af_heart+am_michael@${String(percent)}` });

    await m.locator('input[data-act="mix-name"]').fill('  Warm narrator ');
    await m.locator('[data-act="mix-save"]').click();
    await expect.poll(() => calls('saveCustomVoice').at(-1)).toEqual({ name: 'Warm narrator', a: 'af_heart', b: 'am_michael', percent });
    await expect.poll(() => shell.page.getByTestId('voice-mixer').count(), { timeout: 3000 }).toBe(0);
    const row = screen().locator('[data-testid="voice-mixes"] .row[data-voice="mix_00000001"]');
    await row.waitFor({ timeout: 5000 });
    expect(await row.textContent()).toContain('Warm narrator');
    expect(await row.textContent()).toContain(`Heart ${String(100 - percent)} % · Michael ${String(percent)} %`);
  });

  it('a mix can be the default voice, and is offered for one novel (without Edit)', async () => {
    const row = screen().locator('.row[data-voice="mix_00000001"]');
    await row.locator('[data-act="pick"]').click();
    await expect.poll(() => prefs.defaultVoice).toBe('mix_00000001');
    await expect.poll(() => row.locator('.check').textContent()).toBe('✓');
    await row.locator('[data-act="sample"]').click();
    await expect.poll(() => calls('sampleVoice').at(-1)).toMatchObject({ voice: 'mix_00000001' });
    await screen().locator('[data-act="close"]').click();

    // Listen player › Voice for a novel being read aloud.
    shell.pluginReplies.set('Narration.state', () => ({
      status: 'playing',
      engine: 'speech',
      ...novel,
      chapterName: 'Chapter 1',
      position: 10,
      duration: 600,
      voice: { kokoroVoice: 'af_heart+am_michael@20', kokoroName: 'Warm narrator', source: 'kokoro' },
    }));
    await shell.page.getByTestId('more-listen').click();
    const player = shell.page.getByTestId('car-player');
    await player.locator('[data-act="voice"]').click();
    const picker = shell.page.locator('[data-testid="voice-picker"]:not([inert])');
    await picker.locator('.row[data-voice="mix_00000001"]').waitFor({ timeout: 5000 });
    expect(await picker.locator('[data-act="mix-edit"], [data-act="mix-new"]').count()).toBe(0);
    expect(await picker.textContent()).toContain('Using the default voice (Warm narrator)');
    await picker.locator('.row[data-voice="bf_emma"] [data-act="pick"]').click();
    await expect.poll(() => prefs.novelVoices[`${novel.pluginId}:${novel.novelPath}`]).toBe('bf_emma');
    await picker.locator('[data-act="close"]').click();
    await player.locator('[data-act="close"]').click();
    shell.pluginReplies.delete('Narration.state');
  });

  it('Edit keeps the id; the same voice twice cannot be saved; Delete needs a second tap', async () => {
    await shell.page.getByTestId('more-voices').click();
    const row = screen().locator('.row[data-voice="mix_00000001"]');
    await row.locator('[data-act="mix-edit"]').click();
    const m = mixer();
    await settled(m);
    expect(await m.locator('input[data-act="mix-name"]').inputValue()).toBe('Warm narrator');
    expect(await m.locator('select[data-act="mix-b"]').inputValue()).toBe('am_michael');

    await m.locator('select[data-act="mix-b"]').selectOption('af_heart');
    expect(await m.locator('[data-problem]').textContent()).toMatch(/different voices/);
    expect(await m.locator('[data-act="mix-save"]').isDisabled()).toBe(true);
    expect(await m.locator('[data-act="mix-play"]').isDisabled()).toBe(true);
    await m.locator('select[data-act="mix-b"]').selectOption('bf_emma');
    expect(await m.locator('[data-problem]').isHidden()).toBe(true);
    await m.locator('input[data-act="mix-blend"]').evaluate((el) => {
      const input = el as HTMLInputElement;
      input.value = '70';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await m.locator('[data-act="mix-save"]').click();
    await expect.poll(() => calls('saveCustomVoice').at(-1)).toEqual({ id: 'mix_00000001', name: 'Warm narrator', a: 'af_heart', b: 'bf_emma', percent: 70 });
    await expect.poll(() => row.textContent(), { timeout: 5000 }).toContain('Heart 30 % · Emma 70 %');
    expect(prefs.customVoices).toHaveLength(1);

    await row.locator('[data-act="mix-edit"]').click();
    await settled(mixer());
    const del = mixer().locator('[data-act="mix-delete"]');
    await del.click();
    expect(await del.textContent()).toBe('Tap again to delete');
    expect(calls('deleteCustomVoice')).toHaveLength(0);
    await del.click();
    await expect.poll(() => calls('deleteCustomVoice').at(-1)).toEqual({ id: 'mix_00000001' });
    await expect.poll(() => screen().locator('.row[data-voice="mix_00000001"]').count(), { timeout: 5000 }).toBe(0);
    expect(prefs.defaultVoice).toBe('af_heart');
    await expect.poll(() => screen().locator('.row[data-voice="af_heart"] .check').textContent()).toBe('✓');
  });

  it('narrator mode: switches and the dialogue voice are saved; ▶ Without / ▶ With compare on the test passage', async () => {
    const card = screen().locator('[data-testid="voices-narrator"]');
    await card.waitFor({ timeout: 5000 });
    expect(await card.locator('select').count(), 'pieces hidden while off').toBe(0);
    await card.locator('input[data-k="enabled"]').click();
    await expect.poll(() => prefs.narrator.enabled).toBe(true);
    await card.locator('input[data-k="pacing"]').waitFor({ timeout: 5000 });
    // One narrator voice by default: the dialogue voices sit, closed, under Advanced.
    expect(await card.locator('[data-testid="narrator-advanced"]').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    expect(prefs.narrator.dialogueVoice).toBeNull();
    await card.locator('[data-testid="narrator-advanced"] summary').click();
    await card.locator('select[data-k="dialogueVoice"]').waitFor({ timeout: 5000 });
    expect(await card.locator('select[data-k="secondDialogueVoice"]').isDisabled(), 'no second speaker without a dialogue voice').toBe(true);
    await card.locator('select[data-k="dialogueVoice"]').selectOption('am_michael');
    await expect.poll(() => prefs.narrator.dialogueVoice).toBe('am_michael');
    await expect.poll(() => card.locator('select[data-k="secondDialogueVoice"]').isDisabled()).toBe(false);
    expect(await card.locator('input[data-act="narrator-phrases"]').isChecked(), 'phrase breaks on by default').toBe(true);
    await card.locator('input[data-act="narrator-phrases"]').click();
    await expect.poll(() => prefs.narrator.phraseBreaks).toBe('off');
    expect(await card.locator('input[data-k="jitter"]').isChecked(), 'no jitter by default').toBe(false);
    expect(await card.locator('select[data-act="narrator-pacing-style"]').inputValue(), 'relaxed pacing by default').toBe('relaxed');
    await card.locator('select[data-act="narrator-pacing-style"]').selectOption('natural');
    await expect.poll(() => prefs.narrator.pacingStyle).toBe('natural');
    await card.locator('input[data-k="jitter"]').click();
    await expect.poll(() => prefs.narrator.jitter).toBe(true);
    await card.locator('input[data-k="polish"]').click();
    await expect.poll(() => prefs.narrator.polish).toBe(false);
    await expect.poll(() => card.locator('input[data-k="roomTone"]').isDisabled(), { message: 'room tone needs studio sound' }).toBe(true);
    await card.locator('[data-act="narrator-ab"][data-v="off"]').click();
    await expect.poll(() => calls('play').at(-1)).toMatchObject({ narrator: 'off', pluginId: 'voice-lab', engine: 'speech' });
    await card.locator('[data-act="narrator-ab"][data-v="on"]').click();
    await expect.poll(() => calls('play').at(-1)).toMatchObject({ narrator: 'on' });
    // Back to "Narrator's voice".
    await card.locator('select[data-k="dialogueVoice"]').selectOption('');
    await expect.poll(() => prefs.narrator.dialogueVoice).toBeNull();
  });
});
