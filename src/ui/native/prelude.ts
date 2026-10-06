/**
 * Runs before the v1 UI boots (imported first by src/ui/main.ts). Native-shell adjustments that need
 * no v1 change:
 *  - navigator.wakeLock → native idle-timer control (WKWebView's own Wake Lock support is unreliable;
 *    v1's reader already calls navigator.wakeLock.request('screen') for "keep screen awake").
 *  - Launch screen: hidden as soon as the library has painted its boot content (boot-timing.ts, which
 *    also logs the boot timing), at the latest after 3 s.
 *  - Status bar: light or dark text from what is painted under it (status-bar.ts): the app appearance
 *    (system or forced in Settings), the reader theme, dark overlays.
 *  - Deep links: tachinovel://open?plugin=…&novel=…[&chapter=…] are handled natively (CorePlugin
 *    forwards them as `app.deepLink` core events), so nothing to do here.
 */
import { registerPlugin } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';
import { installBootTiming } from './boot-timing.ts';
import { installStatusBar } from './status-bar.ts';

interface TachiNativePlugin {
  setKeepAwake(opts: { on: boolean }): Promise<void>;
}

export const TachiNative = registerPlugin<TachiNativePlugin>('TachiNative');

type ReleaseListener = () => void;

/** Minimal WakeLockSentinel backed by UIApplication.isIdleTimerDisabled. */
class NativeWakeLockSentinel extends EventTarget {
  released = false;
  readonly type = 'screen' as const;
  onrelease: ReleaseListener | null = null;

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    active.delete(this);
    if (active.size === 0) await TachiNative.setKeepAwake({ on: false }).catch(() => undefined);
    this.dispatchEvent(new Event('release'));
    this.onrelease?.();
  }
}

const active = new Set<NativeWakeLockSentinel>();

function installWakeLock(): void {
  const wakeLock = {
    async request(type: 'screen' = 'screen'): Promise<NativeWakeLockSentinel> {
      if (type !== 'screen') throw new DOMException('Only screen wake locks are supported', 'NotSupportedError');
      const s = new NativeWakeLockSentinel();
      active.add(s);
      await TachiNative.setKeepAwake({ on: true });
      return s;
    },
  };
  try {
    Object.defineProperty(navigator, 'wakeLock', { value: wakeLock, configurable: true });
  } catch {
    // read-only in this WebKit: keep the built-in implementation
  }
  // Like the web API: locks are released when the page is hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') for (const s of [...active]) void s.release();
  });
}

function hideSplashAfterBoot(): void {
  // Previously: two frames + 120 ms after the app.boot CALL, which could reveal an empty library when the
  // boot reply was slow, and waited needlessly when it was fast. Now: the first frame with library content.
  installBootTiming(() => void SplashScreen.hide({ fadeOutDuration: 150 }).catch(() => undefined));
}


installWakeLock();
hideSplashAfterBoot();
installStatusBar();
