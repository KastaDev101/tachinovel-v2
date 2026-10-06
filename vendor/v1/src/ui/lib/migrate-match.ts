/**
 * Migrate helpers (pure; unit-tested): title similarity for ranking another source's search results,
 * a concurrency limiter for the per-source fan-out, library grouping and the preview sentence.
 */
import type { LibraryEntry, SourceInfo } from '../../shared/contracts/domain.ts';
import { splitChapterTitle } from './chapter-title.ts';
import { formatCount } from './format.ts';

/** Results at or above this similarity are marked as a match. */
export const STRONG_MATCH = 0.82;

/**
 * Comparable form of a title: accents, punctuation, bracketed tags ("[WN]", "(Web Novel)") and a
 * leading article removed; lowercase; single spaces.
 */
export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[[(][^\])]*[\])]/g, ' ')
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(?:the|a|an) /, '');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/ /g, '');
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 0..1: 1 for the same normalized title; otherwise a bigram (Dice) score, nudged up when one title contains the other. */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of bx) {
    overlap += Math.min(n, by.get(g) ?? 0);
    total += n;
  }
  for (const n of by.values()) total += n;
  let score = total > 0 ? (2 * overlap) / total : 0;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) score = Math.max(score, 0.85);
  return Math.min(0.99, score);
}

/** Items sorted by similarity to `title` (stable for ties), each with its score. */
export function rankMatches<T extends { name: string }>(title: string, items: readonly T[]): (T & { score: number })[] {
  return items
    .map((it, i) => ({ it: { ...it, score: titleSimilarity(title, it.name) }, i }))
    .sort((a, b) => b.it.score - a.it.score || a.i - b.i)
    .map((x) => x.it);
}

/** Runs `task` for every item with at most `limit` running at once; stops starting new ones once `alive()` is false. */
export async function runLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>, alive: () => boolean = () => true): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && alive()) {
      const item = items[next++] as T;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, worker));
}

export interface LibraryGroup {
  pluginId: string;
  name: string;
  entries: LibraryEntry[];
}

/** Library entries grouped by source (sources A–Z, unknown sources by id), entries A–Z. */
export function groupBySource(entries: readonly LibraryEntry[], sources: readonly SourceInfo[]): LibraryGroup[] {
  const byId = new Map<string, LibraryGroup>();
  for (const e of entries) {
    let g = byId.get(e.pluginId);
    if (!g) {
      g = { pluginId: e.pluginId, name: sources.find((s) => s.id === e.pluginId)?.name ?? e.pluginId, entries: [] };
      byId.set(e.pluginId, g);
    }
    g.entries.push(e);
  }
  const groups = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const g of groups) g.entries.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}

export interface MigratePreview {
  matched: number;
  unmatched: number;
  readCarried: number;
  lastChapterName?: string;
}

/** "312 of 315 chapters matched · 120 read marks carried · resumes at Chapter 121". */
export function previewSentence(p: MigratePreview): string {
  const total = p.matched + p.unmatched;
  const parts = [`${formatCount(p.matched)} of ${formatCount(total)} ${total === 1 ? 'chapter' : 'chapters'} matched`, `${formatCount(p.readCarried)} read ${p.readCarried === 1 ? 'mark' : 'marks'} carried`];
  if (p.lastChapterName) {
    const { label, title } = splitChapterTitle(p.lastChapterName);
    parts.push(`resumes at ${label || title}`);
  }
  return parts.join(' · ');
}

/** The best-scoring item if it's a strong enough title match, else null (batch migrate never guesses). */
export function bestMatch<T extends { name: string }>(title: string, items: readonly T[], threshold = STRONG_MATCH): (T & { score: number }) | null {
  const top = rankMatches(title, items)[0];
  return top && top.score >= threshold ? top : null;
}

export interface BatchCounts {
  total: number;
  searching: number;
  found: number;
  missing: number;
  failed: number;
}

/** Status line for batch migrate while matching: "Finding matches · 3 of 6", then "4 of 6 found on Royal Road". */
export function batchStatus(c: BatchCounts, target: string): string {
  const checked = c.total - c.searching;
  if (c.searching > 0) return `Finding matches · ${formatCount(checked)} of ${formatCount(c.total)}`;
  const base = `${formatCount(c.found)} of ${formatCount(c.total)} found on ${target}`;
  return c.failed > 0 ? `${base} · ${formatCount(c.failed)} couldn’t be searched` : base;
}
