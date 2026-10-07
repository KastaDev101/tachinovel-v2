/**
 * The pronunciation lists and text prep settings in the synced store (narration-lexicons.json), and their
 * section in backups. v1's backup service (vendor, read-only) writes and restores everything else; the core
 * adds a `narration` section to each backup file it writes and restores it after v1's restore
 * (core.ts wraps backup.create / backup.preview / backup.restore).
 */
import type { FileStore } from '@v1/shared/contracts/platform.ts';
import { validateLexicon, type Lexicon } from '@v1tts/frontend.ts';
import { DEFAULT_TEXT_PREP, normalizeTextPrep, type TextPrepPrefs } from './prep/prefs.ts';
import { emptyLexiconStore, type LexiconStore } from './speech-script.ts';

export const LEXICON_FILE = 'narration-lexicons.json';

type Store = Pick<FileStore, 'readText' | 'writeText'>;

/** The store as saved, keeping only valid lists; settings normalized. */
export function parseLexiconStore(text: string | null): LexiconStore {
  if (!text) return emptyLexiconStore();
  try {
    const s = JSON.parse(text) as Partial<LexiconStore>;
    const base = emptyLexiconStore();
    const out: LexiconStore = {
      schemaVersion: 1,
      global: s.global && validateLexicon(s.global).length === 0 ? s.global : base.global,
      novels: Object.fromEntries(Object.entries(s.novels ?? {}).filter(([, l]) => validateLexicon(l).length === 0)),
    };
    if (s.prep !== undefined) out.prep = normalizeTextPrep(s.prep);
    return out;
  } catch {
    return emptyLexiconStore();
  }
}

export async function loadLexiconStore(store: Store): Promise<LexiconStore> {
  return parseLexiconStore(await store.readText(LEXICON_FILE).catch(() => null));
}

export async function saveLexiconStore(store: Store, value: LexiconStore): Promise<void> {
  await store.writeText(LEXICON_FILE, JSON.stringify(value));
}

/** The text prep settings in effect. */
export function textPrepOf(store: LexiconStore): TextPrepPrefs {
  return normalizeTextPrep(store.prep);
}

// ---------------------------------------------------------------- backups

/** The `narration` section of a backup file. */
export interface NarrationBackup {
  schemaVersion: 1;
  global: Lexicon;
  novels: Record<string, Lexicon>;
  prep?: TextPrepPrefs;
}

/** What goes into a backup; null when there is nothing of the user's (no words, default settings). */
export function narrationBackup(store: LexiconStore): NarrationBackup | null {
  const novels = Object.fromEntries(Object.entries(store.novels).filter(([, l]) => l.entries.length > 0));
  const prep = store.prep ? normalizeTextPrep(store.prep) : undefined;
  const customPrep = prep && (prep.skipNotes !== DEFAULT_TEXT_PREP.skipNotes || prep.statTables !== DEFAULT_TEXT_PREP.statTables);
  if (store.global.entries.length === 0 && Object.keys(novels).length === 0 && !customPrep) return null;
  return { schemaVersion: 1, global: store.global, novels, ...(prep ? { prep } : {}) };
}

/** The `narration` section of a backup file's JSON text, validated; null if absent or unusable. */
export function readNarrationBackup(text: string | null): NarrationBackup | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = (JSON.parse(text) as { narration?: unknown }).narration;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Partial<NarrationBackup>;
  const parsed = parseLexiconStore(JSON.stringify({ global: n.global, novels: n.novels, prep: n.prep }));
  const out: NarrationBackup = { schemaVersion: 1, global: parsed.global, novels: parsed.novels };
  if (n.prep !== undefined) out.prep = normalizeTextPrep(n.prep);
  return out;
}

/** A lexicon with the other's words added where it has none for that word (case-insensitive). */
function union(current: Lexicon, incoming: Lexicon): Lexicon {
  const have = new Set(current.entries.map((e) => e.match.trim().toLowerCase()));
  return { schemaVersion: 1, entries: [...current.entries, ...incoming.entries.filter((e) => !have.has(e.match.trim().toLowerCase()))] };
}

/**
 * The store after restoring a backup's section. `merge` (v1's "keep what's here, fold the backup in"): your
 * words win, the backup adds the ones you don't have, your settings stay. `replace`: the backup's lists and
 * settings.
 */
export function restoreLexicons(current: LexiconStore, backup: NarrationBackup, mode: 'merge' | 'replace'): LexiconStore {
  if (mode === 'replace') {
    const out: LexiconStore = { schemaVersion: 1, global: backup.global, novels: { ...backup.novels } };
    const prep = backup.prep ?? current.prep;
    if (prep) out.prep = prep;
    return out;
  }
  const novels: Record<string, Lexicon> = { ...current.novels };
  for (const [key, lex] of Object.entries(backup.novels)) novels[key] = union(current.novels[key] ?? { schemaVersion: 1, entries: [] }, lex);
  const out: LexiconStore = { schemaVersion: 1, global: union(current.global, backup.global), novels };
  const prep = current.prep ?? backup.prep;
  if (prep) out.prep = prep;
  return out;
}
