/**
 * New-chapter findings written by the home-screen widget (agent G) into local `widget-updates.json`:
 * [{key, chapterPaths[], chapterNames[], foundAt}], oldest → newest, each path at most once per novel.
 * Merged into updates.json and the library's unread counts on launch and on the 3 s heartbeat, then
 * the file is deleted. Update records are deduplicated by (novel, chapterPath), so the app's own next
 * update check (whose stored chapter list is older) doesn't record the same chapters again, and counts
 * only grow for chapters that weren't recorded before. lastUpdatedAt is raised to ≥ foundAt, which tells
 * the widget the record has been taken over.
 */
import type { UpdateEntry } from '../../shared/contracts/domain.ts';
import { parseNovelKey } from '../../shared/contracts/domain.ts';
import { errorMessage } from '../lib/errors.ts';
import { isRecord } from '../lib/validate.ts';
import type { Ctx } from './context.ts';
import type { LibraryService } from './library.ts';
import type { NovelStore } from './novel-store.ts';
import type { ProgressService } from './progress.ts';
import type { UpdatesService } from './updates.ts';

export const WIDGET_UPDATES_FILE = 'widget-updates.json';

interface WidgetRecord {
  key: string;
  chapterPaths: string[];
  chapterNames: string[];
  foundAt: number;
}

function parseRecords(v: unknown): WidgetRecord[] {
  if (!Array.isArray(v)) return [];
  const out: WidgetRecord[] = [];
  for (const r of v) {
    if (!isRecord(r) || typeof r.key !== 'string' || !Array.isArray(r.chapterPaths) || typeof r.foundAt !== 'number') continue;
    const paths = r.chapterPaths.filter((p): p is string => typeof p === 'string' && p.length > 0);
    const names = Array.isArray(r.chapterNames) ? r.chapterNames.map((n) => (typeof n === 'string' ? n : '')) : [];
    out.push({ key: r.key, chapterPaths: paths, chapterNames: names, foundAt: r.foundAt });
  }
  return out;
}

export async function mergeWidgetUpdates(
  ctx: Ctx,
  d: { library: LibraryService; updates: UpdatesService; progress: ProgressService; store: NovelStore },
): Promise<number> {
  const { local } = ctx.platform;
  if (!local.exists(WIDGET_UPDATES_FILE)) return 0;
  let records: WidgetRecord[];
  try {
    const text = await local.readText(WIDGET_UPDATES_FILE);
    records = parseRecords(text ? JSON.parse(text) : null);
  } catch (err) {
    ctx.platform.log('warn', `widget-updates.json unreadable, dropped: ${errorMessage(err)}`);
    local.remove(WIDGET_UPDATES_FILE);
    return 0;
  }
  let added = 0;
  let changed = false;
  for (const r of records) {
    const entry = d.library.get(r.key);
    if (!entry || r.chapterPaths.length === 0) continue;
    const { pluginId, path } = parseNovelKey(r.key);
    const prog = await d.progress.get(r.key);
    const known = await d.store.known(r.key);
    const listed = new Set(known?.chapters.map((c) => c.path) ?? []);
    const candidates: UpdateEntry[] = [];
    // Newest chapter first, like the app's own update records.
    for (let i = r.chapterPaths.length - 1; i >= 0; i--) {
      const chapterPath = r.chapterPaths[i] as string;
      const u: UpdateEntry = {
        pluginId,
        path,
        novelName: entry.name,
        chapterPath,
        chapterName: r.chapterNames[i] || chapterPath,
        foundAt: r.foundAt,
        read: prog.read.has(chapterPath),
      };
      if (entry.cover) u.cover = entry.cover;
      candidates.push(u);
    }
    const fresh = await d.updates.add(candidates);
    added += fresh.length;
    // Counts grow only for chapters recorded just now that the stored list doesn't have yet (the next
    // refresh recomputes them from the full list anyway).
    const unseen = fresh.filter((u) => !listed.has(u.chapterPath));
    const unreadNew = unseen.filter((u) => !u.read).length;
    d.library.update(r.key, (e) => {
      e.chapterCount += unseen.length;
      e.unreadCount += unreadNew;
      e.lastUpdatedAt = Math.max(e.lastUpdatedAt ?? 0, r.foundAt);
    });
    changed = true;
  }
  local.remove(WIDGET_UPDATES_FILE);
  if (changed) d.library.emitChanged();
  if (records.length > 0) ctx.platform.log('info', `Merged ${records.length} widget update record(s): ${added} new chapter(s)`);
  return added;
}
