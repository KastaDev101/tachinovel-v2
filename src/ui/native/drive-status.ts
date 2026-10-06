/**
 * "Prepare for the drive" status, pure (no DOM): normalizing the native answer and the words the UI
 * shows (the novel page card, the sheet, Settings › Voices › In the car). Unit-tested in tests/car.test.ts.
 */
import type { DriveJobInfo, DriveStatus } from './narration.ts';

export const DRIVE_CHAPTER_CHOICES = [1, 3, 5, 10] as const;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  if (n < 1e6) return '<1 MB';
  return n < 1e9 ? `${Math.round(n / 1e6)} MB` : `${(n / 1e9).toFixed(1)} GB`;
}

export function formatDuration(sec: number): string {
  const s = Number.isFinite(sec) ? Math.max(0, sec) : 0;
  const m = s > 0 ? Math.max(1, Math.round(s / 60)) : 0;
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/** A usable driveStatus answer, or an empty one (older builds, mocks, errors). */
export function normalizeDriveStatus(raw: unknown): DriveStatus {
  const r = raw && typeof raw === 'object' ? (raw as Partial<DriveStatus>) : {};
  return {
    jobs: Array.isArray(r.jobs) ? r.jobs : [],
    prepared: Array.isArray(r.prepared) ? r.prepared : [],
    bytes: typeof r.bytes === 'number' ? r.bytes : 0,
    totalBytes: typeof r.totalBytes === 'number' ? r.totalBytes : 0,
    capBytes: typeof r.capBytes === 'number' ? r.capBytes : 0,
  };
}

/** Progress of a request, 0…1 (chapters done + the share of the one being rendered). */
export function jobProgress(j: DriveJobInfo): number {
  if (j.count <= 0) return 0;
  const part = j.current && j.current.sentences > 0 ? j.current.sentence / j.current.sentences : 0;
  return Math.min(1, (j.done + part) / j.count);
}

/** One line for a novel: what is being prepared, why it waits, or what is ready. */
export function driveLine(status: DriveStatus, novelKey: string): string {
  const job = status.jobs.find((j) => j.novelKey === novelKey);
  const ready = status.prepared.filter((c) => c.novelKey === novelKey);
  const bytes = ready.reduce((a, c) => a + c.bytes, 0);
  const readyText = ready.length > 0 ? `${ready.length} chapter${ready.length === 1 ? '' : 's'} ready · ${formatBytes(bytes)}` : '';
  if (job) {
    switch (job.state) {
      case 'running':
        return `Preparing ${Math.min(job.count, job.done + 1)} of ${job.count} · ${Math.round(jobProgress(job) * 100)}%`;
      case 'waiting':
        return `${job.reason ?? 'Waiting'} · ${job.done} of ${job.count} ready`;
      case 'queued':
        return `Queued · ${job.done} of ${job.count} ready`;
      case 'failed':
        return `Stopped: ${job.error ?? 'something went wrong'}`;
      case 'done':
        break;
    }
  }
  return readyText || 'Kokoro reads the next chapters ahead, for the car or offline';
}

/** Settings › Voices › In the car: all prepared audio in one line. */
export function storageLine(status: DriveStatus): string {
  const n = status.prepared.length;
  return n === 0 ? 'Nothing prepared' : `${n} chapter${n === 1 ? '' : 's'} · ${formatBytes(status.totalBytes)}`;
}
