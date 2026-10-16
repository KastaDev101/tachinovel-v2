/**
 * v2 UI entry. Order matters:
 *  1. prelude: native shims (wake lock, splash, status bar) before the v1 UI starts;
 *  2. the v1 UI, unchanged (its phone bridge is swapped for capacitor-client.ts at build time);
 *  3. v2 additions that observe the v1 UI without modifying it: car answers in Help, narration overlay, Pronounce,
 *     Voices/Developer/Prepare-for-the-drive hooks (crash-report sharing on the Diagnostics screen among them), the app
 *     icon's quick action, the phone QA folder (qa-folder.ts), ads (store + --ads).
 */
import './native/prelude.ts';
import './native/v2-text.ts'; // v2 wording globals: before v1's modules evaluate
import { installQaFolder } from './native/qa-folder.ts';
import '@v1/ui/main.ts';
import { HELP } from '@v1/ui/lib/help-data.ts';
import { installAds } from './monetization/ads.ts';
import { installVoiceImports } from './native/expressive-lab.ts';
import { installCarHelp } from './native/help-car.ts';
import { installLaunchActions } from './native/launch-actions.ts';
import { Narration } from './native/narration.ts';
import { installNarrationOverlay } from './native/narration-overlay.ts';
import { installOtaUi } from './native/ota-ui.ts';
import { installPronounce } from './native/pronounce-ui.ts';
import { installRecovery } from './native/recovery.ts';
import { installNativeStorage } from './native/storage-native.ts';
import { runSmokeTour } from './native/smoke.ts';
import { ensureNephis } from './native/voices-ui.ts';
import { installV1Hooks } from './native/v1-hooks.ts';

installCarHelp(HELP);
installNarrationOverlay();
installPronounce(); // "Pronounce" on a selected name in the reader
installV1Hooks();
// Nephis is the app's one voice: a phone that had another voice chosen switches to her once.
void ensureNephis();
installLaunchActions(); // "Voice Speed Test" from the app icon's long-press menu
void installRecovery();
installQaFolder();
installNativeStorage();
runSmokeTour();
// Web updates and imported voices ("Open in TachiNovel" for .tnvoice files): personal flavor only (compiled out
// of the store flavor).
if (__FLAVOR__ === 'personal') {
  installOtaUi();
  installVoiceImports();
}

if (__ADS__) {
  let narrating = false;
  void Narration.addListener('state', (s) => (narrating = s.status === 'playing' || s.status === 'paused'));
  void installAds({ isNarrating: () => narrating }).catch((err: unknown) => console.warn('ads disabled', err));
}
