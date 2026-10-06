/**
 * Portable polyfills (pure ECMAScript). The plugin host injects these into plugin scope; script-side
 * code may import them directly. None of them touch globals.
 */
export { URL, URLSearchParams, parseUrlencoded, serializeUrlencoded, resolveUrl, punycodeEncode } from './url.ts';
export { TextEncoder, TextDecoder, normalizeEncoding } from './text.ts';
export { atob, btoa, bytesToBase64, base64ToBytes, InvalidCharacterError } from './base64.ts';
export { FormData, encodeMultipart, makeBoundary } from './formdata.ts';
export { Headers, headersToRecord } from './headers.ts';
export { createTimers, type Timers } from './timers.ts';
export { createConsole, formatArgs, type ConsoleLike } from './console.ts';
export { utf8Encode, utf8Decode } from './utf8.ts';
