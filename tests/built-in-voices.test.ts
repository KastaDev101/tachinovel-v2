/**
 * The voice files that ship in the app (tools/built-in-voices.ts): the Pocket TTS voices checked with the app's rules
 * (PocketVoice.swift), nothing stray in BuiltInVoices/, and the folder that goes into the app.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILT_IN_VOICES_DIR, checkBuiltInVoices, checkPocketVoice } from '../tools/built-in-voices.ts';

const root = path.resolve(import.meta.dirname, '..');
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('tools/built-in-voices.ts (voice files that ship in the app)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });
  const temp = (): string => (dir = mkdtempSync(path.join(tmpdir(), 'tn-voices-')));

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

  it('reports anything but breaths/ and pocket/ (the removed .tnvoice voices among them)', () => {
    const d = temp();
    writeFileSync(path.join(d, 'narrator.tnvoice'), 'old');
    writeFileSync(path.join(d, 'voices.json'), '{}');
    const { problems } = checkBuiltInVoices(d);
    expect(problems.some((p) => p.startsWith('narrator.tnvoice'))).toBe(true);
    expect(problems.some((p) => p.startsWith('voices.json'))).toBe(true);
    expect(problems.some((p) => p.includes('pocket/ is missing'))).toBe(true);
  });

  it('the folder that ships in the app is valid', () => {
    const { problems } = checkBuiltInVoices(BUILT_IN_VOICES_DIR);
    expect(problems).toEqual([]);
    const pbx = readFileSync(path.join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
    expect(pbx).toContain('path = BuiltInVoices;');
    expect(pbx).toContain('/* BuiltInVoices in Resources */,');
  });
});
