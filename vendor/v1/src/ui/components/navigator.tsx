/**
 * Navigation stack renderer: iOS push/pop (350 ms, iOS easing, parallax + dimming of the screen
 * underneath) and an interactive edge-swipe back that tracks the finger and settles with velocity.
 * Only transform/opacity are animated; covered screens stay mounted (state and scroll kept) but
 * hidden.
 */
import { effect, untracked } from '@preact/signals';
import { Component, createContext, type ComponentChildren, type VNode } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { VelocityTracker } from '../lib/gestures.ts';
import { activeTab, consumePendingPush, dropTop, registerAnimator, stack, topId, type Animator, type Route, type TabName } from '../state/nav.ts';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const DURATION = 350;
const PARALLAX = -30; // percent

export interface ScreenInfo {
  id: number;
}

export const ScreenContext = createContext<ScreenInfo>({ id: 0 });

/** True while this screen is the top of the stack. */
export function useIsTop(): boolean {
  const { id } = useContext(ScreenContext);
  return topId.value === id;
}

/** Runs `fn` whenever this screen becomes the top again (after being covered). */
export function useOnReveal(fn: () => void): void {
  const { id } = useContext(ScreenContext);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let wasTop = topId.peek() === id;
    return topId.subscribe((t) => {
      const isTop = t === id;
      if (isTop && !wasTop) ref.current();
      wasTop = isTop;
    });
  }, [id]);
}

/** Runs `fn` as soon as this screen stops being the top (covered or popped), before the screen underneath reacts. */
export function useOnLeave(fn: () => void): void {
  const { id } = useContext(ScreenContext);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let wasTop = topId.peek() === id;
    return topId.subscribe((t) => {
      const isTop = t === id;
      if (!isTop && wasTop) ref.current();
      wasTop = isTop;
    });
  }, [id]);
}

/**
 * Calls `reload` when `key()` (which reads signals) changes — live while `tab` is the visible tab,
 * otherwise once when it's shown again. Hidden tabs neither re-render nor refetch while you read.
 */
export function useRefreshWhenShown(tab: TabName, key: () => unknown, reload: () => void): void {
  const { id } = useContext(ScreenContext);
  const visible = activeTab.value === tab && topId.value === id;
  const keyRef = useRef(key);
  keyRef.current = key;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const seen = useRef<unknown>(undefined);
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      seen.current = untracked(() => keyRef.current());
    }
    if (!visible) return;
    return effect(() => {
      const k = keyRef.current();
      if (Object.is(k, seen.current)) return;
      seen.current = k;
      untracked(() => reloadRef.current());
    });
  }, [visible]);
}

/** Keeps an already-rendered screen from re-rendering when the stack changes. */
class Frozen extends Component<{ id: number; children: ComponentChildren }> {
  override shouldComponentUpdate(next: { id: number }): boolean {
    return next.id !== this.props.id;
  }
  render() {
    return this.props.children;
  }
}

function noAnimations(): boolean {
  return window.__TACHI_DEV__?.noAnimations === true || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function Navigator({ render }: { render: (route: Route) => VNode }) {
  const entries = stack.value;
  const layers = useRef(new Map<number, HTMLElement>());
  const running = useRef<Animation[]>([]);
  const root = useRef<HTMLDivElement>(null);

  const dimOf = (el: HTMLElement): HTMLElement | null => el.querySelector<HTMLElement>(':scope > .layer-dim');

  function settle(): void {
    for (const a of running.current) {
      try {
        a.finish();
      } catch {
        // already finished
      }
    }
    running.current = [];
  }

  async function run(anims: Animation[]): Promise<void> {
    running.current = anims;
    root.current?.classList.add('is-animating');
    try {
      await Promise.all(anims.map((a) => a.finished));
    } catch {
      // cancelled
    } finally {
      if (running.current === anims) running.current = [];
      root.current?.classList.remove('is-animating');
    }
  }

  const animator = useRef<Animator | null>(null);
  animator.current ??= {
    settle,
    async push(fromId, toId) {
      const from = layers.current.get(fromId);
      const to = layers.current.get(toId);
      if (!from || !to) return;
      from.style.transform = `translate3d(${PARALLAX}%,0,0)`;
      to.style.transform = '';
      const dim = dimOf(from);
      if (dim) dim.style.opacity = '1';
      if (noAnimations()) {
        from.classList.add('covered');
        return;
      }
      from.classList.remove('covered');
      const opts: KeyframeAnimationOptions = { duration: DURATION, easing: EASE };
      const anims = [
        to.animate([{ transform: 'translate3d(100%,0,0)' }, { transform: 'translate3d(0,0,0)' }], opts),
        from.animate([{ transform: 'translate3d(0,0,0)' }, { transform: `translate3d(${PARALLAX}%,0,0)` }], opts),
      ];
      if (dim) anims.push(dim.animate([{ opacity: 0 }, { opacity: 1 }], opts));
      await run(anims);
      if (topId.peek() === toId) from.classList.add('covered');
    },
    async pop(fromId, toId) {
      const from = layers.current.get(fromId);
      const to = layers.current.get(toId);
      if (!from || !to) return;
      to.classList.remove('covered');
      to.style.transform = '';
      from.style.transform = 'translate3d(100%,0,0)';
      const dim = dimOf(to);
      if (dim) dim.style.opacity = '0';
      if (noAnimations()) return;
      const opts: KeyframeAnimationOptions = { duration: DURATION, easing: EASE };
      const anims = [
        from.animate([{ transform: 'translate3d(0,0,0)' }, { transform: 'translate3d(100%,0,0)' }], opts),
        to.animate([{ transform: `translate3d(${PARALLAX}%,0,0)` }, { transform: 'translate3d(0,0,0)' }], opts),
      ];
      if (dim) anims.push(dim.animate([{ opacity: 1 }, { opacity: 0 }], opts));
      await run(anims);
    },
  };
  useEffect(() => {
    registerAnimator(animator.current);
    return () => registerAnimator(null);
  }, []);

  // New top layer mounted → animate it in.
  useLayoutEffect(() => {
    const p = consumePendingPush();
    if (p) void animator.current?.push(p.from, p.to);
    // Layers pushed without their own animation (e.g. a deep link pushing two screens) stay covered.
    entries.slice(0, -1).forEach((e) => {
      if (p && e.id === p.from) return;
      const el = layers.current.get(e.id);
      if (el && !el.classList.contains('covered') && running.current.length === 0) {
        el.style.transform = `translate3d(${PARALLAX}%,0,0)`;
        el.classList.add('covered');
      }
    });
    // Make sure the top layer is visible and everything else is covered (after animations).
    const ids = entries.map((e) => e.id);
    const top = ids[ids.length - 1];
    for (const [id, el] of layers.current) {
      if (!ids.includes(id)) layers.current.delete(id);
      else if (id === top) {
        el.classList.remove('covered');
      }
    }
  }, [entries]);

  // Interactive edge swipe.
  function onEdgeDown(e: PointerEvent, id: number): void {
    const s = stack.peek();
    const idx = s.findIndex((x) => x.id === id);
    const below = s[idx - 1];
    if (idx !== s.length - 1 || !below || running.current.length > 0) return;
    const top = layers.current.get(id);
    const under = layers.current.get(below.id);
    if (!top || !under) return;
    const strip = e.currentTarget as HTMLElement;
    strip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const width = root.current?.clientWidth ?? window.innerWidth;
    const vt = new VelocityTracker();
    const dim = dimOf(under);
    let dx = 0;
    let started = false;
    vt.add(0);

    const apply = (): void => {
      const p = dx / width;
      top.style.transform = `translate3d(${dx}px,0,0)`;
      under.style.transform = `translate3d(${PARALLAX * (1 - p)}%,0,0)`;
      if (dim) dim.style.opacity = String(1 - p);
    };
    const move = (ev: PointerEvent): void => {
      dx = Math.max(0, ev.clientX - startX);
      if (!started && dx > 2) {
        started = true;
        under.classList.remove('covered');
        root.current?.classList.add('is-swiping');
      }
      if (started) {
        apply();
        vt.add(dx);
      }
    };
    const up = (ev: PointerEvent): void => {
      strip.removeEventListener('pointermove', move);
      strip.removeEventListener('pointerup', up);
      strip.removeEventListener('pointercancel', up);
      root.current?.classList.remove('is-swiping');
      if (!started) return;
      const v = vt.velocity();
      const p = dx / width;
      const complete = ev.type !== 'pointercancel' && (v > 0.35 || (p > 0.5 && v > -0.2));
      const remaining = complete ? 1 - p : p;
      const duration = Math.max(140, Math.min(DURATION, remaining * 420));
      const opts: KeyframeAnimationOptions = { duration, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
      const fromTop = `translate3d(${dx}px,0,0)`;
      const fromUnder = `translate3d(${PARALLAX * (1 - p)}%,0,0)`;
      if (complete) {
        top.style.transform = 'translate3d(100%,0,0)';
        under.style.transform = '';
        if (dim) dim.style.opacity = '0';
        const anims = [
          top.animate([{ transform: fromTop }, { transform: 'translate3d(100%,0,0)' }], opts),
          under.animate([{ transform: fromUnder }, { transform: 'translate3d(0,0,0)' }], opts),
        ];
        if (dim) anims.push(dim.animate([{ opacity: 1 - p }, { opacity: 0 }], opts));
        void run(anims).then(() => dropTop());
      } else {
        top.style.transform = '';
        under.style.transform = `translate3d(${PARALLAX}%,0,0)`;
        if (dim) dim.style.opacity = '1';
        const anims = [
          top.animate([{ transform: fromTop }, { transform: 'translate3d(0,0,0)' }], opts),
          under.animate([{ transform: fromUnder }, { transform: `translate3d(${PARALLAX}%,0,0)` }], opts),
        ];
        if (dim) anims.push(dim.animate([{ opacity: 1 - p }, { opacity: 1 }], opts));
        void run(anims).then(() => {
          if (topId.peek() === id) under.classList.add('covered');
        });
      }
    };
    strip.addEventListener('pointermove', move);
    strip.addEventListener('pointerup', up);
    strip.addEventListener('pointercancel', up);
  }

  return (
    <div class="nav-root" ref={root}>
      {entries.map((e, i) => (
        <div
          key={e.id}
          class={`layer layer-${e.route.name}`}
          data-layer={e.route.name}
          ref={(el) => {
            if (el) layers.current.set(e.id, el);
          }}
        >
          <ScreenContext.Provider value={{ id: e.id }}>
            <Frozen id={e.id}>{render(e.route)}</Frozen>
          </ScreenContext.Provider>
          <div class="layer-dim" />
          {i > 0 && <div class="edge-swipe" data-testid="edge-swipe" onPointerDown={(ev) => onEdgeDown(ev, e.id)} />}
        </div>
      ))}
    </div>
  );
}
