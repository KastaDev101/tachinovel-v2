/**
 * Small additions to v1 screens without editing v1 (DOM hooks, re-applied when v1 re-renders):
 *  - More: a "Voices" row (Settings › Voices, voices-ui.ts). v1's "Listen in the Car" screen is about the
 *    PC narrator, which is sidelined: unless Settings › Voices › Advanced › "Use PC audio when available"
 *    is on, that row is hidden and a "Listen" row opens the Listen player instead.
 *  - About: tap the version to copy it (for bug reports); 5 taps → the hidden Voice Lab (voice-lab.ts).
 *  - Novel page: "Prepare for the drive" (drive-ui.ts) in place of v1's PC-narrator card (kept with PC audio on).
 * (Open Source Licenses comes from THIRD_PARTY_NOTICES.md at build time: tools/third-party.ts.)
 */
import { addDriveCard, installDrive } from './drive-ui.ts';
import { Narration } from './narration.ts';
import { openListenPlayer } from './narration-overlay.ts';
import { openVoiceLab } from './voice-lab.ts';
import { openVoicesScreen, toast, VOICE_SETTINGS_CHANGED } from './voices-ui.ts';

/** Settings › Voices › Advanced › "Use PC audio when available" (off by default). */
let pcAudio = false;

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
  // v1's PC-narrator screen only when PC audio is on; otherwise our Listen row stands in for it.
  anchor.style.display = pcAudio ? '' : 'none';
  let listen = more.querySelector<HTMLElement>('[data-testid="more-listen"]');
  if (!pcAudio && !listen) {
    listen = cloneRow(anchor, 'more-listen', 'Listen', openListenPlayer);
    anchor.after(listen);
  }
  if (listen) listen.style.display = pcAudio ? 'none' : '';
  if (!more.querySelector('[data-testid="more-voices"]')) {
    (listen ?? anchor).after(cloneRow(anchor, 'more-voices', 'Voices', openVoicesScreen));
  }
}

function hookAboutVersion(): void {
  const version = document.querySelector<HTMLElement>('[data-testid="screen-about"] .about-version');
  if (!version || version.dataset.tnLab) return;
  version.dataset.tnLab = '1';
  let taps: number[] = [];
  version.addEventListener('click', () => {
    const now = Date.now();
    taps = [...taps.filter((t) => now - t < 3000), now];
    if (taps.length >= 5) {
      taps = [];
      openVoiceLab();
      return;
    }
    // The first tap copies the version (for bug reports); the next ones just count toward the Voice Lab.
    if (taps.length === 1) void copyVersion(version.textContent.trim());
  });
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
  let queued = false;
  const apply = (): void => {
    queued = false;
    try {
      addMoreRows();
      hookAboutVersion();
      addDriveCard(pcAudio);
    } catch (err) {
      console.warn('v1 hooks', err);
    }
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(apply);
  };
  installDrive();
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  const refresh = (): void =>
    void Narration.voiceSettings()
      .then((v) => {
        pcAudio = v.usePCAudio === true;
        schedule();
      })
      .catch(() => undefined);
  window.addEventListener(VOICE_SETTINGS_CHANGED, refresh);
  refresh();
  schedule();
}
