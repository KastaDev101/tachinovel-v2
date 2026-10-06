/**
 * Grouping for the Updates and History tabs (pure; unit-tested).
 * - Updates: by calendar day, then by novel within the day ("Shadow Slave · 3 new chapters").
 * - History: Today / Yesterday / This Week / This Month / Earlier.
 */
import type { HistoryEntry, UpdateEntry } from '../../shared/contracts/domain.ts';
import { daysBetween, groupByDay } from './format.ts';

export interface NovelUpdates {
  /** `${pluginId}:${path}` + day: unique within the list. */
  key: string;
  pluginId: string;
  path: string;
  novelName: string;
  cover?: string | undefined;
  /** Newest first, as the list gives them. */
  chapters: UpdateEntry[];
  unread: number;
  /** Newest foundAt in the group. */
  latestAt: number;
}

export interface UpdatesDay {
  key: string;
  label: string;
  novels: NovelUpdates[];
}

/** Day groups (newest first) holding one entry per novel, in order of each novel's newest chapter. */
export function groupUpdates(entries: readonly UpdateEntry[], now: number): UpdatesDay[] {
  return groupByDay(entries, (u) => u.foundAt, now).map((day) => {
    const byNovel = new Map<string, NovelUpdates>();
    for (const u of day.items) {
      const id = `${u.pluginId}:${u.path}`;
      let g = byNovel.get(id);
      if (!g) {
        g = { key: `${day.key}|${id}`, pluginId: u.pluginId, path: u.path, novelName: u.novelName, cover: u.cover, chapters: [], unread: 0, latestAt: u.foundAt };
        byNovel.set(id, g);
      }
      g.chapters.push(u);
      if (!u.read) g.unread++;
      g.latestAt = Math.max(g.latestAt, u.foundAt);
    }
    return { key: day.key, label: day.label, novels: [...byNovel.values()] };
  });
}

/** Unread updates per novel, ready for one `progress.markRead` call each. */
export function unreadByNovel(entries: readonly UpdateEntry[]): { pluginId: string; novelPath: string; chapterPaths: string[] }[] {
  const m = new Map<string, { pluginId: string; novelPath: string; chapterPaths: string[] }>();
  for (const u of entries) {
    if (u.read) continue;
    const id = `${u.pluginId}:${u.path}`;
    let g = m.get(id);
    if (!g) {
      g = { pluginId: u.pluginId, novelPath: u.path, chapterPaths: [] };
      m.set(id, g);
    }
    g.chapterPaths.push(u.chapterPath);
  }
  return [...m.values()];
}

export interface HistorySection {
  key: 'today' | 'yesterday' | 'week' | 'month' | 'earlier';
  label: string;
  items: HistoryEntry[];
}

const SECTION_LABELS: Record<HistorySection['key'], string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This Week',
  month: 'This Month',
  earlier: 'Earlier',
};

export function historySectionKey(readAt: number, now: number): HistorySection['key'] {
  const days = daysBetween(readAt, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return 'week';
  if (days < 31) return 'month';
  return 'earlier';
}

/** History (newest first) in Today / Yesterday / This Week / This Month / Earlier sections; empty ones are left out. */
export function historySections(entries: readonly HistoryEntry[], now: number): HistorySection[] {
  const out: HistorySection[] = [];
  for (const h of entries) {
    const key = historySectionKey(h.readAt, now);
    let s = out[out.length - 1];
    if (!s || s.key !== key) {
      s = out.find((x) => x.key === key);
      if (!s) {
        s = { key, label: SECTION_LABELS[key], items: [] };
        out.push(s);
      }
    }
    s.items.push(h);
  }
  return out;
}
