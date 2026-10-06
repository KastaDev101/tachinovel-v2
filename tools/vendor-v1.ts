/**
 * Refresh vendor/v1 from a v1 checkout (default ../tachinovel).
 *   node tools/vendor-v1.ts              committed state (git archive HEAD), reproducible
 *   node tools/vendor-v1.ts --worktree   working tree (includes uncommitted v1 changes)
 * Never writes to the v1 repo.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './v1.ts';

const PATHS = [
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
const from = path.resolve(root, process.env.V1_SOURCE ?? '../tachinovel');
const dest = path.join(root, 'vendor', 'v1');
const worktree = process.argv.includes('--worktree');

if (!existsSync(path.join(from, '.git'))) throw new Error(`No v1 git checkout at ${from}`);
const note = readFileSync(path.join(dest, 'VENDORED.md'), 'utf8');
const commit = execSync('git rev-parse HEAD', { cwd: from }).toString().trim();
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
if (worktree) {
  for (const p of PATHS) cpSync(path.join(from, p), path.join(dest, p), { recursive: true });
} else {
  execSync(`git archive --format=tar HEAD ${PATHS.join(' ')} | tar -x -C "${dest.split(path.sep).join('/')}"`, { cwd: from, shell: 'bash' });
}
const taken = `- Taken: ${new Date().toISOString().slice(0, 10)} with ${worktree ? 'a working-tree copy (includes uncommitted changes)' : '`git archive HEAD` (committed state only)'}`;
writeFileSync(
  path.join(dest, 'VENDORED.md'),
  note.replace(/- commit: .*/, `- commit: ${commit}${worktree ? ' + working tree' : ''}`).replace(/- Taken: .*/, taken),
);
console.log(`vendored v1 ${commit.slice(0, 7)}${worktree ? ' (+worktree)' : ''} → ${path.relative(root, dest)}`);
