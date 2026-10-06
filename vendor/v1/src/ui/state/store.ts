/**
 * App-wide state (signals): boot payload, settings, library, categories, sources, update progress.
 * Mutations are optimistic: the UI updates immediately and the bridge call follows.
 */
import { batch, computed, signal } from '@preact/signals';
import type {
  AppSettings,
  Category,
  HistoryEntry,
  LibraryEntry,
  SourceInfo,
} from '../../shared/contracts/domain.ts';
import type { BridgeEvents, DeepPartial } from '../../shared/contracts/protocol.ts';
import { bridge, toUiError, type UiError } from '../bridge/client.ts';
import { SYMBOL_NAMES } from '../components/icons.ts';
import { deepMerge } from '../lib/merge.ts';
import { DEFAULT_SETTINGS } from './defaults.ts';
import { push } from './nav.ts';

export const booted = signal(false);
export const bootError = signal<UiError | null>(null);
export const buildVersion = signal('');
export const settings = signal<AppSettings>(DEFAULT_SETTINGS);
export const library = signal<LibraryEntry[]>([]);
export const categories = signal<Category[]>([]);
export const sources = signal<SourceInfo[]>([]);
export const recent = signal<HistoryEntry[]>([]);
export const symbols = signal<Record<string, string>>({});
export const updatesProgress = signal<BridgeEvents['updates.progress'] | null>(null);
/** Bumped whenever reading progress changes (reader → novel page / history refresh). */
export const progressVersion = signal(0);
/** Unread entries in Updates (tab badge). */
export const updatesBadge = signal(0);

export const libraryKeys = computed(() => new Set(library.value.map((e) => e.key)));
export const sortedCategories = computed(() => [...categories.value].sort((a, b) => a.order - b.order));

export function isInLibrary(pluginId: string, path: string): boolean {
  return libraryKeys.value.has(`${pluginId}:${path}`);
}

export function sourceById(id: string): SourceInfo | undefined {
  return sources.value.find((s) => s.id === id);
}

export async function boot(): Promise<void> {
  bootError.value = null;
  try {
    const b = await bridge().call('app.boot');
    batch(() => {
      buildVersion.value = b.buildVersion;
      settings.value = b.settings;
      library.value = b.library;
      categories.value = b.categories;
      sources.value = b.sources;
      recent.value = b.recent;
      symbols.value = b.symbols;
      booted.value = true;
    });
    void loadSymbols(b.symbols);
    void refreshUpdatesBadge();
    // Home-screen widget: open the novel (and the chapter) it points at.
    if (b.deepLink) {
      const { pluginId, novelPath, chapterPath } = b.deepLink;
      const entry = b.library.find((e) => e.pluginId === pluginId && e.path === novelPath);
      push({ name: 'novel', pluginId, path: novelPath, ...(entry ? { preview: entry } : {}) });
      if (chapterPath) push({ name: 'reader', pluginId, novelPath, chapterPath, ...(entry ? { novelName: entry.name } : {}) });
    }
    if (b.settings.library.updateOnOpen && b.library.length > 0) {
      // Lazy import avoids a store ↔ actions cycle at module init.
      void import('./actions.ts').then((m) => m.checkLibraryUpdates());
    }
  } catch (err) {
    bootError.value = toUiError(err);
  }
}

async function loadSymbols(have: Record<string, string>): Promise<void> {
  const missing = SYMBOL_NAMES.filter((n) => !(n in have));
  if (missing.length === 0) return;
  try {
    const got = await bridge().call('native.symbols', { names: missing, size: 64 });
    if (Object.keys(got).length > 0) symbols.value = { ...symbols.value, ...got };
  } catch {
    // Fallback SVG icons stay in place.
  }
}

export async function refreshUpdatesBadge(): Promise<void> {
  try {
    const list = await bridge().call('updates.list', { limit: 200 });
    updatesBadge.value = list.filter((u) => !u.read).length;
  } catch {
    // keep last value
  }
}

// ---------- settings ----------

let pendingPatch: DeepPartial<AppSettings> | null = null;
let patchTimer = 0;

/** Apply locally now; persist (debounced for sliders/steppers). */
export function patchSettings(patch: DeepPartial<AppSettings>, debounceMs = 0): void {
  settings.value = deepMerge(settings.value, patch);
  pendingPatch = pendingPatch ? deepMerge(pendingPatch, patch) : patch;
  window.clearTimeout(patchTimer);
  if (debounceMs > 0) patchTimer = window.setTimeout(flushSettings, debounceMs);
  else flushSettings();
}

export function flushSettings(): void {
  window.clearTimeout(patchTimer);
  const patch = pendingPatch;
  pendingPatch = null;
  if (!patch) return;
  bridge()
    .call('settings.set', { patch })
    .catch(() => undefined);
}

// ---------- library ----------

export async function reloadLibrary(): Promise<void> {
  try {
    library.value = await bridge().call('library.list');
  } catch {
    // keep
  }
}

export function upsertLibraryEntry(e: LibraryEntry): void {
  const list = library.value.filter((x) => x.key !== e.key);
  list.push(e);
  library.value = list;
}

export function removeLibraryEntries(keys: readonly string[]): LibraryEntry[] {
  const set = new Set(keys);
  const removed = library.value.filter((e) => set.has(e.key));
  library.value = library.value.filter((e) => !set.has(e.key));
  return removed;
}

export async function reloadSources(): Promise<void> {
  try {
    sources.value = await bridge().call('sources.list');
  } catch {
    // keep
  }
}

export function installEventListeners(): void {
  const b = bridge();
  b.on('library.changed', (p) => {
    library.value = p.library;
  });
  b.on('updates.progress', (p) => {
    updatesProgress.value = p.finished ? null : p;
    if (p.finished) void refreshUpdatesBadge();
  });
  b.on('app.error', (p) => {
    console.warn('[script error]', p.message);
  });
}
