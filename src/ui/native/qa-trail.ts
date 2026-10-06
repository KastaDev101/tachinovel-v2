/**
 * The phone QA loop's UI event trail (qa-folder.ts): the last screens, tabs and JS errors, kept tiny in
 * localStorage and copied into the diagnostics folder by the native side. Screen names carry novel titles
 * and source ids, never chapter text, library lists or search terms.
 */
import type { Route } from '@v1/ui/state/nav.ts';

export const TRAIL_KEY = 'tachinovel.v2.trail';
export const TRAIL_MAX = 60;

export interface TrailEntry {
  /** ISO time */
  t: string;
  e: 'screen' | 'tab' | 'error';
  d: string;
}

/** One line per screen, readable in a log: "reader: Shadow Slave › novel/x/12". */
export function describeRoute(r: Route): string {
  switch (r.name) {
    case 'novel':
      return `novel: ${r.preview?.name ?? r.path} (${r.pluginId})`;
    case 'reader':
      return `reader: ${r.novelName ?? ''} › ${r.chapterPath} (${r.pluginId})`;
    case 'source':
      return `source: ${r.pluginId}${r.mode ? ` ${r.mode}` : ''}`;
    case 'settings':
      return `settings: ${r.page}`;
    case 'genre':
      return `genre: ${r.genre}`;
    case 'sourceSettings':
      return `sourceSettings: ${r.pluginId}`;
    case 'migrateSearch':
      return `migrateSearch: ${r.pluginId}`;
    case 'globalSearch': // no query text: searches stay private
    case 'tabs':
    case 'latest':
    case 'forYou':
    case 'stats':
    case 'migrate':
    case 'diagnostics':
    case 'help':
    case 'narration':
      return r.name;
  }
}

export function pushTrail(entry: Omit<TrailEntry, 't'>, store: Storage | null = safeStorage(), now = new Date()): void {
  if (!store) return;
  try {
    const list = JSON.parse(store.getItem(TRAIL_KEY) ?? '[]') as TrailEntry[];
    list.push({ t: now.toISOString(), ...entry, d: entry.d.slice(0, 200) });
    store.setItem(TRAIL_KEY, JSON.stringify(list.slice(-TRAIL_MAX)));
  } catch {
    // a broken or full store only costs the trail
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
