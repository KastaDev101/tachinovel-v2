/**
 * Justified text needs long enough lines, or it opens wide gaps ("rivers"): about 36 characters, or
 * 30 when words can be hyphenated. Below that (large text on a phone) lines stay ragged-right.
 * The column is capped at 720 px like the reader's content.
 */
export function justifyFits(r: { fontSize: number; margin: number }, viewportWidth: number, hyphenated: boolean): boolean {
  const column = Math.min(viewportWidth, 720) - 2 * r.margin;
  const charsPerLine = column / (r.fontSize * 0.5);
  return charsPerLine >= (hyphenated ? 30 : 36);
}
