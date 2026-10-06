/**
 * Screen scaffold: translucent navigation bar, iOS large title that collapses into the bar on
 * scroll, per-screen native scroll container, optional pull-to-refresh driven by the native bounce
 * (no scroll hijacking: the pull distance is read from the negative scrollTop iOS reports).
 */
import { createContext, type ComponentChildren, type RefObject } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { haptic } from '../lib/gestures.ts';
import { pop, tabReselect, type TabName } from '../state/nav.ts';
import { Spinner } from './controls.tsx';
import { Icon } from './icon.tsx';

export const ScrollContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function useScroller(): RefObject<HTMLDivElement | null> {
  const ref = useContext(ScrollContext);
  if (!ref) throw new Error('useScroller outside a Screen');
  return ref;
}

export interface ScreenProps {
  title: string;
  /** Root (tab) screen: centered title, no back button. */
  large?: boolean;
  /** Back button; a string is shown as its label. */
  back?: boolean | string;
  left?: ComponentChildren;
  right?: ComponentChildren;
  /** Sticky content under the bar (segmented controls, search). */
  accessory?: ComponentChildren;
  /** Rendered under the large title inside the scroll content (e.g. search field). */
  header?: ComponentChildren;
  children: ComponentChildren;
  /** Bar stays transparent (no title) until scrolled past this many px. */
  transparentUntil?: number;
  onRefresh?: () => Promise<void>;
  /** Scroll to top when this tab is re-selected in the tab bar. */
  tab?: TabName;
  class?: string;
  scrollRef?: RefObject<HTMLDivElement | null>;
  onScroll?: (el: HTMLDivElement) => void;
  testId?: string;
  /** Hide the small centered title (e.g. when it's shown elsewhere). */
  hideBarTitle?: boolean;
  /** Content to overlay at the bottom (floating buttons, toolbars). */
  overlay?: ComponentChildren;
}

const PULL_TRIGGER = 72;

export function Screen(props: ScreenProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const scroller = props.scrollRef ?? ownRef;
  const bar = useRef<HTMLElement>(null);
  const ptr = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const accessoryRef = useRef<HTMLDivElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const onScrollRef = useRef(props.onScroll);
  onScrollRef.current = props.onScroll;
  const onRefreshRef = useRef(props.onRefresh);
  onRefreshRef.current = props.onRefresh;

  // Collapse the large title / show the bar background based on scroll position.
  useLayoutEffect(() => {
    const el = scroller.current;
    const b = bar.current;
    if (!el || !b) return;
    const threshold = props.transparentUntil ?? 1;
    let collapsed = false;
    let touching = false;
    let armed = false;

    const update = (): void => {
      const st = el.scrollTop;
      const c = st > threshold;
      if (c !== collapsed) {
        collapsed = c;
        b.classList.toggle('is-collapsed', c);
      }
      const ind = ptr.current;
      if (ind && onRefreshRef.current && !refreshingRef.current) {
        const pull = Math.max(0, -st);
        const p = Math.min(1, Math.max(0, (pull - 16) / (PULL_TRIGGER - 16)));
        ind.style.opacity = String(p);
        ind.style.transform = `translate3d(0, ${Math.min(pull, PULL_TRIGGER) * 0.25}px, 0) rotate(${pull * 2.2}deg)`;
        if (touching && pull >= PULL_TRIGGER && !armed) {
          armed = true;
          haptic();
        }
      }
      onScrollRef.current?.(el);
    };
    const touchStart = (): void => {
      touching = true;
      armed = false;
    };
    const touchEnd = (): void => {
      touching = false;
      if (armed && !refreshingRef.current) void startRefresh();
      armed = false;
    };
    el.addEventListener('scroll', update, { passive: true });
    el.addEventListener('touchstart', touchStart, { passive: true });
    el.addEventListener('touchend', touchEnd, { passive: true });
    el.addEventListener('touchcancel', touchEnd, { passive: true });
    update();
    return () => {
      el.removeEventListener('scroll', update);
      el.removeEventListener('touchstart', touchStart);
      el.removeEventListener('touchend', touchEnd);
      el.removeEventListener('touchcancel', touchEnd);
    };
  }, []);

  // Keep the scroll content clear of the (variable-height) accessory.
  useLayoutEffect(() => {
    const acc = accessoryRef.current;
    const b = bar.current;
    if (!b) return;
    const set = (): void => b.parentElement?.style.setProperty('--accessory-h', `${acc?.offsetHeight ?? 0}px`);
    set();
    if (!acc) return;
    const ro = new ResizeObserver(set);
    ro.observe(acc);
    return () => ro.disconnect();
  }, [props.accessory !== undefined]);

  // Tapping the active tab again scrolls to top.
  useEffect(() => {
    if (!props.tab) return;
    let first = true;
    return tabReselect.subscribe((v) => {
      if (first) {
        first = false;
        return;
      }
      if (v.tab === props.tab) scroller.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }, [props.tab]);

  async function startRefresh(): Promise<void> {
    const fn = onRefreshRef.current;
    if (!fn) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const ind = ptr.current;
    if (ind) {
      ind.style.opacity = '1';
      ind.style.transform = 'translate3d(0, 18px, 0)';
    }
    try {
      await fn();
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
      if (ind) {
        ind.style.opacity = '0';
        ind.style.transform = '';
      }
    }
  }

  const backLabel = typeof props.back === 'string' ? props.back : undefined;
  const leftContent =
    props.left ??
    (props.back ? (
      <button type="button" class="bar-btn bar-back tap tap-dim" onClick={pop} aria-label={backLabel ? `Back to ${backLabel}` : 'Back'} data-testid="nav-back">
        <Icon name="chevron.left" size={22} />
      </button>
    ) : null);

  return (
    <section
      class={`screen${props.large ? ' is-root' : ''}${props.accessory ? ' has-accessory' : ''}${refreshing ? ' is-refreshing' : ''} ${props.class ?? ''}`}
      data-testid={props.testId}
    >
      <header ref={bar} class={`navbar${props.large ? ' is-large' : ''}${props.transparentUntil !== undefined ? ' is-transparent' : ''}`}>
        <div class="navbar-bg" />
        <div class="navbar-row">
          <div class="navbar-side navbar-left">{leftContent}</div>
          {!props.hideBarTitle && (
            <div class="navbar-title ellipsis" role="heading" aria-level={2}>
              {props.title}
            </div>
          )}
          <div class="navbar-side navbar-right">{props.right}</div>
        </div>
        {props.accessory !== undefined && (
          <div class="navbar-accessory" ref={accessoryRef}>
            {props.accessory}
          </div>
        )}
      </header>
      {props.onRefresh && (
        <div class="ptr" ref={ptr} aria-hidden={!refreshing}>
          <Spinner size={22} class={refreshing ? 'is-spinning' : 'is-static'} />
        </div>
      )}
      <ScrollContext.Provider value={scroller}>
        <div class="scroll screen-scroll" ref={scroller}>
          <div class="scroll-content" ref={content}>
            {props.header}
            {props.children}
          </div>
        </div>
      </ScrollContext.Provider>
      {props.overlay}
    </section>
  );
}
