/**
 * The PC-side .tnvoice checks (tools/voice-pack.ts, a mirror of the app's VoicePack.swift) and the shipped-voice
 * tool (tools/built-in-voices.ts): synthetic packs (patterns, never a real voice) accepted and refused for the
 * same reasons as on the phone, truncation and byte-flip fuzzing, the spec in step with the Swift one, and the
 * BuiltInVoices folder that goes into the app.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { addVoice, BUILT_IN_VOICES_DIR, checkBuiltInVoices, checkPocketVoice, readIndex, slug, writeIndex } from '../tools/built-in-voices.ts';
import { bundledVoiceId, ENGINES, LIMITS, readVoicePack, sha256, validateConditioning } from '../tools/voice-pack.ts';

const root = path.resolve(import.meta.dirname, '..');
const nano = ENGINES['chatterbox-nano'];
if (!nano) throw new Error('no chatterbox-nano spec');

// ---- builders (the same shapes as the Swift tests) ----

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const byte of b) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface Part {
  name: string;
  data: Buffer;
  deflate?: boolean;
  flags?: number;
  method?: number;
  declaredSize?: number;
}

function zip(parts: Part[], trailing = Buffer.alloc(0)): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const p of parts) {
    const payload = p.deflate ? deflateRawSync(p.data) : p.data;
    const method = p.method ?? (p.deflate ? 8 : 0);
    const name = Buffer.from(p.name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(p.flags ?? 0, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt32LE(crc32(p.data), 14);
    h.writeUInt32LE(payload.length, 18);
    h.writeUInt32LE(p.declaredSize ?? p.data.length, 22);
    h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(p.flags ?? 0, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc32(p.data), 16);
    c.writeUInt32LE(payload.length, 20);
    c.writeUInt32LE(p.declaredSize ?? p.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(h, name, payload);
    central.push(c, name);
    offset += 30 + name.length + payload.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end, trailing]);
}

interface Tensor {
  name: string;
  dtype: string;
  shape: number[];
  data: Buffer;
}

function tensors(): Tensor[] {
  let seed = 12345;
  const f16 = (n: number): Buffer => {
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      b.writeUInt16LE(((seed >>> 16) & 0x8000) | ((12 + (seed % 5)) << 10) | (seed & 0x3ff), i * 2);
    }
    return b;
  };
  const tokens = Buffer.alloc(1000);
  for (let i = 0; i < 250; i++) tokens.writeInt32LE((i * 37) % 6561, i * 4);
  return [
    { name: 'prompt_token', dtype: 'I32', shape: [1, 250], data: tokens },
    { name: 'embedding', dtype: 'F16', shape: [1, 192], data: f16(192) },
    { name: 'prompt_feat', dtype: 'F16', shape: [1, 500, 80], data: f16(40_000) },
    { name: 't3_cond_emb', dtype: 'F16', shape: [1, 376, 768], data: f16(288_768) },
  ];
}

function safetensors(ts: Tensor[], extra = Buffer.alloc(0)): Buffer {
  let off = 0;
  const head: Record<string, unknown> = {};
  for (const t of ts) {
    head[t.name] = { dtype: t.dtype, shape: t.shape, data_offsets: [off, off + t.data.length] };
    off += t.data.length;
  }
  let json = Buffer.from(JSON.stringify(head));
  json = Buffer.concat([json, Buffer.alloc((8 - ((8 + json.length) % 8)) % 8, 0x20)]);
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([len, json, ...ts.map((t) => t.data), extra]);
}

const PREVIEW = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A \0\0\0\0M4A isom', 'latin1')]);

function manifest(parts: [string, string, Buffer][], edit: (m: Record<string, unknown>) => void = () => undefined): Buffer {
  const m: Record<string, unknown> = {
    format: 'tachinovel-voice',
    formatVersion: 1,
    engine: 'chatterbox-nano',
    engineVersion: 1,
    model: { weights: 't3_nano_v1+s3gen_meanflow' },
    name: 'Synthetic Test Voice',
    createdAt: '2026-10-07T08:00:00Z',
    parts: parts.map(([p, role, d]) => ({ path: p, role, bytes: d.length, sha256: sha256(d) })),
  };
  edit(m);
  return Buffer.from(JSON.stringify(m));
}

function pack(opts: { voice?: Buffer; deflate?: boolean; preview?: boolean; edit?: (m: Record<string, unknown>) => void } = {}): Buffer {
  const voice = opts.voice ?? safetensors(tensors());
  const parts: [string, string, Buffer][] = [['voice.safetensors', 'conditioning', voice]];
  if (opts.preview !== false) parts.push(['preview.m4a', 'preview', PREVIEW]);
  return zip([{ name: 'manifest.json', data: manifest(parts, opts.edit), deflate: opts.deflate }, ...parts.map(([name, , data]) => ({ name, data, deflate: opts.deflate }))]);
}

const refuses = (b: Buffer, why: RegExp): void => {
  expect(() => readVoicePack(b)).toThrow(why);
};

describe('tools/voice-pack.ts (the app’s rules on the PC)', () => {
  it('accepts a good pack, stored or deflated, with the built-in voice’s exact size', () => {
    const p = readVoicePack(pack());
    expect(p.engine).toBe('chatterbox-nano');
    expect(p.conditioning.length).toBe(659_232);
    expect(p.preview?.equals(PREVIEW)).toBe(true);
    expect(readVoicePack(pack({ deflate: true, preview: false })).preview).toBeNull();
  });

  it('refuses for the same reasons as the phone', () => {
    refuses(Buffer.from('hello, not a zip'), /not a ZIP file/);
    refuses(Buffer.concat([pack(), Buffer.from([1, 2])]), /unexpected bytes at the end/);
    refuses(zip([{ name: '../voice.safetensors', data: Buffer.from('x') }]), /unexpected entry/);
    refuses(zip([{ name: 'manifest.json', data: Buffer.from('{}') }, { name: 'manifest.json', data: Buffer.from('{}') }]), /twice|overlapping/);
    refuses(zip([{ name: 'manifest.json', data: Buffer.from('{}'), flags: 1 }]), /encrypted/);
    refuses(zip([{ name: 'manifest.json', data: Buffer.from('{}'), method: 12 }]), /compression method 12/);
    refuses(zip([{ name: 'manifest.json', data: Buffer.from('{}'), deflate: true, declaredSize: 50_000_000 }]), /too big/);
    refuses(zip(Array.from({ length: 9 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') }))), /9 entries/);
    refuses(pack({ edit: (m) => (m.formatVersion = 2) }), /formatVersion 2/);
    refuses(pack({ edit: (m) => (m.engine = 'kokoro') }), /unknown engine/);
    refuses(pack({ edit: (m) => (m.engineVersion = 2) }), /engineVersion/);
    refuses(pack({ edit: (m) => (m.model = { weights: 't3_turbo_v1' }) }), /model.weights/);
    refuses(pack({ edit: (m) => (m.createdAt = 'yesterday') }), /createdAt/);
    refuses(pack({ edit: (m) => ((m.parts as Record<string, unknown>[])[0] as Record<string, unknown>).sha256 = '0'.repeat(64) }), /checksum/);
    const ts = tensors();
    refuses(pack({ voice: safetensors(ts.map((t) => (t.name === 'prompt_token' ? { ...t, dtype: 'F32' } : t))) }), /prompt_token is F32/);
    refuses(pack({ voice: safetensors(ts.map((t) => (t.name === 't3_cond_emb' ? { ...t, shape: [1, 768, 376] } : t))) }), /t3_cond_emb is F16 1×768×376/);
    refuses(pack({ voice: safetensors(ts.slice(1)) }), /tensors/);
    refuses(pack({ voice: safetensors(ts, Buffer.from([0, 0])) }), /unexpected bytes after the tensors/);
    const nan = tensors();
    (nan[1] as Tensor).data.writeUInt16LE(0x7e00, 0);
    refuses(pack({ voice: safetensors(nan) }), /NaN/);
    const id = tensors();
    (id[0] as Tensor).data.writeInt32LE(6561, 0);
    refuses(pack({ voice: safetensors(id) }), /outside 0\.\.<6561/);
    refuses(zip([{ name: 'manifest.json', data: manifest([['voice.safetensors', 'conditioning', Buffer.from('x')], ['preview.m4a', 'preview', Buffer.from('nope, not audio')]]) }, { name: 'voice.safetensors', data: Buffer.from('x') }, { name: 'preview.m4a', data: Buffer.from('nope, not audio') }]), /truncated header|M4A/);
  });

  it('never accepts a truncated file or header, and byte flips only ever give a clean error or a valid voice', () => {
    const good = pack({ deflate: true });
    for (let n = 0; n < good.length; n += n < 600 ? 1 : 997) expect(() => readVoicePack(good.subarray(0, n)), `cut at ${n}`).toThrow();
    const voice = safetensors(tensors());
    for (let n = 0; n < 400; n++) expect(() => validateConditioning(voice.subarray(0, n), nano)).toThrow();
    let seed = 2026;
    const rnd = (k: number): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed % k;
    };
    let accepted = 0;
    for (let round = 0; round < 300; round++) {
      const b = Buffer.from(round % 2 ? good : pack());
      for (let k = 0; k <= rnd(4); k++) {
        const i = rnd(3) === 0 ? rnd(b.length) : rnd(2) === 0 ? rnd(Math.min(b.length, 1200)) : b.length - 1 - rnd(300);
        b[i] = (b[i] as number) ^ (1 + rnd(255));
      }
      try {
        const p = readVoicePack(b);
        expect(() => validateConditioning(p.conditioning, nano)).not.toThrow();
        accepted++;
      } catch (err) {
        expect(err, `round ${round}`).toBeInstanceOf(Error);
      }
    }
    expect(accepted).toBeLessThan(150);
  });

  it('is the same spec as the app (VoicePack.swift)', () => {
    const swift = readFileSync(path.join(root, 'ios/App/ExpressiveVoice/Sources/ExpressiveCore/VoicePack.swift'), 'utf8');
    for (const [name, t] of Object.entries(nano.tensors)) {
      const range = t.range ? `, intRange: ${t.range[0]}..<${t.range[1]}` : '';
      expect(swift).toContain(`TensorSpec("${name}", .${t.dtype.toLowerCase()}, [${t.shape.join(', ')}]${range})`);
    }
    expect(swift).toContain(`weights: "${nano.weights}"`);
    expect(swift).toContain(`engineVersion: ${nano.engineVersion},`);
    const limit = (name: string): number => {
      const m = new RegExp(`static let ${name} = (\\d+)(?: \\* (\\d[\\d_]*))?`).exec(swift);
      return m ? Number(m[1]) * Number((m[2] ?? '1').replace(/_/g, '')) : NaN;
    };
    expect(limit('maxFileBytes')).toBe(LIMITS.file);
    expect(limit('maxManifestBytes')).toBe(LIMITS.manifest);
    expect(limit('maxConditioningBytes')).toBe(LIMITS.conditioning);
    expect(limit('maxPreviewBytes')).toBe(LIMITS.preview);
    expect(limit('maxEntries')).toBe(LIMITS.entries);
    expect(limit('maxSafetensorsHeaderBytes')).toBe(LIMITS.header);
    // BundledVoices.id(forFileName:): "b" + 16 hex digits of the SHA-256 of the file name.
    expect(readFileSync(path.join(root, 'ios/App/ExpressiveVoice/Sources/ExpressiveCore/ImportedVoices.swift'), 'utf8')).toContain(
      'public static func id(forFileName name: String) -> String { "b" + String(VoicePack.sha256Hex(Array(name.utf8)).prefix(16)) }',
    );
    expect(bundledVoiceId('narrator.tnvoice')).toBe(`b${sha256('narrator.tnvoice').slice(0, 16)}`);
    expect(bundledVoiceId('narrator.tnvoice')).toMatch(/^b[0-9a-f]{16}$/);
  });
});

describe('tools/built-in-voices.ts (voices that ship in the app)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });
  const temp = (): string => (dir = mkdtempSync(path.join(tmpdir(), 'tn-voices-')));

  it('adds a checked voice under a stable file name and makes it the default', () => {
    const d = temp();
    writeIndex({ schemaVersion: 1, default: null }, d);
    const src = path.join(d, '..', `src-${path.basename(d)}.tnvoice`);
    writeFileSync(src, pack({ edit: (m) => (m.name = 'Warm Narrator') }));
    try {
      const v = addVoice(src, { makeDefault: true }, d);
      expect(v.file).toBe('warm-narrator.tnvoice');
      expect(v.id).toBe(bundledVoiceId('warm-narrator.tnvoice'));
      expect(readIndex(d).default).toBe('warm-narrator.tnvoice');
      // Re-tuned under the same name: same file, same id.
      writeFileSync(src, pack({ deflate: true, edit: (m) => (m.name = 'Warm Narrator') }));
      expect(addVoice(src, { as: 'Warm Narrator' }, d).id).toBe(v.id);
      const { voices, problems } = checkBuiltInVoices(d);
      expect(problems).toEqual([]);
      expect(voices.map((x) => [x.file, x.isDefault])).toEqual([['warm-narrator.tnvoice', true]]);
    } finally {
      rmSync(src, { force: true });
    }
  });

  it('refuses a bad file and reports stray files and a missing default', () => {
    const d = temp();
    const bad = path.join(d, 'bad-src.bin');
    writeFileSync(bad, pack({ edit: (m) => (m.engine = 'kokoro') }));
    expect(() => addVoice(bad, {}, d)).toThrow(/unknown engine/);
    rmSync(bad);
    writeFileSync(path.join(d, 'README.md'), 'no');
    writeIndex({ schemaVersion: 1, default: 'gone.tnvoice' }, d);
    const { problems } = checkBuiltInVoices(d);
    expect(problems.some((p) => p.startsWith('README.md'))).toBe(true);
    expect(problems.some((p) => p.includes('gone.tnvoice'))).toBe(true);
  });

  it('checks the Pocket TTS Narrator voice: shape, size, sha256, finite values, nothing else in its folder', () => {
    const d = path.join(temp(), 'pocket');
    mkdirSync(d);
    const write = (frames: number, floats: Float32Array, sha?: string) => {
      const data = Buffer.from(floats.buffer);
      writeFileSync(path.join(d, 'narrator.pocketvoice'), data);
      const manifest = { schemaVersion: 1, engine: 'pocket-tts', name: 'Narrator', frames, embeddingDim: 1024, bytes: frames * 4096, sha256: sha ?? sha256(data) };
      writeFileSync(path.join(d, 'narrator.json'), JSON.stringify(manifest));
    };
    const good = new Float32Array(2 * 1024).map((_, i) => Math.sin(i) * 0.1);
    write(2, good);
    expect(checkPocketVoice(d)).toEqual([]);
    write(2, good, '0'.repeat(64));
    expect(checkPocketVoice(d).some((p) => p.includes('sha256'))).toBe(true);
    write(3, good);
    expect(checkPocketVoice(d).some((p) => p.includes('float32'))).toBe(true);
    write(126, new Float32Array(126 * 1024));
    expect(checkPocketVoice(d).some((p) => p.includes('frames must be'))).toBe(true);
    const nan = good.slice();
    nan[5] = Number.NaN;
    write(2, nan);
    expect(checkPocketVoice(d).some((p) => p.includes('finite'))).toBe(true);
    write(2, good);
    writeFileSync(path.join(d, 'extra.bin'), 'x');
    expect(checkPocketVoice(d).some((p) => p.startsWith('pocket/extra.bin'))).toBe(true);
  });

  it('names files like the voice', () => {
    expect(slug('Warm Narrator')).toBe('warm-narrator');
    expect(slug('Ünïcode  & Co.')).toBe('unicode-co');
    expect(slug('!!!')).toBe('voice');
  });

  it('the folder that ships in the app is valid', () => {
    const { problems } = checkBuiltInVoices(BUILT_IN_VOICES_DIR);
    expect(problems).toEqual([]);
    const pbx = readFileSync(path.join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
    expect(pbx).toContain('path = BuiltInVoices;');
    expect(pbx).toContain('/* BuiltInVoices in Resources */,');
  });
});
