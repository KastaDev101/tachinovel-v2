/**
 * Free-sideload storage layout: without iCloud, the synced store (library, progress, settings, sources,
 * backups, the log mirror) lives in the app's Documents folder, which Files shows as On My iPhone ›
 * TachiNovel (Info.plist: UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace). Builds before this
 * kept everything in the local store (Application Support/TachiNovel, invisible in Files).
 *
 * The one-time move is crash-safe and never deletes the only copy of anything:
 *  1. copy: every synced entry of the local folder (everything except the local-only caches below) is
 *     copied file by file into Documents, merging with what is there, and verified (same
 *     files, same sizes, same text for files up to 1 MB). Interrupted or failed → this launch keeps the
 *     old layout and the next launch resumes the copy (finished files are verified, not copied again);
 *  2. switch: only then is the marker `.layout.json` written (state "switched"), and the app uses
 *     Documents. The old copies stay in the local folder;
 *  3. confirm: once the UI's first `app.boot` has been answered from the new layout, the marker becomes
 *     "confirmed";
 *  4. clean up: at the NEXT launch the old copies of the known synced entries are removed from the local
 *     folder. Unknown names are copied but never removed (if one was a local-only file, it stays).
 *
 * Fresh installs (nothing to move) start in the new layout at once.
 */

/** The host file operations this needs (NativeHost['fs'] fits). Sync, throw on failure. */
export interface LayoutFs {
  readText(path: string): string | null;
  writeText(path: string, text: string): void;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  remove(path: string): void;
  move(from: string, to: string): void;
  copy(from: string, to: string): void;
  list(path: string): string[];
  size(path: string): number;
  mkdirp(path: string): void;
}

export interface LayoutMarker {
  version: 1;
  state: 'switched' | 'confirmed';
  /** Entries copied from the local folder (top-level names). */
  entries: string[];
  switchedAt: number;
  confirmedAt?: number;
  /** When the old copies were removed from the local folder. */
  cleanedAt?: number;
}

export interface LayoutResult {
  /** Use Documents as the synced store (false: keep the old layout this launch). */
  useDocuments: boolean;
  /** What happened this launch. */
  action: 'fresh' | 'migrated' | 'in-use' | 'cleaned' | 'failed';
  copied: string[];
  removed: string[];
  error?: string;
  /** Mark the new layout as working (call after the first successful app.boot). Idempotent. */
  confirm(): void;
}

export const MARKER = '.layout.json';
/** The next marker, complete before the old one is removed (readable if a crash hits in between). */
export const MARKER_NEXT = '.layout.json.new';
const VERIFY_TEXT_MAX_BYTES = 1024 * 1024;

/**
 * Local-only names (caches and device-only state): never copied. Everything else in the old local folder
 * is synced state and is copied, so a synced file this list doesn't know about is not left behind.
 */
export const LOCAL_ONLY = new Set([
  'meta',
  'cache',
  'covers',
  'downloads',
  'plugin-data',
  'symbols.json',
  'imports',
  'logs',
  'state-mirror',
  'run.lock',
  'run.next.json',
]);

/**
 * Synced entries whose old copies are removed after the switch is confirmed (v1 services: settings,
 * library, history, updates, stats, narration, downloads queue, flags, widget, deep link, progress,
 * sources, backups; v2: bundled plugins in app/, pronunciation lexicons). Add new synced files here.
 */
export const KNOWN_SYNCED = new Set([
  'settings.json',
  'library.json',
  'history.json',
  'updates.json',
  'stats.json',
  'audio.json',
  'narration-status.json',
  'narration-lexicons.json',
  'downloads-queue.json',
  'flags.json',
  'widget-updates.json',
  'widget-updates.claimed.json',
  'pending-link.json',
  'progress',
  'sources',
  'backups',
  'app',
]);

const join = (a: string, b: string): string => (a.endsWith('/') ? a + b : `${a}/${b}`);

function readMarker(fs: LayoutFs, docsDir: string): LayoutMarker | null {
  for (const name of [MARKER, MARKER_NEXT]) {
    const p = join(docsDir, name);
    if (!fs.exists(p)) continue;
    const text = fs.readText(p);
    try {
      const m = JSON.parse(text ?? '') as Partial<LayoutMarker>;
      if (m.version === 1 && (m.state === 'switched' || m.state === 'confirmed') && Array.isArray(m.entries)) return m as LayoutMarker;
    } catch {
      // fall through
    }
    // Present but unreadable: it is only ever written after a verified copy, so the new layout is
    // complete; without its list, nothing will be cleaned up.
    return { version: 1, state: 'switched', entries: [], switchedAt: 0 };
  }
  return null;
}

/**
 * Marker update with a readable marker at every instant: the new one is written completely (`.new`)
 * before the old one is removed, and a `.new` left by a crash is promoted before it could be overwritten.
 */
function writeMarker(fs: LayoutFs, docsDir: string, m: LayoutMarker): void {
  const next = join(docsDir, MARKER_NEXT);
  const final = join(docsDir, MARKER);
  if (fs.exists(next)) {
    if (fs.exists(final)) fs.remove(next); // a half-written .new: the marker in place is the valid one
    else fs.move(next, final); // the only marker a crash left: keep it readable
  }
  fs.writeText(next, `${JSON.stringify(m)}\n`);
  if (fs.exists(final)) fs.remove(final);
  fs.move(next, final);
}

function isTempName(name: string): boolean {
  return name.startsWith('.') || name.endsWith('.tmp');
}

function sameFile(fs: LayoutFs, a: string, b: string): boolean {
  if (!fs.exists(b) || fs.isDirectory(b)) return false;
  const size = fs.size(a);
  if (size !== fs.size(b)) return false;
  if (size > VERIFY_TEXT_MAX_BYTES) return true;
  return fs.readText(a) === fs.readText(b);
}

/** Copy `src` into `dst` (file, or folder merged recursively), replacing files that differ. */
function copyMerge(fs: LayoutFs, src: string, dst: string): void {
  if (fs.isDirectory(src)) {
    if (fs.exists(dst) && !fs.isDirectory(dst)) fs.remove(dst);
    fs.mkdirp(dst);
    for (const name of fs.list(src)) if (!isTempName(name)) copyMerge(fs, join(src, name), join(dst, name));
    return;
  }
  if (sameFile(fs, src, dst)) return;
  if (fs.exists(dst)) fs.remove(dst);
  fs.copy(src, dst);
}

/** Every file under `src` has an identical counterpart under `dst` (extra files in `dst` are fine). */
function verify(fs: LayoutFs, src: string, dst: string): string | null {
  if (fs.isDirectory(src)) {
    if (!fs.isDirectory(dst)) return dst;
    for (const name of fs.list(src)) {
      if (isTempName(name)) continue;
      const bad = verify(fs, join(src, name), join(dst, name));
      if (bad) return bad;
    }
    return null;
  }
  return sameFile(fs, src, dst) ? null : dst;
}

export function prepareDocumentsLayout(
  fs: LayoutFs,
  opts: { localDir: string; docsDir: string; now: () => number; log: (level: 'info' | 'warn', message: string) => void },
): LayoutResult {
  const { localDir, docsDir, now, log } = opts;
  let marker = readMarker(fs, docsDir);
  const confirm = (): void => {
    if (!marker || marker.state === 'confirmed') return;
    try {
      marker = { ...marker, state: 'confirmed', confirmedAt: now() };
      writeMarker(fs, docsDir, marker);
    } catch (err) {
      log('warn', `Storage layout: couldn't confirm the Documents layout: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (marker) {
    if (marker.state === 'confirmed' && marker.cleanedAt === undefined) {
      // A launch in the new layout worked: drop the old copies of known synced entries.
      const removed: string[] = [];
      for (const name of marker.entries) {
        const p = join(localDir, name);
        if (!KNOWN_SYNCED.has(name) || !fs.exists(p)) continue;
        try {
          fs.remove(p);
          removed.push(name);
        } catch (err) {
          log('warn', `Storage layout: couldn't remove the old copy of ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      try {
        marker = { ...marker, cleanedAt: now() };
        writeMarker(fs, docsDir, marker);
      } catch {
        // tried again next launch
      }
      if (removed.length > 0) log('info', `Storage layout: removed the old copies of ${removed.join(', ')} from the device-only folder`);
      return { useDocuments: true, action: 'cleaned', copied: [], removed, confirm };
    }
    return { useDocuments: true, action: 'in-use', copied: [], removed: [], confirm };
  }

  const entries = fs.exists(localDir) ? fs.list(localDir).filter((n) => !LOCAL_ONLY.has(n) && !isTempName(n)) : [];
  try {
    fs.mkdirp(docsDir);
    if (entries.length === 0) {
      marker = { version: 1, state: 'confirmed', entries: [], switchedAt: now(), confirmedAt: now(), cleanedAt: now() };
      writeMarker(fs, docsDir, marker);
      return { useDocuments: true, action: 'fresh', copied: [], removed: [], confirm };
    }
    for (const name of entries) copyMerge(fs, join(localDir, name), join(docsDir, name));
    for (const name of entries) {
      const bad = verify(fs, join(localDir, name), join(docsDir, name));
      if (bad) throw new Error(`verification failed at ${bad}`);
    }
    marker = { version: 1, state: 'switched', entries, switchedAt: now() };
    writeMarker(fs, docsDir, marker);
    log('info', `Storage layout: moved ${entries.join(', ')} to Documents (shown in Files); the old copies stay until the next launch`);
    return { useDocuments: true, action: 'migrated', copied: entries, removed: [], confirm };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log('warn', `Storage layout: keeping the device-only folder this launch (the move to Documents failed: ${error}); it is retried next launch`);
    marker = null;
    return { useDocuments: false, action: 'failed', copied: [], removed: [], error, confirm };
  }
}
