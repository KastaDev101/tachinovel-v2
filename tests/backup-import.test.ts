/**
 * Moving a library from v1 (Scriptable) to v2: Settings › Backup & Restore › "Restore from Files…"
 * picks a v1 backup JSON with the iOS document picker (simulated by the native mock: the file is
 * copied into the core's imports folder, exactly like NativeUI.documentPicker does), previews it
 * (backup.preview without fileName → importId), then restores it (backup.restore with importId).
 *
 * Optional real-data check, never committed: set TACHI_V1_BACKUP=<path to a v1 backup .json>.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../tools/build.ts';
import { type CoreHarness, type Route, startCoreInVm } from './helpers/native-mock.ts';

const root = path.resolve(import.meta.dirname, '..');
const fx = (n: string): string => readFileSync(path.join(root, 'tests', 'fixtures', 'demo-site', n), 'utf8');
const SITE = 'https://novels.example.test/';
const routes: Record<string, Route> = {
  [`${SITE}novel/alpha`]: { body: fx('novel-alpha.html') },
  [`${SITE}novel/alpha/1`]: { body: fx('chapter-alpha-1.html') },
};

describe.each(['personal', 'store'] as const)('restore a v1 backup picked from Files (%s flavor)', (flavor) => {
  let www: string;
  let source: CoreHarness;
  let backupFile: string;

  beforeAll(async () => {
    www = path.join(root, '.cache', `test-www-backup-${flavor}`);
    await buildAll({ flavor, ads: false, dev: false, outDir: www });
    // "Old phone": a library with a novel, reading progress and a backup.
    source = startCoreInVm({ wwwDir: www, routes, answers: [0, 0] });
    await source.call('sources.install', { code: fx('spec.json') });
    await source.call('library.add', { novel: { pluginId: 'demo-library', path: 'novel/alpha', name: 'Alpha Story' } });
    await source.call('progress.save', { pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1', position: { percent: 0.5, paragraph: 4, offset: 0 } });
    const info = await source.call<{ fileName: string }>('backup.create');
    backupFile = path.join(source.dir, 'icloud', 'TachiNovel', 'backups', info.fileName);
    expect(existsSync(backupFile)).toBe(true);
  });

  afterAll(() => source?.dispose());

  it('previews and restores it on a fresh install (merge)', async () => {
    const target = startCoreInVm({ wwwDir: www, routes, picks: [backupFile], answers: [0, 0, 0] });
    try {
      const preview = await target.call<{ importId: string; counts: { novels: number; sources: number }; newNovels: number }>('backup.preview');
      expect(preview.counts.novels).toBe(1);
      expect(preview.newNovels).toBe(1);
      expect(preview.importId).toMatch(/^imp-/);
      // The picked copy landed in the local imports folder (what v1's readPicked accepts).
      expect(readdirSync(path.join(target.localAppDir, 'imports'))).toContain(path.basename(backupFile));

      const r = await target.call<{ novels: number; sources: number }>('backup.restore', { importId: preview.importId, mode: 'merge' });
      expect(r.novels).toBe(1);
      const lib = await target.call<{ key: string; name: string }[]>('library.list');
      expect(lib.map((e) => e.key)).toEqual(['demo-library:novel/alpha']);
      await expect(target.call('narration.resumePoint', { pluginId: 'demo-library', novelPath: 'novel/alpha' })).resolves.toMatchObject({
        chapterPath: 'novel/alpha/1',
        paragraph: 4,
      });
    } finally {
      target.dispose();
    }
  });

  it('a cancelled picker is not an error for restore, and a clear NOT_FOUND for preview', async () => {
    const target = startCoreInVm({ wwwDir: www, routes, picks: [null, null] });
    try {
      const preview = await target.callRaw('backup.preview');
      expect(preview).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      await expect(target.call('backup.restore', { mode: 'merge' })).resolves.toEqual({ novels: 0, sources: 0 });
    } finally {
      target.dispose();
    }
  });

  it('rejects a file that is not a backup with INVALID_ARGS', async () => {
    const target = startCoreInVm({ wwwDir: www, routes, picks: [path.join(root, 'package.json')] });
    try {
      const r = await target.callRaw('backup.preview');
      expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    } finally {
      target.dispose();
    }
  });
});

const realBackup = process.env.TACHI_V1_BACKUP;
describe.skipIf(!realBackup || !existsSync(realBackup))('a real v1 backup (local only, TACHI_V1_BACKUP)', () => {
  it('previews and restores in the personal flavor', async () => {
    const www = path.join(root, '.cache', 'test-www-backup-personal');
    await buildAll({ flavor: 'personal', ads: false, dev: false, outDir: www });
    const target = startCoreInVm({ wwwDir: www, routes: {}, picks: [realBackup as string], answers: [0, 0, 0, 0] });
    try {
      const preview = await target.call<{ importId: string; counts: Record<string, number>; skipped: number }>('backup.preview');
      console.log('real backup preview', preview.counts, 'skipped', preview.skipped);
      const r = await target.call<{ novels: number; sources: number }>('backup.restore', { importId: preview.importId, mode: 'merge' });
      const lib = await target.call<unknown[]>('library.list');
      expect(lib.length).toBe(r.novels);
    } finally {
      target.dispose();
    }
  });
});
