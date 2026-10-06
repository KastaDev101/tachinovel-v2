/**
 * Seeds a realistic synthetic store through the core's own bridge methods (the same calls the UI
 * makes), so the crawl starts from a lived-in app instead of the first-run screen:
 *
 *  - sources: the Demo Library declarative source (+ the personal flavor's built-in Stonescape);
 *  - categories: Reading, Plan to Read, Finished (one novel left uncategorized);
 *  - library: 7 novels from both sources, with covers cached locally;
 *  - reading: progress in 5 novels at different times (history, read marks, unread badges, a bookmark);
 *  - updates: new chapters released after the library was added, found by a real update check;
 *  - downloads: three chapters of one novel saved offline.
 */
import vm from 'node:vm';
import type { CoreHarness } from '../helpers/native-mock.ts';
import { FIXED_NOW, type FakeWeb } from './fake-web.ts';

const HOUR = 3_600_000;

interface NovelPageLite {
  details: { pluginId: string; path: string; name: string };
  chapters: { path: string; name: string; locked?: boolean }[];
}

export async function seedStore(core: CoreHarness, web: FakeWeb): Promise<void> {
  // The clock only moves forward (rate limiters and caches compare timestamps).
  let last = 0;
  const at = (t: number): void => {
    last = Math.max(last + 1, t);
    vm.runInContext(`__qaSetClock(${last})`, core.context);
  };
  const debug = process.env.QA_DEBUG ? (m: string) => console.log(`[seed] ${m}`) : () => undefined;
  const call = async <T = unknown>(method: string, args?: unknown): Promise<T> => {
    debug(`${method} ${JSON.stringify(args ?? null).slice(0, 120)}`);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_r, reject) => (timer = setTimeout(() => reject(new Error(`seed: ${method} timed out`)), 20_000)));
    try {
      return await Promise.race([core.call<T>(method, args), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  const sources = await call<{ id: string }[]>('sources.list');
  const personal = sources.some((s) => s.id === 'stonescape');
  await call('sources.install', { code: web.demoSpec });

  await call('categories.save', {
    categories: [
      { id: 'reading', name: 'Reading', order: 0 },
      { id: 'plan', name: 'Plan to Read', order: 1 },
      { id: 'done', name: 'Finished', order: 2 },
    ],
  });

  const demo = (slug: string): { pluginId: string; path: string } => ({ pluginId: 'demo-library', path: `novel/${slug}` });
  const stone = (slug: string): { pluginId: string; path: string } => ({ pluginId: 'stonescape', path: slug });
  const library: { key: { pluginId: string; path: string }; cats: string[] }[] = [
    { key: demo('alpha'), cats: ['reading'] },
    { key: demo('lantern'), cats: ['reading'] },
    { key: demo('ashes'), cats: ['reading', 'plan'] },
    { key: demo('cartographer'), cats: ['plan'] },
    { key: demo('quiet-harbor'), cats: ['done'] },
    { key: demo('iron-ivy'), cats: [] },
  ];
  if (personal) library.push({ key: stone('shadow-tide'), cats: ['reading'] }, { key: stone('glass-orchard'), cats: ['done'] });

  const pages = new Map<string, NovelPageLite>();
  let t = FIXED_NOW - 30 * 24 * HOUR;
  for (const { key, cats } of library) {
    at((t += 6 * HOUR));
    const page = await call<NovelPageLite>('novel.get', key);
    pages.set(`${key.pluginId}:${key.path}`, page);
    await call('library.add', { novel: page.details, categoryIds: cats });
  }

  // Reading: [novel, chapters finished, chapter in progress (fraction), hours ago].
  const reads: [{ pluginId: string; path: string }, number, number, number][] = [
    [demo('alpha'), 6, 0.42, 3],
    [demo('lantern'), 25, 0.1, 20],
    [demo('quiet-harbor'), 6, 1, 26],
    [demo('ashes'), 2, 0.75, 24 * 4],
    [demo('cartographer'), 0, 0.3, 24 * 9],
  ];
  if (personal) reads.push([stone('shadow-tide'), 12, 0.55, 2]);
  reads.sort((a, b) => b[3] - a[3]); // oldest first
  for (const [key, finished, frac, hoursAgo] of reads) {
    const page = pages.get(`${key.pluginId}:${key.path}`);
    if (!page) continue;
    const readable = page.chapters.filter((c) => !c.locked);
    const start = FIXED_NOW - hoursAgo * HOUR - finished * 9 * 60_000;
    for (let i = 0; i < finished; i++) {
      const c = readable[i];
      if (!c) break;
      at(start + i * 9 * 60_000);
      // Only the last few chapters are fetched (history needs the chapter; older ones are just marked).
      if (i >= finished - 2) await call('chapter.get', { pluginId: key.pluginId, novelPath: key.path, chapterPath: c.path });
      await call('progress.save', { pluginId: key.pluginId, novelPath: key.path, chapterPath: c.path, position: { percent: 1, paragraph: 12 }, finished: true });
    }
    const current = readable[finished];
    if (current && frac < 1) {
      at(start + finished * 9 * 60_000);
      await call('chapter.get', { pluginId: key.pluginId, novelPath: key.path, chapterPath: current.path });
      await call('progress.save', { pluginId: key.pluginId, novelPath: key.path, chapterPath: current.path, position: { percent: frac, paragraph: Math.round(frac * 14), offset: 8 } });
    }
  }
  const alpha = pages.get('demo-library:novel/alpha');
  const bookmarked = alpha?.chapters[2];
  if (bookmarked) await call('progress.bookmark', { pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: bookmarked.path, bookmarked: true });

  // Updates: chapters released after the library was set up, found by the regular update check.
  at(FIXED_NOW - 90 * 60_000);
  web.publish();
  const upd = await call<{ newChapters: number }>('library.checkUpdates', {});
  if (upd.newChapters < 1) throw new Error('seed: the update check found no new chapters');

  // Downloads: three chapters of The Lantern Keeper saved offline.
  const lantern = pages.get('demo-library:novel/lantern');
  if (lantern) {
    const paths = lantern.chapters.slice(25, 28).map((c) => c.path);
    await call('downloads.enqueue', { pluginId: 'demo-library', novelPath: 'novel/lantern', chapterPaths: paths });
    const deadline = Date.now() + 15_000;
    while (!core.events.some((e) => e.event === 'downloads.progress' && (e.payload as { finished?: boolean }).finished)) {
      if (Date.now() > deadline) throw new Error('seed: downloads did not finish');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  at(FIXED_NOW - 60_000);
  await call('app.flush');
}
