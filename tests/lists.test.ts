import { describe, expect, it } from 'vitest';
import { compactLists, findLists, summarizeList, type ListMemory } from '../src/core/narration/lists.ts';

const names = ['Copper Key', 'Quiet Lamp', 'Glass Feather', 'River Stone', 'Hollow Drum', 'Ember Thread', 'Paper Crown', 'Salt Mirror'];
const listText = (xs: string[]): string => `Relics: ${xs.map((x) => `[${x}]`).join(', ')}.`;

describe('LitRPG lists', () => {
  it('finds a long bracketed list with its label, across a stray period', () => {
    const t = `Rank: Adept. ${listText(names.slice(0, 5))} [${names[5]}]. [${names[6]}], [${names[7]}]. Then she left.`;
    const [s] = findLists(t);
    expect(s?.label).toBe('Relics');
    expect(s?.items).toEqual(names);
    expect(t.slice(s!.start, s!.end)).toMatch(/^Relics: \[Copper Key\].*\[Salt Mirror\]$/);
  });

  it('leaves short lists alone', () => {
    expect(findLists('Class: [Archer], [Scout], [Guide].')).toEqual([]);
  });

  it('summarizes the first time, then says only what changed', () => {
    const span = findLists(listText(names))[0]!;
    expect(summarizeList(span)).toBe('Relics: 8 in all, including Copper Key, Quiet Lamp and Glass Feather.');
    expect(summarizeList(span, names.slice(0, 6))).toBe('Relics: 8. New: Paper Crown and Salt Mirror.');
    expect(summarizeList(span, names)).toBe('Relics: 8, no change.');
  });

  it('replaces the sentences of the list with one summary that spans them all', () => {
    const block = `Rank: Adept. ${listText(names.slice(0, 5))} [${names[5]}]. [${names[6]}], [${names[7]}]. Then she left.`;
    const cut = (a: string, b: string): [number, number] => [block.indexOf(a), block.indexOf(b) + b.length];
    const mk = (r: [number, number]) => ({ block: 0, start: r[0], end: r[1], text: block.slice(r[0], r[1]) });
    const items = [mk(cut('Rank', 'Adept.')), mk(cut('Relics', `${names[5]}].`)), mk(cut(`[${names[6]}]`, `${names[7]}].`)), mk(cut('Then', 'left.'))];
    const store = new Map<string, readonly string[]>();
    const memory: ListMemory = { previous: (l) => store.get(l), remember: (l, xs) => void store.set(l, xs) };
    const out = compactLists(items, () => block, memory);
    expect(out.map((x) => x.text)).toEqual(['Rank: Adept.', 'Relics: 8 in all, including Copper Key, Quiet Lamp and Glass Feather.', 'Then she left.']);
    expect(out[1]!.end).toBeGreaterThanOrEqual(block.indexOf(`${names[7]}]`));
    expect(store.get('Relics')).toEqual(names);
  });
});
