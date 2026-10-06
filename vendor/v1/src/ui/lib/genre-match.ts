/**
 * Genre search matching (pure; unit-tested). A novel's genre chip ("Sci-fi") is matched to an option
 * of each source's genre/tag/category filter, ignoring case and punctuation and folding a few common
 * synonyms ("Science Fiction" ≈ "Sci-fi", "slice-of-life" ≈ "Slice of Life"). The match becomes a
 * `browse.list` filters map in LNReader's `{ key: { value, type } }` shape: the plugin's defaults with
 * only that one option set.
 */
import type { Filter, FilterOption, Filters, FilterTypes } from '../../shared/lnreader/filters.ts';
import { defaultFilterValues, type FilterValues } from './filters.ts';

/** Lowercase, strip accents, `&` → "and", drop everything that isn't a letter or digit (any script). */
export function normalizeGenre(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Normalized spelling → canonical spelling. Small on purpose: only names sources really disagree on. */
const SYNONYMS: Readonly<Record<string, string>> = {
  sciencefiction: 'scifi',
  sf: 'scifi',
  sol: 'sliceoflife',
  humor: 'comedy',
  humour: 'comedy',
  portalfantasy: 'isekai',
  portalfantasyisekai: 'isekai',
  genderswap: 'genderbender',
  postapocalypse: 'postapocalyptic',
  apocalypse: 'postapocalyptic',
  apocalyptic: 'postapocalyptic',
  history: 'historical',
  rebirth: 'reincarnation',
  reincarnated: 'reincarnation',
  school: 'schoollife',
  superheroes: 'superhero',
  warandmilitary: 'military',
  vr: 'virtualreality',
  videogame: 'videogames',
  gaming: 'videogames',
};

/** Normalized + synonym-folded key ("Science Fiction" → "scifi"). */
export function canonicalGenre(s: string): string {
  const n = normalizeGenre(s);
  return SYNONYMS[n] ?? n;
}

/** Singular form of a canonical key ("mysteries" → "mystery", "martialarts" → "martialart"). */
function singular(k: string): string {
  if (k.length > 4 && k.endsWith('ies')) return `${k.slice(0, -3)}y`;
  if (k.length > 3 && k.endsWith('s') && !k.endsWith('ss')) return k.slice(0, -1);
  return k;
}

/** True when two genre names mean the same thing (case, punctuation, synonyms and plurals ignored). */
export function sameGenre(a: string, b: string): boolean {
  const x = canonicalGenre(a);
  const y = canonicalGenre(b);
  return x !== '' && y !== '' && (x === y || singular(x) === singular(y));
}

export type GenreFilterType = 'Checkbox' | 'XCheckbox' | 'Picker';

export interface GenreMatch {
  /** Filter key in the plugin's `filters`. */
  key: string;
  type: GenreFilterType;
  /** The filter's label ("Genres", "Tags"). */
  label: string;
  option: FilterOption;
}

const GENRE_FILTER = /genre|tag|categor/i;

/** Which filters can hold a genre, best first: genre filters, then categories, then tags (declaration order within each). */
export function genreFilterKeys(filters: Filters): string[] {
  const rank = (key: string, f: Filter<FilterTypes>): number => {
    const text = `${key} ${f.label}`;
    if (/genre/i.test(text)) return 0;
    if (/categor/i.test(text)) return 1;
    return 2;
  };
  return Object.entries(filters)
    .filter(([key, f]) => (f.type === 'Checkbox' || f.type === 'XCheckbox' || f.type === 'Picker') && (GENRE_FILTER.test(key) || GENRE_FILTER.test(f.label)))
    .map(([key, f], i) => ({ key, r: rank(key, f), i }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.key);
}

/**
 * Finds the option for `genre` in the source's genre/tag/category filters. Exact (normalized +
 * synonym) matches win over plural-insensitive ones; better filters win within each pass. Option
 * labels and values are both tried, so slugs like "sliceoflife" or "sci_fi" match too.
 */
export function findGenreOption(filters: Filters | null | undefined, genre: string): GenreMatch | null {
  if (!filters) return null;
  const wanted = canonicalGenre(genre);
  if (!wanted) return null;
  const keys = genreFilterKeys(filters);
  const passes: ((o: FilterOption) => boolean)[] = [
    (o) => canonicalGenre(o.label) === wanted || canonicalGenre(o.value) === wanted,
    (o) => sameGenre(o.label, genre) || sameGenre(o.value, genre),
  ];
  for (const test of passes) {
    for (const key of keys) {
      const f = filters[key];
      if (!f || (f.type !== 'Checkbox' && f.type !== 'XCheckbox' && f.type !== 'Picker')) continue;
      // An empty value is a Picker's "Any"/"All" (no filter), never a genre.
      const option = f.options.find((o) => o.value.trim() !== '' && test(o));
      if (option) return { key, type: f.type, label: f.label, option };
    }
  }
  return null;
}

/** The value LNReader expects for a filter of this type with only `option` set. */
export function genreValue(type: GenreFilterType, option: FilterOption): unknown {
  switch (type) {
    case 'Checkbox':
      return [option.value];
    case 'XCheckbox':
      return { include: [option.value], exclude: [] };
    case 'Picker':
      return option.value;
  }
}

/** `browse.list` filters: the plugin's defaults with only the genre option set. */
export function genreFilterValues(filters: Filters, match: GenreMatch): FilterValues {
  const values = defaultFilterValues(filters);
  values[match.key] = { type: match.type, value: genreValue(match.type, match.option) };
  return values;
}

// ---------- several genres at once (AND) ----------

/** One option per genre, or null when the source lacks any of them. */
export function findGenreOptions(filters: Filters | null | undefined, genres: readonly string[]): GenreMatch[] | null {
  const out: GenreMatch[] = [];
  for (const g of genres) {
    const m = findGenreOption(filters, g);
    if (!m) return null;
    out.push(m);
  }
  return out;
}

/**
 * `browse.list` filters with every matched option set (all of them must apply): Checkbox → [a, b],
 * XCheckbox → { include: [a, b] }; options in different filters are each set. A Picker holds one
 * value, so two different genres in the same Picker can't be combined → null.
 */
export function combinedGenreValues(filters: Filters, matches: readonly GenreMatch[]): FilterValues | null {
  const values = defaultFilterValues(filters);
  const picked = new Map<string, string[]>();
  for (const m of matches) {
    const list = picked.get(m.key) ?? [];
    if (!list.includes(m.option.value)) list.push(m.option.value);
    picked.set(m.key, list);
  }
  for (const [key, list] of picked) {
    const type = matches.find((m) => m.key === key)?.type;
    if (type === 'Picker') {
      if (list.length > 1) return null;
      values[key] = { type, value: list[0] };
    } else if (type === 'Checkbox') {
      values[key] = { type, value: list };
    } else if (type === 'XCheckbox') {
      values[key] = { type, value: { include: list, exclude: [] } };
    }
  }
  return values;
}

/** Matches and filters for all `genres` on one source, or null when it can't search them together. */
export function matchGenres(filters: Filters | null | undefined, genres: readonly string[]): { matches: GenreMatch[]; values: FilterValues } | null {
  if (!filters) return null;
  const matches = findGenreOptions(filters, genres);
  if (!matches) return null;
  const values = combinedGenreValues(filters, matches);
  return values ? { matches, values } : null;
}

export interface GenreCandidate {
  /** Option label as the first source spells it. */
  label: string;
  /** Sources that can search the current genres plus this one. */
  count: number;
}

/**
 * Genres that can be added to `selected` (AND): every genre/tag/category option of the given
 * sources' filters that still combines with the selection, counted per source, A–Z.
 */
export function genreCandidates(sources: readonly (Filters | null | undefined)[], selected: readonly string[]): GenreCandidate[] {
  const byKey = new Map<string, GenreCandidate>();
  for (const filters of sources) {
    if (!filters || !matchGenres(filters, selected)) continue;
    const seen = new Set<string>();
    for (const key of genreFilterKeys(filters)) {
      const f = filters[key];
      if (!f || (f.type !== 'Checkbox' && f.type !== 'XCheckbox' && f.type !== 'Picker')) continue;
      for (const o of f.options) {
        const k = canonicalGenre(o.label);
        if (!k || o.value.trim() === '' || seen.has(k) || selected.some((g) => sameGenre(g, o.label))) continue;
        if (!matchGenres(filters, [...selected, o.label])) continue;
        seen.add(k);
        const c = byKey.get(k);
        if (c) c.count++;
        else byKey.set(k, { label: o.label, count: 1 });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}
