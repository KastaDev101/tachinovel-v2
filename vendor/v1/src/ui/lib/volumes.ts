/**
 * Volume headers in chapter lists (Royal Road "Book One", Baka-Tsuki volumes…): a slim header row
 * wherever the volume changes in display order, only when some chapter has a volume. Rows are of two
 * heights, so the virtual list gets explicit row offsets.
 */

export type ListRow = { kind: 'chapter'; pos: number } | { kind: 'volume'; name: string };

export interface VolumeLayout {
  rows: ListRow[];
  /** Top of each row, plus the total height at the end (rows.length + 1 entries); null = all rows the same. */
  offsets: number[] | null;
  /** Row index of each display position. */
  rowOfPos: number[];
}

export function volumeLayout(volumes: readonly (string | undefined)[], rowHeight: number, headerHeight: number): VolumeLayout {
  const any = volumes.some((v) => v !== undefined && v !== '');
  if (!any) {
    const rowOfPos = volumes.map((_, i) => i);
    return { rows: rowOfPos.map((pos) => ({ kind: 'chapter', pos })), offsets: null, rowOfPos };
  }
  const rows: ListRow[] = [];
  const offsets: number[] = [];
  const rowOfPos: number[] = new Array<number>(volumes.length);
  let y = 0;
  let prev: string | null = null;
  volumes.forEach((v, pos) => {
    const name = v && v !== '' ? v : 'Other chapters';
    if (name !== prev) {
      rows.push({ kind: 'volume', name });
      offsets.push(y);
      y += headerHeight;
      prev = name;
    }
    rowOfPos[pos] = rows.length;
    rows.push({ kind: 'chapter', pos });
    offsets.push(y);
    y += rowHeight;
  });
  offsets.push(y);
  return { rows, offsets, rowOfPos };
}

/** The volume a row belongs to (the nearest header at or above it). */
export function volumeAt(rows: readonly ListRow[], index: number): string | null {
  for (let i = Math.min(index, rows.length - 1); i >= 0; i--) {
    const r = rows[i];
    if (r?.kind === 'volume') return r.name;
  }
  return null;
}
