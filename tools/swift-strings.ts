/**
 * Localization readiness for the native layer (CONTRIBUTING.md "Native strings"). User-facing Swift
 * strings go through `String(localized:comment:)` and live in the String Catalog
 * ios/App/App/Localizable.xcstrings (English only for now; translators add languages to the same file).
 *
 * A PC-side check, since Xcode isn't available here (tests/localization.test.ts runs it):
 *  - no hard-coded literal reaches a UI sink: alert/action titles, CarPlay list texts, notification
 *    title/body, labels, accessibility labels, navigation titles (directly, or through a `let`/`var`
 *    that is then passed to one in the same file);
 *  - every localized key in the code is in the catalog (with a comment for translators), and the
 *    catalog has no keys the code no longer uses.
 * Not localized on purpose: log messages, `call.reject` errors (the web UI words what users see),
 * identifiers. Mark a deliberate exception with `// l10n-ignore: <why>` on the line (e.g. the app name).
 * Paths owned by another workstream are report-only (tools/swift-quality.ts REPORT_ONLY).
 *
 *   node tools/swift-strings.ts            print findings; exit 1 on a gated one
 *   node tools/swift-strings.ts --format   rewrite the catalog in Xcode's layout first
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isReportOnly } from './swift-quality.ts';

const root = path.resolve(import.meta.dirname, '..');
export const CATALOG = 'ios/App/App/Localizable.xcstrings';
/** Swift that ships in the app (the UI test target only reads UI strings). */
const SWIFT_ROOTS = ['ios/App/App'];

export interface Literal {
  /** Offset of the opening quote in the file. */
  start: number;
  end: number;
  /** Source text between the quotes (escapes and interpolations as written). */
  raw: string;
}

/**
 * Splits Swift source into string literals and "code" (same length; comments and literal contents
 * replaced by spaces so regexes see structure only). Handles nested block comments, escapes,
 * interpolations with nested literals, multi-line ("""…""") and raw (#"…"#) strings.
 */
export function scanSwift(src: string): { code: string; literals: Literal[] } {
  const code = src.split('');
  const literals: Literal[] = [];
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (code[k] !== '\n') code[k] = ' ';
  };
  let i = 0;
  const n = src.length;
  // Returns the index just past the literal that opens at `at`.
  const readString = (at: number): number => {
    let hashes = 0;
    let j = at;
    while (src[j] === '#') {
      hashes++;
      j++;
    }
    const multi = src.startsWith('"""', j);
    const open = multi ? 3 : 1;
    const close = `${multi ? '"""' : '"'}${'#'.repeat(hashes)}`;
    const escape = `\\${'#'.repeat(hashes)}`;
    const bodyStart = j + open;
    let k = bodyStart;
    while (k < n) {
      if (src.startsWith(escape, k)) {
        const after = k + escape.length;
        if (src[after] === '(') {
          // Interpolation: skip to the matching paren, stepping over nested literals.
          let depth = 1;
          let m = after + 1;
          while (m < n && depth > 0) {
            if (src[m] === '"' || (src[m] === '#' && /^#+"/.test(src.slice(m, m + 8)))) {
              m = readString(m);
              continue;
            }
            if (src[m] === '(') depth++;
            if (src[m] === ')') depth--;
            m++;
          }
          k = m;
          continue;
        }
        k = after + 1;
        continue;
      }
      if (src.startsWith(close, k)) {
        literals.push({ start: at, end: k + close.length, raw: src.slice(bodyStart, k) });
        return k + close.length;
      }
      if (!multi && src[k] === '\n') break; // unterminated: stop at the line end
      k++;
    }
    return k;
  };
  while (i < n) {
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (src.startsWith('/*', i)) {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (src.startsWith('*/', j)) {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
    } else if (src[i] === '"' || (src[i] === '#' && /^#+"/.test(src.slice(i, i + 8)))) {
      const before = literals.length;
      const end = readString(i);
      // Literals nested in interpolations were pushed first; keep them in source order.
      const outer = literals.splice(before);
      literals.push(...outer.sort((a, b) => a.start - b.start));
      blank(i + 1, end - 1);
      i = end;
    } else i++;
  }
  return { code: code.join(''), literals };
}

/** "\(n) new chapters" → "%… new chapters"; "%lld new chapters" → the same. */
export function normalizeKey(key: string): string {
  return key
    .replace(/\\\((?:[^()]|\([^()]*\))*\)/g, '%_')
    .replace(/%(?:\d+\$)?(?:lld|ld|d|i|u|llu|lu|lf|f|g|@)/g, '%_');
}

/** Text a person reads (not an identifier, path or format token). */
export function looksHuman(raw: string): boolean {
  const text = raw.replace(/\\\((?:[^()]|\([^()]*\))*\)/g, '').trim();
  return /\p{L}/u.test(text);
}

const LOCALIZERS = /(?:String\(\s*localized:|NSLocalizedString\(|LocalizedStringResource\(|LocalizedStringKey\(|String\.LocalizationValue\()\s*$/;
// SwiftUI views and modifiers take a LocalizedStringKey: a literal there is already localized.
const SWIFTUI_KEYS = /(?:\b(?:Text|Button|Label|Toggle|Section|Picker|NavigationLink|Link|Stepper|TextField|SecureField|Menu)|\.(?:navigationTitle|accessibilityLabel|accessibilityHint|help))\(\s*$/;
/** Labeled arguments and properties that put text on screen (UIKit, CarPlay, notifications). */
const SINK_NAMES = 'title|message|text|detailText|header|subtitle|placeholder|prompt|body|accessibilityLabel|accessibilityHint|accessibilityValue';
const SINK_ARG = new RegExp(`\\b(?:${SINK_NAMES})\\s*:`);
const SINK_ASSIGN = new RegExp(`(?:\\.(?:${SINK_NAMES})|^\\s*(?:self\\.)?title)\\s*=(?!=)`);
/** Right before the literal: the sink itself, or an operator inside the sink's expression (`a ? "x" : "y"`, `b ?? "z"`). */
const AT_SINK = new RegExp(`(?:\\b(?:${SINK_NAMES})\\s*:|(?:\\.(?:${SINK_NAMES})|^\\s*(?:self\\.)?title)\\s*=|\\bsetTitle\\()\\s*$`);
const IN_EXPRESSION = /(?:\?\??|[^\w\s]:|\s:|\((?:\s*\w+\s*:)?)\s*$/;

export type Kind = 'hard-coded' | 'localized';
export interface Finding {
  file: string;
  line: number;
  kind: Kind;
  text: string;
  /** For localized keys: the comment argument, if any. */
  comment?: string;
}

export function findStrings(src: string, file: string): Finding[] {
  const { code, literals } = scanSwift(src);
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (at: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const lineAt = (s: string, at: number): string => {
    const start = s.lastIndexOf('\n', at - 1) + 1;
    const end = s.indexOf('\n', at);
    return s.slice(start, end < 0 ? s.length : end);
  };
  const out: Finding[] = [];

  // Variables holding literals that reach a sink later in this file: `let x = c ? "A" : nil` + `title: x`.
  const sinkVars = new Set<string>();
  for (const m of code.matchAll(new RegExp(`(?:\\b(?:${SINK_NAMES})\\s*:|\\.(?:${SINK_NAMES})\\s*=)\\s*([A-Za-z_]\\w*)\\b(?!\\s*[.(\\[])`, 'g'))) sinkVars.add(m[1]!);
  const declared = new Map<number, string>(); // line → the variable declared on it
  for (const m of code.matchAll(/\b(?:let|var)\s+([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/g)) declared.set(lineOf(m.index), m[1]!);

  // Literals nested inside another literal's interpolation are judged with their outer literal.
  const top = literals.filter((l) => !literals.some((o) => o !== l && o.start < l.start && l.end <= o.end));
  for (const [idx, lit] of top.entries()) {
    const prefix = code.slice(code.lastIndexOf('\n', lit.start - 1) + 1, lit.start);
    const line = lineOf(lit.start);
    if (LOCALIZERS.test(prefix) || SWIFTUI_KEYS.test(prefix)) {
      const next = top[idx + 1];
      const comment = next && /^\s*,\s*comment:\s*$/.test(code.slice(lit.end, next.start)) ? next.raw : undefined;
      out.push({ file, line, kind: 'localized', text: lit.raw, ...(comment !== undefined ? { comment } : {}) });
      continue;
    }
    if (/\bcomment:\s*$/.test(prefix) || /l10n-ignore/.test(lineAt(src, lit.start)) || !looksHuman(lit.raw)) continue;
    const direct = AT_SINK.test(prefix);
    const inSinkExpression = IN_EXPRESSION.test(prefix) && (SINK_ARG.test(prefix) || SINK_ASSIGN.test(prefix));
    // Names are matched file-wide (no scopes), so only text that reads like UI copy: capitalized or several words.
    const viaVariable = declared.has(line) && sinkVars.has(declared.get(line)!) && /(?:=|\?\??|[^\w\s]:|\s:)\s*$/.test(prefix) && /^\p{Lu}|\s/u.test(lit.raw);
    if (direct || inSinkExpression || viaVariable) out.push({ file, line, kind: 'hard-coded', text: lit.raw });
  }
  return out;
}

export interface Catalog {
  sourceLanguage: string;
  version: string;
  strings: Record<string, { comment?: string; extractionState?: string; localizations?: Record<string, unknown> }>;
}

export function readCatalog(dir = root): Catalog {
  return JSON.parse(readFileSync(path.join(dir, CATALOG), 'utf8')) as Catalog;
}

/** Xcode's own .xcstrings layout (2-space indent, `" : "`, keys sorted), so Xcode on a Mac doesn't rewrite it. */
export function formatCatalog(value: unknown, indent = ''): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) return value.length ? `[\n${value.map((v) => inner + formatCatalog(v, inner)).join(',\n')}\n${indent}]` : '[]';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    if (!keys.length) return '{\n\n' + indent + '}';
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)} : ${formatCatalog((value as Record<string, unknown>)[k], inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function swiftFiles(dir: string, rel: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const r = `${rel}/${name}`;
    if (statSync(abs).isDirectory()) out.push(...swiftFiles(abs, r));
    else if (name.endsWith('.swift')) out.push(r);
  }
  return out;
}

export interface Report {
  /** Fail the check. */
  errors: string[];
  /** Report-only paths (another workstream's code). */
  notes: string[];
  keys: number;
}

export function checkStrings(files: { file: string; src: string }[], catalog: Catalog): Report {
  const errors: string[] = [];
  const notes: string[] = [];
  const catalogKeys = new Map(Object.keys(catalog.strings).map((k) => [normalizeKey(k), k]));
  const used = new Set<string>();
  if (catalog.sourceLanguage !== 'en') errors.push(`${CATALOG}: sourceLanguage must be "en"`);
  for (const { file, src } of files) {
    const target = isReportOnly(file) ? notes : errors;
    for (const f of findStrings(src, file)) {
      const where = `${f.file}:${f.line}`;
      if (f.kind === 'hard-coded') {
        target.push(`${where}: hard-coded UI string "${f.text}": use String(localized: "${f.text}", comment: "<where it appears>") and add it to ${CATALOG}`);
        continue;
      }
      const key = normalizeKey(f.text);
      used.add(key);
      const entry = catalogKeys.has(key) ? catalog.strings[catalogKeys.get(key)!] : undefined;
      if (!entry) target.push(`${where}: "${f.text}" is not in ${CATALOG}: add ${JSON.stringify(f.text.replace(/\\\((?:[^()]|\([^()]*\))*\)/g, '%@'))} : { "comment" : ${JSON.stringify(f.comment ?? '<where it appears>')} } (integers are %lld, not %@)`);
      else if (f.comment === undefined) target.push(`${where}: String(localized: "${f.text}") needs a comment: for translators`);
      else if (entry.comment !== f.comment) target.push(`${where}: the comment of "${f.text}" differs from ${CATALOG} (Xcode would overwrite it): use the same text in both`);
    }
  }
  for (const [norm, key] of catalogKeys) {
    if (!used.has(norm)) errors.push(`${CATALOG}: "${key}" is not used by any Swift file; remove it`);
    if (!catalog.strings[key]?.comment) errors.push(`${CATALOG}: "${key}" has no comment for translators`);
  }
  return { errors, notes, keys: catalogKeys.size };
}

export function repoSwift(dir = root): { file: string; src: string }[] {
  return SWIFT_ROOTS.flatMap((r) => swiftFiles(path.join(dir, r), r)).map((file) => ({ file, src: readFileSync(path.join(dir, file), 'utf8') }));
}

if (import.meta.main) {
  if (process.argv.includes('--format')) {
    writeFileSync(path.join(root, CATALOG), `${formatCatalog(readCatalog())}\n`);
    console.log(`${CATALOG}: formatted`);
  }
  const r = checkStrings(repoSwift(), readCatalog());
  for (const n of r.notes) console.log(`report-only: ${n}`);
  for (const e of r.errors) console.error(e);
  console.log(`native strings: ${r.keys} catalog key(s), ${r.errors.length} problem(s), ${r.notes.length} in report-only paths`);
  if (r.errors.length) process.exit(1);
}
