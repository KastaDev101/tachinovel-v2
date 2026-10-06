/**
 * Typecheck each TS context with its own tsconfig (different globals per context).
 *
 * TypeScript runs side by side (https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/,
 * "Running side-by-side with TypeScript 6.0"):
 *   - `@typescript/native` = TypeScript 7 (native compiler, ~6x faster here): this script, `npx tsc`;
 *   - `typescript` = `@typescript/typescript6` (TS 6 API, `tsc6`): for tools that need the compiler
 *     API, i.e. typescript-eslint and Capacitor's CLI. TS 7.0 has no stable API.
 * TODO: when TypeScript 7.1 ships its stable API and typescript-eslint supports it, drop the TS 6 alias
 * (package.json "typescript") and point everything at TypeScript 7.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const CONTEXTS: Record<string, string> = { node: 'tsconfig.json', core: 'src/core/tsconfig.json', ui: 'src/ui/tsconfig.json' };
const wanted = process.argv.slice(2);
const tsc = path.join(root, 'node_modules', '@typescript', 'native', 'bin', 'tsc');
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
