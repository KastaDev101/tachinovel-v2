/**
 * Tells the user when saving fails (most often: the iPhone is out of storage). Failed saves are logged
 * anyway, but nothing on screen showed them, so a full disk silently lost reading positions. One
 * `app.error` notice per kind per session (state/positions, downloads); later failures are logged only.
 */
import { errorMessage } from '../lib/errors.ts';
import type { EventHub } from './events.ts';

/** iOS / FileManager wording for a full disk. */
const DISK_FULL_RE = /no space|(?:not|n['\u2019]t) enough (?:free )?space|out of space|ENOSPC|disk (?:is )?full|storage (?:is )?full|OutOfSpace/i;

export function isDiskFull(err: unknown): boolean {
  return DISK_FULL_RE.test(errorMessage(err));
}

export const STATE_FULL_MESSAGE = "Your iPhone is out of storage, so TachiNovel can't save your reading position. Free up some space.";
export const STATE_FAILED_MESSAGE = "TachiNovel couldn't save your reading position on this iPhone. It keeps trying; if this repeats, restart the app.";
export const DOWNLOADS_FULL_MESSAGE = 'Your iPhone is out of storage, so downloads stopped. Free up some space; they continue next time.';
export const DOWNLOADS_FAILED_MESSAGE = "Downloads stopped: TachiNovel couldn't save them on this iPhone. They continue next time.";

export class StorageAlarm {
  private events: EventHub | null = null;
  private readonly told = new Set<'state' | 'downloads'>();

  /** The event hub (created after the documents that report failures). */
  attach(events: EventHub): void {
    this.events = events;
  }

  /** A state or position document couldn't be saved. */
  stateWriteFailed(err: unknown): void {
    this.notify('state', isDiskFull(err) ? STATE_FULL_MESSAGE : STATE_FAILED_MESSAGE);
  }

  /** A downloaded chapter couldn't be saved (the queue pauses). */
  downloadWriteFailed(err: unknown): void {
    this.notify('downloads', isDiskFull(err) ? DOWNLOADS_FULL_MESSAGE : DOWNLOADS_FAILED_MESSAGE);
  }

  private notify(kind: 'state' | 'downloads', message: string): void {
    if (this.told.has(kind) || !this.events) return;
    this.told.add(kind);
    this.events.emit('app.error', { message });
  }
}
