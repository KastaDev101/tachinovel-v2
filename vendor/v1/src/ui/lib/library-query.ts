/** Library sort / filter / search (pure; unit-tested). */
import type { LibraryEntry, LibrarySettings, LibrarySortBy } from '../../shared/contracts/domain.ts';

export interface LibraryQuery {
  sort: LibrarySettings['sort'];
  filter: LibrarySettings['filter'];
  search: string;
  /** null = all categories. '' = uncategorized. */
  categoryId: string | null;
}

function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function matchesSearch(e: LibraryEntry, search: string): boolean {
  const q = normalize(search);
  if (!q) return true;
  return normalize(e.name).includes(q) || (e.author !== undefined && normalize(e.author).includes(q));
}

function sortValue(e: LibraryEntry, by: LibrarySortBy): number | string {
  switch (by) {
    case 'lastRead':
      return e.lastReadAt ?? 0;
    case 'lastUpdated':
      return e.lastUpdatedAt ?? 0;
    case 'alpha':
      return normalize(e.name);
    case 'unread':
      return e.unreadCount;
    case 'dateAdded':
      return e.addedAt;
  }
}

/** Natural direction for each key when dir is 'desc' (most recent / most unread / Z→A first). */
export function compareEntries(a: LibraryEntry, b: LibraryEntry, sort: LibrarySettings['sort']): number {
  const va = sortValue(a, sort.by);
  const vb = sortValue(b, sort.by);
  let c: number;
  if (typeof va === 'string' && typeof vb === 'string') c = va.localeCompare(vb);
  else c = (va as number) - (vb as number);
  if (sort.dir === 'desc') c = -c;
  // Stable, deterministic tiebreak by name.
  return c !== 0 ? c : normalize(a.name).localeCompare(normalize(b.name));
}

export function queryLibrary(entries: readonly LibraryEntry[], q: LibraryQuery): LibraryEntry[] {
  const out = entries.filter((e) => {
    if (q.categoryId !== null) {
      if (q.categoryId === '' ? e.categoryIds.length > 0 : !e.categoryIds.includes(q.categoryId)) return false;
    }
    if (q.filter.unread && e.unreadCount <= 0) return false;
    if (q.filter.completed && e.status !== 'completed') return false;
    if (q.filter.downloaded && e.downloadedCount <= 0) return false;
    return matchesSearch(e, q.search);
  });
  out.sort((a, b) => compareEntries(a, b, q.sort));
  return out;
}

export const SORT_LABELS: Record<LibrarySortBy, string> = {
  lastRead: 'Last read',
  lastUpdated: 'Last updated',
  alpha: 'Alphabetical',
  unread: 'Unread count',
  dateAdded: 'Date added',
};

export function activeFilterCount(filter: LibrarySettings['filter']): number {
  return Number(filter.unread) + Number(filter.completed) + Number(filter.downloaded);
}
