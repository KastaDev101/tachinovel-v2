/**
 * "Listen in the car" helpers (pure; unit-tested): voices, status lines, config edits. The PC narrator
 * reads the config and writes the status; the app only shows and edits.
 */
import type { NarrationConfig, NarrationStatus, NovelKeyString } from '../../shared/contracts/domain.ts';
import { formatCount } from './format.ts';

export const DEFAULT_AHEAD = 10;
export const SPEED_LIMITS = { min: 0.8, max: 1.2, step: 0.05 } as const;
/** Chapters per .m4b: 0 = off (one file per chapter), else 5–20. */
export const BUNDLE_LIMITS = { min: 5, max: 20 } as const;

export interface Voice {
  id: string;
  name: string;
  description: string;
}

export const VOICES: readonly Voice[] = [
  { id: 'af_heart', name: 'Heart', description: 'Warm and natural · American English, female' },
  { id: 'am_michael', name: 'Michael', description: 'Calm and clear · American English, male' },
  { id: 'bm_george', name: 'George', description: 'A steady storyteller · British English, male' },
  { id: 'am_fenrir', name: 'Fenrir', description: 'Deep and dramatic · American English, male' },
  { id: 'bf_emma', name: 'Emma', description: 'Bright and crisp · British English, female' },
];

export type NovelNarration = NarrationStatus['novels'][number];

/** "Ch 1001–1010", "Ch 1–10, 15–20", "Ch 7" (chapter numbers, so no thousands separators). */
export function readyRanges(ready: readonly { from: number; to: number }[]): string {
  if (ready.length === 0) return '';
  const parts = ready.map((r) => (r.from === r.to ? String(r.from) : `${r.from}–${r.to}`));
  return `Ch ${parts.join(', ')}`;
}

export function statusFor(status: NarrationStatus | null, key: NovelKeyString): NovelNarration | undefined {
  return status?.novels.find((n) => n.key === key);
}

/** The narrator's default when nothing is picked: novels read in the last week (its `recentDays`). */
export const RECENT_DAYS = 7;

/** Keys of novels read in the last RECENT_DAYS days, most recent first (what the narrator picks by default). */
export function recentlyRead(entries: readonly { key: NovelKeyString; lastReadAt?: number }[], now: number): NovelKeyString[] {
  const since = now - RECENT_DAYS * 86_400_000;
  return entries
    .filter((e) => e.lastReadAt !== undefined && e.lastReadAt >= since)
    .sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))
    .map((e) => e.key);
}

/**
 * The novels being narrated, like the narrator decides (tachinovel-narrator src/plan.ts): the picked
 * list, or, when nothing is picked, the novels read in the last week (`recent`). Being in the status
 * file means nothing by itself: it lists every novel the PC has ever narrated.
 */
export function effectiveNovels(config: NarrationConfig, recent: readonly NovelKeyString[]): NarrationConfig['novels'] {
  return config.novels.length > 0 ? config.novels : recent.map((key) => ({ key, ahead: DEFAULT_AHEAD }));
}

export function isNarrated(config: NarrationConfig, recent: readonly NovelKeyString[], key: NovelKeyString): boolean {
  return effectiveNovels(config, recent).some((n) => n.key === key);
}

/**
 * One line for a novel: "Audio ready: Ch 1001–1010 · 12 queued", "Narrating · 4 queued",
 * "Waiting for your PC", "Not narrating". Failures and errors are appended. Counts come only from
 * this novel's own status entry.
 */
export function narrationLine(config: NarrationConfig, status: NarrationStatus | null, key: NovelKeyString, recent: readonly NovelKeyString[] = []): string {
  const s = statusFor(status, key);
  const on = isNarrated(config, recent, key);
  if (!s) return on ? 'Waiting for your PC' : 'Not narrating';
  // Turned off: the files already made stay in TachiNovel Audio, but nothing new is coming.
  if (!on) return s.ready.length > 0 ? `Audio ready: ${readyRanges(s.ready)} · not narrating more` : 'Not narrating';
  const parts: string[] = [];
  if (s.ready.length > 0) parts.push(`Audio ready: ${readyRanges(s.ready)}`);
  if (s.queued > 0) parts.push(s.ready.length > 0 ? `${formatCount(s.queued)} queued` : `Narrating · ${formatCount(s.queued)} queued`);
  if (s.failed > 0) parts.push(`${formatCount(s.failed)} failed`);
  if (parts.length === 0) parts.push('Up to date');
  return parts.join(' · ');
}

/** Adds (with the default look-ahead) or removes a novel, starting from what's effectively narrated. */
export function withNovel(config: NarrationConfig, recent: readonly NovelKeyString[], key: NovelKeyString, on: boolean): NarrationConfig {
  const base = effectiveNovels(config, recent);
  const rest = base.filter((n) => n.key !== key);
  return { ...config, novels: on ? [...rest, { key, ahead: base.find((n) => n.key === key)?.ahead ?? DEFAULT_AHEAD }] : rest };
}

/** Look-ahead choices offered per novel. */
export const AHEAD_CHOICES: readonly number[] = [5, 10, 20, 30];

export function aheadFor(config: NarrationConfig, recent: readonly NovelKeyString[], key: NovelKeyString): number | undefined {
  return effectiveNovels(config, recent).find((n) => n.key === key)?.ahead;
}

/** Sets how many chapters ahead one novel is narrated (adding it if it wasn't), keeping the order. */
export function withAhead(config: NarrationConfig, recent: readonly NovelKeyString[], key: NovelKeyString, ahead: number): NarrationConfig {
  const base = effectiveNovels(config, recent);
  const novels = base.some((n) => n.key === key) ? base.map((n) => (n.key === key ? { key, ahead } : n)) : [...base, { key, ahead }];
  return { ...config, novels };
}

/** The status file is only rewritten when the narrator runs; older than this, the PC is probably off. */
export const STALE_STATUS_MS = 36 * 3_600_000;

export function isStale(status: NarrationStatus | null, now: number): boolean {
  return status !== null && now - status.generatedAt > STALE_STATUS_MS;
}

/** Bundle stepper: 0 ⇄ 5 jumps, then 5–20 one at a time. */
export function stepBundle(current: number, next: number): number {
  if (next <= 0) return 0;
  if (current === 0) return BUNDLE_LIMITS.min;
  if (next < BUNDLE_LIMITS.min) return 0;
  return Math.min(BUNDLE_LIMITS.max, next);
}

export function bundleLabel(n: number): string {
  return n === 0 ? 'Off' : `${n} per file`;
}

export function speedLabel(v: number): string {
  return `${(Math.round(v * 100) / 100).toFixed(2).replace(/0$/, '')}×`;
}

/**
 * Files app link to iCloud Drive › TachiNovel Audio (where the PC narrator writes). `shareddocuments://`
 * opens a path in Files; iCloud Drive's root on the device is Mobile Documents/com~apple~CloudDocs.
 */
export const AUDIO_FOLDER_URL = 'shareddocuments:///private/var/mobile/Library/Mobile%20Documents/com~apple~CloudDocs/TachiNovel%20Audio/';

/** "3 locked · paid or not free yet" (never narrated; the narrator tries them again later), or null. */
export function lockedLine(s: Pick<NovelNarration, 'locked'> | undefined): string | null {
  const n = s?.locked ?? 0;
  return n > 0 ? `${formatCount(n)} locked · paid or not free yet` : null;
}

/** Characters Windows won't put in a file or folder name (the narrator runs on Windows). */
const NOT_IN_FILE_NAMES = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);

/**
 * The folder the narrator writes a novel's audio to, from its name: the same rules as the narrator's
 * `safeName` (tachinovel-narrator src/names.ts), so the link lands in the right place.
 */
export function audioFolderName(name: string, max = 80): string {
  let spaced = '';
  // Forbidden characters and control characters (below U+0020) become spaces.
  for (const ch of name) spaced += NOT_IN_FILE_NAMES.has(ch) || ch.charCodeAt(0) < 0x20 ? ' ' : ch;
  let out = spaced.replace(/\s+/g, ' ').trim();
  if (out.length > max) out = out.slice(0, max).trim();
  out = out.replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = `_${out}`;
  return out || '_';
}

/**
 * Files link for one novel's audio folder, or for TachiNovel Audio itself when the folder name has a
 * character the script won't put in a link (an ASCII apostrophe or backtick).
 */
export function audioFolderUrl(novelName?: string): string {
  if (!novelName) return AUDIO_FOLDER_URL;
  const folder = audioFolderName(novelName);
  return /['`]/.test(folder) ? AUDIO_FOLDER_URL : `${AUDIO_FOLDER_URL}${encodeURIComponent(folder)}/`;
}
