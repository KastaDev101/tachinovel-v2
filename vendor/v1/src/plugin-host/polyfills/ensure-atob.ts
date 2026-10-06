/**
 * The only globals the plugin host ever installs: `atob`/`btoa`, and only where they are missing
 * or BROKEN.
 *
 * Why: cheerio 1.2 ships its own nested htmlparser2@10 → entities@7, whose module initialization
 * decodes the HTML entity tables with the global `atob` (falling back to Node's `Buffer`). Without
 * a working one, merely loading the host bundle throws. This module must be evaluated before
 * cheerio, so src/plugin-host/index.ts and modules.ts import it first.
 *
 * CP1 (phone, 2026-10-06): Scriptable DOES define `atob`, but it decodes to a UTF-8 string and
 * returns null for binary data (e.g. atob("gP8=")), so entities crashed with
 * "null is not an object (evaluating 'e.length')". A binary round-trip check catches that.
 */
import { atob, btoa } from './base64.ts';

const g = globalThis as { atob?: unknown; btoa?: unknown };

function atobWorks(): boolean {
  try {
    return typeof g.atob === 'function' && (g.atob as (s: string) => unknown)('gP8=') === '\x80\xff';
  } catch {
    return false;
  }
}

function btoaWorks(): boolean {
  try {
    return typeof g.btoa === 'function' && (g.btoa as (s: string) => unknown)('\x80\xff') === 'gP8=';
  } catch {
    return false;
  }
}

if (!atobWorks()) g.atob = atob;
if (!btoaWorks()) g.btoa = btoa;
