/** A `console` for plugins that forwards to the host's log function, tagged with the plugin id. */
import type { LogLevel } from '../../shared/contracts/platform.ts';

export interface ConsoleLike {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  dir(...args: unknown[]): void;
}

const MAX = 2000;

export function formatArgs(args: unknown[]): string {
  const parts = args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (typeof a === 'object' && a !== null) {
      try {
        return JSON.stringify(a);
      } catch {
        return Object.prototype.toString.call(a);
      }
    }
    return String(a);
  });
  const s = parts.join(' ');
  return s.length > MAX ? s.slice(0, MAX) + '…' : s;
}

export function createConsole(log: (level: LogLevel, message: string) => void, tag: () => string): ConsoleLike {
  const at =
    (level: LogLevel) =>
    (...args: unknown[]): void => {
      log(level, `[${tag()}] ${formatArgs(args)}`);
    };
  return {
    log: at('debug'),
    debug: at('debug'),
    trace: at('debug'),
    dir: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
}
