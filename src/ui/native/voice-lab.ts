/**
 * Voice Lab — hidden (Settings › About › tap the version 5 times). Live numbers from the on-device voice
 * for tonight's phone test: whether the crash safety fallback tripped, where Core ML runs each Kokoro stage
 * (Neural Engine / CPU / GPU, from its compute plan), time to first audio, per-sentence real-time factor,
 * model load (cold/warm), memory, thermal state and fallbacks to the Apple voice. "Copy report" puts it
 * all on the clipboard as JSON.
 */
import type { SourceBlock } from '@v1tts/frontend.ts';
import { speechScript } from '../../core/narration/speech-script.ts';
import { Narration } from './narration.ts';

/** Synthetic chapter for "Speak test paragraph" (and the simulator self-test): no novel, no progress. */
export const LAB_PLUGIN = 'voice-lab';

export const TEST_PARAGRAPHS = [
  'Chapter 12 - The Old Bridge',
  'The rain had stopped by the time Sunny reached the old bridge. He counted the lanterns, all 304 of them, and wondered who had lit them.',
  '“Wait,” Nephis said quietly. “Are you sure this is the way?” Tsk. He didn’t answer; the river answered for him, loud and cold beneath the stones.',
  'Somewhere far behind them, a bell rang three times. They walked on.',
];

export function labScript(paragraphs = TEST_PARAGRAPHS): ReturnType<typeof speechScript> {
  const blocks: SourceBlock[] = paragraphs.map((text) => ({ text, tag: 'p' }));
  return speechScript(blocks, { title: 'The Old Bridge', lexicons: [{ schemaVersion: 1, entries: [{ match: 'Nephis', ipa: 'nˈɛfɪs' }] }] });
}

const CSS = `
.tn-lab{position:fixed;inset:0;z-index:92;background:#0e0e11;color:#e8e8ee;display:flex;flex-direction:column;
  padding:env(safe-area-inset-top) max(12px,env(safe-area-inset-right)) env(safe-area-inset-bottom) max(12px,env(safe-area-inset-left));font:14px -apple-system,system-ui}
.tn-lab button{font:inherit;color:inherit;background:rgba(255,255,255,.08);border:0;border-radius:10px;padding:9px 12px;-webkit-tap-highlight-color:transparent}
.tn-lab button.on{background:#a8b4ff;color:#15151a}
.tn-lab .hd{display:flex;align-items:center;gap:8px;height:50px}
.tn-lab .hd h1{flex:1;font-size:19px;margin:0}
.tn-lab .body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:20px}
.tn-lab h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#9a9aa6;margin:16px 2px 6px}
.tn-lab .kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;background:#18181d;border-radius:12px;padding:10px 12px}
.tn-lab .kv span:nth-child(odd){color:#9a9aa6}
.tn-lab .kv span:nth-child(even){font-variant-numeric:tabular-nums;word-break:break-word}
.tn-lab table{width:100%;border-collapse:collapse;background:#18181d;border-radius:12px;font-variant-numeric:tabular-nums;font-size:13px}
.tn-lab td,.tn-lab th{padding:5px 6px;text-align:right}
.tn-lab th{color:#9a9aa6;font-weight:500}
.tn-lab .acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.tn-lab .big{font-size:26px;font-weight:600}
`;

function fmt(x: unknown, digits = 0, unit = ''): string {
  return typeof x === 'number' && Number.isFinite(x) ? `${x.toFixed(digits)}${unit}` : '–';
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

type Obj = Record<string, unknown>;
/** A string or number from the lab JSON as text, else the fallback. */
const str = (x: unknown, fallback = '–'): string => (typeof x === 'string' || typeof x === 'number' ? String(x) : fallback);
const obj = (x: unknown): Obj => (x && typeof x === 'object' ? (x as Obj) : {});

let open = false;

export function openVoiceLab(): void {
  if (open) return;
  open = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const root = document.createElement('div');
  root.className = 'tn-lab';
  root.dataset.testid = 'voice-lab';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true'); // full screen: VoiceOver must not reach the screen behind
  root.setAttribute('aria-label', 'Voice Lab');
  root.innerHTML = '<div class="hd"><h1>Voice Lab</h1><button type="button" data-act="close">Close</button></div><div class="body"></div>';
  document.body.append(root);
  const body = root.querySelector('.body') as HTMLElement;
  let lab: Obj = {};
  let poll = 0;

  const render = (): void => {
    const k = obj(lab.kokoro);
    const stats = obj(lab.stats);
    const dev = obj(lab.device);
    const ses = obj(lab.session);
    const crashes = obj(lab.crashes);
    const model = obj(k.model);
    const routes = Array.isArray(lab.routes) ? (lab.routes as Obj[]) : [];
    const first = Array.isArray(stats.firstAudio) ? (stats.firstAudio as Obj[]) : [];
    const rows = Array.isArray(stats.sentences) ? (stats.sentences as Obj[]).slice(-20).reverse() : [];
    const stages = obj(k.stages);
    const fallbacks = obj(ses.fallbacks);
    const lastFirst = first[first.length - 1];
    const placement = Array.isArray(lab.placement) ? (lab.placement as Obj[]) : [];
    const car = obj(lab.car);
    const np = obj(car.nowPlaying);
    const cmds = obj(car.commands);
    const gaps = Array.isArray(car.chapterGapsMs) ? (car.chapterGapsMs as number[]) : [];
    const tripped = crashes.disabled === true;
    const crashCount = typeof crashes.total === 'number' ? crashes.total : 0;
    body.innerHTML = `
      <h2>Safety fallback</h2>
      <div class="kv">
        <span>Status</span><span class="big">${tripped ? 'TRIPPED: Kokoro off' : crashCount > 0 ? `armed (${crashCount} crash${crashCount === 1 ? '' : 'es'})` : 'not tripped'}</span>
        <span>Crashes in Core ML</span><span>${fmt(crashes.total)} total, ${fmt(crashes.consecutive)} in a row${crashes.lastAt ? ` · last ${esc(str(crashes.lastAt))}` : ''}</span>
        <span>Last crash during</span><span>${esc(str(crashes.lastContext, '–'))}</span>
      </div>
      <h2>Where each stage runs (Core ML plan)</h2>
      <div class="kv">${placement.length > 0 ? placement.map((p) => `<span>${esc(str(p.stage))}</span><span>${p.error ? esc(str(p.error)) : `${esc(str(p.configured))} → ANE ${fmt(p.ane)} · CPU ${fmt(p.cpu)} · GPU ${fmt(p.gpu)} ops`}</span>`).join('') : '<span>–</span><span>Tap “Check placement”</span>'}</div>
      <div class="acts"><button type="button" data-act="placement">Check placement</button></div>
      <h2>Now</h2>
      <div class="kv">
        <span>Time to first audio</span><span class="big">${lastFirst ? `${fmt(lastFirst.ms)} ms` : '–'}</span>
        <span>…from</span><span>${esc(str(lastFirst?.source, '–'))}</span>
        <span>Speed (all sentences)</span><span class="big">${fmt(stats.aggregateX, 1, '× real time')}</span>
        <span>Median / slowest 5%</span><span>${fmt(stats.p50X, 1, '×')} / ${fmt(stats.p05X, 1, '×')}</span>
        <span>Sentences / failures</span><span>${fmt(stats.totalSentences)} / ${fmt(stats.failures)}</span>
      </div>
      <h2>Kokoro</h2>
      <div class="kv">
        <span>Status</span><span>${esc(str(k.status, '–'))}</span>
        <span>Model load</span><span>${fmt(k.lastLoadMs)} ms${k.lastLoadCold ? ' (cold: first load this launch)' : ''}</span>
        <span>Model</span><span>${esc(str(model.revision, '–').slice(0, 10))} · ${fmt(typeof model.bytes === 'number' ? model.bytes / 1e6 : undefined, 0, ' MB')}</span>
        <span>Render ahead</span><span>${fmt(k.ahead)} sentences</span>
        <span>Stages</span><span>${Object.entries(stages).map(([s, u]) => `${esc(s)} ${esc(String(u))}`).join(', ')}</span>
        <span>Memory releases</span><span>${fmt(k.memoryReleases)}</span>
      </div>
      <div class="acts">${routes.map((r) => `<button type="button" data-act="route" data-v="${esc(String(r.id))}" class="${r.id === k.route ? 'on' : ''}">${esc(String(r.title))}</button>`).join('')}</div>
      <div class="acts">${[2, 3].map((n) => `<button type="button" data-act="ahead" data-v="${n}" class="${n === k.ahead ? 'on' : ''}">Ahead ${n}</button>`).join('')}</div>
      <h2>This session</h2>
      <div class="kv">
        <span>Speaking</span><span>${esc(str(ses.source, '–'))}${ses.lastFallback ? ` (${esc(str(ses.lastFallback))})` : ''}</span>
        <span>Kokoro / Apple sentences</span><span>${fmt(ses.kokoroSentences)} / ${fmt(ses.appleSentences)}</span>
        <span>Queue ran dry</span><span>${fmt(ses.underruns)}</span>
        <span>Fallbacks</span><span>${Object.entries(fallbacks).map(([r, n]) => `${esc(r)} ${String(n)}`).join(', ') || 'none'}</span>
        <span>Back to Kokoro</span><span>${fmt(ses.returnsToKokoro)}</span>
        <span>Thermal throttling</span><span>${ses.throttled ? 'on' : 'off'}</span>
      </div>
      <h2>In the car (Now Playing)</h2>
      <div class="kv">
        <span>Showing</span><span>${np.title ? `${esc(str(np.title))} · ${esc(str(np.artist, ''))} · ${esc(str(np.album, ''))}` : 'nothing'}</span>
        <span>Time / length</span><span>${fmt(np.shownNow ?? np.elapsed, 0, ' s')} / ${fmt(np.duration, 0, ' s')} at ${fmt(np.rate, 2, '×')}${np.artwork ? ' · cover' : ''}</span>
        <span>Car buttons</span><span>${cmds.buttons === 'skip15' ? '±15 s' : 'chapters'} (${['nextTrack', 'previousTrack', 'skipForward', 'skipBackward', 'changePlaybackPosition'].filter((c) => cmds[c] === true).join(', ') || 'none yet'})</span>
        <span>Last commands</span><span>${Array.isArray(cmds.recent) ? esc((cmds.recent as string[]).slice(-6).join(', ')) || '–' : '–'}</span>
        <span>Chapter changes</span><span>${gaps.length > 0 ? `${gaps.map((g) => `${Math.round(g)} ms`).join(', ')} of silence` : '–'}</span>
        <span>Prepared audio</span><span>${fmt(car.preparedChapters)} chapters · ${fmt(typeof car.preparedBytes === 'number' ? car.preparedBytes / 1e6 : undefined, 0, ' MB')}</span>
        <span>CarPlay app</span><span>${car.carPlayTemplates === true ? 'on' : 'off (needs Apple’s CarPlay audio entitlement)'}</span>
      </div>
      <h2>Device</h2>
      <div class="kv">
        <span>iPhone</span><span>${esc(str(dev.model, '–'))} · ${esc(str(dev.os, ''))}</span>
        <span>Compute units</span><span>${Array.isArray(dev.computeDevices) ? esc((dev.computeDevices as string[]).join(', ')) : '–'}</span>
        <span>Memory (app)</span><span>${fmt(dev.memoryMB, 0, ' MB')} · ${fmt(dev.availableMB, 0, ' MB')} available</span>
        <span>Thermal</span><span>${esc(str(dev.thermal, '–'))}${dev.lowPower ? ' · Low Power Mode' : ''}</span>
        <span>Battery</span><span>${typeof dev.battery === 'number' && dev.battery >= 0 ? `${Math.round(dev.battery * 100)}%` : '–'}</span>
        <span>Crashes in Kokoro</span><span>${fmt(crashes.total)}${crashes.disabled ? ' · Kokoro turned off' : ''}${crashes.lastAt ? ` · last ${esc(str(crashes.lastAt))}` : ''}</span>
      </div>
      <h2>Time to first audio (last ${first.length})</h2>
      <div class="kv">${first
        .slice()
        .reverse()
        .map((f) => `<span>${esc(str(f.at, '').slice(11, 19))}</span><span>${fmt(f.ms)} ms · ${esc(str(f.source, ''))}</span>`)
        .join('') || '<span>–</span><span></span>'}</div>
      <h2>Sentences (newest first)</h2>
      <table><tr><th>#</th><th>chars</th><th>synth</th><th>audio</th><th>× RT</th><th>RTF</th></tr>
      ${rows.map((r) => `<tr><td>${fmt(r.index)}</td><td>${fmt(r.chars)}</td><td>${fmt(r.synthMs)} ms</td><td>${fmt(typeof r.audioMs === 'number' ? r.audioMs / 1000 : undefined, 1)} s</td><td>${fmt(r.x, 1)}</td><td>${fmt(r.rtf, 3)}</td></tr>`).join('')}</table>
      <div class="acts">
        <button type="button" data-act="test">Speak test paragraph</button>
        <button type="button" data-act="stop">Stop</button>
        <button type="button" data-act="reset">Reset numbers</button>
        <button type="button" data-act="copy">Copy report</button>
      </div>`;
  };

  const refresh = async (): Promise<void> => {
    lab = obj(await Narration.voiceLab().catch(() => ({})));
    render();
  };

  root.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    switch (el.dataset.act ?? '') {
      case 'close':
        open = false;
        window.clearInterval(poll);
        root.remove();
        style.remove();
        return;
      case 'route':
        void Narration.setVoiceLab({ route: el.dataset.v ?? 'ane-cpu' }).then(refresh);
        return;
      case 'ahead':
        void Narration.setVoiceLab({ ahead: Number(el.dataset.v) }).then(refresh);
        return;
      case 'reset':
        void Narration.setVoiceLab({ resetStats: true }).then(refresh);
        return;
      case 'placement':
        el.textContent = 'Checking…';
        void Narration.voicePlacement()
          .then(refresh)
          .catch(() => (el.textContent = 'Check failed'));
        return;
      case 'stop':
        void Narration.stop();
        return;
      case 'test':
        void Narration.play({
          pluginId: LAB_PLUGIN,
          novelPath: 'lab',
          chapterPath: 'lab/1',
          novelName: 'Voice Lab',
          chapterName: 'Test paragraph',
          script: labScript(),
          start: { paragraph: 0 },
          autoContinue: false,
          engine: 'speech',
        });
        return;
      case 'copy':
        void navigator.clipboard
          .writeText(JSON.stringify(lab, null, 2))
          .then(() => (el.textContent = 'Copied'))
          .catch(() => (el.textContent = 'Copy failed'));
        return;
      default:
    }
  });
  render();
  void refresh();
  void Narration.voicePlacement()
    .then(refresh)
    .catch(() => undefined);
  poll = window.setInterval(() => void refresh(), 1000);
}
