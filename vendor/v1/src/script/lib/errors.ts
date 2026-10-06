/**
 * Script-side errors and their mapping to bridge errors.
 *
 * Errors thrown by the plugin host come from a separately bundled module (loaded with importModule),
 * so `instanceof SourceError` would fail across bundles. Everything here is duck-typed on `code`/`name`.
 */
import type { BridgeError, ErrorCode } from '../../shared/contracts/protocol.ts';

const CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'NETWORK',
  'TIMEOUT',
  'CLOUDFLARE',
  'NOT_FOUND',
  'LOCKED',
  'PLUGIN',
  'STORAGE',
  'INVALID_ARGS',
  'UNKNOWN_METHOD',
  'UNKNOWN',
]);

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['NETWORK', 'TIMEOUT', 'CLOUDFLARE', 'STORAGE']);

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

/** An error with a bridge error code. Thrown by services; mapped 1:1 by toBridgeError. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  constructor(code: ErrorCode, message: string, retryable: boolean = RETRYABLE.has(code)) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function invalidArgs(message: string): AppError {
  return new AppError('INVALID_ARGS', message);
}

export function notFound(message: string): AppError {
  return new AppError('NOT_FOUND', message);
}

/** Never throws, whatever was thrown (null, symbols, objects with throwing getters, proxies). */
export function errorMessage(err: unknown): string {
  try {
    if (err instanceof Error) return String(err.message || err.name);
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const m = (err as { message?: unknown }).message;
      if (typeof m === 'string') return m;
      return JSON.stringify(err) ?? 'Unknown error';
    }
    return String(err);
  } catch {
    return 'Unknown error';
  }
}

export function storageError(op: string, path: string, err: unknown): AppError {
  return new AppError('STORAGE', `Storage ${op} failed for ${path}: ${errorMessage(err)}`);
}

export function errorCode(err: unknown): ErrorCode | undefined {
  try {
    if (err && typeof err === 'object') {
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string' && CODES.has(code)) return code as ErrorCode;
      const name = (err as { name?: unknown }).name;
      if (name === 'PluginLoadError') return 'PLUGIN';
    }
  } catch {
    // Hostile error object: no code.
  }
  return undefined;
}

/** Map anything thrown by a handler to the wire error. */
export function toBridgeError(err: unknown): BridgeError {
  const message = errorMessage(err);
  const code = errorCode(err);
  if (code) {
    let r: unknown;
    try {
      r = (err as { retryable?: unknown }).retryable;
    } catch {
      r = undefined;
    }
    return { code, message, retryable: typeof r === 'boolean' ? r : RETRYABLE.has(code) };
  }
  return { code: 'UNKNOWN', message, retryable: false };
}
