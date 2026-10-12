/**
 * Settings › Voices › Voice test: the one page for testing Nephis (Kasta, 2026-10-12: "everything in one page …
 * run the test, then copy report. Something super simple"). No hidden taps: the Voice Lab is for developers only.
 *   - Top (personal flavor): which Nephis pack is installed, whether it has her studio, whether the studio is on, and
 *     the studio switch (ExpressiveVoice.studioEnable) when the pack has one.
 *   - Run the test: her studio's speed test (ExpressiveVoice.studioTest, when the pack may have a studio), then a
 *     fixed passage read aloud through the real Listen path (speech script → Narration.play → HybridSpeechEngine →
 *     the voice, its finishing chain, playback).
 *   - The result in plain words, then one "Copy report" with everything a developer needs (combinedReport):
 *     - studio: × real time against live reading's 1.5×, which chip runs each part, heat before → after;
 *     - start: tap → her first word;
 *     - breaks: times the read had to wait for the voice, and for how long (the goal is none: an audiobook never stops);
 *     - other voice: sentences another voice read (the goal is none);
 *     - speed: × real time of the voice's work (the goal is 8×), stage by stage for Nephis;
 *     - phone heat at the start and the end, crashes, memory; the app, the device and the pack;
 *     - the listener's own notes (noises, wrong words), typed into the report;
 *     - a recording of what played (after the volume stage and limiter), shared to the PC to compare with its renders.
 * The passage is long paragraphs (Pocket's ~50-token seams), dialogue, a pause after "…", a system line and numbers.
 */
import { callCore } from '../capacitor-client.ts';
import { ExpressiveVoice } from './expressive-lab.ts';
import { Narration, type NarrationState } from './narration.ts';
import { domSpeechScript } from './speech-dom.ts';
import { esc, panel, toast } from './voices-ui.ts';

type Obj = Record<string, unknown>;
type Line = { ok: boolean; text: string };

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
export function summarize(r: Obj): Line[] {
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
  const lines: Line[] = [
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

/**
 * What native says about the installed Nephis pack (ExpressiveVoice.status().nephisPack): pack.json's name and date,
 * whether it has her studio, whether the studio is on. Undefined in builds that don't report it; null: no pack.
 */
export interface PackInfo {
  name?: unknown;
  made?: unknown;
  studio?: unknown;
  studioOn?: unknown;
}

/** Her studio as far as this page knows (null: unknown). */
export interface StudioKnown {
  has: boolean | null;
  on: boolean | null;
}

/** Native's word wins; else what the last test or switch on this phone found. */
export function studioKnown(pack: unknown, remembered: StudioKnown): StudioKnown {
  if (pack === null) return { has: false, on: null };
  const p = (pack && typeof pack === 'object' ? pack : {}) as PackInfo;
  return { has: typeof p.studio === 'boolean' ? p.studio : remembered.has, on: typeof p.studioOn === 'boolean' ? p.studioOn : remembered.on };
}

/** The status block at the top, one plain line each. */
export function statusLines(pack: unknown, k: StudioKnown): string[] {
  const p = pack && typeof pack === 'object' ? (pack as PackInfo) : null;
  const made = typeof p?.made === 'string' && p.made ? ` (made ${p.made})` : '';
  const lines = [
    pack === undefined
      ? 'Nephis pack: this app version doesn’t say which.'
      : p
        ? `Nephis pack: ${typeof p.name === 'string' && p.name ? p.name : 'unnamed'}${made}.`
        : 'Nephis pack: none installed (she reads with the voice the app came with).',
    k.has === null ? 'Her studio: the test checks whether this pack has one.' : k.has ? 'Her studio: in this pack.' : 'Her studio: not in this pack.',
  ];
  if (k.has) lines.push(k.on === null ? 'Studio: on or off shows after the test.' : k.on ? 'Studio: on (she reads at 44.1 kHz).' : 'Studio: off.');
  return lines;
}

/** Live reading needs the studio at least this fast (× real time). */
export const LIVE_X = 1.5;
const HEAT = ['nominal', 'fair', 'serious', 'critical'];
/** Native's thermal state: a number (ProcessInfo.ThermalState) or already a word. */
const heat = (v: unknown): string => (typeof v === 'number' ? (HEAT[v] ?? '?') : typeof v === 'string' ? v : '?');
const CHIP: Record<string, string> = { ane: 'Neural Engine', gpu: 'GPU', cpu: 'CPU' };

/** Which chip runs each part, from Core ML's op counts like {"vocoder.ane": 120, "vocoder.cpu": 4}. */
export function chipSummary(placement: unknown): string {
  const parts = new Map<string, [string, number][]>();
  for (const [key, n] of Object.entries(placement && typeof placement === 'object' ? placement : {})) {
    const [part = key, chip = 'other'] = key.split('.');
    if (typeof n === 'number' && n > 0) parts.set(part, [...(parts.get(part) ?? []), [chip, n]]);
  }
  return [...parts]
    .map(([part, chips]) => {
      const total = chips.reduce((a, [, n]) => a + n, 0);
      const shares = chips.sort((a, b) => b[1] - a[1]).map(([c, n]) => `${Math.round((n / total) * 100)}% ${CHIP[c] ?? c}`);
      return `${part} ${shares.join(', ')}`;
    })
    .join('; ');
}

/** The studio speed test (ExpressiveVoice.studioTest) in plain words. */
export function studioLines(r: Obj): Line[] {
  if (r.ran !== true) {
    const why = typeof r.error === 'string' ? r.error : 'not available';
    return [/has no studio/.test(why) ? { ok: true, text: 'Studio: this pack has none, nothing to time.' } : { ok: false, text: `Studio test failed: ${why}` }];
  }
  const x = Number(r.timesRealTime);
  const fast = x >= LIVE_X;
  const lines: Line[] = [
    { ok: fast, text: `Studio: ${Number.isFinite(x) ? x.toFixed(1) : '?'}× real time — ${fast ? 'fast enough for live reading.' : `too slow for live reading (needs ${LIVE_X}×).`}` },
  ];
  if (r.bypassed === true) lines.push({ ok: false, text: 'The phone was too hot, so the studio stepped aside.' });
  const chips = chipSummary(r.placement);
  if (chips) lines.push({ ok: true, text: `Chips: ${chips}.` });
  const after = heat(r.thermalAfter);
  lines.push({ ok: after === 'nominal' || after === 'fair', text: `Studio heat: ${heat(r.thermalBefore)} → ${after}.` });
  lines.push({ ok: true, text: r.enabled === true ? 'Studio is on for Nephis.' : 'Studio is off: Listen doesn’t use it.' });
  return lines;
}

/** The one report to paste: app, device and pack, the studio (state and test) and the listening test, with notes. */
export function combinedReport(o: { status: Obj; studio: StudioKnown; studioTest: Obj | null; voiceTest: Obj | null; notes: string; at?: string }): Obj {
  return {
    kind: 'nephis-test',
    at: o.at ?? new Date().toISOString(),
    app: o.status.app ?? null,
    device: o.status.device ?? null,
    pack: o.status.nephisPack === undefined ? 'not reported' : o.status.nephisPack,
    studio: { has: o.studio.has, on: o.studio.on, test: o.studioTest },
    voiceTest: o.voiceTest,
    notes: o.notes.trim() || null,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
const clock = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Her studio pieces exist in the personal flavor only (the store flavor's bundle compiles them out). */
const STUDIO = __FLAVOR__ === 'personal';
const KNOWN_KEY = 'tachinovel.voiceTest.studio';

function rememberedStudio(): StudioKnown {
  try {
    const o = JSON.parse(localStorage.getItem(KNOWN_KEY) ?? '{}') as Partial<StudioKnown>;
    return { has: typeof o.has === 'boolean' ? o.has : null, on: typeof o.on === 'boolean' ? o.on : null };
  } catch {
    return { has: null, on: null };
  }
}

function rememberStudio(k: StudioKnown): void {
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify(k));
  } catch {
    // Private mode or blocked storage: native is asked again next time.
  }
}

/** Clipboard first; else the share sheet (it has Copy), like Diagnostics. */
async function copyText(text: string): Promise<string> {
  try {
    await navigator.clipboard.writeText(text);
    return 'Copied';
  } catch {
    await callCore('native.share', { text });
    return 'Copy report';
  }
}

/** Settings › Voices › Voice test. */
export function openVoiceTest(): void {
  const p = panel('Voice test', 'voice-test');
  let running = false;
  let listening = false;
  let switching = false;
  let report: Obj | null = null;
  let studioTest: Obj | null = null;
  let status: Obj = {};
  let known = rememberedStudio();
  let progress = '';
  let notes = '';
  let recorded = false;

  const row = (l: Line): string => `<div class="row"><span aria-hidden="true">${l.ok ? '✓' : '⚠'}</span><div class="main">${esc(l.text)}</div></div>`;

  const render = (): void => {
    const nephis = STUDIO
      ? `<div class="sec">Nephis</div><div class="card" data-testid="voice-test-pack">${statusLines(status.nephisPack, known)
          .map((t) => `<div class="row"><div class="main">${esc(t)}</div></div>`)
          .join('')}${
          known.has
            ? `<label class="row"><div class="main"><b>Her studio</b><span class="sub">Her 44.1 kHz sound, from her next sentence</span></div><input type="checkbox" class="sw" data-act="studio" data-testid="voice-test-studio" aria-label="Her studio" ${known.on ? 'checked' : ''} ${running || switching ? 'disabled' : ''}></label>`
            : ''
        }</div>`
      : '';
    const lines = running ? [] : [...(studioTest ? studioLines(studioTest) : []), ...(report ? summarize(report) : [])];
    const result = lines.length
      ? `<div class="sec">Result</div><div class="card" data-testid="voice-test-result">${lines.map(row).join('')}</div>
         <div class="sec">What did you hear?</div>
         <div class="card" style="padding:4px 14px 14px"><textarea data-f="notes" aria-label="What did you hear?" placeholder="Noises, wrong words, odd pauses, anything off (optional)">${esc(notes)}</textarea></div>
         <button type="button" class="btn" data-act="copy" data-testid="voice-test-copy">Copy report</button>
         ${recorded ? '<button type="button" class="btn alt" data-act="share">Share the recording</button>' : ''}
         <p class="note">Paste the report to your developer: it has every number behind these lines.${recorded ? ' The recording is the test exactly as your phone played it: Share › Save to Files › iCloud Drive.' : ''}</p>`
      : '';
    p.body.innerHTML = `${nephis}
      <div class="sec">Test</div>
      <p class="note">${STUDIO ? 'Times her studio, then reads' : 'Reads'} a 2-minute passage aloud exactly like Listen does. Listen for noises, cut words or odd pauses.</p>
      <button type="button" class="btn" data-act="${running ? 'stop' : 'run'}" data-testid="voice-test-run">${running ? 'Stop the test' : lines.length ? 'Run it again' : 'Run the test'}</button>
      <p class="note" data-testid="voice-test-progress">${esc(progress)}</p>
      ${result}
      ${running ? '' : '<button type="button" class="link" style="margin-top:8px" data-act="long" data-testid="voice-test-long">Or: 15-minute test with your own chapter</button>'}`;
  };

  /** Only the progress line changes while a test runs (the buttons keep their place and focus). */
  const say = (text: string): void => {
    progress = text;
    const el = p.body.querySelector('[data-testid="voice-test-progress"]');
    if (el) el.textContent = text;
  };

  const loadStatus = async (): Promise<void> => {
    status = await ExpressiveVoice.status().catch((): Obj => status);
    known = studioKnown(status.nephisPack, known);
    if (!running) render();
  };

  /**
   * The long test (Kasta, 2026-10-09: "let it run 15 minutes and look for every possible issue"): records what plays
   * while you listen to any chapter the usual way, and every 15 s notes the phone's heat, the voice's speed and any
   * break or switch, so heat build-up, a dropout or a slowdown shows up with its time. Keep TachiNovel open.
   */
  const runLong = async (): Promise<void> => {
    running = true;
    report = null;
    studioTest = null;
    render();
    const timeline: Obj[] = [];
    const t0 = Date.now();
    const before = await ExpressiveVoice.resetStats().catch((): Obj => ({}));
    const crashesBefore = Number(((before.crashes as Obj | undefined) ?? {}).total ?? 0);
    const settings = await Narration.voiceSettings().catch(() => null);
    recorded = false;
    await ExpressiveVoice.recordStart().catch(() => undefined);
    const minutes = 15;
    while (running && Date.now() - t0 < minutes * 60_000) {
      const s = await ExpressiveVoice.status().catch((): Obj => ({}));
      const st = await Narration.state().catch(() => null);
      const flow = (s.flow as Obj | undefined) ?? {};
      const listen = (flow.listen as Obj | undefined) ?? {};
      timeline.push({
        t: Math.round((Date.now() - t0) / 1000),
        thermal: ((s.device as Obj | undefined) ?? {}).thermal ?? null,
        playing: st?.status ?? null,
        renderX: flow.renderX ?? null,
        breaks: listen.breaks ?? null,
        otherVoice: listen.otherVoiceSentences ?? null,
        audioSeconds: flow.audioSeconds ?? null,
      });
      say(`Recording: ${clock(minutes * 60_000 - (Date.now() - t0))} left. Play any chapter with Listen and keep TachiNovel open.`);
      for (let i = 0; i < 50 && running; i++) await sleep(300);
    }
    const rec = await ExpressiveVoice.recordStop().catch(() => ({ saved: false, bytes: 0 }));
    recorded = rec.saved;
    const after = await ExpressiveVoice.status().catch((): Obj => ({}));
    const crashesAfter = Number(((after.crashes as Obj | undefined) ?? {}).total ?? 0);
    report = {
      kind: 'voice-test-long',
      at: new Date().toISOString(),
      app: after.app ?? null,
      device: after.device ?? null,
      delivery: (settings as { delivery?: unknown } | null)?.delivery ?? null,
      ended: Date.now() - t0 >= minutes * 60_000,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      thermalStart: timeline[0]?.thermal ?? null,
      thermalEnd: ((after.device as Obj | undefined) ?? {}).thermal ?? null,
      crashesDuringTest: crashesAfter - crashesBefore,
      lastCrash: crashesAfter > crashesBefore ? after.crashes : null,
      flow: after.flow ?? null,
      listen: ((after.flow as Obj | undefined) ?? {}).listen ?? null,
      timeline,
      recordingBytes: rec.bytes,
    };
    running = false;
    progress = 'Done.';
    render();
  };

  /** Her studio's speed test; what it finds also says whether the pack has a studio and whether it is on. */
  const runStudio = async (): Promise<void> => {
    say('Running studio speed test… the first run prepares her models (up to a minute).');
    const r = await ExpressiveVoice.studioTest().catch((err: unknown): Obj => ({ ran: false, error: err instanceof Error ? err.message : String(err) }));
    studioTest = r;
    if (r.ran === true) known = { has: true, on: r.enabled === true };
    else if (typeof r.error === 'string' && /has no studio/.test(r.error)) known = { has: false, on: null };
    rememberStudio(known);
  };

  /** The listening test: the passage through the real Listen path. */
  const runListen = async (): Promise<void> => {
    say('Listening test: starting…');
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
        if (firstAudioMs === null) firstAudioMs = Date.now() - t0;
      }),
    ];
    const before = await ExpressiveVoice.resetStats().catch((): Obj => ({}));
    const crashesBefore = Number(((before.crashes as Obj | undefined) ?? {}).total ?? 0);
    const thermalStart = ((before.device as Obj | undefined) ?? {}).thermal ?? null;
    const settings = await Narration.voiceSettings().catch(() => null);
    recorded = false;
    await ExpressiveVoice.recordStart().catch(() => undefined);
    let failed = '';
    listening = true;
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
      while (running && Date.now() < deadline && state.status !== 'ended' && state.status !== 'error') {
        await sleep(300);
        if (firstAudioMs !== null) say(`Listening test: ${clock(Date.now() - t0 - firstAudioMs)} / 2:00`);
      }
    } catch (err) {
      failed = `Couldn't start: ${err instanceof Error ? err.message : String(err)}`;
    }
    listening = false;
    const ended = state.status === 'ended';
    if (!ended) await Narration.stop().catch(() => undefined);
    for (const h of handles) void h.remove();
    const rec = await ExpressiveVoice.recordStop().catch(() => ({ saved: false, bytes: 0 }));
    recorded = rec.saved;
    const after = await ExpressiveVoice.status().catch((): Obj => ({}));
    if (Object.keys(after).length) {
      status = after;
      known = studioKnown(after.nephisPack, known);
    }
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
      flow: after.flow ?? null,
      listen: ((after.flow as Obj | undefined) ?? {}).listen ?? null,
      error: state.status === 'error' ? (state.error ?? 'error') : null,
      recordingBytes: rec.bytes,
    };
    progress = failed || (ended ? 'Done. Copy the report below.' : 'Stopped.');
  };

  /** Run the test: the studio (unless native says the pack has none), then the listening test. */
  const run = async (): Promise<void> => {
    running = true;
    report = null;
    studioTest = null;
    progress = '';
    render();
    if (STUDIO && studioKnown(status.nephisPack, { has: null, on: null }).has !== false) await runStudio();
    if (running) await runListen();
    else progress = 'Stopped.';
    running = false;
    render();
  };

  const stop = (): void => {
    running = false;
    if (listening) void Narration.stop().catch(() => undefined);
  };
  // Leaving the page ends the test (the panel's Back closes it).
  p.root.addEventListener('click', (ev) => {
    if ((ev.target as Element).closest('[data-act="close"]')) stop();
  });

  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'run' && !running) void run();
    if (act === 'long' && !running) void runLong();
    if (act === 'stop') stop();
    if (act === 'share') {
      void ExpressiveVoice.shareRecording().catch((err: unknown) => (el.textContent = err instanceof Error ? err.message : 'Couldn’t share'));
    }
    if (act === 'copy') {
      const text = JSON.stringify(combinedReport({ status, studio: known, studioTest, voiceTest: report, notes }), null, 2);
      void copyText(text)
        .then((label) => (el.textContent = label))
        .catch(() => (el.textContent = 'Copy failed'));
    }
  });
  p.body.addEventListener('change', (ev) => {
    const el = ev.target as HTMLInputElement;
    if (el.dataset.act !== 'studio' || switching) return;
    switching = true;
    void ExpressiveVoice.studioEnable({ on: el.checked })
      .then((r) => {
        known = { has: true, on: r.enabled === true };
        rememberStudio(known);
        toast(known.on ? 'Studio on: from her next sentence.' : 'Studio off.');
      })
      .catch((err: unknown) => toast(`Couldn’t switch the studio: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        switching = false;
        render();
      });
  });
  p.body.addEventListener('input', (ev) => {
    const el = ev.target as HTMLTextAreaElement;
    if (el.dataset.f === 'notes') notes = el.value;
  });
  render();
  if (STUDIO) void loadStatus();
}
