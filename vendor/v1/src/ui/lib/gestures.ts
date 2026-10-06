/**
 * Touch feel: pressed states (instant feedback without waiting for :active quirks), long-press,
 * haptics (the iOS 18 `<input switch>` label trick — verified at CP2), velocity tracking.
 */

const CAPTURE_PASSIVE: AddEventListenerOptions = { capture: true, passive: true };

/** Adds `.is-pressed` to the nearest `.tap` ancestor on pointerdown; clears on move/cancel/scroll. */
export function installPressManager(): void {
  let el: Element | null = null;
  let timer = 0;
  let sx = 0;
  let sy = 0;

  const clear = (): void => {
    window.clearTimeout(timer);
    el?.classList.remove('is-pressed');
    el = null;
  };

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const target = e.target instanceof Element ? e.target.closest('.tap') : null;
      clear();
      if (!target || target.matches('[disabled],[aria-disabled="true"]')) return;
      el = target;
      sx = e.clientX;
      sy = e.clientY;
      // Rows inside scrollers get a tiny delay so a scroll start doesn't flash them (still < 50 ms).
      if (target.classList.contains('tap-row')) {
        timer = window.setTimeout(() => el?.classList.add('is-pressed'), 40);
      } else {
        target.classList.add('is-pressed');
      }
    },
    CAPTURE_PASSIVE,
  );
  document.addEventListener(
    'pointermove',
    (e) => {
      if (el && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 10) clear();
    },
    CAPTURE_PASSIVE,
  );
  document.addEventListener(
    'pointerup',
    () => {
      const cur = el;
      el = null;
      window.clearTimeout(timer);
      if (!cur) return;
      cur.classList.add('is-pressed');
      requestAnimationFrame(() => requestAnimationFrame(() => cur.classList.remove('is-pressed')));
    },
    CAPTURE_PASSIVE,
  );
  document.addEventListener('pointercancel', clear, CAPTURE_PASSIVE);
  document.addEventListener('scroll', clear, CAPTURE_PASSIVE);
  // iOS only applies :active styles when a touchstart listener exists.
  document.addEventListener('touchstart', () => undefined, { passive: true });
  // No callouts/context menus on app chrome (reader text keeps its own selection menu).
  document.addEventListener('contextmenu', (e) => {
    if (!(e.target instanceof Element && e.target.closest('.selectable'))) e.preventDefault();
  });
}

let hapticLabel: HTMLLabelElement | null = null;

/** Light haptic tick on iOS 18+ (clicking a label of a switch input). No-op elsewhere. */
export function haptic(): void {
  try {
    if (!hapticLabel) {
      hapticLabel = document.createElement('label');
      hapticLabel.className = 'sr-only';
      hapticLabel.setAttribute('aria-hidden', 'true');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.tabIndex = -1;
      hapticLabel.append(input);
      document.body.append(hapticLabel);
    }
    hapticLabel.click();
  } catch {
    // ignore
  }
}

/**
 * Delegated long-press on elements matching `selector` inside `root`. Fires after `ms` without
 * moving; the click that follows is swallowed.
 */
export function attachLongPress(root: HTMLElement, selector: string, onLongPress: (el: HTMLElement) => void, ms = 450): () => void {
  let timer = 0;
  let target: HTMLElement | null = null;
  let fired = false;
  let sx = 0;
  let sy = 0;

  const cancel = (): void => {
    window.clearTimeout(timer);
    target = null;
  };
  const down = (e: PointerEvent): void => {
    // A new press anywhere in the container ends the "swallow the click after a long-press" state:
    // a native action sheet may have absorbed the release (and its click) of the long-press.
    fired = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>(selector) : null;
    if (!t || !root.contains(t)) return;
    target = t;
    sx = e.clientX;
    sy = e.clientY;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!target) return;
      fired = true;
      haptic();
      target.classList.remove('is-pressed');
      onLongPress(target);
      target = null;
    }, ms);
  };
  const move = (e: PointerEvent): void => {
    if (target && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 10) cancel();
  };
  const click = (e: MouseEvent): void => {
    if (fired) {
      fired = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const touch = (): void => {
    fired = false;
  };
  root.addEventListener('pointerdown', down, { passive: true });
  root.addEventListener('touchstart', touch, { passive: true });
  root.addEventListener('pointermove', move, { passive: true });
  root.addEventListener('pointerup', cancel, { passive: true });
  root.addEventListener('pointercancel', cancel, { passive: true });
  root.addEventListener('scroll', cancel, { passive: true, capture: true });
  root.addEventListener('click', click, true);
  return () => {
    cancel();
    root.removeEventListener('pointerdown', down);
    root.removeEventListener('touchstart', touch);
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerup', cancel);
    root.removeEventListener('pointercancel', cancel);
    root.removeEventListener('scroll', cancel, true);
    root.removeEventListener('click', click, true);
  };
}

/** Tracks recent pointer samples to estimate release velocity (px/ms). */
export class VelocityTracker {
  private samples: { t: number; v: number }[] = [];

  add(value: number, t = performance.now()): void {
    this.samples.push({ t, v: value });
    while (this.samples.length > 2 && t - (this.samples[0]?.t ?? t) > 100) this.samples.shift();
  }

  velocity(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.t - first.t < 1) return 0;
    return (last.v - first.v) / (last.t - first.t);
  }

  reset(): void {
    this.samples = [];
  }
}
