/**
 * The scope plugin code runs in.
 *
 * Plugin code is evaluated as `with (scope) { (function (require, module, exports) { …code… }) }`,
 * where `scope` is a Proxy that claims every identifier. Free names in plugin code therefore resolve
 * here instead of on the real global object:
 *   - injected values (URL, fetch, console, timers, …),
 *   - blocked names → undefined (Scriptable APIs, `self`, `window`, `global`),
 *   - `globalThis` → the scope itself (so `globalThis.FileManager` is undefined too),
 *   - `eval` → a literal-only evaluator (JSON and JS array/object/string literals; one published plugin
 *     evals an array literal scraped from the site, which must never run site code),
 *   - ECMAScript built-ins (Object, Promise, JSON, …) → the real ones,
 *   - anything else → undefined (instead of a ReferenceError),
 *   - assignments to undeclared names (sloppy-mode implicit globals) → kept in this plugin's scope,
 *     never on the real global object and never visible to other plugins.
 *
 * WHAT THIS IS NOT: a security boundary. Plugins run in the host's realm, so the Function constructor
 * is always reachable (`(function () {}).constructor('return this')()`, `require.constructor(…)`,
 * async/generator function constructors), and so is the real global through `this` inside a sloppy-mode
 * function called without a receiver. Neither can be closed within one realm. What protects the user is
 * the native install confirmation on the script side and only installing plugins from trusted repos;
 * this scope only stops accidental or casual access (bare names, `globalThis.X`, leaked implicit globals).
 */

/** ECMAScript built-ins plugins may use (looked up on the real global object). */
const SAFE_GLOBALS = new Set([
  'Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Promise',
  'Proxy', 'Reflect', 'JSON', 'Math', 'Intl', 'Atomics', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
  'FinalizationRegistry', 'Iterator', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array',
  'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Error', 'AggregateError', 'EvalError', 'RangeError',
  'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'escape', 'unescape', 'NaN', 'Infinity',
  'undefined',
]);

/** Parameter name of the scope object in the loader's wrapper function. */
export const SCOPE_PARAM = '__tachinovelScope';

/** Names the scope must not claim: the wrapper's own parameters. */
const PASS_THROUGH = new Set(['require', 'module', 'exports', SCOPE_PARAM]);

/** Global-object aliases that must not lead anywhere. */
export const GLOBAL_ALIASES: readonly string[] = ['self', 'window', 'global'];

/**
 * Creates a plugin's scope. `values` are injected names; `blocked` resolve to undefined.
 * Each plugin gets its own scope (implicit globals stay per plugin).
 */
export function createPluginScope(values: Record<string, unknown>, blocked: readonly string[]): object {
  const bag = Object.create(null) as Record<string, unknown>;
  for (const name of blocked) bag[name] = undefined;
  for (const name of GLOBAL_ALIASES) bag[name] = undefined;
  for (const [name, value] of Object.entries(values)) bag[name] = value;
  bag.eval = literalEval;
  const realGlobal = globalThis as unknown as Record<string, unknown>;
  const scope: object = new Proxy(bag, {
    has(_target, key) {
      return typeof key === 'string' && !PASS_THROUGH.has(key);
    },
    get(target, key) {
      if (typeof key !== 'string') return undefined; // incl. Symbol.unscopables
      if (key in target) return target[key];
      if (key === 'globalThis') return scope;
      if (SAFE_GLOBALS.has(key)) {
        const value = realGlobal[key];
        target[key] = value;
        return value;
      }
      return undefined;
    },
    set(target, key, value) {
      if (typeof key === 'string') target[key] = value;
      return true;
    },
    deleteProperty(target, key) {
      if (typeof key === 'string') delete target[key];
      return true;
    },
  });
  return scope;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };

/** JS literal (arrays/objects/strings/numbers/true/false/null, single quotes, bare keys, trailing commas) → JSON text, or null. */
function jsLiteralToJson(s: string): string | null {
  let out = '';
  let i = 0;
  const nextNonSpace = (from: number): string => {
    let j = from;
    while (j < s.length && /\s/.test(s.charAt(j))) j++;
    return s.charAt(j);
  };
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      while (j < s.length && s.charAt(j) !== c) {
        if (s.charAt(j) === '\\') {
          const n = s.charAt(j + 1);
          if (n === '') return null;
          if (n === 'u' || n === 'x') {
            const len = n === 'u' ? 4 : 2;
            const hex = s.slice(j + 2, j + 2 + len);
            if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return null;
            value += String.fromCharCode(parseInt(hex, 16));
            j += 2 + len;
            continue;
          }
          value += ESCAPES[n] ?? n;
          j += 2;
          continue;
        }
        value += s.charAt(j);
        j++;
      }
      if (j >= s.length) return null;
      out += JSON.stringify(value);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < s.length && /[\w$]/.test(s.charAt(j))) j++;
      const word = s.slice(i, j);
      if (nextNonSpace(j) === ':') out += JSON.stringify(word);
      else if (word === 'true' || word === 'false' || word === 'null') out += word;
      else return null;
      i = j;
      continue;
    }
    if (c === ',') {
      const n = nextNonSpace(i + 1);
      if (n !== ']' && n !== '}') out += ',';
      i++;
      continue;
    }
    if ('[]{}:-+.0123456789eE \t\n\r'.includes(c)) {
      out += c;
      i++;
      continue;
    }
    return null;
  }
  return out;
}

/**
 * The `eval` plugins see: evaluates JSON or a JS literal and nothing else (never code).
 * Non-strings are returned unchanged, as eval does.
 */
export function literalEval(source: unknown): unknown {
  if (typeof source !== 'string') return source;
  const text = source.trim().replace(/;+$/, '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // not JSON; try the JS literal subset
  }
  const json = jsLiteralToJson(text);
  if (json !== null) {
    try {
      return JSON.parse(json) as unknown;
    } catch {
      // fall through
    }
  }
  throw new EvalError('eval is not available to plugins (only JSON or JS literals are evaluated)');
}
