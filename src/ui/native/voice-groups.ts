/**
 * The voice picker's order: grouped by accent and gender, the best-graded voice first in each group.
 * Grades are Kokoro's own (hexgrad/Kokoro-82M VOICES.md, "Overall Grade"); native sends them with each voice
 * (HDVoiceCore VoiceCatalog.swift, same ranking). Pure (no DOM).
 */
import type { KokoroVoiceInfo } from './narration.ts';

/** A letter grade with an optional + or − as a number, higher is better (A = 13 … F = 1, unknown = −1). */
export function gradeRank(grade: string | undefined): number {
  const base = { A: 4, B: 3, C: 2, D: 1, F: 0 }[grade?.charAt(0) ?? ''];
  if (base === undefined) return -1;
  const mod = grade?.charAt(1);
  return base * 3 + 1 + (mod === '+' ? 1 : mod === '-' || mod === '−' ? -1 : 0);
}

export interface VoiceGroup {
  key: string;
  label: string;
  voices: KokoroVoiceInfo[];
}

/** American women, American men, British women, British men; best grade first, then by name. */
export function groupVoices(voices: readonly KokoroVoiceInfo[]): VoiceGroup[] {
  const groups: VoiceGroup[] = [];
  for (const [lang, accent] of [
    ['en-US', 'American'],
    ['en-GB', 'British'],
  ] as const) {
    for (const [gender, who] of [
      ['female', 'women'],
      ['male', 'men'],
    ] as const) {
      const vs = voices
        .filter((v) => v.language === lang && v.gender === gender)
        .sort((a, b) => gradeRank(b.grade) - gradeRank(a.grade) || a.name.localeCompare(b.name));
      if (vs.length > 0) groups.push({ key: `${lang}-${gender}`, label: `${accent} ${who}`, voices: vs });
    }
  }
  // Anything else (a future accent) at the end, as it came.
  const shown = new Set(groups.flatMap((g) => g.voices.map((v) => v.id)));
  const rest = voices.filter((v) => !shown.has(v.id));
  if (rest.length > 0) groups.push({ key: 'other', label: 'Other voices', voices: [...rest] });
  return groups;
}
