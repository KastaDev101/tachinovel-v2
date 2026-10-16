/**
 * Voices UI (v2 additions over the unchanged v1 UI), in v1's grouped-list look (panel.ts; cleanup 2, 2026-10-16):
 *
 *  - More › Voices (a "Voices" row injected into v1's More list, see v1-hooks.ts):
 *      Nephis: Narrator (her pack, "· Studio" when its studio is on) and Dialogue (her dialogue pack, or "Uses the
 *        narrator") in the personal flavor, "Turn Nephis Back On" after crashes, "Download Her Voice" with its progress
 *        while her model isn't on the phone, Voice Settings (Scene Moods and [System] messages);
 *      Backup Voice: the Kokoro voice that reads only when she can't (her matched voice by default), its list (the three
 *        best first, then All Voices, with ▶ samples);
 *      Pronunciations: Names & Made-Up Words (every novel);
 *      In the Car: Car Buttons (segmented), Prepared Audio.
 *    The test tools, voice packs, her studio switch, the delivery internals and the mixer are in More › Developer
 *    (developer-ui.ts).
 *  - The voice mixer (More › Developer › Mix a Voice; Edit on a mix in All Voices with Developer options on): two voices
 *    and a blend slider, ▶ to listen, saved under a name in "Your Mixes" (on this iPhone). Rules in voice-mix.ts.
 *  - The Listen player's Voice panel for one novel (titled with the novel): her rows and Voice Settings, the novel's
 *    pronunciations (and the Voice Speed Test with Developer options on).
 *  - Pronunciations (global or one novel, "All Novels | This Novel"): word → respelling, and with Developer options
 *    Kokoro phonemes and a pasted lexicon (v1 frontend.ts's lexicon format).
 *
 * Nothing here polls, except her model's download progress while it downloads (once a second).
 */
import { isKokoroPhonemes, validateLexicon, type Lexicon, type LexiconEntry } from '@v1tts/frontend.ts';
import { engineEntry } from '../../core/narration/user-pronunciations.ts';
import { callCore } from '../capacitor-client.ts';
import { isDeveloper, normalizeDeveloper, showsPhonemes, showsVoiceDetails } from './dev-flags.ts';
import { normalizeDriveStatus, storageLine } from './drive-status.ts';
import { ExpressiveVoice } from './expressive-lab.ts';
import { voiceLabel as describeVoice } from './listen-controls.ts';
import {
  Narration,
  type CarButtons,
  type CustomVoiceInfo,
  type DeliveryInfo,
  type KokoroVoiceInfo,
  type NarrationState,
  type VoiceSettingsInfo,
} from './narration.ts';
import { check, chevron, confirmStep, esc, icon, panel, segmented, skeleton, switchInput, toast, unavailable, type Panel } from './panel.ts';
import { gradeRank, groupVoices } from './voice-groups.ts';
import { blendVoice, cleanMixName, mixPercent, mixProblem, mixShares, suggestedMixName, usableMixes } from './voice-mix.ts';
import { openVoiceSpeedTest } from './voice-speed.ts';

type Obj = Record<string, unknown>;

/** Window event: the voice settings changed (v1-hooks.ts reads them again: Developer options). */
export const VOICE_SETTINGS_CHANGED = 'tn-voice-settings';

export const SAMPLE_TEXT = 'The rain had stopped by the time we reached the old bridge, and for a moment the whole city held its breath.';

/**
 * Subtitle for the mini player / Listen player: which voice is speaking ("Nephis" or "Backup voice"; the engine and
 * the reason for a stand-in with Developer options' "Show Voice Details in the Player"). A prepared chapter is filed
 * under her key ("nephis|<pack>|…", NarrationController.preparedNephisKey) when she made it.
 */
export function voiceLabel(s: Pick<NarrationState, 'engine' | 'voice' | 'status' | 'prepared'>, details = showsVoiceDetails()): string {
  if (s.engine === 'audio' && s.prepared) {
    if ((s.voice?.kokoroVoice ?? '').startsWith('nephis|')) return 'Nephis · prepared';
    return details ? `Kokoro · ${s.voice?.kokoroName ?? 'prepared'} · prepared` : 'Backup voice · prepared';
  }
  return describeVoice(s, details);
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
    backupVoice: isChoice(r.backupVoice) ? r.backupVoice : null,
    kokoroEnabled: r.kokoroEnabled !== false,
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
    developer: normalizeDeveloper(r.developer),
  };
}

function describe(v: KokoroVoiceInfo): string {
  return v.blurb || (v.grade ? `Kokoro grade ${v.grade}` : `${v.language === 'en-GB' ? 'British' : 'American'} · ${v.gender}`);
}

/** ▶ a Kokoro sample; the button dims while it starts (the first Kokoro use after install compiles the model). */
async function sample(btn: HTMLButtonElement, voice: string, text = SAMPLE_TEXT, runs?: { t?: string; p?: string }[]): Promise<void> {
  if (btn.classList.contains('is-busy')) return;
  btn.classList.add('is-busy');
  const slow = setTimeout(() => toast('Preparing the voice… the first time after installing can take up to a minute.'), 2500);
  try {
    await Narration.sampleVoice({ voice, text, ...(runs ? { runs } : {}) });
  } catch (err) {
    toast(`Couldn’t play the sample: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    clearTimeout(slow);
    btn.classList.remove('is-busy');
  }
}

function playButton(id: string, name: string): string {
  return `<button type="button" class="play" data-act="sample" data-voice="${esc(id)}" aria-label="Play a sample of ${esc(name)}">${icon('play.fill', 16)}</button>`;
}

function voiceRow(v: KokoroVoiceInfo, selected: string): string {
  return `<div class="row" data-voice="${esc(v.id)}">${playButton(v.id, v.name)}
      <button type="button" class="main" data-act="pick" data-voice="${esc(v.id)}"${v.id === selected ? ' aria-current="true"' : ''}><b>${esc(v.name)}</b><span class="sub">${esc(describe(v))}</span></button>${check(v.id === selected)}</div>`;
}

function mixRow(info: VoiceSettingsInfo, m: CustomVoiceInfo, selected: string, editable: boolean): string {
  return `<div class="row" data-voice="${esc(m.id)}">${playButton(m.id, m.name)}
      <button type="button" class="main" data-act="pick" data-voice="${esc(m.id)}"${m.id === selected ? ' aria-current="true"' : ''}><b>${esc(m.name)}</b><span class="sub">${esc(mixShares(info.voices, m.a, m.b, m.percent))}</span></button>
      ${editable ? `<button type="button" class="edit" data-act="mix-edit" data-mix="${esc(m.id)}" aria-label="Edit ${esc(m.name)}">Edit</button>` : ''}${check(m.id === selected)}</div>`;
}

/**
 * Every voice grouped by accent and gender, best-graded first (a header and a card per group), then "Your Mixes".
 * `editable` (Developer options) adds Edit to each mix and a "Mix a Voice" row.
 */
function voiceRows(info: VoiceSettingsInfo, selected: string, editable: boolean): string {
  const groups = groupVoices(info.voices)
    .map((g) => `<div class="sec" data-group="${esc(g.key)}">${esc(g.label)}</div><div class="card">${g.voices.map((v) => voiceRow(v, selected)).join('')}</div>`)
    .join('');
  const mixes = info.customVoices ?? [];
  const newRow = editable ? `<button type="button" class="row" data-act="mix-new"><span class="main"><b class="tint">Mix a Voice</b></span>${chevron()}</button>` : '';
  if (mixes.length === 0 && !newRow) return groups;
  return `${groups}<div class="sec" data-group="mixes">Your Mixes</div><div class="card" data-testid="voice-mixes">${mixes.map((m) => mixRow(info, m, selected, editable)).join('')}${newRow}</div>`;
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

type DeliverySwitch = Exclude<keyof DeliveryInfo, 'listenEngine' | 'sceneAIAvailable' | 'pocketVoice' | 'pocketInstalled' | 'nephisOff' | 'nephisOffLine'>;

/** A delivery switch row (Voice Settings here, the delivery internals in More › Developer). `sub`: a status line. */
export function deliverySwitch(info: VoiceSettingsInfo, k: DeliverySwitch, label: string, sub = '', disabled = false): string {
  const d = { ...DELIVERY_DEFAULT, ...info.delivery };
  return `<label class="row"><span class="main"><b>${esc(label)}</b>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>${switchInput(`data-act="delivery" data-k="${k}"`, d[k], label, disabled)}</label>`;
}

/** Who picks the scene's mood, in words (Voice Settings): Apple Intelligence where the iPhone has it, else the rules. */
export function sceneLine(delivery: Partial<DeliveryInfo> | undefined): string {
  const d = { ...DELIVERY_DEFAULT, ...delivery };
  if (!d.natural) return 'Natural delivery is off in More › Developer, so she reads without scene moods.';
  return d.sceneAI && d.sceneAIAvailable === true ? 'Scene moods use Apple Intelligence.' : 'Scene moods use built-in rules.';
}

/** Voice Settings: Scene Moods and [System] messages. Natural delivery, the AI scene reading and studio sound are
 * automatic (More › Developer overrides them). */
function voiceSettingsCards(info: VoiceSettingsInfo): string {
  const natural = { ...DELIVERY_DEFAULT, ...info.delivery }.natural;
  return `<div class="sec">Scene</div>
    <div class="card" data-testid="voices-delivery">${deliverySwitch(info, 'moods', 'Scene Moods', '', !natural)}</div>
    <p class="note" data-testid="voices-scene-line">Tense, sad, tender and more where the scene calls for them. ${esc(sceneLine(info.delivery))}</p>
    <div class="sec">[System] Messages</div>
    <div class="card">${deliverySwitch(info, 'systemChime', 'System Message Chime')}${deliverySwitch(info, 'systemTone', 'System Message Voice')}</div>
    <p class="note">A soft chime and an interface tone for [System] lines.</p>`;
}

/** Nephis is the voice reading chapters. */
function nephisReads(info: VoiceSettingsInfo): boolean {
  return info.delivery?.listenEngine === 'pocket-tts' && info.delivery.pocketVoice === 'nephis';
}

/**
 * Why Nephis is switched off (her model crashed twice in a row while the app was in use), in plain words; null while
 * she isn't. Swipe-aways, updates, AltStore refreshes and iOS closing the app for memory never switch her off.
 */
export function nephisOffLine(delivery: Partial<DeliveryInfo> | undefined): string | null {
  if (delivery?.nephisOff !== true) return null;
  return typeof delivery.nephisOffLine === 'string' && delivery.nephisOffLine ? delivery.nephisOffLine : 'Nephis was switched off after crashing twice in a row.';
}

/** Nephis reads chapters: set it when another voice was chosen before (the old Narrator, Kokoro, an experiment). */
export async function ensureNephis(): Promise<void> {
  const info = normalizeVoiceSettings(await Narration.voiceSettings().catch(() => null));
  if (!info || nephisReads(info)) return;
  await Narration.setVoiceSettings({ delivery: { listenEngine: 'pocket-tts', pocketVoice: 'nephis' }, kokoroEnabled: true }).catch(() => undefined);
}

// ---------------------------------------------------------------- her rows (packs, download)

/** The Narrator row's value: "<pack> · Studio" (studio on), the pack, or the voice the app came with; null: unknown. */
export function narratorValue(status: Obj | null): string | null {
  if (!status || !('nephisPack' in status)) return null;
  const p = status.nephisPack;
  if (!p || typeof p !== 'object') return 'Built-in voice';
  const o = p as Obj;
  const name = typeof o.name === 'string' && o.name ? o.name : 'Unnamed pack';
  return o.studio === true && o.studioOn === true ? `${name} · Studio` : name;
}

/** The Dialogue row's value: her dialogue pack, or "Uses the narrator" without one; null: unknown. */
export function dialogueValue(status: Obj | null): string | null {
  if (!status) return null;
  const d = status.dialoguePack;
  if (!d || typeof d !== 'object') return 'Uses the narrator';
  const name = (d as Obj).name;
  return typeof name === 'string' && name ? name : 'Unnamed pack';
}

/** Her model's download (ExpressiveVoice.status().engines, Pocket TTS). */
export interface HerDownload {
  state: 'idle' | 'downloading' | 'failed';
  /** 0…1 while downloading. */
  fraction: number;
  error: string;
  /** The model's size; null when native didn't say. */
  bytes: number | null;
  installed: boolean | null;
}

export function herDownload(status: unknown): HerDownload {
  const s = (status && typeof status === 'object' ? status : {}) as Obj;
  const engines = Array.isArray(s.engines) ? (s.engines as unknown[]) : [];
  const e = (engines.find((x) => !!x && typeof x === 'object' && (x as Obj).id === 'pocket-tts') ?? {}) as Obj;
  const dl = (e.download && typeof e.download === 'object' ? e.download : {}) as Obj;
  const f = typeof dl.fraction === 'number' && Number.isFinite(dl.fraction) ? Math.min(1, Math.max(0, dl.fraction)) : 0;
  return {
    state: dl.state === 'downloading' ? 'downloading' : dl.state === 'failed' ? 'failed' : 'idle',
    fraction: f,
    error: typeof dl.error === 'string' ? dl.error : '',
    bytes: typeof e.bytes === 'number' && e.bytes > 0 ? e.bytes : null,
    installed: typeof e.installed === 'boolean' ? e.installed : null,
  };
}

/** "~370 MB" (her model's size, or the usual size when native didn't say). */
export function downloadSize(bytes: number | null): string {
  return `~${Math.round((bytes ?? 370e6) / 1e6)} MB`;
}

/** Nephis's packs exist in the personal flavor only (NephisModelPack.swift). */
const PACKS = __FLAVOR__ === 'personal';

const settingsRow = (): string =>
  `<button type="button" class="row" data-act="narrator-settings" data-testid="voices-settings"><span class="main"><b>Voice Settings</b></span>${chevron()}</button>`;

function valueRow(title: string, value: string | null, testId: string): string {
  const v = value === null ? '<span class="skel skel-line" style="width:96px"></span>' : esc(value);
  return `<div class="row" data-testid="${testId}"><span class="main"><b>${esc(title)}</b></span><span class="val">${v}</span></div>`;
}

/**
 * Nephis's rows for More › Voices and the novel's Voice panel: Narrator and Dialogue (her packs, personal flavor),
 * "Turn Nephis Back On", "Download Her Voice" (and its progress), Voice Settings. ExpressiveVoice.status() is read when
 * the panel opens (when it has something to say) and once a second only while her model downloads.
 */
function herRows(p: Panel, repaint: () => void, reload: () => Promise<void>): {
  rows: (info: VoiceSettingsInfo) => string;
  footer: (info: VoiceSettingsInfo) => string;
  click: (act: string) => boolean;
  start: (info: VoiceSettingsInfo) => void;
} {
  let status: Obj | null = null;
  let asked = false;
  let timer = 0;
  let closed = false;
  p.onClose(() => {
    closed = true;
    window.clearTimeout(timer);
  });

  const paintProgress = (): void => {
    const d = herDownload(status);
    const row = p.body.querySelector<HTMLElement>('[data-testid="voices-download"]');
    if (!row || d.state !== 'downloading') return repaint();
    const pct = Math.round(d.fraction * 100);
    const val = row.querySelector('[data-dl-pct]');
    if (val) val.textContent = `${pct}%`;
    row.querySelector<HTMLElement>('.prog i')?.style.setProperty('width', `${pct}%`);
    row.querySelector('.prog')?.setAttribute('aria-valuenow', String(pct));
  };

  const poll = (): void => {
    window.clearTimeout(timer);
    if (!closed && herDownload(status).state === 'downloading') timer = window.setTimeout(() => void refresh(), 1000);
  };

  const refresh = async (): Promise<void> => {
    const was = herDownload(status).state;
    const s = await ExpressiveVoice.status().catch(() => null);
    if (closed) return;
    if (s) status = s;
    const now = herDownload(status);
    if (was === 'downloading' && now.state === 'downloading') {
      paintProgress();
    } else if (was === 'downloading') {
      if (now.state === 'failed') toast(`Her voice didn’t download: ${now.error || 'try again on Wi-Fi'}`, true);
      else if (now.installed === true) toast('Her voice is ready.');
      await reload(); // pocketInstalled, and the row goes away
    } else {
      repaint();
    }
    poll();
  };

  const download = async (): Promise<void> => {
    const size = downloadSize(herDownload(status).bytes);
    if (!(await confirmStep('Download Her Voice?', `${size.slice(1)} on this iPhone. Use Wi-Fi and keep TachiNovel open until it’s done.`, 'Download', false))) return;
    try {
      status = await ExpressiveVoice.download({ engine: 'pocket-tts' });
    } catch (err) {
      toast(`Couldn’t start the download: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    if (closed) return;
    repaint();
    poll();
  };

  const cancel = async (): Promise<void> => {
    if (!(await confirmStep('Stop the Download?', 'You can download her voice again later.', 'Stop Download'))) return;
    status = await ExpressiveVoice.cancelDownload({ engine: 'pocket-tts' }).catch(() => status);
    if (closed) return;
    repaint();
    poll();
  };

  const downloadRow = (): string => {
    const d = herDownload(status);
    if (d.state === 'downloading') {
      const pct = Math.round(d.fraction * 100);
      return `<button type="button" class="row" data-act="download-stop" data-testid="voices-download" aria-label="Downloading her voice. Stop the download"><span class="main"><b>Downloading Her Voice…</b><span class="prog" role="progressbar" aria-label="Download" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></span></span><span class="val" data-dl-pct>${pct}%</span></button>`;
    }
    const failed = d.state === 'failed' ? `<span class="sub">${esc(d.error || 'The download stopped.')}</span>` : '';
    return `<button type="button" class="row" data-act="download" data-testid="voices-download">${icon(d.state === 'failed' ? 'exclamationmark.triangle' : 'arrow.down.circle', 22, d.state === 'failed' ? 'warn' : 'tint')}<span class="main"><b class="tint">${d.state === 'failed' ? 'Try the Download Again' : 'Download Her Voice'}</b>${failed}</span><span class="val">${esc(downloadSize(d.bytes))}</span></button>`;
  };

  return {
    rows: (info) => {
      const off = nephisOffLine(info.delivery);
      return [
        PACKS ? valueRow('Narrator', narratorValue(status), 'voices-narrator') + valueRow('Dialogue', dialogueValue(status), 'voices-dialogue') : '',
        off
          ? `<button type="button" class="row" data-act="nephis-on" data-testid="voices-nephis-on">${icon('exclamationmark.triangle', 22, 'warn')}<span class="main"><b class="tint">Turn Nephis Back On</b><span class="sub">${esc(off)} Her backup voice reads meanwhile.</span></span></button>`
          : '',
        info.delivery?.pocketInstalled === false ? downloadRow() : '',
        settingsRow(),
      ].join('');
    },
    footer: (info) =>
      info.delivery?.pocketInstalled === false
        ? 'Her voice downloads once, on Wi-Fi. Until then her backup voice reads.'
        : 'Her own voice, with moods for the scene.',
    click: (act) => {
      if (act === 'download') void download();
      else if (act === 'download-stop') void cancel();
      else if (act === 'nephis-on') {
        void ExpressiveVoice.resetCrashes()
          .then(() => toast('Nephis is back on: she reads from the next sentence.'))
          .catch((err: unknown) => toast(`Couldn’t turn her back on: ${err instanceof Error ? err.message : String(err)}`, true))
          .then(reload);
      } else return false;
      return true;
    },
    start: (info) => {
      if (asked || (!PACKS && info.delivery?.pocketInstalled !== false)) return;
      asked = true;
      void refresh();
    },
  };
}

// ---------------------------------------------------------------- the backup voice

/** Kokoro's voice matched to hers: the backup voice until another is picked. */
export const MATCHED_VOICE = 'af_nephis';

/** The backup voice in use: the one picked, else her matched voice (when this build has it), else Kokoro's default. */
export function backupChoice(info: Pick<VoiceSettingsInfo, 'voices' | 'customVoices' | 'backupVoice' | 'defaultVoice'>): string {
  const ok = (id: string): boolean => info.voices.some((v) => v.id === id) || (info.customVoices ?? []).some((m) => m.id === id);
  if (info.backupVoice && ok(info.backupVoice)) return info.backupVoice;
  return ok(MATCHED_VOICE) ? MATCHED_VOICE : info.defaultVoice;
}

/** The backup list's first rows: her matched voice, then the best-graded voices, three in all (plus the one picked
 * when it isn't among them). */
export function recommendedVoices(voices: readonly KokoroVoiceInfo[], selected: string): string[] {
  const rank = (v: KokoroVoiceInfo): number => v.gradeRank ?? gradeRank(v.grade);
  const best = voices.filter((v) => v.id !== MATCHED_VOICE).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
  const ids = [...(voices.some((v) => v.id === MATCHED_VOICE) ? [MATCHED_VOICE] : []), ...best.map((v) => v.id)].slice(0, 3);
  return ids.includes(selected) ? ids : [...ids, selected];
}

/** A voice's or a mix's name. */
function choiceName(info: VoiceSettingsInfo, id: string | undefined): string {
  return info.voices.find((v) => v.id === id)?.name ?? info.customVoices?.find((m) => m.id === id)?.name ?? id ?? '';
}

function backupRows(info: VoiceSettingsInfo): string {
  const k = info.kokoro;
  if (!k.bundled) {
    return `<div class="row">${icon('exclamationmark.triangle', 22, 'warn')}<span class="main"><b>Not in This Build</b><span class="sub">The Apple voice stands in when she can’t read.</span></span></div>`;
  }
  const off = k.crashDisabled
    ? `<button type="button" class="row" data-act="kokoro-on" data-testid="voices-kokoro-on">${icon('exclamationmark.triangle', 22, 'warn')}<span class="main"><b class="tint">Turn the Backup Voice Back On</b><span class="sub">It was turned off after crashing twice (a known iOS Core ML issue).</span></span></button>`
    : '';
  return `<button type="button" class="row" data-act="backup" data-testid="voices-backup-voice"><span class="main"><b>${esc(choiceName(info, backupChoice(info)))}</b></span><span class="val">Kokoro</span>${chevron()}</button>${off}`;
}

/** Load voice settings into a panel: skeleton, then `render`, or the error with Try Again. */
function loader(
  p: Panel,
  ask: () => Promise<unknown>,
  render: (info: VoiceSettingsInfo) => void,
  what = 'Voices aren’t available right now.',
): { load: () => Promise<void>; info: () => VoiceSettingsInfo | null } {
  let info: VoiceSettingsInfo | null = null;
  const load = async (): Promise<void> => {
    info = normalizeVoiceSettings(await ask().catch(() => null));
    if (info) render(info);
    else p.body.innerHTML = unavailable(what);
  };
  p.body.innerHTML = skeleton(3);
  p.body.addEventListener('click', (ev) => {
    if ((ev.target as Element).closest('[data-act="retry"]')) {
      p.body.innerHTML = skeleton(3);
      void load();
    }
  });
  return { load, info: () => info };
}

/** More › Voices › Backup Voice: the three best voices (her matched one first) with ▶, then All Voices. */
export function openBackupVoice(onDone: () => void): void {
  const p = panel('Backup Voice', 'backup-voice');
  const l = loader(p, () => Narration.voiceSettings(), (info) => {
    const sel = backupChoice(info);
    const rows = recommendedVoices(info.voices, sel).map((id) => {
      const v = info.voices.find((x) => x.id === id);
      if (v) return voiceRow(v, sel);
      const mix = info.customVoices?.find((m) => m.id === id);
      return mix ? mixRow(info, mix, sel, false) : '';
    });
    const all = info.voices.length + (info.customVoices?.length ?? 0);
    p.body.innerHTML = `<div class="sec">Recommended</div><div class="card" data-testid="backup-best">${rows.join('')}</div>
      <div class="card"><button type="button" class="row" data-act="kokoro-all" data-testid="backup-all"><span class="main"><b>All Voices</b></span><span class="val">${all}</span>${chevron()}</button></div>
      <p class="note">Kokoro, the voice built into the app, reads only if Nephis can’t. Its Nephis voice is matched to hers.</p>`;
  });
  const done = (): Promise<void> => l.load().then(onDone);
  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'sample') return void sample(el as HTMLButtonElement, el.dataset.voice ?? MATCHED_VOICE);
    if (el.dataset.act === 'pick' && el.dataset.voice) void Narration.setVoiceSettings({ backupVoice: el.dataset.voice }).then(done);
    if (el.dataset.act === 'kokoro-all') openKokoroVoices(() => void done());
  });
  void l.load();
}

/** Backup Voice › All Voices: every Kokoro voice by accent and gender, and your mixes (Edit and Mix a Voice with
 * Developer options on). */
export function openKokoroVoices(onDone: () => void): void {
  const p = panel('All Voices', 'kokoro-voices');
  const l = loader(p, () => Narration.voiceSettings(), (info) => {
    p.body.innerHTML = voiceRows(info, backupChoice(info), isDeveloper());
  });
  const done = (): Promise<void> => l.load().then(onDone);
  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    const info = l.info();
    if (!el || !info) return;
    const act = el.dataset.act;
    if (act === 'sample') void sample(el as HTMLButtonElement, el.dataset.voice ?? MATCHED_VOICE);
    if (act === 'pick' && el.dataset.voice) void Narration.setVoiceSettings({ backupVoice: el.dataset.voice }).then(done);
    if (act === 'mix-new') openMixer(info, null, () => void done());
    if (act === 'mix-edit') {
      const mix = info.customVoices?.find((m) => m.id === el.dataset.mix);
      if (mix) openMixer(info, mix, () => void done());
    }
  });
  void l.load();
}

// ---------------------------------------------------------------- Voice Settings

/** More › Voices › Voice Settings (and the Listen player's Voice panel): Scene Moods and [System] messages. */
function openNarratorSettings(onDone: () => void): void {
  const p = panel('Voice Settings', 'narrator-settings');
  const l = loader(p, () => Narration.voiceSettings(), (info) => (p.body.innerHTML = voiceSettingsCards(info)));
  p.body.addEventListener('change', (ev) => {
    const el = ev.target as HTMLInputElement;
    if (el.dataset.act === 'delivery' && el.dataset.k) void Narration.setVoiceSettings({ delivery: { [el.dataset.k]: el.checked } }).then(l.load).then(onDone);
  });
  void l.load();
}

// ---------------------------------------------------------------- More › Voices

export function openVoicesScreen(): void {
  const p = panel('Voices', 'screen-voices');
  let driveLine: string | null = null;
  let driveAny = false;
  const her = herRows(p, () => paint(), () => l.load());

  const paint = (): void => {
    const info = l.info();
    if (!info) return;
    p.body.innerHTML = `
      <div class="sec">Nephis</div>
      <div class="card" data-testid="voices-engine">${her.rows(info)}</div>
      <p class="note">${esc(her.footer(info))}</p>
      <div class="sec">Backup Voice</div>
      <div class="card" data-testid="voices-backup">${backupRows(info)}</div>
      <p class="note">Reads only if Nephis can’t, for example when the iPhone is very hot.</p>
      <div class="sec">Pronunciations</div>
      <div class="card"><button type="button" class="row" data-act="lexicon" data-testid="voices-lexicon"><span class="main"><b>Names &amp; Made-Up Words</b></span>${chevron()}</button></div>
      <p class="note">How the voices say them, in every novel. A novel’s own list: Listen player › Voice.</p>
      <div class="sec">In the Car</div>
      <div class="card" data-testid="voices-car">
        <div class="row"><span class="main"><b>Car Buttons</b></span>${segmented('car-buttons', 'Car Buttons', [['chapters', 'Chapters'], ['skip15', '15 Seconds']], info.carButtons ?? 'chapters')}</div>
        <div class="row" data-testid="voices-prepared"><span class="main"><b>Prepared Audio</b><span class="sub" data-drive-total>${driveLine === null ? '<span class="skel skel-line" style="width:120px;height:12px;margin-top:3px"></span>' : esc(driveLine)}</span></span>${driveAny ? '<button type="button" class="link" data-act="drive-clear">Remove All</button>' : ''}</div>
      </div>
      <p class="note">Car Buttons are the two side buttons in CarPlay, on the lock screen, on headphones and on the steering wheel. To listen without waiting on the voice or the internet, open a novel and tap Prepare for the Drive.</p>`;
  };

  const loadDrive = (): void =>
    void Narration.driveStatus()
      .then((s) => {
        const d = normalizeDriveStatus(s);
        driveLine = storageLine(d);
        driveAny = d.prepared.length > 0;
        paint();
      })
      .catch(() => {
        driveLine = '';
        paint();
      });

  const l = loader(p, () => Narration.voiceSettings(), (info) => {
    paint();
    her.start(info);
  });

  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    const info = l.info();
    if (!el || !info) return;
    const act = el.dataset.act ?? '';
    if (her.click(act)) return;
    switch (act) {
      case 'lexicon':
        return openLexiconEditor(null);
      case 'narrator-settings':
        return openNarratorSettings(() => undefined);
      case 'backup':
        return openBackupVoice(() => void l.load());
      case 'kokoro-on':
        void Narration.setVoiceSettings({ kokoroEnabled: true }).then(l.load);
        return;
      case 'car-buttons': {
        const v: CarButtons = el.dataset.v === 'skip15' ? 'skip15' : 'chapters';
        if (v !== info.carButtons) void Narration.setVoiceSettings({ carButtons: v }).then(l.load);
        return;
      }
      case 'drive-clear':
        void confirmStep('Remove All Prepared Audio?', `${driveLine ?? ''}. Listen reads those chapters live instead.`, 'Remove All').then((yes) => {
          if (!yes) return;
          void Narration.clearDrive()
            .then(() => toast('Prepared audio removed'))
            .catch((err: unknown) => toast(`Couldn’t remove it: ${err instanceof Error ? err.message : String(err)}`, true))
            .then(loadDrive);
        });
        return;
      default:
    }
  });
  void l.load();
  loadDrive();
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

/** A new mix starts from the backup voice and the best other voice of a different accent or gender. */
function startingPair(info: VoiceSettingsInfo): { a: string; b: string } {
  const voices = groupVoices(info.voices).flatMap((g) => g.voices);
  const a = voices.find((v) => v.id === backupChoice(info)) ?? voices[0];
  const best = [...voices].sort((x, y) => (y.gradeRank ?? -1) - (x.gradeRank ?? -1));
  const b = best.find((v) => v.id !== a?.id && (v.language !== a?.language || v.gender !== a.gender)) ?? best.find((v) => v.id !== a?.id);
  return { a: a?.id ?? 'af_heart', b: b?.id ?? 'bf_emma' };
}

/**
 * Mix a voice / Edit mix: two voices, the blend slider, ▶, a name, Save (and Delete for a saved mix). The
 * slider and pickers update the screen in place (never rebuilt while a finger is on them).
 */
export function openMixer(info: VoiceSettingsInfo, existing: CustomVoiceInfo | null, onDone: () => void): void {
  const p = panel(existing ? 'Edit Mix' : 'Mix a Voice', 'voice-mixer');
  const start = existing ?? { ...startingPair(info), percent: 50, name: '' };
  let a = start.a;
  let b = start.b;
  let percent = mixPercent(start.percent);
  let busy = false;
  p.body.innerHTML = `
    <div class="sec">Voices</div>
    <div class="card">
      <label class="row"><span class="main"><b>First Voice</b></span><select data-act="mix-a" aria-label="First voice">${voiceOptions(info, a)}</select></label>
      <label class="row"><span class="main"><b>Second Voice</b></span><select data-act="mix-b" aria-label="Second voice">${voiceOptions(info, b)}</select></label>
    </div>
    <div class="sec">Blend</div>
    <div class="card"><div class="mix">
      <div class="mix-shares" data-shares></div>
      <input type="range" class="mix-range" data-act="mix-blend" min="0" max="100" step="1" value="${String(percent)}" aria-label="Blend">
      <div class="mix-ends"><span data-end="a"></span><span data-end="b"></span></div>
    </div></div>
    <button type="button" class="btn alt" data-act="mix-play">${icon('play.fill', 16)}Listen to the Mix</button>
    <div class="sec">Name</div>
    <div class="card"><div class="form"><input type="text" data-act="mix-name" maxlength="40" autocomplete="off" aria-label="Name" value="${esc(existing?.name ?? '')}"></div></div>
    <p class="note warn" data-problem hidden></p>
    <button type="button" class="btn" data-act="mix-save">${existing ? 'Save Changes' : 'Save Mix'}</button>
    ${existing ? '<button type="button" class="btn alt danger" data-act="mix-delete">Delete Mix</button>' : ''}
    <p class="note">Mixes are kept on this iPhone. Pick one in More › Voices › Backup Voice › All Voices.</p>`;
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
        .catch((err: unknown) => toast(`Couldn’t save the mix: ${err instanceof Error ? err.message : String(err)}`, true))
        .finally(() => (busy = false));
      return;
    }
    if (act === 'mix-delete' && existing) {
      busy = true;
      void confirmStep(`Delete “${existing.name}”?`, 'The backup voice goes back to her matched voice if it used this mix.', 'Delete Mix')
        .then(async (yes) => {
          if (!yes) return;
          await Narration.deleteCustomVoice({ id: existing.id });
          toast(`Deleted “${existing.name}”`);
          p.close();
          onDone();
        })
        .catch((err: unknown) => toast(`Couldn’t delete the mix: ${err instanceof Error ? err.message : String(err)}`, true))
        .finally(() => (busy = false));
    }
  });
  reflect();
}

// ---------------------------------------------------------------- one novel's voice

export function openVoicePicker(novel: { pluginId: string; novelPath: string; name: string }, onChange?: () => void): void {
  const p = panel(novel.name || 'This Novel', 'voice-picker');
  const her = herRows(p, () => paint(), () => l.load().then(() => onChange?.()));
  const paint = (): void => {
    const info = l.info();
    if (!info) return;
    p.body.innerHTML = `
      <div class="sec">Voice</div>
      <div class="card" data-testid="voices-engine">${her.rows(info)}${isDeveloper() ? SPEED_TEST_ROW() : ''}</div>
      <div class="sec">Pronunciations</div>
      <div class="card"><button type="button" class="row" data-act="lexicon"><span class="main"><b>Pronunciations for This Novel</b></span>${chevron()}</button></div>
      <p class="note">Character names and made-up words, as the voices should say them.</p>`;
  };
  const l = loader(p, () => Narration.voiceSettings({ pluginId: novel.pluginId, novelPath: novel.novelPath }), (info) => {
    paint();
    her.start(info);
  });
  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el || !l.info()) return;
    const act = el.dataset.act ?? '';
    if (her.click(act)) return;
    if (act === 'lexicon') openLexiconEditor({ key: `${novel.pluginId}:${novel.novelPath}`, name: novel.name || 'This Novel' }, 'novel');
    if (act === 'narrator-settings') openNarratorSettings(() => onChange?.());
    if (act === 'voice-speed') openVoiceSpeedTest();
  });
  void l.load();
}

/** The Voice Speed Test's row (the Listen player's Voice panel, with Developer options on): one tap to it. */
const SPEED_TEST_ROW = (): string =>
  `<button type="button" class="row" data-act="voice-speed" data-testid="voices-speed"><span class="main"><b>Voice Speed Test</b></span>${chevron()}</button>`;

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

const EMPTY_LEXICON: Lexicon = { schemaVersion: 1, entries: [] };

/**
 * Pronunciations: every novel's list, or (with a novel) "All Novels | This Novel" on top. `scope`: the list shown first.
 */
export function openLexiconEditor(novel: { key: string; name: string } | null, scope: 'all' | 'novel' = 'all'): void {
  const p = panel('Pronunciations', 'lexicon-editor');
  let lists: { global: Lexicon; novel: Lexicon } | null = null;
  let failed = false;
  let current: 'all' | 'novel' = novel ? scope : 'all';
  let pasteOpen = false;
  const lex = (): Lexicon => (lists ? (current === 'novel' ? lists.novel : lists.global) : EMPTY_LEXICON);

  const save = async (next: Lexicon): Promise<void> => {
    try {
      await callCore('narration.lexicon.set', { ...(current === 'novel' && novel ? { novelKey: novel.key } : {}), lexicon: next });
      if (lists) lists = current === 'novel' ? { ...lists, novel: next } : { ...lists, global: next };
      render();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    }
  };

  const render = (): void => {
    const top = novel ? `<div class="seg-bar">${segmented('scope', 'Which list', [['all', 'All Novels'], ['novel', 'This Novel']], current)}</div>` : '';
    if (!lists) {
      p.body.innerHTML = top + (failed ? unavailable('Pronunciations aren’t available right now.') : skeleton(2));
      return;
    }
    const phonemes = showsPhonemes();
    const l = lex();
    const rows = l.entries
      .map(
        (e, i) => `<div class="row"><button type="button" class="main" data-act="edit" data-i="${i}" aria-label="Change ${esc(e.match)}"><b>${esc(e.match)}</b><span class="sub">${e.say ? `says “${esc(e.say)}”` : ''}${e.say && e.ipa ? ' · ' : ''}${e.ipa ? `/${esc(e.ipa)}/` : ''}</span></button>
        <button type="button" class="play" data-act="test" data-i="${i}" aria-label="Hear ${esc(e.match)}">${icon('play.fill', 16)}</button>
        <button type="button" class="link" data-act="delete" data-i="${i}" aria-label="Delete ${esc(e.match)}">${icon('xmark', 16, 'danger')}</button></div>`,
      )
      .join('');
    const empty = current === 'novel' && novel ? `No words for ${novel.name} yet.` : 'No words yet.';
    p.body.innerHTML = `${top}
      <div class="sec">${l.entries.length} Word${l.entries.length === 1 ? '' : 's'}</div>
      ${rows ? `<div class="card" data-testid="lexicon-words">${rows}</div>` : `<div class="card"><div class="row"><span class="main sub">${esc(empty)} Add a name the voices say wrong.</span></div></div>`}
      <div class="sec">Add a Word</div>
      <div class="card"><div class="form">
        <input type="text" data-f="match" placeholder="Word as written (e.g. Nephis)" autocapitalize="off" autocomplete="off" aria-label="Word as written">
        <input type="text" data-f="say" placeholder="Say it like (e.g. NEF-iss)" autocapitalize="off" autocomplete="off" aria-label="Say it like">
        ${phonemes ? '<input type="text" data-f="ipa" placeholder="Kokoro phonemes, optional (e.g. nˈɛfɪs)" autocapitalize="off" autocomplete="off" spellcheck="false" aria-label="Kokoro phonemes">' : ''}
      </div></div>
      <p class="note">Hyphens between syllables, the stressed one in capitals (NEF-iss, say-SHAHN), or any spelling that sounds right. Tap a word to change it.${phonemes ? ' Phonemes (misaki notation, as in the PC narrator’s lexicon) are exact for Kokoro.' : ''}</p>
      <button type="button" class="btn" data-act="add">Add to ${current === 'novel' ? 'This Novel' : 'All Novels'}</button>
      ${phonemes ? `<button type="button" class="btn alt" data-act="paste-toggle">${pasteOpen ? 'Hide the Lexicon' : 'Paste a Lexicon (JSON)'}</button>` : ''}
      ${phonemes && pasteOpen ? '<div class="card" style="margin-top:16px"><div class="form"><textarea data-f="paste" aria-label="Lexicon JSON" placeholder=\'{"schemaVersion":1,"entries":[{"match":"Nephis","ipa":"nˈɛfɪs"}]}\'></textarea></div></div><button type="button" class="btn" data-act="paste">Merge</button>' : ''}`;
  };

  const field = (name: string): string => (p.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-f="${name}"]`)?.value ?? '').trim();

  const load = (): void => {
    void callCore<{ global: Lexicon; novel: Lexicon | null }>('narration.lexicon.get', novel ? { novelKey: novel.key } : {})
      .then((r) => {
        lists = { global: r.global ?? EMPTY_LEXICON, novel: r.novel ?? EMPTY_LEXICON };
        failed = false;
      })
      .catch(() => {
        failed = true;
      })
      .finally(render);
  };

  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const i = Number(el.dataset.i);
    const l = lex();
    switch (el.dataset.act ?? '') {
      case 'retry':
        failed = false;
        render();
        return load();
      case 'scope': {
        const next = el.dataset.v === 'novel' ? 'novel' : 'all';
        if (next === current) return;
        current = next;
        return render();
      }
      case 'add': {
        const match = field('match');
        const say = field('say');
        // Without the phonemes field (Developer options off) a word keeps the phonemes it had.
        const had = l.entries.find((e) => e.match.trim().toLowerCase() === match.toLowerCase());
        const ipa = showsPhonemes() ? field('ipa') : (had?.ipa ?? '');
        if (!match) return toast('Type the word as it’s written.');
        if (!say && !ipa) return toast('Add how to say it, or its phonemes.');
        if (ipa && !isKokoroPhonemes(ipa)) return toast('Those phonemes have characters Kokoro can’t speak.', true);
        void save(upsertEntry(l, { match, ...(say ? { say } : {}), ...(ipa ? { ipa } : {}) }));
        return;
      }
      case 'edit': {
        const e = l.entries[i];
        if (!e) return;
        for (const [name, value] of [['match', e.match], ['say', e.say ?? ''], ['ipa', e.ipa ?? '']] as const) {
          const input = p.body.querySelector<HTMLInputElement>(`[data-f="${name}"]`);
          if (input) input.value = value;
        }
        p.body.querySelector<HTMLInputElement>('[data-f="say"]')?.focus();
        return;
      }
      case 'delete': {
        const e = l.entries[i];
        if (!e) return;
        void confirmStep(`Delete “${e.match}”?`, 'The voices go back to saying it their own way.', 'Delete').then((yes) => {
          if (yes) void save({ schemaVersion: 1, entries: lex().entries.filter((x) => x !== e) });
        });
        return;
      }
      case 'test': {
        // As narration reads it: a stress respelling ("NEF-iss") as its plain form and phonemes (user-pronunciations.ts).
        const e = l.entries[i] ? engineEntry(l.entries[i]) : undefined;
        if (!e) return;
        // Kokoro says it the way narration will: the phonemes if given, else the respelling.
        const word = e.say ?? e.match;
        const runs = e.ipa ? [{ p: e.ipa }, { t: '. I said, ' }, { p: e.ipa }, { t: '.' }] : undefined;
        void Narration.voiceSettings()
          .then((s) => {
            const info = normalizeVoiceSettings(s);
            return sample(el as HTMLButtonElement, info ? backupChoice(info) : MATCHED_VOICE, `${word}. I said, ${word}.`, runs);
          })
          .catch(() => undefined);
        return;
      }
      case 'paste-toggle':
        pasteOpen = !pasteOpen;
        render();
        return;
      case 'paste': {
        const r = mergePasted(l, field('paste'));
        if ('problems' in r) return toast(r.problems.slice(0, 2).join(' '), true);
        pasteOpen = false;
        void save(r.lexicon);
        return;
      }
      default:
    }
  });
  render();
  load();
}
