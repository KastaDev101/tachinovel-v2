/**
 * Script-side errors and their mapping to bridge errors.
 *
 * Errors thrown by the plugin host come from a separately bundled module (loaded with importModule),
 * so `instanceof SourceError` would fail across bundles. Everything here is duck-typed on `code`/`name`.
 */
import type { SourceFailureReason } from '../../shared/contracts/domain.ts';
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
  return new AppError('STORAGE', `Couldn't ${op === 'write' ? 'save' : op} ${path} on this iPhone: ${errorMessage(err)}`);
}

export function errorCode(err: unknown): ErrorCode | undefined {
  try {
    if (err && typeof err === 'object') {
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string' && CODES.has(code)) return code as ErrorCode;
      const name = (err as { name?: unknown }).name;
      if (name === 'PluginLoadError') return 'PLUGIN';
      if (name === 'SettingsError') return 'INVALID_ARGS'; // plugin settings rejected by the plugin host
    }
  } catch {
    // Hostile error object: no code.
  }
  return undefined;
}

/** Map anything thrown by a handler to the wire error. */
const REASONS: ReadonlySet<string> = new Set<SourceFailureReason>([
  'offline',
  'site-gone',
  'parked',
  'tls',
  'unreachable',
  'site-down',
  'rate-limited',
  'bot-check',
  'blocked',
  'not-found',
  'layout-changed',
  'needs-account',
  'unsupported',
]);

/** A source failure's reason (SourceError.reason, set by the plugin host), if it is a known one. */
export function errorReason(err: unknown): SourceFailureReason | undefined {
  try {
    const reason = err && typeof err === 'object' ? (err as { reason?: unknown }).reason : undefined;
    return typeof reason === 'string' && REASONS.has(reason) ? (reason as SourceFailureReason) : undefined;
  } catch {
    return undefined;
  }
}

/** Longest message shown to the user (the full text is in the log). */
export const MAX_USER_MESSAGE = 300;

/** JavaScript engine errors (a plugin or the app hit a bug): never shown as-is. */
const ENGINE_ERROR_RE =
  /\b(?:undefined|null) is not an object\b|is not a function\b|Cannot read propert|Can't find variable|is not defined\b|Maximum call stack|evaluating '|\b(?:TypeError|ReferenceError|RangeError|InternalError):/;
/** A response that wasn't the JSON the code expected (an error page, a changed site). */
const PARSE_ERROR_RE = /JSON Parse error|Unexpected token|Unexpected end of JSON|in JSON at position|SyntaxError:/;

const ENGINE_MESSAGE: Partial<Record<ErrorCode, string>> = {
  PLUGIN: 'The source ran into an error reading this page. It may need an update.',
  NETWORK: 'The site sent something the source couldn\'t read. Try again later.',
  UNKNOWN: 'Something went wrong. Please try again.',
};

/**
 * What the user sees for an error: plain English, one line, at most MAX_USER_MESSAGE characters.
 * Messages written for people pass through unchanged; JavaScript engine errors, unreadable responses,
 * HTML and stack traces are replaced or cut (the original stays in the log).
 */
export function plainMessage(code: ErrorCode, raw: string): string {
  let m = raw.replace(/\n\s*at .*$/s, '').replace(/<[^>]{1,200}>/g, ' ');
  if (PARSE_ERROR_RE.test(m)) return code === 'PLUGIN' ? ENGINE_MESSAGE.PLUGIN as string : 'The site sent something unreadable. It may be down or may have changed.';
  if (ENGINE_ERROR_RE.test(m)) return ENGINE_MESSAGE[code] ?? (ENGINE_MESSAGE.UNKNOWN as string);
  m = m.replace(/\s+/g, ' ').trim();
  if (!m) return code === 'UNKNOWN' ? (ENGINE_MESSAGE.UNKNOWN as string) : 'Something went wrong.';
  return m.length > MAX_USER_MESSAGE ? `${m.slice(0, MAX_USER_MESSAGE - 1)}…` : m;
}

/** Map anything thrown by a handler to the wire error (code, retryable and, for source failures, reason). */
export function toBridgeError(err: unknown): BridgeError {
  const code = errorCode(err);
  const message = plainMessage(code ?? 'UNKNOWN', errorMessage(err));
  if (code) {
    let r: unknown;
    try {
      r = (err as { retryable?: unknown }).retryable;
    } catch {
      r = undefined;
    }
    const out: BridgeError = { code, message, retryable: typeof r === 'boolean' ? r : RETRYABLE.has(code) };
    const reason = errorReason(err);
    if (reason) out.reason = reason;
    return out;
  }
  return { code: 'UNKNOWN', message, retryable: false };
}
