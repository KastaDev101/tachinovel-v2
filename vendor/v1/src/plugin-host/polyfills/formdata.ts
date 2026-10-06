/**
 * FormData-lite: string fields only (no Blob/File — Scriptable has neither), enough for plugins that
 * POST forms (Madara's admin-ajax, search forms). The fetch shim serializes it as multipart/form-data.
 */

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : String(v);
}

export class FormData {
  #entries: [string, string][] = [];

  constructor(form?: unknown) {
    if (form !== undefined) throw new TypeError('FormData: constructing from a form element is not supported');
  }

  append(name: string, value: unknown, _filename?: string): void {
    this.#entries.push([toStr(name), toStr(value)]);
  }

  delete(name: string): void {
    const n = toStr(name);
    this.#entries = this.#entries.filter(([k]) => k !== n);
  }

  get(name: string): string | null {
    const n = toStr(name);
    const e = this.#entries.find(([k]) => k === n);
    return e ? e[1] : null;
  }

  getAll(name: string): string[] {
    const n = toStr(name);
    return this.#entries.filter(([k]) => k === n).map(([, v]) => v);
  }

  has(name: string): boolean {
    const n = toStr(name);
    return this.#entries.some(([k]) => k === n);
  }

  set(name: string, value: unknown, _filename?: string): void {
    const n = toStr(name);
    const v = toStr(value);
    const i = this.#entries.findIndex(([k]) => k === n);
    if (i < 0) {
      this.#entries.push([n, v]);
    } else {
      this.#entries[i] = [n, v];
      this.#entries = this.#entries.filter(([k], j) => j <= i || k !== n);
    }
  }

  forEach(cb: (value: string, key: string, parent: FormData) => void, thisArg?: unknown): void {
    for (const [k, v] of this.#entries.slice()) cb.call(thisArg, v, k, this);
  }

  *entries(): IterableIterator<[string, string]> {
    for (const [k, v] of this.#entries.slice()) yield [k, v];
  }

  *keys(): IterableIterator<string> {
    for (const [k] of this.#entries.slice()) yield k;
  }

  *values(): IterableIterator<string> {
    for (const [, v] of this.#entries.slice()) yield v;
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'FormData';
  }
}

function escapeName(s: string): string {
  // HTML's multipart/form-data encoding: escape LF/CR/quote in names.
  return s.replace(/\r\n|\r|\n/g, '\r\n').replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22');
}

/** Serializes form entries as multipart/form-data. Returns the body and the Content-Type header value. */
export function encodeMultipart(entries: Iterable<readonly [string, string]>, boundary: string): { body: string; contentType: string } {
  let body = '';
  for (const [name, value] of entries) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${escapeName(name)}"\r\n\r\n${value.replace(/\r\n|\r|\n/g, '\r\n')}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** A boundary like WebKit's (deterministic from a seed so fixtures stay stable). */
export function makeBoundary(seed: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '----WebKitFormBoundary';
  let x = seed >>> 0 || 0x9e3779b9;
  for (let i = 0; i < 16; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out += chars.charAt((x >>> 0) % chars.length);
  }
  return out;
}
