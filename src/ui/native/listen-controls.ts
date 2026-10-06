/**
 * The Listen player's speed and "Voice volume", and the words for which voice is speaking. Pure (no DOM).
 * Native counterpart: ios/App/HDVoice/Sources/HDVoiceCore/ListenControls.swift (same range, grid and chips).
 */
import type { NarrationState, SpeakingVoice } from './narration.ts';

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2.5;
export const SPEED_STEP = 0.05;
/** The chips next to the speed slider. */
export const SPEED_PRESETS = [0.9, 1, 1.1, 1.25, 1.5, 2] as const;
export const VOLUME_MAX_PERCENT = 150;

/** Into 0.5…2.5, on the 0.05 grid. */
export function snapSpeed(s: number): number {
  if (!Number.isFinite(s)) return 1;
  const c = Math.min(SPEED_MAX, Math.max(SPEED_MIN, s));
  return Math.round(Math.round(c / SPEED_STEP) * SPEED_STEP * 100) / 100;
}

/** The chip a speed matches (highlighted while the slider sits on it). */
export function presetFor(s: number): number | undefined {
  const c = snapSpeed(s);
  return SPEED_PRESETS.find((p) => Math.abs(p - c) < 0.001);
}

export function formatSpeed(s: number): string {
  return `${String(snapSpeed(s))}×`;
}

/** 0…1.5 → 0…150 (whole percent). */
export function volumePercent(v: number): number {
  if (!Number.isFinite(v)) return 100;
  return Math.round(Math.min(VOLUME_MAX_PERCENT, Math.max(0, v * 100)));
}

/** Why the system voice is speaking instead of Kokoro, in a few words ('' when unknown). */
export function fallbackReason(v: Pick<SpeakingVoice, 'fallback' | 'kokoroStatus'>): string {
  switch (v.fallback) {
    case 'modelLoading':
      return 'Kokoro is starting';
    case 'queueDry':
      return 'Kokoro is catching up';
    case 'thermal':
      return 'the iPhone is hot';
    case 'segmentFailed':
      return 'Kokoro had an error';
    case 'disabled':
      return 'Kokoro is off in More › Voices';
    case 'modelUnavailable':
      return v.kokoroStatus ? `Kokoro unavailable: ${v.kokoroStatus}` : 'Kokoro unavailable';
    case undefined:
      return '';
  }
}

/** Which voice is speaking: "Kokoro · Heart", or "System voice (fallback) · <reason>". */
export function voiceLabel(s: Pick<NarrationState, 'engine' | 'voice' | 'status'>): string {
  if (s.engine === 'audio') return 'PC audio';
  const v = s.voice;
  if (!v) return 'Kokoro';
  if (v.source === 'apple') {
    const why = fallbackReason(v);
    return `System voice (fallback)${why ? ` · ${why}` : ''}`;
  }
  return `Kokoro · ${v.kokoroName}`;
}
