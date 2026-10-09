/**
 * Settings › Voices › Expressive voices (experimental), also Voice Lab › Experimental engines.
 * EXPERIMENTAL expressive voices on the iPhone (docs/expressive-tts.md): download a model on demand (Wi-Fi,
 * size shown, two taps), play the same sample with it and with Kokoro (A/B), run a speed test (load, time
 * to first audio, × real time, memory, thermal), copy the report. Narration itself is unchanged.
 * Personal flavor: "Narrator voice" — voices designed on the PC (.tnvoice), imported and chosen for
 * Chatterbox Nano (voice-import.ts, docs/voice-import.md).
 * Native side: ExpressiveVoicePlugin.swift (ExpressiveService + ExpressiveSpeechEngine, Kokoro fallback).
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { annotate, SAMPLES, type ExpressiveLine } from './expressive-samples.ts';
import { createVoiceSection, importEventMessage } from './voice-import.ts';

type Obj = Record<string, unknown>;

interface ExpressiveVoicePlugin {
  status(): Promise<Obj>;
  download(o: { engine: string }): Promise<Obj>;
  cancelDownload(o: { engine: string }): Promise<Obj>;
  remove(o: { engine: string }): Promise<Obj>;
  play(o: { engine: string; sample: string; lines: ExpressiveLine[] }): Promise<Obj>;
  stop(): Promise<Obj>;
  speedTest(o: { engine: string; sample: string; lines: ExpressiveLine[] }): Promise<Obj>;
  cancelSpeedTest(): Promise<Obj>;
  unload(): Promise<Obj>;
  resetCrashes(): Promise<Obj>;
  resetStats(): Promise<Obj>;
  recordStart(): Promise<{ recording: boolean }>;
  recordStop(): Promise<{ saved: boolean; bytes: number }>;
  shareRecording(): Promise<void>;
  importVoice(): Promise<Obj>;
  selectVoice(o: { id: string | null }): Promise<Obj>;
  renameVoice(o: { id: string; name: string }): Promise<Obj>;
  deleteVoice(o: { id: string }): Promise<Obj>;
  playVoiceSample(o: { id: string | null }): Promise<Obj>;
}

/** Events (kept out of the method list above, which mirrors the Swift plugin's methods). */
interface ExpressiveVoiceEvents {
  /** A .tnvoice opened with "Open in TachiNovel" was imported (or refused). */
  addListener(event: 'voiceImport', fn: (e: Obj) => void): Promise<PluginListenerHandle>;
}

export const ExpressiveVoice = registerPlugin<ExpressiveVoicePlugin & ExpressiveVoiceEvents>('ExpressiveVoice');

const CSS = `
.tn-xlab{position:fixed;inset:0;z-index:93;background:#0e0e11;color:#e8e8ee;display:flex;flex-direction:column;
  padding:env(safe-area-inset-top) max(12px,env(safe-area-inset-right)) env(safe-area-inset-bottom) max(12px,env(safe-area-inset-left));font:14px -apple-system,system-ui}
.tn-xlab button{font:inherit;color:inherit;background:rgba(255,255,255,.08);border:0;border-radius:10px;padding:9px 12px;-webkit-tap-highlight-color:transparent}
.tn-xlab button.on{background:#a8b4ff;color:#15151a}
.tn-xlab button.warn{background:#5a2a2a}
.tn-xlab .hd{display:flex;align-items:center;gap:8px;height:50px}
.tn-xlab .hd h1{flex:1;font-size:19px;margin:0}
.tn-xlab .body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:24px}
.tn-xlab h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#9a9aa6;margin:16px 2px 6px}
.tn-xlab .card{background:#18181d;border-radius:12px;padding:10px 12px;margin-bottom:10px}
.tn-xlab .card h3{margin:0 0 4px;font-size:16px}
.tn-xlab .muted{color:#9a9aa6;font-size:13px}
.tn-xlab .kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;background:#18181d;border-radius:12px;padding:10px 12px}
.tn-xlab .kv span:nth-child(odd){color:#9a9aa6}
.tn-xlab .kv span:nth-child(even){font-variant-numeric:tabular-nums;word-break:break-word}
.tn-xlab .acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.tn-xlab .bar{height:6px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden;margin-top:6px}
.tn-xlab .bar i{display:block;height:100%;background:#a8b4ff}
.tn-xlab table{width:100%;border-collapse:collapse;background:#18181d;border-radius:12px;font-variant-numeric:tabular-nums;font-size:12px}
.tn-xlab td,.tn-xlab th{padding:4px 5px;text-align:right;vertical-align:top}
.tn-xlab td.t{text-align:left;max-width:52vw}
.tn-xlab tr.now td{background:rgba(168,180,255,.15)}
.tn-xlab th{color:#9a9aa6;font-weight:500}
.tn-xlab .xtag{display:inline-block;font-size:11px;line-height:16px;vertical-align:middle;padding:0 6px;border-radius:8px;background:rgba(255,255,255,.1);margin-left:4px}
.tn-xlab textarea{width:100%;box-sizing:border-box;min-height:110px;background:#18181d;color:inherit;border:1px solid #2a2a33;border-radius:10px;padding:8px;font:inherit}
.tn-xlab .err{color:#ff9a9a}
${
  __FLAVOR__ === 'personal'
    ? `.tn-xlab .xv-row{padding:8px 0;border-top:1px solid rgba(255,255,255,.07)}
.tn-xlab .xv-row:first-of-type{border-top:0}
.tn-xlab input[type=text]{flex:1;min-width:0;box-sizing:border-box;background:#0e0e11;color:inherit;border:1px solid #2a2a33;border-radius:10px;padding:8px;font:16px -apple-system,system-ui}`
    : ''
}
`;

function fmt(x: unknown, digits = 0, unit = ''): string {
  return typeof x === 'number' && Number.isFinite(x) ? `${x.toFixed(digits)}${unit}` : '–';
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const str = (x: unknown, fallback = '–'): string => (typeof x === 'string' || typeof x === 'number' ? String(x) : fallback);
const obj = (x: unknown): Obj => (x && typeof x === 'object' ? (x as Obj) : {});
const arr = (x: unknown): Obj[] => (Array.isArray(x) ? (x as Obj[]) : []);
const mb = (bytes: unknown): string => (typeof bytes === 'number' ? `${Math.round(bytes / 1e6)} MB` : '–');

/** One line of commercial-use guidance per license (docs/expressive-tts.md has the details). */
function licenseNote(license: string): string {
  if (/^MIT$/i.test(license)) return 'MIT: commercial use OK.';
  if (/NeuTTS/i.test(license)) return 'NeuTTS Open License: commercial use free below $5M annual revenue, paid license above.';
  return license;
}

type SampleId = (typeof SAMPLES)[number]['id'] | 'custom';

let open = false;
/** Shows a message in the open lab (set while it is open). */
let showMessage: ((text: string, error: boolean) => void) | null = null;

/** "Open in TachiNovel" results for .tnvoice files: open the lab with what happened (personal flavor, main.ts). */
export function installVoiceImports(): void {
  void ExpressiveVoice.addListener('voiceImport', (e) => {
    const { message, error } = importEventMessage(e);
    openExpressiveLab({ message, error });
  }).catch(() => undefined);
}

export function openExpressiveLab(opts: { message?: string; error?: boolean } = {}): void {
  if (open) {
    if (opts.message) showMessage?.(opts.message, opts.error === true);
    return;
  }
  open = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const root = document.createElement('div');
  root.className = 'tn-xlab';
  root.dataset.testid = 'expressive-lab';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Voice models');
  root.innerHTML = '<div class="hd"><h1>Voice models</h1><button type="button" data-act="close">Close</button></div><div class="body"></div>';
  document.body.append(root);
  const body = root.querySelector('.body') as HTMLElement;

  let st: Obj = {};
  let sampleId: SampleId = 'dialogue';
  let customText = '';
  let armed = ''; // "download:<id>" / "remove:<id>": the second tap confirms
  let message = '';
  let messageIsError = false;
  let unavailable = false;
  let poll = 0;
  if (opts.message) {
    message = opts.message;
    messageIsError = opts.error === true;
  }
  showMessage = (text, error) => {
    message = text;
    messageIsError = error;
    render();
  };

  const lines = (): ExpressiveLine[] => (sampleId === 'custom' ? annotate(customText) : (SAMPLES.find((s) => s.id === sampleId)?.lines ?? []));

  const engineCard = (e: Obj): string => {
    const id = str(e.id, '');
    const dl = obj(e.download);
    const load = obj(e.load);
    const installed = e.installed === true;
    const supported = e.supported !== false;
    let state: string;
    let acts = '';
    if (!supported) state = '<span class="err">Needs iOS 18 or later.</span>';
    else if (dl.state === 'downloading') {
      const pct = typeof dl.fraction === 'number' ? dl.fraction * 100 : 0;
      state = `Downloading ${fmt(pct)}% · ${fmt(dl.filesDone)}/${fmt(dl.filesTotal)} files · keep the app open<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>`;
      acts = `<button type="button" data-act="cancel" data-id="${esc(id)}">Cancel download</button>`;
    } else if (!installed) {
      if (dl.state === 'failed') state = `<span class="err">${esc(str(dl.error, 'Download failed'))}</span>`;
      else state = `Not downloaded${typeof e.bytesOnDisk === 'number' && e.bytesOnDisk > 0 ? ` (${mb(e.bytesOnDisk)} so far)` : ''}.`;
      acts =
        armed === `download:${id}`
          ? `<button type="button" class="on" data-act="download" data-id="${esc(id)}">Tap again: download ${mb(e.bytes)} on Wi-Fi</button>`
          : `<button type="button" data-act="arm-download" data-id="${esc(id)}">Download ${mb(e.bytes)}</button>`;
    } else {
      const ls = str(load.state, 'unloaded');
      const loadText = ls === 'ready' ? 'loaded' : ls === 'loading' ? 'loading… (the first load compiles the model, can take a minute)' : ls === 'failed' ? `load failed: ${str(load.error)}` : 'not loaded';
      state = `Downloaded (${mb(e.bytes)}) · ${esc(loadText)}${typeof e.lastLoadMs === 'number' ? ` · last load ${fmt(e.lastLoadMs)} ms${e.lastLoadCold ? ' (cold)' : ' (warm)'}` : ''}`;
      acts = [
        `<button type="button" data-act="play" data-id="${esc(id)}">▶ Play sample</button>`,
        `<button type="button" data-act="speed" data-id="${esc(id)}">Speed test</button>`,
        armed === `remove:${id}`
          ? `<button type="button" class="warn" data-act="remove" data-id="${esc(id)}">Tap again: delete ${mb(e.bytes)}</button>`
          : `<button type="button" data-act="arm-remove" data-id="${esc(id)}">Delete model</button>`,
      ].join('');
    }
    return `<div class="card" data-engine="${esc(id)}">
      <h3>${esc(str(e.title))}${e.gpu ? '<span class="xtag">GPU: foreground only</span>' : ''}</h3>
      <div class="muted">${esc(str(e.blurb, ''))}</div>
      <div class="muted">${esc(licenseNote(str(e.license, '')))} · ${esc(str(e.upstream, ''))}</div>
      <div style="margin-top:6px">${state}</div>
      <div class="acts">${acts}</div>
    </div>`;
  };

  const sessionView = (s: Obj): string => {
    if (!s.state || s.state === 'idle') return '<div class="muted">Nothing played yet. Play a sample with an engine, then with Kokoro, and compare.</div>';
    const first = obj(s.firstAudio);
    const fallbacks = Object.entries(obj(s.fallbacks)).map(([k, v]) => `${esc(k)} ${str(v)}`).join(', ') || 'none';
    const rows = arr(s.rows);
    return `<div class="kv">
        <span>Engine</span><span>${esc(str(s.title))} · ${esc(str(s.state))}</span>
        <span>Time to first audio</span><span>${first.ms !== undefined ? `${fmt(first.ms)} ms (${esc(str(first.source))}${first.includedLoad ? ', incl. model load' : ''})` : '–'}</span>
        <span>Expressive / Kokoro lines</span><span>${fmt(s.expressiveLines)} / ${fmt(s.kokoroFallbackLines)}</span>
        <span>Queue ran dry</span><span>${fmt(s.underruns)}</span>
        <span>Fallbacks</span><span>${fallbacks}</span>
        <span>Throttled</span><span>${esc(str(s.throttle, 'no'))}</span>
        ${obj(s.voice).name ? `<span>Voice</span><span>${esc(str(obj(s.voice).name))}${obj(s.voice).note ? `<div class="err">${esc(str(obj(s.voice).note))}</div>` : ''}</span>` : ''}
      </div>
      <div class="acts"><button type="button" data-act="stop">■ Stop</button></div>
      <h2>Lines</h2>
      <table><tr><th>#</th><th class="t">text</th><th>voice</th><th>synth</th><th>audio</th><th>×RT</th></tr>
      ${rows
        .map(
          (r) => `<tr class="${r.i === s.current ? 'now' : ''}"><td>${fmt(r.i)}</td><td class="t">${esc(str(r.text, ''))}${r.error ? `<div class="err">${esc(str(r.error))}</div>` : ''}</td>
            <td>${esc(str(r.source, ''))}${r.fallback ? `<div class="muted">${esc(str(r.fallback))}</div>` : ''}</td><td>${fmt(r.synthMs)}</td>
            <td>${fmt(typeof r.audioMs === 'number' ? r.audioMs / 1000 : undefined, 1)}</td><td>${fmt(r.x, 1)}</td></tr>`,
        )
        .join('')}</table>`;
  };

  const speedView = (t: Obj): string => {
    if (!t.engine) return '<div class="muted">Speed test: renders the sample without playing it and measures.</div>';
    const m = obj(t.memoryMB);
    const th = obj(t.thermal);
    const rows = arr(t.rows);
    return `<div class="kv">
        <span>Engine</span><span>${esc(str(t.title))} · ${esc(str(t.sample))} · ${t.running ? `running ${fmt(t.done)}/${fmt(t.total)}` : `done ${fmt(t.done)}/${fmt(t.total)}`}</span>
        <span>Model load</span><span>${typeof t.loadMs === 'number' ? `${fmt(t.loadMs)} ms${t.coldLoad ? ' (cold: first load this launch)' : ''}` : 'already loaded'}</span>
        <span>First audio (line 1)</span><span>${fmt(t.firstAudioMs)} ms</span>
        <span>Speed (all lines)</span><span><b>${fmt(t.aggregateX, 2, '× real time')}</b> · median ${fmt(t.p50X, 2)}× · slowest 10% ${fmt(t.p10X, 2)}×</span>
        <span>Audio rendered</span><span>${fmt(t.audioSeconds, 1)} s</span>
        <span>Memory (app)</span><span>${fmt(m.before)} → ${fmt(m.loaded)} MB loaded, max ${fmt(m.max)} MB</span>
        <span>Thermal</span><span>${esc(str(th.start))} → ${esc(str(th.end))}</span>
        ${t.error ? `<span>Stopped</span><span class="err">${esc(str(t.error))}</span>` : ''}
      </div>
      <div class="acts">${t.running ? '<button type="button" data-act="cancel-speed">Cancel speed test</button>' : ''}</div>
      <table><tr><th>#</th><th>chars</th><th>first</th><th>synth</th><th>audio</th><th>×RT</th></tr>
      ${rows
        .map((r) =>
          r.error
            ? `<tr><td>${fmt(r.i)}</td><td class="t err" colspan="5">${esc(str(r.error))}</td></tr>`
            : `<tr><td>${fmt(r.i)}</td><td>${fmt(r.chars)}</td><td>${fmt(r.firstAudioMs)}</td><td>${fmt(r.synthMs)}</td><td>${fmt(typeof r.audioMs === 'number' ? r.audioMs / 1000 : undefined, 1)}</td><td>${fmt(r.x, 2)}</td></tr>`,
        )
        .join('')}</table>`;
  };

  const render = (): void => {
    const dev = obj(st.device);
    const crashes = obj(st.crashes);
    const engines = arr(st.engines);
    const current = lines();
    body.innerHTML = `
      <div class="muted" style="margin:4px 2px 8px">Pocket TTS is the Narrator’s and Nephis’s voice: download it once (Wi-Fi).
        The other engines are experiments.</div>
      ${unavailable ? '<div class="card err">Experimental engines aren’t available in this build.</div>' : ''}
      ${message ? `<div class="card${messageIsError ? ' err' : ''}" data-testid="xlab-message" data-error="${messageIsError ? 1 : 0}">${esc(message)}</div>` : ''}
      ${voices?.view() ?? ''}
      ${
        crashes.disabled
          ? `<div class="card"><b>Turned off after crashing twice</b> (${esc(str(crashes.lastContext, ''))}).<div class="acts"><button type="button" data-act="reset-crashes">Turn back on</button></div></div>`
          : ''
      }
      <h2>Sample</h2>
      <div class="acts">${[...SAMPLES.map((s) => [s.id, s.title] as const), ['custom', 'Your text'] as const]
        .map(([id, title]) => `<button type="button" data-act="sample" data-id="${id}" class="${id === sampleId ? 'on' : ''}">${esc(title)}</button>`)
        .join('')}</div>
      ${
        sampleId === 'custom'
          ? `<textarea data-act-input="custom" placeholder="Paste a few paragraphs from a chapter. Emotions and speakers are guessed from cue words (said angrily, whispered, laughed…).">${esc(customText)}</textarea>`
          : ''
      }
      <div class="muted" style="margin-top:6px">${current.length} lines · ${current
        .slice(0, 4)
        .map((l) => `${esc(l.text.slice(0, 60))}${l.text.length > 60 ? '…' : ''}<span class="xtag">${esc(l.role)}</span><span class="xtag">${esc(l.style ?? l.emotion)}</span>`)
        .join('<br>')}${current.length > 4 ? '<br>…' : ''}</div>
      <div class="acts"><button type="button" data-act="play-kokoro">▶ Same sample with Kokoro (as today)</button></div>
      <h2>Engines</h2>
      ${engines.map(engineCard).join('') || '<div class="muted">–</div>'}
      <h2>Now playing</h2>
      ${sessionView(obj(st.session))}
      <h2>Speed test</h2>
      ${speedView(obj(st.speedTest))}
      <h2>Device</h2>
      <div class="kv">
        <span>Thermal</span><span>${esc(str(dev.thermal))}${dev.lowPower ? ' · Low Power Mode' : ''}</span>
        <span>Memory (app)</span><span>${fmt(dev.memoryMB)} MB · ${fmt(dev.availableMB)} MB available</span>
        <span>Free storage</span><span>${fmt(st.freeMB)} MB</span>
        <span>Kokoro</span><span>${esc(str(st.kokoro))}</span>
        <span>Memory warnings</span><span>${fmt(st.memoryWarnings)}</span>
        <span>Crashes (experimental)</span><span>${fmt(crashes.total)} total, ${fmt(crashes.consecutive)} in a row</span>
        <span>iOS</span><span>${esc(str(dev.os))}</span>
      </div>
      <div class="acts">
        <button type="button" data-act="unload">Free the model now</button>
        <button type="button" data-act="copy">Copy report</button>
      </div>`;
  };

  const apply = (p: Promise<Obj>, okMessage = ''): void => {
    message = okMessage;
    messageIsError = false;
    render();
    void p
      .then((s) => {
        st = obj(s);
        unavailable = false;
      })
      .catch((err: unknown) => {
        message = err instanceof Error ? err.message : String(err);
        messageIsError = true;
      })
      .finally(render);
  };

  /** A call whose answer isn't the status itself (Import voice…, ▶ on a voice): `done` makes the message. */
  const call = (p: Promise<Obj>, done: (r: Obj) => string): void => {
    message = '';
    messageIsError = false;
    render();
    void p
      .then((r) => {
        const s = obj(r.status && typeof r.status === 'object' ? r.status : r);
        if (Array.isArray(s.engines)) st = s;
        message = done(r);
      })
      .catch((err: unknown) => {
        message = err instanceof Error ? err.message : String(err);
        messageIsError = true;
      })
      .finally(render);
  };

  // Personal flavor: the narrator voice for Chatterbox Nano (built-in or imported; voice-import.ts). The store
  // flavor's bundle compiles it out; an app without voice import sends no `voices` and the section stays hidden.
  const voices =
    __FLAVOR__ === 'personal'
      ? createVoiceSection({
          plugin: ExpressiveVoice,
          status: () => st,
          apply,
          call,
          message: (text, error) => {
            message = text;
            messageIsError = error;
            render();
          },
          render,
          root,
        })
      : null;

  const refresh = (): void => {
    void ExpressiveVoice.status()
      .then((s) => {
        st = obj(s);
        unavailable = false;
      })
      .catch(() => {
        unavailable = true;
      })
      .finally(() => {
        // Don't re-render under the user's fingers while they type (a re-render on blur would also eat the
        // tap that caused the blur, e.g. Play right after pasting).
        const typing = document.activeElement?.tagName;
        // While a voice is being renamed the list stays put too (its Save button must not move).
        if (typing !== 'TEXTAREA' && typing !== 'INPUT' && !voices?.editing()) render();
      });
  };

  const sampleName = (): string => (sampleId === 'custom' ? 'custom' : sampleId);

  root.addEventListener('input', (ev) => {
    const el = ev.target as HTMLElement;
    if (el.dataset.actInput === 'custom') customText = (el as HTMLTextAreaElement).value;
    voices?.input(el);
  });
  root.addEventListener('keydown', (ev) => voices?.key(ev));

  root.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const id = el.dataset.id ?? '';
    const act = el.dataset.act ?? '';
    if (act !== 'download' && act !== 'remove') armed = '';
    if (voices?.click(act, id)) return;
    switch (act) {
      case 'close':
        open = false;
        showMessage = null;
        window.clearInterval(poll);
        root.remove();
        style.remove();
        return;
      case 'sample':
        sampleId = id as SampleId;
        render();
        return;
      case 'arm-download':
        armed = `download:${id}`;
        render();
        return;
      case 'arm-remove':
        armed = `remove:${id}`;
        render();
        return;
      case 'download':
        armed = '';
        apply(ExpressiveVoice.download({ engine: id }));
        return;
      case 'cancel':
        apply(ExpressiveVoice.cancelDownload({ engine: id }));
        return;
      case 'remove':
        armed = '';
        apply(ExpressiveVoice.remove({ engine: id }), 'Model deleted.');
        return;
      case 'play':
      case 'play-kokoro': {
        const ls = lines();
        if (ls.length === 0) {
          message = 'No text: pick a sample or paste some text.';
          messageIsError = true;
          render();
          return;
        }
        apply(ExpressiveVoice.play({ engine: act === 'play-kokoro' ? 'kokoro' : id, sample: sampleName(), lines: ls }));
        return;
      }
      case 'speed': {
        const ls = lines();
        if (ls.length === 0) {
          message = 'No text: pick a sample or paste some text.';
          messageIsError = true;
          render();
          return;
        }
        apply(ExpressiveVoice.speedTest({ engine: id, sample: sampleName(), lines: ls }));
        return;
      }
      case 'cancel-speed':
        apply(ExpressiveVoice.cancelSpeedTest());
        return;
      case 'stop':
        apply(ExpressiveVoice.stop());
        return;
      case 'unload':
        apply(ExpressiveVoice.unload(), 'Model released.');
        return;
      case 'reset-crashes':
        apply(ExpressiveVoice.resetCrashes());
        return;
      case 'copy':
        void navigator.clipboard
          .writeText(JSON.stringify(st, null, 2))
          .then(() => (el.textContent = 'Copied'))
          .catch(() => (el.textContent = 'Copy failed'));
        return;
      default:
    }
  });
  render();
  refresh();
  poll = window.setInterval(refresh, 1000);
}
