/**
 * Byte-capped LRU file store over one directory (read-ahead chapter cache, library covers).
 *
 * The index (`<dir>/index.json`: [file, bytes, lastUsed] oldest first) lives in memory as a Map whose
 * insertion order is the LRU order, so touch/evict are O(1). It is persisted with a debounce and
 * reconciled with the directory listing on load (files written before a crash are adopted, missing
 * files dropped). Writing past the cap evicts least-recently-used files immediately.
 */
import type { FileStore } from '../../shared/contracts/platform.ts';
import { errorMessage } from '../lib/errors.ts';
import { utf8Length } from '../lib/text.ts';
import { type DocEnv, JsonDoc } from './json-doc.ts';

interface LruIndexDoc {
  schemaVersion: number;
  /** [file, bytes, lastUsed], least recently used first. */
  entries: [string, number, number][];
}

const INDEX = 'index.json';

export interface LruOptions {
  store: FileStore;
  /** Directory relative to the store, e.g. "cache". */
  dir: string;
  capBytes: () => number;
  env: DocEnv;
  indexDelayMs: number;
  /** Called after a file leaves the store (evicted, removed or cleared). */
  onRemove?: (file: string) => void;
}

interface Entry {
  bytes: number;
  used: number;
}

export class LruStore {
  private readonly opts: LruOptions;
  private readonly index = new Map<string, Entry>();
  private total = 0;
  private ready: Promise<void> | null = null;
  private doc: JsonDoc<LruIndexDoc> | null = null;

  constructor(opts: LruOptions) {
    this.opts = opts;
  }

  init(): Promise<void> {
    this.ready ??= this.load();
    return this.ready;
  }

  get loaded(): boolean {
    return this.doc !== null;
  }

  get bytes(): number {
    return this.total;
  }

  get count(): number {
    return this.index.size;
  }

  /** Files, least recently used first. */
  files(): string[] {
    return [...this.index.keys()];
  }

  has(file: string): boolean {
    return this.index.has(file);
  }

  path(file: string): string {
    return `${this.opts.dir}/${file}`;
  }

  async readText(file: string): Promise<string | null> {
    await this.init();
    if (!this.index.has(file)) return null;
    const text = await this.opts.store.readText(this.path(file));
    if (text === null) {
      this.drop(file, false);
      return null;
    }
    this.touch(file);
    return text;
  }

  async readBase64(file: string): Promise<string | null> {
    await this.init();
    if (!this.index.has(file)) return null;
    const b64 = await this.opts.store.readBase64(this.path(file));
    if (b64 === null) {
      this.drop(file, false);
      return null;
    }
    this.touch(file);
    return b64;
  }

  async writeText(file: string, text: string): Promise<void> {
    await this.init();
    await this.opts.store.writeText(this.path(file), text);
    // Exact size of what was written (FileManager.fileSize is only whole KB).
    this.record(file, utf8Length(text));
  }

  async writeBase64(file: string, base64: string): Promise<void> {
    await this.init();
    await this.opts.store.writeBase64(this.path(file), base64);
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    this.record(file, Math.floor((base64.length * 3) / 4) - padding); // exact decoded size

  }

  remove(file: string): void {
    this.drop(file, true);
  }

  clear(): void {
    const files = [...this.index.keys()];
    this.index.clear();
    this.total = 0;
    try {
      this.opts.store.remove(this.opts.dir);
    } catch (err) {
      this.opts.env.log('warn', `Failed to clear ${this.opts.dir}: ${errorMessage(err)}`);
    }
    this.doc?.changed();
    for (const f of files) this.opts.onRemove?.(f);
  }

  /** Evict until under the cap (call after the cap setting changes). */
  enforceCap(): void {
    this.evict();
  }

  flush(): Promise<void> {
    return this.doc ? this.doc.flush() : Promise.resolve();
  }

  private async load(): Promise<void> {
    const { store, dir, env, indexDelayMs } = this.opts;
    const doc = await JsonDoc.load<LruIndexDoc>(
      store,
      { path: `${dir}/${INDEX}`, version: 1, create: () => ({ schemaVersion: 1, entries: [] }) },
      indexDelayMs,
      env,
    );
    const names = new Set(store.list(dir));
    names.delete(INDEX);
    const rows: [string, number, number][] = [];
    let repaired = false;
    for (const row of Array.isArray(doc.value.entries) ? doc.value.entries : []) {
      const [file, bytes, used] = row;
      if (typeof file === 'string' && names.has(file)) {
        rows.push([file, typeof bytes === 'number' ? bytes : 0, typeof used === 'number' ? used : 0]);
        names.delete(file);
      } else {
        repaired = true;
      }
    }
    for (const orphan of names) {
      const p = `${dir}/${orphan}`;
      rows.push([orphan, store.size(p), store.modifiedAt(p) ?? 0]);
      repaired = true;
    }
    if (repaired) rows.sort((a, b) => a[2] - b[2]);
    for (const [file, bytes, used] of rows) {
      this.index.set(file, { bytes, used });
      this.total += bytes;
    }
    doc.beforeWrite = () => {
      const entries: [string, number, number][] = [];
      for (const [file, e] of this.index) entries.push([file, e.bytes, e.used]);
      doc.value = { schemaVersion: 1, entries };
    };
    this.doc = doc;
    if (repaired) doc.changed();
    this.evict();
  }

  private record(file: string, bytes: number): void {
    const old = this.index.get(file);
    if (old) {
      this.total -= old.bytes;
      this.index.delete(file);
    }
    this.index.set(file, { bytes, used: this.opts.env.now() });
    this.total += bytes;
    this.doc?.changed();
    this.evict();
  }

  /** Mark a file as used (moves it to the most-recent end). */
  touch(file: string): void {
    const e = this.index.get(file);
    if (!e) return;
    this.index.delete(file);
    e.used = this.opts.env.now();
    this.index.set(file, e);
    this.doc?.changed();
  }

  private drop(file: string, deleteFile: boolean): void {
    const e = this.index.get(file);
    if (!e) return;
    this.index.delete(file);
    this.total -= e.bytes;
    if (deleteFile) {
      try {
        this.opts.store.remove(this.path(file));
      } catch (err) {
        this.opts.env.log('warn', `Failed to remove ${this.path(file)}: ${errorMessage(err)}`);
      }
    }
    this.doc?.changed();
    this.opts.onRemove?.(file);
  }

  private evict(): void {
    const cap = Math.max(0, this.opts.capBytes());
    if (this.total <= cap) return;
    for (const file of this.index.keys()) {
      if (this.total <= cap) break;
      this.drop(file, true);
    }
  }
}
