/** Typecheck each TS context with its own tsconfig (different globals per context). */
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
