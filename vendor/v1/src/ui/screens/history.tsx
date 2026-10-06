/**
 * History (Tachimanga layout): a big "Continue" card for the most recent novel, then
 * Today / Yesterday / This Week / This Month / Earlier sections of cover rows (chapter, reading
 * time, when). Swipe a row left (or tap its trash) to remove it with Undo; long-press for more;
 * search; incognito toggle in the header with a banner while it's on; clear all.
 */
import { useComputed } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { HistoryEntry } from '../../shared/contracts/domain.ts';
import { bridge } from '../bridge/client.ts';
import { BarButton, Button, SearchField } from '../components/controls.tsx';
import { Cover } from '../components/cover.tsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/feedback.tsx';
import { useAsync, useNow } from '../components/hooks.ts';
import { Icon } from '../components/icon.tsx';
import { useRefreshWhenShown } from '../components/navigator.tsx';
import { Screen } from '../components/screen.tsx';
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

/** "8:05 AM" in Today/Yesterday (the section says the day); "Monday · 8:05 AM" further back. */
function whenLabel(h: HistoryEntry, section: HistorySection['key'], now: number): string {
  if (section === 'today' || section === 'yesterday') return timeOfDay(h.readAt);
  return `${dayLabel(h.readAt, now)} · ${timeOfDay(h.readAt)}`;
}

export function HistoryScreen() {
  const incognito = useComputed(() => settings.value.incognito).value;
  const data = useAsync(() => bridge().call('history.list', { limit: 300 }), []);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const now = useNow();
  const list = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Reading progress changes refresh History when it's shown (not while it sits hidden behind the reader).
  useRefreshWhenShown('history', () => progressVersion.value, () => void data.reload({ silent: true }));

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data.data ?? []).filter((h) => !hidden.has(keyOf(h)) && (!q || h.novelName.toLowerCase().includes(q) || h.chapterName.toLowerCase().includes(q)));
  }, [data.data, search, hidden]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const searching = search.trim() !== '';
  // The newest entry gets the Continue card (not while searching: results stay a plain list).
  const hero = !searching ? items[0] : undefined;
  const sections = useMemo(() => historySections(hero ? items.slice(1) : items, now), [items, hero, now]);

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
  const row = (h: HistoryEntry, section: HistorySection['key']) => {
    const index = items.indexOf(h);
    return (
      <div class="sw-row" key={keyOf(h)} data-swipe data-trailing="delete" data-key={keyOf(h)} data-testid="history-row">
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
      <div ref={list} class="hist-list" data-testid="history-list">
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
        {sections.map((s) => (
          <section class="hist-section" key={s.key} data-testid={`history-section-${s.key}`}>
            <h3 class="day-header">{s.label}</h3>
            {s.items.map((h) => row(h, s.key))}
          </section>
        ))}
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
      onRefresh={() => data.reload({ silent: true })}
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
