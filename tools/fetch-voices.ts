/**
 * Fetch the bundled Kokoro voice model (pinned, checksummed) into ios/App/App/KokoroModels/.
 *
 * The app ships Kokoro-82M as FluidAudio's 7-stage Core ML chain (fp16 + int8-palettized weights,
 * "ANE" build) plus the English G2P (BART), the Misaki lexicon and the voices we offer. None of it is
 * committed to git (public repo, ~100 MB of binaries): CI and local builds run this script, which
 *
 *   1. downloads every file listed in ios/kokoro-models.lock.json from Hugging Face at the PINNED
 *      revision (https://huggingface.co/<repo>/resolve/<revision>/<path>),
 *   2. checks its SHA-256 against the lock file and FAILS on any mismatch,
 *   3. converts the Kokoro v1.0 voice packs (voices/<name>.json) to FluidAudio's flat fp32
 *      `<name>.bin` layout ([510, 256], row k = JSON key "k+1", same conversion as FluidAudio's
 *      KokoroAneVoicePack.load(fromJSON:)) and checks those bytes against the lock file too,
 *   4. writes the folder Xcode copies into the app bundle (a folder reference in Copy Bundle Resources):
 *        KokoroModels/kokoro-82m-coreml/ANE/…   the chain, vocab.json, <voice>.bin  (KokoroAneManager directory)
 *        KokoroModels/kokoro-82m-coreml/…       G2PEncoder/Decoder.mlmodelc, g2p_vocab.json, us_lexicon_cache.json
 *        KokoroModels/model-info.json           revision + voices (shown in Voice Lab)
 *
 * Downloads are cached in .cache/kokoro/<revision>/ (CI caches that folder keyed by the lock file).
 *
 * Usage:
 *   node tools/fetch-voices.ts                 fetch + verify + install (what CI runs)
 *   node tools/fetch-voices.ts --check         verify an installed folder against the lock file, no network
 *   node tools/fetch-voices.ts --update-lock [--revision=<sha>]
 *                                              maintainers: list the files at a revision, hash them and
 *                                              rewrite the lock file (also self-tests the voice conversion
 *                                              against the published af_heart.bin)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
export const LOCK_PATH = path.join(root, 'ios', 'kokoro-models.lock.json');
export const OUT_DIR = path.join(root, 'ios', 'App', 'App', 'KokoroModels');
const CACHE_ROOT = path.join(root, '.cache', 'kokoro');

/** Voices the app offers (docs/voices.md). af_heart ships pre-converted as ANE/af_heart.bin. */
export const VOICES = ['af_heart', 'af_bella', 'bf_emma', 'am_michael', 'am_fenrir', 'bm_george'] as const;

/** Paths (relative to the HF repo root) that make up the bundle. Directories are expanded recursively. */
const CHAIN_BUNDLES = [
  'ANE/KokoroAlbert.mlmodelc',
  'ANE/KokoroPostAlbert.mlmodelc',
  'ANE/KokoroAlignment.mlmodelc',
  'ANE/KokoroProsody_v2.mlmodelc',
  'ANE/KokoroNoise_v2.mlmodelc',
  'ANE/KokoroVocoder.mlmodelc',
  'ANE/KokoroTail_v2.mlmodelc',
];
const DIRS = [...CHAIN_BUNDLES, 'G2PEncoder.mlmodelc', 'G2PDecoder.mlmodelc'];
const SINGLE_FILES = ['ANE/vocab.json', 'ANE/af_heart.bin', 'ANE/LICENSE', 'g2p_vocab.json', 'us_lexicon_cache.json'];

export interface LockFile {
  repo: string;
  revision: string;
  license: string;
  source: string;
  files: { path: string; size: number; sha256: string }[];
  voices: { name: string; json: string; jsonSha256: string; binSha256: string }[];
}

export const VOICE_ROWS = 510;
export const VOICE_COLS = 256;

/** Kokoro v1.0 voice JSON ({"1": [256 floats], …, "510": [...]}) → flat little-endian fp32 [510, 256]. */
export function voiceJsonToBin(json: string): Buffer {
  const obj = JSON.parse(json) as Record<string, unknown>;
  const out = Buffer.alloc(VOICE_ROWS * VOICE_COLS * 4);
  for (let row = 1; row <= VOICE_ROWS; row++) {
    const values = obj[String(row)];
    if (!Array.isArray(values) || values.length !== VOICE_COLS) throw new Error(`voice JSON row ${row} missing or not ${VOICE_COLS} numbers`);
    for (let c = 0; c < VOICE_COLS; c++) {
      const v = values[c];
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`voice JSON row ${row} col ${c} is not a finite number`);
      out.writeFloatLE(v, ((row - 1) * VOICE_COLS + c) * 4); // Math.fround: same rounding as NSNumber.floatValue
    }
  }
  return out;
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Local (bundle) path of a repo path: everything lives under kokoro-82m-coreml/ like FluidAudio's cache. */
export function bundlePathFor(repoPath: string): string {
  return path.posix.join('kokoro-82m-coreml', repoPath);
}

function readLock(): LockFile {
  return JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as LockFile;
}

function resolveUrl(lock: Pick<LockFile, 'repo' | 'revision'>, repoPath: string): string {
  return `https://huggingface.co/${lock.repo}/resolve/${lock.revision}/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
}

async function download(url: string, attempts = 4): Promise<Buffer> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Cached download with a checksum: returns the verified bytes or throws. */
async function fetchVerified(lock: LockFile, repoPath: string, expectedSha: string): Promise<Buffer> {
  const cached = path.join(CACHE_ROOT, lock.revision, repoPath);
  if (existsSync(cached)) {
    const data = readFileSync(cached);
    if (sha256(data) === expectedSha) return data;
    rmSync(cached, { force: true }); // stale or corrupt cache entry: fetch again
  }
  const data = await download(resolveUrl(lock, repoPath));
  const got = sha256(data);
  if (got !== expectedSha) throw new Error(`SHA-256 mismatch for ${repoPath} at ${lock.revision}: expected ${expectedSha}, got ${got}`);
  mkdirSync(path.dirname(cached), { recursive: true });
  writeFileSync(cached, data);
  return data;
}

const FLEXIBLE_SHAPE = '[FlexibleShapeInformation =';

/** FluidAudio replaces chain bundles without this attribute at load time (a WRITE): bundled ones must have it. */
export function checkChainBundles(dir: string): string[] {
  const problems: string[] = [];
  for (const b of CHAIN_BUNDLES) {
    const mil = path.join(dir, bundlePathFor(b), 'model.mil');
    if (!existsSync(mil)) problems.push(`${b}: model.mil missing`);
    else if (!readFileSync(mil, 'utf8').includes(FLEXIBLE_SHAPE)) problems.push(`${b}: model.mil lacks FlexibleShapeInformation`);
  }
  return problems;
}

async function install(): Promise<void> {
  const lock = readLock();
  const t0 = Date.now();
  const staging = `${OUT_DIR}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  let bytes = 0;
  // Bounded parallelism: HF's CDN is fast, but 60+ parallel requests get throttled.
  const queue = [...lock.files];
  const workers = Array.from({ length: 6 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const data = await fetchVerified(lock, f.path, f.sha256);
      const dest = path.join(staging, bundlePathFor(f.path));
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      bytes += data.length;
    }
  });
  await Promise.all(workers);
  for (const v of lock.voices) {
    const json = await fetchVerified(lock, v.json, v.jsonSha256);
    const bin = voiceJsonToBin(json.toString('utf8'));
    if (sha256(bin) !== v.binSha256) throw new Error(`converted voice ${v.name}.bin does not match the lock file (${sha256(bin)} != ${v.binSha256})`);
    writeFileSync(path.join(staging, bundlePathFor(`ANE/${v.name}.bin`)), bin);
    bytes += bin.length;
  }
  const problems = checkChainBundles(staging);
  if (problems.length > 0) throw new Error(`bundled chain is not usable read-only:\n  ${problems.join('\n  ')}`);
  writeFileSync(
    path.join(staging, 'model-info.json'),
    JSON.stringify({ repo: lock.repo, revision: lock.revision, license: lock.license, voices: [...VOICES], bytes }, null, 2) + '\n',
  );
  rmSync(OUT_DIR, { recursive: true, force: true });
  renameSync(staging, OUT_DIR);
  console.log(`Kokoro model installed in ${path.relative(root, OUT_DIR)}: ${(bytes / 1e6).toFixed(1)} MB, ${lock.files.length + lock.voices.length} files, revision ${lock.revision.slice(0, 10)} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

/** Offline verification of an installed folder (CI runs it after a cache restore, and the build test can too). */
export function verifyInstalled(dir = OUT_DIR, lock: LockFile = readLock()): string[] {
  const problems: string[] = [];
  if (!existsSync(dir)) return [`${path.relative(root, dir)} does not exist: run node tools/fetch-voices.ts`];
  for (const f of lock.files) {
    const p = path.join(dir, bundlePathFor(f.path));
    if (!existsSync(p)) problems.push(`missing ${f.path}`);
    else if (sha256(readFileSync(p)) !== f.sha256) problems.push(`checksum ${f.path}`);
  }
  for (const v of lock.voices) {
    const p = path.join(dir, bundlePathFor(`ANE/${v.name}.bin`));
    if (!existsSync(p)) problems.push(`missing voice ${v.name}.bin`);
    else if (sha256(readFileSync(p)) !== v.binSha256) problems.push(`checksum voice ${v.name}.bin`);
  }
  return [...problems, ...checkChainBundles(dir)];
}

interface HfEntry {
  type: 'file' | 'directory';
  path: string;
  size?: number;
  lfs?: { oid: string; size: number };
}

async function listDir(repo: string, revision: string, dir: string): Promise<HfEntry[]> {
  const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/${revision}/${dir}?recursive=true`);
  if (!res.ok) throw new Error(`HF tree listing failed for ${dir}: HTTP ${res.status}`);
  return ((await res.json()) as HfEntry[]).filter((e) => e.type === 'file');
}

async function updateLock(revisionArg?: string): Promise<void> {
  const repo = 'FluidInference/kokoro-82m-coreml';
  let revision = revisionArg;
  if (!revision) {
    const res = await fetch(`https://huggingface.co/api/models/${repo}/revision/main`);
    revision = ((await res.json()) as { sha: string }).sha;
  }
  const paths: string[] = [...SINGLE_FILES];
  for (const d of DIRS) for (const e of await listDir(repo, revision, d)) paths.push(e.path);
  const base = { repo, revision };
  const files: LockFile['files'] = [];
  for (const p of paths.sort()) {
    const data = await download(resolveUrl(base, p));
    files.push({ path: p, size: data.length, sha256: sha256(data) });
    process.stdout.write('.');
  }
  // Self-test the conversion against the published, pre-converted af_heart.bin.
  const heartBin = await download(resolveUrl(base, 'ANE/af_heart.bin'));
  const heartJson = await download(resolveUrl(base, 'voices/af_heart.json'));
  if (!voiceJsonToBin(heartJson.toString('utf8')).equals(heartBin)) throw new Error('voice conversion does not reproduce ANE/af_heart.bin byte for byte');
  const voices: LockFile['voices'] = [];
  for (const name of VOICES.filter((v) => v !== 'af_heart')) {
    const json = await download(resolveUrl(base, `voices/${name}.json`));
    voices.push({ name, json: `voices/${name}.json`, jsonSha256: sha256(json), binSha256: sha256(voiceJsonToBin(json.toString('utf8'))) });
  }
  const lock: LockFile = {
    repo,
    revision,
    license: 'Apache-2.0 (Kokoro-82M by hexgrad; Core ML conversion by FluidInference, derived from laishere/kokoro-coreml)',
    source: `https://huggingface.co/${repo}/tree/${revision}`,
    files,
    voices,
  };
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');
  const total = files.reduce((a, f) => a + f.size, 0) + voices.length * VOICE_ROWS * VOICE_COLS * 4;
  console.log(`\nwrote ${path.relative(root, LOCK_PATH)}: ${files.length} files + ${voices.length} converted voices, ${(total / 1e6).toFixed(1)} MB at ${revision}`);
}

/** Size of a directory tree in bytes (for the build summary). */
export function treeBytes(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = statSync(p);
    n += s.isDirectory() ? treeBytes(p) : s.size;
  }
  return n;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--update-lock')) {
      await updateLock(args.find((a) => a.startsWith('--revision='))?.slice('--revision='.length));
    } else if (args.includes('--check')) {
      const problems = verifyInstalled();
      if (problems.length > 0) {
        console.error(`Kokoro model folder is not valid:\n  ${problems.slice(0, 20).join('\n  ')}`);
        process.exit(1);
      }
      console.log(`Kokoro model folder ok (${(treeBytes(OUT_DIR) / 1e6).toFixed(1)} MB)`);
    } else {
      await install();
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
