/** Local-calendar date helpers (the phone's time zone), shared by stats, backups and exports. */

/** Two-digit zero padding. */
export const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local calendar date of an epoch ms: "YYYY-MM-DD". */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
