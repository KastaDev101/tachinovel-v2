/**
 * Minimal protobuf (proto3/proto2 text → wire codec) for @libs/fetch's fetchProto, in place of
 * protobufjs, which LNReader uses and TachiNovel does not ship. Covers what plugins need: messages,
 * nested types, enums, oneof, optional/repeated (packed or not), maps, every scalar type and the
 * google.protobuf wrapper/Timestamp types. Behaves like protobufjs as LNReader configures it:
 *   - field names camelCased (`chapter_id` → `chapterId`), as protobufjs.parse does by default;
 *   - decoded messages are plain objects with proto3 defaults for singular scalars/enums
 *     (0, '', false), [] for repeated, {} for maps, absent for unset messages and optional fields;
 *   - 64-bit integers decode to numbers (React Native has no `long`, so protobufjs does the same);
 *   - the set member of a oneof is named by a virtual property, `obj[oneofName] = fieldName`.
 * Unsupported: groups, extensions, custom options (all ignored or rejected while parsing).
 */
import { utf8Decode, utf8Encode } from '../polyfills/utf8.ts';

type Scalar = 'double' | 'float' | 'int32' | 'int64' | 'uint32' | 'uint64' | 'sint32' | 'sint64' | 'fixed32' | 'fixed64' | 'sfixed32' | 'sfixed64' | 'bool' | 'string' | 'bytes';
const SCALARS = new Set<string>(['double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes']);

interface FieldDef {
  name: string;
  id: number;
  /** Scalar name or the type name as written (resolved lazily). */
  type: string;
  repeated: boolean;
  /** proto3 `optional` or proto2 optional/required: no default when unset. */
  explicit: boolean;
  oneof?: string;
  /** map<keyType, valueType> */
  map?: { key: string; value: string };
  /** packed=false option */
  packed?: boolean;
}

interface MessageDef {
  kind: 'message';
  fullName: string;
  fields: FieldDef[];
  scope: string;
}

interface EnumDef {
  kind: 'enum';
  fullName: string;
  values: Map<string, number>;
}

type TypeDef = MessageDef | EnumDef;

export class ProtoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtoError';
  }
}

function camelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ---------- parsing ----------

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?[0-9][0-9a-zA-Z_.+-]*|[A-Za-z_.][A-Za-z0-9_.]*|[{}[\]()<>;=,:]/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new ProtoError(`Unexpected character "${src[i] ?? ''}" in proto at ${i}`);
    i = re.lastIndex;
    const t = m[0];
    if (/^\s/.test(t) || t.startsWith('//') || t.startsWith('/*')) continue;
    out.push(t);
  }
  return out;
}

class Parser {
  private i = 0;
  readonly types = new Map<string, TypeDef>();
  private pkg = '';
  private readonly t: string[];

  constructor(tokens: string[]) {
    this.t = tokens;
  }

  private peek(): string | undefined {
    return this.t[this.i];
  }
  private next(): string {
    const v = this.t[this.i++];
    if (v === undefined) throw new ProtoError('Unexpected end of proto');
    return v;
  }
  private expect(v: string): void {
    const got = this.next();
    if (got !== v) throw new ProtoError(`Expected "${v}" in proto, got "${got}"`);
  }
  private skipStatement(): void {
    // Up to ';' or a balanced {...} block.
    let depth = 0;
    for (;;) {
      const v = this.next();
      if (v === '{') depth++;
      else if (v === '}') {
        depth--;
        if (depth <= 0) return;
      } else if (v === ';' && depth === 0) return;
    }
  }
  private skipOptions(): void {
    if (this.peek() !== '[') return;
    let depth = 0;
    for (;;) {
      const v = this.next();
      if (v === '[') depth++;
      else if (v === ']' && --depth === 0) return;
    }
  }

  parse(): void {
    while (this.peek() !== undefined) {
      const v = this.next();
      switch (v) {
        case 'syntax':
        case 'edition':
        case 'import':
        case 'option':
          this.i--;
          this.skipStatement();
          break;
        case 'package':
          this.pkg = this.next();
          this.expect(';');
          break;
        case 'message':
          this.message(this.pkg);
          break;
        case 'enum':
          this.enum(this.pkg);
          break;
        case ';':
          break;
        default: // service, extend, …
          this.skipStatement();
      }
    }
  }

  private qualify(scope: string, name: string): string {
    return scope ? `${scope}.${name}` : name;
  }

  private message(scope: string): void {
    const name = this.next();
    const fullName = this.qualify(scope, name);
    const def: MessageDef = { kind: 'message', fullName, fields: [], scope: fullName };
    this.types.set(fullName, def);
    this.expect('{');
    this.messageBody(def, undefined);
  }

  private messageBody(def: MessageDef, oneof: string | undefined): void {
    for (;;) {
      const v = this.next();
      if (v === '}') return;
      if (v === ';') continue;
      if (v === 'message') this.message(def.fullName);
      else if (v === 'enum') this.enum(def.fullName);
      else if (v === 'oneof') {
        const name = camelCase(this.next());
        this.expect('{');
        this.messageBody(def, name);
      } else if (v === 'option' || v === 'reserved' || v === 'extensions' || v === 'extend') {
        this.i--;
        this.skipStatement();
      } else if (v === 'map') {
        this.expect('<');
        const key = this.next();
        this.expect(',');
        const value = this.next();
        this.expect('>');
        const fname = this.next();
        this.expect('=');
        const id = Number(this.next());
        this.skipOptions();
        this.expect(';');
        def.fields.push({ name: camelCase(fname), id, type: value, repeated: false, explicit: false, map: { key, value } });
      } else {
        let label = '';
        let type = v;
        if (v === 'repeated' || v === 'optional' || v === 'required') {
          label = v;
          type = this.next();
        }
        if (type === 'group') throw new ProtoError('proto groups are not supported');
        const fname = this.next();
        this.expect('=');
        const id = Number(this.next());
        if (!Number.isInteger(id) || id <= 0) throw new ProtoError(`Bad field number for ${fname}`);
        let packed: boolean | undefined;
        if (this.peek() === '[') {
          const start = this.i;
          this.skipOptions();
          const opts = this.t.slice(start, this.i).join(' ');
          if (/packed\s*=\s*false/.test(opts)) packed = false;
        }
        this.expect(';');
        const field: FieldDef = { name: camelCase(fname), id, type, repeated: label === 'repeated', explicit: label === 'optional' || label === 'required' || oneof !== undefined };
        if (oneof) field.oneof = oneof;
        if (packed === false) field.packed = false;
        def.fields.push(field);
      }
    }
  }

  private enum(scope: string): void {
    const name = this.next();
    const def: EnumDef = { kind: 'enum', fullName: this.qualify(scope, name), values: new Map() };
    this.types.set(def.fullName, def);
    this.expect('{');
    for (;;) {
      const v = this.next();
      if (v === '}') return;
      if (v === ';') continue;
      if (v === 'option' || v === 'reserved') {
        this.i--;
        this.skipStatement();
        continue;
      }
      this.expect('=');
      const n = Number(this.next());
      this.skipOptions();
      this.expect(';');
      def.values.set(v, n);
    }
  }
}

/** google.protobuf well-known types, used when a proto references them without defining them. */
const WELL_KNOWN = `
package google.protobuf;
message DoubleValue { double value = 1; }
message FloatValue { float value = 1; }
message Int64Value { int64 value = 1; }
message UInt64Value { uint64 value = 1; }
message Int32Value { int32 value = 1; }
message UInt32Value { uint32 value = 1; }
message BoolValue { bool value = 1; }
message StringValue { string value = 1; }
message BytesValue { bytes value = 1; }
message Timestamp { int64 seconds = 1; int32 nanos = 2; }
message Duration { int64 seconds = 1; int32 nanos = 2; }
message Empty {}
`;

// ---------- wire format ----------

class Writer {
  private buf: number[] = [];

  varint(lo: number, hi = 0): void {
    lo >>>= 0;
    hi >>>= 0;
    while (hi !== 0 || lo > 0x7f) {
      this.buf.push((lo & 0x7f) | 0x80);
      lo = ((lo >>> 7) | (hi << 25)) >>> 0;
      hi >>>= 7;
    }
    this.buf.push(lo);
  }
  tag(id: number, wire: number): void {
    this.varint(id * 8 + wire);
  }
  bytes(b: ArrayLike<number>): void {
    this.varint(b.length);
    for (let i = 0; i < b.length; i++) this.buf.push((b[i] ?? 0) & 0xff);
  }
  fixed32(v: number): void {
    v >>>= 0;
    this.buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  float(v: number, size: 4 | 8): void {
    const dv = new DataView(new ArrayBuffer(size));
    if (size === 4) dv.setFloat32(0, v, true);
    else dv.setFloat64(0, v, true);
    for (let i = 0; i < size; i++) this.buf.push(dv.getUint8(i));
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

/** A JS number (or numeric string) as two's-complement 64-bit lo/hi words. */
function split64(v: number): [number, number] {
  if (!Number.isFinite(v)) throw new ProtoError(`Invalid 64-bit integer ${v}`);
  const n = Math.trunc(v);
  const abs = Math.abs(n);
  let lo = abs % 0x100000000;
  let hi = Math.floor(abs / 0x100000000) % 0x100000000;
  if (n < 0) {
    lo = (~lo + 1) >>> 0;
    hi = (~hi + (lo === 0 ? 1 : 0)) >>> 0;
  }
  return [lo >>> 0, hi >>> 0];
}

function join64(lo: number, hi: number, signed: boolean): number {
  if (signed && hi & 0x80000000) {
    const nlo = (~lo + 1) >>> 0;
    const nhi = (~hi + (nlo === 0 ? 1 : 0)) >>> 0;
    return -(nhi * 0x100000000 + nlo);
  }
  return (hi >>> 0) * 0x100000000 + (lo >>> 0);
}

class Reader {
  pos = 0;
  readonly buf: Uint8Array;
  readonly end: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.end = buf.length;
  }

  varint64(): [number, number] {
    let lo = 0;
    let hi = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new ProtoError('Truncated varint');
      const b = this.buf[this.pos++] as number;
      if (shift < 28) lo |= (b & 0x7f) << shift;
      else if (shift === 28) {
        lo |= (b & 0x0f) << 28;
        hi |= (b & 0x7f) >> 4;
      } else hi |= (b & 0x7f) << (shift - 32);
      shift += 7;
      if ((b & 0x80) === 0) return [lo >>> 0, hi >>> 0];
    }
    throw new ProtoError('Varint too long');
  }
  uint32(): number {
    return this.varint64()[0];
  }
  fixed32(): number {
    if (this.pos + 4 > this.end) throw new ProtoError('Truncated fixed32');
    const b = this.buf;
    const p = this.pos;
    this.pos += 4;
    return ((b[p] as number) | ((b[p + 1] as number) << 8) | ((b[p + 2] as number) << 16) | ((b[p + 3] as number) << 24)) >>> 0;
  }
  float(size: 4 | 8): number {
    if (this.pos + size > this.end) throw new ProtoError('Truncated float');
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, size);
    this.pos += size;
    return size === 4 ? dv.getFloat32(0, true) : dv.getFloat64(0, true);
  }
  bytes(): Uint8Array {
    const len = this.uint32();
    if (this.pos + len > this.end) throw new ProtoError('Truncated length-delimited field');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varint64();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2:
        this.bytes();
        break;
      case 5:
        this.pos += 4;
        break;
      default:
        throw new ProtoError(`Unsupported wire type ${wire}`);
    }
    if (this.pos > this.end) throw new ProtoError('Truncated field');
  }
}

function wireTypeOf(type: Scalar | 'enum' | 'message'): number {
  switch (type) {
    case 'double':
    case 'fixed64':
    case 'sfixed64':
      return 1;
    case 'float':
    case 'fixed32':
    case 'sfixed32':
      return 5;
    case 'string':
    case 'bytes':
    case 'message':
      return 2;
    case 'int32':
    case 'int64':
    case 'uint32':
    case 'uint64':
    case 'sint32':
    case 'sint64':
    case 'bool':
    case 'enum':
      return 0;
  }
}

function defaultOf(type: Scalar | 'enum'): unknown {
  switch (type) {
    case 'string':
      return '';
    case 'bool':
      return false;
    case 'bytes':
      return new Uint8Array(0);
    case 'double':
    case 'float':
    case 'int32':
    case 'int64':
    case 'uint32':
    case 'uint64':
    case 'sint32':
    case 'sint64':
    case 'fixed32':
    case 'fixed64':
    case 'sfixed32':
    case 'sfixed64':
    case 'enum':
      return 0;
  }
}

function toNumber(v: unknown, what: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'boolean' ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new ProtoError(`${what}: expected a number, got ${typeof v}`);
  return n;
}

export class ProtoType {
  private readonly root: ProtoRoot;
  readonly def: MessageDef;

  constructor(root: ProtoRoot, def: MessageDef) {
    this.root = root;
    this.def = def;
  }

  /** Encodes a plain object (field names camelCased); throws ProtoError on values of the wrong type. */
  encode(value: unknown): Uint8Array {
    const w = new Writer();
    this.write(w, value, this.def.fullName);
    return w.finish();
  }

  /** Decodes wire bytes into a plain object (see the file header for the shape). */
  decode(bytes: Uint8Array): Record<string, unknown> {
    return this.read(new Reader(bytes));
  }

  private write(w: Writer, value: unknown, path: string): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProtoError(`${path}: expected an object`);
    const obj = value as Record<string, unknown>;
    for (const f of this.def.fields) {
      const v = obj[f.name];
      if (v === undefined || v === null) continue;
      const where = `${path}.${f.name}`;
      if (f.map) {
        if (typeof v !== 'object') throw new ProtoError(`${where}: expected an object map`);
        for (const [k, mv] of Object.entries(v as Record<string, unknown>)) {
          const entry = new Writer();
          this.writeValue(entry, 1, f.map.key, f.map.key === 'bool' ? k === 'true' : k, `${where}[key]`);
          this.writeValue(entry, 2, f.map.value, mv, `${where}[${k}]`);
          w.tag(f.id, 2);
          w.bytes(entry.finish());
        }
        continue;
      }
      if (f.repeated) {
        if (!Array.isArray(v)) throw new ProtoError(`${where}: expected an array`);
        const kind = this.kindOf(f.type);
        if (kind !== 'message' && kind !== 'string' && kind !== 'bytes' && f.packed !== false) {
          const packed = new Writer();
          for (const item of v as unknown[]) this.writeRaw(packed, f.type, item, where);
          w.tag(f.id, 2);
          w.bytes(packed.finish());
        } else {
          for (const item of v as unknown[]) this.writeValue(w, f.id, f.type, item, where);
        }
        continue;
      }
      this.writeValue(w, f.id, f.type, v, where);
    }
  }

  private kindOf(type: string): Scalar | 'enum' | 'message' {
    if (SCALARS.has(type)) return type as Scalar;
    return this.root.resolve(type, this.def.scope).kind;
  }

  private writeValue(w: Writer, id: number, type: string, v: unknown, where: string): void {
    const kind = this.kindOf(type);
    w.tag(id, wireTypeOf(kind));
    this.writeRaw(w, type, v, where);
  }

  private writeRaw(w: Writer, type: string, v: unknown, where: string): void {
    const kind = this.kindOf(type);
    switch (kind) {
      case 'message': {
        const t = this.root.resolve(type, this.def.scope) as MessageDef;
        const inner = new Writer();
        new ProtoType(this.root, t).write(inner, v, where);
        w.bytes(inner.finish());
        return;
      }
      case 'enum': {
        const e = this.root.resolve(type, this.def.scope) as EnumDef;
        const n = typeof v === 'string' && e.values.has(v) ? (e.values.get(v) as number) : toNumber(v, where);
        const [lo, hi] = split64(n);
        w.varint(lo, hi);
        return;
      }
      case 'string':
        if (typeof v !== 'string') throw new ProtoError(`${where}: expected a string`);
        w.bytes(utf8Encode(v));
        return;
      case 'bytes':
        if (v instanceof Uint8Array || Array.isArray(v)) w.bytes(v as ArrayLike<number>);
        else throw new ProtoError(`${where}: expected bytes`);
        return;
      case 'bool':
        w.varint(v ? 1 : 0);
        return;
      case 'double':
        w.float(toNumber(v, where), 8);
        return;
      case 'float':
        w.float(toNumber(v, where), 4);
        return;
      case 'fixed32':
      case 'sfixed32':
        w.fixed32(toNumber(v, where));
        return;
      case 'fixed64':
      case 'sfixed64': {
        const [lo, hi] = split64(toNumber(v, where));
        w.fixed32(lo);
        w.fixed32(hi);
        return;
      }
      case 'sint32':
      case 'sint64': {
        const n = Math.trunc(toNumber(v, where));
        const z = n >= 0 ? n * 2 : -n * 2 - 1;
        const [lo, hi] = split64(z);
        w.varint(lo, hi);
        return;
      }
      case 'int32':
      case 'int64':
      case 'uint32':
      case 'uint64': {
        // Negative int32 is sign-extended to 10 bytes, like protobufjs.
        const [lo, hi] = split64(toNumber(v, where));
        w.varint(lo, hi);
      }
    }
  }

  private read(r: Reader): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const byId = new Map<number, FieldDef>();
    for (const f of this.def.fields) {
      byId.set(f.id, f);
      if (f.map) out[f.name] = {};
      else if (f.repeated) out[f.name] = [];
      else if (!f.explicit) {
        const kind = this.kindOf(f.type);
        if (kind !== 'message') out[f.name] = defaultOf(kind);
      }
    }
    while (r.pos < r.end) {
      const key = r.uint32();
      const id = key >>> 3;
      const wire = key & 7;
      const f = byId.get(id);
      if (!f) {
        r.skip(wire);
        continue;
      }
      if (f.map) {
        const er = new Reader(r.bytes());
        let k: unknown = defaultOf(SCALARS.has(f.map.key) ? (f.map.key as Scalar) : 'string');
        let val: unknown;
        while (er.pos < er.end) {
          const ek = er.uint32();
          if (ek >>> 3 === 1) k = this.readValue(er, f.map.key, ek & 7);
          else if (ek >>> 3 === 2) val = this.readValue(er, f.map.value, ek & 7);
          else er.skip(ek & 7);
        }
        (out[f.name] as Record<string, unknown>)[String(k)] = val ?? (this.kindOf(f.map.value) === 'message' ? {} : defaultOf(this.kindOf(f.map.value) as Scalar));
        continue;
      }
      if (f.repeated) {
        const list = out[f.name] as unknown[];
        const kind = this.kindOf(f.type);
        if (wire === 2 && kind !== 'message' && kind !== 'string' && kind !== 'bytes') {
          const packed = r.bytes();
          const pr = new Reader(packed);
          while (pr.pos < pr.end) list.push(this.readValue(pr, f.type, wireTypeOf(kind)));
        } else list.push(this.readValue(r, f.type, wire));
        continue;
      }
      out[f.name] = this.readValue(r, f.type, wire);
      if (f.oneof) {
        for (const other of this.def.fields) if (other.oneof === f.oneof && other !== f) delete out[other.name];
        out[f.oneof] = f.name;
      }
    }
    return out;
  }

  private readValue(r: Reader, type: string, wire: number): unknown {
    const kind = this.kindOf(type);
    if (wireTypeOf(kind) !== wire) {
      throw new ProtoError(`${this.def.fullName}: wire type ${wire} does not match ${type}`);
    }
    switch (kind) {
      case 'message': {
        const t = this.root.resolve(type, this.def.scope) as MessageDef;
        return new ProtoType(this.root, t).read(new Reader(r.bytes()));
      }
      case 'string':
        return utf8Decode(r.bytes(), false, true);
      case 'bytes':
        return Uint8Array.from(r.bytes());
      case 'bool': {
        const [lo, hi] = r.varint64();
        return lo !== 0 || hi !== 0;
      }
      case 'double':
        return r.float(8);
      case 'float':
        return r.float(4);
      case 'fixed32':
        return r.fixed32();
      case 'sfixed32':
        return r.fixed32() | 0;
      case 'fixed64':
      case 'sfixed64': {
        const lo = r.fixed32();
        const hi = r.fixed32();
        return join64(lo, hi, kind === 'sfixed64');
      }
      case 'sint32':
      case 'sint64': {
        const [lo, hi] = r.varint64();
        const n = join64(lo, hi, false);
        return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
      }
      case 'int32':
      case 'enum':
        return r.varint64()[0] | 0;
      case 'uint32':
        return r.varint64()[0];
      case 'int64': {
        const [lo, hi] = r.varint64();
        return join64(lo, hi, true);
      }
      case 'uint64': {
        const [lo, hi] = r.varint64();
        return join64(lo, hi, false);
      }
    }
  }
}

export class ProtoRoot {
  private readonly types: Map<string, TypeDef>;

  constructor(source: string) {
    const known = new Parser(tokenize(WELL_KNOWN));
    known.parse();
    const p = new Parser(tokenize(source));
    p.parse();
    this.types = new Map([...known.types, ...p.types]);
  }

  /** Resolves a type name as protoc does: innermost scope outwards, then fully qualified. */
  resolve(name: string, scope: string): TypeDef {
    if (name.startsWith('.')) {
      const t = this.types.get(name.slice(1));
      if (t) return t;
    } else {
      const parts = scope ? scope.split('.') : [];
      for (let i = parts.length; i >= 0; i--) {
        const t = this.types.get([...parts.slice(0, i), name].join('.'));
        if (t) return t;
      }
      const wk = this.types.get(`google.protobuf.${name}`);
      if (wk && !name.includes('.')) return wk;
    }
    throw new ProtoError(`Unknown proto type "${name}"`);
  }

  /** A message type by name (short or fully qualified), like protobufjs Root.lookupType. */
  lookupType(name: string): ProtoType {
    let t = this.types.get(name.replace(/^\./, ''));
    if (!t) {
      for (const [full, def] of this.types) {
        if (full === name || full.endsWith(`.${name}`)) {
          t = def;
          break;
        }
      }
    }
    if (!t || t.kind !== 'message') throw new ProtoError(`No message type "${name}" in proto`);
    return new ProtoType(this, t);
  }
}

/** A gRPC-web length-prefixed data frame around one message. */
export function grpcFrame(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + message.length);
  const n = message.length;
  out[1] = (n >>> 24) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 8) & 0xff;
  out[4] = n & 0xff;
  out.set(message, 5);
  return out;
}

/** The first data frame's message and the trailers (grpc-status, grpc-message) of a gRPC-web body. */
export function grpcUnframe(body: Uint8Array): { message?: Uint8Array; trailers: Record<string, string> } {
  const trailers: Record<string, string> = {};
  let message: Uint8Array | undefined;
  let p = 0;
  while (p + 5 <= body.length) {
    const flag = body[p] as number;
    const len = (((body[p + 1] as number) << 24) | ((body[p + 2] as number) << 16) | ((body[p + 3] as number) << 8) | (body[p + 4] as number)) >>> 0;
    const data = body.subarray(p + 5, Math.min(body.length, p + 5 + len));
    p += 5 + len;
    if (flag & 0x80) {
      for (const line of utf8Decode(data, false, true).split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) trailers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
    } else if (!message) message = data;
  }
  return message ? { message, trailers } : { trailers };
}
