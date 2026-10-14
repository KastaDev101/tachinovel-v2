/**
 * Follow along in the PC shell (src/ui/native/narration-follow.ts + narration-overlay.ts), Kasta 2026-10-13: "if I'm
 * CarPlaying the listen on the way to work and my phone is off, when I open the app again it should jump to where the
 * current listen is, so I don't get confused where I'm at."
 *  - while the reader is on screen it keeps the spoken sentence in view, into the next chapter (continuous scroll);
 *  - a finger in the reader lets go of the narration; "Back to narration" brings it back;
 *  - back in the app after narration went on with the WebView asleep (lock screen, CarPlay), the reader jumps to the
 *    sentence being spoken, switching to the chapter narration went on to, marks it, and that becomes the reading
 *    progress (History);
 *  - nothing narrated while away (paused all along): the reader stays where it was;
 *  - a reader opened while listening goes to the spoken sentence.
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
const PARAGRAPHS = 50;
const TITLES = ['Nightmare Begins', 'The Hall', 'The Stairs', 'The Roof'];

/** A long chapter: its title line, then PARAGRAPHS paragraphs of a few lines each (body child i = paragraph i). */
function chapter(n: number): string {
  const ps = Array.from({ length: PARAGRAPHS }, (_, i) => {
    const k = i + 1;
    return `<p>Chapter ${n}, paragraph ${k} begins here. The corridor went on and on in the dark. She counted the doors as she walked past them, one after another.</p>`;
  });
  return `<html><body><div id="content"><p>Chapter ${n} - ${TITLES[n - 1]}</p>${ps.join('')}</div></body></html>`;
}

const novelPage = `<!doctype html><html><head><title>Alpha Story</title></head><body>
<h1 class="novel-title">Alpha Story</h1><div class="status">Publishing</div>
<ul class="chapters">${[4, 3, 2, 1].map((n) => `<li><a href="/novel/alpha/${n}">Chapter ${n} - ${TITLES[n - 1]}</a><time datetime="2026-10-0${n}">Oct ${n}</time></li>`).join('')}</ul>
</body></html>`;

const routes: Record<string, Route> = {
  [`${SITE}popular?page=1`]: { body: fx('popular.html') },
  [`${SITE}popular?page=2`]: { body: '<html><body></body></html>' },
  [`${SITE}novel/alpha`]: { body: novelPage },
  ...Object.fromEntries([1, 2, 3, 4].map((n) => [`${SITE}novel/alpha/${n}`, { body: chapter(n) }])),
};

const NOVEL = { pluginId: 'demo-library', novelPath: 'novel/alpha', novelName: 'Alpha Story' };
const path_ = (n: number): string => `novel/alpha/${n}`;

let shell: PcShell;
const top = () => shell.page.locator('.nav-root > .layer').last();
const waitStack = (n: number) =>
  shell.page.waitForFunction((d) => document.querySelectorAll('.nav-root > .layer').length === d && !document.querySelector('.nav-root.is-animating'), n);

/** Native's narration: the state it reports (events and Narration.state) and the sentence it speaks. */
function narrate(n: number, paragraph: number, opts: { status?: 'playing' | 'paused'; emit?: boolean } = {}): void {
  const state = { status: opts.status ?? 'playing', engine: 'speech', ...NOVEL, chapterPath: path_(n), chapterName: `Chapter ${n}`, paragraph, sentence: 0 };
  shell.pluginReplies.set('Narration.state', () => state);
  if (opts.emit === false) return;
  shell.emitPluginEvent('Narration', 'state', state);
  shell.emitPluginEvent('Narration', 'progress', { chapterPath: path_(n), engine: 'speech', paragraph, sentence: 0 });
}

/** Where paragraph `i` of chapter `n` is in the reader on top: its middle vs the screen, and whether it is marked. */
function paragraph(n: number, i: number): Promise<{ mid: number; vh: number; onScreen: boolean; marked: boolean } | null> {
  return shell.page.evaluate(
    ([p, k]) => {
      const layers = document.querySelectorAll('.nav-root > .layer');
      const reader = layers[layers.length - 1]?.querySelector('[data-testid="screen-reader"]');
      const sec = [...(reader?.querySelectorAll<HTMLElement>('.rd-chapter[data-path]') ?? [])].find((s) => s.dataset.path === p);
      const el = sec?.querySelector('.rd-body')?.children[k];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const mid = Math.round((r.top + r.bottom) / 2);
      return { mid, vh: innerHeight, onScreen: mid > 0 && mid < innerHeight, marked: el.classList.contains('tn-here') };
    },
    [path_(n), i] as const,
  );
}
const onScreen = async (n: number, i: number): Promise<boolean> => (await paragraph(n, i))?.onScreen ?? false;
const scrollTop = (): Promise<number> =>
  shell.page.evaluate(() => {
    const layers = document.querySelectorAll('.nav-root > .layer');
    return layers[layers.length - 1]?.querySelector('[data-testid="screen-reader"] .reader-scroll')?.scrollTop ?? -1;
  });
async function setScrollTop(v: number): Promise<void> {
  await shell.page.evaluate((y) => {
    const layers = document.querySelectorAll('.nav-root > .layer');
    const sc = layers[layers.length - 1]?.querySelector('[data-testid="screen-reader"] .reader-scroll');
    if (sc) sc.scrollTop = y;
  }, v);
}
/** Scroll the reader so paragraph `i` of chapter `n` is at the top of the screen (the chapter must be mounted). */
async function scrollToParagraph(n: number, i: number): Promise<void> {
  await shell.page.evaluate(
    ([p, k]) => {
      const layers = document.querySelectorAll('.nav-root > .layer');
      const reader = layers[layers.length - 1]?.querySelector('[data-testid="screen-reader"]');
      const sc = reader?.querySelector('.reader-scroll');
      const sec = [...(reader?.querySelectorAll<HTMLElement>('.rd-chapter[data-path]') ?? [])].find((s) => s.dataset.path === p);
      const el = sec?.querySelector('.rd-body')?.children[k];
      if (sc && el) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    },
    [path_(n), i] as const,
  );
}
/** Until the reader's page stops moving (following glides smoothly). */
async function settled(): Promise<void> {
  let last = Number.NaN;
  await expect
    .poll(
      async () => {
        const now = await scrollTop();
        const still = now === last;
        last = now;
        return still;
      },
      { timeout: 4000, interval: 150 },
    )
    .toBe(true);
}
/** A finger drag in the reader (a touchmove the overlay counts as a drag). */
async function dragReader(): Promise<void> {
  await shell.page.evaluate(() => {
    const layers = document.querySelectorAll('.nav-root > .layer');
    layers[layers.length - 1]?.querySelector('[data-testid="screen-reader"] .reader-scroll')?.dispatchEvent(new Event('touchmove', { bubbles: true }));
  });
}
/** The app goes to the background / comes back (WKWebView fires visibilitychange for both). */
async function setVisible(visible: boolean): Promise<void> {
  await shell.page.evaluate((v) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (v ? 'visible' : 'hidden') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !v });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visible);
}
const pill = () => shell.page.getByTestId('back-to-narration');
/** What the reader on top shows (for failure messages): its chapters, scroll offset and the paragraphs on screen. */
const where = (): Promise<string> =>
  shell.page.evaluate(() => {
    const layers = document.querySelectorAll('.nav-root > .layer');
    const reader = layers[layers.length - 1]?.querySelector('[data-testid="screen-reader"]');
    if (!reader) return 'no reader on top';
    const secs = [...reader.querySelectorAll<HTMLElement>('.rd-chapter[data-path]')].map((s) => `${s.dataset.path ?? '?'}:${s.dataset.status ?? 'spacer'}`);
    const seen: string[] = [];
    for (const s of reader.querySelectorAll<HTMLElement>('.rd-chapter[data-path]')) {
      [...(s.querySelector('.rd-body')?.children ?? [])].forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.bottom > 0 && r.top < innerHeight) seen.push(`${s.dataset.path ?? '?'}#${i}`);
      });
    }
    const st = reader.querySelector('.reader-scroll')?.scrollTop;
    return `sections=${secs.join(',')} scrollTop=${String(st)} onScreen=${seen[0] ?? '-'}..${seen.at(-1) ?? '-'}`;
  });
/** Marks the reader element on top, to tell whether a later one is the same reader or a new one. */
const markReader = (): Promise<void> => shell.page.evaluate(() => {
  const layers = document.querySelectorAll('.nav-root > .layer');
  const r = layers[layers.length - 1]?.querySelector<HTMLElement>('[data-testid="screen-reader"]');
  if (r) r.dataset.tnTestMark = '1';
});
const sameReader = (): Promise<boolean> => shell.page.evaluate(() => {
  const layers = document.querySelectorAll('.nav-root > .layer');
  return layers[layers.length - 1]?.querySelector<HTMLElement>('[data-testid="screen-reader"]')?.dataset.tnTestMark === '1';
});

describe('the reader follows the narration (PC shell)', () => {
  beforeAll(async () => {
    const www = path.join(root, '.cache', 'shell-www-follow');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    shell = await startPcShell({
      wwwDir: www,
      core: { routes, answers: [0, 0, 0, 0] },
      beforeLoad: async (core) => {
        await core.call('sources.install', { code: fx('spec.json') });
      },
      initStorage: { 'tachinovel.tips.reader': '1' },
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
    expect(await paragraph(1, 1)).not.toBeNull();
  });

  afterAll(async () => {
    await shell?.close();
  });

  it('keeps the spoken sentence in view while the reader is on screen', async () => {
    narrate(1, 20);
    await expect.poll(() => onScreen(1, 20), { timeout: 5000 }).toBe(true);
    narrate(1, 30);
    await expect.poll(() => onScreen(1, 30), { timeout: 5000 }).toBe(true);
    expect(await pill().isHidden()).toBe(true);
  });

  it('a finger lets go of the narration; "Back to narration" brings the reader back to it', async () => {
    await settled();
    await dragReader();
    await setScrollTop(0);
    narrate(1, 35);
    await expect.poll(() => pill().isVisible(), { timeout: 3000 }).toBe(true);
    // The reader stays where the finger put it.
    await shell.page.waitForTimeout(800);
    expect(await scrollTop()).toBe(0);
    expect(await onScreen(1, 35)).toBe(false);
    expect(await pill().getAttribute('aria-label')).toBeNull(); // its visible text is its name
    expect((await pill().textContent())?.trim()).toBe('Back to narration');
    await pill().click();
    await expect.poll(() => onScreen(1, 35), { timeout: 5000 }).toBe(true);
    expect((await paragraph(1, 35))?.marked).toBe(true);
    await expect.poll(() => pill().isHidden(), { timeout: 3000 }).toBe(true);
  });

  it("the reader's own jumps (next chapter) let go of it too", async () => {
    // (A real tap's click: the bottom bar may be slid away while the reader follows.)
    await top().getByTestId('reader-next').evaluate((el) => (el as HTMLElement).click());
    await expect.poll(() => pill().isVisible(), { timeout: 3000 }).toBe(true);
    await pill().click();
    await expect.poll(() => onScreen(1, 35), { timeout: 8000 }).toBe(true);
    await expect.poll(() => pill().isHidden(), { timeout: 3000 }).toBe(true);
  });

  it('runs on into the next chapter in the same reader (continuous scroll appends it)', async () => {
    await markReader();
    narrate(1, PARAGRAPHS - 1);
    await expect.poll(() => onScreen(1, PARAGRAPHS - 1), { timeout: 5000 }).toBe(true);
    // v1 appends the next chapter ~2 screens before the end.
    await shell.page.locator(`[data-testid="reader-chapter"][data-path="${path_(2)}"][data-status="ready"]`).waitFor({ timeout: 10_000 });
    narrate(2, 4);
    await expect.poll(() => onScreen(2, 4), { timeout: 5000 }).toBe(true);
    expect(await sameReader()).toBe(true);
    expect(await pill().isHidden()).toBe(true);
  });

  it('back in the app after listening in the car: jumps to the sentence, in the chapter narration went on to', async () => {
    await setVisible(false);
    // Native went on (CarPlay, phone locked) into chapter 4; the WebView slept, the reports queue up.
    narrate(3, 10);
    narrate(4, 12);
    await shell.page.waitForTimeout(300);
    expect(await sameReader()).toBe(true); // nothing moves while the app is in the background
    await setVisible(true);
    // The reader opens on chapter 4 at the spoken sentence, marked.
    await expect.poll(() => onScreen(4, 12), { timeout: 10_000 }).toBe(true);
    expect(await sameReader()).toBe(false);
    expect((await paragraph(4, 12))?.marked).toBe(true);
    expect(await pill().isHidden()).toBe(true);
    // The listening position is the reading position: History says chapter 4.
    await expect
      .poll(async () => (await shell.core.call<{ path: string; chapterPath: string }[]>('history.list', { limit: 5 })).find((h) => h.path === NOVEL.novelPath)?.chapterPath, { timeout: 8000 })
      .toBe(path_(4));
  });

  it('back in the app with nothing narrated meanwhile (paused all along): the reader stays where it is', async () => {
    narrate(4, 12, { status: 'paused' });
    await settled();
    // Scrolled back to the chapter's start (v1 may insert chapter 3 above, anchored: the page doesn't move).
    await scrollToParagraph(4, 1);
    await shell.page.waitForTimeout(1500);
    expect(await onScreen(4, 2), await where()).toBe(true);
    await setVisible(false);
    await shell.page.waitForTimeout(200);
    await setVisible(true);
    await shell.page.waitForTimeout(1200);
    expect(await onScreen(4, 2)).toBe(true);
    expect(await onScreen(4, 12)).toBe(false);
  });

  it('even after scrolling away, back in the app it goes to the sentence being spoken', async () => {
    narrate(4, 20);
    await expect.poll(() => onScreen(4, 20), { timeout: 5000 }).toBe(true);
    await settled();
    await dragReader();
    await setScrollTop(0);
    await setVisible(false);
    narrate(4, 40);
    await setVisible(true);
    await expect.poll(() => onScreen(4, 40), { timeout: 5000 }).toBe(true).catch(async (e: unknown) => {
      throw new Error(`${String(e)} ${await where()}`);
    });
    expect((await paragraph(4, 40))?.marked).toBe(true);
    await expect.poll(() => pill().isHidden(), { timeout: 3000 }).toBe(true);
  });

  it('a reader opened while listening goes to the spoken sentence', async () => {
    await top().getByTestId('reader-back').click();
    await waitStack(3);
    narrate(4, 30);
    await top().getByTestId('resume').click();
    await waitStack(4);
    await expect.poll(() => onScreen(4, 30), { timeout: 10_000 }).toBe(true).catch(async (e: unknown) => {
      throw new Error(`${String(e)} ${await where()}`);
    });
    expect((await paragraph(4, 30))?.marked).toBe(true);
    shell.emitPluginEvent('Narration', 'state', { status: 'idle' });
    shell.pluginReplies.delete('Narration.state');
  });

  it('ran without page errors', () => {
    expect(shell.pageErrors).toEqual([]);
    expect(shell.consoleErrors.filter((e) => !/403|Failed to load resource|blocked/i.test(e))).toEqual([]);
  });
});
