/**
 * The native↔JS contract level this web bundle was built for (native-api.ts, the Capacitor plugins the UI
 * calls, the OTA file layout). Bump it in the same pull request as an incompatible change on either side,
 * together with WebBundle.nativeLevel in ios/App/App/Native/Core/WebBundle.swift (a test checks they match):
 * a web update built for another level is never applied (src/core/ota/ota.ts, WebBundle.swift).
 */
export const NATIVE_LEVEL = 1;
