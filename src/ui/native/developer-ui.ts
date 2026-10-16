/**
 * More › Developer (cleanup 1, 2026-10-15): the voice's test tools and internals, out of More › Voices and the Listen
 * player so the app looks finished. Shown while Developer options are on (dev-flags.ts: tap the version in More › About
 * 7 times; the switch at the bottom of About turns them off). An iOS grouped list, in the Voices screens' style:
 *   - Nephis: Voice Speed Test, Voice Test, 15-Minute Test, Voice Packs, Studio (Automatic / Off, for the pack in use:
 *     ExpressiveVoice.studioEnable, NephisStudioSwitch), Where Her Studio Runs (Core ML placement, on demand);
 *   - Delivery Internals: Natural Delivery, AI Scene Reading, Studio Sound (automatic unless switched off here), Reset
 *     to Defaults;
 *   - Diagnostics: Scene-Reading Test, Mood Test, Voice Report (copied), Now Playing (read once per tap), Voice Models
 *     (expressive-lab.ts: download, delete, free memory), Show Voice Details in the Player;
 *   - Backup Voice: Mix a Voice (voices-ui.ts openMixer);
 *   - Pronunciations: the phonemes field and JSON paste in the pronunciation editor;
 *   - Legacy: Use PC Audio and its Audio Folder, the Kokoro Voice Lab.
 * Nothing here polls: each number is read when the screen opens or when its row is tapped.
 */
import { developer, normalizeDeveloper, noteDeveloper, setDeveloper } from './dev-flags.ts';
import { ExpressiveVoice, openExpressiveLab } from './expressive-lab.ts';
import { Narration, type VoiceSettingsInfo } from './narration.ts';
import { chapterMoodTest, openVoiceLab, sceneReadingTest } from './voice-lab.ts';
import { normalizePacks, openVoicePacks, packsSummary } from './voice-packs.ts';
import { openVoiceSpeedTest } from './voice-speed.ts';
import { chipSummary, copyText, openVoiceTest } from './voice-test.ts';
import { chevron, esc, panel, segmented, skeleton, switchInput, toast, unavailable } from './panel.ts';
import { deliverySwitch, normalizeVoiceSettings, openMixer, VOICE_SETTINGS_CHANGED } from './voices-ui.ts';

type Obj = Record<string, unknown>;

/** Her packs and studio exist in the personal flavor only (NephisModelPack.swift). */
const PACKS = __FLAVOR__ === 'personal';

/** The pack in use as ExpressiveVoice.status reports it; null: none installed; undefined: not known (yet). */
export interface PackState {
  name: string;
  studio: boolean;
  studioOn: boolean;
}

export function packState(raw: unknown): PackState | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Obj;
  return { name: typeof p.name === 'string' && p.name ? p.name : 'unnamed', studio: p.studio === true, studioOn: p.studioOn === true };
}

/** What CarPlay and the lock screen show now, in one line (Narration.voiceLab's car.nowPlaying). */
export function nowPlayingLine(lab: unknown): string {
  const car = lab && typeof lab === 'object' ? ((lab as Obj).car as Obj | undefined) : undefined;
  const np = car && typeof car.nowPlaying === 'object' && car.nowPlaying ? (car.nowPlaying as Obj) : {};
  const text = (x: unknown): string => (typeof x === 'string' || typeof x === 'number' ? String(x) : '');
  if (!text(np.title)) return 'Nothing is showing.';
  const time = typeof np.elapsed === 'number' && typeof np.duration === 'number' ? ` · ${Math.round(np.elapsed)} of ${Math.round(np.duration)} s` : '';
  return [text(np.title), text(np.artist), text(np.album)].filter(Boolean).join(' · ') + time;
}

/** Voice settings without Kokoro's voice list (normalizeVoiceSettings needs it): what the Developer screen reads. */
function withoutVoices(raw: VoiceSettingsInfo): VoiceSettingsInfo {
  return {
    voices: [],
    defaultVoice: '',
    kokoroEnabled: raw.kokoroEnabled !== false,
    usePCAudio: raw.usePCAudio === true,
    kokoro: { bundled: false, status: '', ready: false, crashDisabled: false, crashes: 0, revision: null, bytes: null },
    apple: { name: 'System voice', quality: 'default', onlyDefault: true },
    ...(raw.delivery ? { delivery: raw.delivery } : {}),
    developer: normalizeDeveloper(raw.developer),
  };
}

function row(act: string, title: string, sub: string, testId = `dev-${act}`): string {
  return `<button type="button" class="row" data-act="${act}" data-testid="${testId}"><span class="main"><b>${esc(title)}</b><span class="sub" data-sub="${act}">${esc(sub)}</span></span>${chevron()}</button>`;
}

function toggle(act: string, title: string, sub: string, on: boolean, disabled = false): string {
  return `<label class="row" data-testid="dev-${act}"><span class="main"><b>${esc(title)}</b><span class="sub">${esc(sub)}</span></span>${switchInput(`data-act="${act}"`, on, title, disabled)}</label>`;
}

export function openDeveloperScreen(): void {
  const p = panel('Developer', 'screen-developer');
  let info: VoiceSettingsInfo | null = null;
  let failed = false;
  let pack: PackState | null | undefined;
  let packsLine = '…';
  let placement = '';
  let scene = '';
  let mood = '';
  let moodReport: Obj | null = null;
  let nowPlaying = '';
  let folder = '';
  let busy = new Set<string>();

  const studioRows = (): string => {
    if (!PACKS) return '';
    const studioSub =
      pack === undefined ? '…' : pack === null ? 'No voice pack installed.' : pack.studio ? `For “${pack.name}”: her 44.1 kHz sound on every call the phone can afford.` : `“${pack.name}” has no studio.`;
    const control = pack?.studio
      ? segmented(
          'studio',
          'Studio',
          [
            ['auto', 'Automatic'],
            ['off', 'Off'],
          ],
          pack.studioOn ? 'auto' : 'off',
        )
      : '';
    const where = pack?.studio ? row('placement', 'Where Her Studio Runs', placement || (busy.has('placement') ? 'Checking…' : 'Which chip runs each part (Core ML), checked on its own')) : '';
    return `${row('packs', 'Voice Packs', packsLine)}
      <div class="row" data-testid="dev-studio"><span class="main"><b>Studio</b><span class="sub">${esc(studioSub)}</span></span></div>${control ? `<div class="row seg-row">${control}</div>` : ''}${where}`;
  };

  const render = (): void => {
    if (!info) {
      p.body.innerHTML = failed ? unavailable('Developer options aren’t available right now.') : skeleton(4);
      return;
    }
    const d = info.delivery;
    const natural = d?.natural !== false;
    const dev = developer();
    p.body.innerHTML = `
      <div class="sec">Nephis</div>
      <div class="card" data-testid="dev-nephis">
        ${row('speed', 'Voice Speed Test', 'Times her voice on a 45-second passage, then saves the report')}
        ${row('test', 'Voice Test', 'A 2-minute passage read aloud like Listen, then the report')}
        ${row('long', '15-Minute Test', 'Records what plays while you listen to your own chapter')}
        ${studioRows()}
        ${toggle('best-of-two', 'Best of 2 Takes for Audio', 'Downloaded chapters: two takes per call, the better one kept (twice the work)', dev.bestOfTwo)}
      </div>
      <div class="sec">Delivery Internals</div>
      <div class="card" data-testid="dev-delivery">
        ${deliverySwitch(info, 'natural', 'Natural Delivery', 'Paragraphs read as one thought, pauses that fit the scene')}
        ${deliverySwitch(info, 'sceneAI', 'AI Scene Reading', d?.sceneAIAvailable === true ? 'Apple Intelligence picks the mood of each scene' : 'Apple Intelligence isn’t available on this iPhone: the built-in rules pick the moods', !natural)}
        ${deliverySwitch(info, 'studioSound', 'Studio Sound', 'Level and polish after each call', !natural)}
        <button type="button" class="row" data-act="reset" data-testid="dev-reset"><span class="main"><b class="tint">Reset to Defaults</b><span class="sub">All of these on${PACKS ? ', her studio Automatic' : ''}</span></span></button>
      </div>
      <p class="note">These are automatic: switch one off here only to compare.</p>
      <div class="sec">Diagnostics</div>
      <div class="card" data-testid="dev-diagnostics">
        ${row('scene', 'Scene-Reading Test', scene || (busy.has('scene') ? 'Reading the test scenes…' : 'The rules and Apple Intelligence against labelled scenes'))}
        ${row('mood', 'Mood Test', mood || (busy.has('mood') ? 'Reading the chapter…' : 'Moods for the chapter you last listened to'))}
        ${moodReport ? row('mood-copy', 'Copy Mood Report', 'Every sentence’s mood, for the PC') : ''}
        ${row('report', 'Voice Report', 'Copies the voice’s numbers (speed, fallbacks, crashes, device)')}
        ${row('now-playing', 'Now Playing', nowPlaying || 'What CarPlay and the lock screen show, read when you tap')}
        ${row('models', 'Voice Models', 'Her model: status, delete, free memory')}
        ${toggle('player-details', 'Show Voice Details in the Player', 'The player names the voice that really speaks, and why a stand-in reads', dev.playerDetails)}
      </div>
      <div class="sec">Backup Voice</div>
      <div class="card">${row('mix', 'Mix a Voice', 'Blend two Kokoro voices into your own')}</div>
      <div class="sec">Pronunciations</div>
      <div class="card">${toggle('phonemes', 'Phonemes and JSON Paste', 'Kokoro phonemes and pasted lexicons in the pronunciation editor', dev.phonemes)}</div>
      <div class="sec">Legacy</div>
      <div class="card" data-testid="dev-legacy">
        ${toggle('pcaudio', 'Use PC Audio', 'Chapters narrated on the PC (“TachiNovel Audio” folder) play instead of her voice', info.usePCAudio)}
        ${info.usePCAudio ? row('folder', 'Audio Folder', folder || '…') : ''}
        ${row('lab', 'Kokoro Voice Lab', 'Her backup voice’s live numbers')}
      </div>
      <p class="note">Turn Developer options off at the bottom of More › About.</p>`;
    if (info.usePCAudio && !folder) {
      void Narration.audioFolder()
        .then((f) => {
          folder = f.linked ? (f.name ?? 'Linked') : 'Not linked: tap to choose iCloud Drive › TachiNovel Audio';
          const el = p.body.querySelector('[data-sub="folder"]');
          if (el) el.textContent = folder;
        })
        .catch(() => undefined);
    }
  };

  const loadPack = async (): Promise<void> => {
    if (!PACKS) return;
    const [st, list] = await Promise.all([ExpressiveVoice.status().catch((): Obj => ({})), ExpressiveVoice.nephisPacks().then(normalizePacks, () => null)]);
    pack = packState(st.nephisPack);
    packsLine = packsSummary(list);
    render();
  };

  const load = async (): Promise<void> => {
    const raw = await Narration.voiceSettings().catch(() => null);
    // Without Kokoro's voice list (it didn't load) the tools still work; only Mix a Voice needs it.
    info = normalizeVoiceSettings(raw) ?? (raw ? withoutVoices(raw) : null);
    failed = !info;
    if (info) noteDeveloper(info.developer);
    render();
  };

  /** One run at a time per row: the row says what it is doing, then the result. */
  const run = (key: string, work: () => Promise<void>): void => {
    if (busy.has(key)) return;
    busy = new Set([...busy, key]);
    render();
    void work()
      .catch((err: unknown) => toast(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        busy = new Set([...busy].filter((k) => k !== key));
        render();
      });
  };

  p.body.addEventListener('click', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-act]');
    if (!el || el.tagName === 'INPUT') return;
    if (el.dataset.act === 'retry') return void load();
    if (!info) return;
    switch (el.dataset.act ?? '') {
      case 'speed':
        return openVoiceSpeedTest();
      case 'test':
        return openVoiceTest();
      case 'long':
        return openVoiceTest({ long: true });
      case 'packs':
        return openVoicePacks(() => void loadPack());
      case 'studio': {
        const on = el.dataset.v === 'auto';
        if (!pack?.studio || pack.studioOn === on) return;
        return run('studio', async () => {
          const r = await ExpressiveVoice.studioEnable({ on });
          if (pack) pack = { ...pack, studioOn: r.enabled === true };
          toast(pack?.studioOn ? 'Studio Automatic: from her next sentence.' : 'Studio off: from her next sentence.');
        });
      }
      case 'placement':
        return run('placement', async () => {
          const r = await ExpressiveVoice.studioTest({ placement: true });
          placement = r.placement ? chipSummary(r.placement) || 'No Core ML parts reported.' : typeof r.error === 'string' ? r.error : 'Couldn’t check where her studio runs.';
        });
      case 'reset':
        return run('reset', async () => {
          await Narration.setVoiceSettings({ delivery: { natural: true, sceneAI: true, studioSound: true } });
          if (PACKS && pack?.studio && !pack.studioOn) {
            const r = await ExpressiveVoice.studioEnable({ on: true });
            pack = { ...pack, studioOn: r.enabled === true };
          }
          await load();
          toast('Voice defaults restored');
        });
      case 'scene':
        return run('scene', async () => {
          scene = await sceneReadingTest();
        });
      case 'mood':
        return run('mood', async () => {
          const r = await chapterMoodTest();
          mood = r.summary;
          moodReport = r.report;
        });
      case 'mood-copy':
        if (moodReport) void copyText(JSON.stringify(moodReport)).then((label) => toast(label === 'Copied' ? 'Mood report copied' : 'Share it to copy'));
        return;
      case 'report':
        return run('report', async () => {
          const [lab, status] = await Promise.all([Narration.voiceLab().catch(() => null), ExpressiveVoice.status().catch(() => null)]);
          const label = await copyText(JSON.stringify({ kind: 'voice-report', at: new Date().toISOString(), voiceLab: lab, expressive: status }, null, 2));
          toast(label === 'Copied' ? 'Voice report copied' : 'Share it to copy');
        });
      case 'now-playing':
        return run('now-playing', async () => {
          nowPlaying = nowPlayingLine(await Narration.voiceLab());
        });
      case 'models':
        return openExpressiveLab();
      case 'mix':
        if (info.voices.length === 0) return toast('Kokoro’s voices aren’t available right now');
        return openMixer(info, null, () => void load());
      case 'folder':
        void Narration.pickAudioFolder().then(() => {
          folder = '';
          return load();
        });
        return;
      case 'lab':
        return openVoiceLab();
      default:
    }
  });

  p.body.addEventListener('change', (ev) => {
    const el = ev.target as HTMLInputElement;
    const act = el.dataset.act;
    if (act === 'delivery' && el.dataset.k) {
      void Narration.setVoiceSettings({ delivery: { [el.dataset.k]: el.checked } }).then(load);
    } else if (act === 'player-details' || act === 'phonemes' || act === 'best-of-two') {
      void setDeveloper(act === 'phonemes' ? { phonemes: el.checked } : act === 'best-of-two' ? { bestOfTwo: el.checked } : { playerDetails: el.checked })
        .catch((err: unknown) => toast(`Couldn’t change it: ${err instanceof Error ? err.message : String(err)}`))
        .then(render);
    } else if (act === 'pcaudio') {
      void Narration.setVoiceSettings({ usePCAudio: el.checked })
        .then(load)
        .then(() => window.dispatchEvent(new Event(VOICE_SETTINGS_CHANGED)));
    }
  });

  render();
  void load();
  void loadPack();
}
