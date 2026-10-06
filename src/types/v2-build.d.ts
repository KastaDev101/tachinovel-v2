/** Injected by tools/build.ts (esbuild `define`), in addition to v1's __BUILD_* defines. */
/** 'personal': v1 parity (LNReader JS plugins, built-in Stonescape) for TestFlight-only use. 'store': App Store candidate. */
declare const __FLAVOR__: 'personal' | 'store';
/** Ads compiled in (store flavor only; off unless built with --ads). */
declare const __ADS__: boolean;
