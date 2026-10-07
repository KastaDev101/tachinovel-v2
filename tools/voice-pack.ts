/**
 * .tnvoice checks on the PC (tools/built-in-voices.ts and tests): the same rules as the app's
 * ios/App/ExpressiveVoice/Sources/ExpressiveCore/VoicePack.swift, which is what protects the phone (that file
 * is unit-tested in Swift). This mirror catches a bad file before it is bundled into the app.
 * Format: docs/voice-import.md.
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const FORMAT = 'tachinovel-voice';
export const FORMAT_VERSION = 1;
export const FILE_EXTENSION = 'tnvoice';
const MIB = 1_048_576;
export const LIMITS = { file: 8 * MIB, manifest: 64 * 1024, conditioning: 2 * MIB, preview: 3 * MIB, entries: 8, header: 64 * 1024, name: 40 };

type DType = 'F16' | 'F32' | 'I32';
export interface TensorSpec {
  dtype: DType;
  shape: number[];
  /** Allowed integer values [low, high). */
  range?: [number, number];
}
export interface EngineSpec {
  engineVersion: number;
  weights: string;
  tensors: Record<string, TensorSpec>;
}

/** VoicePackEngine.all in Swift. */
export const ENGINES: Record<string, EngineSpec> = {
  'chatterbox-nano': {
    engineVersion: 1,
    weights: 't3_nano_v1+s3gen_meanflow',
    tensors: {
      t3_cond_emb: { dtype: 'F16', shape: [1, 376, 768] },
      prompt_token: { dtype: 'I32', shape: [1, 250], range: [0, 6561] },
      prompt_feat: { dtype: 'F16', shape: [1, 500, 80] },
      embedding: { dtype: 'F16', shape: [1, 192] },
    },
  },
};

const PARTS: Record<string, { limit: number; role: string | null }> = {
  'manifest.json': { limit: LIMITS.manifest, role: null },
  'voice.safetensors': { limit: LIMITS.conditioning, role: 'conditioning' },
  'preview.m4a': { limit: LIMITS.preview, role: 'preview' },
};

const DTYPE_SIZE: Record<string, number> = { F16: 2, BF16: 2, I16: 2, U16: 2, F32: 4, I32: 4, U32: 4, F64: 8, I64: 8, U64: 8, U8: 1, I8: 1, BOOL: 1, F8_E4M3: 1, F8_E5M2: 1 };

export interface VoicePack {
  name: string;
  engine: string;
  createdAt: string;
  conditioning: Buffer;
  conditioningSha256: string;
  preview: Buffer | null;
}

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** Like VoicePack.cleanName: control/format characters → space, single spaces, ≤ 40 characters. */
export function cleanName(raw: string): string {
  const spaced = [...raw].map((c) => (/[\p{Cc}\p{Cf}]/u.test(c) ? ' ' : c)).join('');
  const cut = [...spaced.split(/\s+/).filter(Boolean).join(' ')].slice(0, LIMITS.name).join('').trim();
  return cut || 'Imported voice';
}

const fail = (why: string): never => {
  throw new Error(why);
};

interface Entry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  local: number;
  data: number;
}

function zipEntries(b: Buffer): Entry[] {
  if (b.length < 22) fail('not a ZIP file');
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail('not a ZIP file');
  const total = b.readUInt16LE(eocd + 10);
  const cdSize = b.readUInt32LE(eocd + 12);
  const cdOffset = b.readUInt32LE(eocd + 16);
  if (eocd + 22 + b.readUInt16LE(eocd + 20) !== b.length) fail('unexpected bytes at the end');
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail('ZIP64');
  if (b.readUInt16LE(eocd + 4) !== 0 || b.readUInt16LE(eocd + 6) !== 0 || b.readUInt16LE(eocd + 8) !== total) fail('split archive');
  if (total < 1 || total > LIMITS.entries) fail(`${total} entries`);
  if (cdOffset + cdSize > eocd) fail('bad central directory');
  const out: Entry[] = [];
  let p = cdOffset;
  for (let k = 0; k < total; k++) {
    if (p + 46 > cdOffset + cdSize || b.readUInt32LE(p) !== 0x02014b50) fail('bad central directory');
    const nameLength = b.readUInt16LE(p + 28);
    const next = p + 46 + nameLength + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
    if (next > cdOffset + cdSize || nameLength === 0) fail('bad central directory');
    const e: Entry = {
      name: b.subarray(p + 46, p + 46 + nameLength).toString('utf8'),
      flags: b.readUInt16LE(p + 8),
      method: b.readUInt16LE(p + 10),
      crc: b.readUInt32LE(p + 16),
      compressed: b.readUInt32LE(p + 20),
      size: b.readUInt32LE(p + 24),
      local: b.readUInt32LE(p + 42),
      data: 0,
    };
    if (b.readUInt16LE(p + 34) !== 0) fail('split archive');
    if (e.compressed === 0xffffffff || e.size === 0xffffffff || e.local === 0xffffffff) fail('ZIP64');
    const h = e.local;
    if (h + 30 > cdOffset || b.readUInt32LE(h) !== 0x04034b50) fail('bad local header');
    const ln = b.readUInt16LE(h + 26);
    e.data = h + 30 + ln + b.readUInt16LE(h + 28);
    if (ln !== nameLength || e.data > cdOffset || !b.subarray(h + 30, h + 30 + ln).equals(b.subarray(p + 46, p + 46 + nameLength))) fail('local header doesn’t match the directory');
    if (e.data + e.compressed > cdOffset) fail('entry runs past the directory');
    out.push(e);
    p = next;
  }
  if (p !== cdOffset + cdSize) fail('bad central directory');
  const ranges = out.map((e) => [e.local, e.data + e.compressed] as const).sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < ranges.length; i++) if ((ranges[i - 1] as readonly [number, number])[1] > (ranges[i] as readonly [number, number])[0]) fail('overlapping entries');
  return out;
}

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const byte of b) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function extract(e: Entry, b: Buffer, limit: number): Buffer {
  if (e.flags & 0x41) fail('encrypted');
  if (e.size > limit) fail(`${e.name} is too big`);
  const raw = b.subarray(e.data, e.data + e.compressed);
  let out: Buffer;
  if (e.method === 0) {
    if (e.compressed !== e.size) fail('stored entry with two sizes');
    out = Buffer.from(raw);
  } else if (e.method === 8) {
    try {
      out = inflateRawSync(raw, { maxOutputLength: e.size + 1 });
    } catch {
      return fail('compressed data doesn’t match its size');
    }
    if (out.length !== e.size) fail('compressed data doesn’t match its size');
  } else {
    return fail(`compression method ${e.method}`);
  }
  if (crc32(out) !== e.crc) fail(`${e.name} fails its CRC check`);
  return out;
}

/** The safetensors header with the app's bounds checks: tensors → {dtype, shape, begin, end}, payload start. */
export function parseSafetensors(b: Buffer): { tensors: Map<string, { dtype: string; shape: number[]; begin: number; end: number }>; start: number } {
  if (b.length < 8) fail('truncated header');
  const n = b.readBigUInt64LE(0);
  if (n < 2n || n > BigInt(LIMITS.header) || n > BigInt(b.length - 8)) fail('bad header length');
  const start = 8 + Number(n);
  let header: unknown;
  try {
    header = JSON.parse(b.subarray(8, start).toString('utf8'));
  } catch {
    return fail('header is not JSON');
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) fail('header is not a JSON object');
  const payload = b.length - start;
  const tensors = new Map<string, { dtype: string; shape: number[]; begin: number; end: number }>();
  for (const [name, value] of Object.entries(header as Record<string, unknown>)) {
    if (name === '__metadata__') {
      if (!value || typeof value !== 'object' || !Object.values(value).every((v) => typeof v === 'string')) fail('bad metadata');
      continue;
    }
    const v = value as { dtype?: unknown; shape?: unknown; data_offsets?: unknown };
    const ints = (x: unknown): x is number[] => Array.isArray(x) && x.every((d) => Number.isSafeInteger(d) && (d as number) >= 0);
    if (!v || typeof v.dtype !== 'string' || !ints(v.shape) || v.shape.length > 8 || !ints(v.data_offsets) || v.data_offsets.length !== 2) fail(`bad entry “${name}”`);
    const size = DTYPE_SIZE[v.dtype as string] ?? fail(`unknown dtype in “${name}”`);
    const [begin, end] = v.data_offsets as [number, number];
    if (begin > end || end > payload) fail(`${name} points outside the file`);
    const bytes = (v.shape as number[]).reduce((a, d) => a * d, size);
    if (!Number.isSafeInteger(bytes) || bytes !== end - begin) fail(`${name} has the wrong byte length`);
    tensors.set(name, { dtype: v.dtype as string, shape: v.shape as number[], begin, end });
  }
  let cursor = 0;
  for (const t of [...tensors.values()].sort((x, y) => x.begin - y.begin || x.end - y.end)) {
    if (t.begin !== cursor) fail(t.begin < cursor ? 'tensors overlap' : 'gap between tensors');
    cursor = t.end;
  }
  if (cursor !== payload) fail('unexpected bytes after the tensors');
  return { tensors, start };
}

export function validateConditioning(b: Buffer, engine: EngineSpec): void {
  if (b.length > LIMITS.conditioning) fail('voice.safetensors is too big');
  const { tensors, start } = parseSafetensors(b);
  const names = [...tensors.keys()].sort();
  const expected = Object.keys(engine.tensors).sort();
  if (names.join() !== expected.join()) fail(`tensors ${names.join(', ')} instead of ${expected.join(', ')}`);
  for (const [name, spec] of Object.entries(engine.tensors)) {
    const t = tensors.get(name) ?? fail(`tensor “${name}” is missing`);
    if (t.dtype !== spec.dtype || t.shape.join('×') !== spec.shape.join('×')) fail(`${name} is ${t.dtype} ${t.shape.join('×')}, expected ${spec.dtype} ${spec.shape.join('×')}`);
    const raw = b.subarray(start + t.begin, start + t.end);
    if (spec.dtype === 'F16') {
      for (let i = 0; i < raw.length; i += 2) if ((raw.readUInt16LE(i) & 0x7c00) === 0x7c00) fail(`${name} contains NaN or infinity`);
    } else if (spec.dtype === 'F32') {
      for (let i = 0; i < raw.length; i += 4) if ((raw.readUInt32LE(i) & 0x7f800000) === 0x7f800000) fail(`${name} contains NaN or infinity`);
    } else if (spec.range) {
      for (let i = 0; i < raw.length; i += 4) {
        const x = raw.readInt32LE(i);
        if (x < spec.range[0] || x >= spec.range[1]) fail(`${name} has an id outside ${spec.range[0]}..<${spec.range[1]}`);
      }
    }
  }
}

/** A whole .tnvoice with the app's rules; throws an Error saying why not. */
export function readVoicePack(data: Buffer): VoicePack {
  if (data.length > LIMITS.file) fail('file too big');
  const parts = new Map<string, Buffer>();
  for (const e of zipEntries(data)) {
    const allowed = PARTS[e.name] ?? fail(`unexpected entry “${e.name}”`);
    if (parts.has(e.name)) fail(`“${e.name}” twice`);
    parts.set(e.name, extract(e, data, allowed.limit));
  }
  const manifestBytes = parts.get('manifest.json') ?? fail('manifest.json is missing');
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    return fail('manifest is not JSON');
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('manifest is not a JSON object');
  if (m.format !== FORMAT) fail(`format is not “${FORMAT}”`);
  if (typeof m.formatVersion !== 'number' || m.formatVersion !== FORMAT_VERSION) fail(`formatVersion ${String(m.formatVersion)} is not supported`);
  const engineId = typeof m.engine === 'string' ? m.engine : fail('engine is missing');
  const engine = ENGINES[engineId] ?? fail(`unknown engine “${engineId}”`);
  if (m.engineVersion !== engine.engineVersion) fail(`engineVersion ${String(m.engineVersion)}; the app reads ${engine.engineVersion}`);
  const model = m.model && typeof m.model === 'object' ? (m.model as Record<string, unknown>) : {};
  if (model.weights !== engine.weights) fail(`model.weights must be “${engine.weights}”`);
  if (typeof m.name !== 'string' || m.name.length > 200) fail('name is missing');
  if (typeof m.createdAt !== 'string' || m.createdAt.length > 40 || Number.isNaN(Date.parse(m.createdAt))) fail('createdAt is not a date');
  const listed = Array.isArray(m.parts) && m.parts.length >= 1 && m.parts.length <= 2 ? (m.parts as unknown[]) : fail('parts must list 1 or 2 files');
  const seen = new Set<string>();
  for (const item of listed) {
    const part = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const path = typeof part.path === 'string' ? part.path : fail('a part has no path');
    const allowed = PARTS[path];
    if (!allowed?.role) fail(`unexpected entry “${path}”`);
    if (part.role !== allowed?.role) fail(`${path} must have the role “${String(allowed?.role)}”`);
    if (seen.has(path)) fail(`“${path}” twice`);
    seen.add(path);
    const body = parts.get(path) ?? fail(`${path} is missing`);
    if (part.bytes !== body.length) fail(`${path} has the wrong size`);
    if (typeof part.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(part.sha256)) fail(`${path} has no valid sha256`);
    if (sha256(body) !== part.sha256) fail(`${path} doesn’t match its checksum`);
  }
  for (const name of parts.keys()) if (name !== 'manifest.json' && !seen.has(name)) fail(`${name} is not listed`);
  const conditioning = parts.get('voice.safetensors') ?? fail('voice.safetensors is missing');
  validateConditioning(conditioning, engine);
  const preview = parts.get('preview.m4a') ?? null;
  if (preview && preview.subarray(4, 8).toString('latin1') !== 'ftyp') fail('preview.m4a is not an M4A file');
  return { name: cleanName(m.name as string), engine: engineId, createdAt: m.createdAt as string, conditioning, conditioningSha256: sha256(conditioning), preview };
}

/** BundledVoices.id(forFileName:) in Swift: "b" + 16 hex digits of the SHA-256 of the file name. */
export function bundledVoiceId(fileName: string): string {
  return `b${sha256(fileName).slice(0, 16)}`;
}
