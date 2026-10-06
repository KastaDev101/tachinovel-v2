/** Display formatting (pure; unit-tested). Intl formatters are created once: they're expensive. */

const DAY = 86_400_000;

const fmtMonthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const fmtMonthDayYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const fmtWeekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const fmtLongDay = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' });
const fmtLongDayYear = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days between two timestamps in local time (0 = same day). */
export function daysBetween(ts: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
}

export function relativeTime(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  const days = daysBetween(ts, now);
  if (days === 0) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return shortDate(ts, now);
}

export function shortDate(ts: number, now: number): string {
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? fmtMonthDay : fmtMonthDayYear).format(ts);
}

export function timeOfDay(ts: number): string {
  return fmtTime.format(ts);
}

/** Section header for day-grouped lists (Updates, History). */
export function dayLabel(ts: number, now: number): string {
  const days = daysBetween(ts, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return fmtWeekday.format(ts);
  return (new Date(ts).getFullYear() === new Date(now).getFullYear() ? fmtLongDay : fmtLongDayYear).format(ts);
}

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/** Groups items (already sorted newest first) by local calendar day. */
export function groupByDay<T>(items: readonly T[], getTs: (item: T) => number, now: number): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  let current: DayGroup<T> | undefined;
  for (const item of items) {
    const ts = getTs(item);
    const key = String(startOfDay(ts));
    if (!current || current.key !== key) {
      current = { key, label: dayLabel(ts, now), items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const numberFmt = new Intl.NumberFormat('en-US');

export function formatCount(n: number): string {
  return numberFmt.format(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** "2026-10-04T…" or display strings → short display; leaves unknown formats as they are. */
export function releaseLabel(value: string | undefined, now: number): string {
  if (!value) return '';
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return relativeTime(ts, now);
}

export function percentLabel(p: number): string {
  return `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
}

/** "4 h 26 m", "17 m", "< 1 m". */
export function readingTime(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '< 1 m';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} h ${m} m` : `${m} m`;
}

/** Compact chapter count for cover badges: "248", "1.2K" / "3.0K" (1,000–9,999, one decimal), "12K+" from 10,000. */
export function compactCount(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.floor(n)));
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toFixed(1)}K`;
  return `${Math.floor(n / 1000)}K+`;
}

/** "royalroad.com/fiction/81234/…" — a URL shortened for a muted one-line display. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, '');
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return `${host}${path}`;
  } catch {
    return url;
  }
}
