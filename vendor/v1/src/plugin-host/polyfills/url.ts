/**
 * WHATWG URL + URLSearchParams in pure ECMAScript (Scriptable's JavaScriptCore has neither).
 * Implements the URL Standard's basic URL parser (https://url.spec.whatwg.org/#concept-basic-url-parser):
 * special schemes, relative resolution, dot segments, percent-encode sets, IPv4/IPv6 hosts,
 * punycode for internationalized domains (lowercased + NFC; full UTS #46 mapping is not implemented),
 * and the application/x-www-form-urlencoded parser/serializer. Unit tests compare against Node's URL.
 */
import { pushCodePoint, utf8Decode, utf8Encode } from './utf8.ts';

// ---------------------------------------------------------------------------------------------
// URL record
// ---------------------------------------------------------------------------------------------

interface UrlRecord {
  scheme: string;
  username: string;
  password: string;
  /** Serialized host, '' for empty host, null for no host. */
  host: string | null;
  port: number | null;
  /** Segments, or a string for an opaque path. */
  path: string[] | string;
  query: string | null;
  fragment: string | null;
}

const SPECIAL_PORTS: Record<string, number | null> = { ftp: 21, file: null, http: 80, https: 443, ws: 80, wss: 443 };

function isSpecialScheme(s: string): boolean {
  return Object.prototype.hasOwnProperty.call(SPECIAL_PORTS, s);
}

function defaultPort(scheme: string): number | null {
  return isSpecialScheme(scheme) ? (SPECIAL_PORTS[scheme] ?? null) : null;
}

class UrlFailure extends Error {}

// ---------------------------------------------------------------------------------------------
// Percent-encoding
// ---------------------------------------------------------------------------------------------

type EncodeSet = (c: number) => boolean;

const c0Control: EncodeSet = (c) => c < 0x20 || c > 0x7e;
const fragmentSet: EncodeSet = (c) => c0Control(c) || c === 0x20 || c === 0x22 || c === 0x3c || c === 0x3e || c === 0x60;
const querySet: EncodeSet = (c) => c0Control(c) || c === 0x20 || c === 0x22 || c === 0x23 || c === 0x3c || c === 0x3e;
const specialQuerySet: EncodeSet = (c) => querySet(c) || c === 0x27;
const pathSet: EncodeSet = (c) => querySet(c) || c === 0x3f || c === 0x5e || c === 0x60 || c === 0x7b || c === 0x7d;
const userinfoSet: EncodeSet = (c) =>
  pathSet(c) || c === 0x2f || c === 0x3a || c === 0x3b || c === 0x3d || c === 0x40 || (c >= 0x5b && c <= 0x5d) || c === 0x7c;

const HEX = '0123456789ABCDEF';

function pctByte(b: number): string {
  return '%' + HEX.charAt(b >> 4) + HEX.charAt(b & 15);
}

/** Percent-encodes one code point (as UTF-8) if it is in the set. */
function encodeCodePoint(cp: number, set: EncodeSet): string {
  if (cp < 0x80) return set(cp) ? pctByte(cp) : String.fromCharCode(cp);
  const bytes: number[] = [];
  pushCodePoint(bytes, cp);
  let out = '';
  for (const b of bytes) out += pctByte(b);
  return out;
}

function encodeString(s: string, set: EncodeSet): string {
  let out = '';
  for (const ch of s) out += encodeCodePoint(ch.codePointAt(0) as number, set);
  return out;
}

function isHexDigit(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

/** Percent-decodes to bytes (invalid escapes are kept literally). */
function percentDecodeBytes(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const b = input[i] as number;
    if (b === 0x25 && i + 2 < input.length && isHexDigit(input[i + 1] as number) && isHexDigit(input[i + 2] as number)) {
      out.push(parseInt(String.fromCharCode(input[i + 1] as number, input[i + 2] as number), 16));
      i += 2;
    } else {
      out.push(b);
    }
  }
  return Uint8Array.from(out);
}

function percentDecodeString(s: string): Uint8Array {
  return percentDecodeBytes(utf8Encode(s));
}

// ---------------------------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------------------------

function isForbiddenHost(c: number): boolean {
  return (
    c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x20 || c === 0x23 || c === 0x2f || c === 0x3a ||
    c === 0x3c || c === 0x3e || c === 0x3f || c === 0x40 || c === 0x5b || c === 0x5c || c === 0x5d || c === 0x5e || c === 0x7c
  );
}

function isForbiddenDomain(c: number): boolean {
  return isForbiddenHost(c) || (c >= 0x00 && c <= 0x1f) || c === 0x25 || c === 0x7f;
}

// Punycode (RFC 3492) encoder.
const PUNY_BASE = 36;
const PUNY_TMIN = 1;
const PUNY_TMAX = 26;
const PUNY_SKEW = 38;
const PUNY_DAMP = 700;

function punyAdapt(delta: number, numPoints: number, first: boolean): number {
  delta = first ? Math.floor(delta / PUNY_DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1) {
    delta = Math.floor(delta / (PUNY_BASE - PUNY_TMIN));
    k += PUNY_BASE;
  }
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * delta) / (delta + PUNY_SKEW));
}

function punyDigit(d: number): string {
  return String.fromCharCode(d < 26 ? d + 97 : d + 22);
}

export function punycodeEncode(input: string): string {
  const cps = Array.from(input, (ch) => ch.codePointAt(0) as number);
  let n = 128;
  let delta = 0;
  let bias = 72;
  let out = '';
  for (const cp of cps) if (cp < 0x80) out += String.fromCharCode(cp);
  const basic = out.length;
  let h = basic;
  if (basic > 0) out += '-';
  while (h < cps.length) {
    let m = Infinity;
    for (const cp of cps) if (cp >= n && cp < m) m = cp;
    delta += (m - n) * (h + 1);
    n = m;
    for (const cp of cps) {
      if (cp < n) delta++;
      if (cp === n) {
        let q = delta;
        for (let k = PUNY_BASE; ; k += PUNY_BASE) {
          const t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
          if (q < t) break;
          out += punyDigit(t + ((q - t) % (PUNY_BASE - t)));
          q = Math.floor((q - t) / (PUNY_BASE - t));
        }
        out += punyDigit(q);
        bias = punyAdapt(delta, h + 1, h === basic);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return out;
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** Strips leading and trailing C0 control or space code points. */
function trimControlAndSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

function domainToASCII(domain: string): string {
  // Simplified UTS #46: map ideographic full stops, lowercase, NFC, punycode non-ASCII labels.
  const mapped = domain.replace(/[\u3002\uff0e\uff61]/g, '.').toLowerCase().normalize('NFC');
  return mapped
    .split('.')
    .map((label) => (isAscii(label) ? label : 'xn--' + punycodeEncode(label)))
    .join('.');
}

function parseIPv4Number(s: string): number | null {
  if (s === '') return null;
  let radix = 10;
  if (s.length >= 2 && (s.startsWith('0x') || s.startsWith('0X'))) {
    s = s.slice(2);
    radix = 16;
  } else if (s.length >= 2 && s.startsWith('0')) {
    s = s.slice(1);
    radix = 8;
  }
  if (s === '') return 0;
  const re = radix === 10 ? /^[0-9]+$/ : radix === 16 ? /^[0-9a-fA-F]+$/ : /^[0-7]+$/;
  if (!re.test(s)) return null;
  return parseInt(s, radix);
}

function endsInANumber(input: string): boolean {
  const parts = input.split('.');
  if (parts[parts.length - 1] === '') {
    if (parts.length === 1) return false;
    parts.pop();
  }
  const last = parts[parts.length - 1] ?? '';
  if (last !== '' && /^[0-9]+$/.test(last)) return true;
  return parseIPv4Number(last) !== null;
}

function parseIPv4(input: string): number {
  const parts = input.split('.');
  if (parts[parts.length - 1] === '' && parts.length > 1) parts.pop();
  if (parts.length > 4) throw new UrlFailure('IPv4 too many parts');
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseIPv4Number(p);
    if (n === null) throw new UrlFailure('IPv4 non-numeric part');
    nums.push(n);
  }
  for (let i = 0; i < nums.length - 1; i++) if ((nums[i] as number) > 255) throw new UrlFailure('IPv4 part out of range');
  const last = nums[nums.length - 1] as number;
  if (last >= Math.pow(256, 5 - nums.length)) throw new UrlFailure('IPv4 out of range');
  let ipv4 = last;
  for (let i = 0; i < nums.length - 1; i++) ipv4 += (nums[i] as number) * Math.pow(256, 3 - i);
  return ipv4;
}

function serializeIPv4(n: number): string {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    out.unshift(n % 256);
    n = Math.floor(n / 256);
  }
  return out.join('.');
}

function parseIPv6(input: string): number[] {
  const address = [0, 0, 0, 0, 0, 0, 0, 0];
  let pieceIndex = 0;
  let compress: number | null = null;
  let p = 0;
  const cps = Array.from(input, (ch) => ch.codePointAt(0) as number);
  const at = (i: number): number => (i < cps.length ? (cps[i] as number) : -1);
  if (at(p) === 0x3a) {
    if (at(p + 1) !== 0x3a) throw new UrlFailure('IPv6 invalid compression');
    p += 2;
    pieceIndex++;
    compress = pieceIndex;
  }
  while (at(p) !== -1) {
    if (pieceIndex === 8) throw new UrlFailure('IPv6 too many pieces');
    if (at(p) === 0x3a) {
      if (compress !== null) throw new UrlFailure('IPv6 multiple compression');
      p++;
      pieceIndex++;
      compress = pieceIndex;
      continue;
    }
    let value = 0;
    let length = 0;
    while (length < 4 && at(p) !== -1 && isHexDigit(at(p))) {
      value = value * 0x10 + parseInt(String.fromCharCode(at(p)), 16);
      p++;
      length++;
    }
    if (at(p) === 0x2e) {
      if (length === 0) throw new UrlFailure('IPv4-in-IPv6 invalid');
      p -= length;
      if (pieceIndex > 6) throw new UrlFailure('IPv4-in-IPv6 too many pieces');
      let numbersSeen = 0;
      while (at(p) !== -1) {
        let ipv4Piece: number | null = null;
        if (numbersSeen > 0) {
          if (at(p) === 0x2e && numbersSeen < 4) p++;
          else throw new UrlFailure('IPv4-in-IPv6 invalid');
        }
        if (!(at(p) >= 0x30 && at(p) <= 0x39)) throw new UrlFailure('IPv4-in-IPv6 invalid');
        while (at(p) >= 0x30 && at(p) <= 0x39) {
          const num = at(p) - 0x30;
          if (ipv4Piece === null) ipv4Piece = num;
          else if (ipv4Piece === 0) throw new UrlFailure('IPv4-in-IPv6 leading zero');
          else ipv4Piece = ipv4Piece * 10 + num;
          if (ipv4Piece > 255) throw new UrlFailure('IPv4-in-IPv6 out of range');
          p++;
        }
        address[pieceIndex] = (address[pieceIndex] as number) * 0x100 + (ipv4Piece as number);
        numbersSeen++;
        if (numbersSeen === 2 || numbersSeen === 4) pieceIndex++;
      }
      if (numbersSeen !== 4) throw new UrlFailure('IPv4-in-IPv6 too few parts');
      break;
    } else if (at(p) === 0x3a) {
      p++;
      if (at(p) === -1) throw new UrlFailure('IPv6 invalid code point');
    } else if (at(p) !== -1) {
      throw new UrlFailure('IPv6 invalid code point');
    }
    address[pieceIndex] = value;
    pieceIndex++;
  }
  if (compress !== null) {
    let swaps = pieceIndex - compress;
    pieceIndex = 7;
    while (pieceIndex !== 0 && swaps > 0) {
      const tmp = address[compress + swaps - 1] as number;
      address[compress + swaps - 1] = address[pieceIndex] as number;
      address[pieceIndex] = tmp;
      pieceIndex--;
      swaps--;
    }
  } else if (pieceIndex !== 8) {
    throw new UrlFailure('IPv6 too few pieces');
  }
  return address;
}

function serializeIPv6(address: number[]): string {
  // Find the first longest run (length > 1) of zero pieces.
  let bestStart = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (address[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && address[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  let out = '';
  let ignore0 = false;
  for (let i = 0; i < 8; i++) {
    if (ignore0 && address[i] === 0) continue;
    ignore0 = false;
    if (bestStart === i) {
      out += i === 0 ? '::' : ':';
      ignore0 = true;
      continue;
    }
    out += (address[i] as number).toString(16);
    if (i !== 7) out += ':';
  }
  return out;
}

function parseOpaqueHost(input: string): string {
  for (const ch of input) {
    const c = ch.codePointAt(0) as number;
    if (c !== 0x25 && isForbiddenHost(c)) throw new UrlFailure('forbidden host code point');
  }
  return encodeString(input, c0Control);
}

function parseHost(input: string, isOpaque: boolean): string {
  if (input.startsWith('[')) {
    if (!input.endsWith(']')) throw new UrlFailure('IPv6 unclosed');
    return '[' + serializeIPv6(parseIPv6(input.slice(1, -1))) + ']';
  }
  if (isOpaque) return parseOpaqueHost(input);
  const domain = utf8Decode(percentDecodeString(input), false, true);
  const ascii = domainToASCII(domain);
  if (ascii === '') throw new UrlFailure('empty host');
  for (let i = 0; i < ascii.length; i++) {
    if (isForbiddenDomain(ascii.charCodeAt(i))) throw new UrlFailure('forbidden domain code point');
  }
  if (endsInANumber(ascii)) return serializeIPv4(parseIPv4(ascii));
  return ascii;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

const States = {
  SchemeStart: 0,
  Scheme: 1,
  NoScheme: 2,
  SpecialRelativeOrAuthority: 3,
  PathOrAuthority: 4,
  Relative: 5,
  RelativeSlash: 6,
  SpecialAuthoritySlashes: 7,
  SpecialAuthorityIgnoreSlashes: 8,
  Authority: 9,
  Host: 10,
  Port: 11,
  File: 12,
  FileSlash: 13,
  FileHost: 14,
  PathStart: 15,
  Path: 16,
  OpaquePath: 17,
  Query: 18,
  Fragment: 19,
  /** Host state entered through the hostname setter (stops at ':'). */
  Hostname: 20,
} as const;
type State = (typeof States)[keyof typeof States];
const S = States;

const EOF = -1;

function isAsciiAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}
function isAsciiDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isWindowsDriveLetter(s: string, normalizedOnly = false): boolean {
  return s.length === 2 && isAsciiAlpha(s.charCodeAt(0)) && (s.charAt(1) === ':' || (!normalizedOnly && s.charAt(1) === '|'));
}

function startsWithWindowsDriveLetter(cps: number[], p: number): boolean {
  if (cps.length - p < 2) return false;
  if (!isAsciiAlpha(cps[p] as number)) return false;
  const c1 = cps[p + 1] as number;
  if (c1 !== 0x3a && c1 !== 0x7c) return false;
  if (cps.length - p === 2) return true;
  const c2 = cps[p + 2] as number;
  return c2 === 0x2f || c2 === 0x5c || c2 === 0x3f || c2 === 0x23;
}

function isSingleDot(s: string): boolean {
  return s === '.' || s.toLowerCase() === '%2e';
}
function isDoubleDot(s: string): boolean {
  const l = s.toLowerCase();
  return l === '..' || l === '.%2e' || l === '%2e.' || l === '%2e%2e';
}

function shortenPath(url: UrlRecord): void {
  const path = url.path as string[];
  if (url.scheme === 'file' && path.length === 1 && isWindowsDriveLetter(path[0] as string, true)) return;
  path.pop();
}

function cloneRecord(r: UrlRecord): UrlRecord {
  return { ...r, path: typeof r.path === 'string' ? r.path : r.path.slice() };
}

function basicParse(rawInput: string, base: UrlRecord | null, url?: UrlRecord, stateOverride?: State): UrlRecord {
  let input = rawInput;
  if (!url) {
    url = { scheme: '', username: '', password: '', host: null, port: null, path: [], query: null, fragment: null };
    input = trimControlAndSpace(input);
  }
  input = input.replace(/[\t\n\r]/g, '');
  let state: State = stateOverride ?? S.SchemeStart;
  let buffer = '';
  let atSignSeen = false;
  let insideBrackets = false;
  let passwordTokenSeen = false;
  const cps = Array.from(input, (ch) => ch.codePointAt(0) as number);
  const special = (): boolean => isSpecialScheme((url).scheme);

  for (let p = 0; p <= cps.length; p++) {
    const c = p < cps.length ? (cps[p] as number) : EOF;
    const remainingStartsWith = (ch: number): boolean => cps[p + 1] === ch;
    switch (state) {
      case S.SchemeStart:
        if (c !== EOF && isAsciiAlpha(c)) {
          buffer += String.fromCharCode(c).toLowerCase();
          state = S.Scheme;
        } else if (stateOverride === undefined) {
          state = S.NoScheme;
          p--;
        } else {
          throw new UrlFailure('invalid scheme');
        }
        break;
      case S.Scheme:
        if (c !== EOF && (isAsciiAlpha(c) || isAsciiDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e)) {
          buffer += String.fromCharCode(c).toLowerCase();
        } else if (c === 0x3a) {
          if (stateOverride !== undefined) {
            if (isSpecialScheme(url.scheme) !== isSpecialScheme(buffer)) return url;
            if ((url.username !== '' || url.password !== '' || url.port !== null) && buffer === 'file') return url;
            if (url.scheme === 'file' && url.host === '') return url;
          }
          url.scheme = buffer;
          if (stateOverride !== undefined) {
            if (url.port === defaultPort(url.scheme)) url.port = null;
            return url;
          }
          buffer = '';
          if (url.scheme === 'file') {
            state = S.File;
          } else if (special() && base && base.scheme === url.scheme) {
            state = S.SpecialRelativeOrAuthority;
          } else if (special()) {
            state = S.SpecialAuthoritySlashes;
          } else if (remainingStartsWith(0x2f)) {
            state = S.PathOrAuthority;
            p++;
          } else {
            url.path = '';
            state = S.OpaquePath;
          }
        } else if (stateOverride === undefined) {
          buffer = '';
          state = S.NoScheme;
          p = -1;
        } else {
          throw new UrlFailure('invalid scheme');
        }
        break;
      case S.NoScheme:
        if (!base || (typeof base.path === 'string' && c !== 0x23)) {
          throw new UrlFailure('missing scheme, no base');
        } else if (typeof base.path === 'string' && c === 0x23) {
          url.scheme = base.scheme;
          url.path = base.path;
          url.query = base.query;
          url.fragment = '';
          state = S.Fragment;
        } else if (base.scheme !== 'file') {
          state = S.Relative;
          p--;
        } else {
          state = S.File;
          p--;
        }
        break;
      case S.SpecialRelativeOrAuthority:
        if (c === 0x2f && remainingStartsWith(0x2f)) {
          state = S.SpecialAuthorityIgnoreSlashes;
          p++;
        } else {
          state = S.Relative;
          p--;
        }
        break;
      case S.PathOrAuthority:
        if (c === 0x2f) state = S.Authority;
        else {
          state = S.Path;
          p--;
        }
        break;
      case S.Relative: {
        const b = base as UrlRecord;
        url.scheme = b.scheme;
        if (c === 0x2f) state = S.RelativeSlash;
        else if (special() && c === 0x5c) state = S.RelativeSlash;
        else {
          url.username = b.username;
          url.password = b.password;
          url.host = b.host;
          url.port = b.port;
          url.path = (b.path as string[]).slice();
          url.query = b.query;
          if (c === 0x3f) {
            url.query = '';
            state = S.Query;
          } else if (c === 0x23) {
            url.fragment = '';
            state = S.Fragment;
          } else if (c !== EOF) {
            url.query = null;
            shortenPath(url);
            state = S.Path;
            p--;
          }
        }
        break;
      }
      case S.RelativeSlash:
        if (special() && (c === 0x2f || c === 0x5c)) state = S.SpecialAuthorityIgnoreSlashes;
        else if (c === 0x2f) state = S.Authority;
        else {
          const b = base as UrlRecord;
          url.username = b.username;
          url.password = b.password;
          url.host = b.host;
          url.port = b.port;
          state = S.Path;
          p--;
        }
        break;
      case S.SpecialAuthoritySlashes:
        if (c === 0x2f && remainingStartsWith(0x2f)) {
          state = S.SpecialAuthorityIgnoreSlashes;
          p++;
        } else {
          state = S.SpecialAuthorityIgnoreSlashes;
          p--;
        }
        break;
      case S.SpecialAuthorityIgnoreSlashes:
        if (c !== 0x2f && c !== 0x5c) {
          state = S.Authority;
          p--;
        }
        break;
      case S.Authority:
        if (c === 0x40) {
          if (atSignSeen) buffer = '%40' + buffer;
          atSignSeen = true;
          for (const ch of buffer) {
            const cp = ch.codePointAt(0) as number;
            if (cp === 0x3a && !passwordTokenSeen) {
              passwordTokenSeen = true;
              continue;
            }
            const enc = encodeCodePoint(cp, userinfoSet);
            if (passwordTokenSeen) url.password += enc;
            else url.username += enc;
          }
          buffer = '';
        } else if (c === EOF || c === 0x2f || c === 0x3f || c === 0x23 || (special() && c === 0x5c)) {
          if (atSignSeen && buffer === '') throw new UrlFailure('credentials without host');
          p -= Array.from(buffer).length + 1;
          buffer = '';
          state = S.Host;
        } else {
          buffer += String.fromCodePoint(c);
        }
        break;
      case S.Host:
      case S.Hostname:
        if (stateOverride !== undefined && url.scheme === 'file') {
          p--;
          state = S.FileHost;
        } else if (c === 0x3a && !insideBrackets) {
          if (buffer === '') throw new UrlFailure('missing host');
          if (stateOverride === S.Hostname) return url;
          url.host = parseHost(buffer, !special());
          buffer = '';
          state = S.Port;
        } else if (c === EOF || c === 0x2f || c === 0x3f || c === 0x23 || (special() && c === 0x5c)) {
          p--;
          if (special() && buffer === '') throw new UrlFailure('missing host');
          if (stateOverride !== undefined && buffer === '' && (url.username !== '' || url.password !== '' || url.port !== null)) return url;
          url.host = parseHost(buffer, !special());
          buffer = '';
          state = S.PathStart;
          if (stateOverride !== undefined) return url;
        } else {
          if (c === 0x5b) insideBrackets = true;
          if (c === 0x5d) insideBrackets = false;
          buffer += String.fromCodePoint(c);
        }
        break;
      case S.Port:
        if (c !== EOF && isAsciiDigit(c)) {
          buffer += String.fromCharCode(c);
        } else if (c === EOF || c === 0x2f || c === 0x3f || c === 0x23 || (special() && c === 0x5c) || stateOverride !== undefined) {
          if (buffer !== '') {
            const port = parseInt(buffer, 10);
            if (port > 65535) throw new UrlFailure('port out of range');
            url.port = port === defaultPort(url.scheme) ? null : port;
            buffer = '';
            if (stateOverride !== undefined) return url;
          }
          if (stateOverride !== undefined) throw new UrlFailure('invalid port');
          state = S.PathStart;
          p--;
        } else {
          throw new UrlFailure('invalid port');
        }
        break;
      case S.File:
        url.scheme = 'file';
        url.host = '';
        if (c === 0x2f || c === 0x5c) state = S.FileSlash;
        else if (base && base.scheme === 'file') {
          url.host = base.host;
          url.path = (base.path as string[]).slice();
          url.query = base.query;
          if (c === 0x3f) {
            url.query = '';
            state = S.Query;
          } else if (c === 0x23) {
            url.fragment = '';
            state = S.Fragment;
          } else if (c !== EOF) {
            url.query = null;
            if (!startsWithWindowsDriveLetter(cps, p)) shortenPath(url);
            else url.path = [];
            state = S.Path;
            p--;
          }
        } else {
          state = S.Path;
          p--;
        }
        break;
      case S.FileSlash:
        if (c === 0x2f || c === 0x5c) state = S.FileHost;
        else {
          if (base && base.scheme === 'file') {
            url.host = base.host;
            const b0 = (base.path as string[])[0];
            if (!startsWithWindowsDriveLetter(cps, p) && b0 !== undefined && isWindowsDriveLetter(b0, true)) (url.path as string[]).push(b0);
          }
          state = S.Path;
          p--;
        }
        break;
      case S.FileHost:
        if (c === EOF || c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23) {
          p--;
          if (stateOverride === undefined && isWindowsDriveLetter(buffer)) {
            state = S.Path;
          } else if (buffer === '') {
            url.host = '';
            if (stateOverride !== undefined) return url;
            state = S.PathStart;
          } else {
            let host = parseHost(buffer, !special());
            if (host === 'localhost') host = '';
            url.host = host;
            if (stateOverride !== undefined) return url;
            buffer = '';
            state = S.PathStart;
          }
        } else {
          buffer += String.fromCodePoint(c);
        }
        break;
      case S.PathStart:
        if (special()) {
          state = S.Path;
          if (c !== 0x2f && c !== 0x5c) p--;
        } else if (stateOverride === undefined && c === 0x3f) {
          url.query = '';
          state = S.Query;
        } else if (stateOverride === undefined && c === 0x23) {
          url.fragment = '';
          state = S.Fragment;
        } else if (c !== EOF) {
          state = S.Path;
          if (c !== 0x2f) p--;
        } else if (stateOverride !== undefined && url.host === null) {
          (url.path as string[]).push('');
        }
        break;
      case S.Path:
        if (c === EOF || c === 0x2f || (special() && c === 0x5c) || (stateOverride === undefined && (c === 0x3f || c === 0x23))) {
          const path = url.path as string[];
          const slash = c === 0x2f || (special() && c === 0x5c);
          if (isDoubleDot(buffer)) {
            shortenPath(url);
            if (!slash) path.push('');
          } else if (isSingleDot(buffer) && !slash) {
            path.push('');
          } else if (!isSingleDot(buffer)) {
            if (url.scheme === 'file' && path.length === 0 && isWindowsDriveLetter(buffer)) buffer = buffer.charAt(0) + ':';
            path.push(buffer);
          }
          buffer = '';
          if (c === 0x3f) {
            url.query = '';
            state = S.Query;
          }
          if (c === 0x23) {
            url.fragment = '';
            state = S.Fragment;
          }
        } else {
          buffer += encodeCodePoint(c, pathSet);
        }
        break;
      case S.OpaquePath:
        if (c === 0x3f) {
          url.query = '';
          state = S.Query;
        } else if (c === 0x23) {
          url.fragment = '';
          state = S.Fragment;
        } else if (c === 0x20) {
          const next = cps[p + 1];
          url.path = (url.path as string) + (next === 0x3f || next === 0x23 ? '%20' : ' ');
        } else if (c !== EOF) {
          url.path = (url.path as string) + encodeCodePoint(c, c0Control);
        }
        break;
      case S.Query:
        if ((stateOverride === undefined && c === 0x23) || c === EOF) {
          url.query = (url.query ?? '') + encodeString(buffer, special() ? specialQuerySet : querySet);
          buffer = '';
          if (c === 0x23) {
            url.fragment = '';
            state = S.Fragment;
          }
        } else if (c !== EOF) {
          buffer += String.fromCodePoint(c);
        }
        break;
      case S.Fragment:
        if (c !== EOF) url.fragment = (url.fragment ?? '') + encodeCodePoint(c, fragmentSet);
        break;
    }
  }
  return url;
}

function serializePath(url: UrlRecord): string {
  if (typeof url.path === 'string') return url.path;
  let out = '';
  for (const seg of url.path) out += '/' + seg;
  return out;
}

function serialize(url: UrlRecord, excludeFragment = false): string {
  let out = url.scheme + ':';
  if (url.host !== null) {
    out += '//';
    if (url.username !== '' || url.password !== '') {
      out += url.username;
      if (url.password !== '') out += ':' + url.password;
      out += '@';
    }
    out += url.host;
    if (url.port !== null) out += ':' + url.port;
  } else if (typeof url.path !== 'string' && url.path.length > 1 && url.path[0] === '') {
    out += '/.';
  }
  out += serializePath(url);
  if (url.query !== null) out += '?' + url.query;
  if (!excludeFragment && url.fragment !== null) out += '#' + url.fragment;
  return out;
}

function hasCredentialsCapability(url: UrlRecord): boolean {
  return url.host !== null && url.host !== '' && url.scheme !== 'file';
}

// ---------------------------------------------------------------------------------------------
// application/x-www-form-urlencoded
// ---------------------------------------------------------------------------------------------

function formEncode(s: string): string {
  const bytes = utf8Encode(s);
  let out = '';
  for (const b of bytes) {
    if (b === 0x20) out += '+';
    else if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2a || b === 0x2d || b === 0x2e || b === 0x5f) {
      out += String.fromCharCode(b);
    } else {
      out += pctByte(b);
    }
  }
  return out;
}

function formDecode(s: string): string {
  return utf8Decode(percentDecodeBytes(utf8Encode(s.replace(/\+/g, ' '))), false, true);
}

export function parseUrlencoded(input: string): [string, string][] {
  const out: [string, string][] = [];
  for (const seq of input.split('&')) {
    if (seq === '') continue;
    const i = seq.indexOf('=');
    const name = i >= 0 ? seq.slice(0, i) : seq;
    const value = i >= 0 ? seq.slice(i + 1) : '';
    out.push([formDecode(name), formDecode(value)]);
  }
  return out;
}

export function serializeUrlencoded(list: Iterable<readonly [string, string]>): string {
  const parts: string[] = [];
  for (const [k, v] of list) parts.push(formEncode(k) + '=' + formEncode(v));
  return parts.join('&');
}

/** USVString conversion: lone surrogates → U+FFFD. */
function toUSV(v: unknown): string {
  const s = String(v);
  return s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
}

// ---------------------------------------------------------------------------------------------
// Public classes
// ---------------------------------------------------------------------------------------------

type SearchParamsInit = string | URLSearchParams | Iterable<readonly [unknown, unknown] | readonly unknown[]> | Record<string, unknown>;

export class URLSearchParams {
  #list: [string, string][] = [];
  #url: URL | null = null;

  constructor(init?: SearchParamsInit | null) {
    if (init === undefined || init === null) return;
    if (typeof init === 'string') {
      this.#list = parseUrlencoded(init.startsWith('?') ? init.slice(1) : init);
    } else if (init instanceof URLSearchParams) {
      this.#list = init.#list.map(([k, v]) => [k, v]);
    } else if (typeof init === 'object' && typeof (init as Iterable<unknown>)[Symbol.iterator] === 'function') {
      for (const pair of init as Iterable<unknown>) {
        const arr = Array.from(pair as Iterable<unknown>);
        if (arr.length !== 2) throw new TypeError("Failed to construct 'URLSearchParams': each query pair must be an iterable [name, value] tuple");
        this.#list.push([toUSV(arr[0]), toUSV(arr[1])]);
      }
    } else if (typeof init === 'object') {
      for (const key of Object.keys(init)) this.#list.push([toUSV(key), toUSV((init as Record<string, unknown>)[key])]);
    } else {
      this.#list = parseUrlencoded(toUSV(init));
    }
  }

  /** @internal Links this object to a URL (for URL#searchParams). */
  static _attach(params: URLSearchParams, url: URL, query: string | null): void {
    params.#url = url;
    params.#list = query ? parseUrlencoded(query) : [];
  }

  /** @internal Replaces the list from a URL's new query without notifying the URL. */
  static _reset(params: URLSearchParams, query: string | null): void {
    params.#list = query ? parseUrlencoded(query) : [];
  }

  #update(): void {
    if (this.#url) URL._setQueryFromParams(this.#url, this.#list.length ? serializeUrlencoded(this.#list) : null);
  }

  get size(): number {
    return this.#list.length;
  }

  append(name: string, value: string): void {
    this.#list.push([toUSV(name), toUSV(value)]);
    this.#update();
  }

  delete(name: string, value?: string): void {
    const n = toUSV(name);
    const v = value === undefined ? undefined : toUSV(value);
    this.#list = this.#list.filter(([k, val]) => !(k === n && (v === undefined || val === v)));
    this.#update();
  }

  get(name: string): string | null {
    const n = toUSV(name);
    const e = this.#list.find(([k]) => k === n);
    return e ? e[1] : null;
  }

  getAll(name: string): string[] {
    const n = toUSV(name);
    return this.#list.filter(([k]) => k === n).map(([, v]) => v);
  }

  has(name: string, value?: string): boolean {
    const n = toUSV(name);
    const v = value === undefined ? undefined : toUSV(value);
    return this.#list.some(([k, val]) => k === n && (v === undefined || val === v));
  }

  set(name: string, value: string): void {
    const n = toUSV(name);
    const v = toUSV(value);
    const i = this.#list.findIndex(([k]) => k === n);
    if (i < 0) {
      this.#list.push([n, v]);
    } else {
      this.#list[i] = [n, v];
      this.#list = this.#list.filter(([k], j) => j <= i || k !== n);
    }
    this.#update();
  }

  sort(): void {
    // Stable sort by UTF-16 code units of the name.
    const indexed = this.#list.map((e, i) => ({ e, i }));
    indexed.sort((a, b) => (a.e[0] < b.e[0] ? -1 : a.e[0] > b.e[0] ? 1 : a.i - b.i));
    this.#list = indexed.map((x) => x.e);
    this.#update();
  }

  forEach(cb: (value: string, key: string, parent: URLSearchParams) => void, thisArg?: unknown): void {
    for (let i = 0; i < this.#list.length; i++) {
      const [k, v] = this.#list[i] as [string, string];
      cb.call(thisArg, v, k, this);
    }
  }

  *entries(): IterableIterator<[string, string]> {
    for (let i = 0; i < this.#list.length; i++) {
      const [k, v] = this.#list[i] as [string, string];
      yield [k, v];
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
    return 'URLSearchParams';
  }

  toString(): string {
    return serializeUrlencoded(this.#list);
  }
}

export class URL {
  #url: UrlRecord;
  #params: URLSearchParams;

  constructor(url: string | URL, base?: string | URL) {
    let baseRecord: UrlRecord | null = null;
    if (base !== undefined) {
      try {
        baseRecord = basicParse(toUSV(base), null);
      } catch {
        throw new TypeError(`Invalid base URL: ${String(base)}`);
      }
    }
    try {
      this.#url = basicParse(toUSV(url), baseRecord);
    } catch {
      throw new TypeError(`Invalid URL: ${String(url)}`);
    }
    this.#params = new URLSearchParams();
    URLSearchParams._attach(this.#params, this, this.#url.query);
  }

  static canParse(url: string, base?: string): boolean {
    try {
      new URL(url, base);
      return true;
    } catch {
      return false;
    }
  }

  static parse(url: string, base?: string): URL | null {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  }

  /** @internal Called by the linked URLSearchParams. */
  static _setQueryFromParams(u: URL, query: string | null): void {
    u.#url.query = query;
    if (query === null) u.#stripTrailingSpacesFromOpaquePath();
  }

  #stripTrailingSpacesFromOpaquePath(): void {
    const u = this.#url;
    if (typeof u.path !== 'string' || u.fragment !== null || u.query !== null) return;
    u.path = u.path.replace(/ +$/, '');
  }

  get href(): string {
    return serialize(this.#url);
  }
  set href(v: string) {
    let rec: UrlRecord;
    try {
      rec = basicParse(toUSV(v), null);
    } catch {
      throw new TypeError(`Invalid URL: ${String(v)}`);
    }
    this.#url = rec;
    URLSearchParams._reset(this.#params, rec.query);
  }

  get origin(): string {
    const u = this.#url;
    if (u.scheme === 'blob') {
      try {
        const inner = new URL(serializePath(u));
        return inner.protocol === 'http:' || inner.protocol === 'https:' ? inner.origin : 'null';
      } catch {
        return 'null';
      }
    }
    if (u.scheme === 'ftp' || u.scheme === 'http' || u.scheme === 'https' || u.scheme === 'ws' || u.scheme === 'wss') {
      return u.scheme + '://' + (u.host ?? '') + (u.port !== null ? ':' + u.port : '');
    }
    return 'null';
  }

  get protocol(): string {
    return this.#url.scheme + ':';
  }
  set protocol(v: string) {
    try {
      basicParse(toUSV(v) + ':', null, this.#url, S.SchemeStart);
    } catch {
      // setters ignore failures
    }
  }

  get username(): string {
    return this.#url.username;
  }
  set username(v: string) {
    if (!hasCredentialsCapability(this.#url)) return;
    this.#url.username = encodeString(toUSV(v), userinfoSet);
  }

  get password(): string {
    return this.#url.password;
  }
  set password(v: string) {
    if (!hasCredentialsCapability(this.#url)) return;
    this.#url.password = encodeString(toUSV(v), userinfoSet);
  }

  get host(): string {
    const u = this.#url;
    if (u.host === null) return '';
    return u.port === null ? u.host : u.host + ':' + u.port;
  }
  set host(v: string) {
    if (typeof this.#url.path === 'string') return;
    const copy = cloneRecord(this.#url);
    try {
      this.#url = basicParse(toUSV(v), null, copy, S.Host);
    } catch {
      // ignore
    }
  }

  get hostname(): string {
    return this.#url.host ?? '';
  }
  set hostname(v: string) {
    if (typeof this.#url.path === 'string') return;
    const copy = cloneRecord(this.#url);
    try {
      this.#url = basicParse(toUSV(v), null, copy, S.Hostname);
    } catch {
      // ignore
    }
  }

  get port(): string {
    return this.#url.port === null ? '' : String(this.#url.port);
  }
  set port(v: string) {
    const u = this.#url;
    if (!hasCredentialsCapability(u)) return;
    const s = String(v);
    if (s === '') {
      u.port = null;
      return;
    }
    const copy = cloneRecord(u);
    try {
      const digits = /^[0-9]+/.exec(s);
      if (!digits) return;
      this.#url = basicParse(digits[0], null, copy, S.Port);
    } catch {
      // ignore
    }
  }

  get pathname(): string {
    return serializePath(this.#url);
  }
  set pathname(v: string) {
    if (typeof this.#url.path === 'string') return;
    const copy = cloneRecord(this.#url);
    copy.path = [];
    try {
      this.#url = basicParse(toUSV(v), null, copy, S.PathStart);
    } catch {
      // ignore
    }
  }

  get search(): string {
    const q = this.#url.query;
    return q === null || q === '' ? '' : '?' + q;
  }
  set search(v: string) {
    let s = toUSV(v);
    if (s === '') {
      this.#url.query = null;
      URLSearchParams._reset(this.#params, null);
      this.#stripTrailingSpacesFromOpaquePath();
      return;
    }
    if (s.startsWith('?')) s = s.slice(1);
    const copy = cloneRecord(this.#url);
    copy.query = '';
    this.#url = basicParse(s, null, copy, S.Query);
    URLSearchParams._reset(this.#params, this.#url.query);
  }

  get searchParams(): URLSearchParams {
    return this.#params;
  }

  get hash(): string {
    const f = this.#url.fragment;
    return f === null || f === '' ? '' : '#' + f;
  }
  set hash(v: string) {
    let s = toUSV(v);
    if (s === '') {
      this.#url.fragment = null;
      this.#stripTrailingSpacesFromOpaquePath();
      return;
    }
    if (s.startsWith('#')) s = s.slice(1);
    const copy = cloneRecord(this.#url);
    copy.fragment = '';
    this.#url = basicParse(s, null, copy, S.Fragment);
  }

  get [Symbol.toStringTag](): string {
    return 'URL';
  }

  toString(): string {
    return this.href;
  }

  toJSON(): string {
    return this.href;
  }
}

/** Resolves `input` against `base` (both strings); returns null when it cannot be parsed. */
export function resolveUrl(input: string, base?: string): string | null {
  try {
    return new URL(input, base).href;
  } catch {
    return null;
  }
}
