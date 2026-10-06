/** One source: Popular / Latest tabs, search, infinite scroll, "In library" markers (or hidden). */
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { BrowseItem } from '../../shared/contracts/protocol.ts';
import type { Filters } from '../../shared/lnreader/filters.ts';
import { bridge, errorText, toUiError, type UiError } from '../bridge/client.ts';
import { BarButton, Button, Segmented, SearchField, Spinner } from '../components/controls.tsx';
import { EmptyState, ErrorState, SkeletonGrid, solveChallengeThen } from '../components/feedback.tsx';
import { NovelGrid } from '../components/novel-grid.tsx';
import { Screen } from '../components/screen.tsx';
import { changedFilterKeys, defaultFilterValues, type FilterValues } from '../lib/filters.ts';
import { actionSheet, openInSafari, quickAddToLibrary, removeFromLibrary } from '../state/actions.ts';
import { openNovel, push } from '../state/nav.ts';
import { libraryKeys, settings, sourceById } from '../state/store.ts';
import { recordSourceHealth } from './browse.tsx';
import { FilterSheet } from './source-filters.tsx';

type Mode = 'popular' | 'latest';

interface ListState {
  items: BrowseItem[];
  page: number;
  hasMore: boolean;
  status: 'loading' | 'ready' | 'error' | 'more' | 'more-error';
  error?: UiError;
  /** The tab these items belong to (the tab switches a render before its list arrives). */
  forMode?: Mode;
}

/**
 * Per-source memory for this session: the last tab, and each tab's loaded list and scroll position,
 * so reopening a source (or switching back to a tab) continues where you were. Plain browsing only
 * (not search results or filtered lists).
 */
interface RememberedList {
  items: BrowseItem[];
  page: number;
  hasMore: boolean;
  scrollTop: number;
  at: number;
}
/** Older remembered lists are fetched again (the source's Popular/Latest moves on). */
const REMEMBER_MS = 30 * 60_000;

/** Sets scrollTop, retrying for a few frames while the screen is still being laid out (just pushed). */
function restoreScroll(sc: HTMLElement, top: number, tries = 6): void {
  sc.scrollTop = top;
  if (tries > 0 && Math.abs(sc.scrollTop - top) > 1) requestAnimationFrame(() => restoreScroll(sc, top, tries - 1));
}

function fresh(list: RememberedList | undefined): RememberedList | undefined {
  return list && list.items.length > 0 && Date.now() - list.at < REMEMBER_MS ? list : undefined;
}
const sourceMemory = new Map<string, { mode: Mode; lists: Partial<Record<Mode, RememberedList>> }>();

const HIDE_KEY = 'tachinovel.browse.hideInLibrary';

/** Browse lists leave out novels already in the library (every source; ⋮ menu). Kept on this device. */
export const hideInLibrary = signal<boolean>(
  (() => {
    try {
      return localStorage.getItem(HIDE_KEY) === '1';
    } catch {
      return false;
    }
  })(),
);

function setHideInLibrary(on: boolean): void {
  hideInLibrary.value = on;
  try {
    if (on) localStorage.setItem(HIDE_KEY, '1');
    else localStorage.removeItem(HIDE_KEY);
  } catch {
    // This session only.
  }
}

function remembered(pluginId: string): { mode: Mode; lists: Partial<Record<Mode, RememberedList>> } {
  let m = sourceMemory.get(pluginId);
  if (!m) {
    m = { mode: 'popular', lists: {} };
    sourceMemory.set(pluginId, m);
  }
  return m;
}

/** `filters` / `mode`: start with these filter values applied / on this tab (genre search, latest "See all"). */
export function SourceScreen(props: { pluginId: string; query?: string; openFilters?: boolean; filters?: FilterValues; mode?: Mode }) {
  const src = sourceById(props.pluginId);
  const [filterDefs, setFilterDefs] = useState<Filters | null>(null);
  const [filterValues, setFilterValues] = useState<FilterValues | null>(props.filters ?? null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = filterDefs && filterValues ? changedFilterKeys(filterDefs, filterValues).length : 0;
  const memory = remembered(props.pluginId);
  const [mode, setMode] = useState<Mode>(props.mode ?? (props.query || props.filters ? 'popular' : memory.mode));
  const [input, setInput] = useState(props.query ?? '');
  const [query, setQuery] = useState(props.query ?? '');
  /** Plain browsing (no search, no filters): the list and scroll position are remembered. */
  const plain = !query && filterValues === null;
  const [state, setState] = useState<ListState>(() => {
    const kept = plain ? fresh(memory.lists[mode]) : undefined;
    return kept ? { items: kept.items, page: kept.page, hasMore: kept.hasMore, status: 'ready', forMode: mode } : { items: [], page: 0, hasMore: true, status: 'loading' };
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const req = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const keys = libraryKeys.value;
  const hide = hideInLibrary.value;
  /** Scroll position to restore once the remembered list has rendered. */
  const pendingScroll = useRef<number | null>(null);
  const plainRef = useRef(plain);
  plainRef.current = plain;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Remember the tab and the loaded list (plain browsing only).
  useEffect(() => {
    if (!plain) return;
    memory.mode = mode;
    if (state.forMode !== mode) return;
    if (state.status === 'ready' || state.status === 'more' || state.status === 'more-error') {
      const prev = memory.lists[mode];
      // A new first page (fresh load) starts the scroll memory over.
      const same = prev !== undefined && prev.items[0] === state.items[0];
      memory.lists[mode] = { items: state.items, page: state.page, hasMore: state.hasMore, scrollTop: same ? prev.scrollTop : 0, at: same ? prev.at : Date.now() };
    }
  }, [state, mode, plain]);

  // …and where it was scrolled to.
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const onScroll = (): void => {
      const kept = plainRef.current ? memory.lists[modeRef.current] : undefined;
      if (kept && pendingScroll.current === null) kept.scrollTop = sc.scrollTop;
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    return () => sc.removeEventListener('scroll', onScroll);
  }, []);

  // Restore the scroll position after the remembered list is on screen.
  useLayoutEffect(() => {
    const top = pendingScroll.current;
    const sc = scroller.current;
    if (top === null || !sc || state.status !== 'ready') return;
    pendingScroll.current = null;
    restoreScroll(sc, top);
  });

  async function load(page: number): Promise<void> {
    const id = ++req.current;
    const forMode = mode;
    setState((s) => (page === 1 ? { items: [], page: 0, hasMore: true, status: 'loading' } : { ...s, status: 'more' }));
    try {
      const res = query
        ? await bridge().call('browse.search', { pluginId: props.pluginId, query, page }, { timeoutMs: 60_000 })
        : await bridge().call(
            'browse.list',
            // Pre-applied filters (props.filters) are sent before the definitions have loaded.
            { pluginId: props.pluginId, page, mode, ...(filterValues && (activeFilters > 0 || !filterDefs) ? { filters: filterValues } : {}) },
            { timeoutMs: 60_000 },
          );
      if (id !== req.current) return; // stale (tab/search changed meanwhile)
      recordSourceHealth(props.pluginId); // e.g. a passed bot check: global search tries it again
      setState((s) => {
        const seen = new Set(s.items.map((i) => `${i.pluginId}:${i.path}`));
        const fresh = res.items.filter((i) => !seen.has(`${i.pluginId}:${i.path}`));
        return { items: page === 1 ? res.items : [...s.items, ...fresh], page, hasMore: res.hasMore && res.items.length > 0, status: 'ready', forMode };
      });
    } catch (err) {
      if (id !== req.current) return;
      const e = toUiError(err);
      recordSourceHealth(props.pluginId, e);
      setState((s) => (page === 1 ? { ...s, status: 'error', error: e } : { ...s, status: 'more-error', error: e }));
    }
  }

  useLayoutEffect(() => {
    // A remembered list (reopened source, or back on a tab): show it as it was, no reload.
    const kept = plain ? fresh(memory.lists[mode]) : undefined;
    if (kept) {
      req.current++; // drop any load still running for the other tab
      if (stateRef.current.items === kept.items) {
        // Already on screen (reopened source): just put the scroll position back.
        if (scroller.current) restoreScroll(scroller.current, kept.scrollTop);
      } else {
        pendingScroll.current = kept.scrollTop;
        setState({ items: kept.items, page: kept.page, hasMore: kept.hasMore, status: 'ready', forMode: mode });
      }
      return;
    }
    scroller.current?.scrollTo({ top: 0 });
    void load(1);
  }, [mode, query, filterValues]);

  // Filter definitions (only sources that declare filters).
  useEffect(() => {
    if (!src?.hasFilters) return;
    bridge()
      .call('sources.filters', { id: props.pluginId })
      .then((f) => {
        if (!f || Object.keys(f).length === 0) return;
        setFilterDefs(f);
        if (props.openFilters) setFiltersOpen(true);
      })
      .catch(() => undefined);
  }, [props.pluginId]);

  // Infinite scroll: load the next page when the sentinel nears the viewport.
  useEffect(() => {
    const el = sentinel.current;
    const root = scroller.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(
      (entries) => {
        const s = stateRef.current;
        if (entries.some((e) => e.isIntersecting) && s.status === 'ready' && s.hasMore) void load(s.page + 1);
      },
      { root, rootMargin: '0px 0px 800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [state.status === 'ready', mode, query]);

  /** ⋮: hide/show novels in the library, Source Settings (if it has any), Open in Safari. */
  async function moreMenu(): Promise<void> {
    const toggle = hide ? 'Show Novels in Library' : 'Hide Novels in Library';
    const actions = [{ title: toggle }, ...(src?.hasSettings ? [{ title: 'Source Settings' }] : []), ...(src?.site ? [{ title: 'Open in Safari' }] : [])];
    const i = await actionSheet({ title: src?.name ?? props.pluginId, actions });
    const t = actions[i]?.title;
    if (t === toggle) setHideInLibrary(!hide);
    else if (t === 'Source Settings') push({ name: 'sourceSettings', pluginId: props.pluginId });
    else if (t === 'Open in Safari') openInSafari(src?.site);
  }

  async function itemMenu(item: BrowseItem): Promise<void> {
    const inLib = keys.has(`${item.pluginId}:${item.path}`);
    const i = await actionSheet({ title: item.name, actions: [{ title: inLib ? 'Remove from Library' : 'Add to Library', destructive: inLib }, { title: 'Open' }] });
    if (i === 0) {
      if (inLib) removeFromLibrary([item]);
      else void quickAddToLibrary(item);
    } else if (i === 1) openNovel(item);
  }

  const all = state.items.map((i) => ({ ...i, key: `${i.pluginId}:${i.path}` }));
  const items = hide ? all.filter((i) => !keys.has(i.key)) : all;
  const hiddenCount = all.length - items.length;
  let body;
  if (state.status === 'loading') body = <SkeletonGrid count={12} columns={settings.value.library.columns} />;
  else if (state.status === 'error' && state.error) body = <ErrorState error={state.error} onRetry={() => void load(1)} onSolve={solveChallengeThen(props.pluginId, () => void load(1))} />;
  else if (items.length === 0 && hiddenCount > 0 && !state.hasMore)
    body = (
      <EmptyState
        icon="books.vertical.fill"
        title="All in Your Library"
        message={`Every novel here is already in your library (${hiddenCount}).`}
        action={{ label: 'Show Them', onClick: () => setHideInLibrary(false) }}
        testId="source-all-hidden"
      />
    );
  else if (items.length === 0 && hiddenCount > 0) body = null; // the next page is on its way
  else if (items.length === 0)
    body = <EmptyState icon="magnifyingglass" title="No Results" message={query ? `${src?.name ?? 'This source'} has nothing for “${query}”.` : 'This source returned nothing.'} />;
  else
    body = (
      <NovelGrid
        items={items}
        display={settings.value.library.display}
        columns={settings.value.library.columns}
        testId="browse-grid"
        badges={(i) => ({ inLibrary: keys.has(i.key), ...(i.chapterCount ? { chapters: i.chapterCount } : {}) })}
        onOpen={openNovel}
        onLongPress={(i) => void itemMenu(i)}
      />
    );

  return (
    <Screen
      title={src?.name ?? props.pluginId}
      back="Browse"
      testId="screen-source"
      scrollRef={scroller}
      right={
        <>
          {filterDefs && (
            <BarButton icon="line.3.horizontal.decrease" label="Filters" active={activeFilters > 0} onClick={() => setFiltersOpen(true)} testId="source-filters" />
          )}
          <BarButton icon="ellipsis.circle" label="More" onClick={() => void moreMenu()} testId="source-more" />
        </>
      }
      accessory={
        <div class="accessory-stack">
          <SearchField
            value={input}
            onInput={(v) => {
              setInput(v);
              if (v === '' && query !== '') setQuery('');
            }}
            onSubmit={(v) => setQuery(v.trim())}
            onCancel={() => setQuery('')}
            placeholder={`Search ${src?.name ?? 'source'}`}
            testId="source-search"
          />
          {!query && (
            <Segmented
              options={[
                { value: 'popular', label: 'Popular' },
                { value: 'latest', label: 'Latest' },
              ]}
              value={mode}
              onChange={setMode}
            />
          )}
        </div>
      }
    >
      {hide && hiddenCount > 0 && items.length > 0 && (
        <p class="src-hidden-note" data-testid="source-hidden-note">
          <span>{hiddenCount === 1 ? '1 novel in your library is hidden' : `${hiddenCount} novels in your library are hidden`}</span>
          <button type="button" class="link-btn tap tap-dim" onClick={() => setHideInLibrary(false)} data-testid="source-show-hidden">
            Show
          </button>
        </p>
      )}
      {body}
      <div ref={sentinel} class="sentinel" />
      {filterDefs && (
        <FilterSheet
          open={filtersOpen}
          filters={filterDefs}
          values={filterValues ?? defaultFilterValues(filterDefs)}
          onApply={(v) => {
            setFilterValues(v);
            if (query) {
              setQuery('');
              setInput('');
            }
          }}
          onClose={() => setFiltersOpen(false)}
        />
      )}
      {state.status === 'more' && (
        <div class="list-loading">
          <Spinner />
        </div>
      )}
      {state.status === 'more-error' && state.error && (
        <div class="list-loading">
          <span class="list-error">{errorText(state.error)}</span>
          <Button variant="tinted" size="small" onClick={() => void load(state.page + 1)}>
            Retry
          </Button>
        </div>
      )}
      {state.status === 'ready' && !state.hasMore && items.length > 0 && <p class="list-footnote">End of results</p>}
    </Screen>
  );
}
