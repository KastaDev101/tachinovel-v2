import { describe, expect, it } from 'vitest';
import { deletePrompt, madeLabel, normalizePacks, packLine, packsSummary } from '../src/ui/native/voice-packs.ts';

const raw = {
  packs: [
    { id: 'p0123456789abcdef', name: 'nephis-r10', made: '2026-10-12', studio: true, bytes: 455_000_000, active: true },
    { id: 'pfedcba9876543210', name: 'nephis-r9', made: '2026-10-11T22:10:00Z', studio: false, bytes: 380_000_000, active: false },
  ],
  active: 'p0123456789abcdef',
  totalBytes: 835_000_000,
};

describe('Settings › Voices › Voice packs (src/ui/native/voice-packs.ts)', () => {
  it('reads native’s answer and drops what it can’t use', () => {
    const list = normalizePacks(raw);
    expect(list?.packs.map((p) => p.name)).toEqual(['nephis-r10', 'nephis-r9']);
    expect(list?.totalBytes).toBe(835_000_000);
    expect(normalizePacks({ packs: [{ name: 'no id' }, { id: 'p1', name: ' ', bytes: Number.NaN }] })).toEqual({
      packs: [{ id: 'p1', name: 'Unnamed pack', made: null, studio: false, bytes: 0, active: false }],
      totalBytes: 0,
    });
    // An older build (the method isn't there, or answers something else).
    expect(normalizePacks(undefined)).toBeNull();
    expect(normalizePacks({ available: true })).toBeNull();
  });

  it('says each pack in plain words', () => {
    const [a, b] = normalizePacks(raw)?.packs ?? [];
    expect(a && packLine(a)).toBe('Made Oct 12, 2026 · Studio · 455 MB');
    expect(b && packLine(b)).toBe('Made Oct 11, 2026 · No studio · 380 MB');
    expect(madeLabel('r9 build')).toBe('r9 build');
    expect(madeLabel(null)).toBeNull();
    expect(packsSummary(normalizePacks(raw))).toBe('nephis-r10 · 2 packs · 835 MB');
    expect(packsSummary({ packs: [], totalBytes: 0 })).toBe('None yet: open a .tnmodel file to add one');
    expect(packsSummary(null)).toBe('Her model packs on this iPhone');
  });

  it('asks before deleting, and says what she reads with when it is hers', () => {
    const list = normalizePacks(raw);
    if (!list) throw new Error('no list');
    expect(deletePrompt(list, 'pfedcba9876543210')).toBe('Delete “nephis-r9”? Frees 380 MB.');
    expect(deletePrompt(list, 'p0123456789abcdef')).toBe('Nephis reads with this pack. Delete it (frees 455 MB) and switch her to “nephis-r9”?');
    const last = { packs: list.packs.slice(0, 1), totalBytes: 455_000_000 };
    expect(deletePrompt(last, 'p0123456789abcdef')).toBe('Nephis reads with this pack. Delete it (frees 455 MB)? She’ll read with the voice the app came with.');
    expect(deletePrompt(list, 'gone')).toBe('');
  });
});
