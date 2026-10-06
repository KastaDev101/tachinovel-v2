/**
 * Global search: one query, everything at once. Library matches first, then one carousel per
 * enabled source. Requests fan out as `browse.search` calls (at most 4 in flight) so results stream
 * in; sources with results bubble up (pinned first); a new query makes older responses stale.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LibraryEntry, SourceInfo } from '../../shared/contracts/domain.ts';
import type { BrowseItem } from '../../shared/contracts/protocol.ts';
import { bridge, errorText, toUiError, type UiError } from '../bridge/client.ts';
import { Button, SearchField } from '../components/controls.tsx';
import { Cover } from '../components/cover.tsx';
import { EmptyState } from '../components/feedback.tsx';
import { ChapterCountBadge } from '../components/novel-grid.tsx';
import { Icon } from '../components/icon.tsx';
import { Screen } from '../components/screen.tsx';
import { attachLongPress } from '../lib/gestures.ts';
import { matchesSearch } from '../lib/library-query.ts';
import { actionSheet, quickAddToLibrary, removeFromLibrary } from '../state/actions.ts';
import { openNovel, push } from '../state/nav.ts';
import { library, libraryKeys, patchSettings, settings, sources } from '../state/store.ts';
import { showToast } from '../state/toast.ts';
import { browsableSources, SourceIcon } from './browse.tsx';

const MAX_IN_FLIGHT = 4;

export interface SourceResult {
  status: 'pending' | 'loading' | 'ok' | 'error';
  items: BrowseItem[];
  error?: UiError;
}

/** Order: sources with results first, then still searching, then errors, then empty; pinned first within each. */
export function orderSources(list: readonly SourceInfo[], results: ReadonlyMap<string, SourceResult>): SourceInfo[] {
  const base = [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
  const rank = (s: SourceInfo): number => {
    const r = results.get(s.id);
    if (r?.status === 'ok' && r.items.length > 0) return 0;
    if (r?.status === 'pending' || r?.status === 'loading') return 1;
    if (r?.status === 'error') return 2;
    return 3;
  };
  return base
    .map((s, i) => ({ s, i, r: rank(s) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.s);
}

interface CarouselItem {
  key: string;
  pluginId: string;
  name: string;
  cover?: string | undefined;
  /** Source results only (library matches keep their unread focus). */
  chapterCount?: number | undefined;
  inLibrary: boolean;
  onOpen: () => void;
  onLongPress?: () => void;
}

function Carousel({ items }: { items: readonly CarouselItem[] }) {
  const row = useRef<HTMLDivElement>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    return attachLongPress(el, '[data-key]', (t) => itemsRef.current.find((i) => i.key === t.dataset['key'])?.onLongPress?.());
  }, []);
  return (
    <div class="gs-row hscroll" ref={row}>
      {items.map((it) => (
        <button type="button" class={`gs-item tap tap-scale${it.inLibrary ? ' is-in-library' : ''}`} key={it.key} data-key={it.key} onClick={it.onOpen}>
          <span class="grid-cover-wrap">
            <Cover src={it.cover} pluginId={it.pluginId} title={it.name} />
            <span class="grid-compact-title">
              <ChapterCountBadge count={it.chapterCount} />
              <span class="clamp-2">{it.name}</span>
            </span>
            {it.inLibrary && (
              <span class="badges">
                <span class="badge badge-library">In library</span>
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

const MAX_RECENTS = 15;

/** Shown while the field is empty: tap to search again, ✕ to forget one, Clear for all. */
function RecentSearches(props: { items: readonly string[]; onPick: (q: string) => void; onRemove: (q: string) => void; onClear: () => void }) {
  return (
    <section class="recents" data-testid="recent-searches">
      <div class="recents-header">
        <h3 class="recents-title">Recent Searches</h3>
        <button type="button" class="recents-clear tap tap-dim" onClick={props.onClear} data-testid="recent-clear">
          Clear
        </button>
      </div>
      {props.items.map((q) => (
        <div class="recent-row" key={q}>
          <button type="button" class="recent-main tap tap-row" onClick={() => props.onPick(q)} data-testid="recent-search">
            <Icon name="clock" size={18} class="recent-icon" />
            <span class="recent-text ellipsis">{q}</span>
          </button>
          <button type="button" class="recent-remove tap tap-dim" aria-label={`Remove “${q}”`} onClick={() => props.onRemove(q)} data-testid="recent-remove">
            <Icon name="xmark" size={12} />
          </button>
        </div>
      ))}
    </section>
  );
}

export function GlobalSearchScreen(props: { query?: string }) {
  const [input, setInput] = useState(props.query ?? '');
  const [query, setQuery] = useState(props.query ?? '');
  const [results, setResults] = useState<Map<string, SourceResult>>(new Map());
  const generation = useRef(0);
  // Same set as Browse: enabled sources in the chosen languages.
  const enabled = browsableSources(sources.value, settings.value.languages);
  const keys = libraryKeys.value;
  const recents = settings.value.recentSearches;
  const showRecents = input.trim() === '' && recents.length > 0;

  /** Search and remember the query (most recent first, no duplicates, at most 15). */
  function submit(v: string): void {
    const q = v.trim();
    setQuery(q);
    if (!q) return;
    const rest = settings.peek().recentSearches.filter((x) => x.toLowerCase() !== q.toLowerCase());
    patchSettings({ recentSearches: [q, ...rest].slice(0, MAX_RECENTS) });
  }

  function clearRecents(): void {
    const before = settings.peek().recentSearches;
    patchSettings({ recentSearches: [] });
    showToast('Recent searches cleared', { undo: () => patchSettings({ recentSearches: before }) });
  }

  async function itemMenu(item: BrowseItem): Promise<void> {
    const inLib = libraryKeys.peek().has(`${item.pluginId}:${item.path}`);
    const i = await actionSheet({ title: item.name, actions: [{ title: inLib ? 'Remove from Library' : 'Add to Library', destructive: inLib }, { title: 'Open' }] });
    if (i === 0) {
      if (inLib) removeFromLibrary([item]);
      else void quickAddToLibrary(item);
    } else if (i === 1) openNovel(item);
  }

  const update = (g: number, id: string, r: SourceResult): void => {
    if (g !== generation.current) return; // stale: a newer query is running
    setResults((m) => new Map(m).set(id, r));
  };

  async function searchOne(g: number, id: string, q: string): Promise<void> {
    update(g, id, { status: 'loading', items: [] });
    try {
      const page = await bridge().call('browse.search', { pluginId: id, query: q, page: 1 }, { timeoutMs: 45_000 });
      update(g, id, { status: 'ok', items: page.items });
    } catch (err) {
      update(g, id, { status: 'error', items: [], error: toUiError(err) });
    }
  }

  async function run(q: string): Promise<void> {
    const g = ++generation.current;
    if (!q) {
      setResults(new Map());
      return;
    }
    const ids = orderSources(enabled, new Map()).map((s) => s.id);
    setResults(new Map(ids.map((id) => [id, { status: 'pending', items: [] }])));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length && g === generation.current) {
        const id = ids[next++];
        if (id) await searchOne(g, id, q);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, ids.length) }, worker));
  }

  useLayoutEffect(() => {
    void run(query);
  }, [query]);

  // Leaving the screen makes every in-flight search stale, so the workers stop starting new ones.
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  const libMatches = useMemo<LibraryEntry[]>(() => (query ? library.value.filter((e) => matchesSearch(e, query)).slice(0, 20) : []), [query, library.value]);
  const ordered = orderSources(enabled, results);
  const done = [...results.values()].filter((r) => r.status === 'ok' || r.status === 'error').length;

  return (
    <Screen
      title="Global Search"
      back="Browse"
      testId="screen-global-search"
      accessory={
        <div class="accessory-stack">
          <SearchField
            value={input}
            onInput={(v) => {
              setInput(v);
              // An emptied field shows recent searches (or the empty state), not the last results.
              if (!v.trim()) setQuery('');
            }}
            onSubmit={submit}
            placeholder="Search library and all sources"
            autoFocus={!props.query}
            testId="global-search-field"
          />
          {query && !showRecents && results.size > 0 && (
            <p class="gs-progress tabular" aria-live="polite" data-testid="gs-progress">
              {done < results.size ? `Searching ${results.size} sources · ${done} done` : `Searched ${results.size} sources`}
            </p>
          )}
        </div>
      }
    >
      {showRecents && (
        <RecentSearches
          items={recents}
          onPick={(q) => {
            (document.activeElement as HTMLElement | null)?.blur();
            setInput(q);
            submit(q);
          }}
          onRemove={(q) => patchSettings({ recentSearches: settings.peek().recentSearches.filter((x) => x !== q) })}
          onClear={clearRecents}
        />
      )}
      {!query && !showRecents && <EmptyState icon="magnifyingglass" title="Search Everything" message="Find a novel in your library and in every enabled source at once." />}

      {query && !showRecents && libMatches.length > 0 && (
        <section class="gs-section" data-testid="gs-library">
          <div class="gs-header">
            <span class="gs-lib-icon">
              <Icon name="books.vertical.fill" size={15} />
            </span>
            <span class="gs-title">In your library</span>
            <span class="gs-count">{libMatches.length}</span>
          </div>
          <Carousel items={libMatches.map((e) => ({ key: e.key, pluginId: e.pluginId, name: e.name, cover: e.cover, inLibrary: false, onOpen: () => openNovel(e) }))} />
        </section>
      )}

      {query &&
        !showRecents &&
        ordered.map((s) => {
          const r = results.get(s.id);
          if (!r) return null;
          return (
            <section class="gs-section" key={s.id} data-testid={`gs-${s.id}`} data-status={r.status}>
              <button type="button" class="gs-header tap tap-dim" onClick={() => push({ name: 'source', pluginId: s.id, query })}>
                <SourceIcon source={s} size={26} />
                <span class="gs-title">{s.name}</span>
                {r.status === 'ok' && <span class="gs-count">{r.items.length}</span>}
                <Icon name="chevron.right" size={13} class="row-chevron" />
              </button>
              {r.status === 'pending' || r.status === 'loading' ? (
                <div class="gs-row hscroll" aria-busy="true">
                  {Array.from({ length: 4 }, (_, i) => (
                    <div class="gs-item" key={i}>
                      <span class="cover skel" />
                    </div>
                  ))}
                </div>
              ) : r.status === 'error' && r.error ? (
                <div class="gs-message is-error">
                  <span>{errorText(r.error)}</span>
                  <Button variant="tinted" size="small" onClick={() => void searchOne(generation.current, s.id, query)}>
                    Retry
                  </Button>
                </div>
              ) : r.items.length === 0 ? (
                <p class="gs-message">No results</p>
              ) : (
                <Carousel
                  items={r.items.map((it) => ({
                    key: `${it.pluginId}:${it.path}`,
                    pluginId: it.pluginId,
                    name: it.name,
                    cover: it.cover,
                    chapterCount: it.chapterCount,
                    inLibrary: keys.has(`${it.pluginId}:${it.path}`),
                    onOpen: () => openNovel(it),
                    onLongPress: () => void itemMenu(it),
                  }))}
                />
              )}
            </section>
          );
        })}
      {query && !showRecents && enabled.length === 0 && <EmptyState icon="puzzlepiece.extension" title="No Sources" message="Enable or install a source to search it." />}
    </Screen>
  );
}
