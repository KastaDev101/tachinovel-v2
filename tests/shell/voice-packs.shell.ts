/**
 * Settings › Voices › Voice packs (src/ui/native/voice-packs.ts) in the PC shell, personal flavor, against a canned
 * ExpressiveVoice plugin that keeps a pack list like NephisPackLibrary does:
 *  - the Voices row says which pack she reads with, how many and how much space;
 *  - the page lists each pack (name, made, studio, size), ✓ on hers, and the total used;
 *  - tapping a pack switches her to it (selectNephisPack);
 *  - Edit › Delete asks on the row (no browser dialog); deleting hers says which pack takes over, and the last one
 *    leaves the empty state;
 *  - every control has a name for VoiceOver.
 * Screenshots: .cache/shell-shots/voice-packs.png, voice-packs-delete.png
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../../tools/build.ts';
import { type PcShell, startPcShell } from '../helpers/pc-shell.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const shots = path.join(root, '.cache', 'shell-shots');
let shell: PcShell;

type Pack = { id: string; name: string; made: string; studio: boolean; bytes: number };
let packs: Pack[] = [];
let active: string | null = null;

const answer = (): Record<string, unknown> => ({
  packs: packs.map((p) => ({ ...p, active: p.id === active })),
  active,
  totalBytes: packs.reduce((a, p) => a + p.bytes, 0),
});

const calls = (method: string): Record<string, unknown>[] =>
  shell.pluginCalls.filter((c) => c.pluginId === 'ExpressiveVoice' && c.methodName === method).map((c) => c.options);

describe('Settings › Voices › Voice packs (PC shell)', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const www = path.join(root, '.cache', 'shell-www-voice-packs');
    await buildAll({ flavor: 'personal', ads: false, dev: false, outDir: www });
    shell = await startPcShell({ wwwDir: www, core: { routes: {}, answers: [] }, initStorage: { 'tachinovel.tips.reader': '1' } });
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
    shell.pluginReplies.set('ExpressiveVoice.selectNephisPack', (o) => {
      active = String(o.id);
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
    await page.getByTestId('tab-more').click();
    await page.getByTestId('more-voices').click();
    const voices = page.getByTestId('screen-voices');
    const entry = voices.getByTestId('voices-packs');
    await expect.poll(() => entry.textContent(), { timeout: 5000 }).toContain('nephis-r10 · 3 packs · 1.2 GB');
    await entry.click();

    const screen = page.getByTestId('voice-packs');
    const list = screen.getByTestId('voice-packs-list');
    await list.waitFor({ timeout: 5000 });
    const rows = (): Promise<string[]> => list.locator('[data-pack]').allTextContents().then((t) => t.map((s) => s.replace(/\s+/g, ' ').trim()));
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

    // Edit › Delete on another pack: asked on the row, Cancel leaves it.
    await screen.getByTestId('voice-packs-edit').click();
    expect(await screen.getByTestId('voice-packs-edit').textContent()).toBe('Done');
    await list.getByRole('button', { name: 'Delete nephis-r8' }).click();
    const confirm = screen.getByTestId('voice-packs-confirm');
    expect(await confirm.textContent()).toContain('Delete “nephis-r8”? Frees 372 MB.');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    expect(await screen.getByTestId('voice-packs-confirm').count()).toBe(0);
    expect(calls('deleteNephisPack')).toEqual([]);

    // Hers: the row says who takes over, and Delete does it.
    await list.getByRole('button', { name: 'Delete nephis-r9' }).click();
    expect(await confirm.textContent()).toContain('Nephis reads with this pack. Delete it (frees 380 MB) and switch her to “nephis-r10”?');
    await page.screenshot({ path: path.join(shots, 'voice-packs-delete.png') });
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => calls('deleteNephisPack')).toEqual([{ id: 'p000000000000000r9' }]);
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
      await screen.getByTestId('voice-packs-confirm').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect.poll(() => calls('deleteNephisPack').at(-1)).toEqual({ id });
    }
    await expect.poll(() => screen.getByTestId('voice-packs-empty').count()).toBe(1);
    expect(await screen.getByTestId('voice-packs-edit').isVisible()).toBe(false);
    expect(active).toBeNull();

    // Back in Settings › Voices, the row says so.
    await screen.getByRole('button', { name: 'Back' }).click();
    await expect.poll(() => entry.textContent(), { timeout: 5000 }).toContain('None yet: open a .tnmodel file to add one');
    expect(shell.pageErrors).toEqual([]);
  });
});
