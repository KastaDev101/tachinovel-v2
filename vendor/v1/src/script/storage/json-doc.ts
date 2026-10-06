/**
 * Versioned JSON documents with migrations and debounced atomic writes.
 *
 * Every persisted JSON file carries `schemaVersion`. On load, migrations run step by step
 * (v → v+1) and the upgraded document is written back. A corrupt file is moved aside
 * (`<path>.corrupt-<ts>`) and replaced with defaults instead of crashing the app.
 */
import type { FileStore, LogLevel } from '../../shared/contracts/platform.ts';
import { Debouncer } from '../lib/debounce.ts';
import { AppError, errorMessage, storageError } from '../lib/errors.ts';
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
}

export interface LoadedDoc<T> {
  value: T;
  /** No file existed. */
  fresh: boolean;
  /** Migrated or repaired; should be written back. */
  upgraded: boolean;
}

export async function readDoc<T extends Versioned>(store: FileStore, spec: DocSpec<T>, env: DocEnv): Promise<LoadedDoc<T>> {
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
  if (!isRecord(raw)) {
    const aside = `${spec.path}.corrupt-${env.now()}`;
    env.log('error', `Corrupt JSON in ${spec.path}; moved to ${aside} and reset to defaults`);
    try {
      store.move(spec.path, aside);
    } catch {
      // keep going with defaults; the next write replaces the corrupt file
    }
    return { value: spec.create(), fresh: true, upgraded: true };
  }

  let doc: Record<string, unknown> = raw;
  const from = typeof doc.schemaVersion === 'number' && Number.isInteger(doc.schemaVersion) ? doc.schemaVersion : 0;
  let v = from;
  while (v < spec.version) {
    const m = spec.migrations?.[v];
    if (!m) throw new AppError('STORAGE', `No migration for ${spec.path} from schemaVersion ${v} to ${spec.version}`);
    doc = m(doc);
    v++;
    doc.schemaVersion = v;
  }
  if (v > spec.version) {
    env.log('warn', `${spec.path} has schemaVersion ${v}, newer than this build (${spec.version}); using it as-is`);
  }
  const typed = doc as unknown as T;
  return { value: spec.normalize ? spec.normalize(typed) : typed, fresh: false, upgraded: from !== v };
}

export class JsonDoc<T extends Versioned> {
  value: T;
  readonly path: string;
  private readonly store: FileStore;
  private readonly writer: Debouncer;
  private readonly env: DocEnv;
  private writes = 0;
  /** Called right before serializing (e.g. to copy in-memory Sets/Maps into `value`). */
  beforeWrite: (() => void) | null = null;

  constructor(store: FileStore, path: string, value: T, delayMs: number, env: DocEnv) {
    this.store = store;
    this.path = path;
    this.value = value;
    this.env = env;
    this.writer = new Debouncer({
      delayMs,
      sleep: (ms) => env.sleep(ms),
      task: () => this.write(),
      onError: (err) => env.log('error', `Failed to save ${path}: ${errorMessage(err)}`),
    });
  }

  static async load<T extends Versioned>(store: FileStore, spec: DocSpec<T>, delayMs: number, env: DocEnv): Promise<JsonDoc<T>> {
    const loaded = await readDoc(store, spec, env);
    const doc = new JsonDoc(store, spec.path, loaded.value, delayMs, env);
    if (loaded.upgraded) doc.changed();
    return doc;
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
    try {
      await this.store.writeText(this.path, text);
    } catch (err) {
      throw storageError('write', this.path, err);
    }
    this.writes++;
  }
}
