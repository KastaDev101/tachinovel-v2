/**
 * v2 UI entry. Order matters:
 *  1. prelude: native shims (wake lock, splash, status bar) before the v1 UI starts;
 *  2. the v1 UI, unchanged (its phone bridge is swapped for capacitor-client.ts at build time);
 *  3. v2 additions that observe the v1 UI without modifying it: car answers in Help, narration overlay,
 *     Voices/Voice Lab/Prepare-for-the-drive hooks,
 *     crash-report sharing on the Diagnostics screen, ads (store + --ads).
 */
import './native/prelude.ts';
import '@v1/ui/main.ts';
import { HELP } from '@v1/ui/lib/help-data.ts';
import { installAds } from './monetization/ads.ts';
import { installDiagnosticsOverlay } from './native/diagnostics-overlay.ts';
import { installCarHelp } from './native/help-car.ts';
import { Narration } from './native/narration.ts';
import { installNarrationOverlay } from './native/narration-overlay.ts';
import { installRecovery } from './native/recovery.ts';
import { runSmokeTour } from './native/smoke.ts';
import { installV1Hooks } from './native/v1-hooks.ts';

installCarHelp(HELP);
installNarrationOverlay();
installV1Hooks();
installDiagnosticsOverlay();
void installRecovery();
runSmokeTour();

if (__ADS__) {
  let narrating = false;
  void Narration.addListener('state', (s) => (narrating = s.status === 'playing' || s.status === 'paused'));
  void installAds({ isNarrating: () => narrating }).catch((err: unknown) => console.warn('ads disabled', err));
}
