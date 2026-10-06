/** In the car: "Prepare for the drive" status words, the Help answers, and the native wiring (Info.plist, plugin methods). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HelpTopic } from '@v1/ui/lib/help-data.ts';
import { driveLine, formatBytes, formatDuration, jobProgress, normalizeDriveStatus, storageLine } from '../src/ui/native/drive-status.ts';
import type { DriveJobInfo, DriveStatus } from '../src/ui/native/narration.ts';
import { CAR_HELP, installCarHelp } from '../src/ui/native/help-car.ts';

const root = path.resolve(import.meta.dirname, '..');
const KEY = 'src:novel';

function job(over: Partial<DriveJobInfo>): DriveJobInfo {
  return { novelKey: KEY, pluginId: 'src', novelPath: 'novel', novelName: 'Novel', count: 5, done: 1, titles: ['One'], when: 'now', voice: 'af_heart', state: 'running', ...over };
}

function status(over: Partial<DriveStatus>): DriveStatus {
  return { ...normalizeDriveStatus(null), ...over };
}

describe('Prepare for the drive: status words', () => {
  it('formats sizes and lengths', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(400_000)).toBe('<1 MB');
    expect(formatBytes(21_400_000)).toBe('21 MB');
    expect(formatBytes(1_250_000_000)).toBe('1.3 GB');
    expect(formatBytes(Number.NaN)).toBe('0 MB');
    expect(formatDuration(59)).toBe('1 min');
    expect(formatDuration(19 * 60 + 10)).toBe('19 min');
    expect(formatDuration(75 * 60)).toBe('1 h 15 min');
  });

  it('progress counts the chapter being rendered', () => {
    expect(jobProgress(job({ done: 1, count: 4, current: { chapterPath: 'c2', title: 'Two', sentence: 50, sentences: 100 } }))).toBeCloseTo(0.375);
    expect(jobProgress(job({ done: 4, count: 4 }))).toBe(1);
    expect(jobProgress(job({ count: 0 }))).toBe(0);
  });

  it('says what is happening for one novel', () => {
    const running = status({ jobs: [job({ current: { chapterPath: 'c2', title: 'Two', sentence: 30, sentences: 60 } })] });
    expect(driveLine(running, KEY)).toBe('Preparing 2 of 5 · 30%');
    expect(driveLine(status({ jobs: [job({ state: 'waiting', reason: 'Waiting for charging or Wi-Fi', done: 2 })] }), KEY)).toBe('Waiting for charging or Wi-Fi · 2 of 5 ready');
    expect(driveLine(status({ jobs: [job({ state: 'failed', error: 'offline' })] }), KEY)).toBe('Stopped: offline');
    const ready = status({
      jobs: [job({ state: 'done', done: 2, count: 2 })],
      prepared: [
        { novelKey: KEY, chapterPath: 'c1', title: 'One', voice: 'af_heart', bytes: 7_000_000, durationSec: 900, createdAt: 1 },
        { novelKey: KEY, chapterPath: 'c2', title: 'Two', voice: 'af_heart', bytes: 8_000_000, durationSec: 950, createdAt: 2 },
        { novelKey: 'other:n', chapterPath: 'x', title: 'X', voice: 'af_heart', bytes: 9_000_000, durationSec: 950, createdAt: 3 },
      ],
      totalBytes: 24_000_000,
    });
    expect(driveLine(ready, KEY)).toBe('2 chapters ready · 15 MB');
    expect(driveLine(ready, 'nothing:here')).toMatch(/^Kokoro reads the next chapters ahead/);
    expect(storageLine(ready)).toBe('3 chapters · 24 MB');
    expect(storageLine(normalizeDriveStatus({}))).toBe('Nothing prepared');
  });

  it('tolerates empty or broken answers (older builds, mocks)', () => {
    expect(normalizeDriveStatus(undefined)).toEqual({ jobs: [], prepared: [], bytes: 0, totalBytes: 0, capBytes: 0 });
    expect(normalizeDriveStatus({ jobs: 'x', prepared: null, bytes: '3' })).toEqual({ jobs: [], prepared: [], bytes: 0, totalBytes: 0, capBytes: 0 });
  });
});

describe('Help › Listening › the car', () => {
  // v1's Help (vendor/v1/src/ui/lib/help-data.ts) can't be loaded by vitest; the same shape:
  const copy = (): HelpTopic[] => [
    { title: 'Getting Started', items: [{ id: 'find', q: 'How do I find novels?', a: 'Open Browse.' }] },
    {
      title: 'Listening',
      items: [
        { id: 'car', q: 'Can I listen to a novel in the car?', a: 'Yes, with your PC’s help … BookPlayer …' },
        { id: 'car-next', q: 'How do I get the next chapters narrated?', a: 'Delete files from TachiNovel Audio …' },
        { id: 'voices', q: 'Other listening question', a: 'Kept.' },
      ],
    },
  ];

  it("replaces v1's PC-narrator answers with v2's, once", () => {
    const topics = copy();
    installCarHelp(topics);
    installCarHelp(topics);
    const listening = topics.find((t) => t.title === 'Listening');
    const ids = listening?.items.map((i) => i.id) ?? [];
    expect(ids.slice(0, CAR_HELP.length)).toEqual(CAR_HELP.map((i) => i.id));
    expect(ids).not.toContain('car-next');
    expect(ids.filter((i) => i === 'car')).toHaveLength(1);
    expect(JSON.stringify(listening)).not.toMatch(/BookPlayer/);
    expect(ids.at(-1)).toBe('voices');
    const all = topics.flatMap((t) => t.items.map((i) => i.id));
    expect(new Set(all).size).toBe(all.length);
  });

  it('mentions the settings it points to', () => {
    const text = CAR_HELP.map((i) => i.a).join(' ');
    expect(text).toContain('Prepare for the drive');
    expect(text).toContain('More › Voices › In the car › Car buttons');
    expect(text).toMatch(/Hey Siri/);
  });
});

describe('native wiring', () => {
  const plist = readFileSync(path.join(root, 'ios', 'App', 'App', 'Info.plist'), 'utf8');

  it('Info.plist: background audio + processing, the drive task, and CarPlay templates behind the flag', () => {
    expect(plist).toMatch(/<key>UIBackgroundModes<\/key>\s*<array>[^]*?<string>audio<\/string>[^]*?<string>processing<\/string>[^]*?<\/array>/);
    expect(plist).toContain('<string>app.tachinovel.drive-prep</string>');
    expect(plist).toMatch(/<key>TNCarPlayTemplates<\/key>\s*<string>\$\(TN_CARPLAY_TEMPLATES\)<\/string>/);
    expect(plist).not.toContain('CPTemplateApplicationSceneSessionRoleApplication');
    const swift = readFileSync(path.join(root, 'ios', 'App', 'App', 'Native', 'Narration', 'DrivePrep.swift'), 'utf8');
    expect(swift).toContain('static let taskId = "app.tachinovel.drive-prep"');
  });

  it('the Narration plugin registers the car methods the UI calls', () => {
    const swift = readFileSync(path.join(root, 'ios', 'App', 'App', 'Native', 'Narration', 'NarrationPlugin.swift'), 'utf8');
    const methods = [...swift.matchAll(/CAPPluginMethod\(name: "([A-Za-z]+)"/g)].map((m) => m[1]);
    for (const m of ['prepareDrive', 'cancelDrive', 'driveStatus', 'clearDrive', 'nowPlaying', 'remoteCommand', 'selfTestChapters']) {
      expect(methods, m).toContain(m);
      expect(swift, m).toContain(`@objc func ${m}(_ call: CAPPluginCall)`);
    }
  });
});
