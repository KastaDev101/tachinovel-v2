/**
 * Voices UI (v2 additions over the unchanged v1 UI):
 *
 *  - Settings › Voices (a "Voices" row injected into v1's More list, see v1-hooks.ts): the 28 Kokoro
 *    voices, grouped by accent and gender with the best graded first, with ▶ samples and the default one;
 *    the Apple voice that stands in when Kokoro can't keep up (with the "download a Premium voice" hint);
 *    Kokoro on/off, pronunciations, In the car (what the car's side buttons do, prepared audio storage),
 *    and Advanced › "Use PC audio when available" (off by default; the PC narrator is sidelined).
 *  - The voice mixer (Settings › Voices › Mix a voice): two voices and a blend slider, ▶ to listen,
 *    saved under a name in "Your mixes" (on this iPhone), usable as the default or for one novel; edit and
 *    delete. Rules shared with native in voice-mix.ts.
 *  - Narrator mode (Settings › Voices): a dialogue voice (and a second speaker), natural pauses, natural
 *    variation, studio sound, room tone, each with its own switch, and ▶ Without / ▶ With on a test passage.
 *  - The voice picker for one novel (from the Listen player): its own voice (or mix) or the default.
 *  - The pronunciation editor (global, or one novel): word → respelling and/or Kokoro phonemes, the same
 *    lexicon format the PC narrator uses (v1 frontend.ts), so a narrator lexicon can be pasted in.
 *
 * Vanilla DOM like car-mode.ts: these screens live outside v1's navigation stack.
 */
import { isKokoroPhonemes, validateLexicon, type Lexicon, type LexiconEntry } from '@v1tts/frontend.ts';
import { callCore } from '../capacitor-client.ts';
import { normalizeDriveStatus, storageLine } from './drive-status.ts';
import { voiceLabel as describeVoice } from './listen-controls.ts';
import { openVoiceTest } from './voice-test.ts';
import { groupVoices } from './voice-groups.ts';
import { openExpressiveLab } from './expressive-lab.ts';
import { NARRATOR_PIECES, playTestPassage } from './voice-lab.ts';
import { blendVoice, cleanMixName, mixPercent, mixProblem, mixShares, suggestedMixName, usableMixes } from './voice-mix.ts';
import {
  Narration,
  type CarButtons,
  type CustomVoiceInfo,
  type DeliveryInfo,
  type KokoroVoiceInfo,
  type NarrationState,
  type NarratorInfo,
  type VoiceSettingsInfo,
} from './narration.ts';
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
.tn-v .sub-sec{color:#a1a1aa;font-size:${fs(13)};margin:12px 4px 6px}
.tn-v .grade{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:8px;background:rgba(168,180,255,.16);color:#c7cdff;font-size:${fs(12)};font-weight:600;vertical-align:1px}
.tn-v .chips{display:flex;gap:8px;flex:1}
.tn-v .chip{display:flex;align-items:center;justify-content:center;height:auto;flex:1;padding:11px 0;border-radius:12px;background:rgba(255,255,255,.08);text-align:center;font-weight:600}
.tn-v .chip[aria-pressed="true"]{background:#a8b4ff;color:#15151a}
.tn-v .link{color:#a8b4ff;padding:6px 0;flex:none}
.tn-v select{flex:none;max-width:52%;background:#26262d;color:#f2f2f7;border:0;border-radius:10px;font:${fs(16)} -apple-system,system-ui;padding:9px 10px}
.tn-v .mix{display:block;padding:14px}
.tn-v .mix-shares{font-weight:600;text-align:center;margin-bottom:10px}
.tn-v .mix-range{width:100%;accent-color:#a8b4ff;margin:0;height:32px}
.tn-v .mix-ends{display:flex;justify-content:space-between;color:#a1a1aa;font-size:${fs(13)};margin-top:2px}
.tn-v .edit{color:#a8b4ff;padding:6px 4px;flex:none;font-size:${fs(15)}}
.tn-v .btn.danger{color:#ff8a8a}
.tn-v details.tn-adv{display:block}
.tn-v details.tn-adv>summary{list-style:none;cursor:pointer}
.tn-v details.tn-adv>summary::-webkit-details-marker{display:none}
.tn-v details.tn-adv>summary .sub{display:block;color:#a1a1aa;font-size:${fs(13)};margin-top:2px}
.tn-v details.tn-adv>.row{padding-left:0;padding-right:0}
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

/** Narrator settings from native (absent in older builds: off). Unknown voices read as none. */
export function normalizeNarrator(raw: unknown, isChoice: (id: unknown) => boolean): NarratorInfo {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof NarratorInfo, unknown>>;
  const flag = (k: 'pacing' | 'jitter' | 'polish' | 'roomTone'): boolean => (typeof r[k] === 'boolean' ? r[k] : NARRATOR_OFF[k]);
  const voice = (v: unknown): string | null => (typeof v === 'string' && isChoice(v) ? v : null);
  return {
    enabled: r.enabled === true,
    dialogueVoice: voice(r.dialogueVoice),
    secondDialogueVoice: voice(r.secondDialogueVoice),
    pacing: flag('pacing'),
    jitter: flag('jitter'),
    polish: flag('polish'),
    roomTone: flag('roomTone'),
    phraseBreaks: r.phraseBreaks === 'off' ? 'off' : 'clauses',
    pacingStyle: r.pacingStyle === 'natural' ? 'natural' : 'relaxed',
  };
}

/** A usable answer from Narration.voiceSettings, or null (no voices: an older build, a mock, an error). */
export function normalizeVoiceSettings(raw: unknown): VoiceSettingsInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<VoiceSettingsInfo>;
  const voices = Array.isArray(r.voices) ? r.voices.filter((v) => typeof v.id === 'string' && typeof v.name === 'string') : [];
  const first = voices[0];
  if (!first) return null;
  const k: Partial<VoiceSettingsInfo['kokoro']> = r.kokoro ?? {};
  const customVoices = usableMixes(r.customVoices, voices);
  const isChoice = (id: unknown): id is string => typeof id === 'string' && (voices.some((v) => v.id === id) || customVoices.some((m) => m.id === id));
  return {
    ...r,
    voices,
    customVoices,
    defaultVoice: isChoice(r.defaultVoice) ? r.defaultVoice : first.id,
    kokoroEnabled: r.kokoroEnabled !== false,
    usePCAudio: r.usePCAudio === true,
    carButtons: r.carButtons === 'skip15' ? 'skip15' : 'chapters',
    speed: typeof r.speed === 'number' && Number.isFinite(r.speed) ? r.speed : 1,
    narrator: normalizeNarrator(r.narrator, (id) => isChoice(id)),
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
  return v.blurb || (v.grade ? `Kokoro grade ${v.grade}` : `${v.language === 'en-GB' ? 'British' : 'American'} · ${v.gender}`);
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

function voiceRow(v: KokoroVoiceInfo, selected: string): string {
  const grade = v.grade ? `<span class="grade" title="Kokoro's grade for this voice">${esc(v.grade)}</span>` : '';
  return `<div class="row" data-voice="${esc(v.id)}">
        <button type="button" class="play" data-act="sample" data-voice="${esc(v.id)}" aria-label="Play a sample of ${esc(v.name)}">${ICON.play}</button>
        <button type="button" class="main" data-act="pick" data-voice="${esc(v.id)}" style="text-align:left;padding:0"><b>${esc(v.name)}${grade}</b><span class="sub">${esc(describe(v))}</span></button>
        <span class="check" aria-hidden="true">${v.id === selected ? '✓' : ''}</span>
      </div>`;
}

function mixRow(info: VoiceSettingsInfo, m: CustomVoiceInfo, selected: string, editable: boolean): string {
  return `<div class="row" data-voice="${esc(m.id)}">
        <button type="button" class="play" data-act="sample" data-voice="${esc(m.id)}" aria-label="Play a sample of ${esc(m.name)}">${ICON.play}</button>
        <button type="button" class="main" data-act="pick" data-voice="${esc(m.id)}" style="text-align:left;padding:0"><b>${esc(m.name)}</b><span class="sub">${esc(mixShares(info.voices, m.a, m.b, m.percent))}</span></button>
        ${editable ? `<button type="button" class="edit" data-act="mix-edit" data-mix="${esc(m.id)}" aria-label="Edit ${esc(m.name)}">Edit</button>` : ''}
        <span class="check" aria-hidden="true">${m.id === selected ? '✓' : ''}</span>
      </div>`;
}

/**
 * The voices grouped by accent and gender, best-graded first (a sub-header and a card per group), then
 * "Your mixes". `editable` adds Edit to each mix and a "Mix a voice" row (Settings › Voices).
 */
function voiceRows(info: VoiceSettingsInfo, selected: string, editable = false): string {
  const groups = groupVoices(info.voices)
    .map((g) => `<div class="sub-sec" data-group="${esc(g.key)}">${esc(g.label)}</div><div class="card">${g.voices.map((v) => voiceRow(v, selected)).join('')}</div>`)
    .join('');
  const mixes = info.customVoices ?? [];
  const newRow = editable
    ? `<button type="button" class="row" data-act="mix-new"><div class="main"><b>Mix a voice</b><span class="sub">Blend two voices into your own</span></div><span aria-hidden="true">›</span></button>`
    : '';
  if (mixes.length === 0 && !newRow) return groups;
  return `${groups}<div class="sub-sec" data-group="mixes">Your mixes</div><div class="card" data-testid="voice-mixes">${mixes.map((m) => mixRow(info, m, selected, editable)).join('')}${newRow}</div>`;
}

/** A <select> of every choice (voices by group, then your mixes), with a first "none" option. */
function choiceOptions(info: VoiceSettingsInfo, selected: string | null, none: string): string {
  const opt = (id: string, label: string): string => `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(label)}</option>`;
  const groups = groupVoices(info.voices).map((g) => `<optgroup label="${esc(g.label)}">${g.voices.map((v) => opt(v.id, v.name)).join('')}</optgroup>`);
  const mixes = info.customVoices?.length ? `<optgroup label="Your mixes">${info.customVoices.map((m) => opt(m.id, m.name)).join('')}</optgroup>` : '';
  return `<option value=""${selected ? '' : ' selected'}>${esc(none)}</option>${groups.join('')}${mixes}`;
}

const NARRATOR_OFF: NarratorInfo = {
  enabled: false,
  dialogueVoice: null,
  secondDialogueVoice: null,
  pacing: true,
  jitter: false,
  polish: true,
  roomTone: false,
  phraseBreaks: 'clauses',
  pacingStyle: 'relaxed',
};

/** Settings › Voices › Narrator mode. */
function narratorCard(info: VoiceSettingsInfo): string {
  const n = info.narrator ?? NARRATOR_OFF;
  const sw = (k: keyof NarratorInfo, label: string, sub: string, disabled = false): string =>
    `<label class="row"><div class="main"><b>${esc(label)}</b><span class="sub">${esc(sub)}</span></div><input type="checkbox" class="sw" data-act="narrator" data-k="${k}" ${n[k] ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${esc(label)}"></label>`;
  // One narrator voice for the whole story by default; separate dialogue voices are an Advanced option.
  const advanced = `<details class="row tn-adv" data-testid="narrator-advanced"${n.dialogueVoice ? ' open' : ''}><summary><b>Advanced</b><span class="sub">Separate voices for dialogue</span></summary>
       <label class="row"><div class="main"><b>Dialogue voice</b><span class="sub">Words in quotation marks (default: the narrator’s voice)</span></div><select data-act="narrator-voice" data-k="dialogueVoice" aria-label="Dialogue voice">${choiceOptions(info, n.dialogueVoice, 'Narrator’s voice')}</select></label>
       <label class="row"><div class="main"><b>Second speaker</b><span class="sub">Every other paragraph of an exchange</span></div><select data-act="narrator-voice" data-k="secondDialogueVoice" aria-label="Second speaker" ${n.dialogueVoice ? '' : 'disabled'}>${choiceOptions(info, n.secondDialogueVoice, 'Same as dialogue')}</select></label>
     </details>`;
  const phrases = `<label class="row"><div class="main"><b>Phrase breaks</b><span class="sub">Short pauses at commas and between clauses</span></div><input type="checkbox" class="sw" data-act="narrator-phrases" ${n.phraseBreaks === 'off' ? '' : 'checked'} aria-label="Phrase breaks"></label>`;
  const pacingStyle = `<label class="row"><div class="main"><b>Pause length</b><span class="sub">Relaxed gives sentences and paragraphs more room</span></div><select data-act="narrator-pacing-style" aria-label="Pause length" ${n.pacing ? '' : 'disabled'}><option value="relaxed"${n.pacingStyle === 'natural' ? '' : ' selected'}>Relaxed</option><option value="natural"${n.pacingStyle === 'natural' ? ' selected' : ''}>Natural</option></select></label>`;
  const pieces = n.enabled
    ? `${NARRATOR_PIECES.map(([k, label, sub]) => sw(k, label, sub, k === 'roomTone' && !n.polish)).join('')}${pacingStyle}${phrases}${advanced}`
    : '';
  return `<div class="card" data-testid="voices-narrator">
      ${sw('enabled', 'Narrator mode', 'Dialogue in its own voice, natural pauses, studio sound')}
      ${pieces}
      <div class="row"><div class="chips" role="group" aria-label="Compare on a test passage">
        <button type="button" class="chip" data-act="narrator-ab" data-v="off">▶ Without</button>
        <button type="button" class="chip" data-act="narrator-ab" data-v="on">▶ With</button>
      </div></div>
    </div>
    <p class="note">Compare on a short passage with dialogue. One voice reads the whole story; Advanced can give dialogue its own voice.</p>`;
}

/** Listen › the narrator voice (natural delivery), as native sends it; defaults when an older app sends none. */
const DELIVERY_DEFAULT: DeliveryInfo = {
  listenEngine: 'pocket-tts',
  natural: true,
  performed: true,
  moods: true,
  sceneAI: true,
  breaths: true,
  studioSound: true,
  systemChime: true,
  systemTone: true,
};

const DELIVERY_SWITCHES: [Exclude<keyof DeliveryInfo, 'listenEngine' | 'sceneAIAvailable' | 'pocketVoice'>, string, string][] = [
  ['natural', 'Natural delivery', 'Paragraphs read as one thought, pauses that fit the scene'],
  ['performed', 'Act out dialogue', 'Quotes and thoughts performed, narration calm (same voice)'],
  ['moods', 'Mood voices', 'Tense, sad and tender reads where the scene calls for them'],
  ['sceneAI', 'AI scene reading', 'Apple’s on-device model reads each scene (iOS 26, Apple Intelligence)'],
  ['breaths', 'Breaths', 'Real inhales in the longer pauses'],
  ['studioSound', 'Studio sound', 'Clean, warm and even'],
  ['systemChime', 'System message chime', 'A soft chime before [System] lines'],
  ['systemTone', 'System message voice', 'An interface tone for [System] lines'],
];

/** Switches that change only the Narrator's reads: Nephis reads everything in her one voice. */
const NARRATOR_ONLY = new Set<string>(['performed', 'moods', 'sceneAI', 'breaths']);

/** Nephis is the voice reading chapters. */
function nephisReads(info: VoiceSettingsInfo): boolean {
  return info.delivery?.listenEngine === 'pocket-tts' && info.delivery.pocketVoice === 'nephis';
}

/** The Narrator's switches (natural delivery, acting, mood voices, AI scene reading, breaths, studio sound, …). */
function deliveryCard(info: VoiceSettingsInfo): string {
  const d = { ...DELIVERY_DEFAULT, ...info.delivery };
  const nephis = nephisReads(info);
  const rows = DELIVERY_SWITCHES.map(
    ([k, label, sub]) =>
      `<label class="row"><div class="main"><b>${esc(label)}</b><span class="sub">${esc(nephis && NARRATOR_ONLY.has(k) ? `Narrator only. ${sub}` : sub)}</span></div><input type="checkbox" class="sw" data-act="delivery" data-k="${k}" ${d[k] ? 'checked' : ''} ${k !== 'natural' && !d.natural ? 'disabled' : ''} aria-label="${esc(label)}"></label>`,
  ).join('');
  return `<div class="card" data-testid="voices-delivery">${rows}</div>`;
}

/** Kokoro's three backup voices, shown first (the full list and the mixer are one tap further). */
const BACKUP_VOICES = ['af_heart', 'af_bella', 'af_nicole'];

/** Who reads chapters: the Narrator (Pocket TTS; a download row until it is installed) or Kokoro. One tap each. */
function engineCard(info: VoiceSettingsInfo): string {
  const d = { ...DELIVERY_DEFAULT, ...info.delivery };
  // Pocket TTS reads with one of two shipped voices: each is its own row ("pocket-tts" + the voice).
  const on = d.listenEngine === 'pocket-tts' ? `pocket-tts:${d.pocketVoice ?? 'narrator'}` : (d.listenEngine ?? 'kokoro');
  const row = (v: string, title: string, sub: string): string =>
    `<button type="button" class="row" data-act="engine" data-v="${v}" aria-pressed="${String(on === v)}"><div class="main"><b>${esc(title)}</b><span class="sub">${esc(sub)}</span></div><span class="check" aria-hidden="true">${on === v ? '✓' : ''}</span></button>`;
  const download =
    info.delivery?.pocketInstalled === false
      ? `<button type="button" class="row" data-act="expressive"><div class="main"><b>Download the Narrator voice</b><span class="sub">About 370 MB, on Wi-Fi. Until then Kokoro reads.</span></div><span aria-hidden="true">›</span></button>`
      : '';
  return `<div class="card" data-testid="voices-engine">
      ${row('pocket-tts:narrator', 'Narrator', 'Acts the dialogue, follows the scene, reads with the screen locked')}
      ${row('pocket-tts:nephis', 'Nephis', 'Deeper and clearer, one calm voice for everything (new)')}${download}
      ${on === 'chatterbox-nano' ? row('chatterbox-nano', 'Narrator (Chatterbox Nano)', 'The earlier engine; only with the app open') : ''}
      ${row('kokoro', 'Kokoro', 'Fast and light; also the backup when the Narrator can’t keep up')}
    </div>`;
}

/** Kokoro's backup voices (and the one in use, when it is another), plus the way to every voice and the mixer. */
function backupCard(info: VoiceSettingsInfo, selected: string): string {
  const ids = BACKUP_VOICES.includes(selected) ? BACKUP_VOICES : [...BACKUP_VOICES, selected];
  const rows = ids.flatMap((id) => {
    const v = info.voices.find((x) => x.id === id);
    if (v) return [voiceRow(v, selected)];
    const mix = info.customVoices?.find((m) => m.id === id);
    return mix ? [mixRow(info, mix, selected, false)] : [];
  });
  return `<div class="card" data-testid="voices-backup">${rows.join('')}
      <button type="button" class="row" data-act="kokoro-all"><div class="main"><b>All Kokoro voices</b><span class="sub">${info.voices.length} voices and your own mixes</span></div><span aria-hidden="true">›</span></button>
    </div>`;
}

const NARRATOR_SETTINGS_ROW = `<div class="card"><button type="button" class="row" data-act="narrator-settings"><div class="main"><b>Narrator settings</b><span class="sub">Acting, mood voices, AI scene reading, breaths, studio sound</span></div><span aria-hidden="true">›</span></button></div>`;

/** Settings › Voices › Narrator settings: natural delivery's switches. */
function openNarratorSettings(onDone: () => void): void {
  const p = panel('Narrator settings', 'narrator-settings');
  let info: VoiceSettingsInfo | null = null;
  const render = (): void => {
    p.body.innerHTML = info
      ? `${nephisReads(info) ? '<p class="note">Nephis reads every line in her one calm voice, as one continuous read: the switches marked “Narrator only” change the Narrator’s reads, not hers.</p>' : ''}${deliveryCard(info)}<p class="note">The Narrator is one voice: dialogue and thoughts are acted, narration stays calm, and the mood voices follow the scene.</p>`
      : '<p class="note">Loading…</p>';
  };
  const load = async (): Promise<void> => {
    info = normalizeVoiceSettings(await Narration.voiceSettings().catch(() => null));
    render();
  };
  p.body.addEventListener('change', (ev) => {
    const el = ev.target as HTMLInputElement;
    if (el.dataset.act === 'delivery' && el.dataset.k) void Narration.setVoiceSettings({ delivery: { [el.dataset.k]: el.checked } }).then(load).then(onDone);
  });
  render();
  void load();
}

/** Every Kokoro voice (and the mixer and Kokoro's narrator mode, for the default); for a novel, its own choice. */
function openKokoroVoices(novel: { pluginId: string; novelPath: string } | null, onDone: () => void): void {
  const p = panel('Kokoro voices', 'kokoro-voices');
  let info: VoiceSettingsInfo | null = null;
  const render = (): void => {
    if (!info) {
      p.body.innerHTML = '<p class="note">Loading…</p>';
      return;
    }
    const selected = novel ? (info.effectiveVoice ?? info.defaultVoice) : info.defaultVoice;
    p.body.innerHTML = `${voiceRows(info, selected, !novel)}${novel ? '' : `<div class="sec">Kokoro narrator mode</div>${narratorCard(info)}`}`;
  };
  const load = async (): Promise<void> => {
    info = normalizeVoiceSettings(await Narration.voiceSettings(novel ?? undefined).catch(() => null));
    render();
  };
  const done = (): Promise<void> => load().then(onDone);
  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el || !info) return;
    const act = el.dataset.act;
    if (act === 'sample') void sample(el as HTMLButtonElement, el.dataset.voice ?? 'af_heart');
    if (act === 'pick' && el.dataset.voice) {
      void Narration.setVoiceSettings(novel ? { novel: { ...novel, voice: el.dataset.voice } } : { defaultVoice: el.dataset.voice }).then(done);
    }
    if (act === 'mix-new') openMixer(info, null, () => void done());
    if (act === 'mix-edit') {
      const mix = info.customVoices?.find((m) => m.id === el.dataset.mix);
      if (mix) openMixer(info, mix, () => void done());
    }
    if (act === 'narrator-ab') void playTestPassage(el.dataset.v === 'on' ? 'on' : 'off').catch(() => undefined);
  });
  p.body.addEventListener('change', (ev) => {
    const el = ev.target as HTMLInputElement;
    if (el.dataset.act === 'narrator' && el.dataset.k) void Narration.setVoiceSettings({ narrator: { [el.dataset.k]: el.checked } }).then(done);
    if (el.dataset.act === 'narrator-pacing-style') void Narration.setVoiceSettings({ narrator: { pacingStyle: el.value === 'natural' ? 'natural' : 'relaxed' } }).then(done);
    if (el.dataset.act === 'narrator-phrases') void Narration.setVoiceSettings({ narrator: { phraseBreaks: el.checked ? 'clauses' : 'off' } }).then(done);
    if (el.dataset.act === 'narrator-voice' && el.dataset.k) void Narration.setVoiceSettings({ narrator: { [el.dataset.k]: el.value || null } }).then(done);
  });
  render();
  void load();
}

/** The engine row tapped: the Narrator or Nephis (Pocket TTS), Nano, or Kokoro (null), as delivery settings. */
function engineValue(v: string | undefined): Partial<DeliveryInfo> {
  if (v === 'pocket-tts:narrator' || v === 'pocket-tts:nephis') return { listenEngine: 'pocket-tts', pocketVoice: v === 'pocket-tts:nephis' ? 'nephis' : 'narrator' };
  return { listenEngine: v === 'pocket-tts' || v === 'chatterbox-nano' ? v : null };
}

/** A voice's or a mix's name. */
function choiceName(info: VoiceSettingsInfo, id: string | undefined): string {
  return info.voices.find((v) => v.id === id)?.name ?? info.customVoices?.find((m) => m.id === id)?.name ?? '';
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
        : `<p class="note">Kokoro is built into the app${size}: no download, no internet.</p>`;
    p.body.innerHTML = `
      <div class="sec">Reads chapters</div>
      ${engineCard(info)}
      ${NARRATOR_SETTINGS_ROW}
      <div class="card"><button type="button" class="row" data-act="voice-test" data-testid="voices-test"><div class="main"><b>Voice test</b><span class="sub">2 minutes: breaks, voice switches, speed and phone heat, with a report to copy</span></div><span aria-hidden="true">›</span></button></div>
      <div class="sec">Backup voice (Kokoro)</div>
      <div class="card" data-testid="voices-backup"><button type="button" class="row" data-act="kokoro-all"><div class="main"><b>Kokoro voice</b><span class="sub">${esc(choiceName(info, info.defaultVoice) || 'Heart')} · ${nephisReads(info) ? 'reads when Kokoro is chosen (Nephis’s catch-up lines use her own Kokoro voice)' : 'reads when Kokoro is chosen, and stands in when the Narrator can’t keep up'}</span></div><span aria-hidden="true">›</span></button></div>
      ${status}
      <div class="sec">Pronunciations</div>
      <div class="card"><button type="button" class="row" data-act="lexicon"><div class="main"><b>Words the voices get wrong</b><span class="sub">Names and made-up words, for every novel</span></div><span aria-hidden="true">›</span></button></div>
      <p class="note">A novel’s own list: Listen player › Voice › Pronunciations.</p>
      <div class="sec">In the car</div>
      <div class="card" data-testid="voices-car">
        <div class="row"><div class="main"><b>Car buttons</b><span class="sub">The two side buttons in CarPlay, on the lock screen, headphones and the steering wheel</span></div></div>
        <div class="row"><div class="chips" role="group" aria-label="Car buttons">${carChip(info.carButtons, 'chapters', 'Chapters')}${carChip(info.carButtons, 'skip15', '15 seconds')}</div></div>
        <div class="row"><div class="main"><b>Prepared audio</b><span class="sub" data-drive-total>…</span></div><button type="button" class="link" data-act="drive-clear">Remove all</button></div>
      </div>
      <p class="note">CarPlay shows TachiNovel in its Now Playing screen (Siri: “pause”, “resume”, “next”). To listen without waiting on the voice or the internet, open a novel and tap Prepare for the drive.</p>
      <div class="sec">Advanced</div>
      <div class="card"><button type="button" class="row" data-act="expressive"><div class="main"><b>Voice models</b><span class="sub">Download or remove the Narrator voice; experimental engines</span></div><span aria-hidden="true">›</span></button>
      <label class="row"><div class="main"><b>Kokoro on device</b><span class="sub">Off: the Apple voice is the backup</span></div><input type="checkbox" class="sw" data-act="kokoro" ${info.kokoroEnabled ? 'checked' : ''} aria-label="Kokoro on device"></label></div>
      ${appleCard(info)}
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
      case 'mix-new':
        openMixer(info, null, () => void load());
        return;
      case 'expressive':
        openExpressiveLab();
        return;
      case 'engine':
        void Narration.setVoiceSettings({ delivery: engineValue(el.dataset.v) }).then(load);
        return;
      case 'narrator-settings':
        openNarratorSettings(() => undefined);
        return;
      case 'voice-test':
        openVoiceTest();
        return;
      case 'kokoro-all':
        openKokoroVoices(null, () => void load());
        return;
      case 'narrator-ab':
        void playTestPassage(el.dataset.v === 'on' ? 'on' : 'off').catch((err: unknown) => toast(`Couldn't play: ${err instanceof Error ? err.message : String(err)}`));
        return;
      case 'mix-edit': {
        const mix = info.customVoices?.find((m) => m.id === el.dataset.mix);
        if (mix) openMixer(info, mix, () => void load());
        return;
      }
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
    if (el.dataset.act === 'narrator' && el.dataset.k) void Narration.setVoiceSettings({ narrator: { [el.dataset.k]: el.checked } }).then(load);
    if (el.dataset.act === 'narrator-pacing-style') void Narration.setVoiceSettings({ narrator: { pacingStyle: el.value === 'natural' ? 'natural' : 'relaxed' } }).then(load);
    if (el.dataset.act === 'narrator-phrases') void Narration.setVoiceSettings({ narrator: { phraseBreaks: el.checked ? 'clauses' : 'off' } }).then(load);
    if (el.dataset.act === 'narrator-voice' && el.dataset.k) void Narration.setVoiceSettings({ narrator: { [el.dataset.k]: el.value || null } }).then(load);
    if (el.dataset.act === 'delivery' && el.dataset.k) void Narration.setVoiceSettings({ delivery: { [el.dataset.k]: el.checked } }).then(load);
    if (el.dataset.act === 'delivery-engine') {
      const v = el.value === 'pocket-tts' || el.value === 'chatterbox-nano' ? el.value : null;
      void Narration.setVoiceSettings({ delivery: { listenEngine: v } }).then(load);
    }
    if (el.dataset.act === 'kokoro') void Narration.setVoiceSettings({ kokoroEnabled: el.checked }).then(load);
    if (el.dataset.act === 'pcaudio') void Narration.setVoiceSettings({ usePCAudio: el.checked }).then(load).then(changed);
  });
  render();
  void load();
}

// ---------------------------------------------------------------- the voice mixer

function voiceOptions(info: VoiceSettingsInfo, selected: string): string {
  return groupVoices(info.voices)
    .map(
      (g) =>
        `<optgroup label="${esc(g.label)}">${g.voices
          .map((v) => `<option value="${esc(v.id)}"${v.id === selected ? ' selected' : ''}>${esc(v.name)}${v.grade ? ` (${esc(v.grade)})` : ''}</option>`)
          .join('')}</optgroup>`,
    )
    .join('');
}

/** A new mix starts from the default voice and the best other voice of a different accent or gender. */
function startingPair(info: VoiceSettingsInfo): { a: string; b: string } {
  const voices = groupVoices(info.voices).flatMap((g) => g.voices);
  const a = voices.find((v) => v.id === info.defaultVoice) ?? voices[0];
  const best = [...voices].sort((x, y) => (y.gradeRank ?? -1) - (x.gradeRank ?? -1));
  const b = best.find((v) => v.id !== a?.id && (v.language !== a?.language || v.gender !== a.gender)) ?? best.find((v) => v.id !== a?.id);
  return { a: a?.id ?? 'af_heart', b: b?.id ?? 'bf_emma' };
}

/**
 * Mix a voice / Edit mix: two voices, the blend slider, ▶, a name, Save (and Delete for a saved mix). The
 * slider and pickers update the screen in place (never rebuilt while a finger is on them).
 */
export function openMixer(info: VoiceSettingsInfo, existing: CustomVoiceInfo | null, onDone: () => void): void {
  const p = panel(existing ? 'Edit mix' : 'Mix a voice', 'voice-mixer');
  const start = existing ?? { ...startingPair(info), percent: 50, name: '' };
  let a = start.a;
  let b = start.b;
  let percent = mixPercent(start.percent);
  let busy = false;
  p.body.innerHTML = `
    <div class="sec">Voices</div>
    <div class="card">
      <label class="row"><div class="main"><b>First voice</b></div><select data-act="mix-a" aria-label="First voice">${voiceOptions(info, a)}</select></label>
      <label class="row"><div class="main"><b>Second voice</b></div><select data-act="mix-b" aria-label="Second voice">${voiceOptions(info, b)}</select></label>
    </div>
    <div class="sec">Blend</div>
    <div class="card"><div class="mix">
      <div class="mix-shares" data-shares></div>
      <input type="range" class="mix-range" data-act="mix-blend" min="0" max="100" step="1" value="${String(percent)}" aria-label="Blend">
      <div class="mix-ends"><span data-end="a"></span><span data-end="b"></span></div>
    </div></div>
    <button type="button" class="btn alt" data-act="mix-play">▶ Listen to the mix</button>
    <div class="sec">Name</div>
    <input type="text" data-act="mix-name" maxlength="40" autocomplete="off" aria-label="Name" value="${esc(existing?.name ?? '')}">
    <p class="note warn" data-problem hidden></p>
    <button type="button" class="btn" data-act="mix-save">${existing ? 'Save changes' : 'Save mix'}</button>
    ${existing ? '<button type="button" class="btn alt danger" data-act="mix-delete">Delete mix</button>' : ''}
    <p class="note">Mixes are kept on this iPhone. Pick one in Settings › Voices for every novel, or for one novel in the Listen player › Voice.</p>`;
  const $ = <T extends Element>(sel: string): T => p.body.querySelector(sel) as T;
  const nameInput = $<HTMLInputElement>('[data-act="mix-name"]');
  const reflect = (): void => {
    $<HTMLElement>('[data-shares]').textContent = mixShares(info.voices, a, b, percent);
    $<HTMLElement>('[data-end="a"]').textContent = info.voices.find((v) => v.id === a)?.name ?? a;
    $<HTMLElement>('[data-end="b"]').textContent = info.voices.find((v) => v.id === b)?.name ?? b;
    nameInput.placeholder = suggestedMixName(info.voices, a, b, percent);
    const problem = mixProblem(info.voices, a, b);
    const note = $<HTMLElement>('[data-problem]');
    note.hidden = !problem;
    note.textContent = problem ?? '';
    $<HTMLButtonElement>('[data-act="mix-save"]').disabled = !!problem;
    $<HTMLButtonElement>('[data-act="mix-play"]').disabled = !!problem;
  };
  const onInput = (ev: Event): void => {
    const el = ev.target as HTMLInputElement | HTMLSelectElement;
    if (el.dataset.act === 'mix-a') a = el.value;
    else if (el.dataset.act === 'mix-b') b = el.value;
    else if (el.dataset.act === 'mix-blend') percent = mixPercent(Number(el.value));
    else return;
    reflect();
  };
  p.body.addEventListener('input', onInput);
  p.body.addEventListener('change', onInput);
  let deleteArmed: ReturnType<typeof setTimeout> | null = null;
  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLButtonElement>('button[data-act]');
    if (!el || el.disabled || busy) return;
    const act = el.dataset.act;
    if (act === 'mix-play') return void sample(el, blendVoice(a, b, percent));
    if (act === 'mix-save') {
      const name = cleanMixName(nameInput.value) || suggestedMixName(info.voices, a, b, percent);
      busy = true;
      void Narration.saveCustomVoice({ ...(existing ? { id: existing.id } : {}), name, a, b, percent })
        .then(() => {
          toast(`Saved “${name}”`);
          p.close();
          onDone();
        })
        .catch((err: unknown) => toast(`Couldn't save the mix: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => (busy = false));
      return;
    }
    if (act === 'mix-delete' && existing) {
      if (!deleteArmed) {
        el.textContent = 'Tap again to delete';
        deleteArmed = setTimeout(() => {
          deleteArmed = null;
          el.textContent = 'Delete mix';
        }, 4000);
        return;
      }
      clearTimeout(deleteArmed);
      deleteArmed = null;
      busy = true;
      void Narration.deleteCustomVoice({ id: existing.id })
        .then(() => {
          toast(`Deleted “${existing.name}”`);
          p.close();
          onDone();
        })
        .catch((err: unknown) => toast(`Couldn't delete the mix: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => (busy = false));
    }
  });
  reflect();
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
    // Kokoro's own voices are one tap further (tap Kokoro, or Kokoro voice): the list here is only who reads.
    const kokoro = choiceName(info, info.effectiveVoice ?? info.defaultVoice);
    p.body.innerHTML = `
      <div class="sec">Reads chapters</div>
      ${engineCard(info)}
      <div class="card">
        <button type="button" class="row" data-act="narrator-settings"><div class="main"><b>Narrator settings</b><span class="sub">Acting, mood voices, AI scene reading, breaths, studio sound</span></div><span aria-hidden="true">›</span></button>
        <button type="button" class="row" data-act="novel-kokoro"><div class="main"><b>Kokoro voice</b><span class="sub">${esc(kokoro)}${info.novelVoice ? ' (this novel)' : ''} · ${nephisReads(info) ? 'when Kokoro reads (Nephis’s catch-up lines use her own Kokoro voice)' : 'also the backup'}</span></div><span aria-hidden="true">›</span></button>
      </div>
      <div class="sec">Pronunciations</div>
      <div class="card"><button type="button" class="row" data-act="lexicon"><div class="main"><b>Pronunciations for this novel</b><span class="sub">Character names and made-up words</span></div><span aria-hidden="true">›</span></button></div>`;
  };
  const load = async (): Promise<void> => {
    info = normalizeVoiceSettings(await Narration.voiceSettings({ pluginId: novel.pluginId, novelPath: novel.novelPath }).catch(() => null));
    failed = !info;
    render();
  };
  const kokoroPanel = (): void => openNovelKokoro(novel, () => void load().then(onChange));
  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (el?.dataset.act === 'retry') return void load();
    if (!el || !info) return;
    const act = el.dataset.act;
    if (act === 'lexicon') openLexiconEditor(`${novel.pluginId}:${novel.novelPath}`, novel.name || 'This novel');
    if (act === 'engine') {
      void Narration.setVoiceSettings({ delivery: engineValue(el.dataset.v) }).then(load).then(onChange);
      if (el.dataset.v === 'kokoro') kokoroPanel();
    }
    if (act === 'novel-kokoro') kokoroPanel();
    if (act === 'narrator-settings') openNarratorSettings(() => onChange?.());
    if (act === 'expressive') openExpressiveLab();
  });
  render();
  void load();
}

/** Listen player › Voice › Kokoro voice: this novel's Kokoro voice (three first, every voice one tap further). */
function openNovelKokoro(novel: { pluginId: string; novelPath: string; name: string }, onChange: () => void): void {
  const p = panel('Kokoro voice', 'novel-kokoro');
  const key = { pluginId: novel.pluginId, novelPath: novel.novelPath };
  let info: VoiceSettingsInfo | null = null;
  let failed = false;
  const render = (): void => {
    if (!info) {
      p.body.innerHTML = failed ? UNAVAILABLE : '<p class="note">Loading…</p>';
      return;
    }
    const own = info.novelVoice ?? null;
    p.body.innerHTML = `
      <div class="sec">Kokoro voice for this novel</div>
      ${backupCard(info, info.effectiveVoice ?? info.defaultVoice)}
      <p class="note">${own ? 'This novel has its own Kokoro voice.' : `Using the default (${esc(choiceName(info, info.defaultVoice))}).`} Kokoro also stands in when the Narrator can’t keep up.</p>
      ${own ? '<button type="button" class="btn alt" data-act="use-default">Use the default voice</button>' : ''}
      <button type="button" class="btn alt" data-act="make-default">Make it the default for all novels</button>`;
  };
  const load = async (): Promise<void> => {
    info = normalizeVoiceSettings(await Narration.voiceSettings(key).catch(() => null));
    failed = !info;
    render();
  };
  const done = (): Promise<void> => load().then(onChange);
  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (el?.dataset.act === 'retry') return void load();
    if (!el || !info) return;
    const act = el.dataset.act;
    if (act === 'sample') return void sample(el as HTMLButtonElement, el.dataset.voice ?? 'af_heart');
    if (act === 'pick' && el.dataset.voice) void Narration.setVoiceSettings({ novel: { ...key, voice: el.dataset.voice } }).then(done);
    if (act === 'use-default') void Narration.setVoiceSettings({ novel: { ...key, voice: null } }).then(done);
    if (act === 'make-default' && info.effectiveVoice) {
      void Narration.setVoiceSettings({ defaultVoice: info.effectiveVoice, novel: { ...key, voice: null } }).then(done);
    }
    if (act === 'kokoro-all') openKokoroVoices(key, () => void done());
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
