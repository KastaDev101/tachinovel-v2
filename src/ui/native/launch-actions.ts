/**
 * The app icon's long-press menu (Home Screen quick action, DeveloperOptions.swift / LaunchActions): "Voice Speed Test"
 * opens the Voice Speed Test, once the library shows on a cold start. Offered while Developer options are on.
 */
import { whenLibraryVisible } from './boot-timing.ts';
import { TachiNative } from './prelude.ts';
import { openVoiceSpeedTest } from './voice-speed.ts';

export function installLaunchActions(): void {
  void TachiNative.addListener('launchAction', (e) => {
    if (e.action !== 'voiceSpeedTest') return;
    // A cold start waits for the library to paint; a running app (any tab) opens it at once.
    const ready = performance.now() > 5000 ? Promise.resolve(null) : whenLibraryVisible(20_000);
    void ready.then(() => {
      // Already open (a second tap on the quick action): leave it.
      if (!document.querySelector('[data-testid="voice-speed"]:not([inert])')) openVoiceSpeedTest();
    });
  }).catch(() => undefined);
}
