/**
 * "Download with audio" part 2 (src/ui/native/audio-status.ts, src/core/auto-audio.ts, tools/v1-audio.ts): the words
 * the card, queue and storage rows show, the chapter badges, which chapters a choice means, the estimate and the space
 * check, the auto-download report to native, the build-time patches of v1's pages, and the native wiring.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { reportAutoDownloads, type AutoDownloaded } from '../src/core/auto-audio.ts';
import {
  badgeSignature,
  buildBadges,
  byNovel,
  cardLine,
  estimateWords,
  finishedDownloads,
  jobChapter,
  jobState,
  normalizeAudioStatus,
  pickChapters,
  reasonWords,
  resumeIndex,
  spaceProblem,
  storageValue,
  voiceLine,
} from '../src/ui/native/audio-status.ts';
import type { AudioEstimate, AudioStatus, DriveJobInfo, PreparedChapterInfo } from '../src/ui/native/narration.ts';
import { audioPatches } from '../tools/v1-audio.ts';

const root = path.resolve(import.meta.dirname, '..');
const KEY = 'src:novel';

function job(over: Partial<DriveJobInfo>): DriveJobInfo {
  return {
    novelKey: KEY, key: `${KEY}\u001fdownload`, kind: 'download', pluginId: 'src', novelPath: 'novel', novelName: 'Shadow Slave', count: 12, done: 2,
    titles: [], when: 'now', voice: 'nephis', state: 'running', chapters: [], ...over,
  };
}

function entry(over: Partial<PreparedChapterInfo>): PreparedChapterInfo {
  return { novelKey: KEY, chapterPath: 'c1', title: 'Chapter 1', voice: 'v', bytes: 16_000_000, durationSec: 1000, createdAt: 1, kind: 'download', fresh: true, ...over };
}

function status(over: Partial<AudioStatus>): AudioStatus {
  return { ...normalizeAudioStatus(null), ...over };
}

describe('audio status words', () => {
  it('tolerates empty or broken answers', () => {
    const s = normalizeAudioStatus({ jobs: 'x', audio: [null, { novelKey: KEY }], totalBytes: '3', voice: 'kokoro', autoDownloadAudio: true });
    expect(s.jobs).toEqual([]);
    expect(s.audio).toHaveLength(1);
    expect(s.totalBytes).toBe(0);
    expect(s.voice).toBe('kokoro');
    expect(s.autoDownloadAudio).toBe(true);
    expect(normalizeAudioStatus(undefined).voice).toBe('nephis');
  });

  it('the novel card says what is going on, then what is ready', () => {
    const running = status({ jobs: [job({ current: { chapterPath: 'c3', title: 'Chapter 3', sentence: 50, sentences: 100 } })] });
    expect(cardLine(running, KEY)).toBe('Downloading 3 of 12 · Audio 21 %');
    expect(cardLine(status({ jobs: [job({ state: 'waiting', reason: 'Waiting for charging' })] }), KEY)).toBe('Waiting for charging · 2 of 12 ready');
    expect(cardLine(status({ jobs: [job({ state: 'waiting', reason: 'Waiting for the iPhone to cool down' })] }), KEY)).toBe('Paused: iPhone is hot · 2 of 12 ready');
    expect(cardLine(status({ jobs: [job({ state: 'failed', error: 'Couldn’t load c3' })] }), KEY)).toBe('Stopped after 3 tries: Couldn’t load c3');
    const ready = status({ jobs: [job({ state: 'done', done: 2, count: 2 })], audio: [entry({}), entry({ chapterPath: 'c2' }), entry({ chapterPath: 'c9', fresh: false })] });
    // Audio of an older voice never plays, so it isn't "ready".
    expect(cardLine(ready, KEY)).toBe('2 chapters ready to listen offline · 32 MB');
    expect(cardLine(ready, 'other:x')).toBe('Nephis reads chapters into audio ahead of time');
  });

  it('the queue rows: text and audio progress, waits, failures', () => {
    const cur = { chapterPath: 'c3', title: 'Chapter 3', sentence: 42, sentences: 100 };
    expect(jobState(job({ current: cur }))).toBe('Text ✓ · Audio 42 %');
    expect(jobState(job({ current: cur }), { done: 3, total: 12, finished: false })).toBe('Text 3 of 12 · Audio 42 %');
    expect(jobState(job({ current: { ...cur, step: 'director' } }))).toBe('Text ✓ · Reading the chapter for her moods');
    expect(jobState(job({ state: 'waiting', reason: 'Paused while you listen' }))).toBe('Paused while you listen');
    expect(jobState(job({ state: 'waiting', reason: 'Waiting for the iPhone to cool down' }))).toBe('Paused: iPhone is hot');
    expect(jobState(job({ state: 'failed', error: 'offline' }))).toBe('Stopped after 3 tries: offline');
    expect(jobState(job({ state: 'paused' }))).toBe('Paused');
    expect(reasonWords(undefined)).toBe('Waiting');
    expect(jobChapter(job({ current: cur }))).toBe('Chapter 3');
    expect(jobChapter(job({ state: 'waiting' }))).toBe('2 of 12 ready');
  });

  it('storage: the row value and each novel’s audio', () => {
    expect(storageValue(status({}))).toBe('None');
    const s = status({
      jobs: [job({ novelName: 'Shadow Slave' })],
      audio: [entry({}), entry({ chapterPath: 'c2', bytes: 4_000_000 }), entry({ novelKey: 'b:x', bytes: 40_000_000, novelName: 'Other' })],
      totalBytes: 60_000_000,
    });
    expect(storageValue(s)).toBe('60 MB · 3 chapters');
    expect(byNovel(s).map((n) => [n.novelKey, n.name, n.count, n.bytes])).toEqual([
      ['b:x', 'x', 1, 40_000_000],
      [KEY, 'Shadow Slave', 2, 20_000_000],
    ]);
  });

  it('badges: audio, a ring for the chapter being made, and a change-only signature', () => {
    const s = status({ audio: [entry({}), entry({ chapterPath: 'old', fresh: false })], jobs: [job({ current: { chapterPath: 'c3', title: '3', sentence: 47, sentences: 100 } })] });
    const b = buildBadges(s);
    expect(b.get(`${KEY}\u001fc1`)).toBe('audio');
    expect(b.has(`${KEY}\u001fold`)).toBe(false);
    expect(b.get(`${KEY}\u001fc3`)).toBe(0.4);
    // 47 % and 49 % are the same badge: the chapter list doesn't re-render for every sentence.
    const s2 = status({ ...s, jobs: [job({ current: { chapterPath: 'c3', title: '3', sentence: 49, sentences: 100 } })] });
    expect(badgeSignature(buildBadges(s2))).toBe(badgeSignature(b));
  });

  it('a finished download (for the toast while the app is open)', () => {
    const before = status({ jobs: [job({})] });
    const after = status({ jobs: [job({ state: 'done', done: 12 })] });
    expect(finishedDownloads(before, after).map((j) => j.done)).toEqual([12]);
    expect(finishedDownloads(after, after)).toEqual([]);
    expect(finishedDownloads(status({}), after)).toEqual([]);
  });
});

describe('which chapters', () => {
  const list = [
    { path: 'c1', read: true },
    { path: 'c2', read: true },
    { path: 'c3', read: false },
    { path: 'c4', read: false, locked: true },
    ...Array.from({ length: 12 }, (_, i) => ({ path: `c${i + 5}`, read: false })),
  ];

  it('starts where reading would go on', () => {
    expect(resumeIndex(list, undefined)).toBe(2);
    expect(resumeIndex(list, { chapterPath: 'c2', position: { percent: 0.4 } })).toBe(1);
    expect(resumeIndex(list, { chapterPath: 'c2', position: { percent: 1 } })).toBe(2);
    expect(resumeIndex(list, { chapterPath: 'c6' })).toBe(5);
  });

  it('Next 5 / Next 10 / Unread / Selected skip locked chapters, in reading order', () => {
    expect(pickChapters(list, 'next5', 2)).toEqual(['c3', 'c5', 'c6', 'c7', 'c8']);
    expect(pickChapters(list, 'next10', 2)).toHaveLength(10);
    expect(pickChapters(list, 'unread', 0)).toHaveLength(13);
    expect(pickChapters(list, 'selected', 0, [5, 3, 0])).toEqual(['c1', 'c6']);
    expect(pickChapters(list, 'next5', -1)).toEqual(['c1', 'c2', 'c3', 'c5', 'c6']);
  });
});

describe('estimate and space', () => {
  const est = (over: Partial<AudioEstimate>): AudioEstimate => ({
    minutes: 200, megabytes: 192, renderMinutes: 130, bitRate: 128_000, megabytesPerMinute: 0.96, speedX: 1.5, measured: true, freeBytes: 5e9, ...over,
  });

  it('in all, per chapter, and the time to make it', () => {
    expect(estimateWords(est({}), 12)).toEqual({ total: '192 MB', detail: 'About 16 MB a chapter · ready in about 2 h 10 min' });
    expect(estimateWords(null, 3)).toEqual({ total: '', detail: '' });
  });

  it('refuses below the audio plus 1 GB', () => {
    expect(spaceProblem(est({}))).toBeNull();
    expect(spaceProblem(est({ freeBytes: 1.1e9 }))).toBe('The audio needs 192 MB, and 1 GB should stay free. 1.1 GB is free on this iPhone.');
    expect(spaceProblem(est({ freeBytes: null }))).toBeNull();
  });

  it('the voice line names her packs', () => {
    expect(voiceLine('nephis-r10 · Studio', 'nephis-dialogue')).toBe('Nephis · nephis-r10 + nephis-dialogue');
    expect(voiceLine('nephis-r10', 'Uses the narrator')).toBe('Nephis · nephis-r10');
    expect(voiceLine(null, null)).toBe('Nephis');
  });
});

describe('auto-download report (core)', () => {
  function fakeApp() {
    let resolveRun: (() => void) | null = null;
    const enqueued: string[][] = [];
    const services = {
      downloads: { enqueue: (_n: { pluginId: string; path: string }, paths: readonly string[]) => void enqueued.push([...paths]) },
      autoDownload: { run: (_keys?: readonly string[]) => new Promise<number>((r) => (resolveRun = () => r(1))) },
      history: { all: () => [{ pluginId: 'p', path: 'n', novelName: 'Novel', cover: 'https://c' }] },
    };
    return { services, enqueued, finish: () => resolveRun?.() };
  }

  it('reports what the auto-download queues, not what the user downloads', async () => {
    const app = fakeApp();
    const events: AutoDownloaded[] = [];
    reportAutoDownloads(app as never, (_e, p) => events.push(p));
    app.services.downloads.enqueue({ pluginId: 'p', path: 'n' }, ['c1']);
    expect(events).toEqual([]);
    const run = app.services.autoDownload.run();
    app.services.downloads.enqueue({ pluginId: 'p', path: 'n' }, ['c2', 'c3']);
    expect(events).toEqual([{ pluginId: 'p', novelPath: 'n', chapterPaths: ['c2', 'c3'], novelName: 'Novel', cover: 'https://c' }]);
    app.finish();
    await run;
    await vi.waitFor(() => {
      app.services.downloads.enqueue({ pluginId: 'p', path: 'n' }, ['c4']);
      expect(events).toHaveLength(1);
    });
    expect(app.enqueued).toEqual([['c1'], ['c2', 'c3'], ['c4']]);
  });
});

describe('v1 patches and native wiring', () => {
  it('each patch matches exactly once in vendored v1', () => {
    for (const p of audioPatches()) {
      const text = readFileSync(path.join(root, 'vendor', 'v1', 'src', p.file), 'utf8').replace(/\r\n/g, '\n');
      expect(text.match(new RegExp(p.find.source, 'g'))?.length, p.why).toBe(1);
    }
  });

  it('the Narration plugin answers the screens’ calls; the core event reaches DrivePrep', () => {
    const plugin = readFileSync(path.join(root, 'ios', 'App', 'App', 'Native', 'Narration', 'NarrationPlugin.swift'), 'utf8');
    expect(plugin).toContain('CAPPluginMethod(name: "audioNotifications"');
    expect(plugin).toContain('call.getBool("notify")');
    expect(plugin).toContain('call.getBool("autoDownloadAudio")');
    const drive = readFileSync(path.join(root, 'ios', 'App', 'App', 'Native', 'Narration', 'DrivePrep.swift'), 'utf8');
    expect(drive).toContain('static let autoDownloadedEvent = "v2.autoDownloaded"');
    expect(drive).toContain('AudioReadyNotice.post(');
    expect(drive).toContain('"freeBytes"');
  });
});
