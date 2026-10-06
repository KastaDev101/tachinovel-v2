/**
 * Swift quality gates for CI (ios-compile job, macOS). Pure Node, no dependencies, tested on the PC.
 *
 *   node tools/swift-quality.ts lint <swiftlint.json>
 *       SwiftLint JSON report → annotations. Strict: any violation (warning or error) fails, except in
 *       the report-only paths below, which are shown as notices.
 *
 *   node tools/swift-quality.ts warnings <xcodebuild.log> [--baseline=<file>] [--update]
 *       Compiler warnings in the app's own Swift files (ios/App/**; Capacitor and other packages are
 *       ignored). A warning that is not in the baseline fails the build: existing warnings are tolerated,
 *       new ones are errors. Fixed warnings are reported so the baseline can shrink; --update rewrites it.
 *       Matching ignores line numbers, so editing a file doesn't turn its old warnings into new ones.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
export const DEFAULT_BASELINE = 'ci/swift-warnings-baseline.txt';

/**
 * Code owned by another workstream, linted and compiled but not gated here yet: the on-device voice work
 * (branch voice-spike: narration plugin and player, Kokoro engine and models). Remove an entry to enforce.
 */
export const REPORT_ONLY = ['ios/App/App/Native/Narration/', 'ios/App/App/Native/Voice/', 'ios/App/App/KokoroModels/', 'ios/App/HDVoiceCore/'];

export function isReportOnly(file: string): boolean {
  return REPORT_ONLY.some((p) => file.startsWith(p));
}

/** Absolute runner path → repo-relative path for files under ios/App/, else null (not our code). */
export function ownPath(file: string): string | null {
  const norm = file.replace(/\\/g, '/');
  // Package checkouts and build products are not our code, wherever they live.
  if (/\/(SourcePackages|DerivedData|node_modules|\.build|Pods)\//.test(`/${norm}`)) return null;
  let rel: string;
  if (norm.startsWith('ios/App/')) rel = norm;
  else {
    const i = norm.lastIndexOf('/ios/App/');
    if (i < 0) return null;
    rel = norm.slice(i + 1);
  }
  return rel.startsWith('ios/App/CapApp-SPM/') ? null : rel;
}

// ---------- compiler warnings ----------

export interface Warning {
  file: string;
  line: number;
  col: number;
  message: string;
}

/** Unique warnings in our own Swift files (xcodebuild prints some twice: per architecture, in summaries). */
export function parseWarnings(log: string): Warning[] {
  const seen = new Set<string>();
  const out: Warning[] = [];
  for (const m of log.matchAll(/^(.+?\.swift):(\d+):(\d+): warning: (.+?)\s*$/gm)) {
    const file = ownPath(m[1]!);
    if (!file) continue;
    const w = { file, line: Number(m[2]), col: Number(m[3]), message: m[4]! };
    const id = `${w.file}:${w.line}:${w.col}:${w.message}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(w);
  }
  return out;
}

const keyOf = (file: string, message: string): string => `${file}\t${message}`;

export function countWarnings(warnings: Warning[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const w of warnings) counts.set(keyOf(w.file, w.message), (counts.get(keyOf(w.file, w.message)) ?? 0) + 1);
  return counts;
}

/** Baseline file: `<count>\t<file>\t<message>` per line, `#` comments. */
export function parseBaseline(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!raw.trim() || raw.startsWith('#')) continue;
    const [n, file, ...rest] = raw.split('\t');
    if (!file || rest.length === 0 || !/^\d+$/.test(n ?? '')) throw new Error(`bad baseline line: ${raw}`);
    counts.set(keyOf(file, rest.join('\t')), Number(n));
  }
  return counts;
}

export function formatBaseline(counts: Map<string, number>): string {
  const header = [
    '# Swift compiler warnings tolerated in the app target (tools/swift-quality.ts warnings).',
    '# Any warning not listed here fails CI. Fix warnings rather than adding them; after fixing some,',
    '# refresh with: node tools/swift-quality.ts warnings <xcodebuild.log> --update',
    '# Format: <count><TAB><file><TAB><message>',
  ];
  const lines = [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, n]) => `${n}\t${k}`);
  return `${[...header, ...lines].join('\n')}\n`;
}

export interface WarningReport {
  /** New warnings in gated files: these fail. */
  failing: Warning[];
  /** New warnings in report-only files. */
  reported: Warning[];
  /** Baseline entries no longer seen (fixed): key → how many fewer. */
  fixed: Map<string, number>;
}

export function compareWarnings(current: Warning[], baseline: Map<string, number>): WarningReport {
  const budget = new Map(baseline);
  const failing: Warning[] = [];
  const reported: Warning[] = [];
  for (const w of current) {
    const k = keyOf(w.file, w.message);
    const left = budget.get(k) ?? 0;
    if (left > 0) {
      budget.set(k, left - 1);
      continue;
    }
    (isReportOnly(w.file) ? reported : failing).push(w);
  }
  const fixed = new Map([...budget.entries()].filter(([, n]) => n > 0));
  return { failing, reported, fixed };
}

// ---------- SwiftLint ----------

export interface LintViolation {
  file: string;
  line: number;
  col: number;
  rule: string;
  severity: string;
  reason: string;
}

/**
 * SwiftLint `--reporter json` output → violations in our files, split into gated and report-only.
 * Throws on anything that is not a JSON array: an empty report means SwiftLint itself failed (bad config,
 * crash), which must not pass as "no violations".
 */
export function classifyLint(json: string): { failing: LintViolation[]; reported: LintViolation[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) throw new Error('SwiftLint produced no JSON report (configuration error or crash; see its output above)');
  const raw = parsed as { file?: string; line?: number; character?: number | null; rule_id?: string; severity?: string; reason?: string }[];
  const failing: LintViolation[] = [];
  const reported: LintViolation[] = [];
  for (const v of raw) {
    const file = v.file ? ownPath(v.file) : null;
    if (!file) continue;
    const item = { file, line: v.line ?? 1, col: v.character ?? 1, rule: v.rule_id ?? 'unknown', severity: (v.severity ?? 'warning').toLowerCase(), reason: v.reason ?? '' };
    (isReportOnly(file) ? reported : failing).push(item);
  }
  return { failing, reported };
}

// ---------- output ----------

const escData = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s: string): string => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function annotation(level: 'error' | 'warning' | 'notice', file: string, line: number, col: number, title: string, message: string): string {
  return `::${level} file=${escProp(file)},line=${line},col=${col},title=${escProp(title)}::${escData(message)}`;
}

function summary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

function runLint(reportPath: string): number {
  let result: ReturnType<typeof classifyLint>;
  try {
    result = classifyLint(existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '');
  } catch (err) {
    console.log(`::error title=SwiftLint::${escData(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
  const { failing, reported } = result;
  for (const v of failing) console.log(annotation('error', v.file, v.line, v.col, `SwiftLint ${v.rule}`, v.reason));
  for (const v of reported) console.log(annotation('notice', v.file, v.line, v.col, `SwiftLint ${v.rule} (report-only path)`, v.reason));
  console.log(`SwiftLint: ${failing.length} violation(s) in gated files, ${reported.length} in report-only paths (${REPORT_ONLY.join(', ')}).`);
  summary(`### SwiftLint\n\n${failing.length} violation(s) in gated files, ${reported.length} in report-only paths.`);
  return failing.length > 0 ? 1 : 0;
}

function runWarnings(logPath: string, baselinePath: string, update: boolean): number {
  const current = parseWarnings(readFileSync(logPath, 'utf8'));
  const abs = path.resolve(root, baselinePath);
  if (update) {
    writeFileSync(abs, formatBaseline(countWarnings(current)));
    console.log(`wrote ${baselinePath}: ${current.length} warning(s)`);
    return 0;
  }
  const baseline = existsSync(abs) ? parseBaseline(readFileSync(abs, 'utf8')) : new Map<string, number>();
  const { failing, reported, fixed } = compareWarnings(current, baseline);
  for (const w of failing) console.log(annotation('error', w.file, w.line, w.col, 'New Swift warning', w.message));
  for (const w of reported) console.log(annotation('notice', w.file, w.line, w.col, 'New Swift warning (report-only path)', w.message));
  const fixedCount = [...fixed.values()].reduce((a, b) => a + b, 0);
  if (fixedCount > 0) console.log(`::notice title=Swift warnings fixed::${fixedCount} baselined warning(s) are gone; shrink ${baselinePath} with --update`);
  console.log(`Swift warnings: ${current.length} in the app's own files; ${failing.length} new (failing), ${reported.length} new in report-only paths, ${fixedCount} fixed.`);
  summary(`### Swift compiler warnings\n\n${current.length} in the app's own files; **${failing.length} new** (failing), ${reported.length} new in report-only paths, ${fixedCount} fixed since the baseline.`);
  return failing.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  const [cmd, file, ...rest] = process.argv.slice(2);
  const baseline = rest.find((a) => a.startsWith('--baseline='))?.slice('--baseline='.length) ?? DEFAULT_BASELINE;
  if (cmd === 'lint' && file) process.exit(runLint(file));
  if (cmd === 'warnings' && file) process.exit(runWarnings(file, baseline, rest.includes('--update')));
  console.error('usage: node tools/swift-quality.ts lint <swiftlint.json> | warnings <xcodebuild.log> [--baseline=<file>] [--update]');
  process.exit(2);
}
