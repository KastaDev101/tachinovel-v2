/**
 * Typecheck each TS context with its own tsconfig (different globals per context).
 * Uses TypeScript 7's native `tsc` (~6x faster than 6.x here). TS 7.0 has no stable JS API: a tool that
 * needs the compiler API must import `@typescript/typescript6` instead of `typescript` (see
 * CONTRIBUTING.md "Toolchain"). TODO: drop that rule once TypeScript 7.1 ships its stable API.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const CONTEXTS: Record<string, string> = { node: 'tsconfig.json', core: 'src/core/tsconfig.json', ui: 'src/ui/tsconfig.json' };
const wanted = process.argv.slice(2);
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
let failed = false;
for (const name of wanted.length > 0 ? wanted : Object.keys(CONTEXTS)) {
  const config = CONTEXTS[name];
  if (!config) {
    console.error(`Unknown context "${name}"`);
    process.exit(2);
  }
  const r = spawnSync(process.execPath, [tsc, '-p', path.join(root, config), '--pretty'], { cwd: root, stdio: 'inherit' });
  if (r.status === 0) console.log(`ok ${name}`);
  else {
    console.error(`FAIL ${name} (${config})`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
