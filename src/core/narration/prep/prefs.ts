/**
 * Text prep settings (Settings › Voices › Pronunciations › Reading). Kept by the core with the pronunciation
 * lists (narration-lexicons.json, synced and in backups), so the UI and the core read chapters the same way.
 */
import type { StatTableMode } from './system.ts';

export interface TextPrepPrefs {
  /** Skip translator/editor/author notes and Patreon/Discord plugs. */
  skipNotes: boolean;
  /** LitRPG stat tables: every line, a short summary, or not at all. */
  statTables: StatTableMode;
}

export const DEFAULT_TEXT_PREP: TextPrepPrefs = { skipNotes: true, statTables: 'short' };

/** Settings from storage or the UI; anything unknown falls back to the default. */
export function normalizeTextPrep(raw: unknown): TextPrepPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof TextPrepPrefs, unknown>>;
  return {
    skipNotes: typeof r.skipNotes === 'boolean' ? r.skipNotes : DEFAULT_TEXT_PREP.skipNotes,
    statTables: r.statTables === 'full' || r.statTables === 'skip' || r.statTables === 'short' ? r.statTables : DEFAULT_TEXT_PREP.statTables,
  };
}
