/**
 * Settings › Voices › Voice test (Kasta, 2026-10-08: "an easily understandable testing section … so I can send you
 * back the report"). One button reads a fixed passage aloud with the voice chosen for Listen, through the real Listen
 * path (speech script → Narration.play → HybridSpeechEngine → the voice, its finishing chain, playback), then shows
 * the result in plain words and a "Copy report" with everything a developer needs:
 *   - start: tap → her first word;
 *   - breaks: times the read had to wait for the voice, and for how long (the goal is none: an audiobook never stops);
 *   - other voice: sentences another voice read (the goal is none);
 *   - speed: × real time of the voice's work (the goal is 8×), stage by stage for Nephis;
 *   - phone heat at the start and the end, crashes, memory;
 *   - the listener's own notes (noises, wrong words), typed into the report;
 *   - a recording of what played (after the volume stage and limiter), shared to the PC to compare with its renders.
 * The passage is long paragraphs (Pocket's ~50-token seams), dialogue, a pause after "…", a system line and numbers.
 */
import { ExpressiveVoice } from './expressive-lab.ts';
import { Narration, type NarrationState } from './narration.ts';
import { domSpeechScript } from './speech-dom.ts';
import { esc, panel } from './voices-ui.ts';

type Obj = Record<string, unknown>;

export const TEST_PASSAGE = [
  'Chapter 7 - The Lantern Road',
  'The road out of the valley climbed in long, patient switchbacks, and by the time the last farmhouse had fallen behind them the sky had turned the colour of old pewter. Sunny walked a few steps ahead, as he always did, testing the frozen ground with the butt of his spear before trusting it with his weight. Behind him, Nephis carried the lantern low, so that its light fell on the path and not on their faces.',
  '“How far to the pass?” she asked.',
  '“Four hours, if the snow holds off. Six, if it doesn’t.” He glanced back at her. “You should rest when we reach the shrine. There are 312 steps up to it, and I’m not carrying you.”',
  'She almost smiled. Almost.',
  'They reached the shrine just after midnight. It was smaller than he remembered, a low stone hut with a roof of black slate, half buried in drifts that the wind had sculpted into strange, soft shapes. Inside, someone had left a bundle of dry wood and a clay jar of oil, as if they had known travellers would come. Sunny lit a fire while Nephis sat by the door and watched the dark…',
  'Then the ground trembled.',
  '[System: A Nightmare Creature is approaching.]',
  'Nephis rose without a word, and the lantern’s small flame steadied in her hand. Outside, far below them on the road they had just climbed, something enormous was moving through the snow, slowly, deliberately, the way a tide comes in.',
];

/** The result in plain words: each line is good (✓) or worth a look (⚠). */
export function summarize(r: Obj): { ok: boolean; text: string }[] {
  const listen = (r.listen as Obj | undefined) ?? {};
  const flow = (r.flow as Obj | undefined) ?? {};
  const breaks = Number(listen.breaks ?? 0);
  const breakSeconds = Number(listen.breakSeconds ?? 0);
  const other = Number(listen.otherVoiceSentences ?? 0);
  const start = Number(r.firstAudioMs ?? NaN);
  const per = (flow.perAudioSecond as Obj | undefined) ?? {};
  const call = Number(per.call ?? 0);
  const speed = call > 0 ? 1 / call : Number(flow.renderX ?? 0);
  const crashes = Number(r.crashesDuringTest ?? 0);
  const lines: { ok: boolean; text: string }[] = [
    { ok: breaks === 0, text: breaks === 0 ? 'No breaks: it never stopped to wait for the voice.' : `${breaks} break${breaks === 1 ? '' : 's'} (${breakSeconds.toFixed(1)} s of waiting).` },
    { ok: other === 0, text: other === 0 ? 'One voice from start to end.' : `Another voice read ${other} sentence${other === 1 ? '' : 's'}.` },
  ];
  if (speed > 0) lines.push({ ok: speed >= 8, text: `Speed: ${speed.toFixed(1)}× real time (goal 8×).` });
  if (Number.isFinite(start)) lines.push({ ok: start <= 2000, text: `Started ${(start / 1000).toFixed(1)} s after the tap.` });
  lines.push({ ok: crashes === 0, text: crashes === 0 ? 'No crashes.' : `${crashes} crash${crashes === 1 ? '' : 'es'} during the test.` });
  const word = (v: unknown): string => (typeof v === 'string' ? v : '?');
  const heat = `${word(r.thermalStart)} → ${word(r.thermalEnd)}`;
  lines.push({ ok: r.thermalEnd === 'nominal' || r.thermalEnd === 'fair', text: `Phone heat: ${heat}.` });
  if (r.ended !== true) lines.push({ ok: false, text: 'The test was stopped before the end.' });
  return lines;
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** Settings › Voices › Voice test. */
export function openVoiceTest(): void {
  const p = panel('Voice test', 'voice-test');
  let running = false;
  let report: Obj | null = null;
  let status = '';
  let notes = '';
  let recorded = false;

  const render = (): void => {
    const result = report
      ? `<div class="sec">Result</div><div class="card" data-testid="voice-test-result">${summarize(report)
          .map((l) => `<div class="row"><span aria-hidden="true">${l.ok ? '✓' : '⚠'}</span><div class="main">${esc(l.text)}</div></div>`)
          .join('')}</div>
         <div class="sec">What did you hear?</div>
         <div class="card" style="padding:4px 14px 14px"><textarea data-f="notes" placeholder="Noises, wrong words, odd pauses, anything off (optional)">${esc(notes)}</textarea></div>
         <button type="button" class="btn" data-act="copy">Copy report</button>
         ${recorded ? '<button type="button" class="btn alt" data-act="share">Share the recording</button>' : ''}
         <p class="note">Paste the report to your developer: it has every number behind these lines.${recorded ? ' The recording is the test exactly as your phone played it: Share › Save to Files › iCloud Drive.' : ''}</p>`
      : '';
    p.body.innerHTML = `
      <p class="note">Reads a 2-minute test passage aloud with the voice you listen with, exactly like Listen does, then says how it went: breaks, voice switches, speed and phone heat.</p>
      <button type="button" class="btn" data-act="${running ? 'stop' : 'run'}" data-testid="voice-test-run">${running ? 'Stop the test' : report ? 'Run it again' : 'Start the test'}</button>
      ${status ? `<p class="note" data-testid="voice-test-status">${esc(status)}</p>` : ''}
      ${result}`;
  };

  const run = async (): Promise<void> => {
    running = true;
    report = null;
    status = 'Starting… listen for anything that sounds off.';
    render();
    const body = document.createElement('div');
    body.className = 'rd-body tn-voicetest';
    body.setAttribute('aria-hidden', 'true');
    body.style.cssText = 'position:fixed;left:-10000px;top:0;width:360px';
    body.innerHTML = TEST_PASSAGE.map((t) => `<p>${esc(t)}</p>`).join('');
    document.body.append(body);
    const dom = domSpeechScript(body, { title: 'The Lantern Road', lexicons: [] });
    body.remove();
    let state: NarrationState = { status: 'loading' };
    let firstAudioMs: number | null = null;
    const t0 = Date.now();
    const handles = [
      await Narration.addListener('state', (s: NarrationState) => {
        state = { ...state, ...s };
      }),
      await Narration.addListener('progress', () => {
        if (firstAudioMs === null) {
          firstAudioMs = Date.now() - t0;
          status = 'Playing. Listen for noises, cut words or odd pauses.';
          render();
        }
      }),
    ];
    const before = await ExpressiveVoice.resetStats().catch((): Obj => ({}));
    const crashesBefore = Number(((before.crashes as Obj | undefined) ?? {}).total ?? 0);
    const thermalStart = ((before.device as Obj | undefined) ?? {}).thermal ?? null;
    const settings = await Narration.voiceSettings().catch(() => null);
    recorded = false;
    await ExpressiveVoice.recordStart().catch(() => undefined);
    try {
      await Narration.play({
        pluginId: 'voice-lab',
        novelPath: 'voice-test',
        chapterPath: 'voice-test/lantern-road',
        novelName: 'Voice test',
        chapterName: 'The Lantern Road',
        script: dom.script,
        start: { paragraph: 0 },
        autoContinue: false,
        engine: 'speech',
      });
      const deadline = Date.now() + 6 * 60_000;
      while (running && Date.now() < deadline && state.status !== 'ended' && state.status !== 'error') await sleep(300);
    } catch (err) {
      status = `Couldn't start: ${err instanceof Error ? err.message : String(err)}`;
    }
    const ended = state.status === 'ended';
    if (!ended) await Narration.stop().catch(() => undefined);
    for (const h of handles) void h.remove();
    const rec = await ExpressiveVoice.recordStop().catch(() => ({ saved: false, bytes: 0 }));
    recorded = rec.saved;
    const after = await ExpressiveVoice.status().catch((): Obj => ({}));
    const crashesAfter = Number(((after.crashes as Obj | undefined) ?? {}).total ?? 0);
    report = {
      kind: 'voice-test',
      at: new Date().toISOString(),
      app: after.app ?? null,
      device: after.device ?? null,
      delivery: (settings as { delivery?: unknown } | null)?.delivery ?? null,
      ended,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      firstAudioMs,
      sentences: dom.script.items.length,
      thermalStart,
      thermalEnd: ((after.device as Obj | undefined) ?? {}).thermal ?? null,
      crashesDuringTest: crashesAfter - crashesBefore,
      lastCrash: crashesAfter > crashesBefore ? after.crashes : null,
      flow: ((after.flow) ?? null),
      listen: (((after.flow as Obj | undefined) ?? {}).listen) ?? null,
      error: state.status === 'error' ? (state.error ?? 'error') : null,
      recordingBytes: rec.bytes,
    };
    running = false;
    status = ended ? 'Done.' : 'Stopped.';
    render();
  };

  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'run' && !running) void run();
    if (el.dataset.act === 'stop') {
      running = false;
      void Narration.stop().catch(() => undefined);
    }
    if (el.dataset.act === 'share') {
      void ExpressiveVoice.shareRecording().catch((err: unknown) => (el.textContent = err instanceof Error ? err.message : 'Couldn’t share'));
    }
    if (el.dataset.act === 'copy' && report) {
      const text = JSON.stringify({ ...report, notes: notes.trim() || null }, null, 2);
      void navigator.clipboard
        .writeText(text)
        .then(() => (el.textContent = 'Copied'))
        .catch(() => (el.textContent = 'Copy failed'));
    }
  });
  p.body.addEventListener('input', (ev) => {
    const el = ev.target as HTMLTextAreaElement;
    if (el.dataset.f === 'notes') notes = el.value;
  });
  render();
}
