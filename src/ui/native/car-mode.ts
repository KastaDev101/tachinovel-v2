/**
 * Listen player: a big-button, glanceable screen for listening (also while driving).
 *
 *  - Recently read novels; a tap continues where you stopped (Narration.playNovel) with the novel's voice:
 *    Kokoro on device, the Apple voice standing in when Kokoro can't keep up.
 *  - Voice: the novel's Kokoro voice (picker with ▶ samples) and its pronunciations (voices-ui.ts).
 *  - PC-narrated audio (the iCloud Drive "TachiNovel Audio" folder, tachinovel-narrator) appears only with
 *    Settings › Voices › Advanced › "Use PC audio when available" (off by default).
 *  - Transport: −15 s / play-pause / +15 s / next chapter, scrubbable progress.
 *  - Speed: a slider (0.5–2.5×, 0.05 steps) with preset chips (a chip snaps the slider; the slider lights up
 *    the chip it sits on), and "Voice volume" (0–150 %; a limiter keeps it clean above 100 %). Both are
 *    saved natively and apply to every voice (Kokoro, the system voice, PC audio).
 * Lock screen, Control Center, headphones and car Bluetooth controls work without this screen (native).
 * Opened from the mini player and from More › Listen in the Car.
 */
import { sharedClient } from '../capacitor-client.ts';
import { formatSpeed, presetFor, snapSpeed, SPEED_MAX, SPEED_MIN, SPEED_PRESETS, SPEED_STEP, VOLUME_MAX_PERCENT, volumePercent } from './listen-controls.ts';
import { Narration, type AudioNovelInfo, type NarrationState } from './narration.ts';
import { openVoicePicker, voiceLabel } from './voices-ui.ts';

const CSS = `
.tn-car{position:fixed;inset:0;z-index:80;background:#121215;color:#f2f2f7;display:flex;flex-direction:column;
  padding:env(safe-area-inset-top) max(16px,env(safe-area-inset-right)) env(safe-area-inset-bottom) max(16px,env(safe-area-inset-left));
  font:17px -apple-system,system-ui;-webkit-user-select:none;user-select:none;transform:translateY(100%);transition:transform .32s cubic-bezier(.2,.8,.2,1)}
.tn-car.is-open{transform:none}
.tn-car[hidden]{display:none}
.tn-car button{font:inherit;color:inherit;background:transparent;border:0;-webkit-tap-highlight-color:transparent}
.tn-car .hd{display:flex;align-items:center;justify-content:space-between;height:52px}
.tn-car .hd h1{font-size:20px;font-weight:600;margin:0}
.tn-car .x{width:44px;height:44px;border-radius:22px;background:rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center}
.tn-car .now{background:#1f1f25;border-radius:20px;padding:16px;margin:8px 0 12px}
.tn-car .t1{font-size:20px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tn-car .t2{color:#a1a1aa;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tn-car .eng{display:inline-block;font-size:12px;padding:2px 8px;border-radius:9px;background:rgba(168,180,255,.18);color:#c7cdff;margin-top:6px}
.tn-car .bar{height:28px;display:flex;align-items:center;margin-top:10px}
.tn-car .bar div{height:6px;border-radius:3px;background:rgba(255,255,255,.15);flex:1;position:relative;overflow:hidden}
.tn-car .bar i{position:absolute;left:0;top:0;bottom:0;background:#a8b4ff;border-radius:3px}
.tn-car .tm{display:flex;justify-content:space-between;color:#a1a1aa;font-size:13px;font-variant-numeric:tabular-nums}
.tn-car .ctl{display:flex;justify-content:space-between;align-items:center;margin-top:10px}
.tn-car .ctl button{width:68px;height:68px;border-radius:34px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.08)}
.tn-car .ctl .pp{width:88px;height:88px;border-radius:44px;background:#a8b4ff;color:#15151a}
.tn-car .ctl button:active{transform:scale(.94)}
.tn-car .spd{display:flex;gap:6px;margin-top:8px;justify-content:space-between}
.tn-car .spd button{flex:1;padding:8px 0;border-radius:14px;background:rgba(255,255,255,.08);font-size:15px;font-variant-numeric:tabular-nums}
.tn-car .spd button.on{background:#a8b4ff;color:#15151a}
.tn-car .lc{background:#1f1f25;border-radius:20px;padding:12px 16px 14px;margin:0 0 12px}
.tn-car .lc-row{display:flex;justify-content:space-between;align-items:baseline;margin-top:6px;font-size:15px}
.tn-car .lc-row label{font-weight:600}
.tn-car .lc-v{color:#c7cdff;font-variant-numeric:tabular-nums}
.tn-car .lc-sld{width:100%;margin:8px 0 2px;accent-color:#a8b4ff;height:28px}
.tn-car .list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;margin:0 -4px;padding:0 4px 12px}
.tn-car .sec{color:#a1a1aa;font-size:13px;text-transform:uppercase;letter-spacing:.04em;margin:14px 4px 6px}
.tn-car .row{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:12px;border-radius:14px;background:#1b1b20;margin-bottom:8px;min-height:64px}
.tn-car .row:active{background:#26262d}
.tn-car .row img,.tn-car .row .ph{width:40px;height:60px;border-radius:6px;object-fit:cover;background:#2a2a31;flex:none}
.tn-car .row b{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tn-car .row span{display:block;color:#a1a1aa;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tn-car .row div{min-width:0;flex:1}
.tn-car .link{width:100%;padding:16px;border-radius:16px;background:#a8b4ff;color:#15151a;font-weight:600;margin-top:6px}
.tn-car .note{color:#a1a1aa;font-size:14px;margin:8px 4px;line-height:1.4}
.tn-car .folder{display:flex;justify-content:space-between;align-items:center;color:#a1a1aa;font-size:14px;margin:4px 4px 0}
.tn-car .folder button{color:#a8b4ff;padding:8px 0 8px 12px}
.tn-car .voice{display:flex;align-items:center;justify-content:space-between;width:100%;margin-top:12px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.06);font-size:15px}
.tn-car .voice span{color:#a1a1aa}
`;

const ICON = {
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  play: '<svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  back15: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">15</text></svg>',
  fwd15: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">15</text></svg>',
  next: '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M5 5v14l9-7zM15 5h3v14h-3z"/></svg>',
};


interface Recent {
  pluginId: string;
  path: string;
  novelName: string;
  chapterName: string;
  cover?: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function fmt(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return '–:––';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface CarMode {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

export function installCarMode(): CarMode {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const root = document.createElement('div');
  root.className = 'tn-car';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Car player');
  root.dataset.testid = 'car-player';
  document.body.append(root);

  let state: NarrationState = { status: 'idle' };
  /** Listen speed and "Voice volume" (saved natively, see listen-controls.ts). */
  let rate = 1;
  let volume = 1;
  /** A slider is being dragged: the 1 s refresh must not rebuild it under the finger. */
  let dragging = false;
  let renderPending = false;
  let volumeSentAt = 0;
  let volumeTimer = 0;
  let open = false;
  let poll = 0;
  let novels: AudioNovelInfo[] = [];
  let linked = false;
  let folderName = '';
  let recent: Recent[] = [];
  let covers = new Map<string, string>();
  /** Settings › Voices › Advanced › "Use PC audio when available". */
  let usePCAudio = false;

  const active = (): boolean => state.status === 'playing' || state.status === 'paused' || state.status === 'loading';

  function nowHtml(): string {
    if (!active()) return `<div class="now"><div class="t1">Nothing playing</div><div class="t2">Pick a novel below to continue where you stopped.</div></div>`;
    const pos = state.position;
    const dur = state.duration;
    const pct = pos !== undefined && dur ? Math.min(100, (pos / dur) * 100) : 0;
    const engine = voiceLabel(state);
    return `<div class="now">
      <div class="t1">${esc(state.chapterName ?? '')}</div>
      <div class="t2">${esc(novels.find((n) => n.pluginId === state.pluginId && n.novelPath === state.novelPath)?.name ?? recent.find((r) => r.pluginId === state.pluginId && r.path === state.novelPath)?.novelName ?? '')}</div>
      <span class="eng">${engine}${state.status === 'loading' ? ' · loading…' : ''}</span>
      ${state.engine === 'audio' ? `<div class="bar" data-act="seek"><div><i style="width:${pct.toFixed(1)}%"></i></div></div><div class="tm"><span>${fmt(pos)}</span><span>${fmt(dur)}</span></div>` : ''}
      <div class="ctl">
        <button type="button" data-act="back" aria-label="Back 15 seconds">${ICON.back15}</button>
        <button type="button" class="pp" data-act="toggle" aria-label="${state.status === 'playing' ? 'Pause' : 'Play'}">${state.status === 'playing' ? ICON.pause : ICON.play}</button>
        <button type="button" data-act="fwd" aria-label="Forward 15 seconds">${ICON.fwd15}</button>
        <button type="button" data-act="next" aria-label="Next chapter">${ICON.next}</button>
      </div>
      ${state.engine !== 'audio' && state.pluginId && state.novelPath ? `<button type="button" class="voice" data-act="voice"><b>Voice</b><span>${esc(state.voice?.kokoroName ?? 'Kokoro')} ›</span></button>` : ''}
    </div>`;
  }

  function rowHtml(kind: 'audio' | 'recent', pluginId: string, path: string, name: string, sub: string, cover?: string): string {
    const img = cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : '<i class="ph"></i>';
    return `<button type="button" class="row" data-act="novel" data-kind="${kind}" data-plugin="${esc(pluginId)}" data-path="${esc(path)}" data-name="${esc(name)}">${img}<div><b>${esc(name)}</b><span>${esc(sub)}</span></div></button>`;
  }

  function controlsHtml(): string {
    const chip = presetFor(rate);
    const pct = volumePercent(volume);
    return `<div class="lc" data-testid="listen-controls">
      <div class="lc-row"><label for="tn-speed">Speed</label><span class="lc-v" data-speed-val>${formatSpeed(rate)}</span></div>
      <input id="tn-speed" type="range" class="lc-sld" data-act="speed-slider" min="${SPEED_MIN}" max="${SPEED_MAX}" step="${SPEED_STEP}" value="${rate}" aria-valuetext="${formatSpeed(rate)}">
      <div class="spd" role="group" aria-label="Speed presets">${SPEED_PRESETS.map((s) => `<button type="button" data-act="speed" data-v="${s}" class="${s === chip ? 'on is-selected' : ''}" aria-pressed="${s === chip}">${s}×</button>`).join('')}</div>
      <div class="lc-row"><label for="tn-volume">Voice volume</label><span class="lc-v" data-volume-val>${pct}%</span></div>
      <input id="tn-volume" type="range" class="lc-sld" data-act="volume" min="0" max="${VOLUME_MAX_PERCENT}" step="5" value="${pct}" aria-valuetext="${pct}%">
    </div>`;
  }

  /** Slider moved: labels and the matching chip, without rebuilding anything. */
  function reflectControls(): void {
    const chip = presetFor(rate);
    const sv = root.querySelector('[data-speed-val]');
    if (sv) sv.textContent = formatSpeed(rate);
    root.querySelector('[data-act="speed-slider"]')?.setAttribute('aria-valuetext', formatSpeed(rate));
    for (const b of root.querySelectorAll<HTMLElement>('[data-act="speed"]')) {
      const on = Number(b.dataset.v) === chip;
      b.classList.toggle('on', on);
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const vv = root.querySelector('[data-volume-val]');
    if (vv) vv.textContent = `${volumePercent(volume)}%`;
    root.querySelector('[data-act="volume"]')?.setAttribute('aria-valuetext', `${volumePercent(volume)}%`);
  }

  function sendVolume(final: boolean): void {
    window.clearTimeout(volumeTimer);
    const now = Date.now();
    if (final || now - volumeSentAt > 150) {
      volumeSentAt = now;
      void Narration.setVoiceSettings({ volume }).catch(() => undefined);
    } else {
      volumeTimer = window.setTimeout(() => sendVolume(true), 160);
    }
  }

  function render(): void {
    if (dragging) {
      renderPending = true;
      return;
    }
    const audioKeys = new Set(novels.map((n) => n.key));
    const folder = !usePCAudio
      ? ''
      : linked
        ? `<div class="folder"><span>Audio folder: ${esc(folderName || 'linked')}</span><button type="button" data-act="pick">Change</button></div>`
        : `<button type="button" class="link" data-act="pick">Link “TachiNovel Audio” folder</button>
         <p class="note">Choose iCloud Drive › TachiNovel Audio once. Chapters the PC narrated then play here; other chapters use Kokoro.</p>`;
    const audioRows = novels
      .map((n) => {
        const saved = n.saved ? n.chapters.find((c) => c.chapterPath === n.saved?.chapterPath)?.title : undefined;
        const sub = saved ? `Resume: ${saved}` : `${n.chapters.length} narrated chapter${n.chapters.length === 1 ? '' : 's'}`;
        return rowHtml('audio', n.pluginId, n.novelPath, n.name, sub, covers.get(n.key));
      })
      .join('');
    const recentRows = recent
      .filter((r) => !audioKeys.has(`${r.pluginId}:${r.path}`))
      .map((r) => rowHtml('recent', r.pluginId, r.path, r.novelName, r.chapterName, r.cover))
      .join('');
    root.innerHTML = `
      <div class="hd"><h1>Listen</h1><button type="button" class="x" data-act="close" aria-label="Close">${ICON.close}</button></div>
      ${nowHtml()}
      ${controlsHtml()}
      <div class="list">
        ${folder}
        ${audioRows ? `<div class="sec">Narrated on the PC</div>${audioRows}` : usePCAudio && linked ? '<p class="note">No narrated chapters in the folder yet.</p>' : ''}
        ${recentRows ? `<div class="sec">Continue listening</div>${recentRows}` : '<p class="note">Open a chapter and tap the headphones to start listening.</p>'}
      </div>`;
  }

  async function load(refresh: boolean): Promise<void> {
    const settings = await Narration.voiceSettings().catch(() => null);
    usePCAudio = settings?.usePCAudio === true;
    if (typeof settings?.speed === 'number' && !dragging) rate = snapSpeed(settings.speed);
    if (typeof settings?.volume === 'number' && !dragging) volume = Math.min(1.5, Math.max(0, settings.volume));
    const noAudio = { linked: false, novels: [] as AudioNovelInfo[] };
    const [lib, folder, hist, library] = await Promise.all([
      usePCAudio ? Narration.audioLibrary({ refresh }).catch(() => noAudio) : Promise.resolve(noAudio),
      usePCAudio ? Narration.audioFolder().catch(() => ({ linked: false, name: null })) : Promise.resolve({ linked: false, name: null }),
      sharedClient().call('history.list', { limit: 12 }).catch(() => []),
      sharedClient().call('library.list').catch(() => []),
    ]);
    novels = lib.novels;
    linked = folder.linked;
    folderName = folder.name ?? '';
    recent = (hist as { pluginId: string; path: string; novelName: string; chapterName: string; cover?: string }[]).map((h) => ({
      pluginId: h.pluginId,
      path: h.path,
      novelName: h.novelName,
      chapterName: h.chapterName,
      ...(h.cover ? { cover: h.cover } : {}),
    }));
    covers = new Map((library as { key: string; cover?: string }[]).filter((e) => e.cover).map((e) => [e.key, e.cover as string]));
    if (open) render();
  }

  async function refreshState(): Promise<void> {
    state = await Narration.state().catch(() => state);
    if (open) render();
  }

  root.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const act = el.dataset.act ?? '';
    switch (act) {
      case 'close':
        return api.close();
      case 'toggle':
        void (state.status === 'playing' ? Narration.pause() : Narration.resume());
        return;
      case 'back':
        void Narration.skip({ unit: state.engine === 'audio' ? 'seconds' : 'paragraph', count: state.engine === 'audio' ? -15 : -1 });
        return;
      case 'fwd':
        void Narration.skip({ unit: state.engine === 'audio' ? 'seconds' : 'paragraph', count: state.engine === 'audio' ? 15 : 1 });
        return;
      case 'next':
        void Narration.skip({ unit: 'paragraph', count: 100_000 });
        return;
      case 'speed':
        rate = snapSpeed(Number(el.dataset.v) || 1);
        void Narration.setVoiceSettings({ speed: rate }).catch(() => undefined);
        render();
        return;
      case 'seek': {
        if (!state.duration) return;
        const r = el.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, ((ev as MouseEvent).clientX - r.left) / r.width));
        void Narration.seek({ seconds: frac * state.duration });
        return;
      }
      case 'pick':
        void Narration.pickAudioFolder().then(() => load(true));
        return;
      case 'voice': {
        if (!state.pluginId || !state.novelPath) return;
        const name = recent.find((r) => r.pluginId === state.pluginId && r.path === state.novelPath)?.novelName ?? '';
        openVoicePicker({ pluginId: state.pluginId, novelPath: state.novelPath, name }, () => void refreshState());
        return;
      }
      case 'novel': {
        const pluginId = el.dataset.plugin ?? '';
        const novelPath = el.dataset.path ?? '';
        const cover = covers.get(`${pluginId}:${novelPath}`);
        void Narration.playNovel({ pluginId, novelPath, novelName: el.dataset.name ?? '', ...(cover ? { coverUrl: cover } : {}) });
        return;
      }
      default:
    }
  });

  // Sliders: live labels while dragging; speed is applied when released (a new speed restarts the sentence),
  // the volume follows the finger (throttled).
  root.addEventListener('pointerdown', (ev) => {
    if ((ev.target as Element).matches('input[type="range"]')) dragging = true;
  });
  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    if (renderPending) {
      renderPending = false;
      render();
    }
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);
  root.addEventListener('input', (ev) => {
    const el = ev.target as HTMLInputElement;
    if (el.dataset.act === 'speed-slider') rate = snapSpeed(Number(el.value));
    else if (el.dataset.act === 'volume') {
      volume = Math.min(1.5, Math.max(0, Number(el.value) / 100));
      sendVolume(false);
    } else return;
    reflectControls();
  });
  root.addEventListener('change', (ev) => {
    const el = ev.target as HTMLInputElement;
    if (el.dataset.act === 'speed-slider') {
      rate = snapSpeed(Number(el.value));
      void Narration.setVoiceSettings({ speed: rate }).catch(() => undefined);
    } else if (el.dataset.act === 'volume') {
      volume = Math.min(1.5, Math.max(0, Number(el.value) / 100));
      sendVolume(true);
    } else return;
    reflectControls();
    endDrag();
  });

  void Narration.addListener('state', (s) => {
    state = { ...state, ...s };
    if (open) render();
  });

  const api: CarMode = {
    get isOpen() {
      return open;
    },
    open() {
      if (open) return;
      open = true;
      root.hidden = false;
      render();
      requestAnimationFrame(() => root.classList.add('is-open'));
      void load(false);
      void refreshState();
      poll = window.setInterval(() => void refreshState(), 1000);
    },
    close() {
      if (!open) return;
      open = false;
      root.classList.remove('is-open');
      window.clearInterval(poll);
      setTimeout(() => {
        if (!open) root.hidden = true;
      }, 340);
    },
  };
  return api;
}
