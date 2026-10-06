/**
 * Reading Insights math (pure; unit-tested): durations, today / this-week totals, chart buckets
 * (daily for 7 and 30 days, monthly for a year) and a "nice" axis scale.
 */
import type { ReadingStats } from '../../shared/contracts/domain.ts';
import { plural } from './format.ts';
import { PACE_KEY } from './pace.ts';

export type StatsRange = 7 | 30 | 365;
export type StatsDay = ReadingStats['days'][number];

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Compact duration: "45 m", "2 h 14 m", "3 h", "128 h". */
export function formatDuration(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / MIN);
  if (min < 60) return `${min} m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h >= 100 || m === 0 ? `${h} h` : `${h} h ${m} m`;
}

/** Duration split into number/unit pairs so tiles can set the number large and the unit small. */
export function durationParts(ms: number): { value: string; unit: string }[] {
  const min = Math.floor(Math.max(0, ms) / MIN);
  if (min < 60) return [{ value: String(min), unit: 'm' }];
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h >= 100 || m === 0 ? [{ value: h.toLocaleString('en-US'), unit: 'h' }] : [
    { value: String(h), unit: 'h' },
    { value: String(m), unit: 'm' },
  ];
}

/** Local calendar day key, "2026-10-05". */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "2026-10-05" → local midnight of that day. */
export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export interface Totals {
  ms: number;
  chapters: number;
}

function sum(days: readonly StatsDay[]): Totals {
  let ms = 0;
  let chapters = 0;
  for (const d of days) {
    ms += d.ms;
    chapters += d.chapters;
  }
  return { ms, chapters };
}

export function todayTotals(days: readonly StatsDay[], now: number): Totals {
  const k = dayKey(now);
  const d = days.find((x) => x.date === k);
  return { ms: d?.ms ?? 0, chapters: d?.chapters ?? 0 };
}

/** Key of the first day of the calendar week containing `now` (weeks start on Sunday, as in the US, by default). */
export function weekStartKey(now: number, weekStartsOn = 0): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const back = (d.getDay() - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - back);
  return dayKey(d.getTime());
}

export function weekTotals(days: readonly StatsDay[], now: number, weekStartsOn = 0): Totals {
  const from = weekStartKey(now, weekStartsOn);
  const to = dayKey(now);
  return sum(days.filter((d) => d.date >= from && d.date <= to));
}

function shiftKey(key: string, days: number): string {
  const d = parseDayKey(key);
  d.setDate(d.getDate() + days);
  return dayKey(d.getTime());
}

/** This calendar week so far, and the same days of last week ("this time last week"). */
export function weekVsLastWeek(days: readonly StatsDay[], now: number, weekStartsOn = 0): { thisWeek: Totals; lastWeek: Totals } {
  const from = weekStartKey(now, weekStartsOn);
  const to = dayKey(now);
  const lastFrom = shiftKey(from, -7);
  const lastTo = shiftKey(to, -7);
  return {
    thisWeek: sum(days.filter((d) => d.date >= from && d.date <= to)),
    lastWeek: sum(days.filter((d) => d.date >= lastFrom && d.date <= lastTo)),
  };
}

export interface WeekSummary {
  title: string;
  detail: string;
  trend: 'up' | 'down' | 'same' | 'none';
}

/** "You’ve read 10 chapters this week" + "1 h 26 m so far, 35 m more than this time last week." */
export function weekSummary(c: { thisWeek: Totals; lastWeek: Totals }): WeekSummary {
  const t = c.thisWeek;
  const l = c.lastWeek;
  if (t.ms <= 0 && t.chapters <= 0) {
    return {
      title: 'No reading yet this week',
      detail: l.ms > 0 ? `By this time last week you’d read ${formatDuration(l.ms)}.` : 'Open a chapter and it starts counting.',
      trend: 'none',
    };
  }
  const title = `You’ve read ${plural(t.chapters, 'chapter')} this week`;
  const so = `${formatDuration(t.ms)} so far`;
  if (l.ms <= 0) return { title, detail: `${so}.`, trend: 'none' };
  const diff = t.ms - l.ms;
  if (Math.abs(diff) < 5 * MIN) return { title, detail: `${so}, about the same as this time last week.`, trend: 'same' };
  return { title, detail: `${so}, ${formatDuration(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than this time last week.`, trend: diff > 0 ? 'up' : 'down' };
}

export function rangeTotals(days: readonly StatsDay[]): Totals & { activeDays: number; dailyAverageMs: number } {
  const t = sum(days);
  return { ...t, activeDays: days.filter((d) => d.ms > 0).length, dailyAverageMs: days.length > 0 ? t.ms / days.length : 0 };
}

export interface RangeFacts {
  /** Days with any reading, out of `days`. */
  activeDays: number;
  /** Days that reached the daily goal (0 without a goal). */
  goalDays: number;
  days: number;
  /** The day with the most reading time (earliest wins a tie), or null if nothing was read. */
  best: StatsDay | null;
  /** Longest run of consecutive reading days inside the range. */
  longestRun: number;
}

export function rangeFacts(days: readonly StatsDay[], goalMs: number | null = null): RangeFacts {
  let best: StatsDay | null = null;
  let run = 0;
  let longestRun = 0;
  let activeDays = 0;
  let goalDays = 0;
  for (const d of days) {
    if (goalMs !== null && goalMet(d.ms, goalMs)) goalDays++;
    if (d.ms > 0) {
      activeDays++;
      run++;
      longestRun = Math.max(longestRun, run);
      if (!best || d.ms > best.ms) best = d;
    } else run = 0;
  }
  return { activeDays, goalDays, days: days.length, best, longestRun };
}

export interface ChartBucket {
  key: string;
  /** Full label for the readout and screen readers ("Mon, Oct 5", "September 2026"). */
  label: string;
  /** Short axis label, or '' when this bucket has no tick. */
  axis: string;
  ms: number;
  chapters: number;
  /** Today's day / the current month. */
  current: boolean;
  /** Days in this bucket that reached the daily goal (0 without a goal). */
  goalDays: number;
}

const fmtDayLong = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const fmtWeekdayNarrow = new Intl.DateTimeFormat('en-US', { weekday: 'narrow' });
const fmtMonthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const fmtMonthYear = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });
const fmtMonthNarrow = new Intl.DateTimeFormat('en-US', { month: 'narrow' });

/**
 * Bars for the activity chart: one per day for up to a month (7 days: weekday initials; 30 days: a
 * date tick every 7 days, counted back from today), one per calendar month for longer ranges.
 */
export function chartBuckets(days: readonly StatsDay[], now: number, goalMs: number | null = null): ChartBucket[] {
  const met = (ms: number): number => (goalMs !== null && goalMet(ms, goalMs) ? 1 : 0);
  const today = dayKey(now);
  if (days.length <= 31) {
    const weekly = days.length > 7;
    return days.map((d, i) => {
      const date = parseDayKey(d.date);
      const fromEnd = days.length - 1 - i;
      return {
        key: d.date,
        label: fmtDayLong.format(date),
        axis: weekly ? (fromEnd % 7 === 0 ? fmtMonthDay.format(date) : '') : fmtWeekdayNarrow.format(date),
        ms: d.ms,
        chapters: d.chapters,
        current: d.date === today,
        goalDays: met(d.ms),
      };
    });
  }
  const thisMonth = today.slice(0, 7);
  const out: ChartBucket[] = [];
  for (const d of days) {
    const month = d.date.slice(0, 7);
    let b = out[out.length - 1];
    if (!b || b.key !== month) {
      const date = parseDayKey(`${month}-01`);
      b = { key: month, label: fmtMonthYear.format(date), axis: fmtMonthNarrow.format(date), ms: 0, chapters: 0, current: month === thisMonth, goalDays: 0 };
      out.push(b);
    }
    b.ms += d.ms;
    b.chapters += d.chapters;
    b.goalDays += met(d.ms);
  }
  return out;
}

const STEPS_MIN = [5, 10, 15, 30, 60, 120, 180, 300, 600, 1200, 1800, 3000, 6000, 12000];

/** Axis maximum and gridlines: at most two steps above zero, on round minute/hour values. */
export function niceScale(maxMs: number): { max: number; ticks: number[] } {
  const target = Math.max(maxMs, 5 * MIN);
  for (const stepMin of STEPS_MIN) {
    const step = stepMin * MIN;
    if (step * 2 >= target) return { max: step * 2, ticks: [step, step * 2] };
  }
  const step = Math.ceil(target / 2 / (100 * HOUR)) * 100 * HOUR;
  return { max: step * 2, ticks: [step, step * 2] };
}

/** Gridline label: "30 m", "1 h", "20 h". */
export function tickLabel(ms: number): string {
  const min = Math.round(ms / MIN);
  return min < 60 ? `${min} m` : `${Math.round((min / 60) * 10) / 10} h`;
}

/** Screen-reader text for one bar (`daily`: one day per bar, so "goal met" instead of a count). */
export function bucketAria(b: ChartBucket, daily = true): string {
  const goal = b.goalDays > 0 ? (daily ? ', goal met' : `, goal met on ${b.goalDays} ${b.goalDays === 1 ? 'day' : 'days'}`) : '';
  return `${b.label}: ${b.ms > 0 ? formatDuration(b.ms) : 'no reading'}${b.chapters > 0 ? `, ${b.chapters} ${b.chapters === 1 ? 'chapter' : 'chapters'}` : ''}${goal}`;
}

/** Streak tile caption. */
export function streakCaption(streakDays: number, todayMs: number): string {
  if (streakDays <= 0) return 'Read today to start one';
  return todayMs > 0 ? 'Keep it going' : 'Read today to keep it';
}

// ---------- daily goal ----------

/** One-tap goals (minutes per day). */
export const GOAL_PRESETS = [15, 30, 60] as const;
export const GOAL_LIMITS = { min: 5, max: 480, step: 5 } as const;

export function goalToMs(goal: { minutesPerDay: number } | null | undefined): number | null {
  return goal && goal.minutesPerDay > 0 ? goal.minutesPerDay * MIN : null;
}

/** "15 min", "1 hour", "90 min", "2 hours". */
export function goalLabel(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} min`;
}

export function goalMet(ms: number, goal: number): boolean {
  return goal > 0 && ms >= goal;
}

/** 0..1 of today's goal. */
export function goalProgress(ms: number, goal: number): number {
  return goal > 0 ? Math.min(1, Math.max(0, ms / goal)) : 0;
}

/**
 * Consecutive goal days ending today, or ending yesterday while today's goal isn't reached yet (so the
 * streak doesn't drop to 0 in the morning). `capped`: the run reaches the oldest day we have.
 */
export function goalStreak(days: readonly StatsDay[], now: number, goal: number): { days: number; capped: boolean } {
  const byDate = new Map(days.map((d) => [d.date, d.ms]));
  const oldest = days[0]?.date ?? dayKey(now);
  let key = dayKey(now);
  if (!goalMet(byDate.get(key) ?? 0, goal)) key = shiftKey(key, -1);
  let n = 0;
  while (key >= oldest && goalMet(byDate.get(key) ?? 0, goal)) {
    n++;
    key = shiftKey(key, -1);
  }
  return { days: n, capped: key < oldest && n > 0 };
}

/** Caption under today's ring: "Goal met" or "12 m to go". */
export function goalCaption(todayMs: number, goal: number): string {
  return goalMet(todayMs, goal) ? 'Goal met' : `${formatDuration(Math.max(MIN, goal - todayMs))} to go`;
}

/** A short, shareable summary of the reading week ("Share my week"). */
export function weekShareText(stats: ReadingStats, now: number, goal: number | null = null): string {
  const w = weekTotals(stats.days, now);
  const parts = [
    w.ms > 0 ? `This week I read ${plural(w.chapters, 'chapter')} in ${formatDuration(w.ms)}.` : 'No reading yet this week, but the week isn’t over.',
  ];
  const streak = goal !== null ? goalStreak(stats.days, now, goal).days : stats.streakDays;
  if (streak > 1) parts.push(goal !== null ? `${streak} days in a row at my ${goalLabel(Math.round(goal / MIN))} goal 🔥` : `${streak}-day reading streak 🔥`);
  const top = stats.topNovels[0];
  if (top) parts.push(`Most read lately: ${top.name}.`);
  return `${parts.join(' ')}\n— TachiNovel`;
}

/** Duration for screen readers: "38 minutes", "1 hour 26 minutes", "128 hours". */
export function durationSpoken(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / MIN);
  const unit = (n: number, one: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : `${one}s`}`;
  if (min < 60) return unit(min, 'minute');
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h >= 100 || m === 0 ? unit(h, 'hour') : `${unit(h, 'hour')} ${unit(m, 'minute')}`;
}

// ---------- year heatmap ----------

/** Weeks in the year heatmap (a full year plus the week in progress), and the days it asks for. */
export const HEAT_WEEKS = 53;
export const HEAT_DAYS = HEAT_WEEKS * 7;

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatCell {
  date: string;
  ms: number;
  chapters: number;
  level: HeatLevel;
  /** After today (the rest of this week): drawn empty. */
  future: boolean;
}

export interface YearGrid {
  /** Columns oldest → newest, each the 7 days of one week from `weekStartsOn`. */
  weeks: HeatCell[][];
  /** Month labels: the column where each month's first full-week row starts. */
  months: { col: number; label: string }[];
  activeDays: number;
  totalMs: number;
}

/**
 * Shade of one day. With a goal: under half of it, under it, met, twice it. Without: under 15 m,
 * under 30 m, under an hour, an hour or more.
 */
export function heatLevel(ms: number, goalMs: number | null = null): HeatLevel {
  if (ms <= 0) return 0;
  const [a, b, c] = goalMs !== null && goalMs > 0 ? [goalMs / 2, goalMs, goalMs * 2] : [15 * MIN, 30 * MIN, HOUR];
  return ms < a ? 1 : ms < b ? 2 : ms < c ? 3 : 4;
}

const fmtMonth = new Intl.DateTimeFormat('en-US', { month: 'short' });

/** The last 53 weeks as a calendar grid (GitHub-style), ending with the current week. */
export function yearGrid(days: readonly StatsDay[], now: number, goalMs: number | null = null, weekStartsOn = 0): YearGrid {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const today = dayKey(now);
  const first = parseDayKey(today);
  first.setDate(first.getDate() - ((first.getDay() - weekStartsOn + 7) % 7) - (HEAT_WEEKS - 1) * 7);
  const weeks: HeatCell[][] = [];
  const months: { col: number; label: string }[] = [];
  let activeDays = 0;
  let totalMs = 0;
  let lastMonth = -1;
  for (let w = 0; w < HEAT_WEEKS; w++) {
    const col: HeatCell[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(first);
      d.setDate(first.getDate() + w * 7 + i);
      const key = dayKey(d.getTime());
      const future = key > today;
      const day = future ? undefined : byDate.get(key);
      const ms = day?.ms ?? 0;
      if (ms > 0) {
        activeDays++;
        totalMs += ms;
      }
      col.push({ date: key, ms, chapters: day?.chapters ?? 0, level: heatLevel(ms, goalMs), future });
      if (i === 0) {
        const m = d.getMonth();
        // A label where the month changes; none for a first column that's about to change anyway.
        if (m !== lastMonth && !(w === 0 && d.getDate() > 24)) months.push({ col: w, label: fmtMonth.format(d) });
        lastMonth = m;
      }
    }
    weeks.push(col);
  }
  return { weeks, months, activeDays, totalMs };
}

/** "Tue, Oct 3 · 42 m · 4 chapters", or "Tue, Oct 3 · no reading". */
export function heatCellLabel(c: HeatCell): string {
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(parseDayKey(c.date));
  return c.ms > 0 ? `${day} · ${formatDuration(c.ms)} · ${plural(c.chapters, 'chapter')}` : `${day} · no reading`;
}

// ---------- longest session ----------

/** "Shadow Slave · Sep 28" (the year too when it isn't this year); the duration is shown on its own. */
export function longestSessionDetail(s: NonNullable<ReadingStats['longestSession']>, now: number): string {
  const d = new Date(s.at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = new Intl.DateTimeFormat('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
  return [s.name?.trim() || '', date].filter(Boolean).join(' · ');
}

// ---------- reading speed ----------

/** The learned pace in words per minute, or null when the reader hasn't learned one on this device. */
export function learnedPace(stored: string | null): number | null {
  const n = stored === null ? NaN : Number(stored);
  return Number.isFinite(n) && n >= 100 && n <= 700 ? Math.round(n) : null;
}

/** The pace the reader saved (under its own PACE_KEY), or null. Never throws: storage can be blocked. */
export function readLearnedPace(storage: () => Pick<Storage, 'getItem'>): number | null {
  try {
    return learnedPace(storage().getItem(PACE_KEY));
  } catch {
    return null;
  }
}

/** "about 2.8 million words", "about 180,000 words", "about 4,200 words" (two significant digits). */
export function wordsEstimate(totalMs: number, wpm: number): string {
  const words = (totalMs / MIN) * wpm;
  if (words < 1) return 'no words yet';
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(words)) - 1);
  const rounded = Math.round(words / mag) * mag;
  if (rounded >= 1e6) return `about ${(rounded / 1e6).toFixed(rounded >= 1e7 ? 0 : 1).replace(/\.0$/, '')} million words`;
  return `about ${rounded.toLocaleString('en-US')} words`;
}

/** The calendar month by month (oldest first), for screen readers: "October 2026: 4 days read, 3 h 10 m". */
export function heatMonths(grid: YearGrid): { key: string; label: string; days: number; ms: number }[] {
  const byMonth = new Map<string, { key: string; label: string; days: number; ms: number }>();
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });
  for (const col of grid.weeks)
    for (const c of col) {
      if (c.future) continue;
      const key = c.date.slice(0, 7);
      let m = byMonth.get(key);
      if (!m) {
        m = { key, label: fmt.format(parseDayKey(c.date)), days: 0, ms: 0 };
        byMonth.set(key, m);
      }
      if (c.ms > 0) {
        m.days++;
        m.ms += c.ms;
      }
    }
  return [...byMonth.values()];
}
