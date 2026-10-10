/**
 * LitRPG status lists read as a summary, not item by item (Kasta, 2026-10-09: a status screen's "Memories:" list
 * ran to 30+ bracketed names, read one by one every time it came up, and grows with the series).
 *
 * A run of LIST_MIN or more bracketed items ("Label: [A], [B], [C]…", separated by commas, semicolons or periods)
 * is spoken as:
 *   - the first time:            "Memories: 32 in all, including A, B and C."
 *   - when the novel's previous chapter had the same list (ListMemory): only what changed,
 *                                "Memories: 32. New: D and E."  /  "Memories: 32, no change."
 * Shorter lists read as written. The reader still shows the whole list; only the spoken text changes, and the
 * summary keeps the span of the sentences it replaces, so highlighting covers the whole list.
 */

/** A list long enough to summarize. */
export const LIST_MIN = 6;
/** Names read when listing what's new; the rest are counted. */
const NEW_MAX = 5;

export interface ListSpan {
  /** Character offsets in the block text: from the label (or the first bracket) to the last bracket. */
  start: number;
  end: number;
  label?: string;
  items: string[];
}

/** The previous chapter's lists for this novel, by label (the caller stores them, e.g. per novel). */
export interface ListMemory {
  previous(label: string): readonly string[] | undefined;
  remember(label: string, items: readonly string[]): void;
}

const ITEM = /\[([^\][\n]{1,60})\]/g;

/** Long bracketed lists in a block's text. */
export function findLists(text: string): ListSpan[] {
  const out: ListSpan[] = [];
  const hits = [...text.matchAll(ITEM)];
  let i = 0;
  while (i < hits.length) {
    let j = i;
    // Items joined only by separators (", " "; " ". " "and ") belong to one list.
    while (j + 1 < hits.length) {
      const a = hits[j]!, b = hits[j + 1]!;
      const between = text.slice((a.index ?? 0) + a[0].length, b.index ?? 0);
      if (!/^[\s,;.]*(?:and\s+)?$/i.test(between)) break;
      j += 1;
    }
    if (j - i + 1 >= LIST_MIN) {
      const first = hits[i]!, last = hits[j]!;
      let start = first.index ?? 0;
      const lead = /([A-Z][\w' ]{0,30}):\s*$/.exec(text.slice(Math.max(0, start - 40), start));
      const label = lead?.[1]?.trim();
      if (lead) start -= lead[0].length;
      out.push({ start, end: (last.index ?? 0) + last[0].length, ...(label ? { label } : {}), items: hits.slice(i, j + 1).map((h) => h[1]!.trim()) });
    }
    i = j + 1;
  }
  return out;
}

function and(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The spoken summary of a list. */
export function summarizeList(span: ListSpan, previous?: readonly string[]): string {
  const n = span.items.length;
  const head = span.label ? `${span.label}: ${n}` : `A list of ${n}`;
  if (previous && previous.length > 0) {
    const before = new Set(previous.map((x) => x.toLowerCase()));
    const fresh = span.items.filter((x) => !before.has(x.toLowerCase()));
    if (fresh.length === 0) return `${head}, no change.`;
    const named = fresh.slice(0, NEW_MAX);
    const more = fresh.length - named.length;
    return `${head}. New: ${and(more > 0 ? [...named, `${more} more`] : named)}.`;
  }
  return `${head} in all, including ${and(span.items.slice(0, 3))}.`;
}

interface Spoken {
  block: number;
  start: number;
  end: number;
  text: string;
}

/**
 * Replaces the spoken text of sentences covering a long list with its summary: the first sentence of the list takes
 * the summary and the list's whole span; the others in it are dropped. `text` the caller keeps for anything after
 * the list in the last sentence. Returns the new item list (the same objects, the first ones edited).
 */
export function compactLists<T extends Spoken>(items: readonly T[], blockText: (block: number) => string, memory?: ListMemory): T[] {
  const out: T[] = [];
  const spans = new Map<number, ListSpan[]>();
  const listsOf = (b: number): ListSpan[] => {
    let s = spans.get(b);
    if (!s) spans.set(b, (s = findLists(blockText(b))));
    return s;
  };
  let skipUntil: { block: number; end: number } | null = null;
  for (const it of items) {
    if (skipUntil && it.block === skipUntil.block && it.start < skipUntil.end) {
      if (it.end <= skipUntil.end + 2) continue;
      // A sentence that runs on past the list: only its words after the list.
      it.text = blockText(it.block).slice(skipUntil.end, it.end).replace(/^[\s.,;]+/, '');
      it.start = skipUntil.end;
      for (const k of ['runs', 'phrases', 'parts'] as const) delete (it as Record<string, unknown>)[k];
      out.push(it);
      skipUntil = null;
      continue;
    }
    skipUntil = null;
    const span = listsOf(it.block).find((s) => it.start < s.end && it.end > s.start);
    if (!span) {
      out.push(it);
      continue;
    }
    const prev = span.label ? memory?.previous(span.label) : undefined;
    const before = it.start < span.start ? blockText(it.block).slice(it.start, span.start).trim() : '';
    it.text = [before, summarizeList(span, prev)].filter(Boolean).join(' ');
    it.start = Math.min(it.start, span.start);
    it.end = Math.max(it.end, span.end);
    for (const k of ['runs', 'phrases', 'parts'] as const) delete (it as Record<string, unknown>)[k];
    if (span.label) memory?.remember(span.label, span.items);
    out.push(it);
    skipUntil = { block: it.block, end: span.end };
  }
  return out;
}
