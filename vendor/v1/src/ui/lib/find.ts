/**
 * Find in chapter: case-insensitive matching over a block's text nodes (so a match may span inline
 * elements like <em>), with typographic quotes folded (typing "don't" finds "don’t").
 */

/** [text node index, offset inside it] */
export type TextPoint = readonly [number, number];

export interface TextMatch {
  start: TextPoint;
  end: TextPoint;
}

const FOLD: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"', ' ': ' ' };

/** Lower-cases and folds quotes; keeps the length (1 char → 1 char) so offsets stay valid. */
export function foldText(s: string): string {
  let out = '';
  for (const ch of s) {
    const f = FOLD[ch] ?? ch.toLowerCase();
    // Rare characters whose lower case is longer (e.g. "İ"): keep them as they are.
    out += f.length === ch.length ? f : ch;
  }
  return out;
}

/** All matches of `query` in the concatenation of `texts` (one block's text nodes, in order). */
export function locateMatches(texts: readonly string[], query: string, limit = 2000): TextMatch[] {
  const q = foldText(query.trim());
  if (!q) return [];
  const hay = foldText(texts.join(''));
  const starts: number[] = [];
  let acc = 0;
  for (const t of texts) {
    starts.push(acc);
    acc += t.length;
  }
  const point = (abs: number, isEnd: boolean): TextPoint => {
    // An end exactly on a node boundary belongs to the node before it.
    for (let k = texts.length - 1; k >= 0; k--) {
      const s = starts[k] ?? 0;
      if (isEnd ? abs > s : abs >= s) return [k, abs - s];
    }
    return [0, 0];
  };
  const out: TextMatch[] = [];
  for (let i = hay.indexOf(q); i >= 0 && out.length < limit; i = hay.indexOf(q, i + q.length)) {
    out.push({ start: point(i, false), end: point(i + q.length, true) });
  }
  return out;
}
