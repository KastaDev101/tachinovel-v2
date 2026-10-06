/**
 * storage.usage: bytes per category. FileManager.fileSize only reports whole KB, so categories with an
 * index use the exact sizes recorded when files were written (cache, covers: LRU index; downloads:
 * manifests); the rest are measured on disk (KB-granular).
 */
import type { StorageUsage } from '../../shared/contracts/domain.ts';
import { MB } from './context.ts';
import type { Services } from './services.ts';

/** Synced user state (the synced root also holds app code and logs, which are excluded). */
const SYNCED_STATE = ['settings.json', 'library.json', 'history.json', 'updates.json', 'progress', 'sources', 'downloads-queue.json', 'backups'];
const LOCAL_STATE = ['plugin-data', 'symbols.json'];

export async function storageUsage(s: Services): Promise<StorageUsage> {
  const { local, synced } = s.ctx.platform;
  let state = 0;
  for (const p of SYNCED_STATE) state += synced.size(p);
  for (const p of LOCAL_STATE) state += local.size(p);
  await Promise.all([s.chapters.cache.init(), s.covers.lru.init()]);
  const settings = s.ctx.settings();
  return {
    bytes: {
      state,
      meta: local.size('meta'),
      cache: s.chapters.cache.bytes,
      covers: s.covers.lru.bytes,
      downloads: await s.downloads.totalBytes(),
      // Device log + its iCloud mirror (the same folder when iCloud is unavailable).
      logs: local.size('logs') + (synced.root === local.root ? 0 : synced.size('logs')),
    },
    caps: { cacheBytes: settings.cacheCapMB * MB, coverBytes: settings.coverCapMB * MB },
  };
}
