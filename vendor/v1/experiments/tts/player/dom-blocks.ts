/**
 * DOM side of the narration front-end: turn a rendered chapter body into the same blocks as
 * frontend.ts `htmlToBlocks` (same BLOCK_TAGS / SKIP_TAGS rules, same canonical text), and turn a
 * segment's (block, start, end) back into a DOM Range for highlighting.
 *
 * WebView-only (uses DOM types). Integration target: src/ui/lib/narration-dom.ts.
 */
import { BLOCK_TAGS, canonicalize, SKIP_TAGS, type SourceBlock, type TextPart } from '../frontend.ts';

export interface DomBlock extends SourceBlock {
  /** Text nodes (or null for <br>) in document order; index = TextPart index. */
  nodes: (Text | null)[];
  /** Nearest block element containing the text (for paragraph styling). */
  element: Element | null;
}

export function domBlocks(root: Element): DomBlock[] {
  const out: DomBlock[] = [];
  let parts: TextPart[] = [];
  let nodes: (Text | null)[] = [];
  let tag = '';
  let element: Element | null = null;
  const clsStack: string[] = [];
  const flush = (nextTag: string, nextEl: Element | null) => {
    const { text } = canonicalize(parts);
    if (text) {
      const cls = clsStack.filter(Boolean).join(' ');
      out.push(cls ? { text, tag, cls, nodes, element } : { text, tag, nodes, element });
    }
    parts = [];
    nodes = [];
    tag = nextTag;
    element = nextEl;
  };
  const walk = (node: Node, parentBlock: Element | null) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === Node.TEXT_NODE) {
        parts.push((c as Text).data);
        nodes.push(c as Text);
        continue;
      }
      if (c.nodeType !== Node.ELEMENT_NODE) continue;
      const el = c as Element;
      const name = el.localName.toLowerCase();
      if (SKIP_TAGS.has(name)) continue;
      if (name === 'br') {
        parts.push(null);
        nodes.push(null);
        continue;
      }
      if (name === 'hr') {
        flush('', parentBlock);
        out.push({ text: '', tag: 'hr', nodes: [], element: el });
        continue;
      }
      if (BLOCK_TAGS.has(name)) {
        flush(name, el);
        clsStack.push(el.getAttribute('class')?.trim() ?? '');
        walk(el, el);
        flush('', parentBlock);
        clsStack.pop();
      } else walk(el, parentBlock);
    }
  };
  element = root;
  walk(root, root);
  flush('', null);
  return out;
}

/** DOM Range covering [start, end) of a block's canonical text, or null if it can't be mapped. */
export function blockRange(block: DomBlock, start: number, end: number): Range | null {
  if (end <= start) return null;
  const map = canonicalize(
    block.nodes.map((n) => (n ? n.data : null)),
    true,
  );
  const pi = map.partIndex;
  const po = map.partOffset;
  if (!pi || !po || end > map.text.length) return null;
  // Skip a leading/trailing line break (a <br> has no text node to anchor on).
  let s = start;
  let e = end - 1;
  while (s <= e && block.nodes[pi[s] ?? -1] == null) s++;
  while (e >= s && block.nodes[pi[e] ?? -1] == null) e--;
  if (e < s) return null;
  const n0 = block.nodes[pi[s] ?? -1];
  const n1 = block.nodes[pi[e] ?? -1];
  if (!n0 || !n1) return null;
  const r = document.createRange();
  r.setStart(n0, po[s] ?? 0);
  r.setEnd(n1, (po[e] ?? 0) + 1);
  return r;
}

/** Canonical (block, offset) for a DOM point, e.g. from caretRangeFromPoint (tap to play from here). */
export function pointToBlockOffset(blocks: readonly DomBlock[], node: Node, offset: number): { block: number; offset: number } | null {
  for (let b = 0; b < blocks.length; b++) {
    const blk = blocks[b];
    if (!blk) continue;
    const k = blk.nodes.indexOf(node as Text);
    if (k < 0) continue;
    const map = canonicalize(
      blk.nodes.map((n) => (n ? n.data : null)),
      true,
    );
    const pi = map.partIndex ?? [];
    const po = map.partOffset ?? [];
    for (let i = 0; i < pi.length; i++) {
      if (pi[i] === k && (po[i] ?? 0) >= offset) return { block: b, offset: i };
      if ((pi[i] ?? 0) > k) return { block: b, offset: i };
    }
    return { block: b, offset: map.text.length };
  }
  return null;
}
