/**
 * CI budgets (CONTRIBUTING.md "Budgets"), with the baselines in ci/budgets.json:
 *
 *   node tools/budgets.ts ipa <file.ipa>          hard: fail when the sideload IPA is more than
 *                                                 maxGrowthPercent over the committed baseline (job ios-ipa)
 *   node tools/budgets.ts set-ipa <bytes|file>    record a new IPA baseline (commit it with the reason)
 *   node tools/budgets.ts boot <boot-times.txt>   soft: warn when the simulator's cold-launch median is
 *                                                 over budget (job ios-compile; never fails)
 *
 * Results go to the log as annotations and to the job summary. The web bundle budgets are separate
 * (tools/build.ts, checked on every build).
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
export const BUDGETS_FILE = path.join(root, 'ci', 'budgets.json');

export interface Budgets {
  ipa: { baselineBytes: number | null; maxGrowthPercent: number; note?: string };
  boot: { metric: string; recordedMedianMs: number; warnAboveMs: number; note?: string };
}

export type Level = 'ok' | 'notice' | 'warning' | 'error';
export interface Result {
  level: Level;
  message: string;
}

export function loadBudgets(file = BUDGETS_FILE): Budgets {
  return JSON.parse(readFileSync(file, 'utf8')) as Budgets;
}

const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;
const pct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

export function checkIpa(bytes: number, budget: Budgets['ipa']): Result {
  const record = `node tools/budgets.ts set-ipa ${bytes}`;
  if (budget.baselineBytes === null) return { level: 'notice', message: `IPA ${mb(bytes)} (${bytes} bytes); no baseline yet, nothing enforced. Record one: ${record}` };
  const base = budget.baselineBytes;
  const growth = ((bytes - base) / base) * 100;
  const summary = `IPA ${mb(bytes)}, baseline ${mb(base)} (${pct(growth)}, budget +${budget.maxGrowthPercent}%)`;
  if (growth > budget.maxGrowthPercent) {
    return { level: 'error', message: `${summary}. Find what grew (the build log lists the bundle); if the growth is intended, raise the baseline in this PR (${record}) and say why.` };
  }
  if (growth < -budget.maxGrowthPercent) return { level: 'warning', message: `${summary}. Smaller is good: lower the baseline so later growth is caught (${record}).` };
  return { level: 'ok', message: summary };
}

export function setIpaBaseline(budgets: Budgets, bytes: number): Budgets {
  if (!Number.isInteger(bytes) || bytes <= 0) throw new Error(`not a size in bytes: ${bytes}`);
  return { ...budgets, ipa: { ...budgets.ipa, baselineBytes: bytes } };
}

/**
 * Values of one column of ci/ios-sim-smoke.sh's boot-times.txt: a header line of column names (no spaces
 * inside a name, e.g. "process->library"), then one line per launch (name, then one value per column;
 * "-" when unknown). Lines with a different shape ("no boot line …") are skipped.
 */
export function parseBootTimes(text: string, metric: string): number[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines.findIndex((l) => l.split(/\s+/).includes(metric));
  if (header < 0) return [];
  const columns = lines[header]!.trim().split(/\s+/).filter((c) => c !== '(ms)');
  const at = columns.indexOf(metric);
  const values: number[] = [];
  for (const line of lines.slice(header + 1)) {
    const cells = line.trim().split(/\s+/);
    if (cells.length !== columns.length) continue;
    const v = Number(cells[at]);
    if (/^\d+$/.test(cells[at] ?? '') && Number.isFinite(v)) values.push(v);
  }
  return values;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function checkBoot(values: number[], budget: Budgets['boot']): Result {
  if (values.length === 0) return { level: 'notice', message: `no ${budget.metric} times in the boot report; nothing checked` };
  const m = median(values);
  const summary = `${budget.metric} median ${m} ms (n=${values.length}), soft budget ${budget.warnAboveMs} ms (recorded ${budget.recordedMedianMs} ms)`;
  if (m > budget.warnAboveMs) return { level: 'warning', message: `${summary}. Over budget: compare boot-times.txt with an earlier run; the simulator VM is noisy, so re-run before digging in.` };
  return { level: 'ok', message: summary };
}

// GitHub workflow commands: data escapes %, CR, LF; properties also escape ':' and ','.
const escData = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s: string): string => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function annotation(level: Level, title: string, message: string): string {
  return `::${level === 'ok' ? 'notice' : level} title=${escProp(title)}::${escData(message)}`;
}

function report(title: string, r: Result): void {
  console.log(annotation(r.level, title, r.message));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  const mark = { ok: 'ok', notice: 'note', warning: 'WARNING', error: 'FAILED' }[r.level];
  if (summary) appendFileSync(summary, `**${title}** (${mark}): ${r.message}\n\n`);
}

function fail(message: string): never {
  console.error(`budgets: ${message}`);
  process.exit(1);
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  const budgets = loadBudgets();
  switch (cmd ?? '') {
    case 'ipa': {
      if (!arg) fail('usage: node tools/budgets.ts ipa <file.ipa>');
      const r = checkIpa(statSync(arg).size, budgets.ipa);
      report('IPA size budget', r);
      if (r.level === 'error') process.exit(1);
      break;
    }
    case 'set-ipa': {
      if (!arg) fail('usage: node tools/budgets.ts set-ipa <bytes|file.ipa>');
      const bytes = /^\d+$/.test(arg) ? Number(arg) : statSync(arg).size;
      writeFileSync(BUDGETS_FILE, `${JSON.stringify(setIpaBaseline(budgets, bytes), null, 2)}\n`);
      console.log(`ci/budgets.json: IPA baseline ${mb(bytes)} (${bytes} bytes)`);
      break;
    }
    case 'boot': {
      if (!arg) fail('usage: node tools/budgets.ts boot <boot-times.txt>');
      let text = '';
      try {
        text = readFileSync(arg, 'utf8');
      } catch {
        // No report (the smoke test failed before writing it): a soft budget has nothing to say.
      }
      report('Boot time budget (simulator)', checkBoot(parseBootTimes(text, budgets.boot.metric), budgets.boot));
      break;
    }
    default:
      fail('usage: node tools/budgets.ts ipa <file.ipa> | set-ipa <bytes|file.ipa> | boot <boot-times.txt>');
  }
}
