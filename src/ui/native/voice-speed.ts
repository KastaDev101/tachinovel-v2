/**
 * Voice speed test (Kasta, 2026-10-15: "have a diagnostics/speed test ready and easily accessible ... for the phone").
 * Reached from More › About › Diagnostics, More › Developer, the Voice Test page, the app icon's long-press menu and
 * (with Developer options on) the Listen player's Voice panel.
 * One tap: native renders a 45-second passage with the Nephis pack in use, exactly the way Listen renders it (her
 * chain, studio, studio EQ, pauses), without playing it (VoiceSpeedTest.swift), then this page says in plain words
 * whether she keeps up, how fast she starts, where the time goes and whether her studio ran on every call. "Play
 * result" plays the rendered passage, "Copy report" copies the full report; the report and the audio (.wav) are also
 * saved to the Diagnostics folder (iCloud TachiNovel-Diagnostics) as speedtest-<date>-<time>.json/.wav.
 */
import type { PluginListenerHandle } from '@capacitor/core';
import { ExpressiveVoice } from './expressive-lab.ts';
import { copyText } from './voice-test.ts';
import { esc, panel, toast } from './voices-ui.ts';

type Obj = Record<string, unknown>;
export type Line = { ok: boolean; text: string };

const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {});
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
const sec = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const str = (x: unknown, fallback = '?'): string => (typeof x === 'string' || typeof x === 'number' ? String(x) : fallback);

/** Why her studio stepped aside for a call (NephisStudio's bypass reasons), in plain words. */
const STUDIO_REASON: Record<string, string> = {
  hurry: 'short of audio, no time for the studio', heat: 'phone too hot', failed: 'failed', empty: 'empty', memory: 'low memory',
  loading: 'still loading', slow: 'too slow', 'studio too slow': 'switched off as too slow', off: 'off', released: 'released',
};

/** The result in plain words (native's report; ✓ good, ⚠ worth a look). Empty when there is no report. */
export function speedLines(r: Obj): Line[] {
  if (r.ran !== true) {
    const why = typeof r.error === 'string' ? r.error : 'it didn’t run';
    return [{ ok: false, text: why === 'stopped' ? 'The speed test was stopped.' : `Speed test not run: ${why}` }];
  }
  const lines: Line[] = [];
  const breaks = num(r.breaks);
  const breakSeconds = num(r.breakSeconds);
  lines.push(
    r.keepsUp === true
      ? { ok: true, text: 'Keeps up: yes. Every part was ready before the one before it finished playing.' }
      : {
          ok: false,
          text:
            breaks > 0
              ? `Keeps up: no. Playback would have waited ${breaks} time${breaks === 1 ? '' : 's'} (${breakSeconds.toFixed(1)} s in all).`
              : `Keeps up: no${num(r.failedCalls) > 0 ? ` (${num(r.failedCalls)} call${num(r.failedCalls) === 1 ? '' : 's'} failed)` : ''}.`,
        },
  );
  const first = num(r.firstAudioMs);
  if (Number.isFinite(first)) lines.push({ ok: first <= 2500, text: `First audio after ${sec(first)}.` });
  const x = num(r.timesRealTime);
  const audio = num(r.audioSeconds);
  const render = num(r.renderSeconds);
  if (Number.isFinite(x) && x > 0) {
    lines.push({ ok: x >= 1.5, text: `Speed: ${x.toFixed(1)}× real time (${audio.toFixed(1)} s of audio in ${render.toFixed(1)} s).` });
  }
  const studio = obj(r.studio);
  const calls = num(studio.calls);
  const used = num(studio.used);
  if (studio.read === true && calls > 0) {
    const reasons = Object.entries(obj(studio.reasons)).filter(([, n]) => num(n) > 0);
    const why = reasons.map(([k, n]) => `${num(n)} ${STUDIO_REASON[k] ?? k}`).join(', ');
    // Since 2026-10-15 Listen gives her studio every call it can afford (StudioBudget): a skipped call is her plain
    // sound in the middle of the read (a slow or hot phone, or too little time), so any skip is worth a look.
    lines.push(
      used >= calls
        ? { ok: true, text: `Her studio rendered all ${calls} calls.` }
        : { ok: false, text: `Her studio rendered ${used} of ${calls} calls${why ? ` (others: ${why})` : ''}.` },
    );
  } else if (calls > 0) {
    lines.push({ ok: true, text: 'Her studio is off (or not in this pack): her plain sound.' });
  }
  const chain = obj(r.chain);
  if (chain.studioEQPresent === true) {
    const eqCalls = num(studio.studioEQCalls);
    lines.push({ ok: eqCalls > 0 || studio.read !== true, text: `The pack’s studio EQ ran on ${Number.isFinite(eqCalls) ? eqCalls : 0} call${eqCalls === 1 ? '' : 's'}.` });
  }
  const dewind = dewindLine(chain, studio);
  if (dewind) lines.push(dewind);
  const slow = obj(r.slowestCall);
  if (Number.isFinite(num(slow.x))) {
    lines.push({ ok: num(slow.x) >= 1, text: `Slowest call: #${num(slow.n)} at ${num(slow.x).toFixed(1)}× real time (${num(slow.audioS).toFixed(1)} s of audio).` });
  }
  const device = obj(r.device);
  const heat = `${str(device.thermalStart, '?')} → ${str(device.thermalEnd, '?')}`;
  lines.push({ ok: device.thermalEnd === 'nominal' || device.thermalEnd === 'fair', text: `Phone heat: ${heat}${device.lowPower === true ? ', Low Power Mode on' : ''}.` });
  // "…on this iPhone, but iCloud isn’t uploading": written, yet it won't reach the PC (native's UploadCheck).
  if (typeof r.saved === 'string') lines.push({ ok: !/couldn’t|only|not saved|, but /.test(r.saved), text: `Saved ${r.saved}.` });
  return lines;
}

/** The de-wind cleaner (pack chain "dewind"): on how many calls it ran, and why not when it didn't; null when the pack's
 *  chain doesn't ask for it. */
function dewindLine(chain: Obj, studio: Obj): Line | null {
  const passes = num(obj(chain.dewind).passes);
  if (!(passes > 0)) return null;
  const calls = num(studio.calls);
  const ran = num(studio.dewindCalls);
  const n = Number.isFinite(ran) ? ran : 0;
  const why = typeof studio.dewindNote === 'string' ? ` (${studio.dewindNote})` : '';
  const what = `The de-wind cleaner (${passes} pass${passes === 1 ? '' : 'es'})`;
  return Number.isFinite(calls) && n >= calls
    ? { ok: true, text: `${what} ran on all ${calls} calls.` }
    : { ok: false, text: `${what} ran on ${n} of ${Number.isFinite(calls) ? calls : '?'} calls${why}.` };
}

/** Where the time went: each stage's total and its share of a second of audio. */
export function stageRows(r: Obj): { label: string; ms: number; perSecond: number }[] {
  const s = obj(r.stages);
  const audio = num(r.audioSeconds);
  const rows: [string, string][] = [
    ['Pocket generation', 'pocketGenerationMs'],
    ['Mimi decode', 'mimiDecodeMs'],
    ['Studio blueprint', 'studioBlueprintMs'],
    ['Studio vocoder', 'studioVocoderMs'],
    ['De-wind cleaner', 'dewindMs'],
    ['EQ and finishing', 'eqPostMs'],
  ];
  const out = rows.map(([label, key]) => ({ label, ms: num(s[key]), perSecond: audio > 0 ? num(s[key]) / 1000 / audio : NaN }));
  const extra = num(s.analysisMs) + num(s.recognizeMs) + num(s.studioRestMs);
  if (extra > 0) out.push({ label: 'Checks and studio rest', ms: extra, perSecond: audio > 0 ? extra / 1000 / audio : NaN });
  return out.filter((row) => Number.isFinite(row.ms));
}

/** The tuner's finishing in the chain ("closeness", "breathAir", "room"), e.g. ", closeness 15%, room 7%", after the
 *  de-wind cleaner (", de-wind 2 passes"); empty when none. */
function finishing(chain: Obj): string {
  const passes = num(obj(chain.dewind).passes);
  const dewind = passes > 0 ? `, de-wind ${passes} pass${passes === 1 ? '' : 'es'}` : '';
  const parts: [string, unknown][] = [['closeness', chain.closeness], ['breath air', chain.breathAir], ['room', chain.room]];
  return parts
    .map(([label, v]) => [label, num(obj(v).amount)] as const)
    .filter(([, amount]) => amount > 0)
    .map(([label, amount]) => `, ${label} ${Math.round(amount * 100)}%`)
    .reduce((all, part) => all + part, dewind);
}

/** The device and pack lines under the result. */
export function aboutLines(r: Obj): string[] {
  const d = obj(r.device);
  const pack = obj(r.pack);
  const chain = obj(r.chain);
  const mem = obj(d.memoryStart);
  const sha = typeof pack.weightsSha256 === 'string' ? ` · weights ${pack.weightsSha256.slice(0, 12)}…` : '';
  const free = num(mem.freeMB);
  return [
    `${str(d.model, '?')} · iOS ${str(d.ios, '?')}${Number.isFinite(free) ? ` · ${Math.round(free)} MB free` : ''}`,
    pack.installed === true ? `Pack: ${str(pack.name, 'unnamed')}${sha}` : 'Pack: none installed (the voice the app came with)',
    `Chain: clip ${str(chain.clipFrames, '?')}, carry ${str(chain.carryFrames, '?')} frames, studio EQ ${chain.studioEQPresent === true ? 'yes' : 'no'}${finishing(chain)}`,
  ];
}

/** The Voice Speed Test (More › About › Diagnostics, More › Developer, the app icon's quick action, …). */
export function openVoiceSpeedTest(): void {
  const p = panel('Voice Speed Test', 'voice-speed');
  let running = false;
  let report: Obj | null = null;
  let progress = '';
  let playing = false;
  let status: Obj = {};
  let listener: PluginListenerHandle | null = null;

  const row = (l: Line): string => `<div class="row"><span aria-hidden="true">${l.ok ? '✓' : '⚠'}</span><div class="main">${esc(l.text)}</div></div>`;
  const plain = (t: string): string => `<div class="row"><div class="main">${esc(t)}</div></div>`;

  const render = (): void => {
    const pack = status.nephisPack && typeof status.nephisPack === 'object' ? (status.nephisPack as Obj) : null;
    const top = pack
      ? `Nephis pack: ${str(pack.name, 'unnamed')}${pack.studio === true ? (pack.studioOn === true ? ', studio on' : ', studio off') : ''}.`
      : status.nephisPack === null
        ? 'Nephis pack: none installed (she reads with the voice the app came with).'
        : '';
    const lines = report && !running ? speedLines(report) : [];
    const stages = report && !running && report.ran === true ? stageRows(report) : [];
    const result = lines.length
      ? `<div class="sec">Result</div><div class="card" data-testid="voice-speed-result">${lines.map(row).join('')}</div>
        ${
          stages.length
            ? `<div class="sec">Where the time went</div><div class="card" data-testid="voice-speed-stages">${stages
                .map((s) => `<div class="row"><div class="main"><b>${esc(s.label)}</b><span class="sub">${sec(s.ms)}${Number.isFinite(s.perSecond) ? ` · ${s.perSecond.toFixed(2)} s per second of audio` : ''}</span></div></div>`)
                .join('')}</div>`
            : ''
        }
        ${report?.ran === true ? `<div class="sec">This phone</div><div class="card">${aboutLines(report).map(plain).join('')}</div>` : ''}
        ${report?.ran === true && Number(report.audioSamples ?? 0) > 0 ? `<button type="button" class="btn" data-act="play" data-testid="voice-speed-play">${playing ? 'Stop Playing' : 'Play Result'}</button>` : ''}
        <button type="button" class="btn alt" data-act="copy" data-testid="voice-speed-copy">Copy Report</button>`
      : '';
    p.body.innerHTML = `
      ${top ? `<div class="card">${plain(top)}</div>` : ''}
      <p class="note">Renders a 45-second passage with Nephis exactly like Listen does, without playing it, and times every step. It takes about a minute; Listen stops while it runs.</p>
      <button type="button" class="btn" data-act="${running ? 'stop' : 'run'}" data-testid="voice-speed-run">${running ? 'Stop' : report ? 'Run It Again' : 'Run the Speed Test'}</button>
      <p class="note" data-testid="voice-speed-progress" aria-live="polite">${esc(progress)}</p>
      ${result}`;
  };

  /** Only the progress line changes while the test runs. */
  const say = (text: string): void => {
    progress = text;
    const el = p.body.querySelector('[data-testid="voice-speed-progress"]');
    if (el) el.textContent = text;
  };

  const stopPlaying = (): void => {
    if (!playing) return;
    playing = false;
    void ExpressiveVoice.voiceSpeedTestPlay({ stop: true }).catch(() => undefined);
  };

  const run = async (): Promise<void> => {
    stopPlaying();
    running = true;
    report = null;
    progress = 'Starting…';
    render();
    const t0 = Date.now();
    const tick = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000);
      const el = p.body.querySelector('[data-testid="voice-speed-progress"]');
      if (el && progress) el.textContent = `${progress} (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})`;
    }, 1000);
    try {
      listener = await ExpressiveVoice.addListener('voiceSpeedTest', (e: Obj) => {
        if (typeof e.text === 'string') say(e.text);
      }).catch(() => null);
      report = await ExpressiveVoice.voiceSpeedTest();
    } catch (err) {
      report = { ran: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearInterval(tick);
      void listener?.remove();
      listener = null;
    }
    running = false;
    progress = report.ran === true ? 'Done.' : '';
    render();
  };

  p.root.addEventListener('click', (ev) => {
    // Leaving the page: the test stops, the result stops playing.
    if ((ev.target as Element).closest('[data-act="close"]')) {
      if (running) void ExpressiveVoice.voiceSpeedTestStop().catch(() => undefined);
      stopPlaying();
    }
  });
  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'run' && !running) void run();
    if (act === 'stop' && running) {
      say('Stopping after the current part…');
      void ExpressiveVoice.voiceSpeedTestStop().catch(() => undefined);
    }
    if (act === 'play') {
      if (playing) {
        stopPlaying();
        render();
        return;
      }
      void ExpressiveVoice.voiceSpeedTestPlay()
        .then((r) => {
          playing = r.playing;
          render();
          // Back to "Play Result" once it has played (native doesn't say when it ends).
          const seconds = typeof r.seconds === 'number' ? r.seconds : 0;
          if (playing && seconds > 0) {
            setTimeout(() => {
              if (!playing) return;
              playing = false;
              render();
            }, seconds * 1000 + 300);
          }
        })
        .catch((err: unknown) => toast(err instanceof Error ? err.message : String(err)));
    }
    if (act === 'copy' && report) {
      void copyText(JSON.stringify(report, null, 2))
        .then((label) => (el.textContent = label))
        .catch(() => (el.textContent = 'Copy Failed'));
    }
  });
  render();
  void ExpressiveVoice.status()
    .then((s) => {
      status = s;
      if (!running) render();
    })
    .catch(() => undefined);
}
