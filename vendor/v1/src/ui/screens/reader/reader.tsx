/**
 * Reader: one infinite, natively scrolling column of chapters in both directions (continuous mode).
 *
 * - The next chapter is appended as soon as the reader is ~2 screens from the end of the last one
 *   (its heading shows immediately, skeleton lines until the text arrives), so scrolling never stops.
 *   Appending below the reading position never moves the text, so it happens even mid-fling.
 * - The previous chapter is prefetched when the reader is ~2 screens from the top of the first one
 *   and inserted above while scrolling is idle, anchored on the visible paragraph (setting scrollTop
 *   during iOS momentum would stop it). Until then a slim loading/error/locked row sits at the top.
 * - At most 3 chapters have their text mounted (the current one ± 1). Far chapters above become
 *   empty blocks of the same height ("spacers", so nothing moves) and are collapsed when idle,
 *   again anchored; far chapters below are simply removed.
 * - The current chapter is the one under the middle of the screen: top bar title, slider, progress
 *   pill, progress.save (≤ 1 per 2 s per chapter + on crossing/background/leave), mark-read.
 */
import { useComputed } from '@preact/signals';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChapterMeta, ChapterPosition, ChapterView, DeviceInfo } from '../../../shared/contracts/domain.ts';
import type { ChapterContent, NovelPage } from '../../../shared/contracts/protocol.ts';
import { bridge, errorText, toUiError, type UiError } from '../../bridge/client.ts';
import { Spinner } from '../../components/controls.tsx';
import { solveChallengeThen } from '../../components/feedback.tsx';
import { Icon } from '../../components/icon.tsx';
import { useOnLeave } from '../../components/navigator.tsx';
import { useNow } from '../../components/hooks.ts';
import { Sheet } from '../../components/sheet.tsx';
import { VirtualList, type VirtualListHandle } from '../../components/virtual-list.tsx';
import { firstNumber } from '../../lib/chapters.ts';
import { percentLabel, plural, timeOfDay } from '../../lib/format.ts';
import { haptic } from '../../lib/gestures.ts';
import {
  createProgressSaver,
  lastIndexAtOrBefore,
  lineForPosition,
  percentRead,
  positionAt,
  samePosition,
  scrollTopForPercent,
  sectionAt,
} from '../../lib/position.ts';
import { openInSafari, quickAddToLibrary } from '../../state/actions.ts';
import { onBackground } from '../../state/lifecycle.ts';
import { getNovelPage, noteBookmark, noteProgress, novelKey, putNovelPage } from '../../state/novel-cache.ts';
import { pop } from '../../state/nav.ts';
import { libraryKeys, progressVersion, settings, sourceById } from '../../state/store.ts';
import { errorToast, showToast } from '../../state/toast.ts';
import { primeKeyboard } from '../../lib/keyboard.ts';
import { langCode } from '../../lib/lang.ts';
import { languageName } from '../browse.tsx';
import { volumeLayout } from '../../lib/volumes.ts';
import { countWords, newPace, notePace, PACE_KEY, timeLeftLabel, type PaceState } from '../../lib/pace.ts';
import { AUTO_SCROLL_LIMITS, clampSpeed, useAutoScroll } from './auto-scroll.ts';
import { ChapterSection, measureBlocks, splitChapterTitle, type ChapterEntry } from './chapter-section.tsx';
import { FindBar } from './find-bar.tsx';
import { PagedReader, type PagedHandle, type PageInfo } from './paged.tsx';
import { fontFamily, hyphenates, infoPillMode, justifyFits, ReaderSettingsPanel, setReader } from './reader-settings.tsx';

/** The reader's pace (words per minute), learned while reading and remembered on this device. */
const readingPace = {
  state: null as PaceState | null,
  get value(): PaceState {
    if (!this.state) {
      let wpm: number | undefined;
      try {
        const v = Number(localStorage.getItem(PACE_KEY));
        if (v > 0) wpm = v;
      } catch {
        /* private mode */
      }
      this.state = newPace(wpm);
    }
    return this.state;
  },
  set value(next: PaceState) {
    const changed = next.wpm !== this.state?.wpm;
    this.state = next;
    if (changed) {
      try {
        localStorage.setItem(PACE_KEY, String(next.wpm));
      } catch {
        /* private mode */
      }
    }
  },
};

/** Save the position this long after scrolling stops. */
const SETTLE_SAVE_MS = 300;
const IDLE_MS = 220;
/** Prefetch distance, in screens, before the end of the last / start of the first chapter. */
const PREFETCH_SCREENS = 2;
/** Haptic tick when a chapter heading crosses the screen centre (enable once CP2 confirms the trick). */
const HAPTIC_ON_BOUNDARY = false;
const CACHE_SIZE = 8;

interface SectionInfo {
  key: number;
  top: number;
  height: number;
  el: HTMLElement;
}

interface Saved {
  path: string;
  position: ChapterPosition;
}

interface PrevEdge {
  status: 'idle' | 'loading' | 'error' | 'locked';
  meta?: ChapterMeta;
  error?: UiError;
}

function stripPosition(c: ChapterContent): ChapterContent {
  const { position: _ignored, ...rest } = c;
  return rest;
}

/**
 * Scrolling and paged reading are separate mounts of the same reader (switching continues from the
 * chapter and position being read: the outgoing one saves, the incoming one restores).
 */
export function ReaderScreen(props: { pluginId: string; novelPath: string; chapterPath: string; novelName?: string }) {
  const paged = useComputed(() => settings.value.reader.paged).value;
  const lastPath = useRef(props.chapterPath);
  return (
    <ReaderView
      key={paged ? 'paged' : 'scroll'}
      {...props}
      chapterPath={lastPath.current}
      paged={paged}
      onChapterPath={(path) => {
        lastPath.current = path;
      }}
    />
  );
}

function ReaderView(props: { pluginId: string; novelPath: string; chapterPath: string; novelName?: string; paged: boolean; onChapterPath: (path: string) => void }) {
  const pageKey = novelKey(props.pluginId, props.novelPath);
  const rs = settings.value.reader;
  const source = sourceById(props.pluginId);
  // The chapter being restored is laid out eagerly (no content-visibility placeholder clamping the scroll).
  const [entries, setEntries] = useState<ChapterEntry[]>([{ key: 1, path: props.chapterPath, status: 'loading', eager: true }]);
  const [prevEdge, setPrevEdge] = useState<PrevEdge>({ status: 'idle' });
  const [currentKey, setCurrentKey] = useState(1);
  const [barsVisible, setBarsVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [novelChapters, setNovelChapters] = useState<ChapterView[] | null>(null);
  const [novelName, setNovelName] = useState(props.novelName ?? '');
  const novelNameRef = useRef(novelName);
  novelNameRef.current = novelName;
  const finishedHere = useRef(new Set<string>());
  const nudged = useRef(false);
  const [novelUrl, setNovelUrl] = useState<string | undefined>(undefined);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  /** Double-tap info pill (time, battery, chapter %): hidden while reading unless asked for. */
  const [pillShown, setPillShown] = useState(false);
  const pillMode = infoPillMode(rs.showFooter);
  const [viewportW, setViewportW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setViewportW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [findOpen, setFindOpen] = useState(false);
  /** Text selected in the chapter (long-press → drag): offer "Copy quote" / "Share quote". */
  const currentTitleRef = useRef('');
  const [quote, setQuote] = useState<{ text: string; chapter: string } | null>(null);
  const [findKey, setFindKey] = useState(0);
  const pagedHandle = useRef<PagedHandle | null>(null);
  /** Paged mode: the chapter on screen. */
  const [pagedAt, setPagedAt] = useState<{ path: string; content: ChapterContent } | null>(null);
  const pagedPath = useRef<string | null>(null);
  const findOpenRef = useRef(false);
  findOpenRef.current = findOpen;
  const now = useNow(30_000);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const prevEdgeRef = useRef(prevEdge);
  prevEdgeRef.current = prevEdge;
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;
  const barsRef = useRef(barsVisible);
  barsRef.current = barsVisible;
  const rsRef = useRef(rs);
  rsRef.current = rs;

  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const auto = useAutoScroll(
    scroller,
    () => rsRef.current.autoScrollSpeed,
    () => {
      showBars(true);
      showToast('Auto-scroll stopped at the end');
    },
    // A finger (drag or tap) paused it: show the controls (play / speed / Stop) so it can be ended.
    () => showBars(true),
  );
  const content = useRef<HTMLDivElement>(null);
  const insetProbe = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const pillPct = useRef<HTMLSpanElement>(null);
  const bodies = useRef(new Map<number, HTMLElement>());
  const measures = useRef(new Map<number, { tops: number[]; heights: number[] }>());
  const cache = useRef(new Map<string, ChapterContent>());
  /** Latest known position per chapter: from chapter.get, then every save in this session (fresh for jumps back). */
  const positions = useRef(new Map<string, ChapterPosition>());
  const restoreFor = useRef<number | null>(1);
  const anchor = useRef<{ el: Element; top: number } | null>(null);
  const marked = useRef(new Set<string>());
  const keySeq = useRef(2);
  const lastPos = useRef<Saved | null>(null);
  const draggingSlider = useRef(false);
  const touching = useRef(false);
  /** Until when scroll events count as the reader's own scrolling (touch, momentum, wheel, keys). */
  const userScrollUntil = useRef(0);
  const tapTimer = useRef(0);
  const pillTimer = useRef(0);
  const [checkingNew, setCheckingNew] = useState(false);
  /** The next restore is an explicit spot (Back to…), not a saved "where I stopped". */
  const exactRestore = useRef(false);
  /** "Auto-scroll · tap to pause", shown briefly when it starts or resumes (the bars are hidden then). */
  const [autoHint, setAutoHint] = useState(false);
  const autoHintTimer = useRef(0);
  const [jumpBack, setJumpBack] = useState<{ path: string; position: ChapterPosition; label: string } | null>(null);
  const turnsSinceJump = useRef(0);
  const wordCounts = useRef(new Map<string, number>());
  const pillLeft = useRef<HTMLSpanElement>(null);
  const barCaption = useRef<HTMLDivElement>(null);
  const settleTimer = useRef(0);
  /** Where the running page-turn animation is heading (so quick taps accumulate). */
  const pageTarget = useRef<{ top: number; until: number } | null>(null);
  const lastScrollAt = useRef(0);
  const idleTimer = useRef(0);
  const pendingPrepend = useRef<{ content: ChapterContent; meta: ChapterMeta } | null>(null);
  const fetchingNext = useRef<string | null>(null);
  const barsShownAt = useRef(0);
  const rafPending = useRef(false);
  const originalBrightness = useRef<number | null>(null);
  const changedBrightness = useRef(false);
  const brightnessSend = useRef<{ last: number; timer: number; pending: number | null }>({ last: 0, timer: 0, pending: null });

  const saver = useMemo(
    () =>
      createProgressSaver<Saved>({
        intervalMs: 2000,
        save: (v) => persist(v.path, v.position, false),
        equals: (a, b) => a.path === b.path && samePosition(a.position, b.position),
      }),
    [],
  );

  /** Current position → progress.save now (skipped when unchanged). */
  function saveNow(): void {
    tick();
    saver.flush();
  }

  function persist(path: string, position: ChapterPosition, finished: boolean): void {
    positions.current.set(path, position);
    noteProgress(pageKey, path, position, finished);
    if (finished) nudgeLibrary(path);
    bridge()
      .call('progress.save', { pluginId: props.pluginId, novelPath: props.novelPath, chapterPath: path, position, ...(finished ? { finished } : {}) })
      .catch(() => undefined);
  }

  /**
   * Reading a novel that isn't in the library: after two finished chapters, offer to add it (once per
   * reading session; never in incognito mode).
   */
  function nudgeLibrary(path: string): void {
    if (nudged.current || settings.peek().incognito || libraryKeys.peek().has(pageKey)) return;
    finishedHere.current.add(path);
    if (finishedHere.current.size < 2) return;
    nudged.current = true;
    const name = novelNameRef.current || 'this novel';
    showToast(`Enjoying ${name}? Keep it in your library.`, {
      actionLabel: 'Add',
      undo: () => void quickAddToLibrary({ pluginId: props.pluginId, path: props.novelPath, name: novelNameRef.current || props.novelPath }),
      durationMs: 6000,
    });
  }

  /** Chapter list with this session's reading applied (read marks, how far into each chapter). */
  function openList(): void {
    setNovelChapters((cs) =>
      cs?.map((c) => {
        if (marked.current.has(c.path)) return c.read ? c : { ...c, read: true };
        const p = positions.current.get(c.path);
        return p && !c.read && p.percent > 0 && p.percent !== c.progress ? { ...c, progress: p.percent } : c;
      }) ?? cs,
    );
    setListOpen(true);
  }

  // Selected text in a chapter → the quote bar. iOS keeps its own selection menu (Copy, Look Up…).
  useEffect(() => {
    let t = 0;
    const onSelection = (): void => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        const sel = window.getSelection();
        const text = sel && !sel.isCollapsed ? sel.toString().replace(/\s+/g, ' ').trim() : '';
        const node = sel?.anchorNode ?? null;
        const el = node instanceof Element ? node : node?.parentElement;
        const section = el?.closest<HTMLElement>('.rd-chapter, .rd-psec');
        if (!text || text.length < 2 || !section || !el?.closest('[data-testid="reader-body"]')) {
          setQuote(null);
          return;
        }
        const key = Number(section.dataset['key']);
        const entry = entriesRef.current.find((e) => e.key === key);
        const chapter = entry?.content?.title ?? entry?.name ?? currentTitleRef.current;
        setQuote({ text: text.length > 1200 ? `${text.slice(0, 1200)}…` : text, chapter });
      }, 250);
    };
    document.addEventListener('selectionchange', onSelection);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('selectionchange', onSelection);
    };
  }, []);

  function quoteText(q: { text: string; chapter: string }): string {
    const source = [novelNameRef.current, q.chapter].filter(Boolean).join(', ');
    return `“${q.text}”${source ? ` — ${source}` : ''}`;
  }

  function shareQuote(): void {
    if (!quote) return;
    void bridge()
      .call('native.share', { text: quoteText(quote) })
      .catch(() => undefined);
    window.getSelection()?.removeAllRanges();
    setQuote(null);
  }

  async function copyQuote(): Promise<void> {
    if (!quote) return;
    const text = quoteText(quote);
    let ok: boolean;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Older WebKit / no permission: copy through a hidden text field.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;';
      document.body.append(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    }
    window.getSelection()?.removeAllRanges();
    setQuote(null);
    showToast(ok ? 'Quote copied' : 'Couldn’t copy');
  }

  // ---------- fetching ----------

  /** Chapter text (cached without its position: positions change while reading, see `positions`). */
  async function fetchChapter(path: string): Promise<ChapterContent> {
    const hit = cache.current.get(path);
    if (hit) return hit;
    const full = await bridge().call('chapter.get', { pluginId: props.pluginId, novelPath: props.novelPath, chapterPath: path }, { timeoutMs: 60_000 });
    if (full.position && !positions.current.has(path)) positions.current.set(path, full.position);
    const c = stripPosition(full);
    cache.current.set(path, c);
    while (cache.current.size > CACHE_SIZE) {
      const oldest = cache.current.keys().next().value;
      if (oldest === undefined) break;
      cache.current.delete(oldest);
    }
    return c;
  }

  function patchEntry(key: number, patch: Partial<ChapterEntry>): void {
    setEntries((es) => es.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  }

  async function loadEntry(key: number, path: string, keepPosition: boolean): Promise<void> {
    try {
      const c = await fetchChapter(path);
      const pos = keepPosition ? positions.current.get(path) : undefined;
      patchEntry(key, { status: 'ready', content: pos ? { ...c, position: pos } : c, name: c.title });
    } catch (err) {
      const e = toUiError(err);
      patchEntry(key, e.code === 'LOCKED' ? { status: 'locked' } : { status: 'error', error: e });
    }
  }

  // Layout effect: request the chapter in the same frame the reader mounts.
  useLayoutEffect(() => {
    if (!props.paged) void loadEntry(1, props.chapterPath, true);
    bridge()
      .call('native.device')
      .then((d) => {
        setDevice(d);
        originalBrightness.current = d.brightness;
        const b = rsRef.current.brightness;
        if (b !== null) applyBrightness(b);
      })
      .catch(() => undefined);
  }, []);

  // Chapter list / bookmarks / novel name: from the novel page we came from, else fetched after the first paint.
  useEffect(() => {
    const apply = (p: NovelPage): void => {
      setNovelChapters(p.chapters);
      setNovelUrl(p.details.url);
      // Name/number for headings that are still waiting for their text.
      const byPath = new Map(p.chapters.map((c) => [c.path, c]));
      setEntries((es) =>
        es.map((e) => {
          const c = byPath.get(e.path);
          return c && (e.name === undefined || e.number === undefined) ? { ...e, name: e.name ?? c.name, ...(c.number !== undefined ? { number: e.number ?? c.number } : {}) } : e;
        }),
      );
      if (!props.novelName) setNovelName(p.details.name);
    };
    const cached = getNovelPage(pageKey);
    if (cached) {
      apply(cached);
      return;
    }
    const t = window.setTimeout(() => {
      bridge()
        .call('novel.get', { pluginId: props.pluginId, path: props.novelPath }, { timeoutMs: 60_000 })
        .then((p) => {
          putNovelPage(pageKey, p);
          apply(p);
        })
        .catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(t);
  }, []);

  /** Append the next chapter below the last one (heading now, text when it arrives). */
  function ensureNext(): void {
    if (!rsRef.current.continuous) return;
    const es = entriesRef.current;
    const last = es[es.length - 1];
    const next = last?.status === 'ready' ? last.content?.next : undefined;
    if (!last || !next || fetchingNext.current === next.path) return;
    if (es.some((e) => e.path === next.path)) return;
    const key = keySeq.current++;
    const entry: ChapterEntry = { key, path: next.path, name: next.name, ...(next.number !== undefined ? { number: next.number } : {}), status: next.locked ? 'locked' : 'loading' };
    setEntries((xs) => [...xs, entry]);
    if (next.locked) return;
    fetchingNext.current = next.path;
    void loadEntry(key, next.path, false).finally(() => {
      fetchingNext.current = null;
    });
  }

  /** Caught up: ask the source for chapters after the last one, and read straight on if there are. */
  async function checkForNew(): Promise<void> {
    const last = entriesRef.current[entriesRef.current.length - 1];
    if (!last || last.status !== 'ready' || !last.content) return;
    setCheckingNew(true);
    try {
      const page = await bridge().call('novel.get', { pluginId: props.pluginId, path: props.novelPath, refresh: true }, { timeoutMs: 60_000 });
      putNovelPage(pageKey, page);
      setNovelChapters(page.chapters);
      const i = page.chapters.findIndex((c) => c.path === last.path);
      const next = i >= 0 ? page.chapters[i + 1] : undefined;
      if (!next) {
        showToast('No new chapters yet');
        return;
      }
      showToast(`${plural(page.chapters.length - 1 - i, 'new chapter')}`);
      // The last chapter's text now knows what comes next (same objects: its text isn't re-rendered).
      const meta: ChapterMeta = { path: next.path, name: next.name, ...(next.number !== undefined ? { number: next.number } : {}), ...(next.locked ? { locked: true } : {}) };
      last.content.next = meta;
      const cached = cache.current.get(last.path);
      if (cached) cached.next = meta;
      setEntries((es) => [...es]);
      window.setTimeout(ensureNext, 0);
      progressVersion.value++;
    } catch (err) {
      errorToast(errorText(toUiError(err)));
    } finally {
      setCheckingNew(false);
    }
  }

  /** Prefetch the chapter before the first one; it's inserted above when scrolling is idle. */
  function ensurePrev(): void {
    if (!rsRef.current.continuous) return;
    const first = entriesRef.current[0];
    const prev = first?.status === 'ready' ? first.content?.prev : undefined;
    if (!first || !prev || pendingPrepend.current) return;
    const edge = prevEdgeRef.current;
    if (edge.meta?.path === prev.path && edge.status !== 'idle') return;
    if (prev.locked) {
      setPrevEdge({ status: 'locked', meta: prev });
      return;
    }
    setPrevEdge({ status: 'loading', meta: prev });
    fetchChapter(prev.path)
      .then((c) => {
        if (entriesRef.current[0]?.key !== first.key) return; // the window moved meanwhile
        pendingPrepend.current = { content: c, meta: prev };
        scheduleIdle();
      })
      .catch((err: unknown) => {
        const e = toUiError(err);
        setPrevEdge(e.code === 'LOCKED' ? { status: 'locked', meta: prev } : { status: 'error', meta: prev, error: e });
      });
  }

  function retry(key: number): void {
    const e = entriesRef.current.find((x) => x.key === key);
    if (!e) return;
    const isFirst = entriesRef.current[0]?.key === key;
    patchEntry(key, { status: 'loading' });
    if (isFirst && e.content === undefined) restoreFor.current = key;
    void loadEntry(key, e.path, isFirst);
  }

  // Back online (or back from the background): chapters that failed to load try again by themselves.
  useEffect(() => {
    const again = (): void => {
      for (const e of entriesRef.current) if (e.status === 'error' && e.error?.code !== 'CLOUDFLARE') retry(e.key);
      if (prevEdgeRef.current.status === 'error') {
        setPrevEdge({ status: 'idle' });
        window.setTimeout(ensurePrev, 0);
      }
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') again();
    };
    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // ---------- geometry ----------

  const insetTop = (): number => insetProbe.current?.offsetHeight ?? 0;

  function sections(): SectionInfo[] {
    const c = content.current;
    if (!c) return [];
    const out: SectionInfo[] = [];
    for (const el of Array.from(c.children) as HTMLElement[]) {
      const key = Number(el.dataset['key']);
      if (!Number.isFinite(key) || el.dataset['key'] === undefined) continue;
      out.push({ key, top: el.offsetTop, height: el.offsetHeight, el });
    }
    return out;
  }

  function measure(key: number): { tops: number[]; heights: number[] } | null {
    let m = measures.current.get(key);
    if (!m) {
      const body = bodies.current.get(key);
      if (!body) return null;
      m = measureBlocks(body);
      measures.current.set(key, m);
    }
    return m;
  }

  const bodyObserver = useMemo(
    () =>
      new ResizeObserver((items) => {
        for (const e of items) {
          const key = Number((e.target as HTMLElement).closest<HTMLElement>('.rd-chapter')?.dataset['key']);
          measures.current.delete(key);
        }
      }),
    [],
  );

  function onBodyGone(key: number): void {
    const b = bodies.current.get(key);
    if (b) bodyObserver.unobserve(b);
    bodies.current.delete(key);
    measures.current.delete(key);
  }

  /** A fading bar in the margin next to the paragraph a restore landed on (outside the text). */
  function markResume(el: Element | undefined): void {
    if (!(el instanceof HTMLElement)) return;
    el.classList.add('rd-resume-mark');
    window.setTimeout(() => el.classList.remove('rd-resume-mark'), 3200);
  }

  function onBodyReady(key: number, body: HTMLElement): void {
    bodies.current.set(key, body);
    measures.current.delete(key);
    bodyObserver.observe(body);
    if (restoreFor.current === key) {
      restoreFor.current = null;
      const e = entriesRef.current.find((x) => x.key === key);
      const pos = e?.content?.position;
      const sc = scroller.current;
      const sec = sections().find((s) => s.key === key);
      if (sc && sec) {
        // A chapter finished earlier opens at its start (re-reading); an explicit spot (Back to…) is exact.
        const finished = pos !== undefined && pos.percent >= rsRef.current.markReadAt && !exactRestore.current;
        exactRestore.current = false;
        if (pos && pos.percent < 0.995 && !finished) {
          const m = measure(key);
          const line = lineForPosition(pos, m?.tops ?? [], m?.heights ?? [], body.offsetHeight);
          sc.scrollTop = Math.max(0, sec.top + body.offsetTop + line - insetTop());
          // Where you left off: a short-lived mark in the margin beside that paragraph.
          if (pos.paragraph > 0 || (pos.offset ?? 0) > 0) markResume(body.children[pos.paragraph]);
        } else {
          sc.scrollTop = sec.top;
        }
        barsShownAt.current = sc.scrollTop;
      }
      requestAnimationFrame(() => {
        tick();
        // Opened (or jumped to) a chapter: have both neighbours ready, whatever the position.
        ensurePrev();
        ensureNext();
      });
    }
  }

  /** Remember the paragraph at the top of the screen so a DOM change above it can be compensated. */
  function captureAnchor(): void {
    const sc = scroller.current;
    if (!sc) return;
    const lineY = sc.getBoundingClientRect().top + insetTop() + 1;
    let el: Element | null = null;
    const body = bodies.current.get(currentKeyRef.current);
    const m = measure(currentKeyRef.current);
    if (body && m && m.tops.length > 0) {
      const idx = lastIndexAtOrBefore(m.tops, lineY - body.getBoundingClientRect().top);
      el = body.children[idx] ?? null;
    }
    el ??= content.current?.querySelector(`[data-key="${currentKeyRef.current}"]`) ?? null;
    if (el) anchor.current = { el, top: el.getBoundingClientRect().top };
  }

  // After every structural change: undo any movement of the anchored paragraph (before paint).
  useLayoutEffect(() => {
    const a = anchor.current;
    const sc = scroller.current;
    anchor.current = null;
    if (!a || !sc || !a.el.isConnected) return;
    const delta = a.el.getBoundingClientRect().top - a.top;
    if (Math.abs(delta) > 0.5) {
      sc.scrollTop += delta;
      barsShownAt.current = sc.scrollTop;
    }
  }, [entries, prevEdge]);

  /** native.setBrightness at most every ~100 ms while the slider moves, always ending on the last value. */
  function sendBrightness(v: number): void {
    const b = brightnessSend.current;
    b.pending = v;
    if (b.timer) return;
    b.timer = window.setTimeout(
      () => {
        b.timer = 0;
        b.last = performance.now();
        const value = b.pending;
        b.pending = null;
        if (value !== null) void bridge().call('native.setBrightness', { value }).catch(() => undefined);
      },
      Math.max(0, b.last + 100 - performance.now()),
    );
  }

  function cancelBrightness(): void {
    const b = brightnessSend.current;
    window.clearTimeout(b.timer);
    b.timer = 0;
    b.pending = null;
  }

  function applyBrightness(v: number | null): void {
    if (v === null) {
      cancelBrightness();
      if (changedBrightness.current && originalBrightness.current !== null) {
        void bridge().call('native.setBrightness', { value: originalBrightness.current }).catch(() => undefined);
        changedBrightness.current = false;
      }
      return;
    }
    changedBrightness.current = true;
    sendBrightness(v);
  }

  // ---------- scroll tracking ----------

  /** Pace + "N min left" in the info pill. */
  function noteReading(path: string, content: ChapterContent, pct: number): void {
    let w = wordCounts.current.get(path);
    if (w === undefined) {
      w = countWords(content.html);
      wordCounts.current.set(path, w);
    }
    readingPace.value = notePace(readingPace.value, path, pct, w, Date.now());
    const left = timeLeftLabel(w, pct, readingPace.value.wpm);
    if (pillLeft.current) pillLeft.current.textContent = left;
    // The pill hides with the bars up: the bottom bar says it too ("45% · 8 min left").
    if (barCaption.current) barCaption.current.textContent = [pillPct.current?.textContent ?? '', left].filter(Boolean).join(' · ');
  }

  function updateProgressUi(pct: number): void {
    if (slider.current && !draggingSlider.current) {
      slider.current.value = String(Math.round(pct * 1000));
      slider.current.style.setProperty('--pct', `${pct * 100}%`);
      slider.current.setAttribute('aria-valuetext', `${Math.round(Math.max(0, Math.min(1, pct)) * 100)} percent of the chapter`);
    }
    if (pillPct.current) pillPct.current.textContent = `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%`;
  }

  /** Mount the current chapter ± 1; spacer-ize far chapters above, drop far chapters below. */
  function enforceWindow(idx: number, secs: SectionInfo[], st: number, vh: number): void {
    const es = entriesRef.current;
    let changed = false;
    const out: ChapterEntry[] = [];
    es.forEach((e, i) => {
      const s = secs.find((x) => x.key === e.key);
      const inWindow = i >= idx - 1 && i <= idx + 1;
      if (inWindow) {
        if (e.spacer !== undefined) {
          const { spacer: _s, ...live } = e;
          out.push(live);
          changed = true;
        } else out.push(e);
        return;
      }
      if (i > idx + 1 && s && s.top > st + vh * 1.5) {
        changed = true; // far below: drop (nothing above the reading position moves)
        if (fetchingNext.current === e.path) fetchingNext.current = null;
        return;
      }
      if (i < idx - 1 && s && e.spacer === undefined && e.status === 'ready' && s.top + s.height < st - vh * 0.5) {
        out.push({ ...e, spacer: s.height }); // far above: same height, no text
        changed = true;
        return;
      }
      out.push(e);
    });
    if (changed) setEntries(out);
  }

  function tick(): void {
    const sc = scroller.current;
    if (!sc) return;
    const st = sc.scrollTop;
    const vh = sc.clientHeight;
    const secs = sections();
    if (secs.length === 0) return;
    // The current chapter is the one under the middle of the screen.
    const idx = Math.max(0, sectionAt(secs, st + vh / 2));
    const sec = secs[idx];
    const es = entriesRef.current;
    const entry = es.find((e) => e.key === sec?.key);
    if (!sec || !entry) return;
    enforceWindow(es.indexOf(entry), secs, st, vh);

    if (entry.key !== currentKeyRef.current) {
      const prevIdx = es.findIndex((e) => e.key === currentKeyRef.current);
      const prev = es[prevIdx];
      // Scrolled forward past a chapter's end → it's read.
      if (prev?.status === 'ready' && prevIdx < es.indexOf(entry) && !marked.current.has(prev.path)) {
        marked.current.add(prev.path);
        persist(prev.path, { percent: 1, paragraph: Math.max(0, (measure(prev.key)?.tops.length ?? 1) - 1), offset: 0 }, true);
      }
      saver.flush();
      currentKeyRef.current = entry.key;
      setCurrentKey(entry.key);
      progressVersion.value++;
      if (HAPTIC_ON_BOUNDARY) haptic();
    }

    const pct = percentRead(st, sec.top, sec.height, vh);
    updateProgressUi(pct);
    if (entry.status === 'ready' && entry.content) noteReading(entry.path, entry.content, pct);

    if (entry.status === 'ready' && entry.spacer === undefined) {
      const body = bodies.current.get(entry.key);
      const m = measure(entry.key);
      if (body && m) {
        const line = st + insetTop() + 1 - (sec.top + body.offsetTop);
        const pos = line < 0 ? { percent: pct, paragraph: 0, offset: 0 } : positionAt(m.tops, line, pct);
        lastPos.current = { path: entry.path, position: pos };
        saver.update(lastPos.current);
        if (pct >= rsRef.current.markReadAt && !marked.current.has(entry.path)) {
          marked.current.add(entry.path);
          persist(entry.path, pos, true);
          progressVersion.value++;
        }
      }
    }

    // Prefetch neighbours ~2 screens ahead in either direction.
    const lastSec = secs[secs.length - 1];
    if (lastSec && lastSec.top + lastSec.height - (st + vh) < vh * PREFETCH_SCREENS) ensureNext();
    const firstSec = secs[0];
    if (firstSec && st - firstSec.top < vh * PREFETCH_SCREENS) ensurePrev();
  }

  /** Scrolling has settled: insert the prefetched previous chapter and collapse spacers, anchored. */
  function onIdle(): void {
    if (touching.current || performance.now() - lastScrollAt.current < IDLE_MS - 20) {
      scheduleIdle();
      return;
    }
    const es = entriesRef.current;
    let out = es;
    const pending = pendingPrepend.current;
    if (pending && es[0]?.content?.prev?.path === pending.meta.path) {
      const key = keySeq.current++;
      out = [
        {
          key,
          path: pending.meta.path,
          name: pending.content.title,
          ...(pending.meta.number !== undefined ? { number: pending.meta.number } : {}),
          status: 'ready',
          content: pending.content,
          eager: true,
        },
        ...out,
      ];
    }
    const prepended = out !== es;
    pendingPrepend.current = null;
    if (out.some((e) => e.spacer !== undefined)) out = out.filter((e) => e.spacer === undefined);
    if (out !== es) {
      captureAnchor();
      if (prepended) setPrevEdge({ status: 'idle' });
      setEntries(out);
    }
  }

  function scheduleIdle(): void {
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(onIdle, IDLE_MS);
  }

  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const onScroll = (): void => {
      const t = performance.now();
      lastScrollAt.current = t;
      // Only the reader's own scrolling hides the bars (not restore, anchoring or the slider).
      const userScroll = touching.current || t < userScrollUntil.current;
      if (userScroll) userScrollUntil.current = Math.max(userScrollUntil.current, t + 600); // momentum
      // While auto-scroll is on (paused by the finger), keep its controls up so it can be resumed or stopped.
      if (userScroll && barsRef.current && !findOpenRef.current && auto.current() === 'off' && Math.abs(sc.scrollTop - barsShownAt.current) > 48 && !draggingSlider.current) {
        setBarsVisible(false);
        setJumpBack(null); // reading on from the new place
      }
      scheduleIdle();
      // Save as soon as scrolling settles: closing the app right after must not lose the position.
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(saveNow, SETTLE_SAVE_MS);
      if (rafPending.current) return;
      rafPending.current = true;
      requestAnimationFrame(() => {
        rafPending.current = false;
        tick();
      });
    };
    const ts = (): void => {
      touching.current = true;
    };
    const te = (): void => {
      touching.current = false;
      saveNow(); // finger lifted: save the position now (momentum is caught by the settle save)
      userScrollUntil.current = performance.now() + 1500; // momentum after lifting the finger
      scheduleIdle();
    };
    const wheel = (): void => {
      userScrollUntil.current = performance.now() + 400;
    };
    const keys = (e: KeyboardEvent): void => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ', 'Home', 'End'].includes(e.key)) userScrollUntil.current = performance.now() + 800;
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    sc.addEventListener('touchstart', ts, { passive: true });
    sc.addEventListener('touchend', te, { passive: true });
    sc.addEventListener('touchcancel', te, { passive: true });
    sc.addEventListener('wheel', wheel, { passive: true });
    window.addEventListener('keydown', keys);
    return () => {
      sc.removeEventListener('scroll', onScroll);
      sc.removeEventListener('touchstart', ts);
      sc.removeEventListener('touchend', te);
      sc.removeEventListener('touchcancel', te);
      sc.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', keys);
      window.clearTimeout(tapTimer.current);
      window.clearTimeout(pillTimer.current);
      window.clearTimeout(settleTimer.current);
    };
  }, []);

  // Text arrived / chapters changed: re-evaluate the window and prefetching.
  useEffect(() => {
    const t = requestAnimationFrame(() => tick());
    return () => cancelAnimationFrame(t);
  }, [entries]);

  // Leaving (back, edge swipe, pushing another screen): save now, before the screen underneath reloads.
  // The position goes out even if a settle save just sent it: leaving is the moment that must reach the script.
  useOnLeave(() => {
    saveFinal();
    progressVersion.value++;
  });

  /** The position goes out now, even if a settle save already sent it (leaving / backgrounding). */
  function saveFinal(): void {
    tick();
    const pending = saver.pending;
    saver.flush();
    if (!pending && lastPos.current) persist(lastPos.current.path, lastPos.current.position, false);
  }

  // Save on backgrounding and when leaving.
  useEffect(() => {
    const onVis = (): void => {
      if (document.visibilityState === 'visible' && rsRef.current.keepAwake) void requestWakeLock();
    };
    document.addEventListener('visibilitychange', onVis);
    // Backgrounded: save the exact position before the script flushes (app.flush).
    const offBackground = onBackground(() => {
      saveFinal(); // before the script's app.flush
    });
    return () => {
      offBackground();
      document.removeEventListener('visibilitychange', onVis);
      tick();
      saver.flush();
      progressVersion.value++;
      window.clearTimeout(idleTimer.current);
      bodyObserver.disconnect();
      cancelBrightness();
      if (changedBrightness.current && originalBrightness.current !== null) {
        void bridge().call('native.setBrightness', { value: originalBrightness.current }).catch(() => undefined);
      }
      void releaseWakeLock();
    };
  }, []);

  // ---------- keep awake ----------

  const wakeLock = useRef<WakeLockSentinel | null>(null);
  async function requestWakeLock(): Promise<void> {
    try {
      if ('wakeLock' in navigator && !wakeLock.current) {
        wakeLock.current = await navigator.wakeLock.request('screen');
        wakeLock.current.addEventListener('release', () => {
          wakeLock.current = null;
        });
      }
    } catch {
      // not allowed / unsupported
    }
  }
  async function releaseWakeLock(): Promise<void> {
    const w = wakeLock.current;
    wakeLock.current = null;
    await w?.release().catch(() => undefined);
  }
  useEffect(() => {
    if (rs.keepAwake) void requestWakeLock();
    else void releaseWakeLock();
  }, [rs.keepAwake]);

  // Battery refresh.
  useEffect(() => {
    const t = window.setInterval(() => {
      bridge()
        .call('native.device')
        .then(setDevice)
        .catch(() => undefined);
    }, 5 * 60_000);
    return () => window.clearInterval(t);
  }, []);

  // Typography changed: keep only the current chapter (others' heights are stale) on the same paragraph.
  const typo = `${rs.font}|${rs.fontSize}|${rs.lineHeight}|${rs.paragraphSpacing}|${rs.margin}|${rs.justify}|${rs.indent}|${hyphenates(rs.justify)}`;
  const firstTypo = useRef(true);
  const reanchorTypo = useRef(false);
  useLayoutEffect(() => {
    if (firstTypo.current || props.paged) {
      firstTypo.current = false;
      return;
    }
    measures.current.clear();
    pendingPrepend.current = null;
    const cur = entriesRef.current.find((e) => e.key === currentKeyRef.current);
    if (cur && entriesRef.current.length > 1) {
      reanchorTypo.current = true;
      setPrevEdge({ status: 'idle' });
      setEntries([cur]);
    } else reanchor();
  }, [typo]);
  useLayoutEffect(() => {
    if (!reanchorTypo.current) return;
    reanchorTypo.current = false;
    measures.current.clear();
    reanchor();
  }, [entries]);

  function reanchor(): void {
    const saved = lastPos.current;
    const sc = scroller.current;
    if (!saved || !sc) return;
    const e = entriesRef.current.find((x) => x.path === saved.path);
    const sec = sections().find((s) => s.key === e?.key);
    const body = e ? bodies.current.get(e.key) : undefined;
    if (!e || !sec || !body) return;
    const m = measure(e.key);
    const line = lineForPosition(saved.position, m?.tops ?? [], m?.heights ?? [], body.offsetHeight);
    sc.scrollTop = Math.max(0, sec.top + body.offsetTop + line - insetTop());
    barsShownAt.current = sc.scrollTop;
  }

  // ---------- navigation ----------

  /** Where a jump (chapter list, slider, prev/next) came from: "Back to Ch. 12 · 45%". */
  function rememberJump(): void {
    tick();
    const lp = lastPos.current;
    if (!lp) return;
    const n = current?.path === lp.path ? currentNumber : undefined;
    turnsSinceJump.current = 0;
    setJumpBack({ path: lp.path, position: lp.position, label: `Back to ${n !== undefined ? `Ch. ${n}` : 'where you were'} · ${percentLabel(lp.position.percent)}` });
  }

  function jumpBackNow(): void {
    const target = jumpBack;
    if (!target) return;
    // Swap: the place we leave becomes the new "back" (flip between two spots).
    rememberJump();
    goTo({ path: target.path, name: '' }, { position: target.position, remember: false });
  }

  function goTo(meta: Pick<ChapterMeta, 'path' | 'name' | 'locked' | 'number'>, opts: { position?: ChapterPosition; remember?: boolean } = {}): void {
    if (meta.locked) {
      showToast('This chapter is locked on the source site');
      return;
    }
    if (opts.remember !== false) rememberJump();
    if (opts.position) positions.current.set(meta.path, opts.position);
    exactRestore.current = opts.position !== undefined;
    if (props.paged) {
      saveNow();
      pagedHandle.current?.goTo(meta, opts.position);
      return;
    }
    const sc = scroller.current;
    const mounted = entriesRef.current.find((e) => e.path === meta.path && e.status === 'ready' && e.spacer === undefined);
    if (mounted && sc) {
      const sec = sections().find((s) => s.key === mounted.key);
      const body = bodies.current.get(mounted.key);
      const m = measure(mounted.key);
      if (sec && opts.position && body && m) {
        const line = lineForPosition(opts.position, m.tops, m.heights, body.offsetHeight);
        sc.scrollTop = Math.max(0, sec.top + body.offsetTop + line - insetTop());
        return;
      }
      if (sec) {
        sc.scrollTop = sec.top;
        return;
      }
    }
    tick();
    saver.flush();
    const key = keySeq.current++;
    pendingPrepend.current = null;
    fetchingNext.current = null;
    restoreFor.current = key;
    currentKeyRef.current = key;
    lastPos.current = null;
    setCurrentKey(key);
    setPrevEdge({ status: 'idle' });
    setEntries([{ key, path: meta.path, name: meta.name, ...(meta.number !== undefined ? { number: meta.number } : {}), status: 'loading', eager: true }]);
    if (sc) sc.scrollTop = 0;
    updateProgressUi(0);
    void loadEntry(key, meta.path, true);
  }

  // ---------- taps ----------

  function showBars(v: boolean): void {
    barsShownAt.current = scroller.current?.scrollTop ?? 0;
    setBarsVisible(v);
  }

  /** Double tap: show the info pill for ~3 s (or hide it right away if it's showing). */
  function togglePill(): void {
    window.clearTimeout(pillTimer.current);
    setPillShown((shown) => {
      if (shown) return false;
      pillTimer.current = window.setTimeout(() => setPillShown(false), 3000);
      return true;
    });
  }

  function flashAutoHint(): void {
    window.clearTimeout(autoHintTimer.current);
    setAutoHint(true);
    autoHintTimer.current = window.setTimeout(() => setAutoHint(false), 2000);
  }

  /** Smooth page turn; quick repeated turns add up (each continues from the previous target). */
  function turnPage(dir: 1 | -1): void {
    const sc = scroller.current;
    if (!sc) return;
    const page = sc.clientHeight - rsRef.current.fontSize * rsRef.current.lineHeight * 2;
    const now = performance.now();
    const prev = pageTarget.current;
    const base = prev && now < prev.until ? prev.top : sc.scrollTop;
    const top = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, base + dir * page));
    pageTarget.current = { top, until: now + 450 };
    sc.scrollTo({ top, behavior: 'smooth' });
  }

  /** -1 / 1 for the left / right page-turn zones (bars hidden, tap zones on), else 0. */
  function edgeZone(clientX: number): -1 | 0 | 1 {
    const sc = scroller.current;
    if (!sc || !rsRef.current.tapZones || barsRef.current) return 0;
    const r = sc.getBoundingClientRect();
    const x = (clientX - r.left) / Math.max(1, r.width);
    return x < 0.28 ? -1 : x > 0.72 ? 1 : 0;
  }

  /**
   * Edge zones turn the page at once (two quick taps = two pages). In the middle, a single tap waits
   * ~250 ms so a second tap can make it a double tap (info pill); otherwise it toggles the bars.
   */
  function onTap(e: MouseEvent): void {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('button, a, input')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (findOpenRef.current) return; // finding: taps don't toggle anything
    // Auto-scroll: a tap anywhere pauses (bars with speed controls show) or resumes. On the phone the
    // tap's own touchstart has already paused it, so that click must keep it paused, not resume.
    const autoMode = auto.current();
    if (autoMode !== 'off') {
      window.clearTimeout(tapTimer.current);
      tapTimer.current = 0;
      if (autoMode === 'running' || auto.consumeTakeOver()) {
        auto.pause();
        showBars(true);
      } else {
        showBars(false);
        auto.resume();
        flashAutoHint();
      }
      return;
    }
    const zone = edgeZone(e.clientX);
    if (zone !== 0) {
      window.clearTimeout(tapTimer.current);
      tapTimer.current = 0;
      turnPage(zone);
      return;
    }
    centerTap();
  }

  /** Middle of the page: waits ~250 ms for a possible second tap (info pill), else toggles the bars. */
  function centerTap(): void {
    if (tapTimer.current) {
      window.clearTimeout(tapTimer.current);
      tapTimer.current = 0;
      if (infoPillMode(rsRef.current.showFooter) === 'doubletap') togglePill();
      return;
    }
    tapTimer.current = window.setTimeout(() => {
      tapTimer.current = 0;
      showBars(!barsRef.current);
    }, 250);
  }

  /** Paged mode taps: edges turn the page (when the bars are hidden), the middle works as above. */
  function pagedTap(_e: MouseEvent, zone: -1 | 0 | 1): boolean {
    if (findOpenRef.current) return true;
    if (zone !== 0 && rsRef.current.tapZones && !barsRef.current) {
      window.clearTimeout(tapTimer.current);
      tapTimer.current = 0;
      return false; // PagedReader turns the page
    }
    centerTap();
    return true;
  }

  /** Paged mode: a page settled. Same saving / progress / mark-read rules as scrolling. */
  function onPagedPage(info: PageInfo): void {
    if (pagedPath.current !== info.path) {
      if (pagedPath.current !== null) {
        saver.flush();
        progressVersion.value++;
      }
      pagedPath.current = info.path;
      setPagedAt({ path: info.path, content: info.content });
    }
    lastPos.current = { path: info.path, position: info.position };
    saver.update(lastPos.current);
    updateProgressUi(info.position.percent);
    if (++turnsSinceJump.current > 4) setJumpBack(null);
    // Pages read like a book: "12 / 34" in the info pill (and the bottom bar's caption).
    if (pillPct.current) pillPct.current.textContent = `${info.page + 1} / ${info.pages}`;
    noteReading(info.path, info.content, info.position.percent);
    if (info.position.percent >= rsRef.current.markReadAt && !marked.current.has(info.path)) {
      marked.current.add(info.path);
      persist(info.path, info.position, true);
    }
  }

  // ---------- render ----------

  const current: ChapterEntry | undefined = props.paged
    ? pagedAt
      ? { key: -1, path: pagedAt.path, status: 'ready', content: pagedAt.content, name: pagedAt.content.title }
      : undefined
    : (entries.find((e) => e.key === currentKey) ?? entries[0]);
  // The wrapper continues from this chapter if the reading mode is switched.
  useEffect(() => {
    if (current?.path) props.onChapterPath(current.path);
  }, [current?.path]);
  const prevMeta = current?.content?.prev;
  const nextMeta = current?.content?.next;
  const bookmarkedNow = novelChapters?.find((c) => c.path === current?.path)?.bookmarked ?? false;
  const currentTitle = current?.content?.title ?? current?.name ?? '';
  currentTitleRef.current = currentTitle;
  const currentNumber = current?.number ?? firstNumber(currentTitle);
  const first = entries[0];
  const firstPrev = first?.status === 'ready' ? first.content?.prev : undefined;
  const last = entries[entries.length - 1];
  const caughtUp = last?.status === 'ready' && last.content !== undefined && !last.content.next;

  async function toggleBookmark(): Promise<void> {
    if (!current) return;
    const on = !bookmarkedNow;
    setNovelChapters((cs) => cs?.map((c) => (c.path === current.path ? { ...c, bookmarked: on } : c)) ?? cs);
    noteBookmark(pageKey, current.path, on);
    showToast(on ? 'Bookmarked' : 'Bookmark removed');
    await bridge()
      .call('progress.bookmark', { pluginId: props.pluginId, novelPath: props.novelPath, chapterPath: current.path, bookmarked: on })
      .catch(() => undefined);
    progressVersion.value++;
  }

  // Justify only where lines are long enough not to open gaps (large text on a phone stays ragged).
  const justified = rs.justify && justifyFits(rs, viewportW);
  const style = {
    '--rd-font': fontFamily(rs.font),
    '--rd-size': `${rs.fontSize}px`,
    '--rd-lh': String(rs.lineHeight),
    '--rd-ps': `${rs.paragraphSpacing}em`,
    '--rd-margin': `${rs.margin}px`,
    '--rd-align': justified ? 'justify' : 'start',
    '--rd-indent': rs.indent ? '1.6em' : '0',
  };

  const battery = device ? `${Math.round(device.batteryLevel * 100)}%` : '';
  const openSourceSite = (): void => openInSafari(novelUrl ?? source?.site);

  return (
    <div
      class={`reader theme-${rs.theme}${barsVisible || findOpen ? ' bars-visible' : ''}${findOpen ? ' is-finding' : ''}${justified ? ' is-justify' : ''}${hyphenates(rs.justify) ? ' is-hyphenated' : ''}`}
      style={style}
      ref={root}
      lang={langCode(source ? languageName(source.lang) : undefined)}
      data-testid="screen-reader"
    >
      <div class="rd-inset-probe" ref={insetProbe} />
      {props.paged ? (
        <PagedReader
          handle={pagedHandle}
          startPath={props.chapterPath}
          fetch={fetchChapter}
          positionFor={(path) => positions.current.get(path)}
          onPage={onPagedPage}
          onTap={pagedTap}
          layoutKey={typo}
          sourceName={source?.name ?? 'the source site'}
          onOpenSafari={openSourceSite}
          onSolve={(again) => void solveChallengeThen(props.pluginId, again)()}
          pluginId={props.pluginId}
          finishedAt={rs.markReadAt}
        />
      ) : (
      <div
        class="scroll reader-scroll"
        ref={scroller}
        onClick={onTap}
        onMouseDown={(e) => {
          if (e.detail > 1) e.preventDefault(); // double tap/click must not select a word
        }}
        data-testid="reader-scroll"
      >
        <div class="reader-content" ref={content}>
          {firstPrev && (
            <div class="rd-edge" data-testid="reader-top-edge">
              {!rs.continuous ? (
                <button type="button" class="rd-link tap tap-dim" onClick={() => goTo(firstPrev)}>
                  Previous: {splitChapterTitle(firstPrev.name, firstPrev.number).title}
                </button>
              ) : prevEdge.status === 'locked' ? (
                <span class="rd-edge-note">
                  <Icon name="lock.fill" size={14} /> {firstPrev.name} is locked
                </span>
              ) : prevEdge.status === 'error' ? (
                <span class="rd-edge-note">
                  Couldn’t load the previous chapter{prevEdge.error ? ` — ${errorText(prevEdge.error)}` : ''}.{' '}
                  <button
                    type="button"
                    class="rd-link tap tap-dim"
                    onClick={() => {
                      setPrevEdge({ status: 'idle' });
                      window.setTimeout(ensurePrev, 0);
                    }}
                  >
                    Retry
                  </button>
                </span>
              ) : (
                <Spinner size={18} />
              )}
            </div>
          )}
          {entries.map((e, i) => (
            <ChapterSection
              key={e.key}
              entry={e}
              boundary={i > 0}
              pluginId={props.pluginId}
              sourceName={source?.name ?? 'the source site'}
              onBodyReady={onBodyReady}
              onBodyGone={onBodyGone}
              onRetry={retry}
              onSolve={(key) => void solveChallengeThen(props.pluginId, () => retry(key))()}
              onOpenSafari={openSourceSite}
            />
          ))}
          {last?.status === 'ready' && last.content?.next && !rs.continuous && (
            <div class="rd-edge is-bottom">
              <button type="button" class="rd-link tap tap-dim" onClick={() => last.content?.next && goTo(last.content.next)} data-testid="reader-next-link">
                Next: {splitChapterTitle(last.content.next.name, last.content.next.number).title}
              </button>
            </div>
          )}
          {caughtUp && (
            <div class="rd-end-note" data-testid="reader-caught-up">
              <p>You’re all caught up</p>
              <button type="button" class="rd-link tap tap-dim" disabled={checkingNew} onClick={() => void checkForNew()} data-testid="reader-check-new">
                {checkingNew ? 'Checking…' : 'Check for new chapters'}
              </button>
            </div>
          )}
        </div>
      </div>
      )}

      <header class="rd-top" aria-hidden={!barsVisible && !findOpen}>
        {findOpen ? (
          <FindBar scroller={scroller} chapterKey={findKey} onClose={() => setFindOpen(false)} />
        ) : (
          <>
            <button type="button" class="rd-icon-btn tap tap-dim" onClick={pop} aria-label="Back" data-testid="reader-back">
              <Icon name="chevron.left" size={22} />
            </button>
            {/* Tapping the titles opens the chapter list (like a book's table of contents). */}
            <button type="button" class="rd-top-titles tap tap-dim" onClick={openList} aria-label="Chapters" data-testid="reader-titles">
              <span class="rd-top-novel ellipsis">{novelName}</span>
              <span class="rd-top-chapter ellipsis" key={currentKey} data-testid="reader-chapter-title">
                {currentTitle}
              </span>
            </button>
            {!props.paged && (
            <button
              type="button"
              class="rd-icon-btn tap tap-dim"
              onClick={() => {
                primeKeyboard(); // iOS: the keyboard only opens from inside the tap
                auto.stop();
                setFindKey(currentKeyRef.current); // the chapter on screen now is the one searched
                setFindOpen(true);
              }}
              aria-label="Find in chapter"
              data-testid="reader-find-btn"
            >
              <Icon name="magnifyingglass" size={19} />
            </button>
            )}
            <button
              type="button"
              class={`rd-icon-btn tap tap-dim${bookmarkedNow ? ' is-on' : ''}`}
              onClick={() => void toggleBookmark()}
              aria-label={bookmarkedNow ? 'Remove bookmark' : 'Bookmark chapter'}
              aria-pressed={bookmarkedNow}
            >
              <Icon name={bookmarkedNow ? 'bookmark.fill' : 'bookmark'} size={20} />
            </button>
          </>
        )}
      </header>

      <footer class="rd-bottom" aria-hidden={!barsVisible}>
        {auto.mode !== 'off' && (
          <div class="rd-auto-row" data-testid="reader-autoscroll-controls">
            <button
              type="button"
              class="rd-icon-btn tap tap-dim"
              aria-label="Slower"
              disabled={rs.autoScrollSpeed <= AUTO_SCROLL_LIMITS.min}
              onClick={() => setReader({ autoScrollSpeed: clampSpeed(rs.autoScrollSpeed - AUTO_SCROLL_LIMITS.step) }, 400)}
              data-testid="reader-autoscroll-slower"
            >
              <Icon name="minus" size={18} />
            </button>
            <span class="rd-auto-speed tabular" data-testid="reader-autoscroll-speed">
              Speed {rs.autoScrollSpeed}
            </span>
            <button
              type="button"
              class="rd-icon-btn tap tap-dim"
              aria-label="Faster"
              disabled={rs.autoScrollSpeed >= AUTO_SCROLL_LIMITS.max}
              onClick={() => setReader({ autoScrollSpeed: clampSpeed(rs.autoScrollSpeed + AUTO_SCROLL_LIMITS.step) }, 400)}
              data-testid="reader-autoscroll-faster"
            >
              <Icon name="plus" size={18} />
            </button>
            <button
              type="button"
              class="rd-auto-play tap tap-dim"
              onClick={() => {
                if (auto.mode === 'running') auto.pause();
                else {
                  showBars(false);
                  auto.resume();
                  flashAutoHint();
                }
              }}
              aria-label={auto.mode === 'running' ? 'Pause auto-scroll' : 'Resume auto-scroll'}
              data-testid="reader-autoscroll-toggle"
            >
              <Icon name={auto.mode === 'running' ? 'pause.fill' : 'play.fill'} size={16} />
            </button>
          </div>
        )}
        {jumpBack && (
          <div class="rd-jump-row">
            <button type="button" class="rd-jump-back tap tap-dim" onClick={jumpBackNow} data-testid="reader-jump-back">
              <Icon name="arrow.uturn.backward" size={14} />
              {jumpBack.label}
            </button>
          </div>
        )}
        <div class="rd-progress-caption tabular" ref={barCaption} data-testid="reader-progress-caption" />
        <div class="rd-progress-row">
          <button type="button" class="rd-icon-btn tap tap-dim" disabled={!prevMeta} onClick={() => prevMeta && goTo(prevMeta)} aria-label="Previous chapter" data-testid="reader-prev">
            <Icon name="backward.end.fill" size={20} />
          </button>
          <input
            ref={slider}
            type="range"
            class="slider rd-slider"
            min={0}
            max={1000}
            step={1}
            defaultValue="0"
            aria-label="Position in chapter"
            data-testid="reader-slider"
            onPointerDown={() => {
              draggingSlider.current = true;
              rememberJump();
            }}
            onPointerUp={() => {
              draggingSlider.current = false;
            }}
            onChange={() => {
              draggingSlider.current = false;
            }}
            onInput={(e) => {
              const sc = scroller.current;
              const v = Number(e.currentTarget.value) / 1000;
              e.currentTarget.style.setProperty('--pct', `${v * 100}%`);
              if (props.paged) {
                pagedHandle.current?.seek(v);
                return;
              }
              const sec = sections().find((s) => s.key === currentKeyRef.current);
              if (sc && sec) sc.scrollTop = scrollTopForPercent(v, sec.top, sec.height, sc.clientHeight);
            }}
          />
          <button type="button" class="rd-icon-btn tap tap-dim" disabled={!nextMeta || nextMeta.locked} onClick={() => nextMeta && goTo(nextMeta)} aria-label="Next chapter" data-testid="reader-next">
            <Icon name="forward.end.fill" size={20} />
          </button>
        </div>
        <div class="rd-tools">
          <button type="button" class="rd-tool tap tap-dim" onClick={openList} data-testid="reader-chapters">
            <Icon name="list.bullet" size={22} />
            <span>Chapters</span>
          </button>
          {!props.paged && (
          <button
            type="button"
            class={`rd-tool tap tap-dim${auto.mode !== 'off' ? ' is-on' : ''}`}
            onClick={() => {
              if (auto.mode === 'off') {
                showBars(false);
                auto.start();
                flashAutoHint();
              } else {
                auto.stop();
              }
            }}
            data-testid="reader-autoscroll"
          >
            <Icon name={auto.mode === 'off' ? 'arrow.down.doc' : 'stop.fill'} size={22} />
            <span>{auto.mode === 'off' ? 'Auto-scroll' : 'Stop'}</span>
          </button>
          )}
          <button
            type="button"
            class="rd-tool tap tap-dim"
            onClick={() => setReaderTheme(rs.theme === 'dark' || rs.theme === 'black' ? 'light' : 'dark')}
            data-testid="reader-night"
          >
            <Icon name={rs.theme === 'dark' || rs.theme === 'black' ? 'sun.max' : 'moon.fill'} size={22} />
            <span>{rs.theme === 'dark' || rs.theme === 'black' ? 'Day' : 'Night'}</span>
          </button>
          <button type="button" class="rd-tool tap tap-dim" onClick={() => setSettingsOpen(true)} data-testid="reader-settings-btn">
            <Icon name="textformat.size" size={22} />
            <span>Appearance</span>
          </button>
        </div>
      </footer>

      <div class={`rd-hint${autoHint && auto.mode === 'running' ? ' is-shown' : ''}`} aria-live="polite" data-testid="reader-autoscroll-hint">
        {autoHint && auto.mode === 'running' ? 'Auto-scroll · tap to pause' : ''}
      </div>
      {quote && (
        <div
          class={`rd-quote-bar${barsVisible || findOpen ? ' is-raised' : ''}`}
          // Pressing a button must not clear the selection before it's used.
          onMouseDown={(e) => e.preventDefault()}
          data-testid="reader-quote-bar"
        >
          <button type="button" class="rd-quote-btn tap tap-dim" onClick={() => void copyQuote()} data-testid="reader-quote-copy">
            <Icon name="doc.on.clipboard" size={16} />
            Copy quote
          </button>
          <button type="button" class="rd-quote-btn tap tap-dim" onClick={shareQuote} data-testid="reader-quote-share">
            <Icon name="square.and.arrow.up" size={16} />
            Share quote
          </button>
        </div>
      )}
      <div
        class={`rd-pill tabular${pillMode === 'always' || (pillMode === 'doubletap' && pillShown) ? ' is-shown' : ''}`}
        aria-hidden="true"
        hidden={pillMode === 'never'}
        data-testid="reader-pill"
      >
        {currentNumber !== undefined && <span>Ch. {currentNumber}</span>}
        <span ref={pillPct}>0%</span>
        <span ref={pillLeft} class="rd-pill-left" data-testid="reader-time-left" />
        <span>{timeOfDay(now)}</span>
        {battery && <span>{battery}</span>}
      </div>

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Appearance" detents={['medium', 'large']} dimBackdrop={false} class="reader-sheet" testId="reader-settings-sheet">
        <ReaderSettingsPanel onBrightness={applyBrightness} />
      </Sheet>
      <Sheet open={listOpen} onClose={() => setListOpen(false)} title="Chapters" detents={['medium', 'large']} testId="reader-chapter-sheet">
        <ChapterListSheetBody
          chapters={novelChapters}
          currentPath={current?.path}
          onPick={(c) => {
            setListOpen(false);
            goTo(c);
          }}
        />
      </Sheet>
    </div>
  );
}

function setReaderTheme(theme: 'light' | 'dark'): void {
  setReader({ theme }, 0);
}

function ChapterListSheetBody(props: { chapters: ChapterView[] | null; currentPath: string | undefined; onPick: (c: ChapterView) => void }) {
  const handle = useRef<VirtualListHandle>(null);
  const list = props.chapters;
  const idx = list ? list.findIndex((c) => c.path === props.currentPath) : -1;
  // Volume headers ("Book One") where the volume changes, like the novel page.
  const layout = useMemo(() => volumeLayout((list ?? []).map((c) => c.volume), 52, 30), [list]);
  useEffect(() => {
    // The sheet opens at its medium detent (top half visible): put the current chapter near the top.
    if (idx >= 0) window.setTimeout(() => handle.current?.scrollToIndex(layout.rowOfPos[idx] ?? idx, { align: 'start', inset: 52 * 2 }), 0);
  }, [list !== null]);
  if (!list) {
    return <div class="sheet-loading">Loading chapters…</div>;
  }
  return (
    <VirtualList
      count={layout.rows.length}
      rowHeight={52}
      offsets={layout.offsets}
      handle={handle}
      testId="reader-chapter-list"
      renderRow={(i) => {
        const row = layout.rows[i];
        if (row?.kind === 'volume') {
          return (
            <div class="vol-header" role="heading" aria-level={3} data-testid="volume-header">
              {row.name}
            </div>
          );
        }
        const pos = row?.pos ?? i;
        const c = list[pos];
        if (!c) return null;
        return (
          <button type="button" class={`chapter-row is-compact tap tap-row${c.read ? ' is-read' : ''}${pos === idx ? ' is-current' : ''}`} onClick={() => props.onPick(c)}>
            <span class="chapter-main">
              <span class="chapter-title ellipsis">
                {c.bookmarked && <Icon name="bookmark.fill" size={12} class="chapter-bookmark" />}
                {c.name}
              </span>
            </span>
            {!c.read && c.progress !== undefined && c.progress > 0 && pos !== idx && (
              <span class="chapter-pct tabular" data-testid="chapter-pct">
                {percentLabel(c.progress)}
              </span>
            )}
            {c.locked && <Icon name="lock.fill" size={14} class="chapter-lock" />}
          </button>
        );
      }}
    />
  );
}
