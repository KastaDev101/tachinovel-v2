/** The Listen player's speed and "Voice volume", and which voice the UI says is speaking (src/ui/native/listen-controls.ts). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fallbackReason, formatSpeed, presetFor, snapSpeed, SPEED_MAX, SPEED_MIN, SPEED_PRESETS, voiceLabel, volumePercent } from '../src/ui/native/listen-controls.ts';

const root = path.resolve(import.meta.dirname, '..');

describe('speed', () => {
  it('snaps to the 0.05 grid inside 0.5–2.5', () => {
    expect(snapSpeed(1.12)).toBe(1.1);
    expect(snapSpeed(1.13)).toBe(1.15);
    expect(snapSpeed(0.1)).toBe(SPEED_MIN);
    expect(snapSpeed(9)).toBe(SPEED_MAX);
    expect(snapSpeed(Number.NaN)).toBe(1);
    expect(formatSpeed(1.25)).toBe('1.25×');
    expect(formatSpeed(2)).toBe('2×');
  });

  it('a chip lights up only when the slider sits on it', () => {
    expect(presetFor(1.25)).toBe(1.25);
    expect(presetFor(1.26)).toBe(1.25);
    expect(presetFor(1.35)).toBeUndefined();
    for (const p of SPEED_PRESETS) expect(snapSpeed(p)).toBe(p);
  });

  it('matches the native presets and range (HDVoiceCore ListenControls.swift)', () => {
    const swift = readFileSync(path.join(root, 'ios', 'App', 'HDVoice', 'Sources', 'HDVoiceCore', 'ListenControls.swift'), 'utf8');
    const presets = /presets: \[Double\] = \[([^\]]+)\]/.exec(swift)?.[1]?.split(',').map((x) => Number(x.trim()));
    expect(presets).toEqual([...SPEED_PRESETS]);
    expect(swift).toContain(`range: ClosedRange<Double> = ${String(SPEED_MIN)}...${String(SPEED_MAX)}`);
  });
});

describe('voice volume', () => {
  it('0–150 %', () => {
    expect(volumePercent(1)).toBe(100);
    expect(volumePercent(1.3)).toBe(130);
    expect(volumePercent(9)).toBe(150);
    expect(volumePercent(-1)).toBe(0);
    expect(volumePercent(Number.NaN)).toBe(100);
  });
});

describe('which voice is speaking', () => {
  const kokoro = { kokoroVoice: 'af_heart', kokoroName: 'Heart' };

  it('Kokoro by name; the system voice as a fallback with the reason', () => {
    expect(voiceLabel({ status: 'playing', engine: 'speech', voice: { ...kokoro, source: 'kokoro' } })).toBe('Kokoro · Heart');
    expect(voiceLabel({ status: 'loading', engine: 'speech', voice: kokoro })).toBe('Kokoro · Heart');
    expect(voiceLabel({ status: 'playing', engine: 'speech', voice: { ...kokoro, source: 'apple', fallback: 'queueDry' } })).toBe('System voice (fallback) · Kokoro is catching up');
    expect(voiceLabel({ status: 'playing', engine: 'speech', voice: { ...kokoro, source: 'apple' } })).toBe('System voice (fallback)');
    expect(voiceLabel({ status: 'playing', engine: 'audio' })).toBe('PC audio');
    // The expressive voice that read the sentence (Nephis, the Narrator), never Kokoro's name for it.
    expect(voiceLabel({ status: 'playing', engine: 'speech', voice: { ...kokoro, source: 'kokoro', reader: 'Nephis' } })).toBe('Nephis');
    expect(voiceLabel({ status: 'playing', engine: 'speech', voice: { ...kokoro, source: 'apple', reader: 'Nephis' } })).toBe('System voice (fallback)');
  });

  it('every fallback reason has words', () => {
    const reasons = ['modelLoading', 'modelUnavailable', 'queueDry', 'thermal', 'segmentFailed', 'disabled'] as const;
    for (const r of reasons) expect(fallbackReason({ fallback: r }), r).not.toBe('');
    expect(fallbackReason({ fallback: 'modelUnavailable', kokoroStatus: 'Turned off after crashing twice' })).toBe('Kokoro unavailable: Turned off after crashing twice');
    expect(fallbackReason({ fallback: 'disabled' })).toBe('Kokoro is off in More › Voices');
  });
});
