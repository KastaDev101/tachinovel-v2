/**
 * @libs/aes — AES-GCM with the @noble/ciphers API LNReader exposes:
 *   gcm(key, nonce, aad?).encrypt(plaintext) → ciphertext ‖ tag(16)
 *   gcm(key, nonce, aad?).decrypt(ciphertext ‖ tag) → plaintext (throws if the tag does not verify)
 * Pure ECMAScript implementation of FIPS-197 AES (128/192/256) and NIST SP 800-38D GCM.
 * Used by plugins that decrypt chapter text served encrypted to every (free) reader.
 */

const SBOX = new Uint8Array(256);
(() => {
  // Generate the S-box from GF(2^8) inverses (avoids a 256-entry literal).
  let p = 1;
  let q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
})();

function xtime(b: number): number {
  return ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;
}

function expandKey(key: Uint8Array): Uint8Array[] {
  const nk = key.length / 4;
  if (![4, 6, 8].includes(nk)) throw new Error(`AES: invalid key length ${key.length}`);
  const rounds = nk + 6;
  const words: number[][] = [];
  for (let i = 0; i < nk; i++) words.push([key[4 * i] as number, key[4 * i + 1] as number, key[4 * i + 2] as number, key[4 * i + 3] as number]);
  let rcon = 1;
  for (let i = nk; i < 4 * (rounds + 1); i++) {
    let t = (words[i - 1] as number[]).slice();
    if (i % nk === 0) {
      t = [SBOX[t[1] as number] as number, SBOX[t[2] as number] as number, SBOX[t[3] as number] as number, SBOX[t[0] as number] as number];
      t[0] = (t[0] as number) ^ rcon;
      rcon = xtime(rcon);
    } else if (nk > 6 && i % nk === 4) {
      t = t.map((b) => SBOX[b] as number);
    }
    const prev = words[i - nk] as number[];
    words.push([0, 1, 2, 3].map((j) => (prev[j] as number) ^ (t[j] as number)));
  }
  const roundKeys: Uint8Array[] = [];
  for (let r = 0; r <= rounds; r++) {
    const rk = new Uint8Array(16);
    for (let c = 0; c < 4; c++) rk.set(words[4 * r + c] as number[], 4 * c);
    roundKeys.push(rk);
  }
  return roundKeys;
}

function encryptBlock(roundKeys: Uint8Array[], input: Uint8Array): Uint8Array {
  const s = new Uint8Array(16);
  const rk0 = roundKeys[0] as Uint8Array;
  for (let i = 0; i < 16; i++) s[i] = (input[i] as number) ^ (rk0[i] as number);
  const rounds = roundKeys.length - 1;
  const t = new Uint8Array(16);
  for (let r = 1; r <= rounds; r++) {
    // SubBytes + ShiftRows (column-major state: index = 4*col + row)
    for (let c = 0; c < 4; c++) {
      for (let row = 0; row < 4; row++) t[4 * c + row] = SBOX[s[4 * ((c + row) % 4) + row] as number] as number;
    }
    if (r !== rounds) {
      // MixColumns
      for (let c = 0; c < 4; c++) {
        const a0 = t[4 * c] as number;
        const a1 = t[4 * c + 1] as number;
        const a2 = t[4 * c + 2] as number;
        const a3 = t[4 * c + 3] as number;
        const all = a0 ^ a1 ^ a2 ^ a3;
        s[4 * c] = a0 ^ all ^ xtime(a0 ^ a1);
        s[4 * c + 1] = a1 ^ all ^ xtime(a1 ^ a2);
        s[4 * c + 2] = a2 ^ all ^ xtime(a2 ^ a3);
        s[4 * c + 3] = a3 ^ all ^ xtime(a3 ^ a0);
      }
    } else {
      s.set(t);
    }
    const rk = roundKeys[r] as Uint8Array;
    for (let i = 0; i < 16; i++) s[i] = (s[i] as number) ^ (rk[i] as number);
  }
  return s;
}

/** Multiplication in GF(2^128) with GCM's bit order. */
function gfMul(x: Uint8Array, y: Uint8Array): Uint8Array {
  const z = new Uint8Array(16);
  const v = y.slice();
  for (let i = 0; i < 128; i++) {
    if (((x[i >> 3] as number) >> (7 - (i & 7))) & 1) for (let j = 0; j < 16; j++) z[j] = (z[j] as number) ^ (v[j] as number);
    const lsb = (v[15] as number) & 1;
    for (let j = 15; j > 0; j--) v[j] = ((v[j] as number) >> 1) | (((v[j - 1] as number) & 1) << 7);
    v[0] = (v[0] as number) >> 1;
    if (lsb) v[0] = (v[0]) ^ 0xe1;
  }
  return z;
}

function ghash(h: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  let y: Uint8Array = new Uint8Array(16);
  const absorb = (data: Uint8Array): void => {
    for (let i = 0; i < data.length; i += 16) {
      const block = new Uint8Array(16);
      block.set(data.subarray(i, Math.min(i + 16, data.length)));
      for (let j = 0; j < 16; j++) block[j] = (block[j] as number) ^ (y[j] as number);
      y = gfMul(block, h);
    }
  };
  absorb(aad);
  absorb(ct);
  const lens = new Uint8Array(16);
  const put64 = (off: number, bits: number): void => {
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    for (let k = 0; k < 4; k++) {
      lens[off + k] = (hi >>> (24 - 8 * k)) & 0xff;
      lens[off + 4 + k] = (lo >>> (24 - 8 * k)) & 0xff;
    }
  };
  put64(0, aad.length * 8);
  put64(8, ct.length * 8);
  absorb(lens);
  return y;
}

function inc32(block: Uint8Array): void {
  for (let i = 15; i >= 12; i--) {
    block[i] = ((block[i] as number) + 1) & 0xff;
    if (block[i] !== 0) break;
  }
}

function ctr(roundKeys: Uint8Array[], j0: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  const counter = j0.slice();
  for (let i = 0; i < data.length; i += 16) {
    inc32(counter);
    const ks = encryptBlock(roundKeys, counter);
    const n = Math.min(16, data.length - i);
    for (let j = 0; j < n; j++) out[i + j] = (data[i + j] as number) ^ (ks[j] as number);
  }
  return out;
}

export interface Cipher {
  encrypt(plaintext: Uint8Array): Uint8Array;
  decrypt(ciphertext: Uint8Array): Uint8Array;
}

export function gcm(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array = new Uint8Array(0)): Cipher {
  const roundKeys = expandKey(key);
  const h = encryptBlock(roundKeys, new Uint8Array(16));
  let j0: Uint8Array;
  if (nonce.length === 12) {
    j0 = new Uint8Array(16);
    j0.set(nonce);
    j0[15] = 1;
  } else {
    if (nonce.length === 0) throw new Error('AES-GCM: empty nonce');
    j0 = ghash(h, new Uint8Array(0), nonce);
  }
  const tagFor = (ct: Uint8Array): Uint8Array => {
    const s = ghash(h, aad, ct);
    const ek = encryptBlock(roundKeys, j0);
    for (let i = 0; i < 16; i++) s[i] = (s[i] as number) ^ (ek[i] as number);
    return s;
  };
  return {
    encrypt(plaintext) {
      const ct = ctr(roundKeys, j0, plaintext);
      const out = new Uint8Array(ct.length + 16);
      out.set(ct);
      out.set(tagFor(ct), ct.length);
      return out;
    },
    decrypt(data) {
      if (data.length < 16) throw new Error('AES-GCM: ciphertext too short');
      const ct = data.subarray(0, data.length - 16);
      const tag = data.subarray(data.length - 16);
      const expected = tagFor(ct);
      let diff = 0;
      for (let i = 0; i < 16; i++) diff |= (expected[i] as number) ^ (tag[i] as number);
      if (diff !== 0) throw new Error('AES-GCM: invalid ghash tag');
      return ctr(roundKeys, j0, ct);
    },
  };
}
