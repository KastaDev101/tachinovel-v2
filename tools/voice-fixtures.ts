/**
 * Write the CI voice-check fixtures (tools/voice-fixtures-lib.ts) as JSON for kokoro-check.
 * The library imports v1's front-end through the @v1tts alias, so it is bundled with the build's
 * resolver first (esbuild + tools/v1.ts), then run.
 *
 * Usage: node tools/voice-fixtures.ts [out.json]   (default .cache/voice-fixtures.json)
 */
import * as esbuild from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, v1AliasPlugin } from './v1.ts';
import type * as FixturesLib from './voice-fixtures-lib.ts';

const out = path.resolve(process.argv[2] ?? path.join(root, '.cache', 'voice-fixtures.json'));
const lib = path.join(root, '.cache', 'voice-fixtures-lib.mjs');
mkdirSync(path.dirname(lib), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'tools', 'voice-fixtures-lib.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: lib,
  plugins: [v1AliasPlugin()],
  logLevel: 'silent',
});
const { buildFixtures } = (await import(pathToFileURL(lib).href)) as typeof FixturesLib;
const sentences = buildFixtures();
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ sentences }, null, 2) + '\n');
for (const s of sentences) console.log(`${s.id.padEnd(9)} ${s.runs ? '[runs] ' : ''}${s.text}`);
console.log(`wrote ${path.relative(root, out)}`);
