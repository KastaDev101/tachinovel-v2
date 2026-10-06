/**
 * Reading stats in synced `stats.json`: per local calendar day, active reading ms (the same < 60 s
 * progress.save gaps that feed history readingMs), chapters finished, and ms per novel. 400 days kept,
 * plus an all-time reading total that pruning never lowers.
 * stats.get: `days` and `topNovels` cover the requested range; `totalMs` and `streakDays` are all-time
 * (the streak can see the 400 stored days).
 * Hot-path updates are quiet writes (persisted with the next write, app.flush or close).
 */
import type { ReadingStats } from '../../shared/contracts/domain.ts';
import { isRecord } from '../lib/validate.ts';
import { JsonDoc } from '../storage/json-doc.ts';
import type { Ctx } from './context.ts';

export const STATS_PATH = 'stats.json';
export const STATS_KEEP_DAYS = 400;
/** A day counts toward the streak with at least this much reading. */
export const STREAK_MIN_MS = 5 * 60 * 1000;

interface DayRecord {
  ms: number;
  chapters: number;
  /** novelKey → ms */
  novels: Record<string, number>;
}

interface StatsDoc {
  schemaVersion: number;
  /** 'YYYY-MM-DD' (local) → record */
  days: Record<string, DayRecord>;
  /** novelKey → display info (latest) */
  names: Record<string, { name: string; cover?: string }>;
  /** All-time reading ms (kept when old days are pruned). */
  totalMs: number;
}

function sumDays(days: Record<string, DayRecord>): number {
  let total = 0;
  for (const rec of Object.values(days)) total += rec.ms;
  return total;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const msValue = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * A stored stats file made safe to use: malformed days, counters and names (hand edits, a bad sync,
 * an older/newer build) are dropped or zeroed instead of throwing later in addReading/get/prune.
 * The widget reads this file too (src/widget/stats.ts), so what gets written back is always clean.
 */
export function sanitizeStats(d: Record<string, unknown>): StatsDoc {
  const days: Record<string, DayRecord> = {};
  if (isRecord(d.days)) {
    for (const [date, rec] of Object.entries(d.days)) {
      if (!DATE_RE.test(date) || !isRecord(rec)) continue;
      const novels: Record<string, number> = {};
      if (isRecord(rec.novels)) for (const [key, ms] of Object.entries(rec.novels)) if (msValue(ms) > 0) novels[key] = msValue(ms);
      const chapters = typeof rec.chapters === 'number' && Number.isInteger(rec.chapters) && rec.chapters > 0 ? rec.chapters : 0;
      days[date] = { ms: msValue(rec.ms), chapters, novels };
    }
  }
  const names: StatsDoc['names'] = {};
  if (isRecord(d.names)) {
    for (const [key, info] of Object.entries(d.names)) {
      if (!isRecord(info) || typeof info.name !== 'string') continue;
      names[key] = typeof info.cover === 'string' && info.cover ? { name: info.name, cover: info.cover } : { name: info.name };
    }
  }
  const stored = msValue(d.totalMs);
  const summed = sumDays(days);
  // Never below what the kept days add up to (pruning only ever lowers the days, not the total).
  return { schemaVersion: 1, days, names, totalMs: Math.max(stored, summed) };
}

const p2 = (n: number): string => String(n).padStart(2, '0');

/** Local calendar date of an epoch ms. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** Local dates from `days - 1` days before `ms` through `ms`, oldest first. */
function dateRange(ms: number, days: number): string[] {
  const out: string[] = [];
  const d = new Date(ms);
  d.setHours(12, 0, 0, 0); // midday: DST changes never skip or repeat a date
  for (let i = days - 1; i >= 0; i--) {
    const x = new Date(d.getTime());
    x.setDate(d.getDate() - i);
    out.push(localDate(x.getTime()));
  }
  return out;
}

export class StatsService {
  private readonly ctx: Ctx;
  private doc: Promise<JsonDoc<StatsDoc>> | null = null;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  private load(): Promise<JsonDoc<StatsDoc>> {
    this.doc ??= JsonDoc.load<StatsDoc>(
      this.ctx.platform.synced,
      {
        path: STATS_PATH,
        version: 1,
        create: () => ({ schemaVersion: 1, days: {}, names: {}, totalMs: 0 }),
        normalize: (d) => sanitizeStats(d as unknown as Record<string, unknown>),
      },
      this.ctx.timing.historyWriteMs,
      this.ctx.env,
    ).then(
      (doc) => {
        doc.beforeWrite = () => this.prune(doc);
        return doc;
      },
      (err: unknown) => {
        // A failed read (e.g. iCloud hiccup) is retried by the next call instead of breaking stats for the session.
        this.doc = null;
        throw err;
      },
    );
    return this.doc;
  }

  /** A usable timestamp (a NaN would file reading under "NaN-NaN-NaN"). */
  private at(at: number): number {
    return Number.isFinite(at) ? at : this.ctx.platform.now();
  }

  private prune(doc: JsonDoc<StatsDoc>): void {
    const keep = new Set(dateRange(this.ctx.platform.now(), STATS_KEEP_DAYS));
    for (const date of Object.keys(doc.value.days)) if (!keep.has(date)) delete doc.value.days[date];
    // Names of novels no kept day mentions anymore.
    const used = new Set<string>();
    for (const rec of Object.values(doc.value.days)) for (const key of Object.keys(rec.novels)) used.add(key);
    for (const key of Object.keys(doc.value.names)) if (!used.has(key)) delete doc.value.names[key];
  }

  private day(doc: JsonDoc<StatsDoc>, at: number): DayRecord {
    const date = localDate(at);
    let rec = doc.value.days[date];
    if (!rec) {
      rec = { ms: 0, chapters: 0, novels: {} };
      doc.value.days[date] = rec;
    }
    return rec;
  }

  /** Active reading time (a progress.save gap). */
  async addReading(key: string, ms: number, info: { name: string; cover?: string }, at: number): Promise<void> {
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    const doc = await this.load();
    const rec = this.day(doc, this.at(at));
    rec.ms += ms;
    rec.novels[key] = (rec.novels[key] ?? 0) + ms;
    doc.value.totalMs += ms;
    const prev = doc.value.names[key];
    if (!prev || prev.name !== info.name || prev.cover !== info.cover) doc.value.names[key] = info.cover ? { name: info.name, cover: info.cover } : { name: info.name };
    doc.changedQuietly();
  }

  async addChapter(at: number): Promise<void> {
    const doc = await this.load();
    this.day(doc, this.at(at)).chapters++;
    doc.changed();
  }

  /** Move a novel's history (migration to another source). */
  async renameNovel(from: string, to: string): Promise<void> {
    const doc = await this.load();
    let changed = false;
    for (const rec of Object.values(doc.value.days)) {
      const ms = rec.novels[from];
      if (ms === undefined) continue;
      delete rec.novels[from];
      rec.novels[to] = (rec.novels[to] ?? 0) + ms;
      changed = true;
    }
    const name = doc.value.names[from];
    if (name) {
      doc.value.names[to] ??= name;
      delete doc.value.names[from];
      changed = true;
    }
    if (changed) doc.changed();
  }

  async get(days = 30): Promise<ReadingStats> {
    const doc = await this.load();
    const now = this.ctx.platform.now();
    const dates = dateRange(now, days);
    const out: ReadingStats['days'] = [];
    const byNovel = new Map<string, number>();
    for (const date of dates) {
      const rec = doc.value.days[date];
      out.push({ date, ms: rec?.ms ?? 0, chapters: rec?.chapters ?? 0 });
      if (!rec) continue;
      for (const [key, ms] of Object.entries(rec.novels)) byNovel.set(key, (byNovel.get(key) ?? 0) + ms);
    }
    // Streak: consecutive days with ≥ 5 min, ending today — or yesterday while today isn't there yet.
    const streakDates = dateRange(now, STATS_KEEP_DAYS).reverse();
    let streakDays = 0;
    for (let i = 0; i < streakDates.length; i++) {
      const ms = doc.value.days[streakDates[i] as string]?.ms ?? 0;
      if (ms >= STREAK_MIN_MS) streakDays++;
      else if (i === 0) continue;
      else break;
    }
    const topNovels = [...byNovel]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, ms]) => {
        const info = doc.value.names[key];
        const top: ReadingStats['topNovels'][number] = { key, name: info?.name ?? key, ms };
        if (info?.cover) top.cover = info.cover;
        return top;
      });
    return { days: out, streakDays, totalMs: doc.value.totalMs, topNovels };
  }

  async flush(): Promise<void> {
    if (this.doc) await (await this.doc).flush();
  }
}
