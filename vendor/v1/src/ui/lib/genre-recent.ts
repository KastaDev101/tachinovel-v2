/**
 * Recent genre searches (one genre or a combination), newest first, kept on this device so Browse ›
 * Genres can offer them again as quick chips.
 */
import { sameGenre } from './genre-match.ts';

/** One past search: the genres it combined, in the order they were picked. */
export type GenreSearch = readonly string[];

export const RECENT_GENRES_KEY = 'tachinovel.genre.recent.v1';
export const RECENT_GENRES_MAX = 8;

/** The same search: the same genres (synonyms and plurals match), in any order. */
export function sameSearch(a: GenreSearch, b: GenreSearch): boolean {
  return a.length === b.length && a.every((g) => b.some((h) => sameGenre(g, h)));
}

/** `list` with `search` moved (or added) to the front, capped. Blank genres are dropped. */
export function addRecent(list: readonly GenreSearch[], search: GenreSearch, max = RECENT_GENRES_MAX): GenreSearch[] {
  const s = search.map((g) => g.trim()).filter((g) => g !== '');
  if (s.length === 0) return [...list];
  return [s, ...list.filter((x) => !sameSearch(x, s))].slice(0, max);
}

/** `list` without `search`. */
export function removeRecent(list: readonly GenreSearch[], search: GenreSearch): GenreSearch[] {
  return list.filter((x) => !sameSearch(x, search));
}

/** "Action", or "Action + Romance" for a combination. */
export function searchLabel(search: GenreSearch): string {
  return search.join(' + ');
}

/** Parse what was stored, dropping anything malformed. */
export function parseRecent(raw: string | null): GenreSearch[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is string[] => Array.isArray(x) && x.length > 0 && x.every((g) => typeof g === 'string' && g.trim() !== ''))
      .slice(0, RECENT_GENRES_MAX);
  } catch {
    return [];
  }
}

export function readRecentGenres(): GenreSearch[] {
  try {
    return parseRecent(localStorage.getItem(RECENT_GENRES_KEY));
  } catch {
    return [];
  }
}

function write(list: readonly GenreSearch[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(RECENT_GENRES_KEY);
    else localStorage.setItem(RECENT_GENRES_KEY, JSON.stringify(list));
  } catch {
    // Remembered for this session only.
  }
}

export function rememberGenreSearch(search: GenreSearch): void {
  write(addRecent(readRecentGenres(), search));
}

export function forgetGenreSearch(search: GenreSearch): void {
  write(removeRecent(readRecentGenres(), search));
}

export function clearRecentGenres(): void {
  write([]);
}
