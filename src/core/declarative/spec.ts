/**
 * Declarative source definitions ("TachiNovel Source Spec v1", format "tachinovel-source/1").
 *
 * WHY: App Store guideline 2.5.2 forbids downloading code that changes app functionality. LNReader
 * plugins are JavaScript. A store build therefore accepts sources only as DATA: URL templates, CSS
 * selectors, JSON paths and small regexes, interpreted by a fixed engine compiled into the binary
 * (engine.ts). Nothing in a spec is evaluated as code. The same idea as Safari content-blocker JSON
 * rules or an RSS/OPDS feed definition. See docs/app-store-risk.md.
 *
 * A spec is a JSON document; repo indexes keep LNReader's index format ([{id,name,site,lang,version,
 * url,iconUrl}]) with `url` pointing at the .json spec, so v1's SourceService installs/updates it
 * unchanged.
 */

export const SPEC_FORMAT = 'tachinovel-source/1';

/**
 * How to read one value. HTML documents: `selector` (CSS, relative to the current item/document;
 * omitted = the item itself), then `attr` | `html` | text (default). JSON documents: `json` is a
 * dotted path ("data.items", "author.name", "tags[*].name"). Then optional `regex` (first capture
 * group, or whole match), `replace` pairs, `prefix`, and `map` (exact value → value, case-insensitive).
 */
export interface FieldSpec {
  selector?: string;
  attr?: string;
  html?: boolean;
  json?: string;
  /** Collect every match (genres/tags). */
  all?: boolean;
  regex?: string;
  replace?: [pattern: string, replacement: string][];
  prefix?: string;
  map?: Record<string, string>;
  /** Value if nothing matched. */
  default?: string;
  /** For boolean fields (locked): true when the selector/path matches anything (or the value is truthy). */
  exists?: boolean;
}

export type Field = string | FieldSpec;

export interface ListSpec {
  /** HTML: CSS selector of each item. JSON: dotted path of the items array. */
  item: string;
  name: Field;
  path: Field;
  cover?: Field;
}

export interface RequestSpec {
  /**
   * URL template, relative to `site` or absolute. Placeholders: {page}, {query} (URL-encoded),
   * {path} (novel/chapter path), {page0} (page - 1).
   */
  url: string;
  method?: 'GET' | 'POST';
  /** Form-encoded or JSON body template (same placeholders). */
  body?: string;
  headers?: Record<string, string>;
  /** Response type; default 'html'. */
  type?: 'html' | 'json';
}

export interface ChapterListSpec extends ListSpec {
  /** Separate request for the chapter list (default: parsed from the novel page). */
  request?: RequestSpec;
  releaseTime?: Field;
  number?: Field;
  locked?: Field;
  /** Source order of the list; 'desc' lists are reversed to oldest → newest. */
  order?: 'asc' | 'desc';
}

export interface SourceSpec {
  format: typeof SPEC_FORMAT;
  id: string;
  name: string;
  site: string;
  version: string;
  lang?: string;
  icon?: string;
  /** Extra headers for every request (e.g. an API key the SITE gave this app, never a user secret). */
  headers?: Record<string, string>;
  /** Politeness: minimum ms between requests to this source (default 500). */
  minIntervalMs?: number;
  /** Human-readable note shown in the source list (e.g. "Official API, used with permission"). */
  attribution?: string;
  popular: RequestSpec & { list: ListSpec };
  latest?: RequestSpec & { list?: ListSpec };
  search?: RequestSpec & { list?: ListSpec };
  novel: RequestSpec & {
    name?: Field;
    cover?: Field;
    author?: Field;
    summary?: Field;
    status?: Field;
    genres?: Field;
    chapters: ChapterListSpec;
  };
  chapter: RequestSpec & {
    /** HTML: content selector. JSON: path of the HTML string. */
    content: string;
    /** Selectors removed from the content (ads, scripts, "read at …" banners). */
    remove?: string[];
    /** Remove elements hidden by the page's own <style> rules (`display:none` classes, e.g. anti-theft lines). */
    removeHiddenByStyle?: boolean;
    /** The chapter is paywalled when this matches (shown as locked, never fetched again). */
    lockedWhen?: Field;
  };
}

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Cheap check used to route installed source files: JSON object with our format tag. */
export function looksLikeSpec(code: string): boolean {
  const head = code.slice(0, 400).trimStart();
  return head.startsWith('{') && head.includes(SPEC_FORMAT);
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function checkField(where: string, f: unknown, required: boolean): void {
  if (f === undefined) {
    if (required) throw new SpecError(`${where} is required`);
    return;
  }
  if (typeof f === 'string') return;
  if (!isRecord(f)) throw new SpecError(`${where} must be a selector string or a field object`);
  if (f.regex !== undefined) {
    if (typeof f.regex !== 'string' || f.regex.length > 300) throw new SpecError(`${where}.regex must be a string ≤ 300 chars`);
    try {
      new RegExp(f.regex);
    } catch {
      throw new SpecError(`${where}.regex is not a valid regular expression`);
    }
  }
}

function checkRequest(where: string, r: unknown): void {
  if (!isRecord(r) || typeof r.url !== 'string' || !r.url) throw new SpecError(`${where}.url is required`);
  if (r.type !== undefined && r.type !== 'html' && r.type !== 'json') throw new SpecError(`${where}.type must be "html" or "json"`);
}

function checkList(where: string, l: unknown): void {
  if (!isRecord(l) || typeof l.item !== 'string' || !l.item) throw new SpecError(`${where}.item is required`);
  checkField(`${where}.name`, l.name, true);
  checkField(`${where}.path`, l.path, true);
  checkField(`${where}.cover`, l.cover, false);
}

/** Parse + validate. Throws SpecError with a precise message (shown when installing). */
export function parseSpec(text: string): SourceSpec {
  if (text.length > 256 * 1024) throw new SpecError('Source definition is too large (max 256 KB)');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SpecError('Source definition is not valid JSON');
  }
  if (!isRecord(raw) || raw.format !== SPEC_FORMAT) throw new SpecError(`Unsupported source format (expected "${SPEC_FORMAT}")`);
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw new SpecError('id must be 1–64 chars of letters, digits, . _ -');
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new SpecError('name is required');
  if (typeof raw.site !== 'string' || !/^https:\/\//i.test(raw.site)) throw new SpecError('site must be an https URL');
  if (typeof raw.version !== 'string' || !raw.version) throw new SpecError('version is required');
  checkRequest('popular', raw.popular);
  checkList('popular.list', (raw.popular as Record<string, unknown>).list);
  if (raw.latest !== undefined) checkRequest('latest', raw.latest);
  if (raw.search !== undefined) checkRequest('search', raw.search);
  checkRequest('novel', raw.novel);
  const novel = raw.novel as Record<string, unknown>;
  checkList('novel.chapters', novel.chapters);
  for (const k of ['name', 'cover', 'author', 'summary', 'status', 'genres']) checkField(`novel.${k}`, novel[k], false);
  checkRequest('chapter', raw.chapter);
  const chapter = raw.chapter as Record<string, unknown>;
  if (typeof chapter.content !== 'string' || !chapter.content) throw new SpecError('chapter.content is required');
  if (chapter.remove !== undefined && (!Array.isArray(chapter.remove) || chapter.remove.some((s) => typeof s !== 'string'))) {
    throw new SpecError('chapter.remove must be an array of selectors');
  }
  return raw as unknown as SourceSpec;
}
