/**
 * Evaluates LNReader plugin code (CommonJS) with:
 *   - our require() (modules.ts),
 *   - a per-plugin scope (sandbox.ts) that claims every free identifier: injected polyfills (URL,
 *     fetch, setTimeout, …), sensitive Scriptable globals and global-object aliases (`globalThis`,
 *     `self`, `window`, `global`) blocked, `eval` limited to literals, implicit globals kept per plugin.
 *     No global is touched.
 * The code runs inside an inner function so its own top-level `let/const/class` declarations can
 * reuse injected names without a redeclaration SyntaxError.
 *
 * This is defense in depth, not a sandbox: the Function constructor (and sloppy-mode `this`) still
 * reach the real global in the same realm (see sandbox.ts). What protects the user is the native
 * install confirmation on the script side and only installing plugins from trusted repos.
 */
import { PluginLoadError } from '../shared/contracts/plugin-host.ts';
import type { Plugin } from '../shared/lnreader/plugin.ts';
import type { PluginContext } from './context.ts';
import type { FetchInit, FetchLib } from './libs/fetch.ts';
import { createRequire } from './modules.ts';
import { createPluginScope, SCOPE_PARAM } from './sandbox.ts';
import { atob, btoa } from './polyfills/base64.ts';
import { createConsole } from './polyfills/console.ts';
import { FormData } from './polyfills/formdata.ts';
import { Headers } from './polyfills/headers.ts';
import { TextDecoder, TextEncoder } from './polyfills/text.ts';
import { createTimers } from './polyfills/timers.ts';
import { URL, URLSearchParams } from './polyfills/url.ts';

/** Scriptable (and a few generic) globals a plugin has no business touching. */
export const SHADOWED_GLOBALS: readonly string[] = [
  'FileManager',
  'Keychain',
  'Pasteboard',
  'Request',
  'WebView',
  'importModule',
  'Safari',
  'Photos',
  'Contact',
  'ContactsContainer',
  'ContactsGroup',
  'Calendar',
  'CalendarEvent',
  'Reminder',
  'Location',
  'Mail',
  'Message',
  'Notification',
  'Script',
  'Alert',
  'ShareSheet',
  'DocumentPicker',
  'QuickLook',
  'CallbackURL',
  'Dictation',
  'Speech',
  'Device',
  'args',
  'config',
];

/** Names injected with our implementations. */
export const INJECTED_GLOBALS: readonly string[] = [
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'atob',
  'btoa',
  'FormData',
  'Headers',
  'fetch',
  'console',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
];

// The polyfill classes are shared by every plugin (injected as parameters): freeze them so one plugin
// cannot patch what another sees (e.g. `URL.prototype.toString = …`).
for (const C of [URL, URLSearchParams, TextEncoder, TextDecoder, FormData, Headers]) {
  Object.freeze(C.prototype);
  Object.freeze(C);
}

export type LoadedPlugin = Plugin.PluginBase & Partial<Pick<Plugin.PagePlugin, 'parsePage'>> & Record<string, unknown>;

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name === 'Error' ? '' : err.name + ': '}${err.message}`;
  return String(err);
}

/** Runs plugin code and returns its export object (module.exports). */
export function evaluatePluginCode(code: string, ctx: PluginContext, sourceLabel: string): unknown {
  if (typeof code !== 'string' || code.trim() === '') throw new PluginLoadError(`${sourceLabel}: plugin code is empty`);
  const require = createRequire(ctx);
  const module: { exports: Record<string, unknown> } = { exports: {} };
  const fetchLib = require('@libs/fetch') as FetchLib;
  const timers = createTimers(
    (ms) => ctx.deps.sleep(ms),
    (err) => ctx.log('warn', `[${ctx.id}] timer callback threw: ${describe(err)}`),
  );
  const injected: Record<string, unknown> = {
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    FormData,
    Headers,
    fetch: (url: unknown, init?: FetchInit) => fetchLib.fetchApi(url as string, init),
    console: createConsole(
      (level, message) => ctx.log(level, message),
      () => ctx.id,
    ),
    ...timers,
  };
  const scope = createPluginScope(injected, SHADOWED_GLOBALS);
  // `with` (the wrapper is sloppy code) makes the scope win over the real global object for every free
  // name; plugin code keeps its own "use strict" directive, as the first statement of the inner function.
  const body = `with (${SCOPE_PARAM}) { return (function (require, module, exports) {\n${code}\n}).call(this, require, module, exports); }`;

  let fn: (...args: unknown[]) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- evaluating plugin code is this module's job
    fn = new Function(SCOPE_PARAM, 'require', 'module', 'exports', body) as (...args: unknown[]) => unknown;
  } catch (err) {
    throw new PluginLoadError(`${sourceLabel}: plugin code does not parse (${describe(err)})`);
  }
  try {
    fn.apply(module.exports, [scope, require, module, module.exports]);
  } catch (err) {
    throw new PluginLoadError(`${sourceLabel}: plugin code threw while loading (${describe(err)})`);
  }
  return module.exports;
}

const REQUIRED_METHODS = ['popularNovels', 'searchNovels', 'parseNovel', 'parseChapter'] as const;

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return (typeof v === 'object' || typeof v === 'function') && v !== null;
}

/** Picks the plugin object from the exports and validates its shape. */
export function resolvePlugin(exportsValue: unknown, sourceLabel: string, expectedId?: string): LoadedPlugin {
  const exp = isObjectLike(exportsValue) ? exportsValue : undefined;
  const candidates = [exp?.default, exp];
  const plugin = candidates.find((c) => isObjectLike(c) && ('id' in c || 'popularNovels' in c));
  if (!isObjectLike(plugin)) {
    throw new PluginLoadError(`${sourceLabel}: no plugin object exported (expected exports.default = { id, name, site, … })`);
  }
  const problems: string[] = [];
  for (const field of ['id', 'name', 'site', 'version'] as const) {
    const v = plugin[field];
    if (typeof v !== 'string' || v.trim() === '') problems.push(`"${field}" must be a non-empty string`);
  }
  if (plugin.icon !== undefined && typeof plugin.icon !== 'string') problems.push('"icon" must be a string');
  for (const m of REQUIRED_METHODS) if (typeof plugin[m] !== 'function') problems.push(`"${m}" must be a function`);
  for (const m of ['parsePage', 'resolveUrl'] as const) {
    if (plugin[m] !== undefined && typeof plugin[m] !== 'function') problems.push(`"${m}" must be a function when present`);
  }
  if (typeof plugin.id === 'string' && plugin.id.includes(':')) problems.push('"id" must not contain ":"');
  if (typeof plugin.site === 'string' && !/^https?:\/\/[^/]+/i.test(plugin.site)) problems.push('"site" must be an absolute http(s) URL');
  if (problems.length) {
    const id = typeof plugin.id === 'string' ? ` "${plugin.id}"` : '';
    throw new PluginLoadError(`${sourceLabel}: invalid plugin${id}: ${problems.join('; ')}`);
  }
  if (expectedId !== undefined && plugin.id !== expectedId) {
    throw new PluginLoadError(`${sourceLabel}: plugin id "${String(plugin.id)}" does not match the expected id "${expectedId}"`);
  }
  return plugin as LoadedPlugin;
}
