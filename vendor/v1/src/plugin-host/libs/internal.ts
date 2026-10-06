/**
 * Helpers for the @libs/* shim modules.
 *
 * Modules that need per-plugin state (fetch, storage) export a `create…Lib(ctx)` factory used by the
 * host's require(), plus typed top-level exports so our own TypeScript plugins can
 * `import { fetchApi } from '@libs/fetch'`. Those top-level exports are placeholders: plugins are
 * built with @libs/* left as require() calls, and the host hands each plugin its own instances.
 */

/** A placeholder export that explains itself if it is ever called outside the plugin host. */
export function hostProvided<F extends (...args: never[]) => unknown>(module: string, name: string): F {
  const fn = (): never => {
    throw new Error(`${module}.${name} is provided by the TachiNovel plugin host at runtime (via require); it cannot be called directly.`);
  };
  return fn as unknown as F;
}
