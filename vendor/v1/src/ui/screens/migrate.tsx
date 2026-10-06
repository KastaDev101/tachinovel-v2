/**
 * Migrate (More › Migrate): move a library novel to another source and keep its progress.
 * 1. MigrateScreen lists the library grouped by source.
 * 2. MigrateSearchScreen searches every other enabled source for the novel's title (`browse.search`,
 *    at most 4 in flight, results stream in, best title matches first).
 * 3. Picking a match opens a sheet: `migrate.preview` (chapters matched, read marks carried, resume
 *    point), a "Keep old entry" switch, then `migrate.apply`.
 * Batch: "Migrate All" on a source's group matches every novel on a chosen source by title (strong
 * matches only), lets you review and untick them, then migrates them one by one.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LibraryEntry, NovelSummary, SourceInfo } from '../../shared/contracts/domain.ts';
import type { BrowseItem } from '../../shared/contracts/protocol.ts';
import { bridge, errorText, toUiError, type UiError } from '../bridge/client.ts';
import { Button, Row, SearchField, Section, Spinner, SwitchRow } from '../components/controls.tsx';
import { Cover } from '../components/cover.tsx';
import { EmptyState, ErrorState, SkeletonLine, solveChallengeThen } from '../components/feedback.tsx';
import { useAsync } from '../components/hooks.ts';
import { Icon } from '../components/icon.tsx';
import { Screen } from '../components/screen.tsx';
import { Sheet } from '../components/sheet.tsx';
import { plural } from '../lib/format.ts';
import { matchesSearch } from '../lib/library-query.ts';
import { batchStatus, bestMatch, groupBySource, matchConfidence, previewSentence, rankMatches, readMarksLine, runLimited, STRONG_MATCH, type MatchConfidence } from '../lib/migrate-match.ts';
import { actionSheet } from '../state/actions.ts';
import { openNovel, pop, push } from '../state/nav.ts';
import { library, libraryKeys, progressVersion, reloadLibrary, removeLibraryEntries, settings, sources, upsertLibraryEntry } from '../state/store.ts';
import { errorToast, showToast } from '../state/toast.ts';
import { browsableSources, SourceIcon } from './browse.tsx';
import '../styles/extras.css';

const MAX_IN_FLIGHT = 4;

// ---------- 1. library list ----------

export function MigrateScreen() {
  const [search, setSearch] = useState('');
  const all = library.value;
  const groups = useMemo(() => groupBySource(all.filter((e) => matchesSearch(e, search)), sources.value), [all, search, sources.value]);
  const [batch, setBatch] = useState<{ n: number; open: boolean; fromId: string; to: SourceInfo | null; entries: LibraryEntry[] }>({ n: 0, open: false, fromId: '', to: null, entries: [] });

  async function startBatch(fromId: string): Promise<void> {
    const entries = all.filter((e) => e.pluginId === fromId).sort((a, b) => a.name.localeCompare(b.name));
    const targets = orderTargets(
      browsableSources(sources.value, settings.value.languages).filter((s) => s.id !== fromId),
      new Map(),
    );
    if (targets.length === 0) {
      showToast('Enable another source to migrate to');
      return;
    }
    const fromName = sources.value.find((s) => s.id === fromId)?.name ?? fromId;
    const i = await actionSheet({
      title: `Move ${plural(entries.length, 'novel')} from ${fromName} to…`,
      message: 'Each novel is matched by its title. You can review the matches before anything moves.',
      actions: targets.map((t) => ({ title: t.name })),
    });
    const to = targets[i];
    if (to) setBatch((b) => ({ n: b.n + 1, open: true, fromId, to, entries }));
  }

  let body;
  if (all.length === 0)
    body = <EmptyState icon="arrow.triangle.2.circlepath" title="Nothing to Migrate" message="Add novels to your library first. Then you can move one to another source and keep your progress." />;
  else if (groups.length === 0) body = <EmptyState icon="magnifyingglass" title="No Results" message={`Nothing in your library matches “${search}”.`} />;
  else
    body = (
      <div class="grouped">
        <p class="mig-intro">Pick a novel to find it on another source. Read marks, bookmarks, your position, categories and history come along.</p>
        {groups.map((g) => {
          const src = sources.value.find((s) => s.id === g.pluginId);
          return (
            <Section
              key={g.pluginId}
              header={
                <span class="mig-group-header">
                  {src && <SourceIcon source={src} size={18} />}
                  {g.name}
                  <span class="mig-group-count" aria-hidden="true">
                    {g.entries.length}
                  </span>
                  <span class="sr-only">, {plural(g.entries.length, 'novel')}</span>
                </span>
              }
              {...(all.filter((e) => e.pluginId === g.pluginId).length > 1
                ? {
                    headerAction: (
                      <button
                        type="button"
                        class="mig-all tap tap-dim"
                        onClick={() => void startBatch(g.pluginId)}
                        aria-label={`Migrate all ${g.name} novels`}
                        data-testid={`migrate-all-${g.pluginId}`}
                      >
                        Migrate All
                      </button>
                    ),
                  }
                : {})}
            >
              {g.entries.map((e) => (
                <Row
                  key={e.key}
                  class="mig-row"
                  leading={<Cover src={e.cover} pluginId={e.pluginId} class="cover-thumb" />}
                  title={e.name}
                  subtitle={`${plural(e.chapterCount, 'chapter')}${e.lastChapterName ? ` · ${e.lastChapterName}` : ''}`}
                  chevron
                  onClick={() => push({ name: 'migrateSearch', pluginId: e.pluginId, path: e.path })}
                  testId="migrate-novel"
                />
              ))}
            </Section>
          );
        })}
      </div>
    );

  return (
    <Screen
      class="is-grouped"
      title="Migrate"
      back="More"
      testId="screen-migrate"
      accessory={all.length > 0 ? <SearchField value={search} onInput={setSearch} placeholder="Search library" testId="migrate-filter" /> : undefined}
    >
      {body}
      <Sheet open={batch.open} onClose={() => setBatch((b) => ({ ...b, open: false }))} title="Migrate All" detents={['large']} testId="batch-sheet">
        {batch.to && (
          <BatchBody
            key={batch.n}
            fromId={batch.fromId}
            to={batch.to}
            entries={batch.entries}
            onDone={() => setBatch((b) => ({ ...b, open: false }))}
          />
        )}
      </Sheet>
    </Screen>
  );
}

// ---------- batch: a whole source ----------

type BatchState = 'searching' | 'found' | 'none' | 'error' | 'migrating' | 'done' | 'failed';

interface BatchItem {
  entry: LibraryEntry;
  state: BatchState;
  match?: BrowseItem & { score: number };
  error?: UiError;
  selected: boolean;
}

function batchSubtitle(it: BatchItem, toName: string): string {
  switch (it.state) {
    case 'searching':
      return 'Searching…';
    case 'found':
      return it.match?.name === it.entry.name ? `Same title on ${toName}` : `Match: ${it.match?.name ?? ''}`;
    case 'none':
      return `No close match on ${toName}`;
    case 'error':
      return it.error ? errorText(it.error) : 'Couldn’t search';
    case 'migrating':
      return 'Migrating…';
    case 'done':
      return `Moved to ${toName}`;
    case 'failed':
      return `Failed: ${it.error ? errorText(it.error) : 'unknown error'}`;
  }
}

function BatchBody(props: { fromId: string; to: SourceInfo; entries: LibraryEntry[]; onDone: () => void }) {
  const { to } = props;
  const from = sources.value.find((s) => s.id === props.fromId);
  const [items, setItems] = useState<BatchItem[]>(() => props.entries.map((entry) => ({ entry, state: 'searching', selected: false })));
  const [phase, setPhase] = useState<'matching' | 'review' | 'migrating' | 'finished'>('matching');
  const [keepOld, setKeepOld] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const alive = useRef(true);
  const patch = (key: string, p: Partial<BatchItem>): void => setItems((list) => list.map((it) => (it.entry.key === key ? { ...it, ...p } : it)));

  async function find(list: readonly LibraryEntry[]): Promise<void> {
    setPhase('matching');
    for (const e of list) patch(e.key, { state: 'searching', selected: false });
    await runLimited(
      list,
      MAX_IN_FLIGHT,
      async (e) => {
        try {
          const page = await bridge().call('browse.search', { pluginId: to.id, query: e.name, page: 1 }, { timeoutMs: 45_000 });
          const m = bestMatch(e.name, page.items);
          if (m) patch(e.key, { state: 'found', match: m, selected: true });
          else patch(e.key, { state: 'none', selected: false });
        } catch (err) {
          patch(e.key, { state: 'error', error: toUiError(err), selected: false });
        }
      },
      () => alive.current,
    );
    if (alive.current) setPhase('review');
  }

  useLayoutEffect(() => {
    void find(props.entries);
    return () => {
      alive.current = false;
    };
  }, []);

  async function migrate(): Promise<void> {
    const chosen = items.filter((it) => it.selected && it.state === 'found' && it.match);
    setPhase('migrating');
    setProgress({ done: 0, total: chosen.length });
    let moved = 0;
    let failed = 0;
    for (const it of chosen) {
      const m = it.match;
      if (!m) continue;
      patch(it.entry.key, { state: 'migrating' });
      try {
        const e = await bridge().call(
          'migrate.apply',
          { from: { pluginId: it.entry.pluginId, path: it.entry.path }, to: { pluginId: m.pluginId, path: m.path }, keepOld },
          { timeoutMs: 180_000 },
        );
        if (!keepOld) removeLibraryEntries([it.entry.key]);
        upsertLibraryEntry(e);
        patch(it.entry.key, { state: 'done', selected: false });
        moved++;
      } catch (err) {
        patch(it.entry.key, { state: 'failed', error: toUiError(err), selected: false });
        failed++;
      }
      setProgress({ done: moved + failed, total: chosen.length });
    }
    progressVersion.value++;
    void reloadLibrary();
    setPhase('finished');
    if (failed === 0) {
      showToast(`Migrated ${plural(moved, 'novel')} to ${to.name}`);
      props.onDone();
    } else errorToast(`Migrated ${plural(moved, 'novel')}; ${failed} failed`);
  }

  const counts = {
    total: items.length,
    searching: items.filter((i) => i.state === 'searching').length,
    found: items.filter((i) => i.state === 'found').length,
    missing: items.filter((i) => i.state === 'none').length,
    failed: items.filter((i) => i.state === 'error').length,
  };
  const selected = items.filter((i) => i.selected && i.state === 'found').length;
  const errored = items.filter((i) => i.state === 'error');
  const challenge = errored.some((i) => i.error?.code === 'CLOUDFLARE');
  const status =
    phase === 'migrating'
      ? `Migrating ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
      : phase === 'finished'
        ? `Moved ${plural(items.filter((i) => i.state === 'done').length, 'novel')} to ${to.name}`
        : batchStatus(counts, to.name);

  return (
    <div class="mig-batch">
      <div class="mig-batch-head">
        <span class="mig-batch-src">
          {from && <SourceIcon source={from} size={36} />}
          <span class="ellipsis">{from?.name ?? props.fromId}</span>
        </span>
        <span class="mig-arrow" aria-hidden="true">
          <Icon name="chevron.right" size={18} />
        </span>
        <span class="mig-batch-src">
          <SourceIcon source={to} size={36} />
          <span class="ellipsis">{to.name}</span>
        </span>
      </div>
      <p class="mig-batch-status tabular" aria-live="polite" data-testid="batch-status">
        {status}
      </p>

      <Section
        {...(phase === 'review' && counts.found > 0
          ? { footer: 'Only close title matches are picked. Untick any that look wrong, or migrate a novel on its own to choose its match by hand.' }
          : {})}
      >
        {items.map((it) => {
          const selectable = phase === 'review' && it.state === 'found';
          const busy = it.state === 'searching' || it.state === 'migrating';
          return (
            <button
              type="button"
              key={it.entry.key}
              class={`row tap tap-row mig-row mig-batch-row is-${it.state}`}
              role="checkbox"
              aria-checked={it.selected}
              aria-disabled={!selectable}
              onClick={() => {
                if (selectable) patch(it.entry.key, { selected: !it.selected });
              }}
              data-testid="batch-item"
              data-state={it.state}
            >
              <Cover src={it.entry.cover} pluginId={it.entry.pluginId} class="cover-thumb" />
              <span class="row-main">
                <span class="row-title">{it.entry.name}</span>
                <span class="row-subtitle">{batchSubtitle(it, to.name)}</span>
              </span>
              {busy ? (
                <Spinner size={18} />
              ) : it.state === 'done' ? (
                <Icon name="checkmark.circle.fill" size={22} class="mig-batch-done" />
              ) : it.state === 'found' ? (
                <Icon name={it.selected ? 'checkmark.circle.fill' : 'circle'} size={22} class={`mig-batch-check${it.selected ? ' is-on' : ''}`} />
              ) : null}
            </button>
          );
        })}
      </Section>

      {phase === 'review' && errored.length > 0 && (
        <div class="mig-actions">
          <Button
            variant="tinted"
            {...(challenge ? { icon: 'safari' } : {})}
            onClick={() => {
              if (challenge) void solveChallengeThen(to.id, () => void find(errored.map((i) => i.entry)))();
              else void find(errored.map((i) => i.entry));
            }}
          >
            {challenge ? `Verify ${to.name} & Retry` : `Retry ${plural(errored.length, 'Search', 'Searches')}`}
          </Button>
        </div>
      )}

      {phase !== 'finished' && (
        <>
          <Section footer={keepOld ? 'The old entries stay in your library too.' : `Each ${from?.name ?? props.fromId} entry is replaced by its match.`}>
            <SwitchRow title="Keep old entries" checked={keepOld} onChange={setKeepOld} testId="batch-keep-old" />
          </Section>
          <div class="mig-actions">
            <Button variant="filled" size="large" disabled={phase !== 'review' || selected === 0} onClick={() => void migrate()}>
              {phase === 'migrating' ? 'Migrating…' : selected > 0 ? `Migrate ${plural(selected, 'Novel')}` : 'Migrate'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- 2. matches on other sources ----------

interface SourceResult {
  status: 'pending' | 'loading' | 'ok' | 'error';
  items: (BrowseItem & { score: number })[];
  error?: UiError;
}

function bestScore(r: SourceResult | undefined): number {
  return r?.status === 'ok' ? (r.items[0]?.score ?? 0) : -1;
}

/** Strong matches first (best score), then still searching, then weaker results, errors, empty. */
function orderTargets(list: readonly SourceInfo[], results: ReadonlyMap<string, SourceResult>): SourceInfo[] {
  const rank = (s: SourceInfo): number => {
    const r = results.get(s.id);
    if (r?.status === 'ok' && (r.items[0]?.score ?? 0) >= STRONG_MATCH) return 0;
    if (r?.status === 'pending' || r?.status === 'loading') return 1;
    if (r?.status === 'ok' && r.items.length > 0) return 2;
    if (r?.status === 'error') return 3;
    return 4;
  };
  return [...list]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))
    .map((s, i) => ({ s, i, r: rank(s), b: bestScore(results.get(s.id)) }))
    .sort((a, b) => a.r - b.r || b.b - a.b || a.i - b.i)
    .map((x) => x.s);
}

export function MigrateSearchScreen(props: { pluginId: string; path: string }) {
  const key = `${props.pluginId}:${props.path}`;
  // Keep the entry we started from: after a migration that drops it, the library no longer has it.
  const [from] = useState<LibraryEntry | undefined>(() => library.value.find((e) => e.key === key));
  const fromSource = sources.value.find((s) => s.id === props.pluginId);
  const title = from?.name ?? props.path;
  const [input, setInput] = useState(title);
  const [query, setQuery] = useState(title);
  const [results, setResults] = useState<Map<string, SourceResult>>(new Map());
  const [target, setTarget] = useState<(BrowseItem & { score: number }) | null>(null);
  const generation = useRef(0);
  // Like Browse and Global Search: enabled sources in the chosen languages (minus the novel's own).
  const targets = browsableSources(sources.value, settings.value.languages).filter((s) => s.id !== props.pluginId);
  const keys = libraryKeys.value;

  const update = (g: number, id: string, r: SourceResult): void => {
    if (g !== generation.current) return; // stale: the query changed
    setResults((m) => new Map(m).set(id, r));
  };

  async function searchOne(g: number, id: string, q: string): Promise<void> {
    update(g, id, { status: 'loading', items: [] });
    try {
      const page = await bridge().call('browse.search', { pluginId: id, query: q, page: 1 }, { timeoutMs: 45_000 });
      update(g, id, { status: 'ok', items: rankMatches(title, page.items) });
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
    const ids = orderTargets(targets, new Map()).map((s) => s.id);
    setResults(new Map(ids.map((id) => [id, { status: 'pending', items: [] }])));
    await runLimited(ids, MAX_IN_FLIGHT, (id) => searchOne(g, id, q), () => g === generation.current);
  }

  useLayoutEffect(() => {
    void run(query);
    return () => {
      generation.current++;
    };
  }, [query]);

  const ordered = orderTargets(targets, results);
  const done = [...results.values()].filter((r) => r.status === 'ok' || r.status === 'error').length;
  // Every source failed for want of a connection: one offline state, not one error per source.
  const all = [...results.values()];
  const offlineError = all.length > 0 && all.every((r) => r.status === 'error' && r.error?.offline) ? (all[0]?.error ?? null) : null;

  return (
    <Screen
      title="Migrate"
      back="Migrate"
      testId="screen-migrate-search"
      accessory={
        <div class="accessory-stack">
          <SearchField value={input} onInput={setInput} onSubmit={(v) => setQuery(v.trim())} placeholder="Search other sources" testId="migrate-search-field" />
          {query && results.size > 0 && (
            <p class="gs-progress tabular" aria-live="polite" data-testid="migrate-progress">
              {done < results.size ? `Searching ${plural(results.size, 'source')} · ${done} done` : `Searched ${plural(results.size, 'source')}`}
            </p>
          )}
        </div>
      }
    >
      <div class="mig-from" data-testid="migrate-from">
        <Cover src={from?.cover} pluginId={props.pluginId} class="mig-from-cover" />
        <span class="mig-from-text">
          <span class="mig-from-label">Migrating from</span>
          <span class="mig-from-title clamp-2">{title}</span>
          <span class="mig-from-meta">
            {fromSource && <SourceIcon source={fromSource} size={16} />}
            {fromSource?.name ?? props.pluginId}
            {from ? ` · ${plural(from.chapterCount, 'chapter')}` : ''}
          </span>
        </span>
      </div>

      {offlineError ? (
        <ErrorState error={offlineError} onRetry={() => void run(query)} />
      ) : targets.length === 0 ? (
        <EmptyState icon="puzzlepiece.extension" title="No Other Sources" message="Enable or install another source to migrate this novel to it." />
      ) : (
        ordered.map((s) => {
          const r = results.get(s.id);
          if (!r) return null;
          return (
            <section class="gs-section" key={s.id} data-testid={`mig-${s.id}`} data-status={r.status}>
              <div class="gs-header">
                <SourceIcon source={s} size={26} />
                <span class="gs-title">{s.name}</span>
                {r.status === 'ok' && <span class="gs-count">{r.items.length}</span>}
              </div>
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
                  {r.error.code === 'CLOUDFLARE' ? (
                    <Button variant="tinted" size="small" onClick={() => void solveChallengeThen(s.id, () => void searchOne(generation.current, s.id, query))()}>
                      Verify
                    </Button>
                  ) : (
                    <Button variant="tinted" size="small" onClick={() => void searchOne(generation.current, s.id, query)}>
                      Retry
                    </Button>
                  )}
                </div>
              ) : r.items.length === 0 ? (
                <p class="gs-message">No results</p>
              ) : (
                <div class="gs-row hscroll">
                  {r.items.map((it) => {
                    const inLib = keys.has(`${it.pluginId}:${it.path}`);
                    return (
                      <button
                        type="button"
                        class="gs-item mig-item tap tap-scale"
                        key={`${it.pluginId}:${it.path}`}
                        onClick={() => setTarget(it)}
                        aria-label={`${it.name}${it.score >= STRONG_MATCH ? ', match' : ''}`}
                        data-testid="migrate-candidate"
                      >
                        <span class="grid-cover-wrap">
                          <Cover src={it.cover} pluginId={it.pluginId} title={it.name} />
                          {(it.score >= STRONG_MATCH || inLib) && (
                            <span class="badges">
                              {it.score >= STRONG_MATCH && <span class="badge mig-badge">Match</span>}
                              {inLib && <span class="badge badge-library">In library</span>}
                            </span>
                          )}
                        </span>
                        <span class="gs-name clamp-2">{it.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })
      )}

      <Sheet open={target !== null} onClose={() => setTarget(null)} title="Migrate" detents={['fit']} testId="migrate-sheet">
        {target && (
          <MigrateSheetBody
            from={from ?? { pluginId: props.pluginId, path: props.path, name: title }}
            {...(from ? { entry: from } : {})}
            to={target}
            onClose={() => setTarget(null)}
            onDone={(e) => {
              setTarget(null);
              pop();
              const toName = sources.value.find((s) => s.id === e.pluginId)?.name ?? e.pluginId;
              showToast(`Migrated to ${toName}`, { undo: () => openNovel(e), actionLabel: 'Open', durationMs: 5000 });
            }}
          />
        )}
      </Sheet>
    </Screen>
  );
}

// ---------- 3. preview + apply ----------

const CONFIDENCE_TITLE: Record<MatchConfidence['level'], string> = {
  high: 'Looks like the same novel',
  medium: 'Check before migrating',
  low: 'Probably a different novel',
};

/**
 * Title, author and length compared, so a wrong pick is caught before anything moves. `unchecked`: the
 * target's page couldn't be loaded, so only the title was compared (with why, and Retry).
 */
function ConfidenceBlock({ c, unchecked }: { c: MatchConfidence; unchecked?: { error: UiError; toName: string; onRetry: () => void } }) {
  return (
    <div class={`mig-confidence is-${c.level}`} data-testid="migrate-confidence" data-level={c.level}>
      <p class="mig-confidence-title">
        <Icon name={c.level === 'high' ? 'checkmark.circle.fill' : 'exclamationmark.triangle'} size={17} />
        {CONFIDENCE_TITLE[c.level]}
      </p>
      <ul class="mig-signals">
        {c.signals.map((s) => (
          <li key={s.text} class={s.ok ? 'is-ok' : 'is-off'}>
            <Icon name={s.ok ? 'checkmark' : 'xmark'} size={12} />
            <span>{s.text}</span>
          </li>
        ))}
      </ul>
      {unchecked && (
        <div class="mig-unchecked" data-testid="migrate-unchecked">
          <span>
            {unchecked.error.offline ? 'You’re offline, so' : `${unchecked.toName}’s page didn’t load, so`} author and length weren’t compared.
          </span>
          <Button variant="tinted" size="small" onClick={unchecked.onRetry} label="Retry comparing author and length">
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

function MigrateSheetBody(props: { from: NovelSummary; entry?: LibraryEntry; to: BrowseItem & { score?: number }; onClose: () => void; onDone: (e: LibraryEntry) => void }) {
  const { from, to, entry } = props;
  const fromKey = { pluginId: from.pluginId, path: from.path };
  const toKey = { pluginId: to.pluginId, path: to.path };
  const preview = useAsync(() => bridge().call('migrate.preview', { from: fromKey, to: toKey }, { timeoutMs: 90_000 }), [to.pluginId, to.path]);
  const [keepOld, setKeepOld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const fromName = sources.value.find((s) => s.id === from.pluginId)?.name ?? from.pluginId;
  const toSource = sources.value.find((s) => s.id === to.pluginId);
  const toName = toSource?.name ?? to.pluginId;
  const p = preview.data;
  // The target's own page, for its author and length (a failure just leaves those out).
  const target = useAsync(() => bridge().call('novel.get', toKey, { timeoutMs: 45_000 }), [to.pluginId, to.path]);
  const td = target.data;
  const targetFailed = !td && target.status === 'error' && target.error ? target.error : null;
  const compared =
    target.status === 'loading' && !td
      ? null
      : matchConfidence({
          titleScore: to.score ?? 0,
          ...(entry?.author ? { fromAuthor: entry.author } : {}),
          ...(td?.details.author ? { toAuthor: td.details.author } : {}),
          ...(entry ? { fromChapters: entry.chapterCount } : from.chapterCount !== undefined ? { fromChapters: from.chapterCount } : {}),
          ...(td ? { toChapters: td.chapters.length } : {}),
        });
  /** One retry for everything that failed to load (back online: the preview and the comparison). */
  const retryAll = (): void => {
    void preview.reload();
    if (targetFailed) void target.reload();
  };
  // Title alone isn't enough to call it the same novel.
  const confidence: MatchConfidence | null = compared && targetFailed && compared.level === 'high' ? { ...compared, level: 'medium' } : compared;
  // Read marks on the old entry, counted from its stored chapter list (locked chapters are neither
  // read nor unread, so chapterCount − unreadCount would overcount).
  const source = useAsync(() => (entry ? bridge().call('novel.get', fromKey, { timeoutMs: 45_000 }) : Promise.resolve(null)), [from.pluginId, from.path]);
  const readTotal = source.data ? source.data.chapters.reduce((n, c) => n + (c.read ? 1 : 0), 0) : null;
  const marks = p && readTotal !== null ? readMarksLine(p.readCarried, readTotal) : null;

  async function apply(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const e = await bridge().call('migrate.apply', { from: fromKey, to: toKey, keepOld }, { timeoutMs: 180_000 });
      if (!keepOld) removeLibraryEntries([`${from.pluginId}:${from.path}`]);
      upsertLibraryEntry(e);
      progressVersion.value++;
      void reloadLibrary();
      props.onDone(e);
    } catch (err) {
      const ui = toUiError(err);
      setError(ui);
      errorToast(`Couldn’t migrate: ${errorText(ui)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="mig-sheet">
      <div class="mig-pair" role="img" aria-label={`${from.name} on ${fromName} to ${to.name} on ${toName}`}>
        <span class="mig-side">
          <Cover src={from.cover} pluginId={from.pluginId} title={from.name} class="mig-pair-cover" />
          <span class="mig-side-source ellipsis">{fromName}</span>
        </span>
        <span class="mig-arrow" aria-hidden="true">
          <Icon name="chevron.right" size={18} />
        </span>
        <span class="mig-side">
          <Cover src={to.cover} pluginId={to.pluginId} title={to.name} class="mig-pair-cover" />
          <span class="mig-side-source ellipsis">{toName}</span>
        </span>
      </div>
      <p class="mig-target-title clamp-2">{to.name}</p>

      <Section>
        {/* One live region for both states, so VoiceOver reads the verdict when it arrives. */}
        <div aria-live="polite">
          {confidence ? (
            <ConfidenceBlock c={confidence} {...(targetFailed ? { unchecked: { error: targetFailed, toName, onRetry: () => void target.reload() } } : {})} />
          ) : (
            <div class="mig-confidence is-loading" aria-busy="true" aria-label="Comparing the novels">
              <SkeletonLine width="60%" height={14} />
              <SkeletonLine width="80%" height={12} />
            </div>
          )}
        </div>
      </Section>

      <Section>
        {preview.status === 'error' && preview.error && !p ? (
          <ErrorState error={preview.error} onRetry={retryAll} onSolve={solveChallengeThen(to.pluginId, retryAll)} compact />
        ) : !p ? (
          <div class="mig-preview is-loading" aria-busy="true" aria-label="Matching chapters">
            <SkeletonLine width="88%" height={14} />
            <SkeletonLine width="56%" height={14} />
          </div>
        ) : (
          <div class="mig-preview">
            <p class="mig-preview-text" data-testid="migrate-preview">
              {previewSentence(p)}
            </p>
            {marks && (
              <p class="mig-note" data-testid="migrate-read-marks">
                {marks}
                {readTotal !== null && p.readCarried < readTotal ? '. The rest have no matching chapter number.' : '.'}
              </p>
            )}
            {p.matched === 0 ? (
              <p class="mig-warning">
                <Icon name="exclamationmark.triangle" size={15} />
                No chapters matched. This may be a different novel.
              </p>
            ) : p.unmatched > 0 ? (
              <p class="mig-note" data-testid="migrate-unmatched">
                {plural(p.unmatched, 'chapter')} {p.unmatched === 1 ? 'has' : 'have'} no match on {toName}.
              </p>
            ) : null}
          </div>
        )}
      </Section>

      <Section footer={keepOld ? `Both entries stay in your library.` : `The ${fromName} entry is replaced by the one on ${toName}.`}>
        <SwitchRow title="Keep old entry" checked={keepOld} onChange={setKeepOld} testId="migrate-keep-old" />
      </Section>

      {error && <p class="form-error mig-error">{errorText(error)}</p>}

      <div class="mig-actions">
        <Button variant="filled" size="large" onClick={() => void apply()} disabled={busy || !p}>
          {busy ? 'Migrating…' : confidence?.level === 'low' ? 'Migrate Anyway' : 'Migrate'}
        </Button>
        <Button
          variant="plain"
          onClick={() => {
            props.onClose();
            openNovel(to);
          }}
        >
          View on {toName}
        </Button>
      </div>
    </div>
  );
}
