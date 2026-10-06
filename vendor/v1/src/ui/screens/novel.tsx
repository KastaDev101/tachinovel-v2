/**
 * Novel page: blurred-cover header, metadata, expandable summary, genre chips, library/Safari/share
 * actions, sticky Start/Resume, and a virtualized chapter list (read dimming, locks, bookmarks,
 * sort, filters, jump, long-press range select → mark read/unread, bookmark, download).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChapterView, NovelDetails, NovelStatus, NovelSummary } from '../../shared/contracts/domain.ts';
import { bridge, errorText, toUiError } from '../bridge/client.ts';
import { BarButton, Button, CheckRow, Section } from '../components/controls.tsx';
import { Cover, CoverBackdrop } from '../components/cover.tsx';
import { ErrorState, SkeletonLine, SkeletonRows, solveChallengeThen } from '../components/feedback.tsx';
import { useAsync, useNow } from '../components/hooks.ts';
import { Icon } from '../components/icon.tsx';
import { useOnReveal } from '../components/navigator.tsx';
import { Screen } from '../components/screen.tsx';
import { Sheet } from '../components/sheet.tsx';
import { VirtualList, type VirtualListHandle } from '../components/virtual-list.tsx';
import { volumeAt, volumeLayout } from '../lib/volumes.ts';
import { chapterOrder, findChapter, hasChapterFilter, nextToRead, NO_CHAPTER_FILTER, rangeBetween, type ChapterFilter } from '../lib/chapters.ts';
import { displayUrl, formatCount, percentLabel, plural, readingTime, releaseLabel } from '../lib/format.ts';
import { attachLongPress, haptic } from '../lib/gestures.ts';
import { primeKeyboard } from '../lib/keyboard.ts';
import { actionSheet, changeCategories, openInSafari, quickAddToLibrary, removeFromLibrary, share } from '../state/actions.ts';
import { openReader, push } from '../state/nav.ts';
import { getNovelPage, putNovelPage } from '../state/novel-cache.ts';
import { NarrationCard } from './narration-card.tsx';
import { libraryKeys, progressVersion, recent, reloadLibrary, settings, sourceById } from '../state/store.ts';
import { errorToast, showToast } from '../state/toast.ts';

const ROW_H = 60;
const NO_CHAPTERS: ChapterView[] = [];
/** Slim volume header rows ("Book One") in the chapter list. */
const VOL_H = 30;

const STATUS_LABEL: Record<NovelStatus, string> = {
  ongoing: 'Ongoing',
  completed: 'Completed',
  hiatus: 'On Hiatus',
  cancelled: 'Cancelled',
  unknown: 'Unknown status',
};

interface Selection {
  set: Set<number>;
  anchor: number;
}

export function NovelScreen(props: { pluginId: string; path: string; preview?: NovelSummary }) {
  const key = `${props.pluginId}:${props.path}`;
  const data = useAsync(() => bridge().call('novel.get', { pluginId: props.pluginId, path: props.path }, { timeoutMs: 60_000 }), []);
  /** Local edits (read marks, bookmarks) on top of the loaded list; reset whenever a new list loads. */
  const [edited, setEdited] = useState<{ base: ChapterView[]; list: ChapterView[] } | null>(null);
  const [desc, setDesc] = useState(false);
  const [filter, setFilter] = useState<ChapterFilter>(NO_CHAPTER_FILTER);
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [flash, setFlash] = useState(-1);
  const listHandle = useRef<VirtualListHandle>(null);
  const listWrap = useRef<HTMLDivElement>(null);
  const actionsRow = useRef<HTMLDivElement>(null);
  const now = useNow();
  const inLib = libraryKeys.value.has(key);
  const source = sourceById(props.pluginId);

  // The list renders in the same pass the data arrives (no extra render to copy it into state).
  const loaded = data.data?.chapters;
  const chapters: ChapterView[] = (edited && edited.base === loaded ? edited.list : loaded) ?? NO_CHAPTERS;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const setChapters = (fn: (cs: ChapterView[]) => ChapterView[]): void => {
    setEdited((e) => {
      const base = loadedRef.current ?? NO_CHAPTERS;
      const current = e && e.base === base ? e.list : base;
      return { base, list: fn(current) };
    });
  };

  // Shared with the reader (no second novel.get there), including local changes made here.
  useEffect(() => {
    if (data.data) putNovelPage(key, { ...data.data, chapters });
  }, [data.data, chapters]);

  // Coming back from the reader: it applied its progress to the shared page; show that (no refetch).
  // Without one (e.g. it was evicted), refresh quietly. A tick later: the reader's final save runs first.
  const [reveals, setReveals] = useState(0);
  useOnReveal(() =>
    window.setTimeout(() => {
      setReveals((n) => n + 1);
      const shared = getNovelPage(key);
      if (shared && data.data) data.setData(() => shared);
      else void data.reload({ silent: true });
    }, 0),
  );

  const order = useMemo(() => chapterOrder(chapters, filter, desc), [chapters, filter, desc]);
  // Volume headers wherever the volume changes (only for novels whose chapters have volumes).
  const layout = useMemo(() => volumeLayout(order.map((i) => chapters[i]?.volume), ROW_H, VOL_H), [order, chapters]);
  const [topVolume, setTopVolume] = useState<string | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  /** The bar's height: the sticky volume header sits right under it. */
  const barInset = useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    return (parseFloat(cs.getPropertyValue('--nav-h')) || 44) + (parseFloat(cs.getPropertyValue('--safe-top')) || 0);
  }, []);
  const orderRef = useRef(order);
  orderRef.current = order;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const details: Partial<NovelDetails> & NovelSummary = data.data?.details ?? props.preview ?? { pluginId: props.pluginId, path: props.path, name: '' };
  const novelRef = useRef<NovelSummary | NovelDetails>(details);
  novelRef.current = data.data?.details ?? details;
  const page = data.data;
  const lastRead = page?.lastRead;
  const resumeIndex = useMemo(() => {
    if (lastRead) {
      const i = chapters.findIndex((c) => c.path === lastRead.chapterPath);
      if (i >= 0) {
        const c = chapters[i];
        // Stopped mid-chapter (even when re-reading a read chapter) → resume it there.
        const pct = lastRead.position?.percent;
        if (pct !== undefined && pct > 0 && pct < settings.peek().reader.markReadAt) return i;
        // Finished the last-read chapter → continue with the next unread one.
        if (c?.read) {
          const n = nextToRead(chapters);
          return n >= 0 ? n : i;
        }
        return i;
      }
    }
    return nextToRead(chapters);
  }, [chapters, lastRead]);
  const resumeChapter = resumeIndex >= 0 ? chapters[resumeIndex] : undefined;
  const started = chapters.some((c) => c.read || c.progress !== undefined) || lastRead !== undefined;

  // Long-press: start selection, or extend it as a range from the anchor.
  useEffect(() => {
    const el = listWrap.current;
    if (!el) return;
    return attachLongPress(el, '[data-index]', (t) => {
      const idx = Number(t.dataset['index']);
      const sel = selectionRef.current;
      if (!sel) {
        setSelection({ set: new Set([idx]), anchor: idx });
      } else {
        const range = rangeBetween(orderRef.current, sel.anchor, idx);
        setSelection({ set: new Set([...sel.set, ...range]), anchor: idx });
      }
    });
  }, []);

  // Long-press "Add to Library": choose the categories first ("In Library": change them).
  useEffect(() => {
    const el = actionsRow.current;
    if (!el) return;
    return attachLongPress(el, '[data-testid="library-toggle"]', () => {
      if (libraryKeys.peek().has(key)) void changeCategories([key]);
      else void quickAddToLibrary(novelRef.current, { pick: true });
    });
  }, []);

  function openChapter(idx: number): void {
    const c = chapters[idx];
    if (!c) return;
    if (c.locked) {
      showToast('This chapter is locked on the source site');
      return;
    }
    openReader(props.pluginId, props.path, c.path, details.name);
  }

  function toggleSelect(idx: number): void {
    setSelection((s) => {
      if (!s) return s;
      const set = new Set(s.set);
      if (set.has(idx)) set.delete(idx);
      else set.add(idx);
      return { set, anchor: idx };
    });
  }

  async function markRead(indexes: number[], read: boolean): Promise<void> {
    const changed = indexes.filter((i) => chapters[i] && !chapters[i]?.locked && chapters[i]?.read !== read);
    setSelection(null);
    if (changed.length === 0) return;
    const set = new Set(changed);
    setChapters((cs) => cs.map((c, i) => (set.has(i) ? { ...c, read } : c)));
    const paths = changed.map((i) => chapters[i]?.path ?? '');
    try {
      await bridge().call('progress.markRead', { pluginId: props.pluginId, novelPath: props.path, chapterPaths: paths, read });
      progressVersion.value++;
      showToast(`Marked ${plural(changed.length, 'chapter')} as ${read ? 'read' : 'unread'}`, {
        undo: () => {
          setChapters((cs) => cs.map((c, i) => (set.has(i) ? { ...c, read: !read } : c)));
          void bridge()
            .call('progress.markRead', { pluginId: props.pluginId, novelPath: props.path, chapterPaths: paths, read: !read })
            .then(() => {
              progressVersion.value++;
            })
            .catch(() => undefined);
        },
      });
    } catch (err) {
      setChapters((cs) => cs.map((c, i) => (set.has(i) ? { ...c, read: !read } : c)));
      errorToast(errorText(toUiError(err)));
    }
  }

  async function bookmark(indexes: number[]): Promise<void> {
    const on = indexes.some((i) => !chapters[i]?.bookmarked);
    const set = new Set(indexes);
    setSelection(null);
    setChapters((cs) => cs.map((c, i) => (set.has(i) ? { ...c, bookmarked: on } : c)));
    for (const i of indexes) {
      const c = chapters[i];
      if (c) await bridge().call('progress.bookmark', { pluginId: props.pluginId, novelPath: props.path, chapterPath: c.path, bookmarked: on }).catch(() => undefined);
    }
    showToast(on ? `Bookmarked ${plural(indexes.length, 'chapter')}` : `Removed ${plural(indexes.length, 'bookmark')}`);
  }

  function download(indexes: number[]): void {
    const paths = indexes.map((i) => chapters[i]).filter((c): c is ChapterView => c !== undefined && !c.locked && !c.downloaded).map((c) => c.path);
    setSelection(null);
    if (paths.length === 0) return;
    void bridge()
      .call('downloads.enqueue', { pluginId: props.pluginId, novelPath: props.path, chapterPaths: paths })
      .then(() => showToast(`Downloading ${plural(paths.length, 'chapter')}`))
      .catch((err: unknown) => errorToast(errorText(toUiError(err))));
  }

  async function toggleLibrary(): Promise<void> {
    if (inLib) removeFromLibrary([{ pluginId: props.pluginId, path: props.path, name: details.name }]);
    else {
      haptic();
      await quickAddToLibrary(page?.details ?? details);
    }
  }

  async function refresh(): Promise<void> {
    try {
      const fresh = await bridge().call('novel.get', { pluginId: props.pluginId, path: props.path, refresh: true }, { timeoutMs: 60_000 });
      data.setData(() => fresh);
      if (inLib) void reloadLibrary();
    } catch (err) {
      errorToast(errorText(toUiError(err)));
    }
  }

  async function moreMenu(): Promise<void> {
    const actions = [
      { title: 'Refresh' },
      { title: 'Mark All as Read' },
      { title: 'Open in Safari' },
      { title: 'Share' },
      ...(inLib ? [{ title: 'Set Categories' }, { title: 'Migrate' }] : []),
    ];
    const i = await actionSheet({ title: details.name, actions });
    const choice = actions[i]?.title;
    if (choice === 'Refresh') void refresh();
    else if (choice === 'Mark All as Read') void markRead(chapters.map((_, idx) => idx), true);
    else if (choice === 'Open in Safari') openInSafari(details.url);
    else if (choice === 'Share') share(details.name, details.url);
    else if (choice === 'Set Categories') void changeCategories([key]);
    else if (choice === 'Migrate') push({ name: 'migrateSearch', pluginId: props.pluginId, path: props.path });
  }

  function jumpTo(query: string): void {
    const idx = findChapter(chapters, query);
    if (idx < 0) {
      showToast(`No chapter matches “${query}”`);
      return;
    }
    setJumpOpen(false);
    showChapter(idx);
  }

  /** Scrolls the list to chapter `idx` (clearing filters that hide it) and flashes its row. */
  function showChapter(idx: number): void {
    let pos = order.indexOf(idx);
    if (pos < 0) {
      setFilter(NO_CHAPTER_FILTER);
      pos = chapterOrder(chapters, NO_CHAPTER_FILTER, desc).indexOf(idx);
    }
    setFlash(idx);
    // After the (possibly unfiltered) list has rendered: map the position through its volume headers.
    window.setTimeout(() => listHandle.current?.scrollToIndex(layoutRef.current.rowOfPos[pos] ?? pos, { align: 'center' }), 30);
    window.setTimeout(() => setFlash(-1), 1600);
  }

  const selecting = selection !== null;
  const selectedList = selection ? [...selection.set] : [];
  const loading = data.status === 'loading' && !page;
  const summaryParas = (details.summary ?? '').split('\n').filter((p) => p.trim() !== '');

  const hasRating = details.rating !== undefined && details.rating > 0;
  const readingMs = useReadingMs(props.pluginId, props.path, reveals);
  const readCount = useMemo(() => chapters.reduce((n, c) => n + (c.read ? 1 : 0), 0), [chapters]);
  const stats = [
    ...(hasRating ? [String(Number((details.rating ?? 0).toFixed(2)))] : []),
    ...(page ? [`${formatCount(chapters.length)} ${chapters.length === 1 ? 'chapter' : 'chapters'}`] : []),
    // How far into the novel (once started; "99%" until every chapter is read).
    ...(page && readCount > 0 ? [readCount === chapters.length ? 'All read' : `${Math.min(99, Math.floor((readCount / chapters.length) * 100))}% read`] : []),
  ];

  const header = (
    <>
      <div class="novel-hero">
        <CoverBackdrop src={details.cover} pluginId={props.pluginId} class="hero-bg" />
        <div class="hero-content">
          <Cover src={details.cover} pluginId={props.pluginId} title={details.name} class="hero-cover" eager />
          <div class="hero-info">
            <h1 class="hero-title" data-testid="novel-title">
              {details.name || <SkeletonLine width="80%" height={20} />}
            </h1>
            {loading ? (
              <>
                <SkeletonLine width="50%" height={13} />
                <SkeletonLine width="40%" height={13} />
              </>
            ) : (
              <>
                {details.author && <p class="hero-author ellipsis">{details.author}</p>}
                <p class="hero-meta" data-testid="novel-status">
                  <Icon name="clock" size={12} class={`hero-meta-icon is-${details.status ?? 'unknown'}`} />
                  {STATUS_LABEL[details.status ?? 'unknown']}
                  {source ? ` • ${source.name}` : ''}
                </p>
                {stats.length > 0 && (
                  <p class="hero-meta tabular" data-testid="novel-stats">
                    {hasRating && <Icon name="star.fill" size={12} class="hero-star" />}
                    {stats.join(' • ')}
                  </p>
                )}
                {readingMs > 0 && (
                  <p class="hero-meta tabular" data-testid="novel-reading-time">
                    <Icon name="book.clock" size={12} class="hero-meta-icon" />
                    {readingTime(readingMs)} read
                  </p>
                )}
                {details.url && (
                  <button type="button" class="hero-url ellipsis tap tap-dim" onClick={() => openInSafari(details.url)} data-testid="novel-url">
                    {displayUrl(details.url)}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <div class="novel-actions" ref={actionsRow}>
        <button type="button" class={`novel-action tap tap-dim${inLib ? ' is-on' : ''}`} onClick={() => void toggleLibrary()} data-testid="library-toggle" aria-pressed={inLib}>
          <Icon name={inLib ? 'heart.fill' : 'heart'} size={24} />
          <span>{inLib ? 'In Library' : 'Add to Library'}</span>
        </button>
        <button type="button" class="novel-action tap tap-dim" onClick={() => openInSafari(details.url)} disabled={!details.url} data-testid="open-safari">
          <Icon name="safari" size={24} />
          <span>Web View</span>
        </button>
        <button type="button" class="novel-action tap tap-dim" onClick={() => share(details.name, details.url)} data-testid="share">
          <Icon name="square.and.arrow.up" size={24} />
          <span>Share</span>
        </button>
      </div>
      <NarrationCard pluginId={details.pluginId} path={details.path} name={details.name} />
      {loading ? (
        <div class="novel-summary">
          <SkeletonLine width="100%" height={12} />
          <SkeletonLine width="95%" height={12} />
          <SkeletonLine width="70%" height={12} />
        </div>
      ) : (
        summaryParas.length > 0 && (
          <button type="button" class={`novel-summary${expanded ? ' is-expanded' : ''}`} onClick={() => setExpanded(!expanded)} aria-expanded={expanded} data-testid="summary">
            <span class="summary-text selectable">
              {summaryParas.map((p, i) => (
                <span class="summary-p" key={i}>
                  {p}
                </span>
              ))}
            </span>
            <span class="summary-more">
              <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={14} />
            </span>
          </button>
        )
      )}
      {details.genres && details.genres.length > 0 && (
        <div class={`genre-row${expanded ? ' is-wrapped' : ' hscroll'}`}>
          {details.genres.map((g) => (
            <button type="button" class="chip pressable" key={g} onClick={() => push({ name: 'genre', genre: g, pluginId: props.pluginId })}>
              {g}
            </button>
          ))}
        </div>
      )}
      {details.name && (
        <button
          type="button"
          class="novel-row tap tap-row"
          onClick={() => push({ name: 'globalSearch', query: details.name })}
          data-testid="novel-global-search"
        >
          <Icon name="magnifyingglass" size={17} class="novel-row-icon" />
          <span class="novel-row-title">Global Search</span>
          <span class="novel-row-sub ellipsis">Find “{details.name}” in all sources</span>
          <Icon name="chevron.right" size={13} class="row-chevron" />
        </button>
      )}
      <div class="chapters-header">
        <h2 class="chapters-count" data-testid="chapter-count">
          {page ? `${formatCount(chapters.length)} ${chapters.length === 1 ? 'Chapter' : 'Chapters'}` : 'Chapters'}
          {hasChapterFilter(filter) && <span class="chapters-filtered"> · {formatCount(order.length)} shown</span>}
        </h2>
        <div class="chapter-tools">
          <button type="button" class="tool-btn tap tap-dim" aria-label="Jump to chapter" onClick={() => {
              primeKeyboard();
              setJumpOpen(true);
            }}
            disabled={!page}
            data-testid="jump">
            <Icon name="number" size={19} />
          </button>
          <button
            type="button"
            class="tool-btn tap tap-dim"
            aria-label="Show the chapter you're on"
            onClick={() => showChapter(resumeIndex)}
            disabled={!page || resumeIndex < 0}
            data-testid="chapter-locate"
          >
            <Icon name="scope" size={19} />
          </button>
          <button type="button" class={`tool-btn tap tap-dim${hasChapterFilter(filter) ? ' is-on' : ''}`} aria-label="Filter chapters" onClick={() => setFilterOpen(true)} disabled={!page} data-testid="chapter-filter">
            <Icon name={hasChapterFilter(filter) ? 'line.3.horizontal.decrease.circle' : 'line.3.horizontal.decrease'} size={20} />
          </button>
          <button
            type="button"
            class="tool-btn tap tap-dim"
            aria-label={desc ? 'Sorted newest first' : 'Sorted oldest first'}
            onClick={() => setDesc(!desc)}
            disabled={!page}
            data-testid="chapter-sort"
          >
            <Icon name={desc ? 'arrow.down' : 'arrow.up'} size={18} />
          </button>
        </div>
      </div>
    </>
  );

  let list;
  if (loading) list = <SkeletonRows count={10} height={ROW_H} />;
  else if (data.status === 'error' && data.error && !page)
    list = <ErrorState error={data.error} onRetry={() => void data.reload()} onSolve={solveChallengeThen(props.pluginId, () => void data.reload())} compact />;
  else if (order.length === 0) list = <p class="list-footnote">{chapters.length === 0 ? 'No chapters yet.' : 'No chapters match the filters.'}</p>;
  else
    list = (
      <div class="chapter-list">
        {layout.offsets && topVolume && (
          <div class="vol-header vol-sticky" aria-hidden="true" data-testid="volume-sticky">
            {topVolume}
          </div>
        )}
        <VirtualList
          count={layout.rows.length}
          rowHeight={ROW_H}
          offsets={layout.offsets}
          onTopRow={layout.offsets ? (i) => setTopVolume(volumeAt(layout.rows, i)) : undefined}
          topInset={barInset}
          handle={listHandle}
          testId="chapter-list"
          rowKey={(i) => {
            const row = layout.rows[i];
            return row?.kind === 'volume' ? `v${i}:${row.name}` : (order[row?.pos ?? i] ?? i);
          }}
          renderRow={(i) => {
            const row = layout.rows[i];
            if (row?.kind === 'volume') {
              return (
                <div class="vol-header" role="heading" aria-level={3} data-testid="volume-header">
                  {row.name}
                </div>
              );
            }
            const idx = order[row?.pos ?? i] ?? 0;
            const c = chapters[idx];
            if (!c) return null;
            const sel = selection?.set.has(idx) ?? false;
            const date = releaseLabel(c.releaseTime, now);
            const sub = [date, c.progress !== undefined && !c.read ? `${percentLabel(c.progress)} read` : ''].filter(Boolean).join(' · ');
            return (
              <button
                type="button"
                class={`chapter-row tap tap-row${c.read ? ' is-read' : ''}${sel ? ' is-selected' : ''}${c.locked ? ' is-locked' : ''}${flash === idx ? ' is-flash' : ''}${started && idx === resumeIndex ? ' is-current' : ''}`}
                aria-current={started && idx === resumeIndex ? 'step' : undefined}
                data-index={idx}
                data-testid="chapter-row"
                onClick={() => (selecting ? toggleSelect(idx) : openChapter(idx))}
              >
                {selecting && (
                  <span class={`select-mark${sel ? ' is-on' : ''}`}>
                    <Icon name={sel ? 'checkmark.circle.fill' : 'circle'} size={22} />
                  </span>
                )}
                <span class="chapter-main">
                  <span class="chapter-title ellipsis">
                    {c.bookmarked && <Icon name="bookmark.fill" size={13} class="chapter-bookmark" />}
                    {c.name}
                  </span>
                  {sub && <span class="chapter-sub ellipsis">{sub}</span>}
                </span>
                {c.downloaded && <Icon name="arrow.down.circle.fill" size={17} class="chapter-dl" />}
                {c.locked && <Icon name="lock.fill" size={15} class="chapter-lock" />}
              </button>
            );
          }}
        />
      </div>
    );

  const fab =
    !selecting && page && resumeChapter ? (
      <button type="button" class="fab tap tap-fill" onClick={() => openChapter(resumeIndex)} data-testid="resume">
        <Icon name="play.fill" size={15} />
        <span class="fab-text">
          <span class="fab-label">{started ? 'Resume' : 'Start Reading'}</span>
          <span class="fab-sub ellipsis">{resumeChapter.name}</span>
        </span>
      </button>
    ) : null;

  const toolbar = selecting ? (
    <div class="toolbar" role="toolbar" data-testid="chapter-toolbar">
      <ToolButton icon="checkmark.circle" label="Read" onClick={() => void markRead(selectedList, true)} disabled={selectedList.length === 0} testId="mark-read" />
      <ToolButton icon="circle" label="Unread" onClick={() => void markRead(selectedList, false)} disabled={selectedList.length === 0} testId="mark-unread" />
      <ToolButton icon="bookmark" label="Bookmark" onClick={() => void bookmark(selectedList)} disabled={selectedList.length === 0} />
      <ToolButton icon="arrow.down.circle" label="Download" onClick={() => download(selectedList)} disabled={selectedList.length === 0} />
    </div>
  ) : null;

  return (
    <Screen
      title={selecting ? `${selectedList.length} Selected` : details.name}
      back={selecting ? false : true}
      {...(selecting ? {} : { transparentUntil: 150 })} // selecting: an opaque bar, so "N Selected" shows
      class="novel-screen"
      testId="screen-novel"
      left={
        selecting ? (
          <BarButton
            text={selectedList.length === order.length ? 'Deselect All' : 'Select All'}
            onClick={() => setSelection(selectedList.length === order.length ? { set: new Set(), anchor: 0 } : { set: new Set(order), anchor: order[0] ?? 0 })}
          />
        ) : undefined
      }
      right={
        selecting ? (
          <BarButton text="Done" bold onClick={() => setSelection(null)} testId="selection-done" />
        ) : (
          <BarButton icon="ellipsis.circle" label="More actions" onClick={() => void moreMenu()} testId="novel-more" />
        )
      }
      onRefresh={refresh}
      overlay={
        <>
          {fab}
          {toolbar}
        </>
      }
    >
      {header}
      <div ref={listWrap}>{list}</div>
      <div class="list-bottom-pad" />
      <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Chapters" detents={['fit']} testId="chapter-filter-sheet">
        <Section header="Filter">
          <CheckRow title="Unread" checked={filter.unread} onClick={() => setFilter({ ...filter, unread: !filter.unread })} testId="cf-unread" />
          <CheckRow title="Bookmarked" checked={filter.bookmarked} onClick={() => setFilter({ ...filter, bookmarked: !filter.bookmarked })} testId="cf-bookmarked" />
          <CheckRow title="Downloaded" checked={filter.downloaded} onClick={() => setFilter({ ...filter, downloaded: !filter.downloaded })} testId="cf-downloaded" />
        </Section>
        <Section header="Sort">
          <CheckRow title="Oldest first" checked={!desc} onClick={() => setDesc(false)} />
          <CheckRow title="Newest first" checked={desc} onClick={() => setDesc(true)} />
        </Section>
      </Sheet>
      <JumpSheet open={jumpOpen} onClose={() => setJumpOpen(false)} onJump={jumpTo} max={chapters.length} isValid={(q) => findChapter(chapters, q) >= 0} />
    </Screen>
  );
}

function ToolButton(props: { icon: string; label: string; onClick: () => void; disabled?: boolean; testId?: string }) {
  return (
    <button type="button" class="toolbar-btn tap tap-dim" onClick={props.onClick} disabled={props.disabled} data-testid={props.testId}>
      <Icon name={props.icon} size={24} />
      <span>{props.label}</span>
    </button>
  );
}

/** Total reading time for this novel (History's readingMs): recent history first, else one history.list. */
function useReadingMs(pluginId: string, path: string, version: number): number {
  const fromRecent = recent.value.find((h) => h.pluginId === pluginId && h.path === path)?.readingMs;
  const [fetched, setFetched] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (fromRecent !== undefined) return;
    let alive = true;
    const t = window.setTimeout(() => {
      bridge()
        .call('history.list', { limit: 200 })
        .then((list) => {
          if (alive) setFetched(list.find((h) => h.pluginId === pluginId && h.path === path)?.readingMs);
        })
        .catch(() => undefined);
    }, 600);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [pluginId, path, version, fromRecent === undefined]);
  return fromRecent ?? fetched ?? 0;
}

function JumpSheet(props: { open: boolean; onClose: () => void; onJump: (q: string) => void; max: number; isValid: (q: string) => boolean }) {
  const [value, setValue] = useState('');
  const q = value.trim();
  const valid = q !== '' && props.isValid(q);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Takes over from primeKeyboard() as soon as the sheet's input exists (it mounts with the sheet).
    if (!props.open) return;
    input.current?.focus({ preventScroll: true });
    const t = window.setTimeout(() => input.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(t);
  }, [props.open]);
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Jump to Chapter" detents={['fit']} testId="jump-sheet">
      <form
        class="sheet-pad jump-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) props.onJump(q);
        }}
      >
        <input
          ref={input}
          class="text-input"
          type="text"
          inputMode="numeric"
          enterKeyHint="go"
          placeholder={`Chapter number (1–${formatCount(props.max)}) or title`}
          value={value}
          onInput={(e) => setValue(e.currentTarget.value)}
          data-testid="jump-input"
        />
        {q !== '' && !valid && (
          <p class="jump-hint" role="status" data-testid="jump-hint">
            No chapter matches “{q}”
          </p>
        )}
        <Button variant="filled" size="large" onClick={() => valid && props.onJump(q)} disabled={!valid} class="jump-go">
          Go
        </Button>
      </form>
    </Sheet>
  );
}
