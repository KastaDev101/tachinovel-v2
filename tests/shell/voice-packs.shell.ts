/**
 * More › Developer › Voice Packs (src/ui/native/voice-packs.ts) in the PC shell, personal flavor, against a canned
 * ExpressiveVoice plugin that keeps a pack list like NephisPackLibrary does:
 *  - the Voices row says which pack she reads with, how many and how much space;
 *  - the page lists each pack (name, made, studio, size), a checkmark on hers (✓ below), and the total used;
 *  - tapping a pack switches her to it (selectNephisPack);
 *  - Edit › Delete asks with the native alert (cleanup 2: the app's one confirmation); deleting hers says which pack
 *    takes over, and the last one leaves the empty state;
 *  - every control has a name for VoiceOver;
 *  - with a dialogue pack (2026-10-15): a Narrator and a Dialogue section, ✓ on each one in use, "Narrator Reads Dialogue
 *    Too" (selectNephisDialogue null), and Edit's "For Dialogue" / "For Narration" (setNephisPackRole).
 * Screenshots: .cache/shell-shots/voice-packs.png, voice-packs-delete.png, voice-packs-dialogue.png
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Locator } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { openDeveloper, type PcShell, setDeveloperOptions, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'shell-shots');
let shell: PcShell;
/** Native alerts the page asked for, and the answers (0 = the action, 1 = Cancel). */
const alerts: { title: string; message: string }[] = [];
const alertAnswers: number[] = [];

/** A row's text, with " ✓" when its checkmark shows (the pack in use). */
const rowTexts = (rows: Locator): Promise<string[]> =>
  rows.evaluateAll((els) => els.map((e) => `${(e.textContent ?? '').replace(/\s+/g, ' ').trim()}${e.querySelector('.check.on') ? ' ✓' : ''}`));

type Pack = { id: string; name: string; made: string; studio: boolean; bytes: number; role?: 'narrator' | 'dialogue' };
let packs: Pack[] = [];
let active: string | null = null;
let dialogue: string | null = null;

const answer = (): Record<string, unknown> => ({
  packs: packs.map((p) => ({ ...p, role: p.role ?? 'narrator', active: p.id === active, dialogue: p.id === dialogue })),
  active,
  dialogue,
  totalBytes: packs.reduce((a, p) => a + p.bytes, 0),
});

const calls = (method: string): Record<string, unknown>[] =>
  shell.pluginCalls.filter((c) => c.pluginId === 'ExpressiveVoice' && c.methodName === method).map((c) => c.options);

describe('More › Developer › Voice Packs (PC shell)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-voice-packs');
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
      initStorage: { 'tachinovel.tips.reader': '1' },
    });
    packs = [
      { id: 'p00000000000000r10', name: 'nephis-r10', made: '2026-10-12', studio: true, bytes: 455_000_000 },
      { id: 'p000000000000000r9', name: 'nephis-r9', made: '2026-10-11', studio: false, bytes: 380_000_000 },
      { id: 'p000000000000000r8', name: 'nephis-r8', made: '2026-10-10', studio: false, bytes: 372_000_000 },
    ];
    active = 'p00000000000000r10';
    shell.pluginReplies.set('Narration.voiceSettings', () => ({
      voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', blurb: 'Warm.' }],
      defaultVoice: 'af_heart',
      kokoroEnabled: true,
      usePCAudio: false,
      kokoro: { bundled: true, status: 'ready', ready: true, crashDisabled: false, crashes: 0, revision: 'abc', bytes: 97_400_000 },
      apple: { name: 'Samantha', quality: 'default', onlyDefault: true },
      delivery: { listenEngine: 'pocket-tts', pocketVoice: 'nephis' },
    }));
    shell.pluginReplies.set('ExpressiveVoice.nephisPacks', answer);
    // Like NephisPackLibrary.activate: a dialogue pack becomes her dialogue voice.
    shell.pluginReplies.set('ExpressiveVoice.selectNephisPack', (o) => {
      if (packs.find((p) => p.id === o.id)?.role === 'dialogue') dialogue = String(o.id);
      else active = String(o.id);
      return answer();
    });
    shell.pluginReplies.set('ExpressiveVoice.selectNephisDialogue', (o) => {
      dialogue = typeof o.id === 'string' ? o.id : null;
      return answer();
    });
    // Like NephisPackLibrary.setRole.
    shell.pluginReplies.set('ExpressiveVoice.setNephisPackRole', (o) => {
      const p = packs.find((q) => q.id === o.id);
      if (p) p.role = o.role === 'dialogue' ? 'dialogue' : 'narrator';
      if (p?.role === 'dialogue' && active === p.id) active = packs.find((q) => q.role !== 'dialogue')?.id ?? null;
      if (p?.role === 'dialogue' && !dialogue) dialogue = p.id;
      if (p?.role === 'narrator' && dialogue === p.id) dialogue = packs.find((q) => q.role === 'dialogue')?.id ?? null;
      return answer();
    });
    // Like NephisPackLibrary.delete: hers falls back to the next one in the list, then to none.
    shell.pluginReplies.set('ExpressiveVoice.deleteNephisPack', (o) => {
      packs = packs.filter((p) => p.id !== o.id);
      if (active === o.id) active = packs[0]?.id ?? null;
      return answer();
    });
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('lists the packs, switches, and deletes with a confirm on the page', async () => {
    const page = shell.page;
    await page.getByTestId('screen-library').waitFor({ timeout: 20_000 });
    const skip = page.getByTestId('onboarding-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await setDeveloperOptions(shell);
    await openDeveloper(shell);
    const entry = page.getByTestId('screen-developer').getByTestId('dev-packs');
    await expect.poll(() => entry.textContent(), { timeout: 5000 }).toContain('nephis-r10 · 3 packs · 1.2 GB');
    await entry.click();

    const screen = page.getByTestId('voice-packs');
    const list = screen.getByTestId('voice-packs-list');
    await list.waitFor({ timeout: 5000 });
    const rows = (): Promise<string[]> => rowTexts(list.locator('[data-pack]'));
    expect(await rows()).toEqual([
      'nephis-r10Made Oct 12, 2026 · Studio · 455 MB ✓',
      'nephis-r9Made Oct 11, 2026 · No studio · 380 MB',
      'nephis-r8Made Oct 10, 2026 · No studio · 372 MB',
    ]);
    expect(await screen.getByTestId('voice-packs-total').textContent()).toContain('1.2 GB');
    await page.waitForTimeout(450); // slide-in
    await page.screenshot({ path: path.join(shots, 'voice-packs.png') });

    // Tap a pack: she reads with it.
    await list.getByRole('button', { name: /nephis-r9/ }).click();
    await expect.poll(() => calls('selectNephisPack')).toEqual([{ id: 'p000000000000000r9' }]);
    await expect.poll(rows).toEqual([
      'nephis-r10Made Oct 12, 2026 · Studio · 455 MB',
      'nephis-r9Made Oct 11, 2026 · No studio · 380 MB ✓',
      'nephis-r8Made Oct 10, 2026 · No studio · 372 MB',
    ]);

    // Edit › Delete on another pack: the native alert asks, Cancel leaves it.
    await screen.getByTestId('voice-packs-edit').click();
    expect(await screen.getByTestId('voice-packs-edit').textContent()).toBe('Done');
    await page.screenshot({ path: path.join(shots, 'voice-packs-delete.png') });
    alertAnswers.push(1);
    await list.getByRole('button', { name: 'Delete nephis-r8' }).click();
    await expect.poll(() => alerts.length).toBe(1);
    expect(alerts[0]).toMatchObject({ title: 'Delete Voice Pack?', message: 'Delete “nephis-r8”? Frees 372 MB.' });
    await page.waitForTimeout(200);
    expect(calls('deleteNephisPack')).toEqual([]);

    // Hers: the alert says who takes over, and Delete does it.
    await list.getByRole('button', { name: 'Delete nephis-r9' }).click();
    await expect.poll(() => calls('deleteNephisPack')).toEqual([{ id: 'p000000000000000r9' }]);
    expect(alerts[1]?.message).toBe('Nephis reads with this pack. Delete it (frees 380 MB) and switch her to “nephis-r10”?');
    await expect.poll(() => list.locator('[data-pack]').count()).toBe(2);
    expect(active).toBe('p00000000000000r10');

    // Every control has a name VoiceOver can read.
    const unnamed = await screen.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('button, input, [role="button"]')]
        .filter((c) => !c.hidden && !(c.getAttribute('aria-label') ?? c.textContent ?? '').trim())
        .map((c) => c.outerHTML.slice(0, 80)),
    );
    expect(unnamed).toEqual([]);

    // The last two: the page ends empty, and Edit goes away.
    for (const [name, id] of [['nephis-r10', 'p00000000000000r10'], ['nephis-r8', 'p000000000000000r8']] as const) {
      await list.getByRole('button', { name: `Delete ${name}` }).click();
      await expect.poll(() => calls('deleteNephisPack').at(-1)).toEqual({ id });
    }
    await expect.poll(() => screen.getByTestId('voice-packs-empty').count()).toBe(1);
    expect(await screen.getByTestId('voice-packs-edit').isVisible()).toBe(false);
    expect(active).toBeNull();

    // Back in More › Developer, the row says so.
    await screen.getByRole('button', { name: 'Back' }).click();
    await expect.poll(() => entry.textContent(), { timeout: 5000 }).toContain('None yet: open a .tnmodel file to add one');
    expect(shell.pageErrors).toEqual([]);
  });

  it('shows her narrator and dialogue packs apart, switches the dialogue voice and changes a role', async () => {
    const page = shell.page;
    packs = [
      { id: 'p0000000000000dlg', name: 'nephis-dialogue', made: '2026-10-15', studio: true, bytes: 400_000_000, role: 'dialogue' },
      { id: 'p0000000000000nar', name: 'nephis-narrator', made: '2026-10-15', studio: true, bytes: 450_000_000 },
    ];
    active = 'p0000000000000nar';
    dialogue = 'p0000000000000dlg';
    // The first test left More › Developer open: back out of it, then in again (its rows read the packs afresh).
    const developer = page.locator('[data-testid="screen-developer"]:not([inert])');
    if (await developer.count()) {
      await developer.getByRole('button', { name: 'Back' }).first().click();
      await expect.poll(() => page.locator('[data-testid="screen-developer"]:not([inert])').count()).toBe(0);
    }
    await openDeveloper(shell);
    const entry = page.getByTestId('screen-developer').getByTestId('dev-packs');
    await expect.poll(() => entry.textContent(), { timeout: 5000 }).toContain('nephis-narrator · Dialogue: nephis-dialogue · 2 packs · 850 MB');
    await entry.click();
    const screen = page.getByTestId('voice-packs');
    const narrators = screen.getByTestId('voice-packs-list');
    const dialogues = screen.getByTestId('voice-packs-dialogue');
    await dialogues.waitFor({ timeout: 5000 });
    const rows = (l: typeof narrators): Promise<string[]> => rowTexts(l.locator('.row'));
    expect(await rows(narrators)).toEqual(['nephis-narratorMade Oct 15, 2026 · Studio · 450 MB ✓']);
    expect(await rows(dialogues)).toEqual([
      'nephis-dialogueMade Oct 15, 2026 · 400 MB ✓',
      'Narrator Reads Dialogue TooNo dialogue pack: one voice for everything',
    ]);
    await page.waitForTimeout(450); // slide-in
    await page.screenshot({ path: path.join(shots, 'voice-packs-dialogue.png') });

    // One voice for everything: no dialogue pack in use.
    await dialogues.getByRole('button', { name: /Narrator Reads Dialogue Too/ }).click();
    await expect.poll(() => calls('selectNephisDialogue').at(-1)).toEqual({ id: null });
    await expect.poll(() => rows(dialogues)).toEqual([
      'nephis-dialogueMade Oct 15, 2026 · 400 MB',
      'Narrator Reads Dialogue TooNo dialogue pack: one voice for everything ✓',
    ]);
    // Tapping the dialogue pack makes it her dialogue voice again (never her narrator).
    await dialogues.getByRole('button', { name: /nephis-dialogue/ }).click();
    await expect.poll(() => dialogue).toBe('p0000000000000dlg');
    expect(active).toBe('p0000000000000nar');

    // Edit › For Narration: the pack moves to the Narrator section, and the page goes back to one list.
    await screen.getByTestId('voice-packs-edit').click();
    await dialogues.getByRole('button', { name: 'Use nephis-dialogue for Narration' }).click();
    await expect.poll(() => calls('setNephisPackRole').at(-1)).toEqual({ id: 'p0000000000000dlg', role: 'narrator' });
    await expect.poll(() => screen.getByTestId('voice-packs-dialogue').count()).toBe(0);
    await expect.poll(() => narrators.locator('[data-pack]').count()).toBe(2);
    const unnamed = await screen.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('button, input, [role="button"]')]
        .filter((c) => !c.hidden && !(c.getAttribute('aria-label') ?? c.textContent ?? '').trim())
        .map((c) => c.outerHTML.slice(0, 80)),
    );
    expect(unnamed).toEqual([]);
    await screen.getByRole('button', { name: 'Back' }).click();
    expect(shell.pageErrors).toEqual([]);
  });
});
