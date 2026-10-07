/**
 * Simulator smoke tour (CI). Debug builds only: MainViewController injects `window.__TACHI_SMOKE__`
 * when the app is launched with smoke arguments (ci/ios-sim-smoke.sh), and this drives the v1 UI so
 * `simctl io screenshot` captures each screen. Release builds never inject the global, so this is inert
 * there.
 *
 *  - `-tachiSmokeTab <tab>` / `-tachiSmokeSource <id>`: open a tab (and a source).
 *  - `-tachiSmokeTour native`: tap through the native-only surfaces (docs/qa.md): the document picker
 *    (Restore from Files…, Link audio folder), the share sheet, Listen (system voice), the mini player
 *    and the car player controls, the reader's brightness and keep-awake settings. The native side
 *    (SmokeResponder.swift, Debug) cancels system sheets after a few seconds like a user tapping Cancel.
 *    Every step logs "smoke: …" through the core (os_log subsystem app.tachinovel), ending with
 *    "smoke: tour done"; steps that can't run (no network for a source) are logged as skipped.
 */
import { runVoiceSelfTest } from './voice-selftest.ts';
import { sharedClient } from '../capacitor-client.ts';

interface SmokeConfig {
  tab?: string;
  source?: string;
  /** "1": run the voice self-test (voice-selftest.ts) after the tour. */
  voiceSelfTest?: string;
  tour?: string;
}

declare global {
  interface Window {
    __TACHI_SMOKE__?: SmokeConfig;
  }
}

function waitFor(selector: string, timeoutMs: number): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = (): void => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el && el.getClientRects().length > 0) return resolve(el);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function log(message: string): void {
  // warn: `log show` lists it without --info; it also lands in the in-app Diagnostics log.
  void sharedClient()
    .call('app.log', { level: 'warn', message: `smoke: ${message}` })
    .catch(() => undefined);
}

/** Tap the first visible element matching `selector`; logs and returns false when it never appears. */
async function tap(selector: string, what: string, timeoutMs = 6000): Promise<boolean> {
  const el = await waitFor(selector, timeoutMs);
  if (!el) {
    log(`skipped ${what} (not found: ${selector})`);
    return false;
  }
  el.click();
  log(what);
  await sleep(700);
  return true;
}

/** The top navigation layer's Back button (pushed screens and the reader). */
async function back(): Promise<void> {
  await tap('.nav-root > .layer:last-child :is([data-testid="nav-back"], [data-testid="reader-back"])', 'back', 3000);
}

async function closeSheets(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const close = document.querySelector<HTMLElement>('.sheet-wrap:not(.is-closing) [data-testid="sheet-close"]');
    if (!close) return;
    close.click();
    await sleep(600);
  }
}

/** The native SmokeResponder cancels a system sheet ~2 s after it is on screen (slow runners take a few
 *  seconds to show it); this covers that plus the dismissal. */
const NATIVE_SHEET_MS = 7000;

/** Wait until `selector` is visible again (the UI is back after a native sheet), up to `timeoutMs`. */
async function backTo(selector: string, what: string, timeoutMs: number): Promise<boolean> {
  if (await waitFor(selector, timeoutMs)) return true;
  log(`skipped waiting for ${what} (not back after ${timeoutMs} ms)`);
  return false;
}

async function nativeTour(): Promise<void> {
  log('tour start');
  await closeSheets(); // What's New

  // 1. Document picker, twice: More › Backup & Restore › Restore from Files…. SmokeResponder swipes the
  //    first one away (UIKit calls no delegate method then) and cancels the second; both times the request
  //    must be answered (the row comes back), and later popups must still appear (the share sheet below).
  await tap('[data-testid="tab-more"]', 'tab more');
  if (await tap('[data-testid="more-backup"]', 'open Backup & Restore')) {
    for (const how of ['swiped away', 'cancelled']) {
      if (await tap('button[data-testid="backup-restore-files"]', `Restore from Files… (document picker, ${how})`, 20_000)) {
        await sleep(1500);
        // Until the picker answered, the row reads "Reading Backup…" (not a button). ci/ios-sim-smoke.sh
        // checks the first answer comes after SmokeResponder swiped the picker away, not while it was up.
        if (await backTo('button[data-testid="backup-restore-files"]', 'Restore from Files…', 20_000)) log('Restore from Files… answered');
        await sleep(800);
      }
    }
    await back();
  }

  // 2. The Listen player: More › Listen (Kokoro builds), or Listen in the Car › Open the player when PC
  //    audio is on; with PC audio, its Link folder button opens the folder picker too (cancelled).
  const listenRow = await waitFor('[data-testid="more-listen"]', 3000);
  if (listenRow) {
    await tap('[data-testid="more-listen"]', 'open the Listen player');
  } else if (await tap('[data-testid="more-narration"]', 'open Listen in the Car')) {
    await tap('[data-testid="open-car-player"]', 'Open the player');
  }
  if (await waitFor('.tn-car.is-open', 5000)) {
    const pick = await waitFor('.tn-car [data-act="pick"]', 2000);
    if (pick && (await tap('.tn-car [data-act="pick"]', 'Link audio folder (document picker)'))) await sleep(NATIVE_SHEET_MS);
    await tap('.tn-car [data-act="close"]', 'close the car player');
  }
  if (!listenRow) await back();

  // 3. A novel from the built-in source (network): share sheet, then the reader.
  await tap('[data-testid="tab-browse"]', 'tab browse');
  const source = await waitFor('.src-row[data-source]', 5000);
  const id = source?.dataset.source;
  if (id && (await tap(`[data-testid="source-${id}"]`, `open source ${id}`))) {
    if (await tap('[data-testid="browse-grid"] .grid-hit', 'open the first novel', 20_000)) {
      await waitFor('.nav-root > .layer:last-child [data-testid="novel-title"]', 15_000);
      if (await tap('.nav-root > .layer:last-child [data-testid="share"]', 'Share (share sheet)')) await sleep(NATIVE_SHEET_MS);
      if (await tap('.nav-root > .layer:last-child [data-testid="resume"]', 'start reading', 10_000)) {
        await waitFor('[data-testid="reader-chapter"][data-status="ready"]', 20_000);
        await sleep(1000);
        await reader();
        await back();
      }
      await back();
    }
    await back();
  } else {
    log('skipped the novel and reader steps (no source)');
  }
  log('tour done');
  document.documentElement.dataset.smoke = 'done';
}

/** Reader: brightness + keep awake (native), Listen, mini player, car player transport. */
async function reader(): Promise<void> {
  if (await tap('[data-testid="reader-settings-btn"]', 'reader settings')) {
    const range = document.querySelector<HTMLInputElement>('.rs-brightness input[type="range"]');
    if (range) {
      range.value = '0.4';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
      log('brightness 40% (native.setBrightness)');
    } else log('skipped brightness (no slider)');
    const awake = [...document.querySelectorAll<HTMLElement>('.reader-settings .row-switch')].find((r) => /keep screen awake/i.test(r.textContent ?? ''));
    if (awake) {
      awake.click();
      log('keep screen awake toggled (TachiNative.setKeepAwake)');
    } else log('skipped keep awake (no switch)');
    await sleep(500);
    await closeSheets();
  }
  if (!(await tap('[data-testid="listen-button"]', 'Listen (system voice)', 8000))) return;
  await sleep(3000);
  await tap('[data-testid="mini-player"] .tn-toggle', 'mini player pause');
  await tap('[data-testid="mini-player"] .tn-toggle', 'mini player resume');
  if (await tap('[data-testid="mini-player"] .tn-title', 'open the car player from the mini player')) {
    await tap('.tn-car [data-act="fwd"]', 'car player forward');
    await tap('.tn-car [data-act="back"]', 'car player back');
    await tap('.tn-car [data-act="speed"][data-v="1.25"]', 'car player speed 1.25x');
    await tap('.tn-car [data-act="toggle"]', 'car player pause');
    await tap('.tn-car [data-act="toggle"]', 'car player play');
    await tap('.tn-car [data-act="next"]', 'car player next chapter');
    await sleep(2000);
    await tap('.tn-car [data-act="close"]', 'close the car player');
  }
  await tap('[data-testid="mini-player"] .tn-stop', 'mini player stop');
}

export function runSmokeTour(): void {
  const cfg = window.__TACHI_SMOKE__;
  if (!cfg) return;
  void (async () => {
    // The voice self-test runs right after a fresh simulator boot, when the first WebView load is slow.
    if (!(await waitFor('[data-testid="screen-library"]', cfg.voiceSelfTest === '1' ? 120_000 : 20_000))) return;
    // First run shows v1's onboarding over the library: skip it like a user would.
    (await waitFor('[data-testid="onboarding-skip"]', 2500))?.click();
    await sleep(400);
    if (cfg.tour === 'native') return nativeTour().catch((err: unknown) => log(`tour failed: ${String(err)}`));
    if (cfg.tab) (await waitFor(`[data-testid="tab-${cfg.tab}"]`, 5000))?.click();
    if (cfg.source) (await waitFor(`[data-testid="source-${cfg.source}"]`, 8000))?.click();
    document.documentElement.dataset.smoke = 'done';
    if (cfg.voiceSelfTest === '1') await runVoiceSelfTest();
  })();
}
