/**
 * The reader keeps up with the narration ("follow along"), the decisions behind it (narration-overlay.ts does the DOM):
 *
 * - While the reader is on screen it follows the spoken sentence (centered; a glide when near, a jump when far).
 * - A finger in the reader (drag, the slider, prev/next, the chapter list, "Back to Ch. …") lets go of the narration:
 *   the reader stays where the user put it and a "Back to narration" pill brings it back. Following picks up again
 *   by itself only when the spoken sentence is on screen and the finger has been still for a few seconds.
 * - Back in the app after listening with the phone locked or in the car (Kasta, 2026-10-13: "when I open the app
 *   again, it just jumps to where the current listen is"): the reader jumps to the sentence being spoken (or heard
 *   last), switching to the chapter narration went on to, and marks it briefly.
 * - Narration that runs on into a chapter the reader doesn't have (continuous scroll off, or the next chapter not
 *   appended yet) switches the reader to it, but only while the reader is following.
 * Reading progress itself follows the narration natively (NarrationController.saveProgress: every few seconds and
 * at once when the chapter changes), so the library, History and the reader's resume point match the listen.
 */
import type { NarrationProgress, NarrationState } from './narration.ts';

/** A place in the narration the reader can go to: a progress report plus the novel it belongs to. */
export interface FollowTarget extends NarrationProgress {
  pluginId: string;
  novelPath: string;
  novelName?: string;
}

/** The latest progress report, when it came and which novel was playing then. */
export interface Heard extends NarrationProgress {
  pluginId?: string;
  novelPath?: string;
  novelName?: string;
  at: number;
}

/** Farther than this many screen heights from the middle of the screen, the reader jumps instead of gliding. */
export const FAR_SCREENS = 1.5;
/** How long the finger must have been still before following picks up again by itself. */
export const REATTACH_QUIET_MS = 4000;
/** Grace for continuous scroll to append the chapter narration went on to, before the reader switches to it. */
export const SWITCH_GRACE_MS = 1500;
/** The same chapter switch is not repeated within this long (a chapter that fails to open must not loop). */
export const SWITCH_REPEAT_MS = 8000;

/**
 * The reader's own controls that move it somewhere else (v1 reader.tsx `goTo`/`rememberJump`): previous/next chapter,
 * the end-of-chapter link, "Back to Ch. …", the progress slider, the chapter list rows and the find bar.
 */
export const READER_JUMP_CONTROLS = [
  '[data-testid="reader-prev"]',
  '[data-testid="reader-next"]',
  '[data-testid="reader-next-link"]',
  '[data-testid="reader-jump-back"]',
  '[data-testid="reader-slider"]',
  '.chapter-row',
  '.find-bar',
].join(',');

/** Glide to an element near the middle of the screen; jump to one farther away (a long glide flies through pages). */
export function scrollModeFor(rect: { top: number; bottom: number }, viewportHeight: number): 'smooth' | 'instant' {
  const middle = (rect.top + rect.bottom) / 2;
  return Math.abs(middle - viewportHeight / 2) > viewportHeight * FAR_SCREENS ? 'instant' : 'smooth';
}

/** Following picks up again by itself: the spoken sentence is on screen and the finger has been still for a while. */
export function canReattach(rect: { top: number; bottom: number }, viewportHeight: number, lastUserScroll: number, now: number): boolean {
  return now - lastUserScroll > REATTACH_QUIET_MS && rect.bottom > 0 && rect.top < viewportHeight;
}

/**
 * The narration's position now: native's state (authoritative: it kept playing while the WebView was asleep), with the
 * sentence detail of the last progress report (block/start/end for the exact sentence, segment for audio) when that
 * report is about the same sentence. Without a chapter in the state (stopped), the last report.
 */
export function targetFromState(s: NarrationState | null, heard: Heard | null): FollowTarget | null {
  if (s?.chapterPath && s.pluginId && s.novelPath) {
    const same =
      heard && heard.chapterPath === s.chapterPath
        ? s.engine === 'audio'
          ? s.segment === undefined || heard.segment === s.segment
          : heard.paragraph === s.paragraph && (s.sentence === undefined || heard.sentence === s.sentence)
        : false;
    if (same && heard) return withNovel(heard, s.pluginId, s.novelPath, s.novelName);
    const t: FollowTarget = { pluginId: s.pluginId, novelPath: s.novelPath, chapterPath: s.chapterPath, paragraph: s.paragraph ?? 0 };
    if (s.novelName) t.novelName = s.novelName;
    if (s.engine) t.engine = s.engine;
    if (s.sentence !== undefined) t.sentence = s.sentence;
    if (s.segment !== undefined) t.segment = s.segment;
    return t;
  }
  if (heard?.pluginId && heard.novelPath) return withNovel(heard, heard.pluginId, heard.novelPath, heard.novelName);
  return null;
}

function withNovel(h: Heard, pluginId: string, novelPath: string, novelName: string | undefined): FollowTarget {
  const { at: _at, pluginId: _p, novelPath: _n, novelName: _nn, ...progress } = h;
  return { ...progress, pluginId, novelPath, ...(novelName ? { novelName } : {}) };
}

/**
 * Back in the app (or back to the reader): where the reader should go, or null when nothing was narrated meanwhile.
 * Narration that is playing (or loading the next chapter) counts; so does one that played while away and has since
 * stopped or ended (the reader goes to the sentence heard last). Paused all along with nothing new: the reader stays
 * where it is (the user may have scrolled away on purpose).
 */
export function returnTarget(s: NarrationState | null, heard: Heard | null, since: number): FollowTarget | null {
  const playing = s?.status === 'playing' || s?.status === 'loading';
  const heardSince = !!heard && heard.at > since;
  if (!playing && !heardSince) return null;
  return targetFromState(s, heard);
}

/**
 * What to do when the chapter being narrated has no text in the reader:
 *  - 'wait': its section is there, still loading (continuous scroll appended it): it is painted once its text is in;
 *  - 'switch': open the reader on that chapter now (the user asked: "Back to narration", or back in the app);
 *  - 'switch-soon': the reader was following and narration ran on past what it shows: switch after a short grace,
 *    unless continuous scroll appends the chapter meanwhile;
 *  - 'detach': the reader no longer shows where narration was (the user opened or jumped to another chapter): leave
 *    it there, the pill offers the way back;
 *  - 'none': not following, nothing to do.
 */
export type MissingAction = 'wait' | 'switch' | 'switch-soon' | 'detach' | 'none';

export function missingChapterAction(o: { sectionMounted: boolean; forced: boolean; attached: boolean; followedMounted: boolean }): MissingAction {
  if (o.sectionMounted) return 'wait';
  if (o.forced) return 'switch';
  if (!o.attached) return 'none';
  return o.followedMounted ? 'switch-soon' : 'detach';
}

/** The sentence of a progress report that has no canonical range: the `sentence`-th of its paragraph (native numbers
 * sentences per paragraph in script order, NarrationController.items(for:)). */
export function nthInParagraph<T extends { paragraph: number }>(items: readonly T[], paragraph: number, sentence: number): T | null {
  let n = 0;
  for (const it of items) {
    if (it.paragraph !== paragraph) continue;
    if (n === sentence) return it;
    n++;
  }
  return null;
}
