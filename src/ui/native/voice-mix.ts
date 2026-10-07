/**
 * The voice mixer's rules, shared by the UI and its tests (pure, no DOM). They mirror HDVoiceCore
 * VoiceMix.swift: a mix is two different built-in voices and the weight of the second in whole percent;
 * the engine speaks it as the blend string "<a>+<b>@<percent>" (or as one voice when the slider sits at
 * an end). Native validates again on save; these keep the screen honest before that.
 */
import type { CustomVoiceInfo, KokoroVoiceInfo } from './narration.ts';

export const MAX_MIX_NAME = 40;
export const MAX_MIXES = 50;

/** A slider value → whole percent 0–100 (bad input → 50). */
export function mixPercent(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** What the engine speaks for this blend: one voice at the ends, else "<a>+<b>@<percent>". */
export function blendVoice(a: string, b: string, percent: number): string {
  const p = mixPercent(percent);
  if (p <= 0 || a === b) return a;
  if (p >= 100) return b;
  return `${a}+${b}@${String(p)}`;
}

/** Trimmed, one line, at most 40 characters; '' when nothing is left. */
export function cleanMixName(raw: string): string {
  return raw.replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, MAX_MIX_NAME);
}

function nameOf(voices: readonly KokoroVoiceInfo[], id: string): string {
  return voices.find((v) => v.id === id)?.name ?? id;
}

/** "Heart + Emma (35 %)": a new mix's name until the user types one (same as native). */
export function suggestedMixName(voices: readonly KokoroVoiceInfo[], a: string, b: string, percent: number): string {
  return `${nameOf(voices, a)} + ${nameOf(voices, b)} (${String(mixPercent(percent))} %)`;
}

/** "Heart 65 % · Emma 35 %": how much of each voice. */
export function mixShares(voices: readonly KokoroVoiceInfo[], a: string, b: string, percent: number): string {
  const p = mixPercent(percent);
  return `${nameOf(voices, a)} ${String(100 - p)} % · ${nameOf(voices, b)} ${String(p)} %`;
}

/** Why the mix can't be saved yet, or null. */
export function mixProblem(voices: readonly KokoroVoiceInfo[], a: string, b: string): string | null {
  const known = (id: string): boolean => voices.some((v) => v.id === id);
  if (!known(a) || !known(b)) return 'Pick two voices.';
  if (a === b) return 'Pick two different voices to mix.';
  return null;
}

/** The saved mixes worth showing: well-formed, made of voices this build has. */
export function usableMixes(raw: unknown, voices: readonly KokoroVoiceInfo[]): CustomVoiceInfo[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(voices.map((v) => v.id));
  return raw.filter(
    (m): m is CustomVoiceInfo =>
      !!m &&
      typeof m === 'object' &&
      typeof (m as CustomVoiceInfo).id === 'string' &&
      (m as CustomVoiceInfo).id.startsWith('mix_') &&
      typeof (m as CustomVoiceInfo).name === 'string' &&
      typeof (m as CustomVoiceInfo).percent === 'number' &&
      known.has((m as CustomVoiceInfo).a) &&
      known.has((m as CustomVoiceInfo).b),
  );
}
