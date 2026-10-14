/**
 * Follow along (src/ui/native/narration-follow.ts): the reader keeps up with the narration, and catches up with it
 * when the app comes back after listening with the phone locked or in the car (Kasta, 2026-10-13). The DOM side runs
 * in the PC shell (tests/shell/narration-follow.shell.ts); native's part (progress saved as the listen goes) is
 * checked on the Swift source here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canReattach,
  FAR_SCREENS,
  missingChapterAction,
  nthInParagraph,
  READER_JUMP_CONTROLS,
  REATTACH_QUIET_MS,
  returnTarget,
  scrollModeFor,
  targetFromState,
  type Heard,
} from '../src/ui/native/narration-follow.ts';
import type { NarrationState } from '../src/ui/native/narration.ts';

const root = path.resolve(import.meta.dirname, '..');
const novel = { pluginId: 'demo', novelPath: 'novel/alpha' };
const playing = (over: Partial<NarrationState> = {}): NarrationState => ({
  status: 'playing',
  engine: 'speech',
  ...novel,
  novelName: 'Alpha',
  chapterPath: 'novel/alpha/3',
  paragraph: 12,
  sentence: 1,
  ...over,
});

describe('scrolling to the spoken sentence', () => {
  const vh = 800;
  it('glides when it is near, jumps when it is far (no long flight through pages)', () => {
    expect(scrollModeFor({ top: 380, bottom: 420 }, vh)).toBe('smooth');
    expect(scrollModeFor({ top: 900, bottom: 940 }, vh)).toBe('smooth');
    expect(scrollModeFor({ top: -600, bottom: -560 }, vh)).toBe('smooth');
    const far = vh / 2 + vh * FAR_SCREENS + 50;
    expect(scrollModeFor({ top: far, bottom: far + 40 }, vh)).toBe('instant');
    expect(scrollModeFor({ top: -far, bottom: -far + 40 }, vh)).toBe('instant');
  });

  it('picks up following by itself only with the sentence on screen and the finger still for a while', () => {
    const now = 100_000;
    const quiet = now - REATTACH_QUIET_MS - 1;
    expect(canReattach({ top: 300, bottom: 340 }, vh, quiet, now)).toBe(true);
    // Still scrolling: no.
    expect(canReattach({ top: 300, bottom: 340 }, vh, now - 1000, now)).toBe(false);
    // Scrolled away (the sentence is above or below the screen): stays put, the pill brings it back.
    expect(canReattach({ top: -200, bottom: -160 }, vh, quiet, now)).toBe(false);
    expect(canReattach({ top: 900, bottom: 940 }, vh, quiet, now)).toBe(false);
  });
});

describe('where the narration is', () => {
  it("native's state is the position; the last report adds the exact sentence when it is the same one", () => {
    const heard: Heard = { chapterPath: 'novel/alpha/3', engine: 'speech', paragraph: 12, sentence: 1, block: 14, start: 20, end: 61, hash: 7, at: 5 };
    expect(targetFromState(playing(), heard)).toEqual({ ...novel, novelName: 'Alpha', chapterPath: 'novel/alpha/3', engine: 'speech', paragraph: 12, sentence: 1, block: 14, start: 20, end: 61, hash: 7 });
    // An older report (the WebView slept while native went on): the state's sentence, without a stale range.
    const old: Heard = { ...heard, chapterPath: 'novel/alpha/2', paragraph: 40 };
    expect(targetFromState(playing(), old)).toEqual({ ...novel, novelName: 'Alpha', chapterPath: 'novel/alpha/3', engine: 'speech', paragraph: 12, sentence: 1 });
    expect(targetFromState(playing(), { ...heard, sentence: 0 })?.block).toBeUndefined();
  });

  it('audio: matched by segment', () => {
    const heard: Heard = { chapterPath: 'novel/alpha/3', engine: 'audio', paragraph: 9, segment: 31, block: 9, start: 0, end: 30, at: 5 };
    expect(targetFromState(playing({ engine: 'audio', paragraph: 9, sentence: undefined, segment: 31 }), heard)?.block).toBe(9);
    expect(targetFromState(playing({ engine: 'audio', paragraph: 9, sentence: undefined, segment: 32 }), heard)).toMatchObject({ engine: 'audio', segment: 32, paragraph: 9 });
  });

  it('stopped (no chapter in the state): the sentence heard last, if its novel is known', () => {
    const heard: Heard = { chapterPath: 'novel/alpha/4', engine: 'speech', paragraph: 3, ...novel, at: 5 };
    expect(targetFromState({ status: 'idle' }, heard)).toEqual({ chapterPath: 'novel/alpha/4', engine: 'speech', paragraph: 3, ...novel });
    expect(targetFromState({ status: 'idle' }, { chapterPath: 'x', paragraph: 0, at: 5 })).toBeNull();
    expect(targetFromState(null, null)).toBeNull();
  });
});

describe('back in the app', () => {
  const hiddenAt = 1000;
  it('jumps while narration plays (the car, the lock screen), whatever was heard', () => {
    expect(returnTarget(playing(), null, hiddenAt)).toMatchObject({ chapterPath: 'novel/alpha/3', paragraph: 12 });
    expect(returnTarget(playing({ status: 'loading' }), null, hiddenAt)).not.toBeNull();
  });

  it('jumps to where it ended or stopped when it was narrated while away', () => {
    const heard: Heard = { chapterPath: 'novel/alpha/9', engine: 'speech', paragraph: 30, ...novel, at: hiddenAt + 60_000 };
    expect(returnTarget({ status: 'ended', ...novel, chapterPath: 'novel/alpha/9', paragraph: 30 }, heard, hiddenAt)).toMatchObject({ chapterPath: 'novel/alpha/9', paragraph: 30 });
    expect(returnTarget({ status: 'idle' }, heard, hiddenAt)).toMatchObject({ chapterPath: 'novel/alpha/9', paragraph: 30 });
  });

  it('stays put when nothing was narrated meanwhile (paused all along, or not listening)', () => {
    const before: Heard = { chapterPath: 'novel/alpha/3', paragraph: 12, ...novel, at: hiddenAt - 1 };
    expect(returnTarget(playing({ status: 'paused' }), before, hiddenAt)).toBeNull();
    expect(returnTarget({ status: 'idle' }, before, hiddenAt)).toBeNull();
    expect(returnTarget({ status: 'idle' }, null, hiddenAt)).toBeNull();
  });
});

describe('a narrated chapter the reader does not have', () => {
  const base = { sectionMounted: false, forced: false, attached: true, followedMounted: true };
  it('waits for a chapter continuous scroll is loading', () => {
    expect(missingChapterAction({ ...base, sectionMounted: true })).toBe('wait');
    expect(missingChapterAction({ ...base, sectionMounted: true, forced: true })).toBe('wait');
  });
  it('switches at once when asked (Back to narration, back in the app)', () => {
    expect(missingChapterAction({ ...base, forced: true, attached: false, followedMounted: false })).toBe('switch');
  });
  it('switches after a grace when narration ran on past what the reader shows while it followed', () => {
    expect(missingChapterAction(base)).toBe('switch-soon');
  });
  it("leaves a reader the user took elsewhere (another chapter opened or jumped to): the pill offers the way back", () => {
    expect(missingChapterAction({ ...base, followedMounted: false })).toBe('detach');
    expect(missingChapterAction({ ...base, attached: false })).toBe('none');
  });
});

describe('the sentence by its number in the paragraph (native state has no range)', () => {
  const items = [
    { paragraph: 0, id: 'title' },
    { paragraph: 1, id: 'a' },
    { paragraph: 1, id: 'b' },
    { paragraph: 2, id: 'c' },
    { paragraph: 1, id: 'd' },
  ];
  it('counts per paragraph in script order', () => {
    expect(nthInParagraph(items, 1, 0)?.id).toBe('a');
    expect(nthInParagraph(items, 1, 1)?.id).toBe('b');
    expect(nthInParagraph(items, 1, 2)?.id).toBe('d');
    expect(nthInParagraph(items, 2, 0)?.id).toBe('c');
    expect(nthInParagraph(items, 1, 3)).toBeNull();
    expect(nthInParagraph(items, 7, 0)).toBeNull();
  });
});

describe("the reader's own jumps let go of the narration", () => {
  it("covers v1's jump controls (reader.tsx goTo callers)", () => {
    const reader = readFileSync(path.join(root, 'vendor', 'v1', 'src', 'ui', 'screens', 'reader', 'reader.tsx'), 'utf8');
    for (const id of ['reader-prev', 'reader-next', 'reader-next-link', 'reader-jump-back', 'reader-slider']) {
      expect(reader).toContain(`data-testid="${id}"`);
      expect(READER_JUMP_CONTROLS).toContain(`[data-testid="${id}"]`);
    }
    expect(reader).toContain('chapter-row');
  });
});

describe('native: the listening position is the reading progress', () => {
  const swift = readFileSync(path.join(root, 'ios', 'App', 'App', 'Native', 'Narration', 'NarrationController.swift'), 'utf8');
  const save = /private func saveProgress\(force: Bool, finished: Bool = false\) \{([\s\S]*?)\n {4}\}/.exec(swift)?.[1] ?? '';

  it('saves every few seconds, and at once when a new chapter starts', () => {
    expect(save).toContain('CoreHost.shared.request("progress.save"');
    expect(save).toMatch(/guard force \|\| ch\.chapterPath != lastSavedChapterPath \|\| Date\(\)\.timeIntervalSince\(lastSavedAt\) > 5 else \{ return \}/);
    expect(save).toContain('lastSavedChapterPath = ch.chapterPath');
  });

  it('saves on pause, stop and at the end of each chapter', () => {
    expect(swift).toMatch(/set\(\.paused\)\n\s+saveProgress\(force: true\)/);
    expect(swift).toMatch(/func stop\(\) \{[\s\S]*?saveProgress\(force: true\)/);
    expect(swift).toMatch(/private func finishChapter\(\) \{\n\s+saveProgress\(force: true, finished: true\)/);
  });
});
