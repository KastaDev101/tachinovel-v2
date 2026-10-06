/**
 * History (Tachimanga layout): a big "Continue" card for the most recent novel, then
 * Today / Yesterday / This Week / This Month / Earlier sections of cover rows (chapter, reading
 * time, when). Swipe a row left (or tap its trash) to remove it with Undo; long-press for more;
 * search; incognito toggle in the header with a banner while it's on; clear all.
 */
import { useComputed } from '@preact/signals';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { HistoryEntry } from '../../shared/contracts/domain.ts';
import { bridge } from '../bridge/client.ts';
import { BarButton, Button, SearchField } from '../components/controls.tsx';
import { Cover } from '../components/cover.tsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/feedback.tsx';
import { useAsync, useNow } from '../components/hooks.ts';
import { Icon } from '../components/icon.tsx';
import { useRefreshWhenShown } from '../components/navigator.tsx';
import { Screen } from '../components/screen.tsx';
import { VirtualList } from '../components/virtual-list.tsx';
import { dayLabel, percentLabel, readingTime, timeOfDay } from '../lib/format.ts';
import { attachLongPress } from '../lib/gestures.ts';
import { primeKeyboard } from '../lib/keyboard.ts';
import { attachSwipe } from '../lib/swipe.ts';
import { historySections, type HistorySection } from '../lib/updates-history.ts';
import { actionSheet, confirmAlert } from '../state/actions.ts';
import { openNovel, openReader } from '../state/nav.ts';
import { patchSettings, progressVersion, recent, settings } from '../state/store.ts';
import { deferredAction, showToast } from '../state/toast.ts';
import './feed.css';

const keyOf = (h: HistoryEntry): string => `${h.pluginId}:${h.path}`;

/** History entries per request (older ones page in while scrolling). */
const PAGE = 100;
/** Virtual list geometry: a row is its 2:3 cover (86 px wide) plus padding; a section header. */
const ROW_H = 145;
const HEADER_H = 40;

/** "8:05 AM" in Today/Yesterday (the section says the day); "Monday · 8:05 AM" further back. */
function whenLabel(h: HistoryEntry, section: HistorySection['key'], now: number): string {
  if (section === 'today' || section === 'yesterday') return timeOfDay(h.readAt);
  return `${dayLabel(h.readAt, now)} · ${timeOfDay(h.readAt)}`;
}

export function HistoryScreen() {
  const incognito = useComputed(() => settings.value.incognito).value;
  // First page now; older ones page in as you scroll (`before` = the oldest loaded readAt).
  const data = useAsync(() => bridge().call('history.list', { limit: PAGE }), []);
  const [older, setOlder] = useState<HistoryEntry[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const loadingMore = useRef(false);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const now = useNow();
  const list = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Reading progress changes refresh History when it's shown (not while it sits hidden behind the reader).
  useRefreshWhenShown('history', () => progressVersion.value, () => void data.reload({ silent: true }));

  /** Everything loaded: the first page plus older pages (a refreshed first page wins over stale copies). */
  const loaded = useMemo(() => {
    const first = data.data ?? [];
    const seen = new Set(first.map(keyOf));
    return [...first, ...older.filter((h) => !seen.has(keyOf(h)))];
  }, [data.data, older]);
  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return loaded.filter((h) => !hidden.has(keyOf(h)) && (!q || h.novelName.toLowerCase().includes(q) || h.chapterName.toLowerCase().includes(q)));
  }, [loaded, search, hidden]);

  // A fresh first page that's shorter than a page means there's nothing older.
  useEffect(() => {
    if (data.data) setHasMore((m) => m && (data.data?.length ?? 0) >= PAGE);
  }, [data.data]);

  async function loadOlder(): Promise<void> {
    const last = loaded[loaded.length - 1];
    if (!last || !hasMore || loadingMore.current) return;
    loadingMore.current = true;
    try {
      const page = await bridge().call('history.list', { limit: PAGE, before: last.readAt });
      setOlder((o) => [...o, ...page]);
      if (page.length < PAGE) setHasMore(false);
    } catch {
      // Try again on the next scroll.
    } finally {
      loadingMore.current = false;
    }
  }
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const searching = search.trim() !== '';
  // The newest entry gets the Continue card (not while searching: results stay a plain list).
  const hero = !searching ? items[0] : undefined;
  const sections = useMemo(() => historySections(hero ? items.slice(1) : items, now), [items, hero, now]);
  /** Flattened for the virtual list: section headers and rows, with their heights. */
  const flat = useMemo(() => {
    const rows: ({ kind: 'header'; key: string; label: string } | { kind: 'row'; h: HistoryEntry; section: HistorySection['key'] })[] = [];
    for (const sec of sections) {
      rows.push({ kind: 'header', key: `h:${sec.key}`, label: sec.label });
      for (const h of sec.items) rows.push({ kind: 'row', h, section: sec.key });
    }
    const offsets = [0];
    const headers: { at: number; label: string }[] = [];
    for (const r of rows) {
      const at = offsets[offsets.length - 1] ?? 0;
      if (r.kind === 'header') headers.push({ at, label: r.label });
      offsets.push(at + (r.kind === 'header' ? HEADER_H : ROW_H));
    }
    return { rows, offsets, headers };
  }, [sections]);
  const flatRef = useRef(flat);
  flatRef.current = flat;

  // The current section's header stays pinned under the bar, and the next one pushes it up (virtual
  // rows can't be `position: sticky`). Written straight to the DOM on scroll: no re-render.
  const pin = useRef<HTMLDivElement>(null);
  const pinShown = useRef<{ el: Element | null; label: string; shift: number; on: boolean }>({ el: null, label: '', shift: 0, on: false });
  function updatePin(): void {
    const p = pin.current;
    const vl = list.current?.querySelector<HTMLElement>('.vlist');
    const label = p?.firstElementChild as HTMLElement | null | undefined;
    if (!p || !vl || !label) return;
    // Where the pin line sits in list coordinates (0 until it sticks).
    const y = p.getBoundingClientRect().top - vl.getBoundingClientRect().top;
    const hs = flatRef.current.headers;
    let k = -1;
    while (k + 1 < hs.length && (hs[k + 1]?.at ?? 0) <= y) k++;
    const on = y > 0.5 && k >= 0;
    const next = hs[k + 1];
    const shift = on && next ? Math.min(0, next.at - y - HEADER_H) : 0;
    const text = on ? (hs[k]?.label ?? '') : '';
    // A new element (remounted) starts unknown, so everything is written once.
    const s = pinShown.current.el === p ? pinShown.current : { el: p, label: '-', shift: NaN, on: !on };
    if (s.on !== on) p.classList.toggle('is-on', on);
    if (s.label !== text) label.textContent = text;
    if (s.shift !== shift) label.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : '';
    pinShown.current = { el: p, label: text, shift, on };
  }

  // Keep what you're looking at in place when the list changes above it (reading moves a novel to the
  // top, a refresh lands, a row is removed): the virtual list can't rely on browser scroll anchoring.
  const scroller = useRef<HTMLDivElement>(null);
  const prevFlat = useRef(flat);
  const listTopRef = useRef(-1);
  const flatKey = (r: (typeof flat.rows)[number] | undefined): string => (!r ? '' : r.kind === 'header' ? r.key : keyOf(r.h));
  useLayoutEffect(() => {
    const prev = prevFlat.current;
    prevFlat.current = flat;
    const sc = scroller.current;
    const vl = list.current?.querySelector<HTMLElement>('.vlist');
    if (!sc || !vl) return;
    const listTop = vl.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const oldTop = listTopRef.current >= 0 ? listTopRef.current : listTop;
    listTopRef.current = listTop;
    if (prev === flat || searching) return;
    const y = sc.scrollTop - oldTop;
    if (y <= 0) return;
    let i = 0;
    while (i + 1 < prev.rows.length && (prev.offsets[i + 1] ?? 0) <= y) i++;
    const key = flatKey(prev.rows[i]);
    const j = flat.rows.findIndex((r) => flatKey(r) === key);
    if (j < 0) return;
    const target = listTop + (flat.offsets[j] ?? 0) + (y - (prev.offsets[i] ?? 0));
    if (Math.abs(target - sc.scrollTop) > 1) sc.scrollTop = target;
  }, [flat]);
  useLayoutEffect(updatePin, [flat, data.status]);

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const offLong = attachLongPress(el, '[data-index]', (t) => {
      const h = itemsRef.current[Number(t.dataset['index'])];
      if (h) void rowMenu(h);
    });
    const offSwipe = attachSwipe(el, {
      onCommit: (row) => {
        const h = itemsRef.current.find((x) => keyOf(x) === row.dataset['key']);
        if (h) remove(h);
      },
    });
    return () => {
      offLong();
      offSwipe();
    };
  }, [data.status, items.length > 0]);

  function remove(h: HistoryEntry): void {
    const key = keyOf(h);
    deferredAction(
      `Removed “${h.novelName}” from history`,
      () => setHidden((s) => new Set(s).add(key)),
      () =>
        setHidden((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        }),
      () => {
        void bridge()
          .call('history.remove', { pluginId: h.pluginId, path: h.path })
          .then(() => {
            recent.value = recent.value.filter((r) => !(r.pluginId === h.pluginId && r.path === h.path));
          })
          .catch(() => undefined);
      },
    );
  }

  const resume = (h: HistoryEntry): void => openReader(h.pluginId, h.path, h.chapterPath, h.novelName);

  async function rowMenu(h: HistoryEntry): Promise<void> {
    const i = await actionSheet({
      title: h.novelName,
      actions: [{ title: 'Resume Reading' }, { title: 'Open Novel' }, { title: 'Remove from History', destructive: true }],
    });
    if (i === 0) resume(h);
    else if (i === 1) openNovel({ pluginId: h.pluginId, path: h.path, name: h.novelName, ...(h.cover ? { cover: h.cover } : {}) });
    else if (i === 2) remove(h);
  }

  async function clearAll(): Promise<void> {
    if (!(await confirmAlert('Clear History?', 'This removes all reading history. Your progress in each novel is kept.', 'Clear History'))) return;
    data.setData(() => []);
    recent.value = [];
    await bridge()
      .call('history.clear')
      .catch(() => undefined);
  }

  function toggleIncognito(): void {
    patchSettings({ incognito: !incognito });
    showToast(incognito ? 'Incognito mode off' : 'Incognito mode on: reading isn’t added to history');
  }

  const all = data.data ?? [];
  const indexOf = useMemo(() => new Map(items.map((h, i) => [keyOf(h), i])), [items]);
  const row = (h: HistoryEntry, section: HistorySection['key']) => {
    const index = indexOf.get(keyOf(h)) ?? -1;
    return (
      <div class="sw-row" key={keyOf(h)} data-swipe data-trailing="delete" data-key={keyOf(h)} data-section={section} data-testid="history-row">
        <div class="sw-actions is-trailing" aria-hidden="true">
          <button type="button" class="sw-action" tabIndex={-1}>
            <Icon name="trash" size={22} />
            Delete
          </button>
        </div>
        <div class="sw-content hist-row">
          <button type="button" class="hist-main tap tap-row" data-index={index} onClick={() => resume(h)} aria-label={`Resume ${h.novelName}`}>
            <Cover src={h.cover} pluginId={h.pluginId} title={h.novelName} class="hist-cover" />
            <span class="hist-text">
              <span class="hist-title clamp-2">{h.novelName}</span>
              <span class="hist-chapter ellipsis">{h.chapterName}</span>
              {h.readingMs !== undefined && h.readingMs > 0 && (
                <span class="hist-meta tabular">
                  <Icon name="hourglass" size={16} />
                  {readingTime(h.readingMs)}
                </span>
              )}
              <span class="hist-meta tabular">
                <Icon name="clock" size={16} />
                {whenLabel(h, section, now)}
                {/* Where in the chapter: "· 38%", or done. */}
                <span class="hist-time" data-testid="history-progress">{h.percent >= 0.995 ? ' · Finished' : h.percent > 0 ? ` · ${percentLabel(h.percent)}` : ''}</span>
              </span>
            </span>
          </button>
          <button type="button" class="hist-remove tap tap-dim" aria-label={`Remove ${h.novelName} from history`} onClick={() => remove(h)} data-testid="history-remove">
            <Icon name="trash" size={22} />
          </button>
        </div>
      </div>
    );
  };

  let body;
  if (data.status === 'loading' && !data.data) body = <SkeletonRows count={6} thumb height={141} />;
  else if (data.status === 'error' && data.error && !data.data) body = <ErrorState error={data.error} onRetry={() => void data.reload()} />;
  else if (all.length === 0) body = <EmptyState icon="clock.fill" title="Nothing Read Yet" message="Chapters you read show up here so you can jump right back in." />;
  else if (items.length === 0) body = <EmptyState icon="magnifyingglass" title="No Results" message={`No history matches “${search}”.`} />;
  else
    body = (
      <div ref={list} class="hist-list" data-testid="history-list" data-count={loaded.length}>
        {hero && (
          <div class="hist-hero" data-testid="history-continue">
            <button type="button" class="hist-hero-main tap tap-scale" data-index={0} onClick={() => resume(hero)} aria-label={`Continue ${hero.novelName}`}>
              <Cover src={hero.cover} pluginId={hero.pluginId} title={hero.novelName} class="hist-hero-cover" eager />
              <span class="hist-hero-text">
                <span class="hist-hero-kicker">Continue reading</span>
                <span class="hist-hero-title clamp-2">{hero.novelName}</span>
                <span class="hist-chapter clamp-2">{hero.chapterName}</span>
                <span class="hist-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hero.percent * 100)}>
                  <span style={{ transform: `scaleX(${Math.min(1, Math.max(0, hero.percent))})` }} />
                </span>
                <span class="hist-hero-meta tabular">
                  {percentLabel(hero.percent)} · {dayLabel(hero.readAt, now)} {timeOfDay(hero.readAt)}
                  {hero.readingMs !== undefined && hero.readingMs > 0 ? ` · ${readingTime(hero.readingMs)} read` : ''}
                </span>
              </span>
            </button>
            <Button variant="filled" size="large" icon="play.fill" class="hist-continue" onClick={() => resume(hero)}>
              Continue
            </Button>
          </div>
        )}
        <div ref={pin} class="hist-pin" aria-hidden="true" data-testid="history-pin">
          <div class="day-header" />
        </div>
        <VirtualList
          count={flat.rows.length}
          rowHeight={ROW_H}
          offsets={flat.offsets}
          overscan={6}
          rowKey={(i) => {
            const r = flat.rows[i];
            return r ? (r.kind === 'header' ? r.key : keyOf(r.h)) : i;
          }}
          renderRow={(i) => {
            const r = flat.rows[i];
            if (!r) return null;
            return r.kind === 'header' ? (
              <h3 class="day-header hist-header" data-testid={`history-section-${sections.find((x) => `h:${x.key}` === r.key)?.key ?? ''}`}>
                {r.label}
              </h3>
            ) : (
              row(r.h, r.section)
            );
          }}
          class="hist-vlist"
        />
        {hasMore && !searching && <div class="list-loading" aria-hidden="true" />}
      </div>
    );

  return (
    <Screen
      title="History"
      large
      tab="history"
      testId="screen-history"
      left={<BarButton icon="eyeglasses" label="Incognito mode" active={incognito} onClick={toggleIncognito} testId="history-incognito" />}
      right={
        <>
          <BarButton
            icon="magnifyingglass"
            label="Search history"
            active={searchOpen}
            onClick={() => {
              if (searchOpen) setSearch('');
              else primeKeyboard(); // iOS: the keyboard only opens from inside the tap
              setSearchOpen(!searchOpen);
            }}
            testId="history-search-toggle"
          />
          <BarButton icon="xmark.bin" label="Clear history" disabled={all.length === 0} onClick={() => void clearAll()} testId="history-clear" />
        </>
      }
      accessory={
        searchOpen ? (
          <SearchField value={search} onInput={setSearch} onCancel={() => setSearchOpen(false)} placeholder="Search history" autoFocus testId="history-search" />
        ) : undefined
      }
      onRefresh={async () => {
        setOlder([]);
        setHasMore(true);
        await data.reload({ silent: true });
      }}
      scrollRef={scroller}
      onScroll={(el) => {
        // Where the list starts (the banner or Continue card above it can change size).
        const vl = list.current?.querySelector<HTMLElement>('.vlist');
        if (vl) listTopRef.current = vl.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        updatePin();
        // Page in older history a couple of screens before the end.
        if (hasMore && el.scrollTop + el.clientHeight > el.scrollHeight - 2 * el.clientHeight) void loadOlder();
      }}
    >
      {incognito && (
        <div class="incognito-banner" role="status" data-testid="incognito-banner">
          <Icon name="eyeglasses" size={20} />
          <span class="incognito-text">Incognito is on: what you read isn’t added to History.</span>
          <button type="button" class="link-btn tap tap-dim" onClick={toggleIncognito}>
            Turn Off
          </button>
        </div>
      )}
      {body}
    </Screen>
  );
}
