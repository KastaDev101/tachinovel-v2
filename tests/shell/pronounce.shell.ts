/**
 * "Pronounce" in the reader (src/ui/native/pronounce-ui.ts), in the PC shell: select a name in a chapter → v1's
 * quote bar gets "Pronounce" (and still fits) → the panel: type a stress respelling, the hint, ▶ (the real
 * narration pipeline: Kokoro phonemes for the stressed respelling), Save for this novel → the novel's list in the
 * core; Listen reads the respelling while the page still shows the word; then "All novels" moves it to the global list.
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
const NOVEL_KEY = 'demo-library:novel/alpha';

let shell: PcShell;
const top = () => shell.page.locator('.nav-root > .layer').last();
const waitStack = (n: number) =>
  shell.page.waitForFunction((d) => document.querySelectorAll('.nav-root > .layer').length === d && !document.querySelector('.nav-root.is-animating'), n);
const calls = (plugin: string, method: string): Record<string, unknown>[] =>
  shell.pluginCalls.filter((c) => c.pluginId === plugin && c.methodName === method).map((c) => c.options);
type Lex = { schemaVersion: 1; entries: { match: string; say?: string }[] };
const lexicons = (): Promise<{ global: Lex; novel: Lex | null }> => shell.core.call('narration.lexicon.get', { novelKey: NOVEL_KEY });

/** Select `word` in the reader's chapter text, the way a long-press does. */
async function select(word: string): Promise<void> {
  const ok = await shell.page.evaluate((w) => {
    const body = document.querySelector('[data-testid="screen-reader"] [data-testid="reader-body"]');
    if (!body) return false;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.textContent?.indexOf(w) ?? -1;
      if (at < 0) continue;
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + w.length);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      return true;
    }
    return false;
  }, word);
  expect(ok).toBe(true);
}

describe('Pronounce a name from the reader (PC shell)', () => {
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-pronounce');
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
      defaultVoice: 'af_heart',
      effectiveVoice: 'af_heart',
      kokoroEnabled: true,
      voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', blurb: 'warm' }],
      kokoro: { bundled: true, status: 'ready', ready: true, crashDisabled: false, crashes: 0, revision: null, bytes: null },
      apple: { name: 'Samantha', quality: 'default', onlyDefault: false },
    }));
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

  it('offers Pronounce for a selected name, next to the quote buttons, and the bar still fits', async () => {
    await select('Smith?');
    const btn = top().getByTestId('reader-quote-pronounce');
    await btn.waitFor({ state: 'visible', timeout: 5000 });
    expect(await btn.getAttribute('aria-label')).toBe('Set pronunciation for Smith');
    const fits = await shell.page.evaluate(() => {
      const bar = document.querySelector('[data-testid="reader-quote-bar"]');
      const r = bar?.getBoundingClientRect();
      const tops = [...(bar?.querySelectorAll('.rd-quote-btn') ?? [])].map((b) => Math.round(b.getBoundingClientRect().top));
      return !!r && r.left >= 0 && r.right <= innerWidth && tops.length === 3 && new Set(tops).size === 1;
    });
    expect(fits).toBe(true);
    // A whole sentence isn't a name: no Pronounce.
    await select('Well. The door - old and grey - creaked.');
    await expect.poll(() => btn.isHidden(), { timeout: 3000 }).toBe(true);
  });

  it('saves a stress respelling for this novel; ▶ and Listen read it, the page keeps the word', async () => {
    await select('Smith?');
    const btn = top().getByTestId('reader-quote-pronounce');
    await btn.waitFor({ state: 'visible', timeout: 5000 });
    await btn.click();
    const sheet = shell.page.getByTestId('pronounce-sheet');
    await sheet.waitFor({ timeout: 5000 });
    expect(await sheet.locator('.sec').first().textContent()).toBe('How to say “Smith”');
    await sheet.getByTestId('pronounce-say').fill('SMEETH');
    await expect.poll(() => sheet.locator('[data-hint]').textContent()).toBe('Read as “Smeeth”, stress on SMEETH.');

    await sheet.getByTestId('pronounce-hear').click();
    await expect.poll(() => calls('Narration', 'sampleVoice').length, { timeout: 5000 }).toBe(1);
    const sample = calls('Narration', 'sampleVoice')[0] as { voice: string; text: string; runs?: { p?: string }[] };
    expect(sample.voice).toBe('af_heart');
    expect(sample.text).toBe('Smeeth. I said, Smeeth.');
    expect(sample.runs?.filter((r) => r.p).map((r) => r.p)).toEqual(['smˈiθ', 'smˈiθ']);

    await sheet.getByTestId('pronounce-save').click();
    await expect.poll(async () => (await lexicons()).novel?.entries, { timeout: 5000 }).toEqual([{ match: 'Smith', say: 'SMEETH' }]);
    expect((await lexicons()).global.entries).toEqual([]);
    await expect.poll(() => shell.page.getByTestId('pronounce-sheet').count(), { timeout: 3000 }).toBe(0);

    const before = calls('Narration', 'play').length;
    await top().getByTestId('reader-listen').click();
    await expect.poll(() => calls('Narration', 'play').length, { timeout: 5000 }).toBe(before + 1);
    const items = (calls('Narration', 'play').at(-1) as { script: { items: { text: string; runs?: { p?: string }[] }[] } }).script.items;
    const said = items.find((i) => i.text.includes('Smeeth'));
    expect(said?.text).toContain('Mister Smeeth?');
    expect(said?.runs?.some((r) => r.p === 'smˈiθ')).toBe(true);
    expect(items.some((i) => /Smith/u.test(i.text))).toBe(false);
    expect(await top().getByTestId('reader-body').first().textContent()).toContain('Mr. Smith?');
    await shell.page.evaluate(() => window.getSelection()?.removeAllRanges());
  });

  it('shows the saved respelling again, and "All novels" moves it to the global list', async () => {
    await select('Smith?');
    const btn = top().getByTestId('reader-quote-pronounce');
    await btn.waitFor({ state: 'visible', timeout: 5000 });
    await btn.click();
    const sheet = shell.page.getByTestId('pronounce-sheet');
    await sheet.getByTestId('pronounce-remove').waitFor({ timeout: 5000 });
    // Slid all the way in.
    await expect.poll(() => sheet.evaluate((el) => Math.round(el.getBoundingClientRect().left)), { timeout: 3000 }).toBe(0);
    expect(await sheet.getByTestId('pronounce-say').inputValue()).toBe('SMEETH');
    expect(await sheet.getByTestId('pronounce-all').isChecked()).toBe(false);
    await sheet.getByTestId('pronounce-all').check();
    await sheet.getByTestId('pronounce-save').click();
    await expect.poll(async () => (await lexicons()).global.entries, { timeout: 5000 }).toEqual([{ match: 'Smith', say: 'SMEETH' }]);
    await expect.poll(async () => (await lexicons()).novel, { timeout: 5000 }).toBeNull();
    expect(shell.pageErrors).toEqual([]);
  });
});
