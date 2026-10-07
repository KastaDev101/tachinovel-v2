/**
 * Voices UI (v2 additions over the unchanged v1 UI):
 *
 *  - Settings › Voices (a "Voices" row injected into v1's More list, see v1-hooks.ts): the six Kokoro
 *    voices with ▶ samples and the default one, the Apple voice that stands in when Kokoro can't keep up
 *    (with the "download a Premium voice" hint), Kokoro on/off, pronunciations, In the car (what the car's
 *    side buttons do, prepared audio storage), and Advanced › "Use PC audio when available" (off by
 *    default; the PC narrator is sidelined).
 *  - The voice picker for one novel (from the Listen player): its own voice or the default.
 *  - The pronunciation editor (global, or one novel): word → respelling and/or Kokoro phonemes, the same
 *    lexicon format the PC narrator uses (v1 frontend.ts), so a narrator lexicon can be pasted in.
 *
 * Vanilla DOM like car-mode.ts: these screens live outside v1's navigation stack.
 */
import { isKokoroPhonemes, validateLexicon, type Lexicon, type LexiconEntry } from '@v1tts/frontend.ts';
import { callCore } from '../capacitor-client.ts';
import { normalizeDriveStatus, storageLine } from './drive-status.ts';
import { voiceLabel as describeVoice } from './listen-controls.ts';
import { Narration, type CarButtons, type KokoroVoiceInfo, type NarrationState, type VoiceSettingsInfo } from './narration.ts';
import { fs } from './type.ts';

const CSS = `
.tn-v{position:fixed;inset:0;z-index:90;background:#121215;color:#f2f2f7;display:flex;flex-direction:column;
  padding:env(safe-area-inset-top) max(16px,env(safe-area-inset-right)) env(safe-area-inset-bottom) max(16px,env(safe-area-inset-left));
  font:${fs(16)} -apple-system,system-ui;-webkit-user-select:none;user-select:none;transform:translateX(100%);transition:transform .32s cubic-bezier(.2,.8,.2,1)}
.tn-v.is-open{transform:none}
.tn-v[hidden]{display:none}
.tn-v button{font:inherit;color:inherit;background:transparent;border:0;-webkit-tap-highlight-color:transparent}
.tn-v .hd{display:flex;align-items:center;gap:8px;min-height:52px;flex:none}
.tn-v .hd h1{font-size:${fs(20)};font-weight:600;margin:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tn-v .x{width:44px;height:44px;border-radius:22px;background:rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;flex:none}
.tn-v .body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:24px}
.tn-v .sec{color:#a1a1aa;font-size:${fs(13)};text-transform:uppercase;letter-spacing:.04em;margin:18px 4px 6px}
.tn-v .card{background:#1c1c22;border-radius:14px;overflow:hidden}
.tn-v .row{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:12px 14px;min-height:52px;border-bottom:1px solid rgba(255,255,255,.06)}
.tn-v .row:last-child{border-bottom:0}
.tn-v .row:active{background:#26262d}
.tn-v .row .main{flex:1;min-width:0}
.tn-v .row b{display:block;font-weight:600}
.tn-v .row span.sub{display:block;color:#a1a1aa;font-size:${fs(13)};margin-top:2px}
.tn-v .play{width:40px;height:40px;border-radius:20px;background:rgba(168,180,255,.16);color:#c7cdff;display:flex;align-items:center;justify-content:center;flex:none}
.tn-v .play.is-busy{opacity:.6}
.tn-v .check{color:#a8b4ff;font-size:${fs(20)};width:22px;text-align:center;flex:none}
.tn-v .note{color:#a1a1aa;font-size:${fs(13)};line-height:1.4;margin:6px 4px 0}
.tn-v .warn{color:#ffd28a}
.tn-v .btn{display:block;width:100%;padding:13px;border-radius:12px;background:#a8b4ff;color:#15151a;font-weight:600;margin-top:10px;text-align:center}
.tn-v .btn.alt{background:rgba(255,255,255,.08);color:#f2f2f7}
.tn-v .sw{appearance:none;-webkit-appearance:none;width:51px;height:31px;border-radius:16px;background:#39393d;position:relative;flex:none;transition:background .2s}
.tn-v .sw:checked{background:#a8b4ff}
.tn-v .sw::after{content:"";position:absolute;top:2px;left:2px;width:27px;height:27px;border-radius:14px;background:#fff;transition:transform .2s}
.tn-v .sw:checked::after{transform:translateX(20px)}
.tn-v input[type=text],.tn-v textarea{width:100%;box-sizing:border-box;background:#26262d;border:0;border-radius:10px;color:#f2f2f7;font:max(16px,${fs(16)}) -apple-system,system-ui;padding:10px 12px;margin-top:8px;-webkit-user-select:text;user-select:text}
.tn-v textarea{min-height:110px;font-family:ui-monospace,Menlo,monospace;font-size:${fs(13)}}
.tn-v .del{color:#ff8a8a;width:36px;height:36px;flex:none}
.tn-v .chips{display:flex;gap:8px;flex:1}
.tn-v .chip{flex:1;padding:11px 0;border-radius:12px;background:rgba(255,255,255,.08);text-align:center;font-weight:600}
.tn-v .chip[aria-pressed="true"]{background:#a8b4ff;color:#15151a}
.tn-v .link{color:#a8b4ff;padding:6px 0;flex:none}
.tn-v .toast{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 24px);transform:translateX(-50%);background:rgba(40,40,48,.95);color:#fff;padding:10px 16px;border-radius:12px;font-size:${fs(14)};z-index:95;max-width:86%}
`;

const ICON = {
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
};

/** Window event after a voice setting changed here (v1-hooks.ts re-checks "Use PC audio"). */
export const VOICE_SETTINGS_CHANGED = 'tn-voice-settings';

function changed(): void {
  window.dispatchEvent(new Event(VOICE_SETTINGS_CHANGED));
}

export const SAMPLE_TEXT = 'The rain had stopped by the time we reached the old bridge, and for a moment the whole city held its breath.';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

let styled = false;
function ensureStyle(): void {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
}

export function toast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'tn-v toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

/** Subtitle for the mini player / Listen player: which voice is speaking. */
export function voiceLabel(s: Pick<NarrationState, 'engine' | 'voice' | 'status' | 'prepared'>): string {
  if (s.engine === 'audio' && s.prepared) return `Kokoro · ${s.voice?.kokoroName ?? 'prepared'} · prepared`;
  return describeVoice(s);
}

/** A usable answer from Narration.voiceSettings, or null (no voices: an older build, a mock, an error). */
export function normalizeVoiceSettings(raw: unknown): VoiceSettingsInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<VoiceSettingsInfo>;
  const voices = Array.isArray(r.voices) ? r.voices.filter((v) => typeof v.id === 'string' && typeof v.name === 'string') : [];
  const first = voices[0];
  if (!first) return null;
  const k: Partial<VoiceSettingsInfo['kokoro']> = r.kokoro ?? {};
  return {
    ...r,
    voices,
    defaultVoice: typeof r.defaultVoice === 'string' && voices.some((v) => v.id === r.defaultVoice) ? r.defaultVoice : first.id,
    kokoroEnabled: r.kokoroEnabled !== false,
    usePCAudio: r.usePCAudio === true,
    carButtons: r.carButtons === 'skip15' ? 'skip15' : 'chapters',
    speed: typeof r.speed === 'number' && Number.isFinite(r.speed) ? r.speed : 1,
    volume: typeof r.volume === 'number' && Number.isFinite(r.volume) ? r.volume : 1,
    kokoro: {
      bundled: k.bundled === true,
      status: typeof k.status === 'string' ? k.status : '',
      ready: k.ready === true,
      crashDisabled: k.crashDisabled === true,
      crashes: typeof k.crashes === 'number' ? k.crashes : 0,
      revision: typeof k.revision === 'string' ? k.revision : null,
      bytes: typeof k.bytes === 'number' ? k.bytes : null,
    },
    apple: r.apple ?? { name: 'System voice', quality: 'default', onlyDefault: true },
  };
}

const UNAVAILABLE = '<p class="note">Voices aren’t available right now.</p><button type="button" class="btn alt" data-act="retry">Try again</button>';

function describe(v: KokoroVoiceInfo): string {
  return `${v.language === 'en-GB' ? 'British' : 'American'} · ${v.gender} · ${v.blurb}`;
}

/** Close functions of the open panels (Settings › Voices, a novel's voice picker, the pronunciation editor). */
const openPanels = new Set<() => void>();

/** Close every Voices panel: the Listen player opening or closing must never leave one on top of it. */
export function closeVoicePanels(): void {
  for (const close of [...openPanels]) close();
}

/** A full-screen panel (slides in from the right). */
export function panel(title: string, testId: string): { root: HTMLElement; body: HTMLElement; close: () => void; setTitle: (t: string) => void } {
  ensureStyle();
  const root = document.createElement('div');
  root.className = 'tn-v';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true'); // full screen: VoiceOver must not reach the screen behind
  root.setAttribute('aria-label', title);
  root.dataset.testid = testId;
  root.innerHTML = `<div class="hd"><button type="button" class="x" data-act="close" aria-label="Back">${ICON.back}</button><h1></h1></div><div class="body"></div>`;
  (root.querySelector('h1') as HTMLElement).textContent = title;
  document.body.append(root);
  requestAnimationFrame(() => {
    root.classList.add('is-open');
    root.querySelector<HTMLElement>('[data-act="close"]')?.focus({ preventScroll: true });
  });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    openPanels.delete(close);
    root.classList.remove('is-open');
    // Out of the way at once: while it slides out it must not catch taps meant for what's underneath.
    root.inert = true;
    root.style.pointerEvents = 'none';
    void Narration.stopSample().catch(() => undefined);
    setTimeout(() => root.remove(), 340);
  };
  openPanels.add(close);
  root.addEventListener('click', (ev) => {
    if ((ev.target as Element).closest('[data-act="close"]')) close();
  });
  return { root, body: root.querySelector('.body') as HTMLElement, close, setTitle: (t) => ((root.querySelector('h1') as HTMLElement).textContent = t) };
}

/** ▶ a sample; the button shows progress (the first Kokoro use after install compiles the model). */
async function sample(btn: HTMLButtonElement, voice: string, text = SAMPLE_TEXT, runs?: { t?: string; p?: string }[]): Promise<void> {
  if (btn.classList.contains('is-busy')) return;
  btn.classList.add('is-busy');
  const slow = setTimeout(() => toast('Preparing the voice… the first time after installing can take up to a minute.'), 2500);
  try {
    await Narration.sampleVoice({ voice, text, ...(runs ? { runs } : {}) });
  } catch (err) {
    toast(`Couldn't play the sample: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(slow);
    btn.classList.remove('is-busy');
  }
}

function voiceRows(info: VoiceSettingsInfo, selected: string): string {
  return info.voices
    .map(
      (v) => `<div class="row" data-voice="${esc(v.id)}">
        <button type="button" class="play" data-act="sample" data-voice="${esc(v.id)}" aria-label="Play a sample of ${esc(v.name)}">${ICON.play}</button>
        <button type="button" class="main" data-act="pick" data-voice="${esc(v.id)}" style="text-align:left;padding:0"><b>${esc(v.name)}</b><span class="sub">${esc(describe(v))}</span></button>
        <span class="check" aria-hidden="true">${v.id === selected ? '✓' : ''}</span>
      </div>`,
    )
    .join('');
}

function carChip(current: CarButtons | undefined, value: CarButtons, label: string): string {
  const on = (current ?? 'chapters') === value;
  return `<button type="button" class="chip${on ? ' is-selected' : ''}" data-act="car-buttons" data-v="${value}" aria-pressed="${on}">${label}</button>`;
}

function appleCard(info: VoiceSettingsInfo): string {
  const a = info.apple;
  const hint = a.onlyDefault
    ? `<p class="note warn">Only basic Apple voices are installed. For a better fallback, download a Premium voice in Settings › Accessibility › Spoken Content › Voices › English.</p>`
    : '';
  return `<div class="card"><div class="row">
      <button type="button" class="play" data-act="sample" data-voice="apple" aria-label="Play a sample of the Apple voice">${ICON.play}</button>
      <div class="main"><b>${esc(a.name)}</b><span class="sub">Apple voice · ${esc(a.quality)}</span></div>
    </div></div>
    <p class="note">Used for a sentence or two when Kokoro can't keep up (first start, a hot phone, or an error), then Kokoro takes over again.</p>${hint}`;
}

// ---------------------------------------------------------------- Settings › Voices

export function openVoicesScreen(): void {
  const p = panel('Voices', 'screen-voices');
  let info: VoiceSettingsInfo | null = null;
  let failed = false;

  const render = (): void => {
    if (!info) {
      p.body.innerHTML = failed ? UNAVAILABLE : '<p class="note">Loading…</p>';
      return;
    }
    const k = info.kokoro;
    const size = typeof k.bytes === 'number' ? ` · ${Math.round(k.bytes / 1e6)} MB` : '';
    const status = !k.bundled
      ? '<p class="note warn">Kokoro isn’t included in this build: the Apple voice reads everything.</p>'
      : k.crashDisabled
        ? `<p class="note warn">Kokoro was turned off after it crashed twice (a known iOS Core ML issue). <button type="button" data-act="kokoro-on" style="color:#a8b4ff;padding:0">Turn it back on</button></p>`
        : `<p class="note">Kokoro runs on this iPhone, built into the app${size}. No download, no internet needed.</p>
           <p class="note">iOS 26.4 and later have a known Core ML crash that can hit Kokoro (FluidAudio #844). This build carries FluidAudio’s fix for it (0.17), not yet proven on an iPhone. If Kokoro still crashes twice in a row, the app switches to the Apple voice by itself and says so here.</p>`;
    p.body.innerHTML = `
      <div class="sec">Voice</div>
      <div class="card">${voiceRows(info, info.defaultVoice)}</div>
      ${status}
      <div class="sec">Fallback</div>
      ${appleCard(info)}
      <div class="sec">Pronunciations</div>
      <div class="card"><button type="button" class="row" data-act="lexicon"><div class="main"><b>Words the voices get wrong</b><span class="sub">Names and made-up words, for every novel</span></div><span aria-hidden="true">›</span></button></div>
      <p class="note">A novel’s own list: Listen player › Voice › Pronunciations.</p>
      <div class="sec">Kokoro</div>
      <div class="card"><label class="row"><div class="main"><b>Kokoro on device</b><span class="sub">Off: always use the Apple voice</span></div><input type="checkbox" class="sw" data-act="kokoro" ${info.kokoroEnabled ? 'checked' : ''} aria-label="Kokoro on device"></label></div>
      <div class="sec">In the car</div>
      <div class="card" data-testid="voices-car">
        <div class="row"><div class="main"><b>Car buttons</b><span class="sub">The two side buttons in CarPlay, on the lock screen, headphones and the steering wheel</span></div></div>
        <div class="row"><div class="chips" role="group" aria-label="Car buttons">${carChip(info.carButtons, 'chapters', 'Chapters')}${carChip(info.carButtons, 'skip15', '15 seconds')}</div></div>
        <div class="row"><div class="main"><b>Prepared audio</b><span class="sub" data-drive-total>…</span></div><button type="button" class="link" data-act="drive-clear">Remove all</button></div>
      </div>
      <p class="note">CarPlay shows TachiNovel in its Now Playing screen (Siri: “pause”, “resume”, “next”). To listen without waiting on the voice or the internet, open a novel and tap Prepare for the drive.</p>
      <div class="sec">Advanced</div>
      <div class="card"><label class="row"><div class="main"><b>Use PC audio when available</b><span class="sub">Chapters narrated on the PC (“TachiNovel Audio” folder) play instead of Kokoro</span></div><input type="checkbox" class="sw" data-act="pcaudio" ${info.usePCAudio ? 'checked' : ''} aria-label="Use PC audio when available"></label>
      ${info.usePCAudio ? '<button type="button" class="row" data-act="folder"><div class="main"><b>Audio folder</b><span class="sub" data-folder>…</span></div><span aria-hidden="true">›</span></button>' : ''}</div>`;
    void Narration.driveStatus()
      .then((s) => {
        const el = p.body.querySelector('[data-drive-total]');
        if (el) el.textContent = storageLine(normalizeDriveStatus(s));
      })
      .catch(() => undefined);
    if (info.usePCAudio) {
      void Narration.audioFolder()
        .then((f) => {
          const el = p.body.querySelector('[data-folder]');
          if (el) el.textContent = f.linked ? (f.name ?? 'Linked') : 'Not linked: tap to choose iCloud Drive › TachiNovel Audio';
        })
        .catch(() => undefined);
    }
  };

  const load = async (): Promise<void> => {
    info = normalizeVoiceSettings(await Narration.voiceSettings().catch(() => null));
    failed = !info;
    render();
  };

  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (el?.dataset.act === 'retry') return void load();
    if (!el || !info) return;
    switch (el.dataset.act ?? '') {
      case 'sample':
        void sample(el as HTMLButtonElement, el.dataset.voice ?? 'af_heart');
        return;
      case 'pick':
        if (el.dataset.voice) void Narration.setVoiceSettings({ defaultVoice: el.dataset.voice }).then(load);
        return;
      case 'lexicon':
        openLexiconEditor(undefined, 'All novels');
        return;
      case 'kokoro-on':
        void Narration.setVoiceSettings({ kokoroEnabled: true }).then(load);
        return;
      case 'car-buttons': {
        const v: CarButtons = el.dataset.v === 'skip15' ? 'skip15' : 'chapters';
        void Narration.setVoiceSettings({ carButtons: v }).then(load);
        return;
      }
      case 'drive-clear':
        void Narration.clearDrive()
          .then(() => {
            toast('Prepared audio removed');
            render();
          })
          .catch(() => undefined);
        return;
      case 'folder':
        void Narration.pickAudioFolder().then(load);
        return;
      default:
    }
  });
  p.body.addEventListener('change', (ev) => {
    const el = ev.target as HTMLInputElement;
    if (el.dataset.act === 'kokoro') void Narration.setVoiceSettings({ kokoroEnabled: el.checked }).then(load);
    if (el.dataset.act === 'pcaudio') void Narration.setVoiceSettings({ usePCAudio: el.checked }).then(load).then(changed);
  });
  render();
  void load();
}

// ---------------------------------------------------------------- one novel's voice

export function openVoicePicker(novel: { pluginId: string; novelPath: string; name: string }, onChange?: () => void): void {
  const p = panel(`Voice · ${novel.name || 'This novel'}`, 'voice-picker');
  let info: VoiceSettingsInfo | null = null;
  let failed = false;
  const render = (): void => {
    if (!info) {
      p.body.innerHTML = failed ? UNAVAILABLE : '<p class="note">Loading…</p>';
      return;
    }
    const own = info.novelVoice ?? null;
    p.body.innerHTML = `
      <div class="sec">Voice for this novel</div>
      <div class="card">${voiceRows(info, info.effectiveVoice ?? info.defaultVoice)}</div>
      <p class="note">${own ? 'This novel has its own voice.' : `Using the default voice (${esc(info.voices.find((v) => v.id === info?.defaultVoice)?.name ?? '')}).`}</p>
      ${own ? '<button type="button" class="btn alt" data-act="use-default">Use the default voice</button>' : ''}
      <button type="button" class="btn alt" data-act="make-default">Make it the default for all novels</button>
      <div class="sec">Pronunciations</div>
      <div class="card"><button type="button" class="row" data-act="lexicon"><div class="main"><b>Pronunciations for this novel</b><span class="sub">Character names and made-up words</span></div><span aria-hidden="true">›</span></button></div>
      <div class="sec">Fallback</div>
      ${appleCard(info)}`;
  };
  const load = async (): Promise<void> => {
    info = normalizeVoiceSettings(await Narration.voiceSettings({ pluginId: novel.pluginId, novelPath: novel.novelPath }).catch(() => null));
    failed = !info;
    render();
  };
  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (el?.dataset.act === 'retry') return void load();
    if (!el || !info) return;
    const act = el.dataset.act;
    if (act === 'sample') return void sample(el as HTMLButtonElement, el.dataset.voice ?? 'af_heart');
    if (act === 'pick' && el.dataset.voice) {
      void Narration.setVoiceSettings({ novel: { pluginId: novel.pluginId, novelPath: novel.novelPath, voice: el.dataset.voice } }).then(load).then(onChange);
    }
    if (act === 'use-default') void Narration.setVoiceSettings({ novel: { pluginId: novel.pluginId, novelPath: novel.novelPath, voice: null } }).then(load).then(onChange);
    if (act === 'make-default' && info.effectiveVoice) {
      const voice = info.effectiveVoice;
      void Narration.setVoiceSettings({ defaultVoice: voice, novel: { pluginId: novel.pluginId, novelPath: novel.novelPath, voice: null } })
        .then(load)
        .then(onChange);
    }
    if (act === 'lexicon') openLexiconEditor(`${novel.pluginId}:${novel.novelPath}`, novel.name || 'This novel');
  });
  render();
  void load();
}

// ---------------------------------------------------------------- pronunciation lexicons

/** Add/replace an entry (same `match`, case-insensitive), keeping the list's order otherwise. */
export function upsertEntry(lex: Lexicon, entry: LexiconEntry): Lexicon {
  const key = entry.match.trim().toLowerCase();
  const entries = lex.entries.filter((e) => e.match.trim().toLowerCase() !== key);
  return { schemaVersion: 1, entries: [...entries, { ...entry, match: entry.match.trim() }] };
}

/** Merge a pasted lexicon (e.g. from the PC narrator) into a list; returns the problems instead if invalid. */
export function mergePasted(lex: Lexicon, json: string): { lexicon: Lexicon } | { problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { problems: ['That isn’t JSON.'] };
  }
  const candidate = Array.isArray(parsed) ? { schemaVersion: 1, entries: parsed } : parsed;
  const problems = validateLexicon(candidate);
  if (problems.length > 0) return { problems };
  let out = lex;
  for (const e of (candidate as Lexicon).entries) out = upsertEntry(out, e);
  return { lexicon: out };
}

export function openLexiconEditor(novelKey: string | undefined, label: string): void {
  const p = panel(`Pronunciations · ${label}`, 'lexicon-editor');
  let lex: Lexicon = { schemaVersion: 1, entries: [] };
  let pasteOpen = false;

  const save = async (next: Lexicon): Promise<void> => {
    try {
      await callCore('narration.lexicon.set', { ...(novelKey ? { novelKey } : {}), lexicon: next });
      lex = next;
      render();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const render = (): void => {
    const rows = lex.entries
      .map(
        (e, i) => `<div class="row"><div class="main"><b>${esc(e.match)}</b><span class="sub">${e.say ? `says “${esc(e.say)}”` : ''}${e.say && e.ipa ? ' · ' : ''}${e.ipa ? `/${esc(e.ipa)}/` : ''}</span></div>
        <button type="button" class="play" data-act="test" data-i="${i}" aria-label="Hear ${esc(e.match)}">${ICON.play}</button>
        <button type="button" class="del" data-act="delete" data-i="${i}" aria-label="Delete ${esc(e.match)}">✕</button></div>`,
      )
      .join('');
    p.body.innerHTML = `
      <div class="sec">${lex.entries.length} word${lex.entries.length === 1 ? '' : 's'}</div>
      ${rows ? `<div class="card">${rows}</div>` : '<p class="note">No words yet. Add a name the voice mispronounces.</p>'}
      <div class="sec">Add a word</div>
      <div class="card" style="padding:4px 14px 14px">
        <input type="text" data-f="match" placeholder="Word as written (e.g. Nephis)" autocapitalize="off" autocomplete="off">
        <input type="text" data-f="say" placeholder="Say it like (e.g. Neff-iss)" autocapitalize="off" autocomplete="off">
        <input type="text" data-f="ipa" placeholder="Kokoro phonemes, optional (e.g. nˈɛfɪs)" autocapitalize="off" autocomplete="off" spellcheck="false">
        <button type="button" class="btn" data-act="add">Add</button>
      </div>
      <p class="note">“Say it like” works with every voice. Phonemes (misaki notation, as in the PC narrator’s lexicon) are exact for Kokoro.</p>
      <button type="button" class="btn alt" data-act="paste-toggle">${pasteOpen ? 'Hide' : 'Paste a lexicon (JSON)'}</button>
      ${pasteOpen ? '<textarea data-f="paste" placeholder=\'{"schemaVersion":1,"entries":[{"match":"Nephis","ipa":"nˈɛfɪs"}]}\'></textarea><button type="button" class="btn" data-act="paste">Merge</button>' : ''}`;
  };

  const field = (name: string): string => (p.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-f="${name}"]`)?.value ?? '').trim();

  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const i = Number(el.dataset.i);
    switch (el.dataset.act ?? '') {
      case 'add': {
        const match = field('match');
        const say = field('say');
        const ipa = field('ipa');
        if (!match) return toast('Type the word as it’s written.');
        if (!say && !ipa) return toast('Add how to say it, or its phonemes.');
        if (ipa && !isKokoroPhonemes(ipa)) return toast('Those phonemes have characters Kokoro can’t speak.');
        void save(upsertEntry(lex, { match, ...(say ? { say } : {}), ...(ipa ? { ipa } : {}) }));
        return;
      }
      case 'delete': {
        const entries = lex.entries.filter((_, k) => k !== i);
        void save({ schemaVersion: 1, entries });
        return;
      }
      case 'test': {
        const e = lex.entries[i];
        if (!e) return;
        // Kokoro says it the way narration will: the phonemes if given, else the respelling.
        const word = e.say ?? e.match;
        const runs = e.ipa ? [{ p: e.ipa }, { t: '. I said, ' }, { p: e.ipa }, { t: '.' }] : undefined;
        void Narration.voiceSettings()
          .then((s) => sample(el as HTMLButtonElement, normalizeVoiceSettings(s)?.defaultVoice ?? 'af_heart', `${word}. I said, ${word}.`, runs))
          .catch(() => undefined);
        return;
      }
      case 'paste-toggle':
        pasteOpen = !pasteOpen;
        render();
        return;
      case 'paste': {
        const r = mergePasted(lex, field('paste'));
        if ('problems' in r) return toast(r.problems.slice(0, 2).join(' '));
        pasteOpen = false;
        void save(r.lexicon);
        return;
      }
      default:
    }
  });

  void callCore<{ global: Lexicon; novel: Lexicon | null }>('narration.lexicon.get', novelKey ? { novelKey } : {})
    .then((r) => {
      lex = (novelKey ? r.novel : r.global) ?? { schemaVersion: 1, entries: [] };
      render();
    })
    .catch(() => render());
  render();
}
