/**
 * Summary of the expressive-voice benchmark (.github/workflows/expressive-bench.yml): one row per engine from
 * <dir>/<engine>/report.json (written by expressive-bench), the ASR word error rate per line from the
 * whisper.cpp transcripts next to the WAVs (ci/expressive-asr.sh), and the Kokoro baseline when the
 * workflow ran it (build/voice-check/report.json from ci/voice-check.sh). Writes <dir>/summary.md and
 * <dir>/summary.json and prints the markdown (the workflow appends it to the job summary).
 *
 * Exit status 1 only if an engine produced no audio at all (crash, load failure): numbers never fail it.
 *
 * Usage: node ci/expressive-bench-report.ts <bench dir> <fixtures.json> [kokoro report.json]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { wordErrorRate } from './voice-asr.ts';

export interface BenchLine {
  id: string;
  sample: string;
  emotion: string;
  chars: number;
  synthMs: number;
  firstAudioMs: number;
  audioMs: number;
  x: number;
}

export interface BenchReport {
  engine: string;
  title: string;
  license: string;
  revision: string;
  modelBytes: number;
  device?: { model?: string; cpu?: string; cores?: number; memoryGB?: number; os?: string; metal?: string };
  downloadSeconds?: number;
  loadMs?: number;
  firstLine?: { firstAudioMs: number; synthMs: number; coldStartToFirstAudioMs: number } | null;
  warm?: { loadMs?: number; firstAudioMs?: number; x?: number };
  lines?: BenchLine[];
  linesTotal?: number;
  aggregateX?: number;
  p50X?: number;
  p10X?: number;
  minX?: number;
  audioSeconds?: number;
  memoryMB?: { before: number; loaded: number; maxWhileRendering: number; afterUnload: number; residentPeak: number };
  problems?: string[];
}

export interface EngineSummary {
  engine: string;
  title: string;
  ok: boolean;
  report?: BenchReport;
  exitCode?: number;
  /** Mean word error rate over the lines with a transcript, by sample and overall. */
  wer?: { all: number; bySample: Record<string, number>; checked: number; worst: { id: string; wer: number; heard: string }[] };
}

interface FixtureLine {
  id: string;
  plain: string;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (x: number | undefined, digits = 0): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(digits) : '–');
const pct = (x: number | undefined): string => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '–');

/** WER per line from `<dir>/<engine>/<line id>.txt` against the spoken text. */
export function werFor(report: BenchReport, fixtures: FixtureLine[], transcript: (id: string) => string | undefined): EngineSummary['wer'] {
  const byId = new Map(fixtures.map((l) => [l.id, l.plain]));
  const rows: { id: string; sample: string; wer: number; heard: string }[] = [];
  for (const line of report.lines ?? []) {
    const heard = transcript(line.id);
    const spoken = byId.get(line.id);
    if (heard === undefined || spoken === undefined) continue;
    rows.push({ id: line.id, sample: line.sample, wer: wordErrorRate(spoken, heard), heard: heard.trim() });
  }
  if (rows.length === 0) return undefined;
  const bySample: Record<string, number> = {};
  for (const s of new Set(rows.map((r) => r.sample))) bySample[s] = mean(rows.filter((r) => r.sample === s).map((r) => r.wer));
  const worst = [...rows].sort((a, b) => b.wer - a.wer).slice(0, 3).filter((r) => r.wer > 0.2).map(({ id, wer, heard }) => ({ id, wer, heard }));
  return { all: mean(rows.map((r) => r.wer)), bySample, checked: rows.length, worst };
}

export function markdown(engines: EngineSummary[], kokoro?: { p50x?: number; loadMs?: number; firstAudioMs?: number; route?: string; memoryMB?: { loaded?: number } }): string {
  const dev = engines.find((e) => e.report?.device)?.report?.device;
  const out = [
    '### Expressive voices on the CI Mac',
    '',
    dev ? `Runner: ${dev.model ?? '?'} · ${dev.cpu ?? '?'} · ${dev.cores ?? '?'} cores · ${dev.memoryGB ?? '?'} GB · Metal: ${dev.metal ?? '?'} · ${dev.os ?? ''}` : '',
    '',
    '| Engine | Model | Load cold / warm | First audio (line 1) | Speed: all / median / slowest 10% | Memory loaded / max | ASR WER (narration / dialogue / long) | Lines |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const e of engines) {
    const r = e.report;
    if (!r || !e.ok) {
      out.push(`| ${e.title} | – | **failed**${e.exitCode !== undefined ? ` (exit ${e.exitCode})` : ''} | – | – | – | – | ${r?.problems?.slice(0, 2).join('; ') ?? 'no report'} |`);
      continue;
    }
    const w = e.wer;
    out.push(
      `| ${r.title} | ${f(r.modelBytes / 1e6)} MB | ${f(r.loadMs)} / ${f(r.warm?.loadMs)} ms | ${f(r.firstLine?.firstAudioMs)} ms (cold start ${f(r.firstLine?.coldStartToFirstAudioMs)} ms) | ` +
        `**${f(r.aggregateX, 2)}×** / ${f(r.p50X, 2)}× / ${f(r.p10X, 2)}× | ${f(r.memoryMB?.loaded)} / ${f(r.memoryMB?.maxWhileRendering)} MB | ` +
        `${w ? `${pct(w.bySample.narration)} / ${pct(w.bySample.dialogue)} / ${pct(w.bySample.long)}` : 'not run'} | ${r.lines?.length ?? 0}/${r.linesTotal ?? '?'} |`,
    );
  }
  if (kokoro) {
    out.push(`| Kokoro (bundled, ${kokoro.route ?? '?'}) | 93 MB | ${f(kokoro.loadMs)} ms | ${f(kokoro.firstAudioMs)} ms | median ${f(kokoro.p50x, 2)}× | ${f(kokoro.memoryMB?.loaded)} MB | (voice-quality job) | – |`);
  }
  out.push('', '× = seconds of audio per second of synthesis (above 1 keeps up with playback). The runner is a VM without the Neural Engine: expect the iPhone to differ (docs/expressive-tts.md).');
  for (const e of engines) {
    const probs = e.report?.problems ?? [];
    const worst = e.wer?.worst ?? [];
    if (probs.length === 0 && worst.length === 0) continue;
    out.push('', `**${e.title}**`);
    for (const p of probs.slice(0, 8)) out.push(`- ${p}`);
    for (const w of worst) out.push(`- ASR ${w.id}: WER ${pct(w.wer)}, heard “${w.heard.slice(0, 140)}”`);
  }
  return `${out.join('\n')}\n`;
}

if (import.meta.main) {
  const [dir, fixturesPath, kokoroPath] = process.argv.slice(2);
  if (!dir || !fixturesPath) {
    console.error('usage: node ci/expressive-bench-report.ts <bench dir> <fixtures.json> [kokoro report.json]');
    process.exit(2);
  }
  const fixtures = (JSON.parse(readFileSync(fixturesPath, 'utf8')) as { lines: FixtureLine[] }).lines;
  const engines: EngineSummary[] = [];
  const names = new Set<string>();
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (existsSync(path.join(dir, name, 'report.json'))) names.add(name);
    const m = /^(.+)\.(log|exit)$/.exec(name);
    if (m?.[1]) names.add(m[1]);
  }
  for (const engine of [...names].sort()) {
    const reportPath = path.join(dir, engine, 'report.json');
    const exitPath = path.join(dir, `${engine}.exit`);
    const report = existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, 'utf8')) as BenchReport) : undefined;
    const exitCode = existsSync(exitPath) ? Number(readFileSync(exitPath, 'utf8').trim()) : undefined;
    const transcript = (id: string): string | undefined => {
      const p = path.join(dir, engine, `${id}.txt`);
      return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
    };
    const ok = !!report && (report.lines?.length ?? 0) > 0;
    engines.push({ engine, title: report?.title ?? engine, ok, report, exitCode, wer: report ? werFor(report, fixtures, transcript) : undefined });
  }
  const kokoro = kokoroPath && existsSync(kokoroPath) ? (JSON.parse(readFileSync(kokoroPath, 'utf8')) as Parameters<typeof markdown>[1]) : undefined;
  const md = markdown(engines, kokoro);
  writeFileSync(path.join(dir, 'summary.md'), md);
  writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify({ engines: engines.map(({ report: _r, ...rest }) => ({ ...rest, aggregateX: _r?.aggregateX, p50X: _r?.p50X, p10X: _r?.p10X, loadMs: _r?.loadMs, firstLine: _r?.firstLine, memoryMB: _r?.memoryMB })) }, null, 2)}\n`);
  console.log(md);
  process.exit(engines.length > 0 && engines.every((e) => e.ok) ? 0 : 1);
}
