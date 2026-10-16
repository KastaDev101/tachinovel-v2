/**
 * The native DiagFolder plugin (DiagnosticsFolder.swift): the Diagnostics folder's status and menu, and the storage
 * map behind Settings › Storage › Voices & models. No v1 imports, so unit tests can load it.
 */
import { registerPlugin } from '@capacitor/core';

export interface DiagFolderStatus {
  linked: boolean;
  name?: string | null;
  /** Epoch ms of the last copy that worked, or null. */
  lastMirror?: number | null;
  /** off | ok | disconnected (the folder can't be reached: pick it again) | failing (the last copy failed). Older builds: absent. */
  state?: 'off' | 'ok' | 'disconnected' | 'failing';
  /** Why, in words, when disconnected or failing. */
  problem?: string | null;
  /** Copies work, but iCloud doesn't take them (storage full, the folder isn't in iCloud Drive, …): why. Older builds: absent. */
  upload?: string | null;
  /** Where the folder is ("iCloud Drive › TachiNovel-Diagnostics"). Older builds: absent. */
  place?: string | null;
}

/** The Diagnostics row's value: the folder's name, "Off", or what is wrong. */
export function folderLabel(s: DiagFolderStatus): string {
  if (!s.linked) return 'Off';
  if (s.state === 'disconnected') return 'Disconnected – tap to reconnect';
  if (s.state === 'failing') return `${s.name ?? 'On'} – not copying`;
  if (s.upload) return `${s.name ?? 'On'} – not uploading`;
  return s.name ?? 'On';
}

export interface DiagFolderPlugin {
  status(): Promise<DiagFolderStatus>;
  /** Native action sheet: choose/change/reconnect the folder, mirror now, report a problem, stop. */
  menu(): Promise<DiagFolderStatus>;
  /** Settings › Storage › Voices & models: bytes per category (storage-native.ts). */
  storage(): Promise<unknown>;
  /** Remove copies and unfinished unpacks only: {removed, bytes, report}. */
  cleanStorage(): Promise<unknown>;
}

export const DiagFolder = registerPlugin<DiagFolderPlugin>('DiagFolder');
