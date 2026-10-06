// Lazy bundle (www/core/lib/declarative-host.js): loaded on first source use, like v1's plugin-host.
// Must stay the first import: installs `atob` where missing, before cheerio's modules initialize.
import '@v1/plugin-host/polyfills/ensure-atob.ts';

export { createDeclarativeHost } from '../declarative/engine.ts';
export { parseSpec, looksLikeSpec, SPEC_FORMAT } from '../declarative/spec.ts';
