/**
 * UTF-8 encode/decode on plain arrays and Uint8Arrays. Pure ECMAScript (no TextEncoder/TextDecoder),
 * shared by the URL, TextEncoder/TextDecoder and base64 polyfills.
 */

/** Encodes a string to UTF-8. Lone surrogates become U+FFFD (as TextEncoder does). */
export function utf8Encode(input: string): Uint8Array {
  // Fast path: pure ASCII.
  let ascii = true;
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 0x7f) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = input.charCodeAt(i);
    return out;
  }
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let cp = input.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    pushCodePoint(bytes, cp);
  }
  return Uint8Array.from(bytes);
}

/** Appends the UTF-8 bytes of one code point. */
export function pushCodePoint(bytes: number[], cp: number): void {
  if (cp < 0x80) bytes.push(cp);
  else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
}

const CHUNK = 0x2000;

/** Code units → string, in chunks (fromCharCode.apply has argument-count limits). */
export function codeUnitsToString(units: ArrayLike<number>, length = units.length): string {
  if (length <= CHUNK) return String.fromCharCode.apply(null, Array.prototype.slice.call(units, 0, length) as number[]);
  let out = '';
  for (let i = 0; i < length; i += CHUNK) {
    out += String.fromCharCode.apply(null, Array.prototype.slice.call(units, i, Math.min(i + CHUNK, length)) as number[]);
  }
  return out;
}

export class Utf8DecodeError extends TypeError {
  constructor() {
    super('The encoded data was not valid UTF-8');
    this.name = 'TypeError';
  }
}

/**
 * WHATWG UTF-8 decode: invalid sequences become U+FFFD using the "maximal subpart" rule,
 * or throw when `fatal`. A leading BOM is stripped unless `keepBOM`.
 */
export function utf8Decode(bytes: ArrayLike<number>, fatal = false, keepBOM = false): string {
  const units = new Uint16Array(bytes.length + 1);
  let n = 0;
  let i = 0;
  const len = bytes.length;
  if (!keepBOM && len >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < len) {
    const b = bytes[i] as number;
    if (b < 0x80) {
      units[n++] = b;
      i++;
      continue;
    }
    let needed: number;
    let cp: number;
    let lower = 0x80;
    let upper = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) {
      needed = 1;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      if (b === 0xe0) lower = 0xa0;
      if (b === 0xed) upper = 0x9f;
      needed = 2;
      cp = b & 0x0f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      if (b === 0xf0) lower = 0x90;
      if (b === 0xf4) upper = 0x8f;
      needed = 3;
      cp = b & 0x07;
    } else {
      if (fatal) throw new Utf8DecodeError();
      units[n++] = 0xfffd;
      i++;
      continue;
    }
    let j = i + 1;
    let ok = true;
    for (let k = 0; k < needed; k++, j++) {
      const c = j < len ? (bytes[j] as number) : -1;
      if (c < lower || c > upper) {
        ok = false;
        break;
      }
      lower = 0x80;
      upper = 0xbf;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (!ok) {
      if (fatal) throw new Utf8DecodeError();
      units[n++] = 0xfffd;
      i = j; // maximal subpart consumed; the offending byte is reprocessed
      continue;
    }
    // Output never outgrows the input: a 4-byte sequence yields 2 code units.
    if (cp >= 0x10000) {
      cp -= 0x10000;
      units[n++] = 0xd800 + (cp >> 10);
      units[n++] = 0xdc00 + (cp & 0x3ff);
    } else {
      units[n++] = cp;
    }
    i = j;
  }
  return codeUnitsToString(units, n);
}
