/** The voice mixer's rules (src/ui/native/voice-mix.ts), which mirror HDVoiceCore VoiceMix.swift. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { KokoroVoiceInfo } from '../src/ui/native/narration.ts';
import { blendVoice, cleanMixName, MAX_MIX_NAME, mixPercent, mixProblem, mixShares, suggestedMixName, usableMixes } from '../src/ui/native/voice-mix.ts';

const voices: KokoroVoiceInfo[] = [
  { id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', blurb: '', grade: 'A' },
  { id: 'bf_emma', name: 'Emma', language: 'en-GB', gender: 'female', blurb: '', grade: 'B-' },
  { id: 'am_michael', name: 'Michael', language: 'en-US', gender: 'male', blurb: '', grade: 'C+' },
];

describe('voice mixer rules', () => {
  it('speaks a blend string, or one voice at the ends (as native does)', () => {
    expect(blendVoice('af_heart', 'bf_emma', 35)).toBe('af_heart+bf_emma@35');
    expect(blendVoice('af_heart', 'bf_emma', 34.6)).toBe('af_heart+bf_emma@35');
    expect(blendVoice('af_heart', 'bf_emma', 0)).toBe('af_heart');
    expect(blendVoice('af_heart', 'bf_emma', 100)).toBe('bf_emma');
    expect(blendVoice('af_heart', 'bf_emma', 140)).toBe('bf_emma');
    expect(blendVoice('af_heart', 'af_heart', 50)).toBe('af_heart');
    expect(mixPercent(Number.NaN)).toBe(50);
    expect(mixPercent(-4)).toBe(0);
  });

  it('names: suggested like native, cleaned to one line of 40 characters', () => {
    expect(suggestedMixName(voices, 'af_heart', 'bf_emma', 35)).toBe('Heart + Emma (35 %)');
    expect(mixShares(voices, 'af_heart', 'bf_emma', 35)).toBe('Heart 65 % · Emma 35 %');
    expect(cleanMixName('  Warm\n narrator  ')).toBe('Warm narrator');
    expect(cleanMixName(' \n ')).toBe('');
    expect(cleanMixName('x'.repeat(90))).toHaveLength(MAX_MIX_NAME);
  });

  it('says why a mix cannot be saved', () => {
    expect(mixProblem(voices, 'af_heart', 'bf_emma')).toBeNull();
    expect(mixProblem(voices, 'af_heart', 'af_heart')).toMatch(/different/);
    expect(mixProblem(voices, 'af_heart', 'zz_gone')).toMatch(/Pick two voices/);
  });

  it('shows only well-formed mixes made of voices this build has', () => {
    const good = { id: 'mix_0a1b2c3d', name: 'Duo', a: 'af_heart', b: 'am_michael', percent: 40 };
    expect(
      usableMixes(
        [good, { ...good, id: 'af_heart' }, { ...good, a: 'zz_gone' }, { ...good, name: 7 }, null, 'x', { ...good, percent: '40' }],
        voices,
      ),
    ).toEqual([good]);
    expect(usableMixes(undefined, voices)).toEqual([]);
  });

  it('native uses the same blend string and suggested name', () => {
    const swift = readFileSync(new URL('../ios/App/HDVoice/Sources/HDVoiceCore/VoiceMix.swift', import.meta.url), 'utf8');
    expect(swift).toContain('"\\(a)+\\(b)@\\(percent)"');
    expect(swift).toContain('"\\(na) + \\(nb) (\\(percent) %)"');
    expect(swift).toContain('public static let maxNameLength = 40');
  });
});
