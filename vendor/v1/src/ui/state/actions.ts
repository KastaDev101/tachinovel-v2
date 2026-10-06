/** User actions shared by several screens (optimistic, with toasts and Undo). */
import type { LibraryEntry, NovelDetails, NovelKey, NovelSummary } from '../../shared/contracts/domain.ts';
import type { NativeAction } from '../../shared/contracts/protocol.ts';
import { bridge, errorText, toUiError } from '../bridge/client.ts';
import { pickCategories } from '../components/category-picker.tsx';
import { plural } from '../lib/format.ts';
import {
  categories,
  library,
  libraryKeys,
  patchSettings,
  progressVersion,
  refreshUpdatesBadge,
  reloadLibrary,
  removeLibraryEntries,
  settings,
  sortedCategories,
  upsertLibraryEntry,
  updatesProgress,
} from './store.ts';
import { errorToast, showToast } from './toast.ts';

/** Native iOS action sheet. Resolves to the chosen index or -1 (cancelled / unavailable). */
export async function actionSheet(opts: { title?: string; message?: string; actions: NativeAction[]; cancel?: string }): Promise<number> {
  try {
    const r = await bridge().call('native.actionSheet', opts);
    return r.index >= 0 && r.index < opts.actions.length ? r.index : -1;
  } catch {
    return -1;
  }
}

export async function confirmAlert(title: string, message: string, action: string, destructive = true): Promise<boolean> {
  try {
    const r = await bridge().call('native.alert', { title, message, actions: [{ title: action, destructive }], cancel: 'Cancel' });
    return r.index === 0;
  } catch {
    return false;
  }
}

export function openInSafari(url: string | undefined): void {
  if (!url) return;
  bridge()
    .call('native.openUrl', { url })
    .catch(() => errorToast('Couldn’t open Safari'));
}

export function share(text: string, url?: string): void {
  bridge()
    .call('native.share', { text, ...(url ? { url } : {}) })
    .catch(() => undefined);
}

function keyOf(k: NovelKey): string {
  return `${k.pluginId}:${k.path}`;
}

/** Adds still waiting for the script (a "Change" right after adding waits for its add). */
const pendingAdds = new Map<string, Promise<boolean>>();

/**
 * Plain add. Without `categoryIds` the script picks the categories (settings.library.addTo);
 * `expectedCategoryIds` is only what the optimistic entry shows until the script answers.
 */
export function addToLibrary(
  novel: NovelSummary | NovelDetails,
  opts: { toast?: boolean; categoryIds?: string[]; expectedCategoryIds?: string[]; toastText?: string; toastAction?: { label: string; run: () => void } } = {},
): Promise<boolean> {
  const key = keyOf(novel);
  if (libraryKeys.value.has(key)) return pendingAdds.get(key) ?? Promise.resolve(true);
  const p = addNow(novel, key, opts).finally(() => pendingAdds.delete(key));
  pendingAdds.set(key, p);
  return p;
}

async function addNow(
  novel: NovelSummary | NovelDetails,
  key: string,
  opts: { toast?: boolean; categoryIds?: string[]; expectedCategoryIds?: string[]; toastText?: string; toastAction?: { label: string; run: () => void } },
): Promise<boolean> {
  const temp: LibraryEntry = {
    key,
    pluginId: novel.pluginId,
    path: novel.path,
    name: novel.name,
    ...(novel.cover !== undefined ? { cover: novel.cover } : {}),
    addedAt: Date.now(),
    chapterCount: 0,
    unreadCount: 0,
    downloadedCount: 0,
    categoryIds: opts.categoryIds ?? opts.expectedCategoryIds ?? [],
  };
  upsertLibraryEntry(temp);
  if (opts.toast) {
    const action = opts.toastAction ?? { label: 'Undo', run: () => void removeNow([novel]) };
    // A little longer than an Undo toast: "Change" is how a one-tap add picks other categories.
    showToast(opts.toastText ?? 'Added to Library', { undo: action.run, actionLabel: action.label, durationMs: opts.toastAction ? 6000 : 4500 });
  }
  try {
    const summary: NovelSummary = { pluginId: novel.pluginId, path: novel.path, name: novel.name, ...(novel.cover !== undefined ? { cover: novel.cover } : {}) };
    const e = await bridge().call('library.add', { novel: 'genres' in novel ? novel : summary, ...(opts.categoryIds ? { categoryIds: opts.categoryIds } : {}) });
    if (libraryKeys.value.has(key)) upsertLibraryEntry(e);
    return true;
  } catch (err) {
    removeLibraryEntries([key]);
    errorToast(`Couldn’t add to library: ${errorText(toUiError(err))}`);
    return false;
  }
}

// ---------- categories on add (Tachimanga-style) ----------

function knownIds(ids: readonly string[]): string[] {
  const known = new Set(categories.peek().map((c) => c.id));
  return [...new Set(ids)].filter((id) => known.has(id));
}

/** Where a one-tap add goes (mirrors the script's settings.library.addTo); null = ask first. */
export function quickAddTarget(): string[] | null {
  if (categories.peek().length === 0) return [];
  const lib = settings.peek().library;
  if (lib.addTo === 'ask') return null;
  return knownIds(lib.addTo === 'last' ? lib.lastAddCategoryIds : [lib.addTo]);
}

/** "Reading", "Reading & Later", "3 categories", "Default" (no category) or "Library" (none exist). */
export function categoryLabel(ids: readonly string[]): string {
  const cats = sortedCategories.peek();
  if (cats.length === 0) return 'Library';
  const names = cats.filter((c) => ids.includes(c.id)).map((c) => c.name);
  if (names.length === 0) return 'Default';
  if (names.length <= 2) return names.join(' & ');
  return `${names.length} categories`;
}

/** The script remembers explicit choices (add with categoryIds, setCategories); mirror that locally. */
function rememberLastAdd(ids: string[]): void {
  const s = settings.peek();
  const last = s.library.lastAddCategoryIds;
  if (last.length === ids.length && last.every((id, i) => id === ids[i])) return;
  settings.value = { ...s, library: { ...s.library, lastAddCategoryIds: [...ids] } };
}

/**
 * "Add to Library" everywhere. One tap adds to the last-used categories (or the fixed one from
 * settings) with a toast "Added to Reading · Change"; settings "Ask every time" or `pick`
 * (long-press) opens the picker first with the last-used categories preselected.
 */
export async function quickAddToLibrary(novel: NovelSummary | NovelDetails, opts: { pick?: boolean } = {}): Promise<boolean> {
  const key = keyOf(novel);
  if (libraryKeys.peek().has(key)) return true;
  const target = quickAddTarget();
  if (categories.peek().length > 0 && (opts.pick || target === null)) {
    const ids = await pickCategories({
      title: 'Add to Library',
      selected: target ?? knownIds(settings.peek().library.lastAddCategoryIds),
      confirmLabel: 'Add',
    });
    if (ids === null) return false;
    rememberLastAdd(ids);
    return addToLibrary(novel, { categoryIds: ids, toast: true, toastText: `Added to ${categoryLabel(ids)}` });
  }
  const expected = target ?? [];
  if (categories.peek().length === 0) return addToLibrary(novel, { toast: true });
  return addToLibrary(novel, {
    expectedCategoryIds: expected,
    toast: true,
    toastText: `Added to ${categoryLabel(expected)}`,
    toastAction: { label: 'Change', run: () => void changeCategories([key]) },
  });
}

/** Category picker for library entries (checked = categories they all share); saves with setCategories. */
export async function changeCategories(keys: string[], opts: { title?: string } = {}): Promise<boolean> {
  await Promise.all(keys.map((k) => pendingAdds.get(k)).filter((p) => p !== undefined));
  const entries = library.peek().filter((e) => keys.includes(e.key));
  if (entries.length === 0) return false;
  const shared = (entries[0]?.categoryIds ?? []).filter((id) => entries.every((e) => e.categoryIds.includes(id)));
  const ids = await pickCategories({ title: opts.title ?? (entries.length === 1 ? 'Set Categories' : `Move ${plural(entries.length, 'novel')}`), selected: shared });
  if (ids === null) return false;
  const set = new Set(entries.map((e) => e.key));
  library.value = library.value.map((e) => (set.has(e.key) ? { ...e, categoryIds: ids } : e));
  rememberLastAdd(ids);
  try {
    const fresh = await bridge().call('library.setCategories', { keys: [...set], categoryIds: ids });
    const freshKeys = new Set(fresh.map((e) => e.key));
    library.value = [...fresh, ...library.peek().filter((e) => !freshKeys.has(e.key) && pendingAdds.has(e.key))];
    showToast(entries.length === 1 ? `Moved to ${categoryLabel(ids)}` : `Moved ${plural(entries.length, 'novel')} to ${categoryLabel(ids)}`);
    return true;
  } catch (err) {
    errorToast(`Couldn’t change categories: ${errorText(toUiError(err))}`);
    void reloadLibrary();
    return false;
  }
}

/** Removes now (after any add still in flight for the same novel, so a quick Add → Undo sticks). */
async function removeNow(novels: NovelKey[]): Promise<void> {
  const keys = novels.map(keyOf);
  removeLibraryEntries(keys);
  await Promise.all(
    novels.map(async (n) => {
      await pendingAdds.get(keyOf(n));
      await bridge()
        .call('library.remove', { pluginId: n.pluginId, path: n.path })
        .catch(() => undefined);
    }),
  );
  void reloadLibrary();
}

function summaryOf(e: LibraryEntry): NovelSummary {
  return { pluginId: e.pluginId, path: e.path, name: e.name, ...(e.cover !== undefined ? { cover: e.cover } : {}) };
}

/**
 * Remove with Undo. Committed to the script at once (closing the app right after can't lose it);
 * Undo adds the novels back into their categories (progress and downloads are kept by the script).
 */
export function removeFromLibrary(novels: (NovelKey & { name: string })[]): void {
  const removed = library.peek().filter((e) => novels.some((n) => keyOf(n) === e.key));
  const done = removeNow(novels);
  const text = novels.length === 1 ? `Removed “${novels[0]?.name ?? ''}”` : `Removed ${plural(novels.length, 'novel')}`;
  showToast(text, { undo: () => void restoreRemoved(removed, done) });
}

async function restoreRemoved(entries: LibraryEntry[], removal: Promise<void>): Promise<void> {
  const have = libraryKeys.peek();
  library.value = [...library.peek(), ...entries.filter((e) => !have.has(e.key))];
  // Re-adding with categories counts as an explicit choice for the script; keep "last used" as it was.
  const last = [...settings.peek().library.lastAddCategoryIds];
  await removal;
  try {
    const back = await Promise.all(entries.map((e) => bridge().call('library.add', { novel: summaryOf(e), categoryIds: e.categoryIds })));
    for (const e of back) upsertLibraryEntry(e);
  } catch (err) {
    errorToast(`Couldn’t restore: ${errorText(toUiError(err))}`);
  }
  patchSettings({ library: { lastAddCategoryIds: last } });
  void reloadLibrary();
}

/** Mark every chapter of the given novels read/unread in one bridge call (optimistic). */
export async function markNovelsRead(entries: LibraryEntry[], read: boolean): Promise<void> {
  const keys = new Set(entries.map((e) => e.key));
  const before = library.value;
  library.value = library.value.map((e) => (keys.has(e.key) ? { ...e, unreadCount: read ? 0 : e.chapterCount } : e));
  try {
    const updated = await bridge().call('library.markRead', { keys: [...keys], read }, { timeoutMs: 120_000 });
    const byKey = new Map(updated.map((e) => [e.key, e]));
    library.value = library.value.map((e) => byKey.get(e.key) ?? e);
    progressVersion.value++;
    showToast(read ? `Marked ${plural(entries.length, 'novel')} as read` : `Marked ${plural(entries.length, 'novel')} as unread`);
  } catch (err) {
    library.value = before;
    errorToast(errorText(toUiError(err)));
  }
}

/** Library update check (pull-to-refresh). Progress arrives as `updates.progress` events. */
export async function checkLibraryUpdates(keys?: string[]): Promise<void> {
  if (updatesProgress.value) return;
  updatesProgress.value = { done: 0, total: keys?.length ?? library.value.length, newChapters: 0, finished: false };
  try {
    const r = await bridge().call('library.checkUpdates', keys ? { keys } : {}, { timeoutMs: 15 * 60_000 });
    showToast(r.newChapters > 0 ? `${plural(r.newChapters, 'new chapter')} found` : 'Your library is up to date');
  } catch (err) {
    errorToast(errorText(toUiError(err)));
  } finally {
    updatesProgress.value = null;
    void reloadLibrary();
    void refreshUpdatesBadge();
    progressVersion.value++;
  }
}
