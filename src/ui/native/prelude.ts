/**
 * Runs before the v1 UI boots (imported first by src/ui/main.ts). Native-shell adjustments that need
 * no v1 change:
 *  - navigator.wakeLock → native idle-timer control (WKWebView's own Wake Lock support is unreliable;
 *    v1's reader already calls navigator.wakeLock.request('screen') for "keep screen awake").
 *  - Splash screen: hidden once the UI has painted its first real frame after app.boot.
 *  - Status bar: follows the system appearance (the v1 UI follows it too).
 *  - Deep links: tachinovel://open?plugin=…&novel=…[&chapter=…] are handled natively (CorePlugin
 *    forwards them as `app.deepLink` core events), so nothing to do here.
 */
import { registerPlugin } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { observeCalls } from '../capacitor-client.ts';

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
  let hidden = false;
  const hide = (): void => {
    if (hidden) return;
    hidden = true;
    void SplashScreen.hide({ fadeOutDuration: 150 }).catch(() => undefined);
  };
  const stop = observeCalls((method) => {
    if (method !== 'app.boot') return;
    stop();
    // Two frames after the boot call: the library has rendered from the boot payload by then.
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(hide, 120)));
  });
  setTimeout(hide, 3000); // never leave the splash up
}

function followSystemStatusBar(): void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = (): void => {
    void StatusBar.setStyle({ style: mq.matches ? Style.Dark : Style.Light }).catch(() => undefined);
  };
  apply();
  mq.addEventListener('change', apply);
}

installWakeLock();
hideSplashAfterBoot();
followSystemStatusBar();
