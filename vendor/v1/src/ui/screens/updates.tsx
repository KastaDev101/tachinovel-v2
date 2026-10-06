/**
 * Updates: new chapters of library novels, grouped by day and then by novel ("Shadow of the Ninth
 * Gate · 3 new chapters", tap to expand). Swipe a row right to mark it read/unread; "Mark all read"
 * in the header (with Undo); a download button per chapter (progress from `downloads.progress`);
 * pull to refresh runs the library update check with a progress bar fed by `updates.progress`.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { UpdateEntry } from '../../shared/contracts/domain.ts';
import { bridge, errorText, toUiError } from '../bridge/client.ts';
import { BarButton, Spinner } from '../components/controls.tsx';
import { Cover } from '../components/cover.tsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/feedback.tsx';
import { useAsync, useNow } from '../components/hooks.ts';
import { Icon } from '../components/icon.tsx';
import { useRefreshWhenShown } from '../components/navigator.tsx';
import { Screen } from '../components/screen.tsx';
import { plural, timeOfDay } from '../lib/format.ts';
import { attachLongPress } from '../lib/gestures.ts';
import { attachSwipe } from '../lib/swipe.ts';
import { groupUpdates, unreadByNovel, type NovelUpdates } from '../lib/updates-history.ts';
import { actionSheet, checkLibraryUpdates } from '../state/actions.ts';
import { openNovel, openReader } from '../state/nav.ts';
import { library, progressVersion, refreshUpdatesBadge, updatesProgress } from '../state/store.ts';
import { errorToast, showToast } from '../state/toast.ts';
import './feed.css';

const chapterKey = (u: UpdateEntry): string => `${u.pluginId}:${u.chapterPath}`;
const novelKey = (u: { pluginId: string; path: string }): string => `${u.pluginId}:${u.path}`;

type DownloadState = 'queued' | 'done';
type Filter = 'all' | 'unread' | 'downloaded';

const FILTER_KEY = 'tachinovel.updates.filter';

function readFilter(): Filter {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return v === 'unread' || v === 'downloaded' ? v : 'all';
  } catch {
    return 'all';
  }
}

function saveFilter(f: Filter): void {
  try {
    localStorage.setItem(FILTER_KEY, f);
  } catch {
    // Remembered for this session only.
  }
}

export function UpdatesScreen() {
  const data = useAsync(() => bridge().call('updates.list', { limit: 200 }), []);
  const now = useNow();
  const list = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [downloads, setDownloads] = useState<Map<string, DownloadState>>(new Map());
  /** Batches this screen enqueued, per novel, oldest first: `downloads.progress` marks their chapters done in order. */
  const batches = useRef(new Map<string, { keys: string[]; done: number }[]>());
  const [filter, setFilterState] = useState<Filter>(readFilter);
  const all = data.data ?? [];
  const itemsRef = useRef<UpdateEntry[]>(all);
  itemsRef.current = all;
  const progress = updatesProgress.value;

  useRefreshWhenShown('updates', () => `${progressVersion.value}:${library.value.length}`, () => void data.reload({ silent: true }));

  /** Downloaded: saved per the script (survives relaunch), or finished here this session. */
  const isDownloaded = (u: UpdateEntry): boolean => u.downloaded === true || downloads.get(chapterKey(u)) === 'done';
  const items = useMemo(
    () => (filter === 'unread' ? all.filter((u) => !u.read) : filter === 'downloaded' ? all.filter(isDownloaded) : all),
    [data.data, filter, downloads],
  );
  const counts = { unread: all.filter((u) => !u.read).length, downloaded: all.filter(isDownloaded).length };
  const setFilter = (f: Filter): void => {
    setFilterState(f);
    saveFilter(f);
  };

  const days = useMemo(() => groupUpdates(items, now), [items, now]);
  const groupsRef = useRef(new Map<string, NovelUpdates>());
  groupsRef.current = new Map(days.flatMap((d) => d.novels.map((n) => [n.key, n] as const)));
  const unread = counts.unread;

  // Download progress: chapters of the oldest batch for that novel are done in order.
  useEffect(
    () =>
      bridge().on('downloads.progress', (p) => {
        const q = batches.current.get(novelKey({ pluginId: p.pluginId, path: p.novelPath }));
        const b = q?.[0];
        if (!q || !b) return;
        const newlyDone = b.keys.slice(b.done, Math.min(p.done, b.keys.length));
        b.done = Math.max(b.done, p.done);
        if (p.finished || b.done >= b.keys.length) q.shift();
        if (newlyDone.length > 0)
          setDownloads((m) => {
            const n = new Map(m);
            for (const k of newlyDone) n.set(k, 'done');
            return n;
          });
      }),
    [],
  );

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const offLong = attachLongPress(el, '[data-index], [data-group]', (t) => {
      const group = t.dataset['group'] !== undefined ? groupsRef.current.get(t.dataset['group']) : undefined;
      if (group) {
        void groupMenu(group);
        return;
      }
      const u = itemsRef.current[Number(t.dataset['index'])];
      if (u) void rowMenu(u);
    });
    const offSwipe = attachSwipe(el, {
      onCommit: (row) => {
        const key = row.dataset['key'] ?? '';
        const group = groupsRef.current.get(key);
        if (group) {
          void setRead(group.chapters, group.unread > 0);
          return;
        }
        const u = itemsRef.current.find((x) => chapterKey(x) === key);
        if (u) void setRead([u], !u.read);
      },
    });
    return () => {
      offLong();
      offSwipe();
    };
  }, [data.status, items.length > 0]);

  /** Optimistic read/unread for some updates; the bridge call follows (one per novel). */
  async function setRead(list: readonly UpdateEntry[], read: boolean): Promise<void> {
    const keys = new Set(list.map(chapterKey));
    data.setData((d) => d?.map((x) => (keys.has(chapterKey(x)) ? { ...x, read } : x)));
    const byNovel = new Map<string, { pluginId: string; novelPath: string; chapterPaths: string[] }>();
    for (const u of list) {
      const k = novelKey(u);
      const g = byNovel.get(k) ?? { pluginId: u.pluginId, novelPath: u.path, chapterPaths: [] };
      g.chapterPaths.push(u.chapterPath);
      byNovel.set(k, g);
    }
    try {
      await Promise.all([...byNovel.values()].map((g) => bridge().call('progress.markRead', { ...g, read })));
    } catch (err) {
      errorToast(errorText(toUiError(err)));
      void data.reload({ silent: true });
    }
    void refreshUpdatesBadge();
    progressVersion.value++;
  }

  function markAllRead(): void {
    const targets = unreadByNovel(itemsRef.current);
    const count = targets.reduce((n, g) => n + g.chapterPaths.length, 0);
    if (count === 0) return;
    const paths = new Set(targets.flatMap((g) => g.chapterPaths.map((p) => `${g.pluginId}:${p}`)));
    const affected = itemsRef.current.filter((u) => paths.has(chapterKey(u)));
    void setRead(affected, true);
    showToast(`Marked ${plural(count, 'chapter')} as read`, { undo: () => void setRead(affected, false) });
  }

  /** Queue chapters (of one novel) for download; already downloaded or queued ones are skipped. */
  async function download(list: readonly UpdateEntry[]): Promise<void> {
    const todo = list.filter((u) => !isDownloaded(u) && !downloads.has(chapterKey(u)));
    const first = todo[0];
    if (!first) return;
    const keys = todo.map(chapterKey);
    setDownloads((m) => {
      const n = new Map(m);
      for (const k of keys) n.set(k, 'queued');
      return n;
    });
    const nk = novelKey(first);
    const batch = { keys, done: 0 };
    batches.current.set(nk, [...(batches.current.get(nk) ?? []), batch]);
    try {
      await bridge().call('downloads.enqueue', { pluginId: first.pluginId, novelPath: first.path, chapterPaths: todo.map((u) => u.chapterPath) });
    } catch (err) {
      batches.current.set(
        nk,
        (batches.current.get(nk) ?? []).filter((b) => b !== batch),
      );
      setDownloads((m) => {
        const n = new Map(m);
        for (const k of keys) n.delete(k);
        return n;
      });
      errorToast(errorText(toUiError(err)));
    }
  }

  async function groupMenu(g: NovelUpdates): Promise<void> {
    const missing = g.chapters.filter((u) => !isDownloaded(u)).length;
    const actions = [
      { title: g.unread > 0 ? 'Mark All as Read' : 'Mark All as Unread' },
      ...(missing > 0 ? [{ title: `Download All New (${missing})` }] : []),
      { title: 'Open Novel' },
    ];
    const i = await actionSheet({ title: g.novelName, message: plural(g.chapters.length, 'new chapter'), actions });
    const t = actions[i]?.title ?? '';
    if (t.startsWith('Mark All')) void setRead(g.chapters, g.unread > 0);
    else if (t.startsWith('Download')) void download(g.chapters);
    else if (t === 'Open Novel') openNovel({ pluginId: g.pluginId, path: g.path, name: g.novelName, ...(g.cover ? { cover: g.cover } : {}) });
  }

  async function rowMenu(u: UpdateEntry): Promise<void> {
    const i = await actionSheet({
      title: u.chapterName,
      message: u.novelName,
      actions: [{ title: u.read ? 'Mark as Unread' : 'Mark as Read' }, { title: 'Download' }, { title: 'Open Novel' }],
    });
    if (i === 0) void setRead([u], !u.read);
    else if (i === 1) void download([u]);
    else if (i === 2) openNovel({ pluginId: u.pluginId, path: u.path, name: u.novelName, ...(u.cover ? { cover: u.cover } : {}) });
  }

  function toggle(group: NovelUpdates): void {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(group.key)) n.delete(group.key);
      else n.add(group.key);
      return n;
    });
  }

  const refresh = async (): Promise<void> => {
    await checkLibraryUpdates();
    await data.reload({ silent: true });
  };

  const downloadButton = (u: UpdateEntry) => {
    const st: DownloadState | undefined = isDownloaded(u) ? 'done' : downloads.get(chapterKey(u));
    return (
      <button
        type="button"
        class={`upd-download tap tap-dim${st === 'done' ? ' is-done' : ''}`}
        onClick={() => void download([u])}
        disabled={st !== undefined}
        aria-label={st === 'done' ? `${u.chapterName} downloaded` : st === 'queued' ? `Downloading ${u.chapterName}` : `Download ${u.chapterName}`}
        data-testid="update-download"
        data-state={st ?? 'none'}
      >
        {st === 'queued' ? <Spinner size={18} /> : <Icon name={st === 'done' ? 'arrow.down.circle.fill' : 'arrow.down.circle'} size={22} />}
      </button>
    );
  };

  const swipeActions = (read: boolean) => (
    <div class="sw-actions is-leading" aria-hidden="true">
      <button type="button" class="sw-action" tabIndex={-1}>
        <Icon name={read ? 'circle' : 'checkmark.circle'} size={22} />
        {read ? 'Unread' : 'Read'}
      </button>
    </div>
  );

  /** One chapter: with the cover (a novel's only update that day) or indented under its expanded novel. */
  const chapterRow = (u: UpdateEntry, withCover: boolean) => (
    <div class={`sw-row upd-row${withCover ? '' : ' is-sub'}`} key={chapterKey(u)} data-swipe data-leading="read" data-key={chapterKey(u)} data-testid="update-row" data-read={u.read}>
      {swipeActions(u.read)}
      <div class="sw-content upd-content">
        <button
          type="button"
          class={`media-row upd-main tap tap-row${u.read ? ' is-read' : ''}`}
          data-index={all.indexOf(u)}
          onClick={() => openReader(u.pluginId, u.path, u.chapterPath, u.novelName)}
        >
          {withCover && <Cover src={u.cover} pluginId={u.pluginId} title={u.novelName} class="cover-thumb" />}
          <span class="media-main">
            {withCover && <span class="media-title ellipsis">{u.novelName}</span>}
            <span class="media-sub ellipsis">{u.chapterName}</span>
            {!withCover && <span class="upd-time tabular">{timeOfDay(u.foundAt)}</span>}
          </span>
          {withCover && <span class="media-meta tabular">{timeOfDay(u.foundAt)}</span>}
        </button>
        {downloadButton(u)}
      </div>
    </div>
  );

  const novelRow = (g: NovelUpdates) => {
    const open = expanded.has(g.key);
    const allRead = g.unread === 0;
    const missing = g.chapters.filter((u) => !isDownloaded(u) && !downloads.has(chapterKey(u))).length;
    return (
      <div class="upd-group" key={g.key}>
        <div class="sw-row upd-row" data-swipe data-leading="read" data-key={g.key} data-testid="update-group">
          {swipeActions(allRead)}
          <div class="sw-content upd-content">
            <button type="button" class={`media-row upd-main tap tap-row${allRead ? ' is-read' : ''}`} onClick={() => toggle(g)} aria-expanded={open} data-group={g.key}>
              <Cover src={g.cover} pluginId={g.pluginId} title={g.novelName} class="cover-thumb" />
              <span class="media-main">
                <span class="media-title ellipsis">{g.novelName}</span>
                <span class="media-sub ellipsis">
                  {plural(g.chapters.length, 'new chapter')}
                  {g.unread > 0 && g.unread < g.chapters.length ? ` · ${g.unread} unread` : ''}
                </span>
              </span>
              <span class="media-meta tabular">{timeOfDay(g.latestAt)}</span>
            </button>
            <span class={`upd-chevron${open ? ' is-open' : ''}`} aria-hidden="true">
              <Icon name="chevron.right" size={14} />
            </span>
          </div>
        </div>
        {open && (
          <div class="upd-children">
            {g.chapters.map((u) => chapterRow(u, false))}
            {missing > 0 && (
              <button type="button" class="upd-download-all tap tap-row" onClick={() => void download(g.chapters)} data-testid="update-download-all">
                <Icon name="arrow.down.circle" size={20} />
                Download All New ({missing})
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  let body;
  if (data.status === 'loading' && !data.data) body = <SkeletonRows count={8} thumb height={72} />;
  else if (data.status === 'error' && data.error && !data.data) body = <ErrorState error={data.error} onRetry={() => void data.reload()} />;
  else if (all.length === 0)
    body = <EmptyState icon="bell.fill" title="No Updates Yet" message="New chapters from novels in your library appear here. Pull down to check now." />;
  else if (days.length === 0)
    body =
      filter === 'unread' ? (
        <EmptyState icon="checkmark.circle" title="All Caught Up" message="Every new chapter here is read." testId="updates-filter-empty" />
      ) : (
        <EmptyState icon="arrow.down.circle" title="Nothing Downloaded" message="Tap the download button on a chapter to keep it for offline reading." testId="updates-filter-empty" />
      );
  else
    body = (
      <div ref={list} data-testid="updates-list">
        {days.map((d) => (
          <section class="day-group" key={d.key}>
            <h3 class="day-header">{d.label}</h3>
            <div class="plain-list upd-list">{d.novels.map((g) => (g.chapters.length === 1 && g.chapters[0] ? chapterRow(g.chapters[0], true) : novelRow(g)))}</div>
          </section>
        ))}
      </div>
    );

  return (
    <Screen
      title="Updates"
      large
      tab="updates"
      testId="screen-updates"
      left={<BarButton icon="checkmark.circle" label="Mark all as read" disabled={unread === 0} onClick={markAllRead} testId="updates-mark-all" />}
      right={<BarButton icon="arrow.clockwise" label="Check for updates" disabled={progress !== null} onClick={() => void refresh()} testId="updates-check" />}
      accessory={
        <div class="accessory-stack upd-accessory">
          <div class="upd-filters" role="tablist" aria-label="Show">
            {(
              [
                ['all', 'All', all.length],
                ['unread', 'Unread', counts.unread],
                ['downloaded', 'Downloaded', counts.downloaded],
              ] as const
            ).map(([f, label, n]) => (
              <button
                type="button"
                role="tab"
                aria-selected={filter === f}
                class={`chip upd-filter tap tap-dim${filter === f ? ' is-selected' : ''}`}
                key={f}
                onClick={() => setFilter(f)}
                data-testid={`updates-filter-${f}`}
              >
                {label}
                {f !== 'all' && n > 0 && <span class="upd-filter-count tabular">{n}</span>}
              </button>
            ))}
          </div>
          {progress && (
            <div class="upd-progress" role="status" data-testid="updates-progress">
              <div class="upd-progress-text">
                <span class="ellipsis">{progress.current ? `Checking ${progress.current}` : 'Checking for updates…'}</span>
                <span class="tabular">
                  {progress.done} of {progress.total}
                </span>
              </div>
              <span class="upd-progress-bar">
                <span style={{ transform: `scaleX(${progress.total > 0 ? progress.done / progress.total : 0})` }} />
              </span>
              {progress.newChapters > 0 && <span class="upd-progress-new tabular">{plural(progress.newChapters, 'new chapter')} so far</span>}
            </div>
          )}
        </div>
      }
      onRefresh={refresh}
    >
      {body}
    </Screen>
  );
}
