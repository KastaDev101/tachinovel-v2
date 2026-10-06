/**
 * Build-time patch, personal flavor only: More › About gets an "App Update" row (web updates,
 * src/ui/native/ota-ui.ts → core ota.status / ota.check). It reads `globalThis.__TN_OTA__`; the store
 * flavor gets neither this patch nor the update code. Must match exactly once (tools/v1.ts).
 */
import type { Patch } from './v1.ts';

const ANCHOR = `<Row title="Diagnostics" chevron onClick={() => push({ name: 'diagnostics' })} testId="about-diagnostics" />`;

export function otaPatches(): Patch[] {
  const row =
    '{globalThis.__TN_OTA__ ? <Row title="App Update" value={globalThis.__TN_OTA__.label.value} chevron onClick={() => globalThis.__TN_OTA__?.check()} testId="about-ota" /> : null}';
  return [
    {
      file: 'ui/screens/settings.tsx',
      find: new RegExp(ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      replace: `${ANCHOR}\n          ${row}`.replaceAll('$', '$$$$'),
      why: 'About: the App Update row (web updates)',
    },
  ];
}
