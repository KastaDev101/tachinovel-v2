/**
 * cyrb53 (bryc, public domain): fast 53-bit string hash. Used for file names (cache, covers,
 * per-novel files), never for security. Callers that need certainty store the full key in the file.
 */
export function hash53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 11-char base36 file-name-safe hash. */
export function hashKey(str: string): string {
  return hash53(str).toString(36).padStart(11, '0');
}

/** File-name-safe id: the id itself when it is simple, otherwise a hash of it. */
export function safeName(id: string): string {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(id) ? id : `h${hashKey(id)}`;
}
