/**
 * Builds a signed web update from a personal-flavor web build (src/core/ota/ota.ts):
 *
 *   OTA_SIGNING_KEY=<PKCS#8 PEM> node tools/ota-pack.ts --www=www --version=<package version> --build=<n>
 *       --base-url=https://github.com/<repo>/releases/download/ota [--notes=<file>] --out=<folder>
 *
 * Writes <out>/web-<build>.json (the pack: every www/ file as UTF-8 text) and <out>/manifest.json
 * (id, version, build, builtAt and flavor from www/build-info.json, NATIVE_LEVEL, the pack's URL,
 * SHA-256 and size, signed with Ed25519 over the canonical JSON). The release workflow uploads both to
 * the rolling release "ota".
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NATIVE_LEVEL } from '../src/core/ota/native-level.ts';
import { canonicalJson, type Manifest, MANIFEST_FORMAT, PACK_FORMAT } from '../src/core/ota/ota.ts';

export function packWww(www: string): { text: string; files: number } {
  const files: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else files[r] = readFileSync(abs, 'utf8');
    }
  };
  walk(www, '');
  if (!files['index.html'] || !files['core/core.js']) throw new Error(`${www} is not a web build (index.html, core/core.js)`);
  return { text: JSON.stringify({ format: PACK_FORMAT, files }), files: Object.keys(files).length };
}

export function signManifest(unsigned: Omit<Manifest, 'signature'>, privateKeyPem: string): Manifest {
  const key = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), key).toString('base64');
  return { ...unsigned, signature };
}

export function buildUpdate(opts: { www: string; version: string; build: string; baseUrl: string; notes?: string; privateKeyPem: string }): { manifest: Manifest; pack: string; packName: string } {
  const info = JSON.parse(readFileSync(path.join(opts.www, 'build-info.json'), 'utf8')) as { time: string; flavor: 'personal' | 'store' };
  if (info.flavor !== 'personal') throw new Error('web updates are for the personal flavor only');
  const { text } = packWww(opts.www);
  const packName = `web-${opts.build}.json`;
  const id = `${opts.version}_${opts.build}`.replace(/[^A-Za-z0-9._-]/g, '-');
  const unsigned: Omit<Manifest, 'signature'> = {
    format: MANIFEST_FORMAT,
    id,
    version: opts.version,
    build: opts.build,
    builtAt: info.time,
    flavor: info.flavor,
    nativeLevel: NATIVE_LEVEL,
    pack: {
      url: `${opts.baseUrl.replace(/\/$/, '')}/${packName}`,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      size: Buffer.byteLength(text, 'utf8'),
    },
    ...(opts.notes ? { notes: opts.notes.slice(0, 2000) } : {}),
  };
  return { manifest: signManifest(unsigned, opts.privateKeyPem), pack: text, packName };
}

if (import.meta.main) {
  const arg = (n: string): string | undefined => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const need = (n: string): string => {
    const v = arg(n);
    if (!v) throw new Error(`--${n}= is required`);
    return v;
  };
  const key = process.env.OTA_SIGNING_KEY;
  if (!key) {
    console.log('OTA_SIGNING_KEY is not set: no web update built (see tools/ota-keygen.ts).');
    process.exit(0);
  }
  const notesFile = arg('notes');
  const { manifest, pack, packName } = buildUpdate({
    www: need('www'),
    version: need('version'),
    build: need('build'),
    baseUrl: need('base-url'),
    ...(notesFile ? { notes: readFileSync(notesFile, 'utf8') } : {}),
    privateKeyPem: key,
  });
  const out = need('out');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, packName), pack);
  writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`web update ${manifest.id}: ${manifest.pack.size} bytes, sha256 ${manifest.pack.sha256.slice(0, 12)}…, native level ${manifest.nativeLevel}`);
}
