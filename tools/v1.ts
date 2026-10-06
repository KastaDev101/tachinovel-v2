/**
 * Where v1 code comes from, and the (few, asserted) build-time adjustments v2 makes to it.
 *
 * Source of v1:
 *   - default: vendor/v1 (snapshot committed in this repo; see vendor/v1/VENDORED.md). Reproducible,
 *     and what CI uses.
 *   - V1_ROOT=<path> (e.g. ../tachinovel): build against a live v1 checkout, to pick up v1 work
 *     without re-vendoring. Typecheck always uses vendor/v1.
 *
 * Adjustments (esbuild plugins; v1 files are never edited):
 *   1. v1-phone-client: v1's UI bridge transport (src/ui/bridge/phone-client.ts) → src/ui/capacitor-client.ts.
 *   2. v1-store-defaults (store flavor only): no built-in Stonescape source, no pre-seeded LNReader
 *      repo, no bundled LNReader plugin verification table. Each replacement must match exactly once, or the build fails (so a v1 change can't
 *      silently re-enable them). Requested upstream as a ServicesOptions field (docs/roadmap.md).
 */
import type * as esbuild from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');

export function v1Root(): string {
  const env = process.env.V1_ROOT;
  const dir = env ? path.resolve(root, env) : path.join(root, 'vendor', 'v1');
  if (!existsSync(path.join(dir, 'src', 'script', 'app.ts'))) throw new Error(`v1 sources not found at ${dir} (set V1_ROOT or run npm run vendor:v1)`);
  return dir;
}

export function v1Src(): string {
  return path.join(v1Root(), 'src');
}

/** Resolve `@v1/...` imports to the chosen v1 checkout. */
export function v1AliasPlugin(): esbuild.Plugin {
  const src = v1Src();
  return {
    name: 'v1-alias',
    setup(b) {
      b.onResolve({ filter: /^@v1\// }, (a) => ({ path: path.join(src, a.path.slice('@v1/'.length)) }));
    },
  };
}

export function phoneClientPlugin(): esbuild.Plugin {
  const v1Bridge = path.join(v1Src(), 'ui', 'bridge');
  const replacement = path.join(root, 'src', 'ui', 'capacitor-client.ts');
  return {
    name: 'v1-phone-client',
    setup(b) {
      b.onResolve({ filter: /(^|\/)phone-client\.ts$/ }, (a) => {
        if (path.resolve(a.resolveDir) !== path.resolve(v1Bridge)) return undefined;
        return { path: replacement };
      });
    },
  };
}

interface Patch {
  file: string;
  find: RegExp;
  replace: string;
  why: string;
}

export const STORE_PATCHES: Patch[] = [
  {
    file: 'script/services/sources.ts',
    find: /export const BUILTIN_SOURCES:([^=]+)= \[\n[\s\S]*?\n\];/,
    replace: 'export const BUILTIN_SOURCES:$1= [];',
    why: 'store flavor ships no built-in sources',
  },
  {
    file: 'script/services/sources.ts',
    find: /const DEFAULT_REPOS:([^=]+)= \[[^\]]*\];/,
    replace: 'const DEFAULT_REPOS:$1= [];',
    why: 'store flavor pre-configures no plugin repository',
  },
  {
    file: 'script/services/verified.ts',
    find: /import \{ plugins \} from '\.\.\/\.\.\/\.\.\/plugins\/verified\.json';/,
    replace: 'const plugins: Record<string, { version?: unknown; status?: unknown }> = {};',
    why: 'store flavor bundles no LNReader plugin verification table',
  },
];

/** Applies flavor patches to v1 files; throws unless every patch matched exactly once. */
export function v1PatchPlugin(flavor: 'personal' | 'store'): esbuild.Plugin {
  const patches = flavor === 'store' ? STORE_PATCHES : [];
  const src = v1Src();
  const applied = new Set<Patch>();
  return {
    name: 'v1-patches',
    setup(b) {
      if (patches.length === 0) return;
      const files = new Set(patches.map((p) => path.join(src, p.file)));
      b.onLoad({ filter: /\.ts$/ }, (a) => {
        if (!files.has(path.resolve(a.path))) return undefined;
        let text = readFileSync(a.path, 'utf8').replace(/\r\n/g, '\n');
        for (const p of patches) {
          if (path.join(src, p.file) !== path.resolve(a.path)) continue;
          const matches = text.match(new RegExp(p.find.source, p.find.flags.includes('g') ? p.find.flags : `${p.find.flags}g`));
          if (!matches || matches.length !== 1) throw new Error(`v1 patch "${p.why}" matched ${matches?.length ?? 0} times in ${p.file}; update tools/v1.ts`);
          text = text.replace(p.find, p.replace);
          applied.add(p);
        }
        return { contents: text, loader: 'ts' };
      });
      b.onEnd((result) => {
        if (result.errors.length > 0) return;
        const missing = patches.filter((p) => !applied.has(p));
        if (missing.length > 0) throw new Error(`v1 patches not applied (file not in bundle?): ${missing.map((p) => p.why).join('; ')}`);
      });
    },
  };
}
