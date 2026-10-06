/**
 * Single-instance guard. Two TachiNovel runs at once (e.g. a widget deep link while the app is open)
 * would write the same files concurrently. The running instance keeps a lock file in local storage
 * (`run.lock`: {id, startedAt, heartbeat}) fresh; a second instance finds a fresh heartbeat and backs
 * off, or takes over when it is stale (the previous run was killed or suspended for > LOCK_STALE_MS).
 * An instance whose lock was taken over notices on its next heartbeat and stops.
 */
import type { Platform } from '../../shared/contracts/platform.ts';
import { errorMessage } from '../lib/errors.ts';
import { isRecord } from '../lib/validate.ts';

export const RUN_LOCK_FILE = 'run.lock';
/** A deep link handed from a second launch to the running instance. */
export const PENDING_LINK_FILE = 'pending-link.json';
/** Older pending links are ignored (the user has moved on). */
export const PENDING_LINK_MAX_AGE_MS = 60_000;

export interface PendingLink {
  pluginId: string;
  novelPath: string;
  chapterPath?: string;
}

/** Second instance: leave the deep link for the running one (it polls on its heartbeat). */
export async function writePendingLink(platform: Pick<Platform, 'local' | 'now'>, link: PendingLink): Promise<void> {
  await platform.local.writeText(PENDING_LINK_FILE, JSON.stringify({ ...link, at: platform.now() }));
}

/**
 * A launch that found another instance running: leave its deep link (if any) for the running instance and
 * report what happened. Never shows UI — the caller just exits (Script.complete()).
 */
export async function handleBusyLaunch(platform: Pick<Platform, 'local' | 'now'>, link: PendingLink | null): Promise<'handed-over' | 'exit'> {
  if (!link) return 'exit';
  await writePendingLink(platform, link);
  return 'handed-over';
}

/** Running instance: take (and remove) a pending deep link, if a fresh one is there. */
export async function takePendingLink(platform: Pick<Platform, 'local' | 'now'>): Promise<PendingLink | null> {
  const { local } = platform;
  if (!local.exists(PENDING_LINK_FILE)) return null;
  let v: unknown;
  try {
    const text = await local.readText(PENDING_LINK_FILE);
    v = text ? JSON.parse(text) : null;
  } catch {
    v = null;
  }
  local.remove(PENDING_LINK_FILE);
  if (!isRecord(v) || typeof v.pluginId !== 'string' || typeof v.novelPath !== 'string' || !v.pluginId || !v.novelPath) return null;
  if (typeof v.at !== 'number' || platform.now() - v.at > PENDING_LINK_MAX_AGE_MS) return null;
  const link: PendingLink = { pluginId: v.pluginId, novelPath: v.novelPath };
  if (typeof v.chapterPath === 'string' && v.chapterPath) link.chapterPath = v.chapterPath;
  return link;
}
export const LOCK_STALE_MS = 10_000;
export const HEARTBEAT_MS = 3_000;

interface LockFile {
  id: string;
  startedAt: number;
  heartbeat: number;
}

export interface RunLock {
  readonly id: string;
  /** 'acquired', or 'busy' when another instance holds a fresh lock. */
  acquire(): Promise<'acquired' | 'busy'>;
  /** Claim the lock even if another instance holds it (newest launch wins; the old one stops on its next heartbeat). */
  takeOver(): Promise<void>;
  /**
   * Keep the lock fresh; `onLost` runs once if another instance takes it over. `onBeat` runs after
   * every heartbeat (e.g. to pick up a pending deep link).
   */
  startHeartbeat(onLost: () => void, onBeat?: () => Promise<void>): void;
  /** Stop the heartbeat and remove the lock if it is still ours. */
  release(): Promise<void>;
}

export function newRunId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createRunLock(platform: Pick<Platform, 'local' | 'now' | 'sleep' | 'log'>, id: string = newRunId(platform.now())): RunLock {
  const { local } = platform;
  let beating = false;
  let startedAt = 0;

  async function read(): Promise<LockFile | null> {
    try {
      const text = await local.readText(RUN_LOCK_FILE);
      const v: unknown = text ? JSON.parse(text) : null;
      if (isRecord(v) && typeof v.id === 'string' && typeof v.heartbeat === 'number') {
        return { id: v.id, heartbeat: v.heartbeat, startedAt: typeof v.startedAt === 'number' ? v.startedAt : v.heartbeat };
      }
    } catch {
      // unreadable lock → treat as absent
    }
    return null;
  }

  async function write(): Promise<void> {
    const lock: LockFile = { id, startedAt, heartbeat: platform.now() };
    await local.writeText(RUN_LOCK_FILE, JSON.stringify(lock));
  }

  return {
    id,
    async acquire() {
      const current = await read();
      const now = platform.now();
      if (current && current.id !== id && now - current.heartbeat <= LOCK_STALE_MS && current.heartbeat <= now + LOCK_STALE_MS) return 'busy';
      if (current && current.id !== id) platform.log('info', `Run lock: taking over from stale instance ${current.id}`);
      startedAt = now;
      await write();
      // Two instances starting at the same moment: whoever wrote last wins; the other backs off.
      const check = await read();
      return check?.id === id ? 'acquired' : 'busy';
    },
    async takeOver() {
      const current = await read();
      if (current && current.id !== id) platform.log('info', `Run lock: newest launch takes over from ${current.id}`);
      startedAt = platform.now();
      await write();
    },
    startHeartbeat(onLost, onBeat) {
      if (beating) return;
      beating = true;
      void (async () => {
        while (beating) {
          await platform.sleep(HEARTBEAT_MS);
          if (!beating) return;
          try {
            const current = await read();
            if (current && current.id !== id) {
              beating = false;
              platform.log('warn', `Run lock taken over by ${current.id}; stopping`);
              onLost();
              return;
            }
            await write();
            await onBeat?.();
          } catch (err) {
            platform.log('warn', `Run lock heartbeat failed: ${errorMessage(err)}`);
          }
        }
      })();
    },
    async release() {
      beating = false;
      const current = await read();
      if (current?.id === id) {
        try {
          local.remove(RUN_LOCK_FILE);
        } catch (err) {
          platform.log('warn', `Run lock release failed: ${errorMessage(err)}`);
        }
      }
    },
  };
}
