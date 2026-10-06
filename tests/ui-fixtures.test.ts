/**
 * The simulator UI test's fixtures (tools/ui-fixtures.ts) work on the PC first: the fixture site serves
 * the demo source, and the sample backup restores into a fresh install of the built core (source
 * reinstalled from the site, novel and progress back, chapter readable).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../tools/build.ts';
import { readableName } from '../tools/ui-attachments.ts';
import { absoluteRoutes, makeBackup, serve, SITE } from '../tools/ui-fixtures.ts';
import { startCoreInVm } from './helpers/native-mock.ts';

const root = path.resolve(import.meta.dirname, '..');
const PORT = 8799;
const local = `http://127.0.0.1:${PORT}/`;
const www = path.join(root, '.cache', 'test-www-ui-fixtures');
let server: ReturnType<typeof serve>;

beforeAll(async () => {
  await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
  server = serve(PORT, { quiet: true });
  await new Promise((r) => server.once('listening', r));
});

afterAll(() => {
  server?.close();
});

describe('UI test fixtures', () => {
  it('serves the demo site and its https source definition', async () => {
    const spec = (await (await fetch(`${local}spec.json`)).json()) as { id: string; site: string };
    expect(spec).toMatchObject({ id: 'demo-library', site: SITE });
    expect((await fetch(`${local}novel/alpha/1`)).status).toBe(200);
    expect(await (await fetch(`${local}popular?page=1`)).text()).toContain('Alpha Story');
    expect((await fetch(`${local}nope`)).status).toBe(404);
  });

  it('builds a synthetic sample backup that restores on a fresh install', async () => {
    const json = await makeBackup(www);
    const backup = JSON.parse(json) as { library: { name: string }[]; sources: { id: string; installUrl?: string }[] };
    expect(backup.library.map((n) => n.name)).toEqual(['Alpha Story']);
    expect(backup.sources).toEqual([expect.objectContaining({ id: 'demo-library', installUrl: `${SITE}spec.json` })]);

    const file = path.join(mkdtempSync(path.join(tmpdir(), 'tn-ui-')), 'tachinovel-backup-2026-10-01-0900.json');
    writeFileSync(file, json);
    const target = startCoreInVm({ wwwDir: www, routes: absoluteRoutes(), picks: [file], answers: [0, 0, 0] });
    try {
      const preview = await target.call<{ importId: string }>('backup.preview');
      await expect(target.call('backup.restore', { importId: preview.importId, mode: 'merge' })).resolves.toMatchObject({ novels: 1, sources: 1 });
      const lib = await target.call<{ key: string }[]>('library.list');
      expect(lib.map((e) => e.key)).toEqual(['demo-library:novel/alpha']);
      const chapter = await target.call<{ html: string }>('chapter.get', { pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1' });
      expect(chapter.html).toContain('Nobody answered');
    } finally {
      target.dispose();
    }
  });

  it('names exported XCTest attachments readably and drops automatic snapshots', () => {
    expect(readableName('03-restored_0_7B119B3E-9518-4154-8ED9-BE05ADC15AA4.png', 'AB.png')).toBe('03-restored.png');
    expect(readableName('accessibility-tree_0_ECBDC1E2-BC1D-4C6C-9FCD-DDF62C375F52.txt', 'CD.txt')).toBe('accessibility-tree.txt');
    expect(readableName('Screen Recording 2026-10-06 at 05.43.25 PM.mp4', 'EF.mp4')).toBe('screen-recording.mp4');
    expect(readableName('UI Snapshot 2026-10-06 at 05.44.40 PM', '12')).toBeNull();
    expect(readableName('Synthesized Event 2026-10-06 at 05.44.33 PM', '34')).toBeNull();
  });
});
