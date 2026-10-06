/**
 * Launch-time housekeeping (runs after boot, in the background): leftovers of writes cut short when the
 * app was closed or killed mid-save are healed. Listing a folder through the FileStore does the work
 * (lib/file-store.ts): stale temp files are removed, orphaned complete ones become the file. iCloud
 * conflict copies of state files are reported (findConflictCopies).
 */
import { errorMessage } from '../lib/errors.ts';
import type { Ctx } from './context.ts';
import { DOWNLOADS_DIR } from './downloads.ts';

/** Folders that hold app state, per store. */
const SYNCED_DIRS = ['', 'progress', 'sources', 'sources/plugins', 'backups'];
const LOCAL_DIRS = ['', 'meta', 'cache', 'covers', 'plugin-data'];

/**
 * iCloud conflict copies of state files ("library 2.json", "settings (1).json", …): made when two
 * devices (or two app instances) changed a file at once. The app only reads the real file, so their
 * content would be ignored silently. Found at launch and logged once (one warning, visible in
 * Diagnostics); never read, merged or deleted here — the user decides what to do with them.
 */
const CONFLICT_RE = /^(.+?)(?: \d+| \(\d+\))(\.[A-Za-z0-9]+)$/;

export function findConflictCopies(ctx: Pick<Ctx, 'platform'>): string[] {
  const { synced, local } = ctx.platform;
  if (synced.root === local.root) return []; // no iCloud: no conflict copies
  const found: string[] = [];
  for (const dir of SYNCED_DIRS) {
    let names: string[];
    try {
      names = synced.list(dir);
    } catch {
      continue; // sweepTempFiles reports unlistable folders
    }
    const present = new Set(names);
    for (const name of names) {
      const m = CONFLICT_RE.exec(name);
      // Only copies of a file that exists next to them (so a real name with a number isn't flagged).
      if (m && present.has(`${m[1] as string}${m[2] as string}`)) found.push(dir ? `${dir}/${name}` : name);
    }
  }
  if (found.length > 0) {
    const shown = found.slice(0, 10).join(', ') + (found.length > 10 ? ` and ${found.length - 10} more` : '');
    ctx.platform.log('warn', `iCloud conflict copies found (not read, not changed; the real files are used): ${shown}`);
  }
  return found;
}

export function sweepTempFiles(ctx: Pick<Ctx, 'platform'>): number {
  const { synced, local } = ctx.platform;
  let dirs = 0;
  const visit = (store: typeof local, dir: string): string[] => {
    try {
      dirs++;
      return store.list(dir);
    } catch (err) {
      ctx.platform.log('warn', `Housekeeping: can't list ${dir || '(root)'}: ${errorMessage(err)}`);
      return [];
    }
  };
  if (synced.root !== local.root) for (const d of SYNCED_DIRS) visit(synced, d);
  for (const d of LOCAL_DIRS) visit(local, d);
  // Each downloaded novel has its own folder.
  for (const name of visit(local, DOWNLOADS_DIR)) visit(local, `${DOWNLOADS_DIR}/${name}`);
  return dirs;
}
