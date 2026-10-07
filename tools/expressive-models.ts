/**
 * Pinned model files for the EXPERIMENTAL expressive voices (docs/expressive-tts.md).
 *
 * These models are big (0.4–1.4 GB each), so the app never bundles them: the hidden Voice Lab downloads
 * one on demand (Wi-Fi, size warning, delete button) and the CI benchmark downloads them per run. Both use
 * the same Swift downloader (ios/App/ExpressiveVoice, ExpressiveCore/ModelDownloader.swift), which fetches
 * exactly the files listed here from Hugging Face at the PINNED revision and checks every file's SHA-256.
 *
 * The lock lives in two forms that must agree (tests/expressive.test.ts):
 *   ios/expressive-models.lock.json                                   reviewable JSON
 *   ios/App/ExpressiveVoice/Sources/ExpressiveCore/PinnedModels.generated.swift   what the Swift code reads
 *
 * Files land where FluidAudio 0.17.5's managers look for them (TtsCacheDirectory/Models/<folder>/<path>),
 * so FluidAudio finds a complete set and never downloads anything itself (ModelHub.offlineMode stays on).
 *
 * Usage:
 *   node tools/expressive-models.ts --update-lock   list the files at each pinned revision, hash them
 *                                                   (LFS files: the published SHA-256; small git files:
 *                                                   downloaded and hashed) and rewrite both lock files
 *   node tools/expressive-models.ts --check         exit 1 if the generated Swift doesn't match the JSON
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
export const LOCK_PATH = path.join(root, 'ios', 'expressive-models.lock.json');
export const SWIFT_PATH = path.join(root, 'ios', 'App', 'ExpressiveVoice', 'Sources', 'ExpressiveCore', 'PinnedModels.generated.swift');

/** FluidAudio version whose loaders these file sets match (ios/App/ExpressiveVoice/Package.swift pins it). */
export const FLUIDAUDIO_VERSION = '0.17.5';

export type EngineId = 'chatterbox-nano' | 'neutts-2e' | 'pocket-tts';

export interface EngineSpec {
  id: EngineId;
  title: string;
  repo: string;
  revision: string;
  /** Folder under FluidAudio's TTS model cache (TtsCacheDirectory/Models/<folder>), = Repo.<x>.folderName. */
  folder: string;
  /** SPDX id or license name of the WEIGHTS. */
  license: string;
  licenseUrl: string;
  /** The model the Core ML conversion was made from. */
  upstream: string;
  /** Offered in the app's Voice Lab (false = CI benchmark only). */
  inApp: boolean;
  include: (repoPath: string) => boolean;
}

const under = (dirs: string[]) => (p: string) => dirs.some((d) => p.startsWith(`${d}/`));

/** Which repo files each engine needs (FluidAudio 0.17.5: ModelNames.ChatterboxNano / NeuTts / PocketTTS). */
export const ENGINES: EngineSpec[] = [
  {
    id: 'chatterbox-nano',
    title: 'Chatterbox Nano',
    repo: 'FluidInference/chatterbox-nano-coreml',
    revision: 'f28421eff8e34bb6d70663ba1e3b1295562c620b',
    folder: 'chatterbox-nano',
    license: 'MIT',
    licenseUrl: 'https://huggingface.co/ResembleAI/chatterbox-nano',
    upstream: 'ResembleAI/chatterbox-nano',
    inApp: true,
    // Standard output capacity (≈9.9 s per call): the T3 pair + FlowMean-N500 + HiFT-T1000, tables, tokenizer.
    include: (p) =>
      under(['T3Nano-Prefill-T512-M1536-fp16.mlmodelc', 'T3Nano-Decode-M1536-fp16-stateful.mlmodelc', 'FlowMean-N500-fp16.mlmodelc', 'HiFT-T1000-fp16.mlmodelc'])(p) ||
      ['tables/tables.safetensors', 'tables/voice-default.safetensors', 'tokenizer/vocab.json', 'tokenizer/merges.txt', 'tokenizer/added_tokens.json'].includes(p),
  },
  {
    id: 'neutts-2e',
    title: 'NeuTTS-2E',
    repo: 'FluidInference/neutts-2e-coreml',
    revision: '1f2fed10b5ec3d2979747b08556daa5861d88bf8',
    folder: 'neutts-2e',
    license: 'NeuTTS Open License v1.0',
    licenseUrl: 'https://huggingface.co/FluidInference/neutts-2e-coreml/blob/1f2fed10b5ec3d2979747b08556daa5861d88bf8/LICENSE',
    upstream: 'neuphonic/neutts-2e',
    inApp: true,
    // The M=2048 LM pair FluidAudio loads, the NeuCodec decoder, tokenizer, the 4 speaker references, LICENSE
    // (the license requires passing a copy on with the weights).
    include: (p) =>
      under(['LM-Prefill-T768-M2048-fp16.mlmodelc', 'LM-Decode-M2048-fp16-stateful.mlmodelc', 'NeuCodec-Decoder-fp16.mlmodelc'])(p) ||
      ['tokenizer.json', 'LICENSE', 'samples/emily.json', 'samples/paul.json', 'samples/sophie.json', 'samples/steven.json'].includes(p),
  },
  {
    id: 'pocket-tts',
    title: 'Pocket TTS',
    repo: 'FluidInference/pocket-tts-coreml',
    revision: '91748676fe3c8b2eb3007b3125253bcd898202c3',
    folder: 'pocket-tts',
    license: 'CC-BY-4.0',
    licenseUrl: 'https://huggingface.co/kyutai/pocket-tts',
    upstream: 'kyutai/pocket-tts',
    inApp: false,
    // English v2.1 pack, `.ane` placement (rank-4 FlowLM on the Neural Engine), voice "alba" only.
    include: (p) =>
      under(['v2.1/english/cond_prefill_ane.mlmodelc', 'v2.1/english/flowlm_step_ane.mlmodelc', 'v2.1/english/flow_decoder_fused.mlmodelc', 'v2.1/english/mimi_decoder.mlmodelc'])(p) ||
      ['bos_emb.bin', 'text_embed_table.bin', 'tokenizer.model', 'bos_before_voice.bin', 'alba.safetensors'].map((f) => `v2.1/english/constants_bin/${f}`).includes(p) ||
      p === 'v2.1/english/manifest.json',
  },
];

export interface LockedFile {
  path: string;
  size: number;
  sha256: string;
}

export interface LockedEngine {
  id: EngineId;
  title: string;
  repo: string;
  revision: string;
  folder: string;
  license: string;
  licenseUrl: string;
  upstream: string;
  inApp: boolean;
  bytes: number;
  files: LockedFile[];
}

export interface ExpressiveLock {
  schemaVersion: 1;
  fluidAudio: string;
  engines: LockedEngine[];
}

export function readLock(file = LOCK_PATH): ExpressiveLock {
  return JSON.parse(readFileSync(file, 'utf8')) as ExpressiveLock;
}

function swiftString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The Swift twin of the lock (PinnedModels.generated.swift). */
export function swiftSource(lock: ExpressiveLock): string {
  const lines = [
    '//',
    '//  PinnedModels.generated.swift — GENERATED by tools/expressive-models.ts from ios/expressive-models.lock.json.',
    '//  Do not edit: run `node tools/expressive-models.ts --update-lock` (tests/expressive.test.ts checks they agree).',
    '//',
    '',
    '// swiftlint:disable line_length file_length',
    'extension PinnedModels {',
    `    public static let fluidAudioVersion = ${swiftString(lock.fluidAudio)}`,
    '',
    '    public static let all: [PinnedEngineModel] = [',
  ];
  for (const e of lock.engines) {
    lines.push('        PinnedEngineModel(');
    lines.push(`            id: ${swiftString(e.id)}, title: ${swiftString(e.title)}, repo: ${swiftString(e.repo)},`);
    lines.push(`            revision: ${swiftString(e.revision)}, folder: ${swiftString(e.folder)},`);
    lines.push(`            license: ${swiftString(e.license)}, licenseURL: ${swiftString(e.licenseUrl)}, upstream: ${swiftString(e.upstream)},`);
    lines.push(`            inApp: ${e.inApp ? 'true' : 'false'},`);
    lines.push('            files: [');
    for (const f of e.files) lines.push(`                PinnedFile(path: ${swiftString(f.path)}, size: ${f.size}, sha256: ${swiftString(f.sha256)}),`);
    lines.push('            ]');
    lines.push('        ),');
  }
  lines.push('    ]', '}', '// swiftlint:enable line_length file_length', '');
  return lines.join('\n');
}

/** Problems with a lock (also run by the unit test). */
export function validateLock(lock: ExpressiveLock): string[] {
  const problems: string[] = [];
  if (lock.schemaVersion !== 1) problems.push(`schemaVersion ${String(lock.schemaVersion)}`);
  if (lock.fluidAudio !== FLUIDAUDIO_VERSION) problems.push(`fluidAudio ${lock.fluidAudio} != ${FLUIDAUDIO_VERSION}`);
  const ids = new Set<string>();
  for (const e of lock.engines) {
    if (ids.has(e.id)) problems.push(`duplicate engine ${e.id}`);
    ids.add(e.id);
    if (!/^[0-9a-f]{40}$/.test(e.revision)) problems.push(`${e.id}: revision is not a commit hash`);
    if (e.files.length === 0) problems.push(`${e.id}: no files`);
    if (/\b(NC|non-?commercial)\b/i.test(e.license)) problems.push(`${e.id}: non-commercial license ${e.license}`);
    let bytes = 0;
    const seen = new Set<string>();
    for (const f of e.files) {
      if (!/^[0-9a-f]{64}$/.test(f.sha256)) problems.push(`${e.id}: ${f.path} has no SHA-256`);
      if (!(f.size > 0)) problems.push(`${e.id}: ${f.path} has size ${f.size}`);
      if (f.path.includes('..') || f.path.startsWith('/')) problems.push(`${e.id}: unsafe path ${f.path}`);
      if (seen.has(f.path)) problems.push(`${e.id}: duplicate ${f.path}`);
      seen.add(f.path);
      bytes += f.size;
    }
    if (bytes !== e.bytes) problems.push(`${e.id}: bytes ${e.bytes} != sum of files ${bytes}`);
  }
  return problems;
}

interface HfEntry {
  type: 'file' | 'directory';
  path: string;
  size?: number;
  oid?: string;
  lfs?: { oid: string; size: number };
}

async function getJson(url: string): Promise<unknown> {
  for (let i = 0; ; i++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (i >= 3) throw new Error(`HTTP ${res.status} for ${url}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
}

/** Every file at the revision (the tree API pages with a Link header; recursive listing). */
async function listFiles(repo: string, revision: string): Promise<HfEntry[]> {
  const out: HfEntry[] = [];
  let url: string | null = `https://huggingface.co/api/models/${repo}/tree/${revision}?recursive=true&expand=false`;
  while (url) {
    const res: Response = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    out.push(...((await res.json()) as HfEntry[]));
    const link: string | null = res.headers.get('link');
    const next: RegExpExecArray | null = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
    url = next?.[1] ?? null;
  }
  return out.filter((e) => e.type === 'file');
}

async function sha256Of(repo: string, revision: string, repoPath: string): Promise<{ sha: string; size: number }> {
  const url = `https://huggingface.co/${repo}/resolve/${revision}/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
  for (let i = 0; ; i++) {
    const res = await fetch(url, { redirect: 'follow' });
    if (res.ok) {
      const data = Buffer.from(await res.arrayBuffer());
      return { sha: createHash('sha256').update(data).digest('hex'), size: data.length };
    }
    if (i >= 3) throw new Error(`HTTP ${res.status} for ${url}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
}

async function updateLock(): Promise<void> {
  const engines: LockedEngine[] = [];
  for (const spec of ENGINES) {
    const info = (await getJson(`https://huggingface.co/api/models/${spec.repo}/revision/${spec.revision}`)) as { sha?: string };
    if (info.sha !== spec.revision) throw new Error(`${spec.repo}: revision ${spec.revision} not found (got ${String(info.sha)})`);
    const entries = (await listFiles(spec.repo, spec.revision)).filter((e) => spec.include(e.path)).sort((a, b) => a.path.localeCompare(b.path));
    const files: LockedFile[] = [];
    for (const e of entries) {
      if (e.lfs) files.push({ path: e.path, size: e.lfs.size, sha256: e.lfs.oid });
      else {
        const { sha, size } = await sha256Of(spec.repo, spec.revision, e.path);
        files.push({ path: e.path, size, sha256: sha });
      }
    }
    const bytes = files.reduce((n, f) => n + f.size, 0);
    console.log(`${spec.id}: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB at ${spec.revision.slice(0, 10)}`);
    const { include: _include, ...rest } = spec;
    engines.push({ ...rest, bytes, files });
  }
  const lock: ExpressiveLock = { schemaVersion: 1, fluidAudio: FLUIDAUDIO_VERSION, engines };
  const problems = validateLock(lock);
  if (problems.length > 0) throw new Error(`lock invalid:\n  ${problems.join('\n  ')}`);
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(SWIFT_PATH, swiftSource(lock));
  console.log(`wrote ${path.relative(root, LOCK_PATH)} and ${path.relative(root, SWIFT_PATH)}`);
}

if (import.meta.main) {
  if (process.argv.includes('--update-lock')) {
    await updateLock();
  } else if (process.argv.includes('--check')) {
    const lock = readLock();
    const problems = validateLock(lock);
    if (readFileSync(SWIFT_PATH, 'utf8') !== swiftSource(lock)) problems.push(`${path.relative(root, SWIFT_PATH)} is out of date: run node tools/expressive-models.ts --update-lock`);
    if (problems.length > 0) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    for (const e of lock.engines) console.log(`${e.id}: ${e.files.length} files, ${(e.bytes / 1e6).toFixed(1)} MB, ${e.license}`);
  } else {
    console.error('usage: node tools/expressive-models.ts --update-lock | --check');
    process.exit(2);
  }
}
