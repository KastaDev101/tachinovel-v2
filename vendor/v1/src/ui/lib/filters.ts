/**
 * Source filter values (pure; unit-tested). Plugins describe filters in LNReader's `Filters` shape;
 * `browse.list` receives `{ key: { value, type } }`, exactly what LNReader passes to popularNovels.
 */
import type { FilterTypes, Filters, ValueOfFilter } from '../../shared/lnreader/filters.ts';

export interface FilterValue {
  type: FilterTypes;
  value: unknown;
}

export type FilterValues = Record<string, FilterValue>;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** The plugin's defaults as `{ value, type }` pairs. */
export function defaultFilterValues(filters: Filters): FilterValues {
  const out: FilterValues = {};
  for (const [key, f] of Object.entries(filters)) out[key] = { type: f.type, value: clone(f.value) };
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const x = (a as unknown[]).map(String).sort();
    const y = (b as unknown[]).map(String).sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const x = a as { include?: string[]; exclude?: string[] };
    const y = b as { include?: string[]; exclude?: string[] };
    return sameValue(x.include ?? [], y.include ?? []) && sameValue(x.exclude ?? [], y.exclude ?? []);
  }
  return a === b;
}

/** Keys whose value differs from the plugin's default. */
export function changedFilterKeys(filters: Filters, values: FilterValues): string[] {
  return Object.keys(filters).filter((k) => {
    const v = values[k];
    return v !== undefined && !sameValue(v.value, filters[k]?.value);
  });
}

export function isDefaultFilters(filters: Filters, values: FilterValues): boolean {
  return changedFilterKeys(filters, values).length === 0;
}

/** Checkbox group: toggle one option. */
export function toggleCheckbox(value: ValueOfFilter<'Checkbox'>, option: string): string[] {
  return value.includes(option) ? value.filter((v) => v !== option) : [...value, option];
}

export type XState = 'none' | 'include' | 'exclude';

export function xState(value: ValueOfFilter<'XCheckbox'>, option: string): XState {
  if (value.include?.includes(option)) return 'include';
  if (value.exclude?.includes(option)) return 'exclude';
  return 'none';
}

/** Excludable checkbox: none → include → exclude → none. */
export function cycleXCheckbox(value: ValueOfFilter<'XCheckbox'>, option: string): ValueOfFilter<'XCheckbox'> {
  const state = xState(value, option);
  const include = (value.include ?? []).filter((v) => v !== option);
  const exclude = (value.exclude ?? []).filter((v) => v !== option);
  if (state === 'none') include.push(option);
  else if (state === 'include') exclude.push(option);
  return { include, exclude };
}
