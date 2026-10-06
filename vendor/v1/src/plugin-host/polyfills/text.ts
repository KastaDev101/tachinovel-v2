/**
 * TextEncoder / TextDecoder in pure ECMAScript. Encoder: UTF-8 only (as per spec).
 * Decoder: utf-8, utf-16le, utf-16be, windows-1252 (WHATWG's mapping for latin1/iso-8859-1/ascii labels).
 * Other legacy encodings (gbk, shift_jis, …) throw a RangeError like an unknown label would.
 * `stream: true` is accepted, with UTF-8 sequences split across calls carried over.
 */
import { codeUnitsToString, utf8Decode, utf8Encode } from './utf8.ts';

export type BufferSourceLike = ArrayBuffer | ArrayBufferView;

const LABELS: Record<string, 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252'> = {
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  'unicode-1-1-utf-8': 'utf-8',
  'unicode11utf8': 'utf-8',
  'unicode20utf8': 'utf-8',
  'x-unicode20utf8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16': 'utf-16le',
  ucs2: 'utf-16le',
  'ucs-2': 'utf-16le',
  unicode: 'utf-16le',
  csunicode: 'utf-16le',
  'iso-10646-ucs-2': 'utf-16le',
  unicodefeff: 'utf-16le',
  'utf-16be': 'utf-16be',
  unicodefffe: 'utf-16be',
  'windows-1252': 'windows-1252',
  'iso-8859-1': 'windows-1252',
  'iso8859-1': 'windows-1252',
  'iso_8859-1': 'windows-1252',
  iso88591: 'windows-1252',
  latin1: 'windows-1252',
  l1: 'windows-1252',
  'us-ascii': 'windows-1252',
  ascii: 'windows-1252',
  'ansi_x3.4-1968': 'windows-1252',
  cp1252: 'windows-1252',
  cp819: 'windows-1252',
  'x-cp1252': 'windows-1252',
  ibm819: 'windows-1252',
  'iso-ir-100': 'windows-1252',
  csisolatin1: 'windows-1252',
};

/** windows-1252 bytes 0x80–0x9F (the rest map to the same code point). */
const W1252 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

/** Normalizes an encoding label; null if unsupported. */
export function normalizeEncoding(label: string | undefined): 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252' | null {
  if (label === undefined) return 'utf-8';
  return LABELS[String(label).trim().toLowerCase()] ?? null;
}

export function toBytes(input: BufferSourceLike | undefined): Uint8Array {
  if (input === undefined) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('The provided value is not of type (ArrayBuffer or ArrayBufferView)');
}

export class TextEncoder {
  get encoding(): string {
    return 'utf-8';
  }

  encode(input = ''): Uint8Array {
    return utf8Encode(String(input));
  }

  encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
    let read = 0;
    let written = 0;
    for (const ch of String(source)) {
      const bytes = utf8Encode(ch);
      if (written + bytes.length > destination.length) break;
      destination.set(bytes, written);
      written += bytes.length;
      read += ch.length;
    }
    return { read, written };
  }

  get [Symbol.toStringTag](): string {
    return 'TextEncoder';
  }
}

/** Length of an incomplete UTF-8 sequence at the end of `bytes` (0 if complete). */
function incompleteUtf8Tail(bytes: Uint8Array): number {
  const n = bytes.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = bytes[n - back] as number;
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    const need = b >= 0xf0 && b <= 0xf4 ? 4 : b >= 0xe0 ? 3 : b >= 0xc2 && b <= 0xdf ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

export class TextDecoder {
  readonly #encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
  readonly #fatal: boolean;
  readonly #ignoreBOM: boolean;
  #pending: Uint8Array = new Uint8Array(0);
  #bomSeen = false;

  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) {
    const enc = normalizeEncoding(label);
    if (!enc) throw new RangeError(`The encoding label provided ('${String(label)}') is not supported.`);
    this.#encoding = enc;
    this.#fatal = Boolean(options?.fatal);
    this.#ignoreBOM = Boolean(options?.ignoreBOM);
  }

  get encoding(): string {
    return this.#encoding;
  }
  get fatal(): boolean {
    return this.#fatal;
  }
  get ignoreBOM(): boolean {
    return this.#ignoreBOM;
  }

  decode(input?: BufferSourceLike, options?: { stream?: boolean }): string {
    let bytes = toBytes(input);
    if (this.#pending.length) {
      const merged = new Uint8Array(this.#pending.length + bytes.length);
      merged.set(this.#pending);
      merged.set(bytes, this.#pending.length);
      bytes = merged;
      this.#pending = new Uint8Array(0);
    }
    const stream = Boolean(options?.stream);
    if (stream) {
      const tail = this.#encoding === 'utf-8' ? incompleteUtf8Tail(bytes) : this.#encoding === 'windows-1252' ? 0 : bytes.length % 2;
      if (tail) {
        this.#pending = bytes.slice(bytes.length - tail);
        bytes = bytes.subarray(0, bytes.length - tail);
      }
    }
    const stripBOM = !this.#ignoreBOM && !this.#bomSeen;
    let out: string;
    switch (this.#encoding) {
      case 'utf-8':
        out = utf8Decode(bytes, this.#fatal, !stripBOM);
        break;
      case 'utf-16le':
      case 'utf-16be': {
        const le = this.#encoding === 'utf-16le';
        const units = new Uint16Array(bytes.length >> 1);
        for (let i = 0; i + 1 < bytes.length; i += 2) {
          units[i >> 1] = le ? (bytes[i] as number) | ((bytes[i + 1] as number) << 8) : ((bytes[i] as number) << 8) | (bytes[i + 1] as number);
        }
        out = codeUnitsToString(units);
        if (bytes.length % 2) {
          if (this.#fatal) throw new TypeError('The encoded data was not valid utf-16');
          out += String.fromCharCode(0xfffd);
        }
        if (stripBOM && out.charCodeAt(0) === 0xfeff) out = out.slice(1);
        break;
      }
      case 'windows-1252': {
        const units = new Uint16Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i] as number;
          units[i] = b >= 0x80 && b <= 0x9f ? (W1252[b - 0x80] as number) : b;
        }
        out = codeUnitsToString(units);
        break;
      }
    }
    if (out.length > 0 || bytes.length > 0) this.#bomSeen = stream;
    if (!stream) this.#bomSeen = false;
    return out;
  }

  get [Symbol.toStringTag](): string {
    return 'TextDecoder';
  }
}
