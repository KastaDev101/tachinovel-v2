/**
 * Developer options (cleanup 1, 2026-10-15): stored natively (DeveloperOptions.swift), read and changed through the
 * Narration plugin's voiceSettings / setVoiceSettings ("developer"). Tap the version in More › About 7 times to turn them
 * on; the "Developer Options" switch at the bottom of About turns them off. The personal build starts with them on.
 *
 * While they are on: More › Developer (developer-ui.ts) with the voice tools, the Voice Speed Test in the Listen player's
 * Voice panel and on the app icon's long-press menu; with "Show Voice Details in the Player", the player's voice chip
 * says which voice really speaks and why (otherwise just "Nephis" or "Backup voice"); with "Phonemes and JSON Paste", the
 * pronunciation editor shows its phonemes field and lexicon paste.
 *
 * This module only keeps the last answer (no native call of its own until something changes): v1-hooks.ts reads it at
 * launch and whenever voice settings change; every Voices screen that loads voice settings refreshes it too.
 */
import { Narration } from './narration.ts';

export interface DeveloperInfo {
  on: boolean;
  /** The Listen player's chip: which voice speaks and why (fallback reasons). */
  playerDetails: boolean;
  /** The pronunciation editor: Kokoro phonemes field and JSON lexicon paste. */
  phonemes: boolean;
  /** Audio downloads: the better of two takes per call (twice the work). */
  bestOfTwo: boolean;
}

/** Window event after Developer options changed (v1-hooks.ts adds or removes the More row and About's switch). */
export const DEVELOPER_CHANGED = 'tn-developer';

/** The native answer, or the defaults (older builds send none: on in the personal flavor). */
export function normalizeDeveloper(raw: unknown): DeveloperInfo {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof DeveloperInfo, unknown>>;
  return {
    on: typeof r.on === 'boolean' ? r.on : __FLAVOR__ === 'personal',
    playerDetails: r.playerDetails === true,
    phonemes: r.phonemes !== false,
    bestOfTwo: r.bestOfTwo === true,
  };
}

let current: DeveloperInfo = normalizeDeveloper(undefined);

export function developer(): DeveloperInfo {
  return current;
}

/** Developer options are on. */
export function isDeveloper(): boolean {
  return current.on;
}

/** The player's chip names the voice and the reason for a stand-in. */
export function showsVoiceDetails(): boolean {
  return current.on && current.playerDetails;
}

/** The pronunciation editor's phonemes field and JSON paste. */
export function showsPhonemes(): boolean {
  return current.on && current.phonemes;
}

/** Remember native's answer (from a voiceSettings call made anyway); tells listeners when it changed. */
export function noteDeveloper(raw: unknown): DeveloperInfo {
  const next = normalizeDeveloper(raw);
  const changed =
    next.on !== current.on || next.playerDetails !== current.playerDetails || next.phonemes !== current.phonemes || next.bestOfTwo !== current.bestOfTwo;
  current = next;
  if (changed) window.dispatchEvent(new Event(DEVELOPER_CHANGED));
  return next;
}

/** Change some options natively; the screen updates at once (and goes back if native refuses). */
export async function setDeveloper(changes: Partial<DeveloperInfo>): Promise<DeveloperInfo> {
  const before = current;
  noteDeveloper({ ...current, ...changes });
  try {
    await Narration.setVoiceSettings({ developer: changes });
  } catch (err) {
    noteDeveloper(before);
    throw err;
  }
  return current;
}
