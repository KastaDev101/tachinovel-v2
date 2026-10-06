/**
 * Fixed interpreter for declarative source specs (spec.ts) → v1 SourceAdapter.
 *
 * Reuses v1's plugin-host networking (cookie jar, per-host limits, Cloudflare detection + WebView
 * fallback, error mapping) and normalization helpers, so declarative sources behave exactly like
 * JS plugins to the rest of the app. Nothing from the spec is ever evaluated as code: selectors go to
 * cheerio, paths to a tiny JSON walker, regexes to RegExp.
 */
import * as cheerio from 'cheerio/slim';
import type { Cheerio, CheerioAPI } from 'cheerio/slim';
import type { AnyNode } from 'domhandler';
import type { ChapterMeta, NovelDetails, NovelSummary } from '@v1/shared/contracts/domain.ts';
import { PluginLoadError, SourceError, type PluginHost, type PluginHostDeps, type SourceAdapter, type SourceMeta } from '@v1/shared/contracts/plugin-host.ts';
import { createNet, type Net } from '@v1/plugin-host/net.ts';
import { absoluteUrl, cleanText, coverUrl, htmlToText, mapStatus, toChapterMetas, type RawChapter } from '@v1/plugin-host/normalize.ts';
import { URL } from '@v1/plugin-host/polyfills/url.ts';
import { type ChapterListSpec, type Field, type FieldSpec, type ListSpec, type RequestSpec, type SourceSpec, SpecError, parseSpec } from './spec.ts';

type CheerioRoot = CheerioAPI;
type Sel = Cheerio<AnyNode>;

type Doc = { kind: 'html'; $: CheerioRoot; raw: string } | { kind: 'json'; data: unknown; raw: string };
type Scope = { kind: 'html'; $: CheerioRoot; el: Sel } | { kind: 'json'; value: unknown };

const DEFAULT_INTERVAL_MS = 500;

// ---------- JSON paths ----------

/** Dotted path with [n] and [*]: "data.items[*].title". Returns an array when [*] is used. */
export function jsonPath(value: unknown, path: string): unknown {
  if (!path || path === '$' || path === '.') return value;
  const tokens = path.replace(/\[(\*|\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current: unknown[] = [value];
  let multi = false;
  for (const t of tokens) {
    const next: unknown[] = [];
    for (const v of current) {
      if (t === '*') {
        multi = true;
        if (Array.isArray(v)) next.push(...(v as unknown[]));
        else if (v && typeof v === 'object') next.push(...(Object.values(v) as unknown[]));
      } else if (Array.isArray(v) && /^\d+$/.test(t)) {
        next.push(v[Number(t)]);
      } else if (v && typeof v === 'object') {
        next.push((v as Record<string, unknown>)[t]);
      }
    }
    current = next.filter((x) => x !== undefined && x !== null);
  }
  return multi ? current : current[0];
}

// ---------- fields ----------

function asSpec(f: Field): FieldSpec {
  return typeof f === 'string' ? { selector: f } : f;
}

function postProcess(raw: string, f: FieldSpec): string {
  let v = raw;
  if (f.regex) {
    const m = new RegExp(f.regex).exec(v);
    v = m ? (m[1] ?? m[0]) : '';
  }
  for (const [pattern, replacement] of f.replace ?? []) v = v.replace(new RegExp(pattern, 'g'), replacement);
  v = cleanText(v);
  if (v && f.prefix) v = f.prefix + v;
  if (v && f.map) {
    const key = Object.keys(f.map).find((k) => k.toLowerCase() === v.toLowerCase());
    if (key !== undefined) v = f.map[key] as string;
  }
  return v;
}

function htmlValue(scope: Extract<Scope, { kind: 'html' }>, f: FieldSpec, el: Sel): string {
  if (f.attr) {
    // "data-src|src": first non-empty attribute (lazy-loaded images).
    for (const name of f.attr.split('|')) {
      const v = el.attr(name.trim());
      if (v && v.trim()) return v;
    }
    return '';
  }
  if (f.html) return el.html() ?? '';
  void scope;
  return el.text();
}

function select(scope: Extract<Scope, { kind: 'html' }>, f: FieldSpec): Sel {
  return f.selector ? scope.el.find(f.selector) : scope.el;
}

/** All values of a field (genres). */
export function readAll(scope: Scope, field: Field | undefined): string[] {
  if (field === undefined) return [];
  const f = asSpec(field);
  if (scope.kind === 'json') {
    const v = jsonPath(scope.value, f.json ?? f.selector ?? '');
    const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
    return list.map((x) => postProcess(typeof x === 'string' ? x : JSON.stringify(x), f)).filter(Boolean);
  }
  const out: string[] = [];
  select(scope, f).each((_, node) => {
    const v = postProcess(htmlValue(scope, f, scope.$(node)), f);
    if (v) out.push(v);
  });
  return out;
}

/** First value of a field ('' when nothing matched and no default). */
export function readOne(scope: Scope, field: Field | undefined): string {
  if (field === undefined) return '';
  const f = asSpec(field);
  if (f.all) return readAll(scope, f).join(', ');
  let v = '';
  if (scope.kind === 'json') {
    const raw = jsonPath(scope.value, f.json ?? f.selector ?? '');
    const first: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
    if (first !== undefined && first !== null) {
      // Strings as they are, numbers/booleans as text, anything else as JSON (like readAll), never "[object Object]".
      const text = typeof first === 'string' ? first : typeof first === 'number' || typeof first === 'boolean' ? String(first) : JSON.stringify(first);
      v = postProcess(text, f);
    }
  } else {
    const el: Sel = select(scope, f).first();
    if (el.length > 0) v = postProcess(htmlValue(scope, f, el), f);
  }
  return v || f.default || '';
}

export function readBool(scope: Scope, field: Field | undefined): boolean {
  if (field === undefined) return false;
  const f = asSpec(field);
  if (f.exists !== false && scope.kind === 'html' && f.selector && !f.attr && !f.regex) return select(scope, f).length > 0;
  const v = readOne(scope, field).toLowerCase();
  return v !== '' && v !== 'false' && v !== '0' && v !== 'no';
}

// ---------- adapter ----------

export interface DeclarativeAdapter extends SourceAdapter {
  readonly spec: SourceSpec;
}

function fillTemplate(t: string, vars: Record<string, string | number>): string {
  return t.replace(/\{(page0|page|query|path)\}/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new SourceError('PLUGIN', `URL template needs {${k}}`);
    return k === 'query' ? encodeURIComponent(String(v)) : String(v);
  });
}

/** Absolute URL → site-relative path when on the site's host, else kept absolute. */
export function toPath(href: string, site: string): string {
  const abs = absoluteUrl(href, site);
  if (!abs) return '';
  const s = new URL(site);
  const u = new URL(abs);
  if (u.host !== s.host) return abs;
  return `${u.pathname.replace(/^\/+/, '')}${u.search}`;
}

export function createDeclarativeAdapter(spec: SourceSpec, deps: PluginHostDeps, net: Net): DeclarativeAdapter {
  const site = spec.site.endsWith('/') ? spec.site : `${spec.site}/`;
  const interval = Math.max(0, spec.minIntervalMs ?? DEFAULT_INTERVAL_MS);
  let nextSlot = 0;

  async function polite(): Promise<void> {
    const now = deps.now();
    const wait = nextSlot - now;
    nextSlot = Math.max(now, nextSlot) + interval;
    if (wait > 0) await deps.sleep(wait);
  }

  function resolve(pathOrUrl: string): string {
    return absoluteUrl(pathOrUrl, site) ?? site;
  }

  async function load(req: RequestSpec, vars: Record<string, string | number>): Promise<Doc> {
    const url = resolve(fillTemplate(req.url, vars));
    await polite();
    const headers: Record<string, string> = { ...(spec.headers ?? {}), ...(req.headers ?? {}) };
    const body = req.body !== undefined ? fillTemplate(req.body, vars) : undefined;
    if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = body.trimStart().startsWith('{') ? 'application/json' : 'application/x-www-form-urlencoded';
    }
    const res = await net.request({ url, method: req.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}), referer: site });
    if (res.status === 404) throw new SourceError('NOT_FOUND', `Not found: ${url}`);
    if (res.status >= 400) throw new SourceError('NETWORK', `HTTP ${res.status} for ${url}`);
    if ((req.type ?? 'html') === 'json') {
      try {
        return { kind: 'json', data: JSON.parse(res.body) as unknown, raw: res.body };
      } catch {
        throw new SourceError('PLUGIN', `Expected JSON from ${url}`);
      }
    }
    return { kind: 'html', $: cheerio.load(res.body), raw: res.body };
  }

  function rootScope(doc: Doc): Scope {
    return doc.kind === 'json' ? { kind: 'json', value: doc.data } : { kind: 'html', $: doc.$, el: doc.$.root() };
  }

  function items(doc: Doc, list: ListSpec): Scope[] {
    if (doc.kind === 'json') {
      const arr = jsonPath(doc.data, list.item);
      return (Array.isArray(arr) ? (arr as unknown[]) : []).map((value) => ({ kind: 'json', value }));
    }
    const out: Scope[] = [];
    doc.$(list.item).each((_, node) => {
      out.push({ kind: 'html', $: doc.$, el: doc.$(node) });
    });
    return out;
  }

  function summaries(doc: Doc, list: ListSpec): NovelSummary[] {
    const out: NovelSummary[] = [];
    const seen = new Set<string>();
    for (const scope of items(doc, list)) {
      const path = toPath(readOne(scope, list.path), site);
      const name = readOne(scope, list.name);
      if (!path || !name || seen.has(path)) continue;
      seen.add(path);
      const s: NovelSummary = { pluginId: spec.id, path, name };
      const cover = coverUrl(readOne(scope, list.cover), site);
      if (cover) s.cover = cover;
      out.push(s);
    }
    return out;
  }

  function chapterList(doc: Doc, list: ChapterListSpec): ChapterMeta[] {
    const raw: RawChapter[] = items(doc, list).map((scope) => {
      const r: RawChapter = { name: readOne(scope, list.name), path: toPath(readOne(scope, list.path), site) };
      const rt = readOne(scope, list.releaseTime);
      if (rt) r.releaseTime = rt;
      const n = readOne(scope, list.number);
      if (n) r.chapterNumber = n;
      if (list.locked !== undefined && readBool(scope, list.locked)) r.locked = true;
      return r;
    });
    if (list.order === 'desc') raw.reverse();
    return toChapterMetas(raw);
  }

  function hiddenClasses(doc: Extract<Doc, { kind: 'html' }>): string[] {
    const classes = new Set<string>();
    doc.$('style').each((_, node) => {
      const css = doc.$(node).text();
      for (const m of css.matchAll(/\.([A-Za-z_][\w-]*)\s*\{[^}]*display\s*:\s*none/g)) classes.add(m[1] as string);
    });
    return [...classes];
  }

  const meta: SourceMeta = {
    id: spec.id,
    name: spec.name,
    site,
    version: spec.version,
    hasCustomJS: false,
    ...(spec.lang ? { lang: spec.lang } : {}),
    ...(spec.icon ? { iconUrl: absoluteUrl(spec.icon, site) ?? spec.icon } : {}),
  };

  return {
    spec,
    meta,
    async popular(page, opts) {
      const useLatest = opts.latest && spec.latest;
      const req = useLatest ? (spec.latest as RequestSpec) : spec.popular;
      const list = (useLatest ? spec.latest?.list : undefined) ?? spec.popular.list;
      return summaries(await load(req, { page, page0: page - 1 }), list);
    },
    async search(query, page) {
      if (!spec.search) throw new SourceError('PLUGIN', `${spec.name} has no search`);
      return summaries(await load(spec.search, { query, page, page0: page - 1 }), spec.search.list ?? spec.popular.list);
    },
    async novel(path) {
      const n = spec.novel;
      const doc = await load(n, { path });
      const scope = rootScope(doc);
      const details: NovelDetails = {
        pluginId: spec.id,
        path,
        name: readOne(scope, n.name) || (doc.kind === 'html' ? cleanText(doc.$('h1').first().text()) : '') || path,
        status: mapStatus(readOne(scope, n.status)),
        genres: readAll(scope, n.genres),
        url: resolve(path),
      };
      const cover = coverUrl(readOne(scope, n.cover), site);
      if (cover) details.cover = cover;
      const author = readOne(scope, n.author);
      if (author) details.author = author;
      if (n.summary !== undefined) {
        const f = asSpec(n.summary);
        const s = f.html ? htmlToText(readOne(scope, n.summary)) : readOne(scope, n.summary);
        if (s) details.summary = s;
      }
      const chaptersDoc = n.chapters.request ? await load(n.chapters.request, { path }) : doc;
      const chapters = chapterList(chaptersDoc, n.chapters);
      details.chapterCount = chapters.length;
      return { details, chapters };
    },
    async chapter(path) {
      const c = spec.chapter;
      const doc = await load(c, { path });
      const scope = rootScope(doc);
      if (c.lockedWhen !== undefined && readBool(scope, c.lockedWhen)) throw new SourceError('LOCKED', 'This chapter is locked on the site');
      if (doc.kind === 'json') {
        const html = jsonPath(doc.data, c.content);
        if (typeof html !== 'string' || !html.trim()) throw new SourceError('PLUGIN', 'Chapter content is empty');
        return html;
      }
      const content = doc.$(c.content).first();
      if (content.length === 0) throw new SourceError('PLUGIN', `Chapter content not found (${c.content})`);
      for (const sel of c.remove ?? []) content.find(sel).remove();
      if (c.removeHiddenByStyle) for (const cls of hiddenClasses(doc)) content.find(`.${cls}`).remove();
      content.find('script,style,iframe,noscript').remove();
      const html = content.html() ?? '';
      if (!html.trim()) throw new SourceError('PLUGIN', 'Chapter content is empty');
      return html;
    },
    resolveUrl(path) {
      return resolve(path);
    },
  };
}

export interface DeclarativeHost extends PluginHost {
  imageRequestInit(adapter: SourceAdapter): { headers?: Record<string, string> } | undefined;
}

/** PluginHost for declarative specs. `load` takes the spec text (what the SourceService stores). */
export function createDeclarativeHost(deps: PluginHostDeps): DeclarativeHost {
  const net = createNet(deps);
  const specs = new WeakMap<SourceAdapter, SourceSpec>();
  return {
    providedModules: [],
    load(code, opts) {
      let spec: SourceSpec;
      try {
        spec = parseSpec(code);
      } catch (err) {
        throw new PluginLoadError(err instanceof SpecError ? err.message : `Invalid source definition: ${String(err)}`);
      }
      if (opts?.expectedId && opts.expectedId !== spec.id) throw new PluginLoadError(`Source id "${spec.id}" does not match "${opts.expectedId}"`);
      const adapter = createDeclarativeAdapter(spec, deps, net);
      specs.set(adapter, spec);
      return adapter;
    },
    imageRequestInit(adapter) {
      const spec = specs.get(adapter);
      if (!spec) return undefined;
      return { headers: { Referer: spec.site, ...(spec.headers ?? {}) } };
    },
  };
}
