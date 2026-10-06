/**
 * Move vendor/v1 to a v1 commit and prove v2 still builds on it, in one command:
 *
 *   node tools/revendor-v1.ts <commit|ref> [--from=../tachinovel] [--keep] [--skip-tests] [--force]
 *
 *  1. Resolve the commit in the v1 repo (read-only) and list the v1 commits that touch the vendored paths
 *     since the currently vendored one.
 *  2. Snapshot it into vendor/v1 (git archive of tools/vendor-v1.ts PATHS); the old snapshot is kept aside.
 *  3. Re-apply and check v2's adjustments: typecheck (v2 against v1's contracts), then build BOTH flavors
 *     into a temp dir: the build-time patches in tools/v1.ts must each match exactly once, so a v1 change
 *     that moves a patched line fails here instead of shipping unpatched. Then the unit tests.
 *  4. On failure the previous snapshot is restored, unless --keep (keep the new one and fix v2 against it).
 *
 * vendor/v1 is never edited by hand; v1 bugs are reported upstream, not patched here.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root } from './v1.ts';
import { defaultV1Source, PATHS, resolveCommit, snapshot, v1Git, VENDOR_DIR, vendoredCommit } from './vendor-v1.ts';

export interface VerifyResult {
  ok: boolean;
  /** Failed step, e.g. "build store". */
  step?: string;
}

export interface RevendorOptions {
  from: string;
  ref: string;
  dest: string;
  verify: (dest: string) => VerifyResult;
  /** Keep the new snapshot even if verification fails. */
  keep?: boolean;
  /** Re-snapshot and verify even when the commit is already vendored. */
  force?: boolean;
  log?: (line: string) => void;
}

export interface RevendorResult {
  ok: boolean;
  from: string | null;
  to: string;
  /** `git log --oneline` of v1 commits touching the vendored paths (old..new). */
  changes: string[];
  unchanged?: boolean;
  failedStep?: string;
  restored?: boolean;
}

/** v1 commits between the vendored one and `to` that touch the vendored paths (empty if unknown). */
export function changesSince(from: string, old: string | null, to: string): string[] {
  if (!old) return [];
  try {
    const out = v1Git(from, ['log', '--oneline', '--no-decorate', `${old}..${to}`, '--', ...PATHS]);
    return out ? out.split('\n') : [];
  } catch {
    return []; // old commit not in this repo (e.g. history rewritten)
  }
}

export function revendor(o: RevendorOptions): RevendorResult {
  const log = o.log ?? ((l: string) => console.log(l));
  const to = resolveCommit(o.from, o.ref);
  const old = vendoredCommit(o.dest);
  const changes = changesSince(o.from, old, to);
  if (old && to.startsWith(old) && !o.force) {
    log(`vendor/v1 is already at ${to.slice(0, 7)}; nothing to do (--force to re-verify)`);
    return { ok: true, from: old, to, changes, unchanged: true };
  }
  log(`v1 ${old ? old.slice(0, 7) : '(unknown)'} → ${to.slice(0, 7)}: ${changes.length} commit(s) touch the vendored paths`);
  for (const c of changes) log(`  ${c}`);

  const backup = mkdtempSync(path.join(os.tmpdir(), 'v1-vendor-backup-'));
  const hadPrevious = existsSync(o.dest);
  if (hadPrevious) cpSync(o.dest, backup, { recursive: true });
  try {
    snapshot(o.from, to, o.dest);
    const v = o.verify(o.dest);
    if (v.ok) return { ok: true, from: old, to, changes };
    if (o.keep) {
      log(`verification failed at "${v.step}"; keeping the new snapshot (--keep)`);
      return { ok: false, from: old, to, changes, ...(v.step ? { failedStep: v.step } : {}), restored: false };
    }
    rmSync(o.dest, { recursive: true, force: true });
    if (hadPrevious) cpSync(backup, o.dest, { recursive: true });
    log(`verification failed at "${v.step}"; restored the previous snapshot (${old?.slice(0, 7) ?? 'none'})`);
    return { ok: false, from: old, to, changes, ...(v.step ? { failedStep: v.step } : {}), restored: true };
  } catch (e) {
    // Snapshot or verifier crashed: never leave a half-written vendor dir behind.
    rmSync(o.dest, { recursive: true, force: true });
    if (hadPrevious) cpSync(backup, o.dest, { recursive: true });
    throw e;
  } finally {
    rmSync(backup, { recursive: true, force: true });
  }
}

/** The real checks, run in this repo against vendor/v1. */
export function verifyRepo(opts: { skipTests?: boolean } = {}): VerifyResult {
  const out = mkdtempSync(path.join(os.tmpdir(), 'v1-revendor-build-'));
  const steps: [string, string, string[]][] = [
    ['typecheck', process.execPath, ['tools/typecheck.ts']],
    ['build personal', process.execPath, ['tools/build.ts', '--flavor=personal', `--out=${path.join(out, 'personal')}`]],
    ['build store', process.execPath, ['tools/build.ts', '--flavor=store', `--out=${path.join(out, 'store')}`]],
  ];
  if (!opts.skipTests) steps.push(['unit tests', process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vitest', 'run']]);
  try {
    for (const [step, cmd, args] of steps) {
      console.log(`\n== ${step}`);
      const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && cmd.endsWith('.cmd') });
      if (r.status !== 0) return { ok: false, step };
    }
    return { ok: true };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const ref = args.find((a) => !a.startsWith('--'));
  if (!ref) {
    console.error('usage: node tools/revendor-v1.ts <commit|ref> [--from=../tachinovel] [--keep] [--skip-tests] [--force]');
    process.exit(2);
  }
  const fromArg = args.find((a) => a.startsWith('--from='))?.slice('--from='.length);
  const result = revendor({
    from: fromArg ? path.resolve(root, fromArg) : defaultV1Source(),
    ref,
    dest: VENDOR_DIR,
    keep: args.includes('--keep'),
    force: args.includes('--force'),
    verify: () => verifyRepo({ skipTests: args.includes('--skip-tests') }),
  });
  if (result.unchanged) process.exit(0);
  if (result.ok) {
    const checked = args.includes('--skip-tests') ? 'typecheck and both flavors pass (tests skipped)' : 'typecheck, both flavors and tests pass';
    console.log(`\nvendor/v1 is now v1 ${result.to.slice(0, 7)}; ${checked}.`);
    console.log('Next: review `git diff --stat vendor/v1`, then branch, commit and open a PR (CONTRIBUTING.md).');
  } else {
    console.error(`\nrevendor to ${result.to.slice(0, 7)} failed at "${result.failedStep}".`);
    console.error(result.restored ? 'vendor/v1 was restored. Re-run with --keep to fix v2 against the new snapshot.' : 'The new snapshot was kept (--keep).');
    console.error('A broken build-time patch means tools/v1.ts needs updating; a v1 bug goes to the v1 coordinator.');
    process.exit(1);
  }
}
