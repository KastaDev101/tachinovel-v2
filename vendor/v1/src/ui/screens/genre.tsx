/**
 * Discovery across sources. Genre search ("Genre: Action"): series with a genre — or several at once (AND) — from every
 * browsable source. Each source's genre/tag/category filter is matched to the genres
 * (lib/genre-match.ts) and `browse.list` runs with only those options set. Layout follows global
 * search: the novel's own source first, then a carousel per source (results first) with "See all"
 * into the source screen with the filter applied. Sources that lack a genre are named at the bottom;
 * there's no text-search fallback. LatestScreen: every source's Latest page in the same layout.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LibraryEntry, SourceFailureReason, SourceInfo } from '../../shared/contracts/domain.ts';
import type { BrowseItem } from '../../shared/contracts/protocol.ts';
import type { Filters } from '../../shared/lnreader/filters.ts';
import { bridge, errorText, toUiError, type UiError } from '../bridge/client.ts';
import { Button, Row, Section } from '../components/controls.tsx';
import { Cover } from '../components/cover.tsx';
import { EmptyState, ErrorState, SkeletonRows, solveChallengeThen } from '../components/feedback.tsx';
import { Icon } from '../components/icon.tsx';
import { Screen } from '../components/screen.tsx';
import { Sheet } from '../components/sheet.tsx';
import type { FilterValues } from '../lib/filters.ts';
import { genreCandidates, matchGenres, normalizeGenre, sameGenre, type GenreMatch } from '../lib/genre-match.ts';
import { clearRecentGenres, forgetGenreSearch, readRecentGenres, rememberGenreSearch, searchLabel, type GenreSearch } from '../lib/genre-recent.ts';
import { interleave, pickGenres } from '../lib/genre-recommend.ts';
import { createFiltersCache, createLimiter } from '../lib/genre-search.ts';
import { failureInfo, reasonOf } from '../lib/source-failure.ts';
import { openNovel, push } from '../state/nav.ts';
import { library, libraryKeys, settings, sources } from '../state/store.ts';
import { errorToast, showToast } from '../state/toast.ts';
import { useOnReveal } from '../components/navigator.tsx';
import { browsableSources, healthMark, recordSourceHealth, sourceHealth, SourceIcon } from './browse.tsx';

/** At most this many genre-search bridge requests in flight (all screens together). */
const MAX_IN_FLIGHT = 4;
const limiter = createLimiter(MAX_IN_FLIGHT);
/** Filter definitions, fetched once per source (and plugin version) per session. */
const filtersCache = createFiltersCache((id) => bridge().call('sources.filters', { id }));

export interface GenreResult {
  /** checking: filters not known yet · loading: results on the way · unavailable: lacks a genre (or can't combine them). */
  status: 'checking' | 'loading' | 'ok' | 'error' | 'unavailable';
  items: BrowseItem[];
  matches?: GenreMatch[];
  filters?: FilterValues;
  error?: UiError;
  /** Why the site failed, when the script could tell. */
  reason?: SourceFailureReason;
  /** Source-health mark when it failed: a success recorded after it means it's worth another try. */
  failMark?: number;
}

/** Search order: the novel's own source, then pinned, then by name. */
export function genreSourceOrder(list: readonly SourceInfo[], firstId?: string): SourceInfo[] {
  return [...list].sort((a, b) => Number(b.id === firstId) - Number(a.id === firstId) || Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
}

/** Browse's sources (enabled, in the selected languages) plus the novel's own source if it's enabled. */
function genreSources(ownId?: string): SourceInfo[] {
  const list = browsableSources(sources.value, settings.value.languages);
  const own = ownId !== undefined ? sources.value.find((s) => s.id === ownId && s.enabled) : undefined;
  if (own && !list.includes(own)) list.push(own);
  return genreSourceOrder(list, ownId);
}

/** Display order: own source first, then sources with results, still loading, errors, empty. */
function displayOrder(list: readonly SourceInfo[], results: ReadonlyMap<string, { status: string; items: readonly unknown[] }>, firstId?: string): SourceInfo[] {
  const rank = (s: SourceInfo): number => {
    const r = results.get(s.id);
    if (s.id === firstId) return -1;
    if (r?.status === 'ok' && r.items.length > 0) return 0;
    if (r?.status === 'loading') return 1;
    if (r?.status === 'error') return 2;
    return 3;
  };
  return list
    .map((s, i) => ({ s, i, r: rank(s) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.s);
}

function shortLabel(label: string): string {
  return label.replace(/\s*\(.*\)\s*$/, '').trim() || label;
}

/** "Tags · Slice of Life" for matches that aren't simply the genre itself in a genre filter. */
function matchNote(matches: readonly GenreMatch[], genres: readonly string[]): string | null {
  const notes = matches
    .map((m, i) => {
      const plainGenreFilter = /genre/i.test(`${m.key} ${m.label}`);
      if (plainGenreFilter && normalizeGenre(m.option.label) === normalizeGenre(genres[i] ?? '')) return null;
      return `${shortLabel(m.label)} · ${m.option.label}`;
    })
    .filter((n): n is string => n !== null);
  return notes.length > 0 ? notes.join(', ') : null;
}

/** Spoken name of a novel in a carousel: title, then what the badges say. */
export function itemLabel(name: string, o: { inLibrary?: boolean; isNew?: boolean; chapters?: number | undefined }): string {
  const parts = [name];
  if (o.chapters !== undefined && o.chapters > 0) parts.push(`${o.chapters} ${o.chapters === 1 ? 'chapter' : 'chapters'}`);
  if (o.isNew) parts.push('new');
  if (o.inLibrary) parts.push('in library');
  return parts.join(', ');
}

export function Carousel({ items, keys, fresh }: { items: readonly BrowseItem[]; keys: ReadonlySet<string>; fresh?: ReadonlySet<string> | undefined }) {
  // Titles on the cover only in the library's Compact display (else under it), like the library.
  const compact = settings.value.library.display === 'compact';
  return (
    <div class="gs-row hscroll">
      {items.map((it) => {
        const key = `${it.pluginId}:${it.path}`;
        const inLibrary = keys.has(key);
        const isNew = fresh?.has(key) ?? false;
        return (
          <button
            type="button"
            class={`gs-item tap tap-scale${inLibrary ? ' is-in-library' : ''}`}
            key={key}
            onClick={() => openNovel(it)}
            // One clean name for VoiceOver (not "Cover of X, X, In library").
            aria-label={itemLabel(it.name, { inLibrary, isNew })}
            data-testid="genre-item"
          >
            <span class="grid-cover-wrap">
              <Cover src={it.cover} pluginId={it.pluginId} title={it.name} />
              {compact && (
                <span class="grid-compact-title">
                  <span class="clamp-2">{it.name}</span>
                </span>
              )}
              {(inLibrary || isNew) && (
                <span class="badges">
                  {isNew && (
                    <span class="badge badge-new" data-testid="new-badge">
                      New
                    </span>
                  )}
                  {inLibrary && <span class="badge badge-library">In library</span>}
                </span>
              )}
            </span>
            {!compact && <span class="gs-name clamp-2">{it.name}</span>}
          </button>
        );
      })}
    </div>
  );
}

function SkeletonCarousel() {
  return (
    <div class="gs-row hscroll" aria-busy="true">
      {Array.from({ length: 4 }, (_, i) => (
        <div class="gs-item" key={i}>
          <span class="cover skel" />
        </div>
      ))}
    </div>
  );
}

/** One source: header (icon, name, optional note, "See all") and its carousel / skeleton / error / empty line. */
function SourceSection(props: {
  source: SourceInfo;
  status: string;
  items: readonly BrowseItem[];
  error?: UiError | undefined;
  reason?: SourceFailureReason | undefined;
  note?: string | null;
  /** Small tinted pill after the name ("3 new"). */
  pill?: string | null;
  fresh?: ReadonlySet<string> | undefined;
  onSeeAll?: (() => void) | undefined;
  onRetry: () => void;
  keys: ReadonlySet<string>;
  testPrefix: string;
}) {
  const s = props.source;
  return (
    <section class="gs-section" data-testid={`${props.testPrefix}-${s.id}`} data-status={props.status}>
      {/* A heading per source, so VoiceOver's rotor jumps between them. */}
      <h3 class="gs-h">
        <button
          type="button"
          class="gs-header genre-header tap tap-dim"
          onClick={props.onSeeAll}
          disabled={!props.onSeeAll}
          aria-label={[s.name, props.note, props.pill, props.onSeeAll ? 'see all' : null].filter(Boolean).join(', ')}
          data-testid={`${props.testPrefix}-see-all-${s.id}`}
        >
          <SourceIcon source={s} size={26} />
          <span class="genre-src">
            <span class="gs-title ellipsis">{s.name}</span>
            {props.note && <span class="genre-note ellipsis">{props.note}</span>}
          </span>
          {props.pill && (
            <span class="new-pill tabular" data-testid="new-pill">
              {props.pill}
            </span>
          )}
          <span class="genre-see-all">See all</span>
          <Icon name="chevron.right" size={13} class="row-chevron" />
        </button>
      </h3>
      {props.status === 'loading' ? (
        <SkeletonCarousel />
      ) : props.status === 'error' && props.error ? (
        <SourceErrorRow source={s} error={props.error} reason={props.reason} onRetry={props.onRetry} />
      ) : props.items.length === 0 ? (
        <p class="gs-message">No results</p>
      ) : (
        <Carousel items={props.items} keys={props.keys} fresh={props.fresh} />
      )}
    </section>
  );
}

/**
 * A source that failed: what went wrong in plain words (the script's reason when it has one, see
 * lib/source-failure.ts) and the one thing to do about it: pass the site's check, try again, or
 * install the newer plugin. Global search, genre search and Latest.
 */
export function SourceErrorRow(props: { source: SourceInfo; error: UiError; reason: SourceFailureReason | undefined; onRetry: () => void }) {
  const { source: s, error } = props;
  const info = props.reason ? failureInfo(props.reason) : null;
  // Without a reason, a Cloudflare error still means the site's bot check.
  const fallback = error.code === 'CLOUDFLARE' ? failureInfo('bot-check') : null;
  const known = info ?? fallback;
  // A known reason decides the action, including none ("This site no longer exists").
  const action = known ? known.action : 'retry';
  const text = known ? known.text : errorText(error);
  return (
    <div class="gs-message is-error" data-testid="source-error" data-reason={props.reason ?? ''}>
      <span>{text}</span>
      {action === 'open-site' ? (
        <Button variant="tinted" size="small" icon="safari" onClick={() => void solveChallengeThen(s.id, props.onRetry)()} label={`Open ${s.name} to verify`}>
          Open site to verify
        </Button>
      ) : action === 'retry' ? (
        <Button variant="tinted" size="small" onClick={props.onRetry} label={`Retry ${s.name}`}>
          Retry
        </Button>
      ) : action === 'update' && s.updateAvailable ? (
        <Button variant="tinted" size="small" onClick={() => void updateThenRetry(s, props.onRetry)} label={`Update ${s.name} to v${s.updateAvailable}`}>
          Update
        </Button>
      ) : null}
    </div>
  );
}

/** "The site changed": install the newer plugin, then try again. */
async function updateThenRetry(s: SourceInfo, retry: () => void): Promise<void> {
  try {
    const u = await bridge().call('sources.update', { id: s.id }, { timeoutMs: 60_000 });
    sources.value = sources.value.map((x) => (x.id === u.id ? u : x));
    showToast(`${s.name} updated to v${u.version}`);
    retry();
  } catch (err) {
    errorToast(errorText(toUiError(err)));
  }
}

/**
 * Back on this screen: search again the sources that failed here but have worked since — passed their
 * bot check on the source screen, say. Only those, and only once each.
 */
export function useRerunRecovered(results: ReadonlyMap<string, { status: string; failMark?: number | undefined }>, rerun: (id: string) => void): void {
  const ref = useRef(results);
  ref.current = results;
  useOnReveal(() => {
    const health = sourceHealth.peek();
    for (const [id, r] of ref.current) {
      const h = health.get(id);
      if (r.status === 'error' && r.failMark !== undefined && h?.ok && h.seq > r.failMark) rerun(id);
    }
  });
}

/**
 * Every source that could answer failed because the phone is offline: that error, so the screen shows
 * one offline state (with Try Again) instead of a "You're offline" row per source. Null otherwise,
 * including while any source is still loading.
 */
export function offlineEverywhere(results: Iterable<{ status: string; error?: UiError | undefined; reason?: SourceFailureReason | undefined }>): UiError | null {
  let first: UiError | null = null;
  for (const r of results) {
    if (r.status === 'unavailable') continue; // sources without the genre weren't asked
    if (r.status !== 'error' || !r.error || !(r.reason === 'offline' || r.error.offline)) return null;
    first ??= r.error;
  }
  return first;
}

/** Placeholder sections while nothing can be shown yet. */
function CheckingPlaceholder({ count, testId }: { count: number; testId: string }) {
  return (
    <div aria-busy="true" data-testid={testId}>
      {Array.from({ length: Math.min(2, count) }, (_, i) => (
        <section class="gs-section" key={i}>
          <div class="gs-header">
            <span class="skel genre-skel-icon" />
            <span class="skel genre-skel-title" />
          </div>
          <SkeletonCarousel />
        </section>
      ))}
    </div>
  );
}

/** Filter definitions of every browsable source that has filters (cached; at most 4 requests at once). */
async function loadAllFilters(): Promise<{ defs: (Filters | null)[]; failed: number }> {
  const list = browsableSources(sources.peek(), settings.peek().languages).filter((s) => s.hasFilters);
  const got = await Promise.all(
    list.map(async (s): Promise<Filters | null | undefined> => {
      try {
        return filtersCache.has(s.id, s.version) ? await filtersCache.get(s.id, s.version) : await limiter.run(() => filtersCache.get(s.id, s.version));
      } catch (err) {
        recordSourceHealth(s.id, toUiError(err));
        return undefined;
      }
    }),
  );
  return { defs: got.map((f) => f ?? null), failed: got.filter((f) => f === undefined).length };
}

/** Genre search for one genre or a combination (the first is the screen's genre, the rest `also`). */
function openGenreSearch(search: GenreSearch): void {
  const [first, ...rest] = search;
  if (first) push({ name: 'genre', genre: first, ...(rest.length > 0 ? { also: rest } : {}) });
}

/**
 * Browse › Genres: your recent genre searches, then every genre the sources can filter by — the most
 * widely supported first as chips, then A–Z with how many sources have each. Picking one opens genre
 * search.
 */
export function GenresSheet(props: { open: boolean; onClose: () => void }) {
  const [state, setState] = useState<{ defs: (Filters | null)[]; failed: number } | null>(null);
  const [recent, setRecent] = useState<GenreSearch[]>([]);
  useEffect(() => {
    if (props.open) setRecent(readRecentGenres());
  }, [props.open]);
  useEffect(() => {
    if (!props.open) return;
    let live = true;
    void loadAllFilters().then((r) => {
      if (live) setState(r);
    });
    return () => {
      live = false;
    };
  }, [props.open]);
  const all = useMemo(() => (state ? genreCandidates(state.defs, []) : []), [state]);
  const popular = useMemo(() => [...all].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 8), [all]);
  const pick = (genre: string): void => {
    props.onClose();
    push({ name: 'genre', genre });
  };
  const pickRecent = (search: GenreSearch): void => {
    props.onClose();
    openGenreSearch(search);
  };

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Genres" detents={['medium', 'large']} testId="genres-sheet">
      <div class="filters">
        {recent.length > 0 && (
          <section class="group genre-recent" data-testid="genre-recent">
            <div class="genre-recent-header">
              <h3 class="group-header">Recent</h3>
              <button
                type="button"
                class="link-btn tap tap-dim"
                onClick={() => {
                  clearRecentGenres();
                  setRecent([]);
                }}
                aria-label="Clear recent genres"
                data-testid="genre-recent-clear"
              >
                Clear
              </button>
            </div>
            <div class="genre-popular">
              {recent.map((r) => (
                <span class="genre-recent-chip" key={searchLabel(r)}>
                  <button type="button" class="chip genre-pop-chip tap tap-dim" onClick={() => pickRecent(r)} data-testid="genre-recent-chip">
                    <Icon name="clock" size={13} />
                    {searchLabel(r)}
                  </button>
                  <button
                    type="button"
                    class="genre-recent-remove tap tap-dim"
                    aria-label={`Remove ${searchLabel(r)} from recent genres`}
                    onClick={() => {
                      forgetGenreSearch(r);
                      setRecent(readRecentGenres());
                    }}
                    data-testid="genre-recent-remove"
                  >
                    <Icon name="xmark" size={10} />
                  </button>
                </span>
              ))}
            </div>
          </section>
        )}
        {!state ? (
          <SkeletonRows count={6} height={48} />
        ) : all.length === 0 ? (
          <EmptyState icon="magnifyingglass" title="No Genres" message="None of your sources has a genre or tag filter." />
        ) : (
          <>
            <section class="group">
              <h3 class="group-header">On the most sources</h3>
              <div class="genre-popular">
                {popular.map((g) => (
                  <button type="button" class="chip genre-pop-chip tap tap-dim" key={g.label} onClick={() => pick(g.label)} data-testid={`genre-popular-${g.label}`}>
                    {g.label}
                  </button>
                ))}
              </div>
            </section>
            <Section
              header="All genres"
              footer={`From your sources’ genre and tag filters; counts are sources that can search each one.${state.failed > 0 ? ` ${state.failed} ${state.failed === 1 ? 'source' : 'sources'} couldn’t be checked.` : ''}`}
            >
              {all.map((g) => (
                <Row key={g.label} title={g.label} value={`${g.count} ${g.count === 1 ? 'source' : 'sources'}`} chevron onClick={() => pick(g.label)} testId={`genre-pick-${g.label}`} />
              ))}
            </Section>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** "Add a genre": genres the sources' filters still offer together with the current ones. */
function AddGenreSheet(props: { open: boolean; onClose: () => void; selected: readonly string[]; defs: readonly (Filters | null)[]; onAdd: (genre: string) => void }) {
  const candidates = useMemo(() => (props.open ? genreCandidates(props.defs, props.selected) : []), [props.open, props.defs, props.selected]);
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Add Genre" detents={['medium', 'large']} testId="add-genre-sheet">
      <div class="filters">
        {candidates.length === 0 ? (
          <EmptyState icon="magnifyingglass" title="Nothing to Add" message="Your sources have no other genre that combines with these." />
        ) : (
          <Section footer="Results must have every selected genre. Counts are sources that can filter by all of them.">
            {candidates.map((c) => (
              <Row
                key={c.label}
                title={c.label}
                value={`${c.count} ${c.count === 1 ? 'source' : 'sources'}`}
                onClick={() => {
                  props.onAdd(c.label);
                  props.onClose();
                }}
                testId={`add-genre-${c.label}`}
              />
            ))}
          </Section>
        )}
      </div>
    </Sheet>
  );
}

export function GenreScreen(props: { genre: string; pluginId?: string; also?: string[] }) {
  const [genres, setGenres] = useState<string[]>(() =>
    [props.genre, ...(props.also ?? [])].map((g) => g.trim()).filter((g, i, all) => g !== '' && all.findIndex((x) => sameGenre(x, g)) === i),
  );
  const [addOpen, setAddOpen] = useState(false);
  const list = genreSources(props.pluginId);
  const [results, setResults] = useState<Map<string, GenreResult>>(() => new Map(list.map((s) => [s.id, { status: 'checking', items: [] }])));
  /** Filter definitions this screen has seen (for "Add genre"). */
  const [defs, setDefs] = useState<Map<string, Filters | null>>(new Map());
  /** Latest request token per source: older responses (a Retry overtaking them, a changed selection, a closed screen) are dropped. */
  const tokens = useRef(new Map<string, number>());
  const seq = useRef(0);
  const alive = useRef(true);
  const keys = libraryKeys.value;
  const genresKey = genres.join('\u0000');

  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const set = (id: string, token: number, r: GenreResult): void => {
    if (!alive.current || tokens.current.get(id) !== token) return;
    setResults((m) => new Map(m).set(id, r));
  };

  async function searchOne(s: SourceInfo): Promise<void> {
    const token = ++seq.current;
    tokens.current.set(s.id, token);
    const current = (): boolean => alive.current && tokens.current.get(s.id) === token;
    if (!s.hasFilters) {
      set(s.id, token, { status: 'unavailable', items: [] });
      return;
    }
    set(s.id, token, { status: 'checking', items: [] });
    let found: ReturnType<typeof matchGenres>;
    try {
      const f = filtersCache.has(s.id, s.version)
        ? await filtersCache.get(s.id, s.version)
        : await limiter.run(() => (current() ? filtersCache.get(s.id, s.version) : Promise.resolve(null)));
      if (!current()) return;
      setDefs((m) => (m.get(s.id) === f ? m : new Map(m).set(s.id, f)));
      found = matchGenres(f, genres);
      if (!found) {
        set(s.id, token, { status: 'unavailable', items: [] });
        return;
      }
    } catch (err) {
      const e = toUiError(err);
      recordSourceHealth(s.id, e);
      const reason = reasonOf(err) ?? reasonOf(e);
      set(s.id, token, { status: 'error', items: [], error: e, failMark: healthMark(), ...(reason ? { reason } : {}) });
      return;
    }
    const { matches, values: filters } = found;
    set(s.id, token, { status: 'loading', items: [], matches, filters });
    try {
      const page = await limiter.run(() =>
        current() ? bridge().call('browse.list', { pluginId: s.id, page: 1, mode: 'popular', filters }, { timeoutMs: 45_000 }) : Promise.resolve(null),
      );
      if (page) {
        recordSourceHealth(s.id);
        set(s.id, token, { status: 'ok', items: page.items, matches, filters });
      }
    } catch (err) {
      const e = toUiError(err);
      recordSourceHealth(s.id, e);
      const reason = reasonOf(err) ?? reasonOf(e);
      set(s.id, token, { status: 'error', items: [], matches, filters, error: e, failMark: healthMark(), ...(reason ? { reason } : {}) });
    }
  }

  useLayoutEffect(() => {
    setResults(new Map(list.map((s) => [s.id, { status: 'checking', items: [] }])));
    for (const s of list) void searchOne(s);
  }, [genresKey]);
  useRerunRecovered(results, (id) => {
    const s = list.find((x) => x.id === id);
    if (s) void searchOne(s);
  });
  // Offered again in Browse › Genres.
  useEffect(() => rememberGenreSearch(genres), [genresKey]);

  function addGenre(g: string): void {
    if (!genres.some((x) => sameGenre(x, g))) setGenres([...genres, g]);
  }

  function removeGenre(g: string): void {
    if (genres.length > 1) setGenres(genres.filter((x) => x !== g));
  }

  const shown = displayOrder(
    list.filter((s) => {
      const st = results.get(s.id)?.status;
      return st !== undefined && st !== 'checking' && st !== 'unavailable';
    }),
    results,
    props.pluginId,
  );
  const unavailable = list.filter((s) => results.get(s.id)?.status === 'unavailable');
  const checking = list.filter((s) => results.get(s.id)?.status === 'checking').length;
  const done = list.filter((s) => {
    const st = results.get(s.id)?.status;
    return st === 'ok' || st === 'error' || st === 'unavailable';
  }).length;
  const finished = list.length > 0 && done === list.length;
  const offline = finished ? offlineEverywhere(results.values()) : null;
  const defList = useMemo(() => list.map((s) => defs.get(s.id) ?? null), [defs, list.map((s) => s.id).join()]);
  const multi = genres.length > 1;

  return (
    <Screen
      // Several genres: the chips under the bar spell them out.
      title={multi ? `${genres.length} Genres` : `Genre: ${genres[0] ?? ''}`}
      back
      testId="screen-genre"
      accessory={
        list.length > 0 ? (
          <div class="accessory-stack genre-accessory">
            <div class="genre-chips hscroll" data-testid="genre-chips">
              {genres.map((g) => (
                <button
                  type="button"
                  class={`chip is-selected genre-chip${multi ? ' tap tap-dim' : ''}`}
                  key={g}
                  onClick={() => removeGenre(g)}
                  disabled={!multi}
                  aria-label={multi ? `Remove ${g}` : g}
                  data-testid="genre-chip"
                >
                  {g}
                  {multi && <Icon name="xmark" size={10} class="genre-chip-x" />}
                </button>
              ))}
              <button type="button" class="chip genre-add tap tap-dim" onClick={() => setAddOpen(true)} disabled={checking > 0} data-testid="genre-add">
                <Icon name="plus" size={12} />
                Genre
              </button>
            </div>
            <p class="gs-progress tabular" aria-live="polite" data-testid="genre-progress">
              {finished ? `Searched ${list.length} ${list.length === 1 ? 'source' : 'sources'}` : `Searching ${list.length} sources · ${done} done`}
            </p>
          </div>
        ) : undefined
      }
    >
      {list.length === 0 && <EmptyState icon="puzzlepiece.extension" title="No Sources" message="Enable or install a source to browse it by genre." />}

      {offline && (
        <ErrorState
          error={offline}
          onRetry={() => {
            for (const s of list) void searchOne(s);
          }}
        />
      )}

      {!offline && shown.map((s) => {
        const r = results.get(s.id);
        if (!r) return null;
        const filters = r.filters;
        return (
          <SourceSection
            key={s.id}
            source={s}
            status={r.status}
            items={r.items}
            error={r.error}
            reason={r.reason}
            note={r.matches ? matchNote(r.matches, genres) : null}
            onSeeAll={filters ? () => push({ name: 'source', pluginId: s.id, filters }) : undefined}
            onRetry={() => void searchOne(s)}
            keys={keys}
            testPrefix="genre"
          />
        );
      })}

      {shown.length === 0 && checking > 0 && <CheckingPlaceholder count={checking} testId="genre-checking" />}

      {finished && shown.length === 0 && unavailable.length > 0 && (
        <EmptyState
          icon="magnifyingglass"
          title={multi ? 'Combination Not Available' : 'Genre Not Available'}
          message={multi ? `None of your sources can filter by ${genres.map((g) => `“${g}”`).join(' and ')} together.` : `None of your sources can filter by “${genres[0] ?? ''}”.`}
          testId="genre-empty"
        />
      )}

      {!offline && unavailable.length > 0 && (checking === 0 || shown.length > 0) && (
        <p class="list-footnote genre-unavailable" data-testid="genre-unavailable">
          Not available on: {unavailable.map((s) => s.name).join(', ')}
        </p>
      )}

      <AddGenreSheet open={addOpen} onClose={() => setAddOpen(false)} selected={genres} defs={defList} onAdd={addGenre} />
    </Screen>
  );
}

// ---------- latest from all sources ----------

/** Per source, the Latest items already seen (newest first), kept on this device. */
const SEEN_KEY = 'tachinovel.latest.seen.v1';
const SEEN_CAP = 120;

function readSeen(): Record<string, string[]> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

function markSeen(pluginId: string, keys: readonly string[]): void {
  try {
    const all = readSeen();
    all[pluginId] = [...new Set([...keys, ...(all[pluginId] ?? [])])].slice(0, SEEN_CAP);
    localStorage.setItem(SEEN_KEY, JSON.stringify(all));
  } catch {
    // Private mode / storage full: no "new" markers next time, nothing else changes.
  }
}

interface LatestResult {
  status: 'loading' | 'ok' | 'error';
  items: BrowseItem[];
  error?: UiError;
  reason?: SourceFailureReason;
  failMark?: number;
}

/**
 * "Latest": each browsable source's Latest page side by side (pinned first, then sources with
 * results), streamed through the same 4-request limiter; "See all" opens the source on its Latest tab.
 * Items that weren't there on the last visit are marked "New" and their sources come first.
 */
export function LatestScreen() {
  const list = genreSourceOrder(browsableSources(sources.value, settings.value.languages));
  /** What was seen before this visit (snapshot: marking items seen now doesn't clear the markers). */
  const [seenBefore] = useState(readSeen);
  const [results, setResults] = useState<Map<string, LatestResult>>(() => new Map(list.map((s) => [s.id, { status: 'loading', items: [] }])));
  const tokens = useRef(new Map<string, number>());
  const seq = useRef(0);
  const alive = useRef(true);
  const keys = libraryKeys.value;

  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  async function loadOne(s: SourceInfo): Promise<void> {
    const token = ++seq.current;
    tokens.current.set(s.id, token);
    const current = (): boolean => alive.current && tokens.current.get(s.id) === token;
    const set = (r: LatestResult): void => {
      if (current()) setResults((m) => new Map(m).set(s.id, r));
    };
    set({ status: 'loading', items: [] });
    try {
      const page = await limiter.run(() => (current() ? bridge().call('browse.list', { pluginId: s.id, page: 1, mode: 'latest' }, { timeoutMs: 45_000 }) : Promise.resolve(null)));
      if (page) {
        recordSourceHealth(s.id);
        set({ status: 'ok', items: page.items });
        if (current()) markSeen(s.id, page.items.map((it) => `${it.pluginId}:${it.path}`));
      }
    } catch (err) {
      const e = toUiError(err);
      recordSourceHealth(s.id, e);
      const reason = reasonOf(err) ?? reasonOf(e);
      set({ status: 'error', items: [], error: e, failMark: healthMark(), ...(reason ? { reason } : {}) });
    }
  }

  useLayoutEffect(() => {
    for (const s of list) void loadOne(s);
  }, []);
  useRerunRecovered(results, (id) => {
    const s = list.find((x) => x.id === id);
    if (s) void loadOne(s);
  });

  const done = list.filter((s) => results.get(s.id)?.status !== 'loading').length;
  /** New since the last visit (only for sources visited before: a first visit marks nothing). */
  const fresh = new Map<string, Set<string>>();
  for (const s of list) {
    const before = seenBefore[s.id];
    const r = results.get(s.id);
    if (!before || r?.status !== 'ok') continue;
    const seen = new Set(before);
    const keysNew = r.items.map((it) => `${it.pluginId}:${it.path}`).filter((k) => !seen.has(k));
    if (keysNew.length > 0) fresh.set(s.id, new Set(keysNew));
  }
  const offline = done === list.length ? offlineEverywhere(results.values()) : null;
  const shown = displayOrder(list, results)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => Number(fresh.has(b.s.id)) - Number(fresh.has(a.s.id)) || a.i - b.i)
    .map((x) => x.s);

  return (
    <Screen
      title="Latest"
      back
      testId="screen-latest"
      onRefresh={async () => {
        await Promise.all(list.map((s) => loadOne(s)));
      }}
      accessory={
        list.length > 0 ? (
          <p class="gs-progress tabular" aria-live="polite" data-testid="latest-progress">
            {done === list.length ? `Checked ${list.length} ${list.length === 1 ? 'source' : 'sources'}` : `Checking ${list.length} sources · ${done} done`}
          </p>
        ) : undefined
      }
    >
      {list.length === 0 && <EmptyState icon="puzzlepiece.extension" title="No Sources" message="Enable or install a source to see what’s new." />}
      {offline && (
        <ErrorState
          error={offline}
          onRetry={() => {
            for (const s of list) void loadOne(s);
          }}
        />
      )}
      {!offline && shown.map((s) => {
        const r = results.get(s.id);
        if (!r) return null;
        return (
          <SourceSection
            key={s.id}
            source={s}
            status={r.status}
            items={r.items}
            error={r.error}
            reason={r.reason}
            pill={fresh.has(s.id) ? `${fresh.get(s.id)?.size ?? 0} new` : null}
            fresh={fresh.get(s.id)}
            onSeeAll={() => push({ name: 'source', pluginId: s.id, mode: 'latest' })}
            onRetry={() => void loadOne(s)}
            keys={keys}
            testPrefix="latest"
          />
        );
      })}
    </Screen>
  );
}

// ---------- for you ("Because you read X") ----------

/** Genres of library novels (from their stored details), once per session. */
const genresOf = new Map<string, Promise<string[]>>();

function novelGenres(e: LibraryEntry): Promise<string[]> {
  let p = genresOf.get(e.key);
  if (!p) {
    p = limiter.run(() => bridge().call('novel.get', { pluginId: e.pluginId, path: e.path })).then(
      (page) => page.details.genres,
      () => {
        genresOf.delete(e.key);
        return [];
      },
    );
    genresOf.set(e.key, p);
  }
  return p;
}

/** One source's popular page for these genres (all of them), or null when it can't filter by them. */
async function genreItems(s: SourceInfo, genres: readonly string[], alive: () => boolean, errors: UiError[]): Promise<BrowseItem[] | null> {
  if (!s.hasFilters) return null;
  try {
    const f = filtersCache.has(s.id, s.version) ? await filtersCache.get(s.id, s.version) : await limiter.run(() => filtersCache.get(s.id, s.version));
    const found = matchGenres(f, genres);
    if (!found || !alive()) return null;
    const page = await limiter.run(() => (alive() ? bridge().call('browse.list', { pluginId: s.id, page: 1, mode: 'popular', filters: found.values }, { timeoutMs: 45_000 }) : Promise.resolve(null)));
    if (page) recordSourceHealth(s.id);
    return page?.items ?? null;
  } catch (err) {
    const e = toUiError(err);
    recordSourceHealth(s.id, e);
    errors.push(e);
    return null;
  }
}

interface ForYouRow {
  status: 'loading' | 'ok' | 'none' | 'error';
  genres: string[];
  items: BrowseItem[];
  /** Every source failed (offline, say): why, instead of "nothing new". */
  error?: UiError;
  reason?: SourceFailureReason;
}

/** Seeds: the most recently read library novels. */
const SEEDS = 3;
/** How many recent reads shape "taste" (which of a seed's genres matter most). */
const TASTE = 8;

/**
 * For You: "Because you read X" rows. For each recently read library novel, its genres most common
 * in what you read (two, else one) are searched on every browsable source with the genre engine;
 * results are interleaved across sources, minus your library. Tap a row's header for the full genre
 * search.
 */
export function ForYouScreen() {
  const recent = useMemo(
    () => [...library.peek()].filter((e) => e.lastReadAt !== undefined).sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0)).slice(0, TASTE),
    [],
  );
  const seeds = recent.slice(0, SEEDS);
  const [rows, setRows] = useState<Map<string, ForYouRow>>(() => new Map(seeds.map((e) => [e.key, { status: 'loading', genres: [], items: [] }])));
  const alive = useRef(true);
  const keys = libraryKeys.value;

  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  /** Genres of the recent reads (taste), fetched once for every row. */
  const taste = useRef<Promise<string[][]> | null>(null);

  async function loadSeed(seed: LibraryEntry, i: number): Promise<void> {
    const isAlive = (): boolean => alive.current;
    const set = (r: ForYouRow): void => {
      if (alive.current) setRows((m) => new Map(m).set(seed.key, r));
    };
    set({ status: 'loading', genres: [], items: [] });
    taste.current ??= Promise.all(recent.map(novelGenres));
    const all = await taste.current;
    const list = browsableSources(sources.peek(), settings.peek().languages);
    const exclude = new Set(libraryKeys.peek());
    const errors: UiError[] = [];
    let picked = pickGenres(all[i] ?? [], all, 2);
    const search = async (genres: string[]): Promise<BrowseItem[][]> =>
      (await Promise.all(list.map((s) => genreItems(s, genres, isAlive, errors)))).filter((x): x is BrowseItem[] => x !== null);
    let lists = picked.length > 0 ? await search(picked) : [];
    // Two genres together too narrow (or nowhere to search them): the main one alone.
    if (picked.length > 1 && lists.reduce((n, l) => n + l.length, 0) < 4) {
      picked = picked.slice(0, 1);
      lists = await search(picked);
    }
    // Nothing answered and something failed: say why (not "nothing new").
    const failed = errors.find((e) => e.offline) ?? errors[0];
    if (lists.length === 0 && failed) {
      const reason = reasonOf(failed);
      set({ status: 'error', genres: picked, items: [], error: failed, ...(reason ? { reason } : {}) });
      return;
    }
    const items = interleave(lists, (it) => `${it.pluginId}:${it.path}`, new Set([...exclude, seed.key]), 20);
    set({ status: items.length > 0 ? 'ok' : 'none', genres: picked, items });
  }

  useLayoutEffect(() => {
    seeds.forEach((seed, i) => void loadSeed(seed, i));
  }, []);
  const offline = offlineEverywhere(rows.values());

  return (
    <Screen title="For You" back testId="screen-for-you">
      {seeds.length === 0 && (
        <EmptyState icon="books.vertical.fill" title="Read Something First" message="Recommendations come from the genres of novels you read in your library." testId="for-you-empty" />
      )}
      {offline && <ErrorState error={offline} onRetry={() => seeds.forEach((seed, i) => void loadSeed(seed, i))} />}
      {!offline && seeds.map((seed, i) => {
        const r = rows.get(seed.key);
        if (!r) return null;
        const [first, ...rest] = r.genres;
        return (
          <section class="gs-section" key={seed.key} data-testid="for-you-row" data-status={r.status}>
            <h3 class="gs-h">
              <button
                type="button"
                class="gs-header genre-header tap tap-dim"
                onClick={first ? () => push({ name: 'genre', genre: first, ...(rest.length > 0 ? { also: rest } : {}) }) : undefined}
                disabled={!first}
                aria-label={`Because you read ${seed.name}${r.genres.length > 0 ? `: ${r.genres.join(', ')}` : ''}${first ? ', see all' : ''}`}
                data-testid="for-you-see-all"
              >
                <Cover src={seed.cover} pluginId={seed.pluginId} title={seed.name} class="foryou-seed" />
                <span class="genre-src">
                  <span class="genre-note">Because you read</span>
                  <span class="gs-title ellipsis">{seed.name}</span>
                  {r.genres.length > 0 && <span class="genre-note ellipsis">{r.genres.join(' · ')}</span>}
                </span>
                <span class="genre-see-all">See all</span>
                <Icon name="chevron.right" size={13} class="row-chevron" />
              </button>
            </h3>
            {r.status === 'loading' ? (
              <SkeletonCarousel />
            ) : r.status === 'error' && r.error ? (
              <div class="gs-message is-error" data-testid="source-error" data-reason={r.reason ?? ''}>
                <span>{r.reason ? failureInfo(r.reason).text : errorText(r.error)}</span>
                <Button variant="tinted" size="small" onClick={() => void loadSeed(seed, i)} label={`Retry ${seed.name}`}>
                  Retry
                </Button>
              </div>
            ) : r.items.length > 0 ? (
              <Carousel items={r.items} keys={keys} />
            ) : (
              <p class="gs-message">{r.genres.length > 0 ? `Nothing new in ${r.genres.join(' · ')} on your sources.` : 'No genres to go on for this one.'}</p>
            )}
          </section>
        );
      })}
      {seeds.length > 0 && !offline && <p class="list-footnote">Based on the genres of what you read lately, from every source you browse.</p>}
    </Screen>
  );
}
