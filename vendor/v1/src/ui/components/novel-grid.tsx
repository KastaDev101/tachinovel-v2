/**
 * Cover-forward novel grid (comfortable / compact) and list display, with badges, a "continue
 * reading" button, long-press and selection support.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { compactCount } from '../lib/format.ts';
import { attachLongPress } from '../lib/gestures.ts';
import { Cover } from './cover.tsx';
import { Icon } from './icon.tsx';

export interface GridNovel {
  key: string;
  pluginId?: string;
  name: string;
  cover?: string | undefined;
  subtitle?: string | undefined;
}

export interface GridBadges {
  unread?: number;
  downloaded?: number;
  inLibrary?: boolean;
  /** Total chapters (browse results): a small glass pill at the cover's bottom-left. */
  chapters?: number;
}

/** Book glyph + "248" / "1.2K" / "12K+" on a dark glass pill (omitted when the count is unknown). */
export function ChapterCountBadge({ count }: { count: number | undefined }) {
  if (count === undefined || count <= 0) return null;
  return (
    <span class="badge-chapters tabular" aria-label={`${count} chapters`} data-testid="chapter-count-badge">
      <Icon name="book.closed" size={10} />
      {compactCount(count)}
    </span>
  );
}

export interface NovelGridProps<T extends GridNovel> {
  items: readonly T[];
  display: 'comfortable' | 'compact' | 'list';
  columns: number;
  onOpen: (item: T) => void;
  onLongPress?: (item: T) => void;
  onContinue?: (item: T) => void;
  canContinue?: (item: T) => boolean;
  badges?: (item: T) => GridBadges;
  selected?: ReadonlySet<string>;
  selecting?: boolean;
  testId?: string;
  footer?: ComponentChildren;
}

export function NovelGrid<T extends GridNovel>(props: NovelGridProps<T>) {
  const root = useRef<HTMLDivElement>(null);
  const itemsRef = useRef(props.items);
  itemsRef.current = props.items;
  const longRef = useRef(props.onLongPress);
  longRef.current = props.onLongPress;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    return attachLongPress(el, '[data-key]', (target) => {
      const key = target.dataset['key'];
      const item = itemsRef.current.find((i) => i.key === key);
      if (item) longRef.current?.(item);
    });
  }, []);

  const list = props.display === 'list';
  return (
    <div
      ref={root}
      class={`novel-grid is-${props.display}${props.selecting ? ' is-selecting' : ''}`}
      style={{ '--cols': String(props.columns) }}
      data-testid={props.testId}
    >
      {props.items.map((item) => {
        const b = props.badges?.(item) ?? {};
        const sel = props.selected?.has(item.key) ?? false;
        const showContinue = !props.selecting && props.onContinue !== undefined && (props.canContinue?.(item) ?? true);
        return (
          <div class={`grid-item${sel ? ' is-selected' : ''}${b.inLibrary ? ' is-in-library' : ''}`} key={item.key}>
            <button
              type="button"
              class={`grid-hit tap ${list ? 'tap-row' : 'tap-scale'}`}
              data-key={item.key}
              aria-label={item.name}
              aria-pressed={props.selecting ? sel : undefined}
              onClick={() => props.onOpen(item)}
            >
              <span class="grid-cover-wrap">
                <Cover src={item.cover} pluginId={item.pluginId} title={item.name} />
                {(b.unread !== undefined && b.unread > 0) || (b.downloaded !== undefined && b.downloaded > 0) || b.inLibrary ? (
                  <span class="badges">
                    {b.unread !== undefined && b.unread > 0 && <span class="badge badge-unread tabular">{b.unread > 999 ? '999+' : b.unread}</span>}
                    {b.downloaded !== undefined && b.downloaded > 0 && <span class="badge badge-downloaded tabular">{b.downloaded}</span>}
                    {b.inLibrary && <span class="badge badge-library">In library</span>}
                  </span>
                ) : null}
                {props.display === 'compact' && !list ? (
                  <span class="grid-compact-title">
                    <ChapterCountBadge count={b.chapters} />
                    <span class="clamp-2">{item.name}</span>
                  </span>
                ) : (
                  !list && <ChapterCountBadge count={b.chapters} />
                )}
                {props.selecting && (
                  <span class={`select-mark${sel ? ' is-on' : ''}`}>
                    <Icon name={sel ? 'checkmark.circle.fill' : 'circle'} size={24} />
                  </span>
                )}
              </span>
              {props.display !== 'compact' && (
                <span class="grid-text">
                  <span class={`grid-title ${list ? 'ellipsis' : 'clamp-2'}`}>{item.name}</span>
                  {item.subtitle && <span class="grid-subtitle ellipsis">{item.subtitle}</span>}
                </span>
              )}
              {list && b.unread !== undefined && b.unread > 0 && <span class="list-unread tabular">{b.unread}</span>}
            </button>
            {showContinue && (
              <span class="grid-overlay">
                <button
                  type="button"
                  class="continue-btn tap tap-scale"
                  aria-label={`Continue reading ${item.name}`}
                  data-testid="continue-reading"
                  onClick={() => props.onContinue?.(item)}
                >
                  <Icon name="play.fill" size={12} />
                </button>
              </span>
            )}
          </div>
        );
      })}
      {props.footer}
    </div>
  );
}
