/**
 * FileStore (contracts/platform.ts) over a minimal synchronous file API, shared by the Scriptable
 * adapter (FileManager) and the Node test platform (node:fs) so both run the exact same logic:
 *
 * - Atomic writes: write `<file>.tmp`, remove the old file, move the temp into place. FileManager.move
 *   fails if the destination exists, hence the remove. A crash between remove and move leaves only the
 *   complete temp file, which the next read/exists recovers.
 * - iCloud: `download()` (FileManager.downloadFileFromiCloud) is always awaited before reading; the file
 *   may be an evicted placeholder.
 * - Relative paths only; '..' and absolute paths are rejected.
 */
import type { FileStore } from '../../shared/contracts/platform.ts';

export interface FileOps {
  readString(abs: string): string;
  writeString(abs: string, text: string): void;
  readBase64(abs: string): string;
  writeBase64(abs: string, base64: string): void;
  exists(abs: string): boolean;
  isDirectory(abs: string): boolean;
  /** Recursive for directories. */
  remove(abs: string): void;
  /** Must fail if `to` exists (FileManager semantics). */
  move(from: string, to: string): void;
  list(abs: string): string[];
  /** Bytes; may be approximate (Scriptable only reports whole KB). */
  fileSizeBytes(abs: string): number;
  modifiedAt(abs: string): number | null;
  mkdirp(abs: string): void;
  join(base: string, rel: string): string;
  /** Present for iCloud-backed stores. Safe to call for local files. */
  download?(abs: string): Promise<void>;
}

const TMP = '.tmp';

function attempt<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

export function checkRelative(rel: string): string {
  const p = rel.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (p.startsWith('/') || /^[a-z]+:/i.test(p)) throw new Error(`Absolute path not allowed: ${rel}`);
  for (const seg of p.split('/')) {
    if (seg === '..') throw new Error(`Path escapes the store: ${rel}`);
  }
  return p;
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

export function createFileStore(ops: FileOps, root: string, isSynced: boolean): FileStore {
  const abs = (rel: string): string => {
    const p = checkRelative(rel);
    return p === '' ? root : ops.join(root, p);
  };

  /** Finish an interrupted atomic write. */
  const recover = (p: string): void => {
    if (!ops.exists(p) && ops.exists(p + TMP)) ops.move(p + TMP, p);
  };

  const ensureDir = (rel: string): void => {
    const d = dirOf(checkRelative(rel));
    ops.mkdirp(d === '' ? root : ops.join(root, d));
  };

  const atomicWrite = (rel: string, write: (tmp: string) => void): void => {
    ensureDir(rel);
    const p = abs(rel);
    const tmp = p + TMP;
    if (ops.exists(tmp)) ops.remove(tmp);
    write(tmp);
    if (ops.exists(p)) ops.remove(p);
    ops.move(tmp, p);
  };

  const sizeOf = (p: string): number => {
    if (!ops.exists(p)) return 0;
    if (!ops.isDirectory(p)) return ops.fileSizeBytes(p);
    let total = 0;
    for (const name of ops.list(p)) total += sizeOf(ops.join(p, name));
    return total;
  };

  return {
    root,
    isSynced,
    async readText(rel) {
      const p = abs(rel);
      recover(p);
      if (!ops.exists(p)) return null;
      if (ops.download) await ops.download(p);
      return ops.readString(p);
    },
    writeText(rel, text) {
      return attempt(() => atomicWrite(rel, (tmp) => ops.writeString(tmp, text)));
    },
    async readBase64(rel) {
      const p = abs(rel);
      recover(p);
      if (!ops.exists(p)) return null;
      if (ops.download) await ops.download(p);
      return ops.readBase64(p);
    },
    writeBase64(rel, base64) {
      return attempt(() => atomicWrite(rel, (tmp) => ops.writeBase64(tmp, base64)));
    },
    exists(rel) {
      const p = abs(rel);
      return ops.exists(p) || ops.exists(p + TMP);
    },
    remove(rel) {
      const p = abs(rel);
      if (ops.exists(p)) ops.remove(p);
      if (p !== root && ops.exists(p + TMP)) ops.remove(p + TMP);
    },
    move(from, to) {
      ensureDir(to);
      ops.move(abs(from), abs(to));
    },
    list(dir) {
      const p = abs(dir);
      if (!ops.exists(p) || !ops.isDirectory(p)) return [];
      const out = new Set<string>();
      for (const name of ops.list(p)) {
        if (name.endsWith(TMP)) continue;
        // Evicted iCloud files may be listed as ".name.icloud" placeholders.
        const m = /^\.(.+)\.icloud$/.exec(name);
        out.add(m ? (m[1] as string) : name);
      }
      return [...out];
    },
    size(rel) {
      return sizeOf(abs(rel));
    },
    modifiedAt(rel) {
      const p = abs(rel);
      return ops.exists(p) ? ops.modifiedAt(p) : null;
    },
    mkdirp(dir) {
      ops.mkdirp(abs(dir));
    },
    absolute(rel) {
      return abs(rel);
    },
  };
}
