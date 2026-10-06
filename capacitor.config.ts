/**
 * Capacitor configuration for TachiNovel v2.
 *
 * - The web layer is ONE inlined HTML file (www/index.html, built by tools/build.ts from the v1 UI).
 * - The script core is NOT a Capacitor web asset that runs in the WebView: www/core/*.js is loaded by
 *   the native CoreHost into its own JavaScriptCore context (see docs/architecture.md).
 * - CapacitorHttp stays disabled: the UI never fetches; the core does HTTP natively (URLSession).
 * - appId is a placeholder: replace it with your own reverse-DNS id before registering it with Apple.
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kasta.tachinovel',
  appName: 'TachiNovel',
  webDir: 'www',
  loggingBehavior: 'debug',
  ios: {
    // The UI handles safe areas itself with env(safe-area-inset-*) (viewport-fit=cover).
    contentInset: 'never',
    // Each screen has its own scroll container; the WKWebView itself must not rubber-band.
    scrollEnabled: false,
    backgroundColor: '#1b1b1f',
    preferredContentMode: 'mobile',
    limitsNavigationsToAppBoundDomains: false,
    // webContentsDebuggingEnabled is left unset on purpose: Capacitor then makes the WKWebView inspectable
    // (Safari Web Inspector) in Debug builds only. `true` here would also expose Release/App Store builds.
  },
  plugins: {
    CapacitorHttp: { enabled: false },
    CapacitorCookies: { enabled: false },
    SplashScreen: { launchAutoHide: false, backgroundColor: '#1b1b1f', showSpinner: false },
    Keyboard: { resize: 'native', resizeOnFullScreen: true },
  },
};

export default config;
