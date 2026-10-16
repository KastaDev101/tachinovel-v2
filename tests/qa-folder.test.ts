/**
 * Phone QA loop: the UI trail stays tiny and private (src/ui/native/qa-trail.ts), the Diagnostics folder row says
 * when the folder stopped working, the Storage page's Voices & models row reads native's storage map, and the
 * row patches match v1 exactly once (tools/v1-qa.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { folderLabel } from '../src/ui/native/diag-folder.ts';
import { describeRoute, pushTrail, TRAIL_KEY, TRAIL_MAX, type TrailEntry } from '../src/ui/native/qa-trail.ts';
import { cleanedMessage, normalizeStorage, storageRowLabel } from '../src/ui/native/storage-native.ts';
import { qaPatches } from '../tools/v1-qa.ts';

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

describe('QA trail', () => {
  it('keeps the newest entries only, each short', () => {
    const store = new MemoryStorage() as unknown as Storage;
    for (let i = 0; i < TRAIL_MAX + 15; i++) pushTrail({ e: 'screen', d: `screen ${i} ${'x'.repeat(300)}` }, store, new Date(Date.UTC(2026, 9, 6, 0, 0, i)));
    const list = JSON.parse(store.getItem(TRAIL_KEY) ?? '[]') as TrailEntry[];
    expect(list).toHaveLength(TRAIL_MAX);
    expect(list[0]?.d.startsWith('screen 15 ')).toBe(true);
    expect(list.every((e) => e.d.length <= 200)).toBe(true);
  });

  it('names screens with titles and ids, never search text', () => {
    expect(describeRoute({ name: 'reader', pluginId: 'stonescape', novelPath: 'shadow', chapterPath: 'shadow/12.00', novelName: 'Shadow Slave' })).toBe(
      'reader: Shadow Slave › shadow/12.00 (stonescape)',
    );
    expect(describeRoute({ name: 'globalSearch', query: 'my private search' })).toBe('globalSearch');
    expect(describeRoute({ name: 'source', pluginId: 'stonescape', query: 'secret' })).toBe('source: stonescape');
  });

  it('survives a broken store', () => {
    const store = new MemoryStorage() as unknown as Storage;
    store.setItem(TRAIL_KEY, '{not json');
    expect(() => pushTrail({ e: 'error', d: 'x' }, store)).not.toThrow();
  });
});

describe('Diagnostics folder and Storage row patches', () => {
  it('matches v1 exactly once', () => {
    const src = path.resolve(import.meta.dirname, '..', 'vendor', 'v1', 'src');
    for (const p of qaPatches()) {
      const text = readFileSync(path.join(src, p.file), 'utf8').replace(/\r\n/g, '\n');
      expect(text.match(new RegExp(p.find.source, 'g')) ?? []).toHaveLength(1);
    }
  });
});

describe('Diagnostics folder row (src/ui/native/diag-folder.ts)', () => {
  it('says when the folder stopped working instead of showing its name', () => {
    expect(folderLabel({ linked: false })).toBe('Off');
    expect(folderLabel({ linked: true, name: 'TachiNovel-Diagnostics', state: 'ok' })).toBe('TachiNovel-Diagnostics');
    expect(folderLabel({ linked: true, name: 'TachiNovel-Diagnostics' })).toBe('TachiNovel-Diagnostics'); // an older build
    expect(folderLabel({ linked: true, name: 'TachiNovel-Diagnostics', state: 'disconnected', problem: 'gone' })).toBe('Disconnected – tap to reconnect');
    expect(folderLabel({ linked: true, name: 'TachiNovel-Diagnostics', state: 'failing' })).toBe('TachiNovel-Diagnostics – not copying');
    // Copies work, but iCloud doesn't take them (2026-10-15: nothing reached the PC for two days).
    expect(folderLabel({ linked: true, name: 'TachiNovel-Diagnostics', state: 'ok', upload: 'iCloud isn’t uploading' })).toBe('TachiNovel-Diagnostics – not uploading');
  });
});

describe('Settings › Storage › Voices & models (src/ui/native/storage-native.ts)', () => {
  const raw = {
    entries: [
      { key: 'packActive', label: 'Nephis voice pack in use', note: 'nephis-7', bytes: 455_000_000, count: 1, leftover: false },
      { key: 'packsOther', label: 'Other voice packs', note: 'nephis-6', bytes: 410_000_000, count: 1, leftover: false },
      { key: 'leftoverInbox', label: 'Copies of shared files', note: '', bytes: 440_000_000, count: 1, leftover: true },
      { key: 'leftoverTemp', label: 'Temporary import files', note: '', bytes: 0, count: 0, leftover: true },
      { key: '', label: 'no key', bytes: 5 },
      { key: 'other', label: 'Other', note: '', bytes: -3, count: 0, leftover: false },
    ],
    totalBytes: 1_305_000_000,
    appBytes: 520_000_000,
  };

  it('reads native’s answer and adds up the leftovers', () => {
    const s = normalizeStorage(raw);
    expect(s?.entries.map((e) => e.key)).toEqual(['packActive', 'packsOther', 'leftoverInbox', 'leftoverTemp', 'other']);
    expect(s?.entries.find((e) => e.key === 'other')?.bytes).toBe(0);
    expect(s?.leftoverBytes).toBe(440_000_000);
    expect(s?.appBytes).toBe(520_000_000);
    expect(normalizeStorage({})).toBeNull();
    expect(normalizeStorage(null)).toBeNull();
  });

  it('labels the Storage row and the clean-up', () => {
    expect(storageRowLabel(normalizeStorage(raw))).toBe('1.3 GB · 440 MB to clean up');
    expect(storageRowLabel(normalizeStorage({ ...raw, entries: raw.entries.slice(0, 2) }))).toBe('1.3 GB');
    expect(storageRowLabel(null)).toBe('');
    expect(cleanedMessage(0, 0)).toBe('Nothing to clean up.');
    expect(cleanedMessage(1, 440_000_000)).toBe('Removed 1 leftover, freed 440 MB.');
    expect(cleanedMessage(3, 1_300_000_000)).toBe('Removed 3 leftovers, freed 1.3 GB.');
  });
});
