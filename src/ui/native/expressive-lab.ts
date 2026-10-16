/**
 * More › Developer › Voice Models, also Voice Lab › Experimental engines.
 * EXPERIMENTAL expressive voices on the iPhone (docs/expressive-tts.md): download a model on demand (Wi-Fi,
 * size shown, confirmed with the native alert), play the same sample with it and with Kokoro (A/B), run a speed test
 * (load, time to first audio, × real time, memory, thermal), copy the report. Narration itself is unchanged. Its
 * numbers refresh once a second only while something runs (a download, a model loading, a sample, a speed test).
 * Personal flavor: "Narrator voice" — voices designed on the PC (.tnvoice), imported and chosen for
 * Chatterbox Nano (voice-import.ts, docs/voice-import.md).
 * Native side: ExpressiveVoicePlugin.swift (ExpressiveService + ExpressiveSpeechEngine, Kokoro fallback).
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { annotate, SAMPLES, type ExpressiveLine } from './expressive-samples.ts';
import { confirmStep, icon, panel } from './panel.ts';
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
  /** float32: a 32-bit float WAV (the exact samples that played) instead of 16-bit. */
  recordStart(o?: { float32?: boolean }): Promise<{ recording: boolean; float32?: boolean }>;
  /** sampleRate: the rate of the read the WAV holds (24 kHz, or 44.1 kHz with her studio); absent in older builds. */
  recordStop(): Promise<{ saved: boolean; bytes: number; sampleRate?: number; float32?: boolean }>;
  shareRecording(): Promise<void>;
  importVoice(): Promise<Obj>;
  selectVoice(o: { id: string | null }): Promise<Obj>;
  renameVoice(o: { id: string; name: string }): Promise<Obj>;
  deleteVoice(o: { id: string }): Promise<Obj>;
  playVoiceSample(o: { id: string | null }): Promise<Obj>;
  /** placement: only where Core ML runs her studio's models (MLComputePlan), on its own. */
  studioTest(o?: { placement?: boolean }): Promise<Obj>;
  /** Stop during the studio speed test: native cancels it (it then answers `stopped`). */
  studioTestStop(): Promise<Obj>;
  studioEnable(o: { on: boolean }): Promise<Obj>;
  /** Nephis's model packs on this iPhone (voice-packs.ts normalizes the answer); select/delete answer the same. */
  nephisPacks(): Promise<Obj>;
  selectNephisPack(o: { id: string }): Promise<Obj>;
  deleteNephisPack(o: { id: string }): Promise<Obj>;
  /** A pack reads narration or quoted dialogue (over its pack.json "role"); answers the packs. */
  setNephisPackRole(o: { id: string; role: 'narrator' | 'dialogue' }): Promise<Obj>;
  /** The dialogue pack she reads quoted dialogue with; null: the narrator pack reads it too. Answers the packs. */
  selectNephisDialogue(o: { id: string | null }): Promise<Obj>;
  /** Voice speed test (VoiceSpeedTest.swift, voice-speed.ts): renders the test passage the way Listen does, without
   * playing it, and answers the report ({ran: false, error} when it can't run); progress as the "voiceSpeedTest" event.
   * `banked` (seconds): the steady-state run, as if that much audio were already waiting (Developer: 60). */
  voiceSpeedTest(o?: { banked?: number }): Promise<Obj>;
  /** Stop: no new call starts; the report then says "stopped". */
  voiceSpeedTestStop(): Promise<{ stopping?: boolean }>;
  /** Plays the last rendered passage ({stop: true}: stops it). */
  voiceSpeedTestPlay(o?: { stop?: boolean }): Promise<{ playing: boolean; seconds?: number }>;
}

/** Events (kept out of the method list above, which mirrors the Swift plugin's methods). */
interface ExpressiveVoiceEvents {
  /** A .tnvoice opened with "Open in TachiNovel" was imported (or refused). */
  addListener(event: 'voiceImport', fn: (e: Obj) => void): Promise<PluginListenerHandle>;
  /** The Voice speed test as it goes: {step, text, done, total}. */
  addListener(event: 'voiceSpeedTest', fn: (e: Obj) => void): Promise<PluginListenerHandle>;
}

export const ExpressiveVoice = registerPlugin<ExpressiveVoicePlugin & ExpressiveVoiceEvents>('ExpressiveVoice');

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
  const pn = panel('Voice Models', 'expressive-lab');
  const root = pn.root;
  root.classList.add('lab');
  const body = pn.body;

  let st: Obj = {};
  let sampleId: SampleId = 'dialogue';
  let customText = '';
  let message = '';
  let messageIsError = false;
  let unavailable = false;
  let poll = 0;
  let closed = false;
  if (opts.message) {
    message = opts.message;
    messageIsError = opts.error === true;
  }
  showMessage = (text, error) => {
    message = text;
    messageIsError = error;
    render();
  };

  const engineOf = (id: string): Obj => arr(st.engines).find((e) => e.id === id) ?? {};

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
      acts = `<button type="button" data-act="cancel" data-id="${esc(id)}">Cancel Download</button>`;
    } else if (!installed) {
      if (dl.state === 'failed') state = `<span class="err">${esc(str(dl.error, 'Download failed'))}</span>`;
      else state = `Not downloaded${typeof e.bytesOnDisk === 'number' && e.bytesOnDisk > 0 ? ` (${mb(e.bytesOnDisk)} so far)` : ''}.`;
      acts = `<button type="button" data-act="download" data-id="${esc(id)}">Download ${mb(e.bytes)}</button>`;
    } else {
      const ls = str(load.state, 'unloaded');
      const loadText = ls === 'ready' ? 'loaded' : ls === 'loading' ? 'loading… (the first load compiles the model, can take a minute)' : ls === 'failed' ? `load failed: ${str(load.error)}` : 'not loaded';
      state = `Downloaded (${mb(e.bytes)}) · ${esc(loadText)}${typeof e.lastLoadMs === 'number' ? ` · last load ${fmt(e.lastLoadMs)} ms${e.lastLoadCold ? ' (cold)' : ' (warm)'}` : ''}`;
      acts = [
        `<button type="button" data-act="play" data-id="${esc(id)}">${icon('play.fill', 14)} Play Sample</button>`,
        `<button type="button" data-act="speed" data-id="${esc(id)}">Speed Test</button>`,
        `<button type="button" class="danger" data-act="remove" data-id="${esc(id)}">Delete Model</button>`,
      ].join('');
    }
    return `<div class="lab-card" data-engine="${esc(id)}">
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
      <div class="acts"><button type="button" data-act="stop">${icon('stop.fill', 14)} Stop</button></div>
      <h2>Lines</h2>
      <table class="lab-t"><tr><th>#</th><th class="t">text</th><th>voice</th><th>synth</th><th>audio</th><th>×RT</th></tr>
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
      <div class="acts">${t.running ? '<button type="button" data-act="cancel-speed">Cancel Speed Test</button>' : ''}</div>
      <table class="lab-t"><tr><th>#</th><th>chars</th><th>first</th><th>synth</th><th>audio</th><th>×RT</th></tr>
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
      <p class="note" style="padding-bottom:8px">Pocket TTS is Nephis’s voice: download it once (Wi-Fi). The other engines are experiments.</p>
      ${unavailable ? '<div class="lab-card err">Experimental engines aren’t available in this build.</div>' : ''}
      ${message ? `<div class="lab-card${messageIsError ? ' err' : ''}" data-testid="xlab-message" data-error="${messageIsError ? 1 : 0}" role="status">${esc(message)}</div>` : ''}
      ${voices?.view() ?? ''}
      ${
        crashes.disabled
          ? `<div class="lab-card"><b>${esc(str(crashes.offLine, 'Turned off after crashing twice.'))}</b> (${esc(str(crashes.lastContext, ''))})<div class="acts"><button type="button" data-act="reset-crashes">Turn Nephis Back On</button></div></div>`
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
      <div class="acts"><button type="button" data-act="play-kokoro">${icon('play.fill', 14)} Same Sample With Kokoro</button></div>
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
        <span>Crashes (experimental)</span><span>${fmt(crashes.total)} total, ${fmt(crashes.consecutive)} in a row, ${fmt(crashes.notCounted)} ends not counted</span>
        <span>iOS</span><span>${esc(str(dev.os))}</span>
      </div>
      <div class="acts">
        <button type="button" data-act="unload">Free the Model Now</button>
        <button type="button" data-act="copy">Copy Report</button>
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
      .finally(() => {
        render();
        schedule(true);
      });
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
      .finally(() => {
        render();
        schedule(true);
      });
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
          confirm: (title, text, action) => confirmStep(title, text, action),
          root,
        })
      : null;

  /** Something is going on whose numbers change: a download, a model loading, a sample playing, a speed test. */
  const running = (s: Obj): boolean =>
    arr(s.engines).some((e) => obj(e.download).state === 'downloading' || obj(e.load).state === 'loading') ||
    obj(s.session).state === 'playing' ||
    obj(s.speedTest).running === true;

  /** The next status read: in a second while something runs (or once after a tap, `soon`), else none. */
  function schedule(soon = false): void {
    window.clearTimeout(poll);
    if (!closed && (soon || running(st))) poll = window.setTimeout(refresh, 1000);
  }

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
        schedule();
      });
  };

  pn.onClose(() => {
    open = false;
    closed = true;
    showMessage = null;
    window.clearTimeout(poll);
  });

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
    if (voices?.click(act, id)) return;
    switch (act) {
      case 'sample':
        sampleId = id as SampleId;
        render();
        return;
      case 'download': {
        const e = engineOf(id);
        void confirmStep(`Download ${str(e.title, 'the Model')}?`, `${mb(e.bytes)} on this iPhone. Use Wi-Fi and keep TachiNovel open until it’s done.`, 'Download', false).then((yes) => {
          if (yes) apply(ExpressiveVoice.download({ engine: id }));
        });
        return;
      }
      case 'cancel':
        apply(ExpressiveVoice.cancelDownload({ engine: id }));
        return;
      case 'remove': {
        const e = engineOf(id);
        void confirmStep(`Delete ${str(e.title, 'the Model')}?`, `Frees ${mb(e.bytes)}. You can download it again.`, 'Delete').then((yes) => {
          if (yes) apply(ExpressiveVoice.remove({ engine: id }), 'Model deleted.');
        });
        return;
      }
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
}
