/**
 * One chapter in the reader's infinite scroll. Novels carry their own chapter titles, so the boundary
 * between chapters is only a thin centered hairline; the source's title line stays in the text. When
 * a chapter has no title-like first line, its name is inserted as one plain bold paragraph.
 * Far chapters become "spacers" (an empty block of their last height) so unmounting never moves text.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChapterContent } from '../../../shared/contracts/protocol.ts';
import type { UiError } from '../../bridge/client.ts';
import { failureView, openExtensions, SkeletonLine } from '../../components/feedback.tsx';
import { Icon } from '../../components/icon.tsx';
import { firstNumber } from '../../lib/chapters.ts';
import { isTitleEcho, splitChapterTitle } from '../../lib/chapter-title.ts';
import { scopeCustomCss } from '../../lib/custom-css.ts';
import { sanitizeChapter } from '../../lib/sanitize.ts';
import { wireChapterImages } from './chapter-images.ts';

export { splitChapterTitle };

export interface ChapterEntry {
  key: number;
  path: string;
  /** Known before the content arrives (from the chapter list / prev-next metadata). */
  name?: string;
  number?: number;
  status: 'loading' | 'ready' | 'error' | 'locked';
  content?: ChapterContent;
  error?: UiError;
  /** Unmounted (far from the reading position): kept as an empty block of this height. */
  spacer?: number;
  /** Inserted above the reading position: laid out eagerly so its height is real immediately. */
  eager?: boolean;
}

/** No readable text and no pictures (only the inserted title, if any). */
export function isEmptyChapter(body: HTMLElement): boolean {
  if (body.querySelector('img')) return false;
  let text = '';
  for (const child of Array.from(body.children)) if (!child.classList.contains('rd-inserted-title')) text += child.textContent ?? '';
  return text.trim().length === 0;
}

/**
 * A chapter that couldn't be loaded, inline in the text column. With a failure reason: its plain
 * wording and the one action that helps (Verify, Retry, Check for Updates, or none when the site is
 * gone); without one: Verify for browser checks, else Retry.
 */
export function ChapterErrorNote(props: { error: UiError | undefined; label: string; sourceName: string; onRetry: () => void; onSolve: () => void }) {
  const e = props.error;
  const view = e ? failureView(e) : null;
  const action = view ? view.action : e?.code === 'CLOUDFLARE' ? 'open-site' : 'retry';
  const text = view
    ? `Couldn’t load ${props.label}. ${view.text}`
    : action === 'open-site'
      ? `${props.sourceName} wants to check you’re a person before ${props.label}`
      : `Couldn’t load ${props.label}`;
  return (
    <p class="rd-inline-note" data-testid="reader-chapter-error" data-action={action ?? 'none'}>
      {text}
      {action !== null && ' — '}
      {action === 'open-site' && (
        <button type="button" class="rd-link tap tap-dim" onClick={props.onSolve} data-testid="reader-verify">
          Verify
        </button>
      )}
      {action === 'retry' && (
        <button type="button" class="rd-link tap tap-dim" onClick={props.onRetry} data-testid="reader-retry">
          Retry
        </button>
      )}
      {action === 'update' && (
        <button type="button" class="rd-link tap tap-dim" onClick={openExtensions} data-testid="reader-check-updates">
          Check for Updates
        </button>
      )}
    </p>
  );
}

export function EmptyChapterNote(props: { sourceName: string; onOpenSafari: () => void }) {
  return (
    <p class="rd-inline-note" data-testid="reader-empty-chapter">
      {props.sourceName} sent this chapter without any text. It may be an image-only chapter or a page that needs the website —{' '}
      <button type="button" class="rd-link tap tap-dim" onClick={props.onOpenSafari}>
        Open in Safari
      </button>
    </p>
  );
}

/** Chapter text has a title-like first line (kept as is); otherwise insert the name in bold. */
export function ensureTitleLine(frag: DocumentFragment, title: string, number?: number): void {
  if (!title) return;
  const first = frag.firstElementChild;
  if (first && isTitleEcho(first.textContent ?? '', title, number)) return;
  const p = document.createElement('p');
  p.className = 'rd-inserted-title';
  const b = document.createElement('strong');
  b.textContent = title;
  p.append(b);
  frag.prepend(p);
}

function ChapterBody(props: {
  entry: ChapterEntry;
  pluginId: string;
  sourceName: string;
  onOpenSafari: () => void;
  onBodyReady: (key: number, body: HTMLElement) => void;
  onBodyGone: (key: number) => void;
}) {
  const { entry } = props;
  const body = useRef<HTMLDivElement>(null);
  /** The source sent no text (and no pictures): say so instead of a blank page. */
  const [empty, setEmpty] = useState(false);
  const ready = useRef(props.onBodyReady);
  ready.current = props.onBodyReady;
  const gone = useRef(props.onBodyGone);
  gone.current = props.onBodyGone;

  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !entry.content) return;
    const frag = sanitizeChapter(entry.content.html);
    ensureTitleLine(frag, entry.content.title || entry.name || '', entry.number);
    el.replaceChildren(frag);
    setEmpty(isEmptyChapter(el));
    ready.current(entry.key, el);
    // Illustrations: direct, or through the script when the site blocks them (near the screen only).
    return wireChapterImages(el, props.pluginId, { root: el.closest('.reader-scroll'), margin: '800px 0px' });
  }, [entry.content]);

  useLayoutEffect(() => () => gone.current(entry.key), []);

  // Plugin CSS, sanitized and scoped to this chapter's body only.
  const css = useMemo(() => scopeCustomCss(entry.content?.customCSS, `.rd-chapter[data-key="${entry.key}"] .rd-body`), [entry.content]);
  return (
    <>
      {css && <style>{css}</style>}
      <div class="rd-body selectable" ref={body} data-testid="reader-body" />
      {empty && <EmptyChapterNote sourceName={props.sourceName} onOpenSafari={props.onOpenSafari} />}
    </>
  );
}

export function ChapterSection(props: {
  entry: ChapterEntry;
  pluginId: string;
  /** Not the first chapter in the column: draw the hairline boundary above it. */
  boundary: boolean;
  sourceName: string;
  onBodyReady: (key: number, body: HTMLElement) => void;
  onBodyGone: (key: number) => void;
  onRetry: (key: number) => void;
  /** Cloudflare check: open the site, then retry. */
  onSolve: (key: number) => void;
  onOpenSafari: () => void;
}) {
  const { entry } = props;
  if (entry.spacer !== undefined) {
    return <section class="rd-chapter is-spacer" data-key={entry.key} data-path={entry.path} style={{ height: `${entry.spacer}px` }} data-testid="reader-spacer" />;
  }
  const n = entry.number ?? firstNumber(entry.content?.title ?? entry.name ?? '');
  const label = n !== undefined ? `chapter ${n}` : 'this chapter';
  return (
    <section
      class={`rd-chapter${entry.eager ? ' is-eager' : ''}${props.boundary ? ' has-boundary' : ''}`}
      data-key={entry.key}
      data-path={entry.path}
      data-status={entry.status}
      data-testid="reader-chapter"
    >
      {props.boundary && <div class="rd-boundary" aria-hidden="true" data-testid="reader-boundary" />}
      {entry.status === 'loading' && (
        <div class="rd-skeleton" aria-busy="true" aria-label="Loading chapter">
          {Array.from({ length: 7 }, (_, i) => (
            <SkeletonLine key={i} width={i === 0 ? '46%' : i === 6 ? '58%' : i % 3 === 2 ? '92%' : '100%'} height={13} class="rd-skel-line" />
          ))}
        </div>
      )}
      {entry.status === 'error' && (
        <ChapterErrorNote
          error={entry.error}
          label={label}
          sourceName={props.sourceName}
          onRetry={() => props.onRetry(entry.key)}
          onSolve={() => props.onSolve(entry.key)}
        />
      )}
      {entry.status === 'locked' && (
        <p class="rd-inline-note rd-locked" data-testid="reader-locked">
          <Icon name="lock.fill" size={14} />
          <span>
            {label.charAt(0).toUpperCase() + label.slice(1)} is locked on {props.sourceName}.
          </span>{' '}
          <button type="button" class="rd-link tap tap-dim" onClick={props.onOpenSafari}>
            Open in Safari
          </button>
        </p>
      )}
      {entry.status === 'ready' && (
        <ChapterBody
          entry={entry}
          pluginId={props.pluginId}
          sourceName={props.sourceName}
          onOpenSafari={props.onOpenSafari}
          onBodyReady={props.onBodyReady}
          onBodyGone={props.onBodyGone}
        />
      )}
    </section>
  );
}

/** Paragraph tops/heights (relative to the body) for position math. */
export function measureBlocks(body: HTMLElement): { tops: number[]; heights: number[] } {
  const kids = body.children;
  const tops: number[] = new Array<number>(kids.length);
  const heights: number[] = new Array<number>(kids.length);
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i] as HTMLElement;
    tops[i] = el.offsetTop;
    heights[i] = el.offsetHeight;
  }
  return { tops, heights };
}
