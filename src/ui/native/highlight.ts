/**
 * Sentence highlighting in the v1 reader while narration plays: the spoken sentence is a DOM Range painted with the CSS
 * Custom Highlight API (no DOM mutation, so v1's reader and its position math are untouched); without that API, the
 * paragraph gets a class instead. The range comes from the script's canonical ranges (narration-overlay.ts); a chapter's
 * audio file reports the sentences it was rendered from, so it highlights the same way.
 */
interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

const HIGHLIGHT = 'tn-spoken';

function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const H = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return css?.highlights && H ? css.highlights : null;
}

let paragraphEl: Element | null = null;

export function clearPaint(): void {
  registry()?.delete(HIGHLIGHT);
  paragraphEl?.classList.remove('tn-speaking');
  paragraphEl = null;
}

export const HIGHLIGHT_CSS = `::highlight(${HIGHLIGHT}){background-color:rgba(168,180,255,.32);color:inherit}`;

/** Paint a DOM range (speech: the sentence being spoken); without the Highlight API, the paragraph. */
export function paintRange(range: Range | null, fallback: Element | null): Element | null {
  clearPaint();
  const reg = registry();
  const H = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (range && reg && H) {
    reg.set(HIGHLIGHT, new H(range));
    return range.startContainer.parentElement;
  }
  if (fallback) {
    paragraphEl = fallback;
    paragraphEl.classList.add('tn-speaking');
  }
  return fallback;
}
