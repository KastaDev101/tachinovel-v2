/**
 * v2 build (esbuild) → www/ (Capacitor webDir; `npx cap copy ios` puts it in ios/App/App/public/).
 *
 *   www/index.html                     UI: v1 UI + v2 shims, CSS/JS inlined, strict CSP (script hash)
 *   www/core/core.js                   core entry for the native JSContext (IIFE, no imports)
 *   www/core/lib/declarative-host.js   lazy: declarative source engine (both flavors)
 *   www/core/lib/plugin-host.js        lazy: v1 LNReader JS plugin host (personal flavor ONLY)
 *   www/core/app/plugins/*.js          built-in plugins (personal flavor ONLY) + app/manifest.json
 *   www/build-info.json
 *
 * Usage: node tools/build.ts [--flavor=personal|store] [--ads] [--dev]
 *   default flavor: personal. --ads only valid with store. V1_ROOT=../tachinovel to use live v1 code.
 */
import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { phoneClientPlugin, root, v1AliasPlugin, v1PatchPlugin, v1Root, v1Src } from './v1.ts';

export type Flavor = 'personal' | 'store';

export interface BuildOptions {
  flavor: Flavor;
  ads: boolean;
  dev: boolean;
  outDir: string;
}

/** Same targets for UI and core: iOS 17 is the deployment target (ios/App, docs/architecture.md). */
const UI_TARGET = ['es2022', 'safari17'];
const CORE_TARGET = ['es2022', 'safari17'];

const BUDGETS_KB: Record<string, number> = {
  'index.html': 700,
  'core/core.js': 900,
  'core/lib/declarative-host.js': 700,
  'core/lib/plugin-host.js': 1200,
};

export interface BuildInfo {
  version: string;
  hash: string;
  time: string;
  flavor: Flavor;
  ads: boolean;
  v1: { root: string; hash: string };
}

function git(cwd: string, args: string): string {
  try {
    return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

export function buildInfo(opts: BuildOptions): BuildInfo {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
  let hash = git(root, 'rev-parse --short HEAD') || 'nogit';
  if (git(root, 'status --porcelain')) hash += '-dirty';
  const v1 = v1Root();
  let v1Hash = '';
  const vendoredNote = path.join(v1, 'VENDORED.md');
  if (existsSync(vendoredNote)) v1Hash = /commit:\s*([0-9a-f]{7,40})/i.exec(readFileSync(vendoredNote, 'utf8'))?.[1]?.slice(0, 7) ?? 'vendored';
  else v1Hash = git(v1, 'rev-parse --short HEAD') + (git(v1, 'status --porcelain') ? '-dirty' : '');
  return { version: pkg.version, hash, time: new Date().toISOString(), flavor: opts.flavor, ads: opts.ads, v1: { root: path.relative(root, v1) || '.', hash: v1Hash } };
}

function defines(info: BuildInfo, dev: boolean): Record<string, string> {
  return {
    __BUILD_VERSION__: JSON.stringify(info.version),
    __BUILD_HASH__: JSON.stringify(info.hash),
    __BUILD_TIME__: JSON.stringify(info.time),
    __DEV_BUILD__: dev ? 'true' : 'false',
    __FLAVOR__: JSON.stringify(info.flavor),
    __ADS__: info.ads ? 'true' : 'false',
  };
}

function replaceMarker(template: string, marker: string, value: string): string {
  if (!template.includes(marker)) throw new Error(`HTML template is missing ${marker}`);
  return template.replace(marker, () => value);
}

/** UI: v1's index.html template + v2 entry, everything inlined, CSP with the script's hash. */
export async function buildUi(info: BuildInfo, opts: BuildOptions): Promise<string> {
  const template = readFileSync(path.join(v1Src(), 'ui', 'index.html'), 'utf8');
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src', 'ui', 'main.ts')],
    bundle: true,
    write: false,
    outdir: path.join(root, '.cache', 'ui'),
    format: 'iife',
    platform: 'browser',
    target: UI_TARGET,
    minify: !opts.dev,
    legalComments: 'eof',
    define: defines(info, opts.dev),
    loader: { '.svg': 'text', '.png': 'dataurl', '.woff2': 'dataurl' },
    plugins: [v1AliasPlugin(), phoneClientPlugin()],
    jsx: 'automatic',
    jsxImportSource: 'preact',
    logLevel: 'silent',
  });
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  const safeJs = js.replace(/<\/script/gi, '<\\/script');
  const scriptHash = createHash('sha256').update(safeJs, 'utf8').digest('base64');
  // Capacitor's native bridge is injected as a WKUserScript (not subject to page CSP) and talks over
  // WKScriptMessageHandler, so the page needs no connect-src at all: the UI never fetches.
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${scriptHash}'`,
    "style-src 'unsafe-inline'",
    // capacitor://localhost serves local covers (covers/<file>, routed by TachiRouter.swift).
    "img-src 'self' data: blob: https: http: capacitor:",
    'font-src data:',
    "connect-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  let html = replaceMarker(template, '<!--inject:csp-->', `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  html = replaceMarker(html, '<!--inject:css-->', `<style>${css}</style>`);
  html = replaceMarker(html, '<!--inject:js-->', `<script>${safeJs}</script>`);
  return html;
}

/** Core entry: one IIFE for JSContext.evaluateScript. No module syntax may survive. */
export async function buildCore(info: BuildInfo, opts: BuildOptions): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src', 'core', 'main.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    target: CORE_TARGET,
    minify: false,
    keepNames: true,
    legalComments: 'eof',
    define: defines(info, opts.dev),
    plugins: [v1AliasPlugin(), v1PatchPlugin(opts.flavor)],
    logLevel: 'silent',
  });
  const code = result.outputFiles[0]?.text ?? '';
  if (/^\s*(export|import)\s[^(]/m.test(code)) throw new Error('core.js must not contain top-level import/export');
  return `// TachiNovel core ${info.version} (${info.hash}, ${info.flavor}) built ${info.time}. Generated; see src/core.\n${code}`;
}

/** Lazy CommonJS module (loaded through __native.bundle.loadModule). */
export async function buildLazy(entry: string, info: BuildInfo, opts: BuildOptions): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    target: CORE_TARGET,
    minify: !opts.dev,
    keepNames: true,
    legalComments: 'eof',
    define: defines(info, opts.dev),
    plugins: [v1AliasPlugin()],
    logLevel: 'silent',
  });
  return result.outputFiles[0]?.text ?? '';
}

/** Built-in LNReader-format plugins (v1 plugins/*.ts) → CommonJS, libs left as require() (personal only). */
export async function buildBuiltInPlugin(file: string, info: BuildInfo, opts: BuildOptions): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    target: ['es2022'],
    external: ['htmlparser2', 'cheerio', 'dayjs', 'urlencode', '@libs/*', '@/*'],
    define: defines(info, opts.dev),
    logLevel: 'silent',
  });
  return result.outputFiles[0]?.text ?? '';
}

interface SizeRow {
  file: string;
  kb: number;
  budgetKB?: number;
}

export function parseArgs(argv: string[]): BuildOptions {
  const flavorArg = argv.find((a) => a.startsWith('--flavor='))?.slice('--flavor='.length) ?? 'personal';
  if (flavorArg !== 'personal' && flavorArg !== 'store') throw new Error(`Unknown flavor "${flavorArg}"`);
  const ads = argv.includes('--ads');
  if (ads && flavorArg !== 'store') throw new Error('--ads is only valid with --flavor=store');
  const outArg = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  return { flavor: flavorArg, ads, dev: argv.includes('--dev'), outDir: outArg ? path.resolve(root, outArg) : path.join(root, 'www') };
}

export async function buildAll(opts: BuildOptions): Promise<{ info: BuildInfo; sizes: SizeRow[] }> {
  const info = buildInfo(opts);
  const out = opts.outDir;
  rmSync(out, { recursive: true, force: true });
  const sizes: SizeRow[] = [];
  const write = (rel: string, contents: string): void => {
    const abs = path.join(out, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
    sizes.push({ file: rel, kb: Buffer.byteLength(contents) / 1024, ...(BUDGETS_KB[rel] ? { budgetKB: BUDGETS_KB[rel] } : {}) });
  };

  write('index.html', await buildUi(info, opts));
  write('core/core.js', await buildCore(info, opts));
  write('core/lib/declarative-host.js', await buildLazy(path.join(root, 'src', 'core', 'lazy', 'declarative-host.ts'), info, opts));

  if (opts.flavor === 'personal') {
    write('core/lib/plugin-host.js', await buildLazy(path.join(v1Src(), 'script', 'lazy', 'plugin-host.ts'), info, opts));
    const pluginsDir = path.join(v1Root(), 'plugins');
    const names: string[] = [];
    if (existsSync(pluginsDir)) {
      for (const f of readdirSync(pluginsDir).filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts'))) {
        const name = `${path.basename(f, '.ts')}.js`;
        write(`core/app/plugins/${name}`, await buildBuiltInPlugin(path.join(pluginsDir, f), info, opts));
        names.push(`plugins/${name}`);
      }
    }
    write('core/app/manifest.json', JSON.stringify(names, null, 2));
  }

  writeFileSync(path.join(out, 'build-info.json'), JSON.stringify(info, null, 2));
  return { info, sizes };
}

if (import.meta.main) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const { info, sizes } = await buildAll(opts);
    console.log(`TachiNovel v2 ${info.version} (${info.hash}) flavor=${info.flavor} ads=${info.ads} v1=${info.v1.root}@${info.v1.hash}`);
    let over = false;
    for (const s of sizes) {
      const flag = s.budgetKB !== undefined && s.kb > s.budgetKB ? '  OVER BUDGET' : '';
      if (flag) over = true;
      console.log(`${s.kb.toFixed(1).padStart(8)} KB${s.budgetKB ? ` / ${String(s.budgetKB).padStart(5)} KB` : '         '}  www/${s.file}${flag}`);
    }
    if (over) {
      console.error('Size budget exceeded.');
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
