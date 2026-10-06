/**
 * Assertions on the simulator voice self-test report (ci/ios-voice-selftest.sh → Documents/voice-selftest.json,
 * written by src/ui/native/voice-selftest.ts + NarrationSelfTest in VoiceLab.swift).
 *
 *   kokoro  Kokoro spoke (Apple may cover the first sentences while the model loads), audio was actually
 *           rendered, the chapter ended, and every sentence event mapped onto the DOM (highlight).
 *   slow    with Kokoro slowed down, the Apple voice took over, and Kokoro came back after the delay lifted.
 *   fail    with Kokoro failing, every sentence was still spoken (Apple) and the chapter ended.
 *   car     Now Playing fields, remote commands (chapters / ±15 s / scrubbing / play-pause), the chapter
 *           change by itself with little silence, and a chapter prepared for the drive playing from its
 *           file (src/ui/native/voice-selftest-car.ts; warnings don't fail).
 *
 * Usage: node ci/check-voice-selftest.ts <report.json>
 */
import { appendFileSync, readFileSync } from 'node:fs';

interface PhaseEvent {
  segment?: number;
  source?: string;
  highlighted: string;
  expected: string;
  t: number;
}

interface Phase {
  name: string;
  events: PhaseEvent[];
  sources: Record<string, number>;
  highlightMatches: number;
  ended: boolean;
  sentences: number;
  error?: string;
}

export interface CarReport {
  steps: Record<string, { ok: boolean; detail?: string }>;
  gapsMs: number[];
  warnings: string[];
}

/** Car steps that must pass (voice-selftest-car.ts). */
export const CAR_STEPS = ['buttons-chapters', 'now-playing', 'auto-advance', 'next', 'previous', 'toggle', 'skip', 'scrub', 'buttons-skip', 'prepare', 'prepared-plays'] as const;

export interface SelfTestReport {
  ui?: { sentences: number; phases: Phase[]; car?: CarReport };
  output?: { renderedFrames: number; audibleFrames: number; maxRMS: number; manual: boolean };
  lab?: { stats?: { totalSentences?: number; aggregateX?: number; firstAudio?: { ms: number; source: string }[] }; session?: Record<string, unknown> };
}

export function checkSelfTest(r: SelfTestReport): { problems: string[]; summary: string[] } {
  const problems: string[] = [];
  const summary: string[] = [];
  const phases = r.ui?.phases ?? [];
  const phase = (n: string): Phase | undefined => phases.find((p) => p.name === n);
  const describe = (p: Phase): string =>
    `${p.name}: ${p.events.length} sentences (kokoro ${p.sources.kokoro ?? 0}, apple ${p.sources.apple ?? 0}), highlight ${p.highlightMatches}/${p.events.length}, ${p.ended ? 'ended' : 'NOT ended'}${p.error ? `, error ${p.error}` : ''}`;
  for (const name of ['kokoro', 'slow', 'fail']) {
    const p = phase(name);
    if (!p) {
      problems.push(`phase "${name}" missing`);
      continue;
    }
    summary.push(describe(p));
    if (p.error) problems.push(`${name}: ${p.error}`);
    if (!p.ended) problems.push(`${name}: the chapter didn't finish`);
    if (p.events.length < p.sentences) problems.push(`${name}: only ${p.events.length} of ${p.sentences} sentences were spoken`);
    if (p.highlightMatches < p.events.length) problems.push(`${name}: ${p.events.length - p.highlightMatches} sentence(s) didn't map onto the reader DOM (highlight)`);
  }
  const k = phase('kokoro');
  if (k && (k.sources.kokoro ?? 0) < 1) problems.push('kokoro: Kokoro never spoke');
  const s = phase('slow');
  if (s) {
    const firstApple = s.events.findIndex((e) => e.source === 'apple');
    const backToKokoro = firstApple >= 0 && s.events.slice(firstApple).some((e) => e.source === 'kokoro');
    if (firstApple < 0) problems.push('slow: the Apple voice never took over from a slow Kokoro');
    else if (!backToKokoro) problems.push('slow: Kokoro never took over again after the delay was lifted');
  }
  const f = phase('fail');
  if (f && (f.sources.kokoro ?? 0) > 0) problems.push('fail: Kokoro "spoke" although every synthesis failed');
  const car = r.ui?.car;
  if (!car) {
    problems.push('car phase missing');
  } else {
    const failed = CAR_STEPS.filter((s) => car.steps[s]?.ok !== true);
    const gap = car.gapsMs.length > 0 ? `, chapter change ${car.gapsMs.map((g) => `${Math.round(g)} ms`).join(' / ')}` : '';
    summary.push(`car: ${CAR_STEPS.length - failed.length}/${CAR_STEPS.length} steps${gap}${car.warnings.length > 0 ? ` (warnings: ${car.warnings.join('; ')})` : ''}`);
    for (const s of failed) problems.push(`car: ${s} failed${car.steps[s]?.detail ? ` (${car.steps[s]?.detail ?? ''})` : ''}`);
    for (const [name, st] of Object.entries(car.steps)) {
      if (!st.ok && !(CAR_STEPS as readonly string[]).includes(name)) problems.push(`car: ${name}${st.detail ? ` (${st.detail})` : ''}`);
    }
  }
  const out = r.output;
  if (out) {
    summary.push(`audio rendered: ${(out.renderedFrames / 24000).toFixed(1)} s, audible ${(out.audibleFrames / 24000).toFixed(1)} s, max RMS ${out.maxRMS.toFixed(3)} (${out.manual ? 'headless' : 'device'} output)`);
    if (out.manual && out.audibleFrames < 24000) problems.push('Kokoro produced less than 1 s of audible audio');
  } else {
    problems.push('native output counters missing');
  }
  const st = r.lab?.stats;
  if (st) summary.push(`synthesis: ${st.totalSentences ?? 0} sentences, ${st.aggregateX ?? 0}× real time; first audio ${(st.firstAudio ?? []).map((x) => `${Math.round(x.ms)} ms (${x.source})`).join(', ')}`);
  return { problems, summary };
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node ci/check-voice-selftest.ts <report.json>');
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(file, 'utf8')) as SelfTestReport;
  const { problems, summary } = checkSelfTest(report);
  for (const l of summary) console.log(l);
  for (const p of problems) console.log(`::error::voice self-test: ${p}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Voice self-test (simulator)\n\n${summary.map((l) => `- ${l}`).join('\n')}\n${problems.map((p) => `- ❌ ${p}`).join('\n')}\n`);
  }
  process.exit(problems.length > 0 ? 1 : 0);
}
