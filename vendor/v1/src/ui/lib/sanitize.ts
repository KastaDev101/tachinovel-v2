/**
 * Chapter HTML sanitizing (DOMPurify, strict allowlist) + normalization into a flat list of block
 * elements so reading positions can be stored as paragraph indexes.
 */
import DOMPurify from 'dompurify';
import { isAllowedImageSrc, purifyConfig } from './sanitize-config.ts';

let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    const name = data.attrName.toLowerCase();
    if (name.startsWith('on')) data.keepAttr = false;
    else if (name === 'src' && !isAllowedImageSrc(data.attrValue)) data.keepAttr = false;
  });
}

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'TABLE', 'HR', 'FIGURE',
]);

function isBlank(el: Element): boolean {
  if (el.querySelector('img,hr,table')) return false;
  return (el.textContent ?? '').replace(/[\s\u00a0\u200b]+/g, '') === '';
}

/** Unwrap a lone wrapper <div>/<span> (common: <div class="chapter-content">…</div>). */
function unwrapSingleWrapper(frag: DocumentFragment): void {
  for (let depth = 0; depth < 4; depth++) {
    const elements = Array.from(frag.childNodes).filter(
      (n) => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== ''),
    );
    const only = elements[0];
    if (elements.length !== 1 || !(only instanceof Element) || (only.tagName !== 'DIV' && only.tagName !== 'SPAN')) return;
    if (!Array.from(only.children).some((c) => BLOCK_TAGS.has(c.tagName) || c.tagName === 'BR')) return;
    frag.replaceChildren(...Array.from(only.childNodes));
  }
}

/** Wrap runs of top-level inline content into <p>, splitting on double <br>. */
function wrapInlineRuns(frag: DocumentFragment): void {
  const doc = frag.ownerDocument;
  const out: Node[] = [];
  let run: Node[] = [];
  let pendingBr = 0;

  const flush = (): void => {
    // Trim leading/trailing <br>s and whitespace-only text.
    while (run.length > 0 && isSkippable(run[0])) run.shift();
    while (run.length > 0 && isSkippable(run[run.length - 1])) run.pop();
    if (run.length > 0) {
      const p = doc.createElement('p');
      p.append(...run);
      out.push(p);
    }
    run = [];
  };

  for (const node of Array.from(frag.childNodes)) {
    if (node instanceof Element && BLOCK_TAGS.has(node.tagName)) {
      flush();
      pendingBr = 0;
      out.push(node);
    } else if (node instanceof Element && node.tagName === 'BR') {
      pendingBr++;
      if (pendingBr >= 2) {
        flush();
        pendingBr = 0;
      } else {
        run.push(node);
      }
    } else if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '') {
      if (run.length > 0) run.push(node);
    } else {
      pendingBr = 0;
      run.push(node);
    }
  }
  flush();
  frag.replaceChildren(...out);
}

function isSkippable(n: Node | undefined): boolean {
  if (!n) return false;
  if (n instanceof Element) return n.tagName === 'BR';
  return n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() === '';
}

/** Split <p>a<br><br>b</p> style paragraphs (common on some sites) into separate blocks. */
function splitDoubleBreaks(frag: DocumentFragment): void {
  for (const p of Array.from(frag.children)) {
    if (p.tagName !== 'P' && p.tagName !== 'DIV') continue;
    const brs = p.querySelectorAll(':scope > br + br');
    if (brs.length === 0) continue;
    const inner = p.ownerDocument.createDocumentFragment();
    inner.append(...Array.from(p.childNodes));
    wrapInlineRuns(inner);
    p.replaceWith(...Array.from(inner.childNodes));
  }
}

export function normalizeChapter(frag: DocumentFragment): void {
  unwrapSingleWrapper(frag);
  wrapInlineRuns(frag);
  splitDoubleBreaks(frag);
  for (const img of Array.from(frag.querySelectorAll('img'))) {
    const src = img.getAttribute('src');
    if (!src || !isAllowedImageSrc(src)) {
      img.remove();
      continue;
    }
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.setAttribute('draggable', 'false');
  }
  for (const el of Array.from(frag.children)) {
    if ((el.tagName === 'P' || el.tagName === 'DIV') && isBlank(el)) el.remove();
  }
  for (const table of Array.from(frag.querySelectorAll('table'))) {
    const wrap = frag.ownerDocument.createElement('div');
    wrap.className = 'rd-table';
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

/** Sanitize untrusted chapter HTML into a fragment of block elements, ready to append. */
export function sanitizeChapter(html: string): DocumentFragment {
  installHooks();
  const frag = DOMPurify.sanitize(html, { ...purifyConfig(), RETURN_DOM_FRAGMENT: true });
  normalizeChapter(frag);
  return frag;
}

/** String form (tests and diagnostics). */
export function sanitizeChapterToString(html: string): string {
  const frag = sanitizeChapter(html);
  const div = document.createElement('div');
  div.append(frag);
  return div.innerHTML;
}
