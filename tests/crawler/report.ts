/** Crawl report: JSON (everything) + Markdown summary (totals, failures with screenshots, coverage). */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Crawler, Finding } from './crawler.ts';

export interface KnownIssue {
  id: string;
  kind: string;
  /** Regexes; all given ones must match. */
  state?: string;
  control?: string;
  message?: string;
  /** Who fixes it: 'v1' (vendored UI/core, fixed upstream and re-vendored) or 'v2'. */
  owner: 'v1' | 'v2' | 'harness';
  note: string;
}

export function loadKnownIssues(file: string): KnownIssue[] {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as KnownIssue[];
  } catch {
    return [];
  }
}

export function matchKnown(f: Finding, known: KnownIssue[]): KnownIssue | undefined {
  return known.find(
    (k) =>
      k.kind === f.kind &&
      (!k.state || new RegExp(k.state).test(f.state)) &&
      (!k.control || new RegExp(k.control).test(f.control ?? '')) &&
      (!k.message || new RegExp(k.message).test(f.message)),
  );
}

export interface RunReport {
  meta: { flavor: string; scheme: string; seed: number; device: string; build: string; durationMs: number; date: string };
  stats: Crawler['stats'] & { failures: number; warnings: number; known: number };
  findings: Finding[];
  states: { index: number; sig: string; path: string[]; screenshot?: string; found: number; sampledOut: number; controls: { label: string; kind: string; outcome: string; ms: number; effects: string[] }[]; layout: { kind: string; detail: string }[] }[];
  /** Visited-states graph: control `control` led from state `from` to state `to` (StateNode.index). */
  edges: { from: number; to: number; control: string }[];
  /** Known issues that didn't show up in this run (fixed? then remove them from known-issues.json). */
  unusedKnown: string[];
}

export function buildReport(crawler: Crawler, meta: RunReport['meta'], known: KnownIssue[]): RunReport {
  const findings = [...crawler.findings.values()];
  for (const f of findings) {
    const k = matchKnown(f, known);
    if (k) f.known = k.id;
  }
  const failures = findings.filter((f) => f.severity === 'fail' && !f.known).length;
  const used = new Set(findings.map((f) => f.known).filter(Boolean));
  const warnings = findings.filter((f) => f.severity === 'warn' && !f.known).length;
  return {
    meta,
    stats: { ...crawler.stats, failures, warnings, known: findings.filter((f) => f.known).length },
    findings,
    edges: crawler.edges,
    unusedKnown: known.filter((k) => !used.has(k.id)).map((k) => k.id),
    states: [...crawler.states.values()].map((s) => ({
      index: s.index,
      sig: s.sig,
      path: s.path.map((p) => p.label),
      ...(s.screenshot ? { screenshot: s.screenshot } : {}),
      found: s.found,
      sampledOut: s.sampledOut,
      controls: s.controls,
      layout: s.layout,
    })),
  };
}

function mdEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/</g, '&lt;');
}

export function markdown(reports: RunReport[]): string {
  const out: string[] = ['# UI crawler report', ''];
  for (const r of reports) {
    const s = r.stats;
    out.push(
      `## ${r.meta.flavor} flavor, ${r.meta.scheme} mode`,
      '',
      `${r.meta.device}, seed ${r.meta.seed}, build ${r.meta.build}, ${Math.round(r.meta.durationMs / 1000)} s.`,
      '',
      '| States | Controls found | Activated | Sampled out (repeated rows) | Disabled | Skipped (budget) | Fresh launches | Failures | Warnings | Known |',
      '|---|---|---|---|---|---|---|---|---|---|',
      `| ${s.states} | ${s.controlsFound} | ${s.controlsTried} | ${s.sampledOut} | ${s.disabled} | ${s.skipped} | ${s.resets} | **${s.failures}** | ${s.warnings} | ${s.known} |`,
      '',
    );
    const order = (f: Finding): number => (f.known ? 2 : f.severity === 'fail' ? 0 : 1);
    const list = [...r.findings].sort((a, b) => order(a) - order(b));
    if (list.length === 0) out.push('No findings.', '');
    else {
      out.push('| | Kind | Where | Control | What | × | Screenshot |', '|---|---|---|---|---|---|---|');
      for (const f of list) {
        const tag = f.known ? `known (${f.known})` : f.severity === 'fail' ? '**FAIL**' : 'warn';
        const shot = f.screenshot ? `[png](${r.meta.scheme}/${f.screenshot})` : '';
        out.push(`| ${tag} | ${f.kind} | ${mdEscape(f.state)} | ${mdEscape(f.control ?? '')} | ${mdEscape(f.message.slice(0, 240))} | ${f.count} | ${shot} |`);
      }
      out.push('');
      const fails = list.filter((f) => !f.known && f.severity === 'fail');
      if (fails.length) {
        out.push('<details><summary>Repro steps for failures</summary>', '');
        for (const f of fails) out.push(`- **${f.kind}** ${mdEscape(f.control ?? f.state)}: ${f.repro.map(mdEscape).join(' → ')}`);
        out.push('', '</details>', '');
      }
    }
    if (r.unusedKnown.length) {
      out.push(`Known issues not seen in this run (fixed? remove them from tests/crawler/known-issues.json): ${r.unusedKnown.map((k) => `\`${k}\``).join(', ')}.`, '');
    }
    out.push('<details><summary>States visited</summary>', '', '| # | State | Controls (found / tried) | Path |', '|---|---|---|---|');
    r.states.forEach((st, i) => {
      out.push(`| [${i + 1}](${r.meta.scheme}/${st.screenshot ?? ''}) | ${mdEscape(st.sig)} | ${st.found} / ${st.controls.length} | ${mdEscape(st.path.join(' → ') || 'launch')} |`);
    });
    out.push('', '</details>', '');
  }
  return out.join('\n');
}

export function writeReports(dir: string, reports: RunReport[]): void {
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(reports, null, 2));
  writeFileSync(path.join(dir, 'report.md'), markdown(reports));
}
