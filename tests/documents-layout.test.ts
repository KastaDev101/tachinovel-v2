/**
 * Free-sideload storage layout (src/core/storage/documents-layout.ts): without iCloud, the synced store
 * lives in Documents/TachiNovel (visible in Files). Data written by older builds into the local folder is
 * moved once: copy → verify → switch (marker) → confirm on the first app.boot → old copies removed at
 * the next launch. Crashes and failures at any step keep a complete copy and resume next launch.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KNOWN_SYNCED, type LayoutFs, LOCAL_ONLY, MARKER, MARKER_NEXT, prepareDocumentsLayout } from '../src/core/storage/documents-layout.ts';
import { buildAll } from '../tools/build.ts';
import { type Route, startCoreInVm } from './helpers/native-mock.ts';

/** NativeHost-like fs over node (FileManager semantics: copy/move refuse existing targets), with faults. */
function nodeFs(fault?: (op: string, p: string) => boolean): LayoutFs {
  const f = (op: string, p: string): void => {
    if (fault?.(op, p)) throw new Error(`Injected ${op} failure: ${p}`);
  };
  return {
    readText: (p) => (existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf8') : null),
    writeText(p, t) {
      f('writeText', p);
      if (!existsSync(path.dirname(p))) throw new Error(`No such directory: ${p}`);
      writeFileSync(p, t);
    },
    exists: (p) => existsSync(p),
    isDirectory: (p) => existsSync(p) && statSync(p).isDirectory(),
    remove(p) {
      f('remove', p);
      if (!existsSync(p)) throw new Error(`No such file: ${p}`);
      rmSync(p, { recursive: true, force: true });
    },
    move(a, b) {
      f('move', a);
      if (existsSync(b)) throw new Error(`Destination exists: ${b}`);
      renameSync(a, b);
    },
    copy(a, b) {
      f('copy', a);
      if (existsSync(b)) throw new Error(`Destination exists: ${b}`);
      copyFileSync(a, b);
    },
    list: (p) => readdirSync(p),
    size: (p) => (existsSync(p) ? statSync(p).size : 0),
    mkdirp: (p) => void mkdirSync(p, { recursive: true }),
  };
}

const tmp = mkdtempSync(path.join(tmpdir(), 'tn2-layout-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

function setup(): { localDir: string; docsDir: string; logs: string[] } {
  const base = path.join(tmp, `case-${++n}`);
  const localDir = path.join(base, 'local', 'TachiNovel');
  const docsDir = path.join(base, 'documents', 'TachiNovel');
  mkdirSync(localDir, { recursive: true });
  return { localDir, docsDir, logs: [] };
}

function put(dir: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
}

/** An old-layout install: synced state, local caches, an unknown file and a temp file, all in one folder. */
function oldInstall(localDir: string): void {
  put(localDir, 'library.json', '{"schemaVersion":3,"novels":["alpha"]}');
  put(localDir, 'settings.json', '{"schemaVersion":1}');
  put(localDir, 'progress/abc.json', '{"p":4}');
  put(localDir, 'backups/tachinovel-backup-1.json', 'x'.repeat(2048));
  put(localDir, 'sources/plugins/demo.js', 'exports.default = {}');
  put(localDir, 'cache/c1.json', '{}');
  put(localDir, 'covers/a.jpg', 'jpg');
  put(localDir, 'logs/app.log', 'line');
  put(localDir, 'symbols.json', '{}');
  put(localDir, 'something-new.json', '{"future":true}');
  put(localDir, 'library.json.tmp', 'partial');
}

const run = (s: ReturnType<typeof setup>, fs: LayoutFs = nodeFs()) =>
  prepareDocumentsLayout(fs, { localDir: s.localDir, docsDir: s.docsDir, now: () => 1_000, log: (_l, m) => s.logs.push(m) });
const marker = (docsDir: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(docsDir, MARKER), 'utf8')) as Record<string, unknown>;

describe('documents layout (unit)', () => {
  it('a fresh install starts in Documents at once', () => {
    const s = setup();
    const r = run(s);
    expect(r).toMatchObject({ useDocuments: true, action: 'fresh', copied: [] });
    expect(marker(s.docsDir)).toMatchObject({ state: 'confirmed', entries: [], cleanedAt: 1000 });
  });

  it('moves synced state (and unknown names), never caches or temp files; old copies stay until confirmed + relaunch', () => {
    const s = setup();
    oldInstall(s.localDir);
    const r1 = run(s);
    expect(r1.action).toBe('migrated');
    expect(r1.copied.sort()).toEqual(['backups', 'library.json', 'progress', 'settings.json', 'something-new.json', 'sources']);
    expect(readFileSync(path.join(s.docsDir, 'progress/abc.json'), 'utf8')).toBe('{"p":4}');
    expect(readFileSync(path.join(s.docsDir, 'sources/plugins/demo.js'), 'utf8')).toBe('exports.default = {}');
    for (const local of ['cache', 'covers', 'logs', 'symbols.json', 'library.json.tmp']) expect(existsSync(path.join(s.docsDir, local))).toBe(false);
    expect(marker(s.docsDir)).toMatchObject({ state: 'switched' });
    expect(existsSync(path.join(s.localDir, 'library.json'))).toBe(true); // old copy kept

    // Next launch without a confirmed boot: still in use, nothing removed.
    expect(run(s)).toMatchObject({ useDocuments: true, action: 'in-use', removed: [] });
    expect(existsSync(path.join(s.localDir, 'library.json'))).toBe(true);

    // The UI booted from Documents; the launch after that removes the old copies of KNOWN synced entries.
    run(s).confirm();
    expect(marker(s.docsDir)).toMatchObject({ state: 'confirmed', confirmedAt: 1000 });
    const r3 = run(s);
    expect(r3.action).toBe('cleaned');
    expect(r3.removed.sort()).toEqual(['backups', 'library.json', 'progress', 'settings.json', 'sources']);
    expect(existsSync(path.join(s.localDir, 'something-new.json'))).toBe(true); // unknown: copied, never removed
    for (const local of ['cache/c1.json', 'covers/a.jpg', 'logs/app.log', 'symbols.json']) expect(existsSync(path.join(s.localDir, local))).toBe(true);
    expect(run(s).action).toBe('in-use');
  });

  it('a failure mid-copy keeps the old layout this launch, then resumes and repairs a half-written file', () => {
    const s = setup();
    oldInstall(s.localDir);
    let copies = 0;
    const r1 = run(s, nodeFs((op) => op === 'copy' && ++copies === 3));
    expect(r1).toMatchObject({ useDocuments: false, action: 'failed' });
    expect(existsSync(path.join(s.docsDir, MARKER))).toBe(false);
    expect(readFileSync(path.join(s.localDir, 'library.json'), 'utf8')).toContain('alpha'); // untouched
    // A crash left a truncated file behind in Documents.
    put(s.docsDir, 'library.json', '{"schemaVer');
    const r2 = run(s);
    expect(r2.action).toBe('migrated');
    expect(readFileSync(path.join(s.docsDir, 'library.json'), 'utf8')).toBe('{"schemaVersion":3,"novels":["alpha"]}');
  });

  it('a crash while updating the marker always leaves a readable one', () => {
    const s = setup();
    oldInstall(s.localDir);
    run(s);
    // Confirm: the new marker is written, the old one removed, then the move fails (a crash right there).
    const r = run(s, nodeFs((op, p) => op === 'move' && p.endsWith(MARKER_NEXT)));
    r.confirm();
    expect(existsSync(path.join(s.docsDir, MARKER))).toBe(false);
    expect(existsSync(path.join(s.docsDir, MARKER_NEXT))).toBe(true);
    // Next launch reads it (confirmed), promotes it before writing, and cleans up.
    expect(run(s).action).toBe('cleaned');
    expect(marker(s.docsDir)).toMatchObject({ state: 'confirmed', cleanedAt: 1000 });
    expect(existsSync(path.join(s.docsDir, MARKER_NEXT))).toBe(false);
  });

  it('a half-written next marker beside a valid one is ignored', () => {
    const s = setup();
    oldInstall(s.localDir);
    run(s);
    writeFileSync(path.join(s.docsDir, MARKER_NEXT), '{"vers');
    expect(run(s)).toMatchObject({ action: 'in-use' });
    run(s).confirm();
    expect(marker(s.docsDir)).toMatchObject({ state: 'confirmed' });
  });

  it('an unreadable marker means "in use, never clean up"', () => {
    const s = setup();
    oldInstall(s.localDir);
    run(s);
    writeFileSync(path.join(s.docsDir, MARKER), '{not json');
    expect(run(s)).toMatchObject({ useDocuments: true, action: 'in-use' });
    expect(existsSync(path.join(s.localDir, 'library.json'))).toBe(true);
  });

  it('the name lists stay disjoint', () => {
    for (const name of KNOWN_SYNCED) expect(LOCAL_ONLY.has(name)).toBe(false);
  });
});

const root = path.resolve(import.meta.dirname, '..');
const fx = (name: string): string => readFileSync(path.join(root, 'tests', 'fixtures', 'demo-site', name), 'utf8');
const SITE = 'https://novels.example.test/';
const routes: Record<string, Route> = { [`${SITE}novel/alpha`]: { body: fx('novel-alpha.html') } };

describe('documents layout (core, three launches of one free-sideload install)', () => {
  let www: string;
  const dataDir = path.join(tmp, 'install');
  const docsApp = path.join(dataDir, 'documents', 'TachiNovel');
  const localApp = path.join(dataDir, 'local', 'TachiNovel');

  beforeAll(async () => {
    www = path.join(root, '.cache', 'test-www-layout');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    mkdirSync(dataDir, { recursive: true });
  });

  it('an older build kept the library in the device-only folder', async () => {
    const core = startCoreInVm({ wwwDir: www, routes, dataDir, syncedAvailable: false, documentsAvailable: false });
    try {
      await core.call('sources.install', { code: fx('spec.json') });
      await core.call('library.add', { novel: { pluginId: 'demo-library', path: 'novel/alpha', name: 'Alpha Story' } });
      await core.call('app.flush');
      expect(existsSync(path.join(localApp, 'library.json'))).toBe(true);
    } finally {
      core.dispose();
    }
  });

  it('this build moves it to Documents and confirms on the first app.boot', async () => {
    const core = startCoreInVm({ wwwDir: www, routes, dataDir, syncedAvailable: false });
    try {
      await core.call('app.boot');
      const lib = await core.call<{ key: string }[]>('library.list');
      expect(lib.map((e) => e.key)).toEqual(['demo-library:novel/alpha']);
      expect(existsSync(path.join(docsApp, 'library.json'))).toBe(true);
      expect(existsSync(path.join(docsApp, 'sources'))).toBe(true);
      expect(marker(docsApp)).toMatchObject({ state: 'confirmed' });
      expect(existsSync(path.join(localApp, 'library.json'))).toBe(true); // kept until the next launch
      // New backups land in Documents (Files: On My iPhone › TachiNovel › TachiNovel › backups).
      const b = await core.call<{ fileName: string }>('backup.create');
      expect(existsSync(path.join(docsApp, 'backups', b.fileName))).toBe(true);
      expect(core.logs.some((l) => l.line.includes('Storage layout: moved'))).toBe(true);
      await core.call('app.flush');
    } finally {
      core.dispose();
    }
  });

  it('the next launch removes the old copies and still has the library', async () => {
    const core = startCoreInVm({ wwwDir: www, routes, dataDir, syncedAvailable: false });
    try {
      const lib = await core.call<{ key: string }[]>('library.list');
      expect(lib.map((e) => e.key)).toEqual(['demo-library:novel/alpha']);
      expect(existsSync(path.join(localApp, 'library.json'))).toBe(false);
      expect(existsSync(path.join(localApp, 'sources'))).toBe(false);
      expect(marker(docsApp).cleanedAt).toEqual(expect.any(Number));
    } finally {
      core.dispose();
    }
  });

  it('with iCloud, Documents is not used', async () => {
    const core = startCoreInVm({ wwwDir: www, routes });
    try {
      await core.call('app.boot');
      expect(existsSync(path.join(core.dir, 'documents', 'TachiNovel'))).toBe(false);
    } finally {
      core.dispose();
    }
  });
});
