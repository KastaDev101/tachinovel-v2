/**
 * "Download with audio" (part 2, the screens), pure (no DOM): the native audio status made safe, the words the novel
 * card, the queue rows and the storage rows show, the chapter-row badges, which chapters a choice means, the estimate
 * and the space check. Unit-tested in tests/audio-downloads.test.ts.
 */
import { formatBytes, formatDuration, jobProgress, stepWords } from './drive-status.ts';
import type { AudioEstimate, AudioStatus, DriveJobInfo, PreparedChapterInfo } from './narration.ts';

/** Space left over after the audio (the sheet refuses below the audio's size plus this). */
export const SPARE_BYTES = 1e9;

export function novelKeyOf(pluginId: string, novelPath: string): string {
  return `${pluginId}:${novelPath}`;
}

/** A usable audioStatus answer, or an empty one (older builds, mocks, errors). */
export function normalizeAudioStatus(raw: unknown): AudioStatus {
  const r = raw && typeof raw === 'object' ? (raw as Partial<AudioStatus>) : {};
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    jobs: Array.isArray(r.jobs) ? r.jobs.filter((j) => !!j && typeof j === 'object' && typeof j.novelKey === 'string') : [],
    audio: Array.isArray(r.audio) ? r.audio.filter((a) => !!a && typeof a === 'object' && typeof a.novelKey === 'string') : [],
    bytes: n(r.bytes),
    totalBytes: n(r.totalBytes),
    downloadBytes: n(r.downloadBytes),
    driveBytes: n(r.driveBytes),
    workBytes: n(r.workBytes),
    capBytes: n(r.capBytes),
    deleteAfterListening: r.deleteAfterListening === true,
    autoDownloadAudio: r.autoDownloadAudio === true,
    bestOfTwo: r.bestOfTwo === true,
    speedX: typeof r.speedX === 'number' ? r.speedX : null,
    voice: r.voice === 'kokoro' ? 'kokoro' : 'nephis',
  };
}

/** Audio that plays (made with the voice that reads now; never-checked counts). Stale audio is never played. */
export function playable(a: PreparedChapterInfo): boolean {
  return a.fresh !== false;
}

/** A novel's download request (the queue shows downloads; "Prepare for the drive" requests of older builds too). */
export function novelJob(s: AudioStatus, novelKey: string): DriveJobInfo | undefined {
  return s.jobs.find((j) => j.novelKey === novelKey && (j.kind ?? 'drive') === 'download') ?? s.jobs.find((j) => j.novelKey === novelKey);
}

/** Still to do: running, waiting, queued, paused, or stopped after its tries (Retry). */
export function isOpen(j: DriveJobInfo): boolean {
  return j.state !== 'done';
}

/** Why it waits, in the queue's words. */
export function reasonWords(reason: string | undefined): string {
  if (!reason) return 'Waiting';
  if (/cool down|hot/i.test(reason)) return 'Paused: iPhone is hot';
  if (reason === 'Paused') return 'Paused';
  return reason;
}

/** The queue row's state: "Text ✓ · Audio 42 %", "Waiting for charging", "Failed: … · Retry". */
export function jobState(j: DriveJobInfo, text?: { done: number; total: number; finished: boolean }): string {
  const textPart = text && !text.finished && text.total > 0 ? `Text ${text.done} of ${text.total}` : 'Text ✓';
  switch (j.state) {
    case 'running': {
      const pct = j.current && j.current.sentences > 0 ? Math.round((j.current.sentence / j.current.sentences) * 100) : 0;
      const step = j.current?.step === 'director' || j.current?.step === 'encoding' || j.current?.step === 'waiting' ? stepWords(j.current.step) : '';
      return `${textPart} · ${step || `Audio ${pct} %`}`;
    }
    case 'paused':
      return 'Paused';
    case 'waiting':
      return reasonWords(j.reason);
    case 'queued':
      return 'Queued';
    case 'failed':
      return `Stopped after 3 tries: ${j.error ?? 'something went wrong'}`;
    case 'done':
      return 'Done';
  }
}

/** The queue row's first part: the chapter being made, else how many are ready. */
export function jobChapter(j: DriveJobInfo): string {
  if (j.current?.title) return j.current.title;
  return `${j.done} of ${j.count} ready`;
}

/** The novel card's line. */
export function cardLine(s: AudioStatus, novelKey: string): string {
  const j = novelJob(s, novelKey);
  const ready = s.audio.filter((a) => a.novelKey === novelKey && playable(a));
  if (j && isOpen(j)) {
    const of = `${Math.min(j.count, j.done + (j.state === 'running' ? 1 : 0))} of ${j.count}`;
    if (j.state === 'running') return `Downloading ${of} · Audio ${Math.round(jobProgress(j) * 100)} %`;
    if (j.state === 'failed') return `Stopped after 3 tries: ${j.error ?? 'something went wrong'}`;
    if (j.state === 'paused') return `Paused · ${j.done} of ${j.count} ready`;
    return `${j.state === 'queued' ? 'Queued' : reasonWords(j.reason)} · ${j.done} of ${j.count} ready`;
  }
  if (ready.length > 0) return `${chapters(ready.length)} ready to listen offline · ${formatBytes(ready.reduce((a, c) => a + c.bytes, 0))}`;
  return 'Nephis reads chapters into audio ahead of time';
}

export function chapters(n: number): string {
  return `${n} chapter${n === 1 ? '' : 's'}`;
}

/** Settings › Downloads › Narration Audio's value: "190 MB · 12 chapters", or "None". */
export function storageValue(s: AudioStatus): string {
  const n = s.audio.length;
  return n === 0 ? 'None' : `${formatBytes(s.totalBytes)} · ${chapters(n)}`;
}

/** Each novel's audio, biggest first (Narration Audio's list). */
export function byNovel(s: AudioStatus): { novelKey: string; name: string; count: number; bytes: number; seconds: number }[] {
  const names = new Map(s.jobs.map((j) => [j.novelKey, j.novelName]));
  const out = new Map<string, { novelKey: string; name: string; count: number; bytes: number; seconds: number }>();
  for (const a of s.audio) {
    const e = out.get(a.novelKey) ?? { novelKey: a.novelKey, name: names.get(a.novelKey) || a.novelKey.slice(a.novelKey.indexOf(':') + 1), count: 0, bytes: 0, seconds: 0 };
    e.count++;
    e.bytes += a.bytes;
    e.seconds += a.durationSec;
    out.set(a.novelKey, e);
  }
  return [...out.values()].sort((a, b) => b.bytes - a.bytes);
}

/** A chapter's line in Narration Audio: length, size, and whether it is being made again in the current voice. */
export function audioRow(a: PreparedChapterInfo): string {
  return `${formatDuration(a.durationSec)} · ${formatBytes(a.bytes)}${a.fresh === false ? ' · Being made again' : ''}`;
}

export type Badge = 'audio' | number;

/** Chapter-row badges: "audio" (text + audio), or the share made (0…1, in 10 % steps) of the chapter being made. */
export function buildBadges(s: AudioStatus): Map<string, Badge> {
  const m = new Map<string, Badge>();
  for (const a of s.audio) if (playable(a)) m.set(`${a.novelKey}\u001f${a.chapterPath}`, 'audio');
  for (const j of s.jobs) {
    const c = j.current;
    if (j.state === 'running' && c) m.set(`${j.novelKey}\u001f${c.chapterPath}`, c.sentences > 0 ? Math.floor((c.sentence / c.sentences) * 10) / 10 : 0);
  }
  return m;
}

/** A cheap fingerprint of the badges: the chapter list re-renders only when one changes. */
export function badgeSignature(m: Map<string, Badge>): string {
  return [...m].map(([k, v]) => `${k}=${v}`).join('|');
}

export interface ChapterLike {
  path: string;
  read: boolean;
  locked?: boolean;
  downloaded?: boolean;
  progress?: number;
}

/** Where listening/reading would go on (v1's novel page Resume): mid-chapter → it; finished → the next unread. */
export function resumeIndex(list: readonly ChapterLike[], lastRead: { chapterPath: string; position?: { percent: number } } | undefined, markReadAt = 0.97): number {
  const nextUnread = (): number => {
    let last = -1;
    for (let i = list.length - 1; i >= 0; i--) if (list[i]?.read) {
      last = i;
      break;
    }
    for (let i = last + 1; i < list.length; i++) if (!list[i]?.read) return i;
    return -1;
  };
  if (lastRead) {
    const i = list.findIndex((c) => c.path === lastRead.chapterPath);
    if (i >= 0) {
      const pct = lastRead.position?.percent;
      if (pct !== undefined && pct > 0 && pct < markReadAt) return i;
      if (list[i]?.read) {
        const n = nextUnread();
        return n >= 0 ? n : i;
      }
      return i;
    }
  }
  return nextUnread();
}

export type ChapterChoice = 'next5' | 'next10' | 'unread' | 'selected';

/** The chapters a choice means, in reading order, never locked ones. */
export function pickChapters(list: readonly ChapterLike[], choice: ChapterChoice, start: number, selected: readonly number[] = []): string[] {
  const ok = (c: ChapterLike | undefined): c is ChapterLike => !!c && !c.locked;
  if (choice === 'selected') return [...selected].sort((a, b) => a - b).map((i) => list[i]).filter(ok).map((c) => c.path);
  if (choice === 'unread') return list.filter((c) => ok(c) && !c.read).map((c) => c.path);
  const n = choice === 'next5' ? 5 : 10;
  const out: string[] = [];
  for (let i = Math.max(0, start); i < list.length && out.length < n; i++) {
    const c = list[i];
    if (ok(c)) out.push(c.path);
  }
  return out;
}

/** The estimate for `n` chapters at 128 kbps: the total ("190 MB") and "About 16 MB a chapter · ready in about 2 h 10 min"
 * (her measured speed, else real time). */
export function estimateWords(e: AudioEstimate | null, n: number): { total: string; detail: string } {
  if (!e || n <= 0) return { total: '', detail: '' };
  const per = e.megabytes / n;
  return {
    total: formatBytes(e.megabytes * 1e6),
    detail: `About ${per >= 1 ? Math.round(per) : '<1'} MB a chapter · ready in about ${formatDuration(e.renderMinutes * 60)}`,
  };
}

/** Not enough space for the audio plus 1 GB: the message (null when it fits, or when iOS didn't say). */
export function spaceProblem(e: AudioEstimate | null): string | null {
  if (!e || typeof e.freeBytes !== 'number') return null;
  const need = e.megabytes * 1e6 + SPARE_BYTES;
  if (e.freeBytes >= need) return null;
  return `The audio needs ${formatBytes(e.megabytes * 1e6)}, and 1 GB should stay free. ${formatBytes(e.freeBytes)} is free on this iPhone.`;
}

/** The voice line under Include Narration Audio: "Nephis · <narrator pack> + <dialogue pack>". */
export function voiceLine(narrator: string | null, dialogue: string | null): string {
  const n = narrator ? ` · ${narrator.replace(/ · Studio$/, '')}` : '';
  const d = dialogue && dialogue !== 'Uses the narrator' ? ` + ${dialogue}` : '';
  return `Nephis${n}${d}`;
}

/** A finished download (in the queue a moment ago, done now): the toast while the app is open. */
export function finishedDownloads(before: AudioStatus, after: AudioStatus): DriveJobInfo[] {
  return after.jobs.filter((j) => {
    if (j.state !== 'done' || (j.kind ?? 'drive') !== 'download') return false;
    const was = before.jobs.find((b) => b.key === j.key);
    return !!was && was.state !== 'done';
  });
}
