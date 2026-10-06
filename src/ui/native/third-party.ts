/**
 * Open-source notices for everything v2 ships (Capacitor, the core's parsers, Kokoro, FluidAudio, …), read
 * from THIRD_PARTY_NOTICES.md at the repo root (bundled as text at build time). v1-hooks.ts appends them to
 * v1's Settings › About › Open Source Licenses, skipping the ones v1 already lists.
 *
 * Format (documented in the file): `## <Name>`, a `- License: <SPDX>` line, then the notice in a ```text
 * block. Notices that say "full text in "Apache License 2.0" below" get that section's text appended.
 */
import NOTICES_MD from '../../../THIRD_PARTY_NOTICES.md';
import { parseNotices, type Notice } from './notices.ts';

export type { Notice };

let cached: Notice[] | null = null;

export function v2Notices(): Notice[] {
  cached ??= parseNotices(NOTICES_MD);
  return cached;
}
