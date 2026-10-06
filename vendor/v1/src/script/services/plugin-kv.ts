/**
 * LNReader `@libs/storage` backing: a synchronous key/value store per plugin, persisted to local
 * `plugin-data/<id>.json` (debounced). Sync API → the file is preloaded before the plugin runs;
 * writes that happen before the load completes are merged over the loaded values.
 */
import type { PluginKV } from '../../shared/contracts/plugin-host.ts';
import { errorMessage } from '../lib/errors.ts';
import { safeName } from '../lib/hash.ts';
import { isRecord } from '../lib/validate.ts';
import { JsonDoc } from '../storage/json-doc.ts';
import type { Ctx } from './context.ts';

interface KvEntry {
  v: unknown;
  /** Absolute expiry (epoch ms). */
  e?: number;
}

interface KvDoc {
  schemaVersion: number;
  values: Record<string, KvEntry>;
}

export function pluginDataPath(id: string): string {
  return `plugin-data/${safeName(id)}.json`;
}

class KvState implements PluginKV {
  values: Record<string, KvEntry> = Object.create(null) as Record<string, KvEntry>;
  doc: JsonDoc<KvDoc> | null = null;
  ready: Promise<void> | null = null;
  private earlyWrites = false;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  attach(doc: JsonDoc<KvDoc>): void {
    // Changes the plugin made before the stored values arrived win: a clear drops what was stored, a
    // delete removes the stored key, a set replaces it.
    const loaded: Record<string, unknown> = this.earlyCleared ? {} : isRecord(doc.value.values) ? { ...doc.value.values } : {};
    for (const k of this.earlyDeleted) delete loaded[k];
    if (this.earlyWrites) {
      for (const k of Object.keys(this.values)) loaded[k] = this.values[k];
    }
    this.earlyDeleted.clear();
    this.earlyCleared = false;
    const values = Object.create(null) as Record<string, KvEntry>;
    for (const k of Object.keys(loaded)) {
      // Only well-formed entries ({v, e?}); anything else is dropped rather than handed to a plugin.
      const entry = loaded[k];
      if (!isRecord(entry) || !('v' in entry)) continue;
      values[k] = typeof entry.e === 'number' && Number.isFinite(entry.e) ? { v: entry.v, e: entry.e } : { v: entry.v };
    }
    this.values = values;
    this.doc = doc;
    doc.beforeWrite = () => {
      doc.value = { schemaVersion: 1, values: this.values };
    };
    if (this.earlyWrites) doc.changed();
  }

  /** Before the stored values loaded: keys deleted and whether everything was cleared. */
  private readonly earlyDeleted = new Set<string>();
  private earlyCleared = false;

  private changed(): void {
    if (this.doc) this.doc.changed();
    else this.earlyWrites = true;
  }

  private live(key: string): KvEntry | undefined {
    const e = this.values[key];
    if (!e) return undefined;
    if (e.e !== undefined && this.now() > e.e) {
      delete this.values[key];
      this.changed();
      return undefined;
    }
    return e;
  }

  get(key: string): unknown {
    return this.live(key)?.v;
  }

  set(key: string, value: unknown, expires?: number | Date): void {
    const entry: KvEntry = { v: value };
    if (expires instanceof Date) entry.e = expires.getTime();
    else if (typeof expires === 'number' && Number.isFinite(expires)) entry.e = expires;
    this.values[key] = entry;
    this.changed();
  }

  delete(key: string): void {
    if (!this.doc) {
      this.earlyDeleted.add(key); // the key may exist in the stored values that haven't loaded yet
      delete this.values[key];
      this.changed();
      return;
    }
    if (!(key in this.values)) return;
    delete this.values[key];
    this.changed();
  }

  clearAll(): void {
    this.values = Object.create(null) as Record<string, KvEntry>;
    if (!this.doc) {
      this.earlyCleared = true;
      this.earlyDeleted.clear();
    }
    this.changed();
  }

  getAllKeys(): string[] {
    return Object.keys(this.values).filter((k) => this.live(k) !== undefined);
  }
}

export class PluginKvStore {
  private readonly ctx: Ctx;
  private readonly states = new Map<string, KvState>();

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  /** Synchronous accessor handed to the plugin host (PluginHostDeps.storageFor). */
  kvFor(id: string): PluginKV {
    const s = this.state(id);
    void this.preload(id).catch((err: unknown) => {
      this.ctx.platform.log('warn', `Plugin storage for ${id} failed to load: ${errorMessage(err)}`);
    });
    return s;
  }

  preload(id: string): Promise<void> {
    const s = this.state(id);
    s.ready ??= JsonDoc.load<KvDoc>(
      this.ctx.platform.local,
      { path: pluginDataPath(id), version: 1, create: () => ({ schemaVersion: 1, values: {} }) },
      this.ctx.timing.indexWriteMs,
      this.ctx.env,
    ).then(
      (doc) => s.attach(doc),
      (err: unknown) => {
        s.ready = null;
        throw err;
      },
    );
    return s.ready;
  }

  remove(id: string): void {
    const s = this.states.get(id);
    this.states.delete(id);
    if (s?.doc) s.doc.delete();
    else this.ctx.platform.local.remove(pluginDataPath(id));
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.states.values()].map((s) => (s.doc ? s.doc.flush() : Promise.resolve())));
  }

  private state(id: string): KvState {
    let s = this.states.get(id);
    if (!s) {
      s = new KvState(() => this.ctx.platform.now());
      this.states.set(id, s);
    }
    return s;
  }
}
