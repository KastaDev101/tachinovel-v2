/** @libs/utils — the @noble/ciphers byte helpers LNReader exposes (utf8ToBytes, bytesToUtf8). */
import { utf8Decode, utf8Encode } from '../polyfills/utf8.ts';

export function utf8ToBytes(str: string): Uint8Array {
  if (typeof str !== 'string') throw new TypeError(`utf8ToBytes expected string, got ${typeof str}`);
  return utf8Encode(str);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return utf8Decode(bytes, false, true);
}
