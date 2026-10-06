/** Fetch `Headers` in pure ECMAScript: case-insensitive, combined values, sorted iteration. */

export type HeadersInitLike = Headers | Iterable<readonly [string, string] | readonly string[]> | Record<string, string | undefined | null>;

function normName(name: unknown): string {
  const n = String(name);
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(n)) throw new TypeError(`Invalid header name: "${n}"`);
  return n.toLowerCase();
}

function normValue(value: unknown): string {
  return String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
}

export class Headers {
  /** lower-cased name → values in insertion order */
  #map = new Map<string, string[]>();

  constructor(init?: HeadersInitLike | null) {
    if (init === undefined || init === null) return;
    if (init instanceof Headers) {
      for (const [k, vs] of init.#map) this.#map.set(k, vs.slice());
    } else if (typeof (init as Iterable<unknown>)[Symbol.iterator] === 'function') {
      for (const pair of init as Iterable<readonly string[]>) {
        const arr = Array.from(pair);
        if (arr.length !== 2) throw new TypeError('Headers: each header must be a [name, value] pair');
        this.append(arr[0] as string, arr[1] as string);
      }
    } else {
      for (const k of Object.keys(init)) {
        const v = (init as Record<string, unknown>)[k];
        if (v !== undefined && v !== null) this.append(k, v as string);
      }
    }
  }

  append(name: string, value: string): void {
    const n = normName(name);
    const list = this.#map.get(n);
    if (list) list.push(normValue(value));
    else this.#map.set(n, [normValue(value)]);
  }

  set(name: string, value: string): void {
    this.#map.set(normName(name), [normValue(value)]);
  }

  delete(name: string): void {
    this.#map.delete(normName(name));
  }

  get(name: string): string | null {
    const list = this.#map.get(normName(name));
    return list ? list.join(', ') : null;
  }

  getSetCookie(): string[] {
    return (this.#map.get('set-cookie') ?? []).slice();
  }

  has(name: string): boolean {
    return this.#map.has(normName(name));
  }

  forEach(cb: (value: string, key: string, parent: Headers) => void, thisArg?: unknown): void {
    for (const [k, v] of this.entries()) cb.call(thisArg, v, k, this);
  }

  *entries(): IterableIterator<[string, string]> {
    const names = [...this.#map.keys()].sort();
    for (const n of names) {
      const list = this.#map.get(n) ?? [];
      if (n === 'set-cookie') for (const v of list) yield [n, v];
      else yield [n, list.join(', ')];
    }
  }

  *keys(): IterableIterator<string> {
    for (const [k] of this.entries()) yield k;
  }

  *values(): IterableIterator<string> {
    for (const [, v] of this.entries()) yield v;
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'Headers';
  }
}

/** Flattens any headers-ish value (our Headers, a native Headers, pairs or a record) to a plain record. */
export function headersToRecord(init: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (init === undefined || init === null) return out;
  const it = init as { forEach?: unknown; [Symbol.iterator]?: unknown };
  if (init instanceof Headers || Object.prototype.toString.call(init) === '[object Headers]') {
    (init as Headers).forEach((v, k) => {
      out[k] = k in out ? `${out[k]}, ${v}` : v;
    });
  } else if (typeof it[Symbol.iterator] === 'function') {
    for (const pair of init as Iterable<readonly string[]>) {
      const [k, v] = Array.from(pair);
      if (k !== undefined && v !== undefined) out[String(k)] = String(v);
    }
  } else if (typeof init === 'object') {
    for (const k of Object.keys(init)) {
      const v = (init as Record<string, unknown>)[k];
      if (typeof v === 'string') out[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    }
  }
  return out;
}
