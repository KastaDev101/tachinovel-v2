/**
 * Navigation stack. The root entry is the tab bar container; pushed screens slide over it (iOS
 * push/pop, interactive edge-swipe back). The Navigator component registers the animator.
 */
import { computed, signal } from '@preact/signals';
import type { NovelSummary } from '../../shared/contracts/domain.ts';
import type { FilterValues } from '../lib/filters.ts';

export type SettingsPage =
  | 'general'
  | 'downloads'
  | 'backup'
  | 'appearance'
  | 'reader'
  | 'library'
  | 'categories'
  | 'storage'
  | 'sources'
  | 'about'
  | 'licenses'
  | 'developer'
  /** Reader › Text cleanup rules. */
  | 'cleanup';

export type Route =
  | { name: 'tabs' }
  | { name: 'novel'; pluginId: string; path: string; preview?: NovelSummary }
  | { name: 'reader'; pluginId: string; novelPath: string; chapterPath: string; novelName?: string }
  | { name: 'source'; pluginId: string; query?: string; openFilters?: boolean; filters?: FilterValues; mode?: 'popular' | 'latest' }
  | { name: 'globalSearch'; query?: string }
  /** Cross-source genre search; `pluginId` (the novel's own source) is listed first. */
  | { name: 'genre'; genre: string; pluginId?: string }
  /** Latest novels from every browsable source. */
  | { name: 'latest' }
  | { name: 'settings'; page: SettingsPage }
  /** More › Reading Insights. */
  | { name: 'stats' }
  /** More › Migrate: library list, then (with a novel) its matches on other sources. */
  | { name: 'migrate' }
  | { name: 'migrateSearch'; pluginId: string; path: string }
  /** More › About › Diagnostics. */
  | { name: 'diagnostics' }
  /** More › Help & Tips. */
  | { name: 'help' };

export interface StackEntry {
  id: number;
  route: Route;
}

export type TabName = 'library' | 'updates' | 'history' | 'browse' | 'more';

export const stack = signal<StackEntry[]>([{ id: 0, route: { name: 'tabs' } }]);
export const topId = computed(() => stack.value[stack.value.length - 1]?.id ?? 0);
export const activeTab = signal<TabName>('library');
/** Incremented when the active tab is tapped again (scroll to top). */
export const tabReselect = signal<{ tab: TabName; n: number }>({ tab: 'library', n: 0 });

export interface Animator {
  /** Called after the new top layer has mounted. */
  push(fromId: number, toId: number): Promise<void>;
  pop(fromId: number, toId: number): Promise<void>;
  /** Finish any running transition immediately. */
  settle(): void;
}

let animator: Animator | null = null;
let seq = 1;
let popping = false;

export function registerAnimator(a: Animator | null): void {
  animator = a;
}

/** Entry id that should animate in once mounted (consumed by the Navigator). */
export let pendingPush: { from: number; to: number } | null = null;

export function consumePendingPush(): { from: number; to: number } | null {
  const p = pendingPush;
  pendingPush = null;
  return p;
}

export function push(route: Route): void {
  animator?.settle();
  const from = topId.value;
  const entry: StackEntry = { id: seq++, route };
  pendingPush = { from, to: entry.id };
  stack.value = [...stack.value, entry];
}

/** Replace the top screen without animation (e.g. reader → next chapter is handled inside). */
export function replaceTop(route: Route): void {
  const s = stack.value;
  if (s.length <= 1) return push(route);
  stack.value = [...s.slice(0, -1), { id: seq++, route }];
}

export function pop(): void {
  const s = stack.value;
  if (s.length <= 1 || popping) return;
  animator?.settle();
  const from = s[s.length - 1];
  const to = s[s.length - 2];
  if (!from || !to) return;
  popping = true;
  const done = (): void => {
    popping = false;
    stack.value = stack.value.filter((e) => e.id !== from.id);
  };
  if (animator) animator.pop(from.id, to.id).then(done, done);
  else done();
}

/** Remove the top entry immediately (used by the interactive swipe after it animated itself). */
export function dropTop(): void {
  const s = stack.value;
  if (s.length <= 1) return;
  stack.value = s.slice(0, -1);
}

export function popToRoot(): void {
  animator?.settle();
  stack.value = stack.value.slice(0, 1);
}

export function selectTab(tab: TabName): void {
  if (activeTab.value === tab) {
    tabReselect.value = { tab, n: tabReselect.value.n + 1 };
  } else {
    activeTab.value = tab;
  }
}

export function openNovel(n: NovelSummary): void {
  push({ name: 'novel', pluginId: n.pluginId, path: n.path, preview: n });
}

export function openReader(pluginId: string, novelPath: string, chapterPath: string, novelName?: string): void {
  push({ name: 'reader', pluginId, novelPath, chapterPath, ...(novelName !== undefined ? { novelName } : {}) });
}
