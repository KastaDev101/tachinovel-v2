/**
 * Small additions to v1 screens without editing v1 (DOM hooks, re-applied when v1 re-renders):
 *  - More: a "Voices" row (Settings › Voices, voices-ui.ts) right after "Listen in the Car".
 *  - About: tap the version 5 times → the hidden Voice Lab (voice-lab.ts).
 *  - Open Source Licenses: v2's notices (Kokoro, FluidAudio, …) after v1's list.
 */
import { V2_NOTICES } from './third-party.ts';
import { openVoiceLab } from './voice-lab.ts';
import { openVoicesScreen } from './voices-ui.ts';

function addVoicesRow(): void {
  const more = document.querySelector('[data-testid="screen-more"]');
  if (!more || more.querySelector('[data-testid="more-voices"]')) return;
  const anchor = more.querySelector<HTMLElement>('[data-testid="more-narration"]');
  if (!anchor) return;
  const row = anchor.cloneNode(true) as HTMLElement;
  row.dataset.testid = 'more-voices';
  const title = row.querySelector('.mrow-title');
  if (title) title.textContent = 'Voices';
  row.querySelector('.mrow-value')?.remove();
  row.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openVoicesScreen();
  });
  anchor.after(row);
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
    }
  });
}

function addLicenses(): void {
  const screen = document.querySelector('[data-testid="screen-licenses"]');
  const grouped = screen?.querySelector('.grouped');
  if (!grouped || grouped.querySelector('[data-tn-notice]')) return;
  for (const n of V2_NOTICES) {
    const section = document.createElement('section');
    section.className = 'group';
    section.dataset.tnNotice = n.name;
    section.innerHTML = `<div class="group-body"><button type="button" class="row tap tap-row" aria-expanded="false"><span class="row-main"><span class="row-title"></span></span><span class="row-value"></span></button></div>`;
    (section.querySelector('.row-title') as HTMLElement).textContent = n.name;
    (section.querySelector('.row-value') as HTMLElement).textContent = n.license;
    const body = section.querySelector('.group-body') as HTMLElement;
    const btn = section.querySelector('button') as HTMLButtonElement;
    btn.addEventListener('click', () => {
      const open = body.querySelector('pre');
      if (open) {
        open.remove();
        btn.setAttribute('aria-expanded', 'false');
        return;
      }
      const pre = document.createElement('pre');
      pre.className = 'license-text selectable';
      pre.textContent = n.text;
      body.append(pre);
      btn.setAttribute('aria-expanded', 'true');
    });
    grouped.append(section);
  }
}

export function installV1Hooks(): void {
  let queued = false;
  const apply = (): void => {
    queued = false;
    try {
      addVoicesRow();
      hookAboutVersion();
      addLicenses();
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
  schedule();
}
