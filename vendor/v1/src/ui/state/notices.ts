/**
 * Calm, non-blocking notices from the script (`app.error`): "iCloud isn't ready… using the copy saved
 * on this iPhone". Each message shows once per session, one at a time; the banner stays out of the
 * reader (it waits until you leave it) and goes away on its own or when dismissed.
 */
import { signal } from '@preact/signals';

export interface Notice {
  id: number;
  message: string;
}

/** Waiting to be shown, oldest first. The banner shows the first one. */
export const notices = signal<Notice[]>([]);
const seen = new Set<string>();
let seq = 1;

export function pushNotice(message: string): void {
  const text = message.trim();
  if (!text || seen.has(text)) return;
  seen.add(text);
  notices.value = [...notices.value, { id: seq++, message: text }];
}

export function dismissNotice(id: number): void {
  notices.value = notices.value.filter((n) => n.id !== id);
}
