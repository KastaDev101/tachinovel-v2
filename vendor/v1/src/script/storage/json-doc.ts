/**
 * Versioned JSON documents with migrations and debounced atomic writes.
 *
 * Every persisted JSON file carries `schemaVersion`. On load, migrations run step by step
 * (v → v+1) and the upgraded document is written back. A corrupt file is moved aside
 * (`<path>.corrupt-<ts>`) and replaced with defaults instead of crashing the app.
 */
import type { FileStore, LogLevel } from '../../shared/contracts/platform.ts';
import { Debouncer } from '../lib/debounce.ts';
import { AppError, errorCode, errorMessage, storageError } from '../lib/errors.ts';
import { isRecord } from '../lib/validate.ts';

export interface Versioned {
  schemaVersion: number;
}

export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

export interface DocSpec<T extends Versioned> {
  /** Path relative to the store. */
  path: string;
  /** Current schema version. */
  version: number;
  create(): T;
  /** migrations[n] upgrades a v`n` document to v`n+1`. Files without schemaVersion count as v0. */
  migrations?: Readonly<Record<number, Migration>>;
  /** Fill defaults / drop invalid data after migrating. */
  normalize?(doc: T): T;
}

export interface DocEnv {
  sleep(ms: number): Promise<void>;
  now(): number;
  log(level: LogLevel, message: string, data?: unknown): void;
  /** A save failed (it is retried with the next change); services tell the user once (StorageAlarm). */
  writeFailed?(path: string, err: unknown): void;
}

export interface LoadedDoc<T> {
  value: T;
  /** No file existed. */
  fresh: boolean;
  /** Migrated or repaired; should be written back. */
  upgraded: boolean;
}

export interface ReadOptions {
  /**
   * Default true: a file whose migration/cleanup fails is moved aside and defaults are used. False
   * (read-only readers): the error is thrown instead and nothing is moved. A store that refuses the
   * move (the widget's read-only wrapper) gets the same: the problem is reported, never hidden.
   */
  repair?: boolean;
}

export async function readDoc<T extends Versioned>(store: FileStore, spec: DocSpec<T>, env: DocEnv, opts: ReadOptions = {}): Promise<LoadedDoc<T>> {
  let text: string | null;
  try {
    text = await store.readText(spec.path);
  } catch (err) {
    throw storageError('read', spec.path, err);
  }
  if (text === null) return { value: spec.create(), fresh: true, upgraded: false };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (!isRecord(raw)) return setAside(store, spec, env, 'Corrupt JSON');

  // Migrations and cleanup must never take the app down over one bad file: if they throw, the file is
  // treated like corrupt JSON (kept aside for recovery, defaults used, logged as an error).
  try {
    let doc: Record<string, unknown> = raw;
    const from = typeof doc.schemaVersion === 'number' && Number.isInteger(doc.schemaVersion) ? doc.schemaVersion : 0;
    let v = from;
    while (v < spec.version) {
      const m = spec.migrations?.[v];
      if (!m) throw new AppError('STORAGE', `No migration for ${spec.path} from schemaVersion ${v} to ${spec.version}`);
      doc = m(doc);
      if (!isRecord(doc)) throw new AppError('STORAGE', `Migration of ${spec.path} from schemaVersion ${v} returned no object`);
      v++;
      doc.schemaVersion = v;
    }
    if (v > spec.version) {
      env.log('warn', `${spec.path} has schemaVersion ${v}, newer than this build (${spec.version}); using it as-is`);
    }
    const typed = doc as unknown as T;
    const value = spec.normalize ? spec.normalize(typed) : typed;
    if (!isRecord(value)) throw new AppError('STORAGE', `Cleanup of ${spec.path} returned no object`);
    return { value, fresh: false, upgraded: from !== v };
  } catch (err) {
    const problem = err instanceof AppError ? err : new AppError('STORAGE', `${spec.path}: ${errorMessage(err)}`);
    if (opts.repair === false) throw problem;
    const aside = `${spec.path}.corrupt-${env.now()}`;
    try {
      store.move(spec.path, aside);
    } catch {
      throw problem; // can't set it aside (read-only store): report instead of silently using defaults
    }
    env.log('error', `Unusable data (${errorMessage(err)}) in ${spec.path}; moved to ${aside} and reset to defaults`);
    return { value: spec.create(), fresh: true, upgraded: true };
  }
}

/** Move a file that can't be used to `<path>.corrupt-<ts>` (kept for recovery) and start from defaults. */
function setAside<T extends Versioned>(store: FileStore, spec: DocSpec<T>, env: DocEnv, why: string): LoadedDoc<T> {
  const aside = `${spec.path}.corrupt-${env.now()}`;
  env.log('error', `${why} in ${spec.path}; moved to ${aside} and reset to defaults`);
  try {
    store.move(spec.path, aside);
  } catch {
    // keep going with defaults; the next write replaces the bad file
  }
  return { value: spec.create(), fresh: true, upgraded: true };
}

/** Where the device copy of a synced document lives in the local store. */
export function mirrorPath(path: string): string {
  return `state-mirror/${path}`;
}

export interface LoadOptions {
  /**
   * Keep a copy of this (synced) document on the device, written after every save, and fall back to
   * it when the iCloud copy can't be read in time (offline, iCloud stuck). See `degraded`.
   */
  mirror?: FileStore;
}

/**
 * Why a document isn't backed by its iCloud file this session: its read failed (download timed out),
 * so it was loaded from the device copy ('mirror') or from defaults ('defaults'). Either way the iCloud
 * file is never written over until it has been read again (`retrySynced`).
 */
export type Degraded = 'mirror' | 'defaults' | null;

export class JsonDoc<T extends Versioned> {
  value: T;
  readonly path: string;
  private readonly store: FileStore;
  private readonly writer: Debouncer;
  private readonly env: DocEnv;
  private writes = 0;
  private mirror: FileStore | null = null;
  private spec: DocSpec<T> | null = null;
  private degradedFrom: Degraded = null;
  /** Text of the device copy this session started from (degraded 'mirror'). */
  private baseText: string | null = null;
  private changedWhileDegraded = false;
  /** Called right before serializing (e.g. to copy in-memory Sets/Maps into `value`). */
  beforeWrite: (() => void) | null = null;
  /** Called after retrySynced replaced `value` with the iCloud content (see 'reloaded'). */
  onReloaded: (() => void) | null = null;

  constructor(store: FileStore, path: string, value: T, delayMs: number, env: DocEnv) {
    this.store = store;
    this.path = path;
    this.value = value;
    this.env = env;
    this.writer = new Debouncer({
      delayMs,
      sleep: (ms) => env.sleep(ms),
      task: () => this.write(),
      onError: (err) => {
        env.log('error', `Failed to save ${path}: ${errorMessage(err)}`);
        env.writeFailed?.(path, err);
      },
    });
  }

  static async load<T extends Versioned>(store: FileStore, spec: DocSpec<T>, delayMs: number, env: DocEnv, opts: LoadOptions = {}): Promise<JsonDoc<T>> {
    const mirror = opts.mirror && opts.mirror.root !== store.root ? opts.mirror : null;
    if (!mirror) {
      const loaded = await readDoc(store, spec, env);
      const doc = new JsonDoc(store, spec.path, loaded.value, delayMs, env);
      if (loaded.upgraded) doc.changed();
      return doc;
    }
    let loaded: LoadedDoc<T>;
    try {
      loaded = await readDoc(store, spec, env);
    } catch (err) {
      if (errorCode(err) !== 'STORAGE') throw err;
      return JsonDoc.fromMirror(store, spec, delayMs, env, mirror, err);
    }
    const doc = new JsonDoc(store, spec.path, loaded.value, delayMs, env);
    doc.mirror = mirror;
    doc.spec = spec;
    if (loaded.upgraded) doc.changed();
    else if (!loaded.fresh && !mirror.exists(mirrorPath(spec.path))) doc.writeMirror(JSON.stringify(doc.value)); // first run with mirroring
    return doc;
  }

  /** The iCloud copy couldn't be read: start from the device copy (or defaults), never writing iCloud. */
  private static async fromMirror<T extends Versioned>(store: FileStore, spec: DocSpec<T>, delayMs: number, env: DocEnv, mirror: FileStore, err: unknown): Promise<JsonDoc<T>> {
    let text: string | null = null;
    let local: LoadedDoc<T> | null = null;
    try {
      text = await mirror.readText(mirrorPath(spec.path));
      if (text !== null) local = await readDoc(mirror, { ...spec, path: mirrorPath(spec.path) }, env, { repair: false });
    } catch {
      local = null;
    }
    const usable = local !== null && !local.fresh;
    const doc = new JsonDoc(store, spec.path, usable && local ? local.value : spec.create(), delayMs, env);
    doc.mirror = mirror;
    doc.spec = spec;
    doc.degradedFrom = usable ? 'mirror' : 'defaults';
    doc.baseText = usable ? text : null;
    env.log(
      'error',
      `${spec.path}: the iCloud copy can't be read (${errorMessage(err)}); using ${usable ? 'the copy saved on this device' : 'defaults'} and not writing to iCloud until it can be read`,
    );
    return doc;
  }

  /** Not backed by the iCloud file this session (see Degraded). */
  get degraded(): Degraded {
    return this.degradedFrom;
  }

  /**
   * Try the iCloud copy again (it may have downloaded meanwhile). When it reads:
   * - started from the device copy and iCloud still holds that same content: back on iCloud, changes
   *   made meanwhile are written to it ('resumed');
   * - started from defaults: the iCloud content replaces the session's (whose changes were never going
   *   to be saved, as the user was told), and the document is backed by iCloud again ('reloaded';
   *   `onReloaded` lets the owning service refresh what it derived from the old value);
   * - started from the device copy but iCloud differs: nothing is written to iCloud this session; the
   *   session's changes stay on the device copy ('reopen': reopen the app to load iCloud).
   * Returns null while iCloud still can't be read, 'ok' if the document wasn't degraded.
   */
  async retrySynced(): Promise<'ok' | 'resumed' | 'reloaded' | 'reopen' | null> {
    if (!this.degradedFrom || !this.spec) return 'ok';
    let text: string | null;
    try {
      text = await this.store.readText(this.path);
    } catch {
      return null;
    }
    if (this.degradedFrom === 'defaults') {
      let loaded: LoadedDoc<T>;
      try {
        loaded = await readDoc(this.store, this.spec, this.env, { repair: false });
      } catch {
        return null; // readable but not usable right now: keep running on defaults, try again later
      }
      this.writer.cancel(); // the session's changes to the defaults are dropped
      this.value = loaded.value;
      this.degradedFrom = null;
      this.changedWhileDegraded = false;
      this.env.log('info', `${this.path}: iCloud copy readable again; loaded it`);
      try {
        this.onReloaded?.();
      } catch (err) {
        this.env.log('error', `Refreshing after ${this.path} reloaded failed: ${errorMessage(err)}`);
      }
      return 'reloaded';
    }
    if (this.degradedFrom === 'mirror' && text !== null && text === this.baseText) {
      this.degradedFrom = null;
      this.baseText = null;
      if (this.changedWhileDegraded) this.writer.mark();
      this.env.log('info', `${this.path}: iCloud copy readable again; ${this.changedWhileDegraded ? 'saving this session\'s changes to it' : 'back in sync'}`);
      return 'resumed';
    }
    this.env.log('warn', `${this.path}: iCloud copy readable again but different from what this session started with; reopen the app to load it`);
    return 'reopen';
  }

  private writeMirror(text: string): void {
    if (!this.mirror) return;
    this.mirror.writeText(mirrorPath(this.path), text).catch((err: unknown) => {
      this.env.log('warn', `Device copy of ${this.path} not saved: ${errorMessage(err)}`);
    });
  }

  /** Number of completed writes (diagnostics/tests). */
  get writeCount(): number {
    return this.writes;
  }

  get dirty(): boolean {
    return this.writer.isDirty;
  }

  /** Mark changed; persisted within the debounce delay. */
  changed(): void {
    this.writer.mark();
  }

  /** Mark changed without scheduling a write (persisted with the next write or flush). */
  changedQuietly(): void {
    this.writer.markQuiet();
  }

  /** Persist now if changed. */
  flush(): Promise<void> {
    return this.writer.flush();
  }

  /** Replace and persist immediately. */
  async save(value: T): Promise<void> {
    this.value = value;
    this.writer.mark();
    await this.writer.flush();
  }

  /** Drop pending changes and delete the file. */
  delete(): void {
    this.writer.cancel();
    this.store.remove(this.path);
  }

  private async write(): Promise<void> {
    try {
      this.beforeWrite?.();
    } catch (err) {
      // A failing pre-write step (pruning, copying in-memory state) must not block saving forever.
      this.env.log('error', `Pre-write step failed for ${this.path}: ${errorMessage(err)}`);
    }
    const text = JSON.stringify(this.value);
    if (this.degradedFrom) {
      // Never over the iCloud file we couldn't read. Started from the device copy: keep it current.
      this.changedWhileDegraded = true;
      if (this.degradedFrom === 'mirror') this.writeMirror(text);
      this.writes++;
      return;
    }
    try {
      await this.store.writeText(this.path, text);
    } catch (err) {
      throw storageError('write', this.path, err);
    }
    this.writeMirror(text);
    this.writes++;
  }
}
