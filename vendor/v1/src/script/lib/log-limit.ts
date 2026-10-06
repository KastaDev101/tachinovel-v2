/**
 * Keeps the log readable: the same kind of info/warn line (same text once URLs, numbers and quoted bits
 * are blanked) is written at most `maxPerWindow` times per `windowMs`; the rest are counted, and the
 * count is written once the window ends (with the next such line) or at session end (`flush`).
 * Errors and debug lines always pass (errors matter; debug lines aren't persisted on the phone).
 */
import type { LogLevel } from '../../shared/contracts/platform.ts';

export type LogFn = (level: LogLevel, message: string, data?: unknown) => void;

export interface LogLimitOptions {
  now(): number;
  /** Lines of one kind per window. Default 5. */
  maxPerWindow?: number;
  /** Default 10 minutes. */
  windowMs?: number;
  /** Kinds tracked at once (oldest dropped). Default 300. */
  maxKinds?: number;
}

export interface LogLimiter {
  log: LogFn;
  /** Write the counts of lines suppressed so far (session end). */
  flush(): void;
  /** Lines suppressed so far this session (diagnostics/tests). */
  readonly suppressed: number;
}

interface Kind {
  level: LogLevel;
  sample: string;
  start: number;
  count: number;
  dropped: number;
}

/** "net: GET https://x/y/12 failed (attempt 2/3)" and "... /13 ... (attempt 1/3)" are one kind. */
export function logKind(level: LogLevel, message: string): string {
  return `${level} ${message
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/"[^"]*"|'[^']*'/g, '<q>')
    .replace(/\d+/g, '#')
    .slice(0, 100)}`;
}

export function createLogLimiter(log: LogFn, opts: LogLimitOptions): LogLimiter {
  const max = opts.maxPerWindow ?? 5;
  const windowMs = opts.windowMs ?? 10 * 60 * 1000;
  const maxKinds = opts.maxKinds ?? 300;
  const kinds = new Map<string, Kind>();
  let suppressed = 0;

  const report = (k: Kind): void => {
    if (k.dropped === 0) return;
    const sample = k.sample.length > 120 ? `${k.sample.slice(0, 119)}…` : k.sample;
    log(k.level, `(${k.dropped} more like this suppressed: ${sample})`);
    k.dropped = 0;
  };

  const limited: LogFn = (level, message, data) => {
    if (level === 'error' || level === 'debug') {
      log(level, message, data);
      return;
    }
    const key = logKind(level, message);
    const now = opts.now();
    let k = kinds.get(key);
    if (k && now - k.start >= windowMs) {
      report(k);
      k.start = now;
      k.count = 0;
    }
    if (!k) {
      while (kinds.size >= maxKinds) {
        const oldest = kinds.keys().next().value;
        if (oldest === undefined) break;
        const o = kinds.get(oldest);
        if (o) report(o);
        kinds.delete(oldest);
      }
      k = { level, sample: message, start: now, count: 0, dropped: 0 };
      kinds.set(key, k);
    }
    k.count++;
    if (k.count <= max) {
      log(level, message, data);
      return;
    }
    k.dropped++;
    k.sample = message;
    suppressed++;
  };

  return {
    log: limited,
    flush() {
      for (const k of kinds.values()) report(k);
    },
    get suppressed() {
      return suppressed;
    },
  };
}
