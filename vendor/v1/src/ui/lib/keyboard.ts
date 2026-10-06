/**
 * iOS shows the keyboard only for a focus() made synchronously inside a tap handler. A tap that
 * reveals a text field (search toggle, a sheet with an input) calls primeKeyboard() first: a hidden
 * input takes focus right away so the keyboard comes up, and the real field takes the focus over
 * when it mounts (moving focus between inputs keeps the keyboard up).
 */
let proxy: HTMLInputElement | null = null;
let releaseTimer = 0;

export function primeKeyboard(): void {
  if (!proxy) {
    const el = document.createElement('input');
    el.type = 'text';
    el.tabIndex = -1;
    el.setAttribute('aria-hidden', 'true');
    el.autocomplete = 'off';
    // 16px: no iOS zoom-on-focus. Fixed at the top so focusing it never scrolls anything.
    el.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;font-size:16px;pointer-events:none;';
    document.body.append(el);
    proxy = el;
  }
  proxy.focus({ preventScroll: true });
  // If no field takes over (e.g. the screen never opened), let the keyboard go again.
  window.clearTimeout(releaseTimer);
  releaseTimer = window.setTimeout(() => {
    if (proxy && document.activeElement === proxy) proxy.blur();
  }, 1500);
}
