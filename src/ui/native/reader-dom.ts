/**
 * Read-only helpers over the v1 reader's DOM (src/ui/screens/reader/*.tsx in v1):
 *   [data-testid="screen-reader"] .rd-chapter[data-path] .rd-body > *   = the chapter's paragraphs,
 * numbered exactly like v1's reading positions (ChapterPosition.paragraph).
 * Used by the narration overlay until the reader gets a first-class "Listen" control (a v1 UI change,
 * see docs/roadmap.md).
 */

export function readerRoot(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>('[data-testid="screen-reader"]');
}

export function chapterSections(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.rd-chapter[data-path]:not(.is-spacer)'));
}

export function chapterBody(root: ParentNode, chapterPath: string): HTMLElement | null {
  for (const s of chapterSections(root)) {
    if (s.dataset.path === chapterPath) return s.querySelector<HTMLElement>('.rd-body');
  }
  return null;
}

/**
 * The first chapter section not entirely above `lineY` (px from the viewport top), and its first
 * paragraph whose bottom is below that line ("listen from here" = from the first visible paragraph).
 */
export function locateReadingPoint(root: ParentNode, lineY: number, viewportHeight = Number.POSITIVE_INFINITY): { chapterPath: string; paragraph: number } | null {
  let best: { chapterPath: string; paragraph: number } | null = null;
  for (const s of chapterSections(root)) {
    const r = s.getBoundingClientRect();
    if (r.bottom <= lineY || r.top >= viewportHeight) continue;
    const body = s.querySelector<HTMLElement>('.rd-body');
    const path = s.dataset.path;
    if (!body || !path) continue;
    const kids = Array.from(body.children);
    let paragraph = 0;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i] as Element;
      if (k.getBoundingClientRect().bottom > lineY) {
        paragraph = i;
        break;
      }
      paragraph = i;
    }
    best = { chapterPath: path, paragraph };
    break;
  }
  return best;
}

/** Paragraph texts exactly as rendered (after sanitizing + cleanup rules). */
export function paragraphsOf(body: HTMLElement): { index: number; text: string }[] {
  return Array.from(body.children).map((el, index) => ({ index, text: (el.textContent ?? '').replace(/\s+/g, ' ').trim() }));
}
