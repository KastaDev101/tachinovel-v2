/**
 * Voice self-test in the iOS Simulator (CI, Debug builds only; ci/ios-voice-selftest.sh launches the app
 * with `-tachiVoiceSelfTest 1`). It exercises the real Listen path end to end:
 *
 *   reader-like DOM → speech script (speech-dom.ts) → Narration.play → native HybridSpeechEngine
 *   (Kokoro from the bundled model, Apple fallback; headless output) → progress events → highlight range
 *
 * Phases:
 *   kokoro    normal playback: Kokoro must speak (the first sentences may be Apple while the model loads),
 *   slow      Kokoro slowed down by an injected delay → the Apple voice takes over; the delay is lifted
 *             mid-chapter → Kokoro must take over again,
 *   fail      Kokoro synthesis fails → every sentence still gets spoken (Apple),
 *   car       Now Playing, remote commands, chapter changes and prepared audio (voice-selftest-car.ts).
 * Every progress event's sentence must map onto the DOM (the highlight). The findings go to native
 * (Narration.selfTestReport), which adds its own counters and writes Documents/voice-selftest.json.
 */
import { paintRange } from './highlight.ts';
import { Narration, type NarrationProgress, type NarrationState } from './narration.ts';
import { domSpeechScript, rangeForSentence } from './speech-dom.ts';
import { runCarPhase } from './voice-selftest-car.ts';

const PARAGRAPHS = [
  'Chapter 12 - The Old Bridge',
  'The rain had stopped by the time Sunny reached the old bridge. He counted the lanterns, all 304 of them, and wondered who had lit them.',
  '“Wait,” Nephis said quietly. “Are you sure this is the way?”',
  'He didn’t answer. The river answered for him, loud and cold beneath the stones.',
  'Somewhere far behind them, a bell rang three times. They walked on, and the city slowly fell asleep.',
  'By midnight the fog had come back, thick and grey, and the lanterns burned like small suns inside it.',
];

interface PhaseEvent {
  segment?: number;
  source?: string;
  paragraph: number;
  highlighted: string;
  expected: string;
  t: number;
}

interface PhaseResult {
  name: string;
  events: PhaseEvent[];
  sources: Record<string, number>;
  highlightMatches: number;
  ended: boolean;
  sentences: number;
  error?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runVoiceSelfTest(): Promise<void> {
  const body = document.createElement('div');
  body.className = 'rd-body tn-selftest';
  body.setAttribute('aria-hidden', 'true');
  body.style.cssText = 'position:fixed;left:-10000px;top:0;width:360px';
  body.innerHTML = PARAGRAPHS.map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('');
  document.body.append(body);
  const dom = domSpeechScript(body, { title: 'The Old Bridge', lexicons: [{ schemaVersion: 1, entries: [{ match: 'Nephis', ipa: 'nˈɛfɪs' }] }] });
  const expectedById = new Map(dom.script.items.map((it) => [it.id, (dom.blocks[it.block]?.text ?? '').slice(it.start, it.end)]));

  let phase: PhaseResult | null = null;
  let state: NarrationState = { status: 'idle' };
  const t0 = Date.now();
  await Narration.addListener('progress', (p: NarrationProgress) => {
    if (!phase || p.engine !== 'speech' || p.charStart !== undefined) return; // word ranges are not sentence starts
    const range = rangeForSentence(dom, p);
    paintRange(range, null);
    const highlighted = range?.toString() ?? '';
    const expected = p.segment !== undefined ? (expectedById.get(p.segment) ?? '') : '';
    phase.events.push({ ...(p.segment !== undefined ? { segment: p.segment } : {}), ...(p.source ? { source: p.source } : {}), paragraph: p.paragraph, highlighted, expected, t: Date.now() - t0 });
    if (p.source) phase.sources[p.source] = (phase.sources[p.source] ?? 0) + 1;
    if (highlighted && highlighted === expected) phase.highlightMatches++;
  });
  await Narration.addListener('state', (s: NarrationState) => {
    state = { ...state, ...s };
  });

  const play = async (name: string, timeoutMs: number, during?: (p: PhaseResult) => Promise<void>): Promise<PhaseResult> => {
    const result: PhaseResult = { name, events: [], sources: {}, highlightMatches: 0, ended: false, sentences: dom.script.items.length };
    phase = result;
    state = { status: 'loading' };
    try {
      await Narration.play({
        pluginId: 'voice-selftest',
        novelPath: 'selftest',
        chapterPath: `selftest/${name}`,
        novelName: 'Voice self-test',
        chapterName: name,
        script: dom.script,
        start: { paragraph: 0 },
        autoContinue: false,
        engine: 'speech',
      });
      const deadline = Date.now() + timeoutMs;
      const watcher = during ? during(result) : Promise.resolve();
      while (Date.now() < deadline && state.status !== 'ended' && state.status !== 'error') await sleep(250);
      await watcher;
      result.ended = state.status === 'ended';
      if (state.status === 'error') result.error = state.error ?? 'error';
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    await Narration.stop().catch(() => undefined);
    phase = null;
    await sleep(500);
    return result;
  };

  const phases: PhaseResult[] = [];
  // Warm the model first (the first load on the simulator compiles it; not part of the measurements).
  await Narration.sampleVoice({ voice: 'af_heart', text: 'Ready.' }).catch(() => undefined);
  await Narration.stopSample().catch(() => undefined);

  phases.push(await play('kokoro', 240_000));

  await Narration.setVoiceLab({ inject: { delayMs: 8000 } }).catch(() => undefined);
  phases.push(
    await play('slow', 300_000, async (r) => {
      // Lift the delay once Apple has taken over a couple of sentences: Kokoro must come back.
      const until = Date.now() + 200_000;
      while (Date.now() < until && (r.sources.apple ?? 0) < 2) await sleep(250);
      await Narration.setVoiceLab({ inject: { delayMs: 0 } }).catch(() => undefined);
    }),
  );

  await Narration.setVoiceLab({ inject: { fail: true } }).catch(() => undefined);
  phases.push(await play('fail', 240_000));
  await Narration.setVoiceLab({ inject: { delayMs: 0, fail: false } }).catch(() => undefined);

  // The car: Now Playing, remote commands, chapter changes, prepared audio.
  state = { status: 'idle' };
  const car = await runCarPhase(() => state).catch((err: unknown) => ({ steps: { car: { ok: false, detail: String(err) } }, gapsMs: [], warnings: [] }));

  const report = { startedAt: new Date(t0).toISOString(), sentences: dom.script.items.length, phases, car };
  await Narration.selfTestReport({ json: JSON.stringify(report) }).catch((err: unknown) => console.error('self-test report failed', err));
  document.documentElement.dataset.voiceSelftest = 'done';
}
