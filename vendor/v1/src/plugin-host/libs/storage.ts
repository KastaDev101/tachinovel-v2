/**
 * @libs/storage shim — LNReader's synchronous per-plugin storage (API mirrors
 * LNReader/lnreader `src/plugins/helpers/storage.ts`, MIT) over the host's PluginKV.
 *
 * Items are stored as `{ created, value, expires? }`; values go through a JSON round trip like
 * LNReader's MMKV store, so plugins see the same semantics on every platform.
 * localStorage/sessionStorage expose what LNReader captures from its WebView; TachiNovel has no such
 * capture, so they return whatever the host stored under `_LocalStorage` / `_SessionStorage` (usually
 * nothing).
 */
import type { PluginContext } from '../context.ts';
import { hostProvided } from './internal.ts';

export interface StorageItem<T = unknown> {
  created: Date;
  value: T;
  expires?: number;
}

interface StoredItem {
  created: number;
  value?: unknown;
  expires?: number;
}

const LOCAL_STORAGE_KEY = '_LocalStorage';
const SESSION_STORAGE_KEY = '_SessionStorage';
const RESERVED = new Set([LOCAL_STORAGE_KEY, SESSION_STORAGE_KEY]);

function isStored(v: unknown): v is StoredItem {
  return typeof v === 'object' && v !== null && typeof (v as StoredItem).created === 'number';
}

export class PluginStorage {
  readonly #ctx: PluginContext;

  constructor(ctx: PluginContext) {
    this.#ctx = ctx;
  }

  set(key: string, value: unknown, expires?: Date | number): void {
    const exp = expires instanceof Date ? expires.getTime() : typeof expires === 'number' ? expires : undefined;
    const item: StoredItem = { created: this.#ctx.deps.now() };
    if (value !== undefined) item.value = JSON.parse(JSON.stringify(value)) as unknown;
    if (exp !== undefined) item.expires = exp;
    this.#ctx.kv().set(String(key), item, exp);
  }

  get<T = unknown>(key: string, raw: true): StorageItem<T> | undefined;
  get<T = unknown>(key: string, raw?: false): T | undefined;
  get<T = unknown>(key: string, raw?: boolean): T | StorageItem<T> | undefined {
    const stored = this.#ctx.kv().get(String(key));
    if (!isStored(stored)) return undefined;
    if (stored.expires && this.#ctx.deps.now() > stored.expires) {
      this.delete(key);
      return undefined;
    }
    if (raw) {
      const item: StorageItem<T> = { created: new Date(stored.created), value: stored.value as T };
      if (stored.expires !== undefined) item.expires = stored.expires;
      return item;
    }
    return stored.value as T;
  }

  delete(key: string): void {
    this.#ctx.kv().delete(String(key));
  }

  clearAll(): void {
    for (const k of this.getAllKeys()) this.delete(k);
  }

  getAllKeys(): string[] {
    return this.#ctx
      .kv()
      .getAllKeys()
      .filter((k) => !RESERVED.has(k));
  }
}

export class WebStorageView {
  readonly #ctx: PluginContext;
  readonly #key: string;

  constructor(ctx: PluginContext, key: string) {
    this.#ctx = ctx;
    this.#key = key;
  }

  get(): Record<string, string> | undefined {
    const v = this.#ctx.kv().get(this.#key);
    return typeof v === 'object' && v !== null ? (v as Record<string, string>) : undefined;
  }
}

export function createStorageLib(ctx: PluginContext) {
  return {
    storage: new PluginStorage(ctx),
    localStorage: new WebStorageView(ctx, LOCAL_STORAGE_KEY),
    sessionStorage: new WebStorageView(ctx, SESSION_STORAGE_KEY),
  };
}

export type StorageLib = ReturnType<typeof createStorageLib>;

const placeholder = {
  set: hostProvided<PluginStorage['set']>('@libs/storage', 'storage.set'),
  get: hostProvided<(key: string, raw?: boolean) => unknown>('@libs/storage', 'storage.get'),
  delete: hostProvided<PluginStorage['delete']>('@libs/storage', 'storage.delete'),
  clearAll: hostProvided<PluginStorage['clearAll']>('@libs/storage', 'storage.clearAll'),
  getAllKeys: hostProvided<PluginStorage['getAllKeys']>('@libs/storage', 'storage.getAllKeys'),
};

/** Typed placeholders (see libs/internal.ts); the host provides per-plugin instances. */
export const storage = placeholder as unknown as PluginStorage;
export const localStorage = { get: hostProvided<WebStorageView['get']>('@libs/storage', 'localStorage.get') } as unknown as WebStorageView;
export const sessionStorage = { get: hostProvided<WebStorageView['get']>('@libs/storage', 'sessionStorage.get') } as unknown as WebStorageView;
