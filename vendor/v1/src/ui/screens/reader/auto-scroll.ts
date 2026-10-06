/**
 * Auto-scroll for the continuous reader: a rAF loop moving the scroller at `speed()` px/s with
 * sub-pixel accumulation (whole pixels only, so slow speeds stay smooth and exact). It flows across
 * chapter boundaries (the reader keeps appending chapters as the scroll position moves), pauses when
 * the reader drags or wheels, and ends by itself at the end of what can be read.
 */
import type { RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

export type AutoScrollMode = 'off' | 'running' | 'paused';

export const AUTO_SCROLL_LIMITS = { min: 10, max: 200, step: 5 } as const;

/** How long the scroller may sit at its very end before auto-scroll gives up (next chapter loading…). */
const END_GRACE_MS = 2500;

export interface AutoScroll {
  mode: AutoScrollMode;
  start: () => void;
  stop: () => void;
  pause: () => void;
  resume: () => void;
}

export function useAutoScroll(scroller: RefObject<HTMLDivElement | null>, speed: () => number, onEnd: () => void): AutoScroll {
  const [mode, setMode] = useState<AutoScrollMode>('off');
  const modeRef = useRef<AutoScrollMode>('off');
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const endRef = useRef(onEnd);
  endRef.current = onEnd;

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
      if (modeRef.current === 'running') set('paused');
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
    start: () => set('running'),
    stop: () => set('off'),
    pause: () => {
      if (modeRef.current === 'running') set('paused');
    },
    resume: () => {
      if (modeRef.current === 'paused') set('running');
    },
  };
}

export function clampSpeed(v: number): number {
  return Math.max(AUTO_SCROLL_LIMITS.min, Math.min(AUTO_SCROLL_LIMITS.max, Math.round(v)));
}
