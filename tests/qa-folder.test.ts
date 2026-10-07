/**
 * Phone QA loop: the UI trail stays tiny and private (src/ui/native/qa-trail.ts), and the Diagnostics
 * row patch matches v1 exactly once (tools/v1-qa.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeRoute, pushTrail, TRAIL_KEY, TRAIL_MAX, type TrailEntry } from '../src/ui/native/qa-trail.ts';
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

describe('Diagnostics folder row patch', () => {
  it('matches v1 exactly once', () => {
    const src = path.resolve(import.meta.dirname, '..', 'vendor', 'v1', 'src');
    for (const p of qaPatches()) {
      const text = readFileSync(path.join(src, p.file), 'utf8').replace(/\r\n/g, '\n');
      expect(text.match(new RegExp(p.find.source, 'g')) ?? []).toHaveLength(1);
    }
  });
});
