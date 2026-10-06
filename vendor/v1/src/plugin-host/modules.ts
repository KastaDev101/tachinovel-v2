/**
 * The require() map plugins see. Mirrors the `packages` map of the LNReader app
 * (src/plugins/pluginManager.ts) plus aliases for the newer `@/…` paths, scoped by the plugin survey
 * (docs/plugin-survey.md). Modules with per-plugin state (@libs/fetch, @libs/storage) are created
 * per plugin; everything else is shared.
 */
// Must precede cheerio (see polyfills/ensure-atob.ts).
import './polyfills/ensure-atob.ts';
import * as cheerio from 'cheerio/slim';
import dayjs from 'dayjs';
import calendar from 'dayjs/plugin/calendar.js';
import localizedFormat from 'dayjs/plugin/localizedFormat.js';
import * as htmlparser2 from 'htmlparser2';
import type { PluginContext } from './context.ts';
import { gcm } from './libs/aes.ts';
import { defaultCover } from './libs/defaultCover.ts';
import { createFetchLib } from './libs/fetch.ts';
import { FilterTypes } from './libs/filterInputs.ts';
import { isUrlAbsolute } from './libs/isAbsoluteUrl.ts';
import { NovelStatus } from './libs/novelStatus.ts';
import { createStorageLib } from './libs/storage.ts';
import { bytesToUtf8, utf8ToBytes } from './libs/utils.ts';

/** `urlencode` (UTF-8 only; LNReader's also does GBK via iconv, which no surveyed plugin uses). */
const urlencode = {
  encode(str: string, charset?: string): string {
    if (charset && !/^utf-?8$/i.test(charset)) throw new Error(`urlencode: charset ${charset} is not supported`);
    return encodeURIComponent(str);
  },
  decode(str: string, charset?: string): string {
    if (charset && !/^utf-?8$/i.test(charset)) throw new Error(`urlencode: charset ${charset} is not supported`);
    try {
      return decodeURIComponent(str);
    } catch {
      return str;
    }
  },
};

/**
 * cheerio/slim made to behave like full cheerio (parse5), which the LNReader app ships and plugins are
 * written against, in the two ways that matter to plugins (outside XML mode):
 *   - serialization: `.html()` emits UTF-8 and escapes only markup-significant characters. Slim's
 *     default would re-encode every non-ASCII character as `&#x…;` (bloating chapters, and breaking
 *     plugins that regex the HTML for literal characters);
 *   - implied `<tbody>`: browsers and parse5 put `<tr>`s written directly inside `<table>` into a
 *     `<tbody>`, so plugins select `table > tbody > tr`; htmlparser2 doesn't.
 */
type CheerioOptions = NonNullable<Parameters<typeof cheerio.load>[1]>;
type CheerioAPI = ReturnType<typeof cheerio.load>;

/** Wraps rows that sit directly in a `<table>` into a `<tbody>`, as the HTML parser would. */
export function insertImpliedTbody($: CheerioAPI): void {
  $('table').each((_, table) => {
    // As in parse5: from the first direct <tr>, rows and the text between them (and after them) go
    // into the implied <tbody>, up to the next table section element.
    const nodes = $(table).contents().toArray();
    const tagName = (n: (typeof nodes)[number]): string | undefined => {
      const name = (n as { name?: unknown }).name;
      return typeof name === 'string' ? name : undefined; // elements only (text/comments have none)
    };
    const start = nodes.findIndex((n) => tagName(n) === 'tr');
    if (start < 0) return;
    const run = [];
    for (const n of nodes.slice(start)) {
      const name = tagName(n);
      if (name !== undefined && name !== 'tr') break;
      run.push(n);
    }
    $(run).wrapAll('<tbody></tbody>');
  });
}

function cheerioLoad(content: unknown, options?: CheerioOptions | null, isDocument?: boolean): CheerioAPI {
  const xml = Boolean(options && (options.xml || (options as { xmlMode?: unknown }).xmlMode));
  const opts = xml ? options : { encodeEntities: 'utf8' as const, ...(options ?? {}) };
  // content: markup string or DOM node(s), passed through as cheerio accepts them. The assertion is
  // only needed where @types/node resolves cheerio's `Buffer` parameter type (Node typecheck).
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const $ = cheerio.load(content as string, opts, isDocument);
  // Cheap string pre-check: only markup with table rows needs the DOM pass.
  if (!xml && typeof content === 'string' && /<tr[\s>]/i.test(content)) insertImpliedTbody($);
  return $;
}

// The LNReader app extends its (shared) dayjs with these, and plugins rely on it: 330+ call sites
// format dates with 'LL'/'LLL', which plain dayjs prints literally ("LL").
dayjs.extend(localizedFormat);
dayjs.extend(calendar);

type ModuleFactory = (ctx: PluginContext) => unknown;

/**
 * Modules without per-plugin state are one object shared by every plugin, so they are frozen: one
 * plugin cannot change what another sees (e.g. replace `cheerio.load`). Per-plugin modules are frozen
 * too, for symmetry. dayjs is frozen as well; its global setters (`dayjs.locale(x)`, `extend`) are not
 * used by any surveyed plugin.
 */
const shared = (value: object): ModuleFactory => {
  Object.freeze(value);
  return () => value;
};

const NOVEL_STATUS = Object.freeze({ ...NovelStatus });
const FILTER_TYPES = Object.freeze({ ...FilterTypes });

const MODULES: Record<string, ModuleFactory> = {
  htmlparser2: shared({ ...htmlparser2 }),
  cheerio: shared({ ...cheerio, load: cheerioLoad }),
  dayjs: shared(dayjs),
  urlencode: shared(urlencode),
  '@libs/fetch': (ctx) => Object.freeze(createFetchLib(ctx)),
  '@libs/storage': (ctx) => Object.freeze(createStorageLib(ctx)),
  '@libs/novelStatus': shared({ NovelStatus: NOVEL_STATUS }),
  '@libs/filterInputs': shared({ FilterTypes: FILTER_TYPES }),
  '@libs/defaultCover': shared({ defaultCover }),
  '@libs/isAbsoluteUrl': shared({ isUrlAbsolute }),
  '@libs/aes': shared({ gcm }),
  '@libs/utils': shared({ utf8ToBytes, bytesToUtf8 }),
  // lnreader-plugins master moved the libs; compiled plugins may reference the new paths.
  '@/types/constants': shared({ NovelStatus: NOVEL_STATUS, defaultCover }),
  '@/types/filters': shared({ FilterTypes: FILTER_TYPES }),
  '@/lib/utils': shared({ isUrlAbsolute }),
  '@/lib/aes': shared({ gcm }),
};
const ALIASES: Record<string, string> = {
  '@/lib/fetch': '@libs/fetch',
  '@/lib/storage': '@libs/storage',
};

export const PROVIDED_MODULES: readonly string[] = Object.freeze([...Object.keys(MODULES), ...Object.keys(ALIASES)]);

export class UnknownModuleError extends Error {
  constructor(name: string) {
    super(`Plugin requires "${name}", which TachiNovel does not provide (available: ${PROVIDED_MODULES.join(', ')})`);
    this.name = 'UnknownModuleError';
  }
}

/** A require() bound to one plugin. Each module is instantiated once per plugin. */
export function createRequire(ctx: PluginContext): (name: string) => unknown {
  const cache = new Map<string, unknown>();
  return function require(name: string): unknown {
    const key = ALIASES[name] ?? name;
    if (cache.has(key)) return cache.get(key);
    const factory = Object.prototype.hasOwnProperty.call(MODULES, key) ? MODULES[key] : undefined;
    if (!factory) throw new UnknownModuleError(String(name));
    const mod = factory(ctx);
    cache.set(key, mod);
    return mod;
  };
}
