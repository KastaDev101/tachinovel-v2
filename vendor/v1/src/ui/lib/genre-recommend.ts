/**
 * "Because you read X" (pure; unit-tested): which of X's genres to search for, and how to merge the
 * per-source results into one row.
 */
import { canonicalGenre } from './genre-match.ts';

/**
 * Up to `max` of the seed's genres, the ones most common across what the user reads (`taste` = the
 * genre lists of recently read novels) first; ties keep the seed's own order (sites list the main
 * genre first). Synonyms and spelling variants count as one genre.
 */
export function pickGenres(seed: readonly string[], taste: readonly (readonly string[])[], max = 2): string[] {
  const freq = new Map<string, number>();
  for (const list of taste) {
    for (const k of new Set(list.map(canonicalGenre))) if (k) freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const unique = seed.filter((g) => {
    const k = canonicalGenre(g);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique
    .map((g, i) => ({ g, i, f: freq.get(canonicalGenre(g)) ?? 0 }))
    .sort((a, b) => b.f - a.f || a.i - b.i)
    .slice(0, max)
    .map((x) => x.g);
}

/**
 * One row from several sources' result lists: round-robin (each source's best first), without
 * duplicates or excluded keys (the library, the seed itself), at most `limit`.
 */
export function interleave<T>(lists: readonly (readonly T[])[], keyOf: (item: T) => string, exclude: ReadonlySet<string>, limit = 20): T[] {
  const out: T[] = [];
  const seen = new Set(exclude);
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < limit; i++) {
    for (const l of lists) {
      const item = l[i];
      if (item === undefined) continue;
      const k = keyOf(item);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
      if (out.length >= limit) break;
    }
  }
  return out;
}
