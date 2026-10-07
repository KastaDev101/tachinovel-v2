/**
 * Pronunciations and text prep settings in the BUILT core (vm + native mock): stored with the lists, used by
 * narration.chapterText (lock screen, Prepare for the drive), and carried by backups: v1 writes the backup
 * file, the core adds its `narration` section and restores it (same device by file name; another device by a
 * picked file, merge or replace).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { narrationBackup, parseLexiconStore, readNarrationBackup, restoreLexicons } from '../src/core/narration/lexicon-store.ts';
import { emptyLexiconStore } from '../src/core/narration/speech-script.ts';
import { buildAll } from '../tools/build.ts';
import { type CoreHarness, type Route, startCoreInVm } from './helpers/native-mock.ts';

const root = path.resolve(import.meta.dirname, '..');
const fx = (n: string): string => readFileSync(path.join(root, 'tests', 'fixtures', 'demo-site', n), 'utf8');
const SITE = 'https://novels.example.test/';
const CHAPTER =
  '<html><body><div id="content"><p>Chapter 4 - Status</p><p>TL note: the status is translated loosely.</p><p>Nephis opened the window.</p>' +
  '<p>Name: Nephis<br>Level: 12<br>STR: 30<br>AGI: 25</p><p>She closed it.</p></div></body></html>';
const routes: Record<string, Route> = {
  [`${SITE}novel/alpha`]: { body: fx('novel-alpha.html') },
  [`${SITE}novel/alpha/1`]: { body: CHAPTER },
};
const ARGS = { pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1' };
const NOVEL = 'demo-library:novel/alpha';
const NEPHIS = { schemaVersion: 1, entries: [{ match: 'Nephis', say: 'NEF-iss' }] };

type Script = { script: { items: { text: string; kind: string }[] } };
const texts = async (core: CoreHarness): Promise<string[]> => (await core.call<Script>('narration.chapterText', ARGS)).script.items.map((i) => i.text);

describe('pronunciations and reading settings in the core', () => {
  let www: string;
  let core: CoreHarness;

  beforeAll(async () => {
    www = path.join(root, '.cache', 'test-www-narration-text');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    core = startCoreInVm({ wwwDir: www, routes, answers: [0, 0] });
    await core.call('sources.install', { code: fx('spec.json') });
    await core.call('library.add', { novel: { pluginId: 'demo-library', path: 'novel/alpha', name: 'Alpha Story' } });
  });

  afterAll(() => core?.dispose());

  it('reads chapters with the settings and the novel’s words (defaults: notes skipped, short stat tables)', async () => {
    expect(await texts(core)).toEqual(['Chapter four. Status.', 'Nephis opened the window.', 'Status. Name: Nephis, Level twelve, Strength thirty, Agility twenty-five.', 'She closed it.']);
    await core.call('narration.lexicon.set', { novelKey: NOVEL, lexicon: NEPHIS });
    await expect(core.call('narration.prep.set', { statTables: 'skip', skipNotes: false })).resolves.toEqual({ skipNotes: false, statTables: 'skip' });
    expect(await texts(core)).toEqual(['Chapter four. Status.', 'TL note: the status is translated loosely.', 'nef-iss opened the window.', 'She closed it.']);
    await expect(core.call('narration.lexicon.get', { novelKey: NOVEL })).resolves.toMatchObject({ prep: { skipNotes: false, statTables: 'skip' }, novel: NEPHIS });
    await expect(core.call('narration.lexicon.list')).resolves.toEqual({ global: 0, novels: [{ novelKey: NOVEL, name: 'Alpha Story', entries: 1 }] });
    // Unknown values fall back to the defaults.
    await expect(core.call('narration.prep.set', { statTables: 'everything' })).resolves.toEqual({ skipNotes: false, statTables: 'short' });
  });

  it('backups carry them; restoring the file on this device brings them back', async () => {
    await core.call('narration.prep.set', { statTables: 'full', skipNotes: true });
    const info = await core.call<{ fileName: string; bytes: number }>('backup.create');
    const file = readFileSync(path.join(core.dir, 'icloud', 'TachiNovel', 'backups', info.fileName), 'utf8');
    expect(info.bytes).toBe(file.length);
    expect(JSON.parse(file)).toMatchObject({ app: 'tachinovel', narration: { novels: { [NOVEL]: NEPHIS }, prep: { statTables: 'full', skipNotes: true } } });

    await core.call('narration.lexicon.set', { novelKey: NOVEL, lexicon: { schemaVersion: 1, entries: [] } });
    await core.call('narration.prep.set', { statTables: 'short' });
    await core.call('backup.restore', { fileName: info.fileName, mode: 'replace' });
    await expect(core.call('narration.lexicon.get', { novelKey: NOVEL })).resolves.toMatchObject({ novel: NEPHIS, prep: { statTables: 'full', skipNotes: true } });
  });

  it('a backup picked on another iPhone (preview, then restore) brings them too', async () => {
    const info = await core.call<{ fileName: string }>('backup.create');
    const picked = path.join(core.dir, 'icloud', 'TachiNovel', 'backups', info.fileName);
    const fresh = startCoreInVm({ wwwDir: www, routes, picks: [picked], answers: [0, 0, 0] });
    try {
      await fresh.call('narration.lexicon.set', { lexicon: { schemaVersion: 1, entries: [{ match: 'Sunny', say: 'sunny' }] } });
      const preview = await fresh.call<{ importId: string }>('backup.preview');
      await fresh.call('backup.restore', { importId: preview.importId, mode: 'merge' });
      const lex = await fresh.call<{ global: { entries: { match: string }[] }; novel: unknown; prep: unknown }>('narration.lexicon.get', { novelKey: NOVEL });
      expect(lex.novel).toEqual(NEPHIS);
      expect(lex.global.entries.map((e) => e.match)).toEqual(['Sunny']);
      expect(lex.prep).toEqual({ skipNotes: true, statTables: 'full' });
    } finally {
      fresh.dispose();
    }
  });
});

describe('backup section (pure)', () => {
  it('only when there is something of the user’s; merge keeps your words and settings, replace takes the backup’s', () => {
    expect(narrationBackup(emptyLexiconStore())).toBeNull();
    const mine = parseLexiconStore(JSON.stringify({ global: { schemaVersion: 1, entries: [{ match: 'Will', say: 'Wil' }] }, novels: {}, prep: { skipNotes: false } }));
    const theirs = readNarrationBackup(
      JSON.stringify({
        narration: {
          global: { schemaVersion: 1, entries: [{ match: 'will', say: 'whatever' }, { match: 'Sunny', say: 'sunny' }] },
          novels: { 'a:b': { schemaVersion: 1, entries: [{ match: 'Nephis', ipa: 'nˈɛfɪs' }] }, 'bad:one': { schemaVersion: 1, entries: [{ match: '' }] } },
          prep: { statTables: 'skip' },
        },
      }),
    );
    expect(theirs?.novels).toEqual({ 'a:b': { schemaVersion: 1, entries: [{ match: 'Nephis', ipa: 'nˈɛfɪs' }] } });
    if (!theirs) throw new Error('no section');
    const merged = restoreLexicons(mine, theirs, 'merge');
    expect(merged.global.entries.map((e) => e.say)).toEqual(['Wil', 'sunny']);
    expect(merged.prep).toEqual({ skipNotes: false, statTables: 'short' });
    const replaced = restoreLexicons(mine, theirs, 'replace');
    expect(replaced.global.entries.map((e) => e.say)).toEqual(['whatever', 'sunny']);
    expect(replaced.prep).toEqual({ skipNotes: true, statTables: 'skip' });
    expect(readNarrationBackup('{"app":"tachinovel"}')).toBeNull();
    expect(readNarrationBackup('not json')).toBeNull();
  });
});
