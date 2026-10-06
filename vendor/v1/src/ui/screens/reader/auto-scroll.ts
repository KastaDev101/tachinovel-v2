/**
 * Auto-scroll for the continuous reader: a rAF loop moving the scroller at `speed()` px/s with
 * sub-pixel accumulation (whole pixels only, so slow speeds stay smooth and exact). It flows across
 * chapter boundaries (the reader keeps appending chapters as the scroll position moves), pauses when
 * the reader drags or wheels, and ends by itself at the end of what can be read.
 *
 * On a touchscreen every tap starts with a touchstart, which already pauses. The click that follows the
 * same tap must not undo that (it used to resume, so taps never stopped auto-scroll on the phone):
 * `consumeTakeOver()` tells the tap handler that this tap's own touch just paused it.
 */
import type { RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

export type AutoScrollMode = 'off' | 'running' | 'paused';

export const AUTO_SCROLL_LIMITS = { min: 10, max: 200, step: 5 } as const;

/** How long the scroller may sit at its very end before auto-scroll gives up (next chapter loading…). */
const END_GRACE_MS = 2500;

/** A click this long after the touch that paused auto-scroll belongs to that same tap. */
const TAKEOVER_TAP_MS = 1500;

export interface AutoScroll {
  mode: AutoScrollMode;
  /** The mode right now (`mode` is the last rendered one; a touch may have changed it since). */
  current: () => AutoScrollMode;
  start: () => void;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  /** True once if a finger/wheel paused auto-scroll within the last moment (that tap's own touch). */
  consumeTakeOver: () => boolean;
}

export function useAutoScroll(
  scroller: RefObject<HTMLDivElement | null>,
  speed: () => number,
  onEnd: () => void,
  onTakeOver?: () => void,
): AutoScroll {
  const [mode, setMode] = useState<AutoScrollMode>('off');
  const modeRef = useRef<AutoScrollMode>('off');
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  const takeOverRef = useRef(onTakeOver);
  takeOverRef.current = onTakeOver;
  const takeOverAt = useRef(0);

  const set = (m: AutoScrollMode): void => {
    modeRef.current = m;
    setMode(m);
  };

  // The loop runs only while 'running'.
  useEffect(() => {
    if (mode !== 'running') return;
    const sc = scroller.current;
    if (!sc) return;
    let raf = 0;
    let last = 0;
    let acc = 0;
    let atEndSince = 0;
    const frame = (t: number): void => {
      if (modeRef.current !== 'running') return;
      const dt = last ? Math.min(64, t - last) : 0;
      last = t;
      acc += (speedRef.current() * dt) / 1000;
      const step = Math.floor(acc);
      if (step >= 1) {
        acc -= step;
        sc.scrollTop += step;
      }
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1) {
        atEndSince ||= t;
        if (t - atEndSince > END_GRACE_MS) {
          set('off');
          endRef.current();
          return;
        }
      } else {
        atEndSince = 0;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // The reader taking over (finger or wheel) pauses it.
    const takeOver = (): void => {
      if (modeRef.current !== 'running') return;
      takeOverAt.current = Date.now();
      set('paused');
      takeOverRef.current?.();
    };
    sc.addEventListener('touchstart', takeOver, { passive: true });
    sc.addEventListener('wheel', takeOver, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      sc.removeEventListener('touchstart', takeOver);
      sc.removeEventListener('wheel', takeOver);
    };
  }, [mode]);

  return {
    mode,
    current: () => modeRef.current,
    start: () => set('running'),
    stop: () => {
      takeOverAt.current = 0;
      set('off');
    },
    pause: () => {
      if (modeRef.current === 'running') set('paused');
    },
    resume: () => {
      takeOverAt.current = 0;
      if (modeRef.current === 'paused') set('running');
    },
    consumeTakeOver: () => {
      const recent = takeOverAt.current > 0 && Date.now() - takeOverAt.current < TAKEOVER_TAP_MS;
      takeOverAt.current = 0;
      return recent;
    },
  };
}

export function clampSpeed(v: number): number {
  return Math.max(AUTO_SCROLL_LIMITS.min, Math.min(AUTO_SCROLL_LIMITS.max, Math.round(v)));
}
