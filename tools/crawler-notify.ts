/**
 * Scheduled UI crawls on main (.github/workflows/ui-crawler.yml, every 2 hours): turns the run's reports
 * into a comment for the tracking issue, listing only failures that are NEW — not in
 * tests/crawler/known-issues.json and not already reported in that issue.
 *
 * Usage: node tools/crawler-notify.ts <artifacts-dir> <previous-issue-text-file> <run-url>
 *   <artifacts-dir>: `gh run download` output (ui-crawler-<scheme>/report.json inside).
 * Prints JSON: { "failures": <unknown failures in this run>, "new": <of those, not reported yet>,
 *   "body": <markdown comment, empty when nothing is new> }.
 * Each reported failure carries a stable id in an HTML comment, so the next run skips it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Finding } from '../tests/crawler/crawler.ts';
import type { RunReport } from '../tests/crawler/report.ts';

/** Same finding = same kind, screen on top, control and message (numbers ignored), whatever the path. */
export function failureId(f: Pick<Finding, 'kind' | 'state' | 'control' | 'message'>): string {
  const parts = f.state.replace(/ \[.*\]$/, '').split(' > ');
  const last = parts[parts.length - 1] ?? '';
  const screen = /^(sheet|dialog):|^car-player$/.test(last) && parts.length > 1 ? `${parts[parts.length - 2]} > ${last}` : last;
  const raw = `${f.kind}|${screen}|${f.control ?? ''}|${f.message.replace(/\d{2,}/g, '#').slice(0, 200)}`;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) h = Math.imul(h ^ raw.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function readReports(dir: string): RunReport[] {
  const out: RunReport[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name, 'report.json');
    if (existsSync(file)) out.push(...(JSON.parse(readFileSync(file, 'utf8')) as RunReport[]));
  }
  return out;
}

export function notify(reports: RunReport[], previousText: string, runUrl: string): { failures: number; new: number; body: string } {
  const reported = new Set([...previousText.matchAll(/<!-- crawler-id:([a-z0-9]+) -->/g)].map((m) => m[1]));
  const lines: string[] = [];
  let failures = 0;
  for (const r of reports) {
    for (const f of r.findings) {
      if (f.severity !== 'fail' || f.known) continue;
      failures++;
      const id = failureId(f);
      if (reported.has(id)) continue;
      reported.add(id);
      const where = `${f.state}${f.control ? ` › ${f.control}` : ''}`;
      lines.push(`- **${f.kind}** (${r.meta.scheme}) ${where}: ${f.message.slice(0, 300)}\n  Repro: ${f.repro.join(' → ')} <!-- crawler-id:${id} -->`);
    }
  }
  const body = lines.length
    ? `New UI crawler failures on main ([run](${runUrl}); screenshots in its \`ui-crawler-<scheme>\` artifacts):\n\n${lines.join('\n')}\n`
    : '';
  return { failures, new: lines.length, body };
}

if (import.meta.main) {
  const [dir, prevFile, runUrl] = process.argv.slice(2);
  if (!dir || !prevFile || !runUrl) {
    console.error('usage: node tools/crawler-notify.ts <artifacts-dir> <previous-issue-text-file> <run-url>');
    process.exit(2);
  }
  const previous = existsSync(prevFile) ? readFileSync(prevFile, 'utf8') : '';
  console.log(JSON.stringify(notify(readReports(dir), previous, runUrl)));
}
