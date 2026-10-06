/**
 * core.js entry, evaluated by the native CoreHost in its own JavaScriptCore context (no DOM, no JIT,
 * no browser globals: the same environment v1's script ran in under Scriptable).
 *
 * 1. Take `__native` and delete the global, so plugin code evaluated later in this context cannot
 *    reach native capabilities (file system, HTTP) through globals.
 * 2. Boot the core (v1 services on the native platform).
 * 3. Register the request handler; the native side queues calls until then.
 */
import { errorMessage } from '@v1/script/lib/errors.ts';
import type { NativeHost } from './native-api.ts';
import { startCore } from './core.ts';

const BUILD = `${__BUILD_VERSION__}+${__BUILD_HASH__} (${__FLAVOR__})`;

function takeHost(): NativeHost {
  const g = globalThis as { __native?: NativeHost };
  const host = g.__native;
  if (!host) throw new Error('core.js: __native is missing (the native CoreHost must install it first)');
  delete g.__native;
  return host;
}

function ensureConsole(host: NativeHost): void {
  type ConsoleLike = Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...args: unknown[]) => void>;
  const g = globalThis as { console?: Partial<ConsoleLike> };
  if (g.console && typeof g.console.log === 'function') return;
  const line = (level: string) => (...args: unknown[]) => host.log(level, args.map((a) => (typeof a === 'string' ? a : safe(a))).join(' '));
  g.console = { log: line('info'), info: line('info'), warn: line('warn'), error: line('error'), debug: line('debug') };
}

function safe(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

const host = takeHost();
ensureConsole(host);

/** Why the core could not start (answered to every request instead of hanging). */
let bootError = '';

const ready = startCore(host, { build: BUILD }).then(
  (core) => {
    host.log('info', `core ${BUILD} ready (${host.info.launchReason})`);
    return core;
  },
  (err: unknown) => {
    bootError = errorMessage(err);
    host.log('error', `core boot failed: ${bootError}`);
    return null;
  },
);

host.register((requestJson, done) => {
  void ready.then(async (core) => {
    if (!core) {
      let id = 0;
      try {
        id = (JSON.parse(requestJson) as { id?: number }).id ?? 0;
      } catch {
        // malformed; answer with id 0
      }
      const message = `The app core failed to start: ${bootError || 'unknown error'}`;
      done(JSON.stringify({ kind: 'res', id, ok: false, error: { code: 'UNKNOWN', message, retryable: false } }));
      return;
    }
    done(await core.handle(requestJson));
  });
});
