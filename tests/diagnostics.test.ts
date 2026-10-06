/**
 * MetricKit diagnostics kept on the device (src/core/diagnostics/metrickit.ts): payload parsing,
 * storage with de-duplication and a cap, the log line, export and clear; then end to end through the
 * built core (diagnostics.* methods, app.logs) in the bare JS context. Fixture data is synthetic.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileStore } from '@v1/shared/contracts/platform.ts';
import { clearReports, EXPORT_FILE, exportReports, hash, listReports, logLine, MAX_REPORTS, parsePayload, recordPayload, REPORTS_DIR, topFrames } from '../src/core/diagnostics/metrickit.ts';
import { buildAll } from '../tools/build.ts';
import { startCoreInVm } from './helpers/native-mock.ts';

const root = path.resolve(import.meta.dirname, '..');
const PAYLOAD = readFileSync(path.join(root, 'tests', 'fixtures', 'metrickit', 'payload.json'), 'utf8');
const NOW = Date.parse('2026-10-06T12:00:00Z');

/** Minimal in-memory FileStore (flat map of relative paths). */
function memoryStore(): FileStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['']);
  return {
    files,
    root: '/mem',
    isSynced: false,
    readText: (p) => Promise.resolve(files.get(p) ?? null),
    writeText: (p, t) => {
      files.set(p, t);
      return Promise.resolve();
    },
    readBase64: () => Promise.resolve(null),
    writeBase64: () => Promise.resolve(),
    exists: (p) => files.has(p) || dirs.has(p),
    remove: (p) => {
      files.delete(p);
    },
    move: (a, b) => {
      files.set(b, files.get(a) ?? '');
      files.delete(a);
    },
    list: (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map((p) => p.slice(dir.length + 1)),
    size: (p) => files.get(p)?.length ?? 0,
    modifiedAt: () => null,
    mkdirp: (d) => {
      dirs.add(d);
    },
    absolute: (p) => `/mem/${p}`,
  };
}

describe('MetricKit payload parsing', () => {
  const found = parsePayload(PAYLOAD, NOW);

  it('finds every diagnostic kind with readable titles', () => {
    expect(found.map((f) => f.summary.kind)).toEqual(['crash', 'hang', 'cpu', 'diskWrite', 'launch']);
    expect(found.map((f) => f.summary.title)).toEqual([
      'Crash: EXC_BAD_ACCESS (SIGSEGV) [Namespace SIGNAL, Code 11 Segmentation fault: 11]',
      'Hang: 2.4 sec',
      'CPU exception: 1.2 min CPU in 3 min',
      'Disk writes exception: 1,100 MB written',
      'Slow launch: 21 sec',
    ]);
    const crash = found[0]!.summary;
    expect(crash).toMatchObject({ appVersion: '2.0.0 (57)', osVersion: 'iPhone OS 26.0 (23A341)', device: 'iPhone17,3' });
    expect(crash.at).toBe(Date.parse('2026-10-05T23:59:00'));
    expect(crash.id).toMatch(/^crash-[0-9a-f]{8}$/);
  });

  it('walks the attributed thread for the top frames', () => {
    expect(found[0]!.summary.frames).toEqual(['App +0x1a2b', 'App +0x5678', 'UIKitCore +0xff']);
    expect(found[1]!.summary.frames).toEqual(['JavaScriptCore +0x1e240']);
    expect(topFrames({}, 3)).toEqual([]);
  });

  it('never throws on bad input', () => {
    expect(parsePayload('not json', NOW)).toEqual([]);
    expect(parsePayload('[]', NOW)).toEqual([]);
    expect(parsePayload('{"crashDiagnostics": [null, 3, {"diagnosticMetaData": {"signal": 6}}]}', NOW).map((f) => f.summary.title)).toEqual(['Crash: (SIGABRT)']);
    expect(parsePayload('{"crashDiagnostics": [{}]}', NOW)[0]!.summary).toMatchObject({ title: 'Crash: unknown exception', at: NOW, frames: [] });
  });

  it('writes a short log line', () => {
    expect(logLine(found[0]!.summary)).toBe('MetricKit 2026-10-05 Crash: EXC_BAD_ACCESS (SIGSEGV) [Namespace SIGNAL, Code 11 Segmentation fault: 11] (app 2.0.0 (57), iPhone OS 26.0 (23A341), iPhone17,3) · App +0x1a2b ← App +0x5678 ← UIKitCore +0xff');
    const long = { ...found[0]!.summary, title: 'x'.repeat(400) };
    expect(logLine(long).length).toBe(280);
    expect(hash('a')).toBe(hash('a'));
    expect(hash('a')).not.toBe(hash('b'));
  });
});

describe('MetricKit report store', () => {
  it('stores each diagnostic once, logs it, lists newest first, exports and clears', async () => {
    const store = memoryStore();
    const logs: [string, string][] = [];
    const log = (level: 'warn' | 'error', message: string): void => {
      logs.push([level, message]);
    };
    expect(await recordPayload(store, PAYLOAD, NOW, log)).toBe(5);
    expect(await recordPayload(store, PAYLOAD, NOW, log)).toBe(0);
    expect(logs.map(([l]) => l)).toEqual(['warn', 'warn', 'warn', 'warn', 'error']);
    expect(store.list(REPORTS_DIR)).toHaveLength(5);

    const listed = await listReports(store);
    expect(listed).toHaveLength(5);
    expect(new Set(listed.map((s) => s.kind))).toEqual(new Set(['crash', 'hang', 'cpu', 'diskWrite', 'launch']));

    const file = await exportReports(store, { app: '2.0.0+test', exportedAt: NOW });
    expect(file).toBe(EXPORT_FILE);
    const doc = JSON.parse(store.files.get(EXPORT_FILE) ?? '{}') as { format: string; reports: { diagnostic: { callStackTree?: unknown } }[] };
    expect(doc.format).toBe('tachinovel-metrickit/1');
    expect(doc.reports).toHaveLength(5);
    expect(doc.reports.some((r) => r.diagnostic.callStackTree !== undefined)).toBe(true);

    expect(clearReports(store)).toBe(5);
    expect(await listReports(store)).toEqual([]);
    expect(store.files.has(EXPORT_FILE)).toBe(false);
    expect(await exportReports(store, { app: 'x', exportedAt: NOW })).toBeNull();
  });

  it(`keeps only the newest ${MAX_REPORTS}`, async () => {
    const store = memoryStore();
    for (let i = 0; i < MAX_REPORTS + 5; i++) {
      const day = String(1 + (i % 28)).padStart(2, '0');
      const json = JSON.stringify({ timeStampEnd: `2026-${i < 28 ? '08' : '09'}-${day} 10:00:00`, hangDiagnostics: [{ diagnosticMetaData: { hangDuration: `${i} sec` } }] });
      await recordPayload(store, json, NOW, () => undefined);
    }
    const listed = await listReports(store);
    expect(listed).toHaveLength(MAX_REPORTS);
    expect(listed[0]!.title).toBe(`Hang: ${MAX_REPORTS + 4} sec`);
    expect(listed.some((s) => s.title === 'Hang: 0 sec')).toBe(false);
  });

  it('skips damaged report files', async () => {
    const store = memoryStore();
    await recordPayload(store, PAYLOAD, NOW, () => undefined);
    store.files.set(`${REPORTS_DIR}/9999-broken.json`, '{not json');
    expect(await listReports(store)).toHaveLength(5);
  });
});

describe('diagnostics.* in the built core', () => {
  it('stores, logs, lists, shares and clears MetricKit reports', async () => {
    const outDir = path.join(root, '.cache', 'test-www-diagnostics');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir });
    const core = startCoreInVm({ wwwDir: outDir, routes: {} });
    try {
      await core.call('app.boot');
      await expect(core.call('diagnostics.metricPayload', { json: PAYLOAD })).resolves.toEqual({ added: 5 });
      await expect(core.call('diagnostics.metricPayload', { json: PAYLOAD })).resolves.toEqual({ added: 0 });
      const raw = await core.callRaw('diagnostics.metricPayload', {});
      expect(raw.ok).toBe(false);
      expect(raw.error?.code).toBe('INVALID_ARGS');

      const problems = await core.call<{ level: string; message: string }[]>('app.logs', { level: 'warn', limit: 20 });
      expect(problems.some((p) => p.level === 'error' && p.message.startsWith('MetricKit 2026-10-05 Crash: EXC_BAD_ACCESS (SIGSEGV)'))).toBe(true);
      expect(problems.filter((p) => p.message.startsWith('MetricKit ')).length).toBe(5);

      expect(await core.call<unknown[]>('diagnostics.reports')).toHaveLength(5);
      await expect(core.call('diagnostics.shareReports')).resolves.toEqual({ shared: 5 });
      expect(existsSync(path.join(core.localAppDir, 'logs', 'metrickit-export.json'))).toBe(true);
      await expect(core.call('diagnostics.clearReports')).resolves.toEqual({ removed: 5 });
      await expect(core.call('diagnostics.shareReports')).resolves.toEqual({ shared: 0 });
    } finally {
      core.dispose();
    }
  });
});
