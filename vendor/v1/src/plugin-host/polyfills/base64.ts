/** atob/btoa (WHATWG forgiving-base64) and base64 ↔ bytes helpers in pure ECMAScript. */
import { codeUnitsToString } from './utf8.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;
// base64url characters are accepted by base64ToBytes (not by atob).
const URL_LOOKUP = LOOKUP.slice();
URL_LOOKUP[0x2d] = 62; // -
URL_LOOKUP[0x5f] = 63; // _

export class InvalidCharacterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCharacterError';
  }
}

export function bytesToBase64(bytes: ArrayLike<number>): string {
  let out = '';
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += ALPHABET.charAt(v >> 18) + ALPHABET.charAt((v >> 12) & 63) + ALPHABET.charAt((v >> 6) & 63) + ALPHABET.charAt(v & 63);
  }
  if (i < n) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < n ? (bytes[i + 1] as number) : 0;
    const v = (b0 << 16) | (b1 << 8);
    out += ALPHABET.charAt(v >> 18) + ALPHABET.charAt((v >> 12) & 63);
    out += i + 1 < n ? ALPHABET.charAt((v >> 6) & 63) + '=' : '==';
  }
  return out;
}

function decodeTo(input: string, table: Int16Array, strict: boolean): Uint8Array {
  let s = input.replace(/[\t\n\f\r ]/g, '');
  if (s.length % 4 === 0) s = s.replace(/={1,2}$/, '');
  else if (!strict) s = s.replace(/=+$/, '');
  if (strict && s.length % 4 === 1) throw new InvalidCharacterError('The string to be decoded is not correctly encoded.');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let buf = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 256 ? (table[c] as number) : -1;
    if (v < 0) throw new InvalidCharacterError('The string to be decoded is not correctly encoded.');
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

/** Decodes standard or URL-safe base64 (padding optional, whitespace ignored). */
export function base64ToBytes(input: string): Uint8Array {
  return decodeTo(input, URL_LOOKUP, false);
}

/** WHATWG atob: returns a "binary string" (one char per byte). */
export function atob(data: string): string {
  const bytes = decodeTo(String(data), LOOKUP, true);
  return codeUnitsToString(bytes);
}

/** WHATWG btoa: input must be a binary string (all code units ≤ 0xFF). */
export function btoa(data: string): string {
  const s = String(data);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) throw new InvalidCharacterError('The string to be encoded contains characters outside of the Latin1 range.');
    bytes[i] = c;
  }
  return bytesToBase64(bytes);
}
