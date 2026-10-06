/**
 * New-chapter findings written by the home-screen widget (agent G) into local `widget-updates.json`:
 * [{key, chapterPaths[], chapterNames[], foundAt}], oldest → newest, each path at most once per novel.
 * Merged into updates.json and the library's unread counts on launch and on the 3 s heartbeat, then
 * handed off (moved to a private name) and deleted, so a write by the widget meanwhile is never lost.
 * Update records are deduplicated by (novel, chapterPath), so the app's own next
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

type MergeDeps = { library: LibraryService; updates: UpdatesService; progress: ProgressService; store: NovelStore };

/** Private name the app moves the widget's file to before deleting it (atomic hand-off, see below). */
export const WIDGET_UPDATES_CLAIM = 'widget-updates.claimed.json';

/**
 * Merge the widget's findings. The widget runs in its own process and may rewrite the file at any
 * moment (finding #6): the app reads it, merges, then hands it off atomically by moving it to a private
 * name, merges that copy too if the widget changed the file meanwhile, and deletes only the private copy.
 * A widget write after the hand-off lands in a fresh file for the next merge. A private copy left over
 * by an interrupted merge is merged first. Duplicates are harmless (updates are deduplicated).
 */
export async function mergeWidgetUpdates(ctx: Ctx, d: MergeDeps): Promise<number> {
  const { local } = ctx.platform;
  let added = 0;
  if (local.exists(WIDGET_UPDATES_CLAIM)) {
    const left = await readOrNull(ctx, WIDGET_UPDATES_CLAIM);
    if (left === UNREADABLE) return added; // try again on the next merge; never delete it unread
    added += await mergeText(ctx, d, left);
    local.remove(WIDGET_UPDATES_CLAIM);
  }
  if (!local.exists(WIDGET_UPDATES_FILE)) return added;
  const first = await readOrNull(ctx, WIDGET_UPDATES_FILE);
  if (first === UNREADABLE) return added; // a read hiccup: leave the widget's file for the next merge
  added += await mergeText(ctx, d, first);
  // Hand-off: from here on, a widget write creates a new file instead of being deleted with this one.
  try {
    local.move(WIDGET_UPDATES_FILE, WIDGET_UPDATES_CLAIM);
  } catch {
    return added; // the widget is replacing it right now: its new file is merged next time
  }
  const claimed = await readOrNull(ctx, WIDGET_UPDATES_CLAIM);
  if (claimed === UNREADABLE) return added; // kept as the claim file: merged first next time
  if (claimed !== first) added += await mergeText(ctx, d, claimed); // the widget wrote between our read and the move
  local.remove(WIDGET_UPDATES_CLAIM);
  return added;
}

const UNREADABLE = Symbol('unreadable');

async function readOrNull(ctx: Ctx, path: string): Promise<string | null | typeof UNREADABLE> {
  try {
    return await ctx.platform.local.readText(path);
  } catch (err) {
    ctx.platform.log('warn', `${path} can't be read right now (kept for the next merge): ${errorMessage(err)}`);
    return UNREADABLE;
  }
}

async function mergeText(ctx: Ctx, d: MergeDeps, text: string | null): Promise<number> {
  if (!text) return 0;
  let records: WidgetRecord[];
  try {
    records = parseRecords(JSON.parse(text));
  } catch (err) {
    ctx.platform.log('warn', `widget-updates.json unreadable, dropped: ${errorMessage(err)}`);
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
  if (changed) d.library.emitChanged();
  if (records.length > 0) ctx.platform.log('info', `Merged ${records.length} widget update record(s): ${added} new chapter(s)`);
  return added;
}
