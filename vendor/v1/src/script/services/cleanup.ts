/**
 * Cleanup rules: hide junk blocks ("Read at …", ads, translator plugs) in chapter HTML, script-side.
 *
 * A careful block-level splitter (no DOM, no parser library — one linear scan, fast without a JIT):
 * the HTML is cut into contiguous top-level segments — element blocks (<p>, <div>, <h3>, <hr>, <img> …)
 * and inline runs (text and inline elements, ending at <br>). When everything sits in a single container
 * (<div class="chapter">…</div>), the splitter descends into it. A block is hidden when its text
 * contains the rule's pattern (case-insensitive) or matches its regex.
 *
 * Regex safety: JavaScript can't interrupt a running regex, so patterns are screened first (nested
 * quantifiers and backreferences are refused), tested text is capped, and a rule that takes too long on
 * a chapter is switched off for the session. Invalid/unsafe patterns are skipped and logged once.
 */
import type { CleanupRule } from '../../shared/contracts/domain.ts';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript']);
const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'label', 'mark',
  'nobr', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var',
]);
/** Wrappers the splitter descends into when they hold all the content. */
const CONTAINERS = new Set(['div', 'section', 'article', 'main', 'body', 'html', 'center', 'blockquote', 'font', 'span']);

const MAX_TEST_CHARS = 2000;
/** A rule spending more than this on one chapter is disabled for the session. */
const RULE_BUDGET_MS = 100;

export interface Block {
  start: number;
  end: number;
  /** Element blocks: lower-case tag name and the content range. Inline runs have no tag. */
  tag?: string;
  innerStart?: number;
  innerEnd?: number;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** A tag, honouring quoted attribute values (`<p title="a>b">`). */
const TAG_RE = /<\/?([a-z][a-z0-9:-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/** Visible text of an HTML fragment (tags removed, entities decoded, whitespace collapsed). */
export function blockText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    // Inline tags join their text ("Site<b>.com</b>"); other tags separate words.
    .replace(TAG_RE, (_m: string, name: string) => (INLINE.has(name.toLowerCase()) ? '' : ' '));
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

/** End index (exclusive) of the tag starting at `lt`, honouring quoted attribute values. */
function tagEnd(html: string, lt: number, to: number): number {
  let quote = 0;
  for (let i = lt + 1; i < to; i++) {
    const c = html.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return i + 1;
    }
  }
  return to;
}

function tagName(html: string, from: number): string {
  let i = from;
  while (i < html.length) {
    const c = html.charCodeAt(i);
    // letters, digits, '-', ':'
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 58) i++;
    else break;
  }
  return html.slice(from, i).toLowerCase();
}

/** Contiguous top-level segments covering [from, to). */
export function topLevelBlocks(html: string, from = 0, to = html.length): Block[] {
  const blocks: Block[] = [];
  const stack: string[] = [];
  let lower: string | null = null;
  let runStart: number | null = null;
  let element: Block | null = null;
  const closeRun = (at: number): void => {
    if (runStart !== null && at > runStart) blocks.push({ start: runStart, end: at });
    runStart = null;
  };
  const extendRun = (at: number): void => {
    runStart ??= at;
  };
  let pos = from;
  while (pos < to) {
    const lt = html.indexOf('<', pos);
    if (lt < 0 || lt >= to) {
      if (stack.length === 0) extendRun(pos);
      break;
    }
    if (lt > pos && stack.length === 0) extendRun(pos);
    const next = html.charCodeAt(lt + 1);
    // Comments, doctype, processing instructions: no text, kept with the surrounding run/element.
    if (next === 33 /* ! */ || next === 63 /* ? */) {
      let end: number;
      if (html.startsWith('<!--', lt)) {
        const close = html.indexOf('-->', lt + 4);
        end = close < 0 || close + 3 > to ? to : close + 3;
      } else {
        end = tagEnd(html, lt, to);
      }
      if (stack.length === 0) extendRun(lt);
      pos = end;
      continue;
    }
    if (next === 47 /* / */) {
      const name = tagName(html, lt + 2);
      const end = tagEnd(html, lt, to);
      const at = stack.lastIndexOf(name);
      if (at >= 0) {
        stack.length = at;
        if (stack.length === 0 && element) {
          element.end = end;
          element.innerEnd = lt;
          blocks.push(element);
          element = null;
        }
      } else if (stack.length === 0) {
        extendRun(lt); // stray closing tag
      }
      pos = end;
      continue;
    }
    const name = tagName(html, lt + 1);
    if (!name) {
      // A lone '<' in text.
      if (stack.length === 0) extendRun(lt);
      pos = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt, to);
    const selfClosing = html.charCodeAt(end - 2) === 47;
    let after = end;
    if (RAW.has(name) && !selfClosing) {
      lower ??= html.toLowerCase();
      const close = lower.indexOf(`</${name}`, end);
      after = close < 0 || close >= to ? to : tagEnd(html, close, to);
    }
    // A block-level start tag implicitly closes an open top-level <p> (HTML parsing rules).
    if (stack.length === 1 && element?.tag === 'p' && !INLINE.has(name) && name !== 'br') {
      element.end = lt;
      element.innerEnd = lt;
      blocks.push(element);
      element = null;
      stack.length = 0;
    }
    if (stack.length === 0) {
      if (name === 'br') {
        extendRun(lt);
        closeRun(after);
      } else if (INLINE.has(name)) {
        extendRun(lt);
        if (!VOID.has(name) && !selfClosing) stack.push(name);
      } else if (VOID.has(name) || selfClosing || RAW.has(name)) {
        // <hr>, <img>, <script>…: a block of its own.
        closeRun(lt);
        blocks.push({ start: lt, end: after, tag: name });
      } else {
        closeRun(lt);
        element = { start: lt, end: to, tag: name, innerStart: end, innerEnd: to };
        stack.push(name);
      }
    } else if (!VOID.has(name) && !selfClosing && !RAW.has(name)) {
      stack.push(name);
    }
    pos = after;
  }
  if (element) blocks.push(element); // unclosed element: runs to the end
  else closeRun(to);
  return blocks;
}

/** Top-level blocks, descending into a single wrapper that holds all the content. */
export function contentBlocks(html: string): { from: number; to: number; blocks: Block[] } {
  let from = 0;
  let to = html.length;
  let blocks = topLevelBlocks(html, from, to);
  for (let depth = 0; depth < 8; depth++) {
    const meaningful = blocks.filter((b) => b.tag !== undefined || blockText(html.slice(b.start, b.end)) !== '');
    const only = meaningful.length === 1 ? meaningful[0] : undefined;
    if (!only?.tag || !CONTAINERS.has(only.tag) || only.innerStart === undefined || only.innerEnd === undefined) break;
    from = only.innerStart;
    to = only.innerEnd;
    blocks = topLevelBlocks(html, from, to);
  }
  return { from, to, blocks };
}

// ---------- rules ----------

/** Refuse patterns that can backtrack catastrophically (nested quantifiers, backreferences). */
export function isSafeRegex(source: string): boolean {
  if (source.length > 500) return false;
  if (/\\[1-9]|\\k</.test(source)) return false;
  // A quantified group that itself contains a quantifier: (a+)+, (\w*x)*, (.+){2,} …
  if (/\((?:[^()\\]|\\.)*[*+?}](?:[^()\\]|\\.)*\)\s*(?:[*+]|\{\d*,\d*\})/.test(source)) return false;
  return true;
}

type Matcher = (text: string) => boolean;

const compiled = new Map<string, Matcher | null>();
/** Rules switched off for this session because they were too slow. */
const disabled = new Set<string>();

function ruleKey(rule: CleanupRule): string {
  return `${rule.regex ? 're' : 'tx'}\n${rule.pattern}`;
}

/** The rule's matcher, or null (invalid/unsafe regex: reported through `log` once). */
export function compileRule(rule: CleanupRule, log?: (message: string) => void): Matcher | null {
  const key = ruleKey(rule);
  if (compiled.has(key)) return compiled.get(key) ?? null;
  let m: Matcher | null;
  if (!rule.regex) {
    const needle = rule.pattern.toLowerCase();
    m = (text) => text.toLowerCase().includes(needle);
  } else if (!isSafeRegex(rule.pattern)) {
    log?.(`Cleanup rule "${rule.id}" skipped: regex may backtrack catastrophically (${rule.pattern.slice(0, 80)})`);
    m = null;
  } else {
    try {
      const re = new RegExp(rule.pattern, 'i');
      m = (text) => re.test(text.length > MAX_TEST_CHARS ? text.slice(0, MAX_TEST_CHARS) : text);
    } catch (err) {
      log?.(`Cleanup rule "${rule.id}" skipped: invalid regex (${err instanceof Error ? err.message : String(err)})`);
      m = null;
    }
  }
  compiled.set(key, m);
  return m;
}

/** Enabled rules that apply to a source ('*' or its pluginId). */
export function rulesFor(rules: readonly CleanupRule[], pluginId: string): CleanupRule[] {
  return rules.filter((r) => r.enabled && (r.scope === '*' || r.scope === pluginId));
}

export interface CleanupResult {
  html: string;
  /** Text of the hidden blocks, in document order. */
  removed: string[];
}

export function applyCleanup(html: string, rules: readonly CleanupRule[], opts: { now: () => number; log?: (message: string) => void }): CleanupResult {
  const matchers: { rule: CleanupRule; match: Matcher; spent: number }[] = [];
  for (const rule of rules) {
    if (disabled.has(ruleKey(rule))) continue;
    const match = compileRule(rule, opts.log);
    if (match) matchers.push({ rule, match, spent: 0 });
  }
  if (matchers.length === 0 || !html) return { html, removed: [] };
  const { from, to, blocks } = contentBlocks(html);
  const kept: string[] = [html.slice(0, from)];
  const removed: string[] = [];
  for (const b of blocks) {
    const slice = html.slice(b.start, b.end);
    const text = blockText(slice);
    let hide = false;
    if (text) {
      for (const m of matchers) {
        if (disabled.has(ruleKey(m.rule))) continue;
        const t0 = opts.now();
        const hit = m.match(text);
        m.spent += opts.now() - t0;
        if (m.spent > RULE_BUDGET_MS) {
          disabled.add(ruleKey(m.rule));
          opts.log?.(`Cleanup rule "${m.rule.id}" disabled for this session: too slow (${m.spent} ms on one chapter)`);
        }
        if (hit) {
          hide = true;
          break;
        }
      }
    }
    if (hide) removed.push(text);
    else kept.push(slice);
  }
  kept.push(html.slice(to));
  return { html: removed.length > 0 ? kept.join('') : html, removed };
}

/** Tests: forget compiled/disabled rules. */
export function resetCleanupCaches(): void {
  compiled.clear();
  disabled.clear();
}
