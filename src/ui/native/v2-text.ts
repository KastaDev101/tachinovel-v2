/**
 * v2's own wording for v1's UI (tools/v1-wording.ts patches v1's strings to read these globals).
 * Imported by src/ui/main.ts right after the prelude and BEFORE v1's UI, so the globals exist when v1's
 * modules evaluate (What's New is read at module load). The storage texts start with the device-only
 * wording and switch to the real place once the core answers `v2.storage` (long before anyone opens
 * Settings or Help).
 */
import { sharedClient } from '../capacitor-client.ts';

export interface V2Text {
  /** "Backups are saved in …" */
  backupsWhere: string;
  /** "Your library, progress and settings live in …" */
  dataWhere: string;
  /** Storage screen, "Library & settings" row. */
  stateNote: string;
}

export type StorageKind = 'icloud' | 'documents' | 'device';

export const STORAGE_TEXT: Record<StorageKind, V2Text> = {
  icloud: {
    backupsWhere: 'iCloud Drive › TachiNovel › backups',
    dataWhere: 'iCloud Drive › TachiNovel',
    stateNote: 'Synced with iCloud',
  },
  documents: {
    backupsWhere: 'Files › On My iPhone › TachiNovel › backups',
    dataWhere: 'Files › On My iPhone › TachiNovel',
    stateNote: 'On this iPhone, shown in Files',
  },
  device: {
    backupsWhere: 'TachiNovel’s storage on this iPhone (use Share on a backup to keep a copy elsewhere)',
    dataWhere: 'TachiNovel’s storage on this iPhone',
    stateNote: 'On this iPhone',
  },
};

interface WhatsNewRelease {
  id: string;
  title: string;
  items: { icon: string; color: string; title: string; detail: string }[];
}

/** v2's release notes, newest first (icons: SF Symbol names in v1's components/icons.ts). */
export const V2_WHATS_NEW: WhatsNewRelease[] = [
  {
    id: 'v2-2026-10-06',
    title: 'TachiNovel for iPhone',
    items: [
      {
        icon: 'headphones',
        color: 'var(--indigo)',
        title: 'Listen',
        detail: 'Tap Listen in the reader: chapters are read aloud, keep playing with the screen locked or in the car, and go on to the next chapter.',
      },
      {
        icon: 'clock.arrow.circlepath',
        color: 'var(--blue)',
        title: 'Bring your library along',
        detail: 'More › Backup & Restore › Restore from Files… reads a backup from the previous version: library, progress and settings.',
      },
      {
        icon: 'folder',
        color: 'var(--orange)',
        title: 'Your files in Files',
        detail: 'Backups and logs are in the Files app, so you can copy them off the phone.',
      },
      {
        icon: 'book',
        color: 'var(--green)',
        title: 'Illustrations and a readable status bar',
        detail: 'Pictures in chapters load even from sites that block them, and the status bar stays readable on every reader theme.',
      },
    ],
  },
];

declare global {
  // eslint-disable-next-line no-var -- read by v1 code patched at build time (tools/v1-wording.ts)
  var __TN_TEXT__: V2Text | undefined;
  // eslint-disable-next-line no-var -- read by v1's whats-new-data.ts, patched at build time
  var __TN_WHATS_NEW__: WhatsNewRelease[] | undefined;
}

globalThis.__TN_TEXT__ = STORAGE_TEXT.device;
globalThis.__TN_WHATS_NEW__ = V2_WHATS_NEW;

void (sharedClient().call as (method: string) => Promise<unknown>)('v2.storage')
  .then((r) => {
    const kind = (r as { kind?: StorageKind } | null)?.kind;
    if (kind && kind in STORAGE_TEXT) globalThis.__TN_TEXT__ = STORAGE_TEXT[kind];
  })
  .catch(() => undefined);
