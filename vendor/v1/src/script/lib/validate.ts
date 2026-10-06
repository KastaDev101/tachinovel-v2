/**
 * Tiny argument validators for bridge handlers. The UI is semi-trusted (it renders third-party HTML),
 * so every handler validates its args and throws INVALID_ARGS instead of failing deeper down.
 */
import { invalidArgs } from './errors.ts';

export type Obj = Record<string, unknown>;

const MAX_STRING = 8192;

export function isRecord(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function obj(v: unknown, what = 'args'): Obj {
  if (!isRecord(v)) throw invalidArgs(`${what} must be an object`);
  return v;
}

export function optObj(o: Obj, k: string): Obj | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (!isRecord(v)) throw invalidArgs(`${k} must be an object`);
  return v;
}

export function str(o: Obj, k: string, opts: { max?: number; allowEmpty?: boolean } = {}): string {
  const v = o[k];
  if (typeof v !== 'string') throw invalidArgs(`${k} must be a string`);
  if (!opts.allowEmpty && v.length === 0) throw invalidArgs(`${k} must not be empty`);
  if (v.length > (opts.max ?? MAX_STRING)) throw invalidArgs(`${k} is too long`);
  return v;
}

export function optStr(o: Obj, k: string, opts: { max?: number; allowEmpty?: boolean } = {}): string | undefined {
  if (o[k] === undefined || o[k] === null) return undefined;
  return str(o, k, opts);
}

export function num(o: Obj, k: string, opts: { min?: number; max?: number; int?: boolean } = {}): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalidArgs(`${k} must be a finite number`);
  if (opts.int && !Number.isInteger(v)) throw invalidArgs(`${k} must be an integer`);
  if (opts.min !== undefined && v < opts.min) throw invalidArgs(`${k} must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw invalidArgs(`${k} must be <= ${opts.max}`);
  return v;
}

export function optNum(o: Obj, k: string, opts: { min?: number; max?: number; int?: boolean } = {}): number | undefined {
  if (o[k] === undefined || o[k] === null) return undefined;
  return num(o, k, opts);
}

export function bool(o: Obj, k: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') throw invalidArgs(`${k} must be a boolean`);
  return v;
}

export function optBool(o: Obj, k: string): boolean | undefined {
  if (o[k] === undefined || o[k] === null) return undefined;
  return bool(o, k);
}

export function strArray(o: Obj, k: string, opts: { max?: number; maxLen?: number } = {}): string[] {
  const v = o[k];
  if (!Array.isArray(v)) throw invalidArgs(`${k} must be an array`);
  if (opts.max !== undefined && v.length > opts.max) throw invalidArgs(`${k} has too many items`);
  const maxLen = opts.maxLen ?? MAX_STRING;
  for (const item of v) {
    if (typeof item !== 'string' || item.length === 0 || item.length > maxLen) throw invalidArgs(`${k} must contain non-empty strings`);
  }
  return v as string[];
}

export function optStrArray(o: Obj, k: string, opts: { max?: number; maxLen?: number } = {}): string[] | undefined {
  if (o[k] === undefined || o[k] === null) return undefined;
  return strArray(o, k, opts);
}

export function oneOf<T extends string>(o: Obj, k: string, values: readonly T[]): T {
  const v = o[k];
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw invalidArgs(`${k} must be one of ${values.join(', ')}`);
  }
  return v as T;
}

/** http(s) URLs only (no javascript:, file:, app schemes). */
export function httpUrl(o: Obj, k: string): string {
  const v = str(o, k, { max: 4096 });
  if (!isHttpUrl(v)) throw invalidArgs(`${k} must be an http(s) URL`);
  return v;
}

export function isHttpUrl(v: string): boolean {
  return /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(v);
}
