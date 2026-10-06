/** Library: cover grid with unread badges, continue reading, categories, sort/filter/search, multi-select. */
import { useComputed } from '@preact/signals';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { LibraryEntry, LibrarySettings, LibrarySortBy } from '../../shared/contracts/domain.ts';
import { BarButton, CheckRow, Section, Segmented, SearchField, Stepper, SwitchRow } from '../components/controls.tsx';
import { EmptyState } from '../components/feedback.tsx';
import { Icon } from '../components/icon.tsx';
import { NovelGrid } from '../components/novel-grid.tsx';
import { Screen } from '../components/screen.tsx';
import { Sheet } from '../components/sheet.tsx';
import { primeKeyboard } from '../lib/keyboard.ts';
import { activeFilterCount, queryLibrary, SORT_LABELS } from '../lib/library-query.ts';
import { actionSheet, changeCategories, checkLibraryUpdates, markNovelsRead, removeFromLibrary } from '../state/actions.ts';
import { openNovel, openReader, push, selectTab } from '../state/nav.ts';
import { library, patchSettings, settings, sortedCategories, sources, updatesProgress } from '../state/store.ts';
import { tabBarHidden } from '../state/ui.ts';

const TAB_KEY = 'tachinovel.libraryTab';

function readTab(): string {
  try {
    return localStorage.getItem(TAB_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeTab(id: string): void {
  try {
    localStorage.setItem(TAB_KEY, id);
  } catch {
    /* private mode: not remembered */
  }
}

export function LibraryScreen() {
  const lib = useComputed(() => settings.value.library).value;
  const entries = library.value;
  const cats = sortedCategories.value;
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  /** Selected tab: '' = Default (no category), else a category id. Remembered on this device. */
  const [tab, setTabState] = useState<string>(() => readTab());
  const setTab = (id: string): void => {
    setTabState(id);
    writeTab(id);
  };
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const selecting = selected !== null;

  useEffect(() => {
    tabBarHidden.value = selecting;
  }, [selecting]);

  useEffect(() => {
    if (tab !== '' && cats.length > 0 && !cats.some((c) => c.id === tab)) setTab('');
  }, [cats, tab]);
  // Without categories there are no tabs: the whole library shows.
  const category = cats.length === 0 ? null : cats.some((c) => c.id === tab) ? tab : '';

  const items = useMemo(
    () => queryLibrary(entries, { sort: lib.sort, filter: lib.filter, search, categoryId: category }),
    [entries, lib.sort, lib.filter, search, category],
  );
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) {
      if (e.categoryIds.length === 0) m.set('', (m.get('') ?? 0) + 1);
      for (const c of e.categoryIds) m.set(c, (m.get(c) ?? 0) + 1);
    }
    return m;
  }, [entries]);
  const sourceNames = useMemo(() => new Map(sources.value.map((s) => [s.id, s.name])), [sources.value]);
  const gridItems = useMemo(
    () => items.map((e) => ({ ...e, subtitle: lib.display === 'list' ? [e.author, sourceNames.get(e.pluginId)].filter(Boolean).join(' · ') : undefined })),
    [items, lib.display, sourceNames],
  );

  const toggle = (key: string): void => {
    setSelected((s) => {
      const next = new Set(s ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedEntries = (): LibraryEntry[] => entries.filter((e) => selected?.has(e.key));

  async function moreMenu(): Promise<void> {
    const i = await actionSheet({
      actions: [{ title: 'Update Library' }, { title: 'Select Novels' }, { title: 'Sort & Filter' }, { title: 'Search All Sources' }],
    });
    if (i === 0) void checkLibraryUpdates();
    else if (i === 1) setSelected(new Set());
    else if (i === 2) setOptionsOpen(true);
    else if (i === 3) push({ name: 'globalSearch', ...(search.trim() ? { query: search.trim() } : {}) });
  }

  async function setCategoriesFor(keys: string[]): Promise<void> {
    if (await changeCategories(keys)) setSelected(null);
  }

  const progress = updatesProgress.value;
  const filterCount = activeFilterCount(lib.filter);

  const right = selecting ? (
    <BarButton text="Done" bold onClick={() => setSelected(null)} testId="select-done" />
  ) : (
    <>
      <BarButton
        icon="magnifyingglass"
        label="Search library"
        active={searchOpen}
        onClick={() => {
          if (searchOpen) setSearch('');
          else primeKeyboard(); // iOS: the keyboard only opens from inside the tap
          setSearchOpen(!searchOpen);
        }}
        testId="library-search-toggle"
      />
      <BarButton icon="line.3.horizontal.decrease" label="Sort and filter" active={filterCount > 0} onClick={() => setOptionsOpen(true)} testId="library-options" />
      <BarButton icon="ellipsis" iconClass="is-vertical" label="More" onClick={() => void moreMenu()} testId="library-more" />
    </>
  );
  const left = selecting ? (
    <BarButton
      text={selected.size === items.length && items.length > 0 ? 'Deselect All' : 'Select All'}
      onClick={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((i) => i.key)))}
    />
  ) : undefined;

  const showChrome = !selecting && entries.length > 0;
  const accessory =
    showChrome && (searchOpen || cats.length > 0) ? (
      <div class="accessory-stack">
        {searchOpen && (
          <SearchField
            value={search}
            onInput={setSearch}
            onSubmit={(q) => q.trim() && push({ name: 'globalSearch', query: q.trim() })}
            onCancel={() => setSearchOpen(false)}
            placeholder="Search library"
            autoFocus
            testId="library-search"
          />
        )}
        {cats.length > 0 && (
          <div class="tabs-underline hscroll" role="tablist" data-testid="category-tabs">
            <div class="tabs-underline-inner">
              <UnderlineTab label="Default" count={counts.get('') ?? 0} active={category === ''} onClick={() => setTab('')} testId="category-tab-default" />
              {cats.map((c) => (
                <UnderlineTab key={c.id} label={c.name} count={counts.get(c.id) ?? 0} active={category === c.id} onClick={() => setTab(c.id)} testId={`category-tab-${c.id}`} />
              ))}
            </div>
          </div>
        )}
      </div>
    ) : undefined;

  let body;
  if (entries.length === 0) {
    body = (
      <EmptyState
        icon="books.vertical.fill"
        title="Your Library Is Empty"
        message="Novels you add from Browse show up here, with new chapters and your reading progress."
        action={{ label: 'Browse Sources', onClick: () => selectTab('browse') }}
        testId="library-empty"
      />
    );
  } else if (items.length === 0 && !search && activeFilterCount(lib.filter) === 0 && category !== null) {
    const name = category === '' ? 'Default' : (cats.find((c) => c.id === category)?.name ?? '');
    body = (
      <EmptyState
        icon="folder"
        title={`“${name}” Is Empty`}
        message={category === '' ? 'Novels without a category show up here.' : 'Long-press “Add to Library” or use Select › Category to put novels here.'}
        testId="library-category-empty"
      />
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        icon="magnifyingglass"
        title="No Matches"
        message={search ? `Nothing in your library matches “${search}”.` : 'No novels match the current filters.'}
        testId="library-no-matches"
      />
    );
  } else {
    body = (
      <NovelGrid
        items={gridItems}
        display={lib.display}
        columns={lib.columns}
        testId="library-grid"
        selecting={selecting}
        {...(selected ? { selected } : {})}
        badges={(e) => ({
          ...(lib.showUnreadBadge ? { unread: e.unreadCount } : {}),
          ...(lib.showDownloadBadge ? { downloaded: e.downloadedCount } : {}),
        })}
        canContinue={(e) => e.lastChapterPath !== undefined}
        onContinue={(e) => e.lastChapterPath && openReader(e.pluginId, e.path, e.lastChapterPath, e.name)}
        onOpen={(e) => (selecting ? toggle(e.key) : openNovel(e))}
        onLongPress={(e) => {
          if (!selecting) setSelected(new Set([e.key]));
          else toggle(e.key);
        }}
      />
    );
  }

  return (
    <Screen
      title={selecting ? (selected.size > 0 ? `${selected.size} Selected` : 'Select Novels') : 'Library'}
      large={!selecting}
      tab="library"
      right={right}
      left={left}
      accessory={accessory}
      onRefresh={async () => {
        void checkLibraryUpdates();
        await new Promise((r) => window.setTimeout(r, 700));
      }}
      testId="screen-library"
      overlay={
        <>
          {progress && (
            <div class="update-pill" role="status" data-testid="update-progress">
              <span class="update-pill-text">
                Updating library <span class="tabular">{Math.min(progress.done + 1, progress.total)}/{progress.total}</span>
              </span>
              <span class="update-pill-bar">
                <span style={{ transform: `scaleX(${progress.total ? progress.done / progress.total : 0})` }} />
              </span>
            </div>
          )}
          {selecting && (
            <div class="toolbar" role="toolbar" data-testid="selection-toolbar">
              <ToolbarButton icon="folder" label="Category" disabled={selected.size === 0} onClick={() => void setCategoriesFor([...selected])} />
              <ToolbarButton icon="checkmark.circle" label="Read" disabled={selected.size === 0} onClick={() => { const e = selectedEntries(); setSelected(null); void markNovelsRead(e, true); }} />
              <ToolbarButton icon="circle" label="Unread" disabled={selected.size === 0} onClick={() => { const e = selectedEntries(); setSelected(null); void markNovelsRead(e, false); }} />
              <ToolbarButton
                icon="trash"
                label="Remove"
                destructive
                disabled={selected.size === 0}
                onClick={() => {
                  const e = selectedEntries();
                  setSelected(null);
                  removeFromLibrary(e);
                }}
              />
            </div>
          )}
        </>
      }
    >
      {search.trim() !== '' && (
        <button type="button" class="search-everywhere tap tap-row" onClick={() => push({ name: 'globalSearch', query: search.trim() })} data-testid="search-everywhere">
          <Icon name="magnifyingglass" size={18} />
          <span class="ellipsis">
            Search all sources for “<b>{search.trim()}</b>”
          </span>
          <Icon name="chevron.right" size={13} class="row-chevron" />
        </button>
      )}
      {body}
      <LibraryOptionsSheet open={optionsOpen} onClose={() => setOptionsOpen(false)} />
    </Screen>
  );
}

export function UnderlineTab(props: { label: string; count?: number; active: boolean; onClick: () => void; testId?: string }) {
  return (
    <button type="button" role="tab" aria-selected={props.active} class={`uline-tab tap tap-dim${props.active ? ' is-active' : ''}`} onClick={props.onClick} data-testid={props.testId}>
      <span class="uline-label">{props.label}</span>
      {props.count !== undefined && <span class="uline-count tabular">{props.count}</span>}
    </button>
  );
}

function ToolbarButton(props: { icon: string; label: string; onClick: () => void; disabled?: boolean; destructive?: boolean }) {
  return (
    <button type="button" class={`toolbar-btn tap tap-dim${props.destructive ? ' is-destructive' : ''}`} onClick={props.onClick} disabled={props.disabled}>
      <Icon name={props.icon} size={24} />
      <span>{props.label}</span>
    </button>
  );
}

const SORTS: LibrarySortBy[] = ['lastRead', 'lastUpdated', 'alpha', 'unread', 'dateAdded'];

export function LibraryOptionsSheet(props: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'filter' | 'sort' | 'display'>('filter');
  const lib = useComputed(() => settings.value.library).value;
  const setLib = (patch: Partial<LibrarySettings>): void => patchSettings({ library: patch });
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Library" detents={['fit']} testId="library-options-sheet">
      <div class="sheet-pad">
        <Segmented
          options={[
            { value: 'filter', label: 'Filter' },
            { value: 'sort', label: 'Sort' },
            { value: 'display', label: 'Display' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === 'filter' && (
        <Section>
          <CheckRow title="Unread" checked={lib.filter.unread} onClick={() => setLib({ filter: { ...lib.filter, unread: !lib.filter.unread } })} testId="filter-unread" />
          <CheckRow title="Completed" checked={lib.filter.completed} onClick={() => setLib({ filter: { ...lib.filter, completed: !lib.filter.completed } })} testId="filter-completed" />
          <CheckRow title="Downloaded" checked={lib.filter.downloaded} onClick={() => setLib({ filter: { ...lib.filter, downloaded: !lib.filter.downloaded } })} testId="filter-downloaded" />
        </Section>
      )}
      {tab === 'sort' && (
        <Section footer="Tap the selected option again to reverse the order.">
          {SORTS.map((by) => (
            <CheckRow
              key={by}
              title={SORT_LABELS[by]}
              checked={lib.sort.by === by}
              testId={`sort-${by}`}
              trailing={lib.sort.by === by ? <Icon name={lib.sort.dir === 'desc' ? 'arrow.down' : 'arrow.up'} size={15} class="sort-dir" /> : null}
              onClick={() =>
                setLib({
                  sort: lib.sort.by === by ? { by, dir: lib.sort.dir === 'desc' ? 'asc' : 'desc' } : { by, dir: by === 'alpha' ? 'asc' : 'desc' },
                })
              }
            />
          ))}
        </Section>
      )}
      {tab === 'display' && (
        <>
          <div class="sheet-pad">
            <Segmented
              options={[
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'compact', label: 'Compact' },
                { value: 'list', label: 'List' },
              ]}
              value={lib.display}
              onChange={(display) => setLib({ display })}
            />
          </div>
          <Section>
            {lib.display !== 'list' && (
              <div class="row">
                <span class="row-main">
                  <span class="row-title">Columns</span>
                </span>
                <Stepper label="Columns" value={lib.columns} min={2} max={5} step={1} onChange={(columns) => setLib({ columns })} />
              </div>
            )}
            <SwitchRow title="Unread badges" checked={lib.showUnreadBadge} onChange={(showUnreadBadge) => setLib({ showUnreadBadge })} />
            <SwitchRow title="Downloaded badges" checked={lib.showDownloadBadge} onChange={(showDownloadBadge) => setLib({ showDownloadBadge })} />
          </Section>
        </>
      )}
    </Sheet>
  );
}
