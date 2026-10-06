/**
 * Find in chapter (reader top bar): searches the chapter being read, highlights every match
 * with the CSS Custom Highlight API (no DOM changes) or, where WebKit lacks it, <mark> wrappers that
 * are removed again on close. ↑/↓ (or Return) step through matches, the current one is centred.
 */
import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../../components/icon.tsx';
import { locateMatches } from '../../lib/find.ts';

const MAX_MATCHES = 2000;

function supportsHighlights(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';
}

function bodiesIn(scroller: HTMLElement, chapterKey: number): HTMLElement[] {
  return Array.from(scroller.querySelectorAll<HTMLElement>(`.rd-chapter[data-key="${chapterKey}"] [data-testid="reader-body"]`));
}

/** Ranges for every match in the current chapter's text, in reading order. */
function collectRanges(scroller: HTMLElement, chapterKey: number, query: string): Range[] {
  const out: Range[] = [];
  for (const body of bodiesIn(scroller, chapterKey)) {
    for (const block of Array.from(body.children)) {
      const nodes: Text[] = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
      if (nodes.length === 0) continue;
      for (const m of locateMatches(
        nodes.map((t) => t.data),
        query,
        MAX_MATCHES - out.length,
      )) {
        const r = document.createRange();
        const s = nodes[m.start[0]];
        const e = nodes[m.end[0]];
        if (!s || !e) continue;
        r.setStart(s, m.start[1]);
        r.setEnd(e, m.end[1]);
        out.push(r);
      }
      if (out.length >= MAX_MATCHES) return out;
    }
  }
  return out;
}

// ---------- painting (Highlight API, or <mark> fallback) ----------

function clearMarks(scroller: HTMLElement): void {
  const marks = scroller.querySelectorAll('mark.rd-find-mark');
  const parents = new Set<Node>();
  for (const m of Array.from(marks)) {
    const parent = m.parentNode;
    if (!parent) continue;
    parents.add(parent);
    m.replaceWith(...Array.from(m.childNodes));
  }
  for (const p of parents) p.normalize();
}

/** Wraps the text-node pieces of a range in <mark>; returns the marks (first one is scrolled to). */
function markRange(range: Range, current: boolean): HTMLElement[] {
  const pieces: { node: Text; start: number; end: number }[] = [];
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(root.nodeType === Node.TEXT_NODE ? (root.parentNode ?? root) : root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!range.intersectsNode(t)) continue;
    const start = t === range.startContainer ? range.startOffset : 0;
    const end = t === range.endContainer ? range.endOffset : t.data.length;
    if (end > start) pieces.push({ node: t, start, end });
  }
  const marks: HTMLElement[] = [];
  for (const p of pieces) {
    const mid = p.node.splitText(p.start);
    mid.splitText(p.end - p.start);
    const mark = document.createElement('mark');
    mark.className = current ? 'rd-find-mark is-current' : 'rd-find-mark';
    mid.replaceWith(mark);
    mark.append(mid);
    marks.push(mark);
  }
  return marks;
}

function paint(scroller: HTMLElement, ranges: Range[], current: number): Range | HTMLElement | null {
  if (supportsHighlights()) {
    CSS.highlights.set('rd-find', new Highlight(...ranges));
    const cur = ranges[current];
    if (cur) CSS.highlights.set('rd-find-current', new Highlight(cur));
    else CSS.highlights.delete('rd-find-current');
    return cur ?? null;
  }
  clearMarks(scroller);
  // Last to first: wrapping a later match never moves an earlier one's text nodes.
  let first: HTMLElement | null = null;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    if (!r) continue;
    const marks = markRange(r, i === current);
    if (i === current) first = marks[0] ?? null;
  }
  return first;
}

function unpaint(scroller: HTMLElement | null): void {
  if (supportsHighlights()) {
    CSS.highlights.delete('rd-find');
    CSS.highlights.delete('rd-find-current');
  } else if (scroller) {
    clearMarks(scroller);
  }
}

function centre(scroller: HTMLElement, target: Range | HTMLElement): void {
  const r = target.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  scroller.scrollTop += r.top - s.top - scroller.clientHeight * 0.35;
}

// ---------- component ----------

export function FindBar(props: {
  scroller: RefObject<HTMLDivElement | null>;
  /** The chapter being read (the one searched); find re-runs when it changes. */
  chapterKey: number;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(0);
  const ranges = useRef<Range[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const currentRef = useRef(0);
  currentRef.current = current;

  // Focus right away (the opening tap primed the iOS keyboard).
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);

  // Search (debounced while typing); start from the first match at or below the reading position.
  // When only the mounted chapters changed (same query), repaint without jumping anywhere.
  const searched = useRef('');
  useEffect(() => {
    const sc = props.scroller.current;
    if (!sc) return;
    const t = window.setTimeout(() => {
      const newQuery = searched.current !== query;
      searched.current = query;
      unpaint(sc);
      const found = query.trim() ? collectRanges(sc, props.chapterKey, query) : [];
      ranges.current = found;
      setCount(found.length);
      if (found.length === 0) {
        setCurrent(0);
        return;
      }
      const top = sc.getBoundingClientRect().top;
      let start = found.findIndex((r) => r.getBoundingClientRect().bottom > top);
      if (start < 0) start = 0;
      setCurrent(start);
      const target = paint(sc, found, start);
      if (target && newQuery) centre(sc, target);
    }, 160);
    return () => window.clearTimeout(t);
  }, [query, props.chapterKey]);

  useEffect(() => () => unpaint(props.scroller.current), []);

  function step(dir: 1 | -1): void {
    const sc = props.scroller.current;
    const n = ranges.current.length;
    if (!sc || n === 0) return;
    // Text nodes may have been re-split by <mark> painting: re-collect for the fallback path.
    if (!supportsHighlights()) {
      unpaint(sc);
      ranges.current = collectRanges(sc, props.chapterKey, query);
    }
    const next = (currentRef.current + dir + n) % n;
    setCurrent(next);
    const target = paint(sc, ranges.current, next);
    if (target) centre(sc, target);
  }

  return (
    <div class="rd-find" data-testid="reader-find">
      <form
        class="rd-find-field"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          step(1);
        }}
      >
        <Icon name="magnifyingglass" size={15} class="rd-find-icon" />
        <input
          ref={input}
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellcheck={false}
          placeholder="Find in chapter"
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
          data-testid="reader-find-input"
        />
        <span class="rd-find-count tabular" data-testid="reader-find-count">
          {query.trim() ? (count > 0 ? `${current + 1}/${count}` : '0') : ''}
        </span>
      </form>
      <button type="button" class="rd-icon-btn tap tap-dim" onClick={() => step(-1)} disabled={count === 0} aria-label="Previous match" data-testid="reader-find-prev">
        <Icon name="chevron.up" size={18} />
      </button>
      <button type="button" class="rd-icon-btn tap tap-dim" onClick={() => step(1)} disabled={count === 0} aria-label="Next match" data-testid="reader-find-next">
        <Icon name="chevron.down" size={18} />
      </button>
      <button type="button" class="rd-find-done tap tap-dim" onClick={props.onClose} data-testid="reader-find-done">
        Done
      </button>
    </div>
  );
}
