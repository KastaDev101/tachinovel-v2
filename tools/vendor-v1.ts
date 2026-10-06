/**
 * Refresh vendor/v1 from a v1 checkout (default ../tachinovel).
 *   node tools/vendor-v1.ts              committed state (git archive HEAD), reproducible
 *   node tools/vendor-v1.ts --worktree   working tree (includes uncommitted v1 changes)
 * Never writes to the v1 repo. To move to a specific v1 commit AND check that v2's build-time patches
 * still apply (rolling back if not), use tools/revendor-v1.ts.
 */
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './v1.ts';

/** v1 paths copied into vendor/v1 (keep VENDORED.md's "Paths" line in sync). */
export const PATHS = [
  'src/shared',
  'src/script',
  'src/plugin-host',
  'src/ui',
  'src/types',
  'plugins/stonescape.ts',
  'plugins/verified.json',
  // Narration text front-end + timestamp manifest + DOM block walker (portable; used by v2's player).
  'experiments/tts/frontend.ts',
  'experiments/tts/manifest.ts',
  'experiments/tts/player/dom-blocks.ts',
];

export const VENDOR_DIR = path.join(root, 'vendor', 'v1');

export function defaultV1Source(): string {
  return path.resolve(root, process.env.V1_SOURCE ?? '../tachinovel');
}

/** Read-only git in the v1 repo. */
export function v1Git(from: string, args: string[]): string {
  return execFileSync('git', args, { cwd: from, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Full sha of `ref` in the v1 repo; throws a readable error for unknown refs. */
export function resolveCommit(from: string, ref: string): string {
  if (!existsSync(path.join(from, '.git'))) throw new Error(`No v1 git checkout at ${from}`);
  try {
    return v1Git(from, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new Error(`"${ref}" is not a commit in ${from}`);
  }
}

/** The commit recorded in a snapshot's VENDORED.md (null if missing). */
export function vendoredCommit(dest: string): string | null {
  const file = path.join(dest, 'VENDORED.md');
  if (!existsSync(file)) return null;
  return /- commit: ([0-9a-f]{7,40})/.exec(readFileSync(file, 'utf8'))?.[1] ?? null;
}

/**
 * Replace `dest` with v1's PATHS at `commit` (git archive; the v1 repo is only read), keeping
 * VENDORED.md and updating its commit/date lines. `worktree` copies the working tree instead.
 */
export function snapshot(from: string, commit: string, dest: string, opts: { worktree?: boolean; date?: string } = {}): void {
  const notePath = path.join(dest, 'VENDORED.md');
  const note = existsSync(notePath) ? readFileSync(notePath, 'utf8') : '# Vendored v1 snapshot\n\n- commit: unknown\n- Taken: unknown\n';
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  if (opts.worktree) {
    for (const p of PATHS) cpSync(path.join(from, p), path.join(dest, p), { recursive: true });
  } else {
    const target = dest.split(path.sep).join('/');
    // `-c core.autocrlf=false`: git archive applies the v1 repo's autocrlf (true on Windows), which would
    // write CRLF files; v2 is LF-only (.gitattributes). The override is per command; nothing is written to v1.
    execSync(`git -c core.autocrlf=false -c core.eol=lf archive --format=tar ${commit} ${PATHS.join(' ')} | tar -x -C "${target}"`, {
      cwd: from,
      shell: 'bash',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const how = opts.worktree ? 'a working-tree copy (includes uncommitted changes)' : `\`git archive ${commit.slice(0, 7)}\` (committed state only)`;
  writeFileSync(
    notePath,
    note.replace(/- commit: .*/, `- commit: ${commit}${opts.worktree ? ' + working tree' : ''}`).replace(/- Taken: .*/, `- Taken: ${date} with ${how}`),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const from = defaultV1Source();
  const worktree = process.argv.includes('--worktree');
  const commit = resolveCommit(from, 'HEAD');
  snapshot(from, commit, VENDOR_DIR, { worktree });
  console.log(`vendored v1 ${commit.slice(0, 7)}${worktree ? ' (+worktree)' : ''} → ${path.relative(root, VENDOR_DIR)}`);
}
