/**
 * tools/revendor-v1.ts against a throwaway git repo shaped like v1: moves the snapshot to a commit,
 * records it in VENDORED.md, lists the v1 commits in between, and restores the previous snapshot when
 * verification fails (unless --keep).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revendor } from '../tools/revendor-v1.ts';
import { PATHS, snapshot, vendoredCommit } from '../tools/vendor-v1.ts';

let tmp: string;
let v1: string;
let first: string;
let second: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: v1,
    encoding: 'utf8',
  }).trim();
}

function write(rel: string, text: string): void {
  const file = path.join(v1, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const sourcesFile = 'src/script/services/sources.ts';
const quiet = (): void => undefined;

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'revendor-test-'));
  v1 = path.join(tmp, 'v1');
  mkdirSync(v1);
  git('init', '-q');
  // Every vendored path must exist in the commit (git archive fails otherwise).
  for (const p of PATHS) {
    if (path.extname(p)) write(p, p.endsWith('.json') ? '{}\n' : `// ${p}\n`);
    else write(`${p}/index.ts`, `// ${p}\n`);
  }
  write(sourcesFile, 'export const BUILTIN_SOURCES = [1];\n');
  write('README.md', 'not vendored\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'v1: first');
  first = git('rev-parse', 'HEAD');
  write(sourcesFile, 'export const BUILTIN_SOURCES = [1, 2];\n');
  git('commit', '-q', '-am', 'v1: second source');
  write('README.md', 'docs only, outside the vendored paths\n');
  git('commit', '-q', '-am', 'v1: readme');
  second = git('rev-parse', 'HEAD');
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function freshDest(): string {
  const dest = mkdtempSync(path.join(tmp, 'vendor-'));
  writeFileSync(path.join(dest, 'VENDORED.md'), '# Vendored v1 snapshot\n\n- commit: none\n- Taken: never\n- Paths: …\n');
  snapshot(v1, first, dest, { date: '2026-01-01' });
  return dest;
}

describe('revendor-v1', () => {
  it('snapshot writes only the vendored paths and records the commit', () => {
    const dest = freshDest();
    expect(vendoredCommit(dest)).toBe(first);
    expect(readFileSync(path.join(dest, sourcesFile), 'utf8')).toContain('[1]');
    expect(() => readFileSync(path.join(dest, 'README.md'))).toThrow();
    const note = readFileSync(path.join(dest, 'VENDORED.md'), 'utf8');
    expect(note).toContain(`- Taken: 2026-01-01 with \`git archive ${first.slice(0, 7)}\``);
    expect(note).toContain('- Paths: …'); // the rest of the note is kept
  });

  it('moves to the commit, lists the v1 commits that touch vendored paths, and verifies', () => {
    const dest = freshDest();
    let verified = '';
    const r = revendor({ from: v1, ref: 'HEAD', dest, log: quiet, verify: (d) => ((verified = vendoredCommit(d) ?? ''), { ok: true }) });
    expect(r.ok).toBe(true);
    expect(r.to).toBe(second);
    expect(verified).toBe(second); // verification ran against the NEW snapshot
    expect(vendoredCommit(dest)).toBe(second);
    expect(readFileSync(path.join(dest, sourcesFile), 'utf8')).toContain('[1, 2]');
    expect(r.changes).toHaveLength(1); // the README commit is outside the vendored paths
    expect(r.changes[0]).toContain('v1: second source');
  });

  it('restores the previous snapshot when verification fails', () => {
    const dest = freshDest();
    const r = revendor({ from: v1, ref: second, dest, log: quiet, verify: () => ({ ok: false, step: 'build store' }) });
    expect(r).toMatchObject({ ok: false, failedStep: 'build store', restored: true });
    expect(vendoredCommit(dest)).toBe(first);
    expect(readFileSync(path.join(dest, sourcesFile), 'utf8')).toContain('[1]');
  });

  it('keeps the new snapshot on failure with keep', () => {
    const dest = freshDest();
    const r = revendor({ from: v1, ref: second, dest, keep: true, log: quiet, verify: () => ({ ok: false, step: 'typecheck' }) });
    expect(r).toMatchObject({ ok: false, failedStep: 'typecheck', restored: false });
    expect(vendoredCommit(dest)).toBe(second);
  });

  it('restores the previous snapshot when the verifier throws', () => {
    const dest = freshDest();
    expect(() =>
      revendor({
        from: v1,
        ref: second,
        dest,
        log: quiet,
        verify: () => {
          throw new Error('boom');
        },
      }),
    ).toThrow('boom');
    expect(vendoredCommit(dest)).toBe(first);
  });

  it('does nothing when the commit is already vendored, and rejects unknown refs', () => {
    const dest = freshDest();
    let calls = 0;
    const r = revendor({ from: v1, ref: first.slice(0, 10), dest, log: quiet, verify: () => (calls++, { ok: true }) });
    expect(r).toMatchObject({ ok: true, unchanged: true });
    expect(calls).toBe(0);
    expect(() => revendor({ from: v1, ref: 'no-such-ref', dest, log: quiet, verify: () => ({ ok: true }) })).toThrow(/not a commit/);
    expect(vendoredCommit(dest)).toBe(first);
  });
});
