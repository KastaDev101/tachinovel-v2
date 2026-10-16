/**
 * Small additions to v1 screens without editing v1 (DOM hooks, re-applied when v1 re-renders):
 *  - More: a "Voices" row (Settings › Voices, voices-ui.ts). v1's "Listen in the Car" row (the PC narrator's screen,
 *    removed: tools/v1.ts stubs it out) is hidden and a "Listen" row opens the Listen player instead.
 *  - About: tap the version to copy it (for bug reports); 7 taps turn Developer options on (dev-flags.ts). While they
 *    are on: a "Developer" row at the bottom of More (developer-ui.ts) and a "Developer Options" switch at the bottom of
 *    About that turns them off.
 *  - Diagnostics: "Share N Crash & Hang Reports" (diagnostics-overlay.ts) and "Voice Speed Test" (voice-speed.ts)
 *    under Copy Full Diagnostics.
 *  - Novel page: "Download with Audio" (audio-ui.tsx) where v1's PC-narrator card was (stubbed out at build time).
 * (Open Source Licenses comes from THIRD_PARTY_NOTICES.md at build time: tools/third-party.ts.)
 */
import { fallbackIconUrl } from '@v1/ui/components/icons.ts';
import { confirmAlert } from '@v1/ui/state/actions.ts';
import { symbols } from '@v1/ui/state/store.ts';
import { errorToast, showToast } from '@v1/ui/state/toast.ts';
import { DEVELOPER_CHANGED, isDeveloper, noteDeveloper, setDeveloper } from './dev-flags.ts';
import { openDeveloperScreen } from './developer-ui.ts';
import { addCrashReportsRow } from './diagnostics-overlay.ts';
import { addAudioCard } from './audio-ui.tsx';
import { Narration } from './narration.ts';
import { openListenPlayer } from './narration-overlay.ts';
import { openVoiceSpeedTest } from './voice-speed.ts';
import { toast, useV1Kit } from './panel.ts';
import { openVoicesScreen, VOICE_SETTINGS_CHANGED } from './voices-ui.ts';

/** Taps on the version in More › About that turn Developer options on (Android's build-number gesture). */
export const DEVELOPER_TAPS = 7;

function cloneRow(anchor: HTMLElement, testId: string, title: string, onClick: () => void): HTMLElement {
  const row = anchor.cloneNode(true) as HTMLElement;
  row.dataset.testid = testId;
  row.style.display = '';
  const t = row.querySelector('.mrow-title');
  if (t) t.textContent = title;
  row.querySelector('.mrow-value')?.remove();
  row.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  });
  return row;
}

function addMoreRows(): void {
  const more = document.querySelector('[data-testid="screen-more"]');
  const anchor = more?.querySelector<HTMLElement>('[data-testid="more-narration"]');
  if (!more || !anchor) return;
  // v1's PC-narrator row (its screen is stubbed out) stays hidden: it only anchors our rows. Our Listen row stands in.
  anchor.style.display = 'none';
  let listen = more.querySelector<HTMLElement>('[data-testid="more-listen"]');
  if (!listen) {
    listen = cloneRow(anchor, 'more-listen', 'Listen', openListenPlayer);
    anchor.after(listen);
  }
  if (!more.querySelector('[data-testid="more-voices"]')) {
    const voices = cloneRow(anchor, 'more-voices', 'Voices', openVoicesScreen);
    // Its own icon: Listen keeps the headphones (both used to show them).
    voices.querySelector<HTMLElement>('.mrow-icon')?.style.setProperty('--icon', `url("${symbols.value.waveform ?? fallbackIconUrl('waveform')}")`);
    (listen ?? anchor).after(voices);
  }
  // Developer: its own group at the bottom of More, while Developer options are on.
  const group = more.querySelector<HTMLElement>('[data-testid="more-developer-group"]');
  if (!isDeveloper()) {
    group?.remove();
  } else if (!group) {
    const list = more.querySelector('.mlist');
    if (!list) return;
    const row = cloneRow(anchor, 'more-developer-options', 'Developer', openDeveloperScreen);
    row.style.display = '';
    row.querySelector<HTMLElement>('.mrow-icon')?.style.setProperty('--icon', `url("${symbols.value.hammer ?? fallbackIconUrl('hammer')}")`);
    const g = document.createElement('div');
    g.className = 'mgroup';
    g.dataset.testid = 'more-developer-group';
    g.append(row);
    list.append(g);
  }
}

/** More › About › Diagnostics: "Share N Crash & Hang Reports" (while there are any) and "Voice Speed Test" under "Copy
 * Full Diagnostics" (copies of that row, re-added when v1 re-renders). */
function addDiagnosticsRow(): void {
  const screen = document.querySelector('[data-testid="screen-diagnostics"]');
  const anchor = screen?.querySelector<HTMLElement>('[data-testid="diagnostics-copy"]');
  if (!screen || !anchor || screen.querySelector('[data-testid="diagnostics-voice-speed"]')) return;
  const crash = screen.querySelector<HTMLElement>('[data-testid="diagnostics-share-crash-reports"]') ?? addCrashReportsRow(anchor);
  const row = anchor.cloneNode(true) as HTMLElement;
  row.dataset.testid = 'diagnostics-voice-speed';
  const title = row.querySelector('.row-title');
  if (title) title.textContent = 'Voice Speed Test';
  row.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openVoiceSpeedTest();
  });
  crash.after(row);
}

/** Taps in a row count while each comes within this long of the one before. */
const TAP_GAP_MS = 1500;

function hookAboutVersion(): void {
  const version = document.querySelector<HTMLElement>('[data-testid="screen-about"] .about-version');
  if (!version || version.dataset.tnDev) return;
  version.dataset.tnDev = '1';
  let taps = 0;
  let last = 0;
  version.addEventListener('click', () => {
    const now = Date.now();
    taps = now - last < TAP_GAP_MS ? taps + 1 : 1;
    last = now;
    // The first tap copies the version (for bug reports); the next ones count toward Developer options.
    if (taps === 1) return void copyVersion(version.textContent.trim());
    if (taps < DEVELOPER_TAPS) return;
    taps = 0;
    if (isDeveloper()) return toast('Developer options are already on');
    void setDeveloper({ on: true })
      .then(() => toast('Developer options on'))
      .catch(() => toast('Couldn’t turn Developer options on'));
  });
}

/** About: "Developer Options" at the bottom while they are on (turning it off hides More › Developer). v1's grouped
 * list markup (controls.tsx Section + SwitchRow). */
function addAboutDeveloperSwitch(): void {
  const list = document.querySelector('[data-testid="screen-about"] .grouped');
  const section = list?.querySelector<HTMLElement>('[data-testid="about-developer"]');
  if (!list) return;
  if (!isDeveloper()) return void section?.remove();
  if (section) return;
  const native = 'switch' in HTMLInputElement.prototype;
  const el = document.createElement('section');
  el.className = 'group';
  el.dataset.testid = 'about-developer';
  el.innerHTML = `<div class="group-body"><label class="row row-switch"><span class="row-main"><span class="row-title">Developer Options</span></span><input type="checkbox" class="${native ? 'switch is-native' : 'switch'}" switch checked aria-label="Developer Options"></label></div><p class="group-footer">Voice tests and internals in More › Developer. Tap the version ${DEVELOPER_TAPS} times to turn them on again.</p>`;
  el.querySelector('input')?.addEventListener('change', (ev) => {
    const input = ev.currentTarget as HTMLInputElement;
    if (input.checked) return;
    void setDeveloper({ on: false })
      .then(() => toast('Developer options off'))
      .catch(() => {
        input.checked = true;
        toast('Couldn’t turn Developer options off');
      });
  });
  list.append(el);
}

async function copyVersion(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Version copied');
  } catch {
    toast(text);
  }
}

export function installV1Hooks(): void {
  // The v2 screens' icons, toast and confirmations are v1's (panel.ts).
  useV1Kit({
    iconUrl: (name) => symbols.value[name] ?? fallbackIconUrl(name),
    toast: (text, error) => (error ? errorToast(text) : void showToast(text)),
    confirm: confirmAlert,
  });
  let queued = false;
  const apply = (): void => {
    queued = false;
    try {
      addMoreRows();
      hookAboutVersion();
      addAboutDeveloperSwitch();
      addDiagnosticsRow();
      addAudioCard();
    } catch (err) {
      console.warn('v1 hooks', err);
    }
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(apply);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  const refresh = (): void =>
    void Narration.voiceSettings()
      .then((v) => {
        noteDeveloper(v.developer);
        schedule();
      })
      .catch(() => undefined);
  window.addEventListener(VOICE_SETTINGS_CHANGED, refresh);
  window.addEventListener(DEVELOPER_CHANGED, schedule);
  refresh();
  schedule();
}
