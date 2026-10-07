/**
 * Back to the same screen after iOS restarts the web view's content process.
 *
 * Under memory pressure (long reading sessions, huge chapter lists) iOS may kill WKWebView's content
 * process; Capacitor reloads the page (WebContentRecovery.swift notes it). The core runs natively and
 * keeps everything, but v1's screen stack lived in the page. So the stack and the selected tab are
 * remembered as they change (localStorage, a few hundred bytes), and when the native side reports a
 * termination, the reloaded UI rebuilds them once the library has painted. The reader then reopens the
 * chapter at its saved position (chapter.get returns it), and Narration keeps playing natively.
 * A normal launch never restores: only a reload after a termination does.
 */
import { effect } from '@preact/signals';
import { activeTab, type Route, stack, type TabName } from '@v1/ui/state/nav.ts';
import { sharedClient } from '../capacitor-client.ts';
import { whenLibraryVisible } from './boot-timing.ts';
import { TachiNative } from './prelude.ts';

export const ROUTE_KEY = 'tachinovel.v2.screen';
/** Older than this, the saved screen is stale (the reload follows the termination within seconds). */
const MAX_AGE_MS = 30 * 60 * 1000;

export interface SavedScreen {
  at: number;
  tab: TabName;
  /** Pushed screens over the tab bar, bottom to top. */
  routes: Route[];
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readSaved(now = Date.now()): SavedScreen | null {
  try {
    const v = JSON.parse(storage()?.getItem(ROUTE_KEY) ?? 'null') as SavedScreen | null;
    if (!v || typeof v.at !== 'number' || now - v.at > MAX_AGE_MS || !Array.isArray(v.routes)) return null;
    return v;
  } catch {
    return null;
  }
}

/** Remember the screen stack as it changes (debounced; navigation is a handful of writes a minute). */
export function rememberScreens(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  effect(() => {
    const routes = stack.value.map((e) => e.route).filter((r) => r.name !== 'tabs');
    const tab = activeTab.value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        storage()?.setItem(ROUTE_KEY, JSON.stringify({ at: Date.now(), tab, routes } satisfies SavedScreen));
      } catch {
        // storage full or unavailable: recovery just lands on the library
      }
    }, 250);
  });
}

/** Rebuild the saved stack (no push animations: the screens appear as they were). */
export function restore(saved: SavedScreen): void {
  activeTab.value = saved.tab;
  const root = stack.value[0] ?? { id: 0, route: { name: 'tabs' } as Route };
  const base = Date.now();
  stack.value = [root, ...saved.routes.map((route, i) => ({ id: base + i, route }))];
}

/** After a content-process termination: wait for the library, then put the user back. */
export async function installRecovery(): Promise<void> {
  const saved = readSaved();
  rememberScreens();
  const r = await TachiNative.consumeRecovery().catch(() => ({ terminations: 0 }));
  if (!r.terminations || !saved) return;
  await whenLibraryVisible(20_000);
  restore(saved);
  // warn: rare and worth seeing in Diagnostics (and `log show`, which the simulator smoke run checks).
  void sharedClient()
    .call('app.log', {
      level: 'warn',
      message: `recovery: the web view was restarted by iOS (${r.terminations}×); restored the ${saved.tab} tab and ${saved.routes.length} screen(s)`,
    })
    .catch(() => undefined);
}
