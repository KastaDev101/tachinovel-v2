/**
 * "Minutes left in this chapter": chapter length in words, the share still unread, and the reader's
 * own pace (words per minute), learned from steady forward reading and remembered on the device.
 */

export const DEFAULT_WPM = 230;
/** localStorage key of the pace the reader learned (words per minute, per device). */
export const PACE_KEY = 'tachinovel.wpm';
const MIN_WPM = 100;
const MAX_WPM = 700;

/** Words in chapter HTML (tags and entities don't count). */
export function countWords(html: string): number {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

/** "8 min left", "<1 min left", or '' when nothing useful can be said. */
export function timeLeftLabel(words: number, percent: number, wpm: number): string {
  if (words <= 0 || percent >= 0.995) return '';
  const minutes = (words * (1 - Math.max(0, Math.min(1, percent)))) / Math.max(MIN_WPM, wpm);
  if (minutes < 1) return '<1 min left';
  if (minutes < 60) return `${Math.round(minutes)} min left`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return m > 0 ? `${h} h ${m} min left` : `${h} h left`;
}

export interface PaceState {
  wpm: number;
  /** Words and time gathered since the last estimate. */
  words: number;
  ms: number;
  last: { path: string; percent: number; at: number } | null;
}

export function newPace(wpm = DEFAULT_WPM): PaceState {
  return { wpm, words: 0, ms: 0, last: null };
}

/**
 * Feed a reading position. Only steady forward reading counts: pauses (> 90 s), jumps (slider,
 * chapter list: faster than 1,500 wpm) and going back are ignored. Every ~20 s of reading the pace
 * moves 25 % towards what was measured.
 */
export function notePace(s: PaceState, path: string, percent: number, chapterWords: number, at: number): PaceState {
  const prev = s.last;
  const next: PaceState = { ...s, last: { path, percent, at } };
  if (!prev || prev.path !== path || chapterWords <= 0) return next;
  const dt = at - prev.at;
  const dw = (percent - prev.percent) * chapterWords;
  if (dt <= 0 || dt > 90_000 || dw <= 0) return next;
  if (dw / (dt / 60_000) > 1500) return next; // a jump, not reading
  next.words = s.words + dw;
  next.ms = s.ms + dt;
  if (next.ms >= 20_000) {
    const measured = next.words / (next.ms / 60_000);
    next.wpm = Math.round(Math.max(MIN_WPM, Math.min(MAX_WPM, s.wpm * 0.75 + measured * 0.25)));
    next.words = 0;
    next.ms = 0;
  }
  return next;
}
