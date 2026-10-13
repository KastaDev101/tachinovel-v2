/**
 * Build-time patches (both flavors), reading globals v2 sets before v1's UI loads (without them, a v1 build, nothing
 * is shown). Each must match exactly once (tools/v1.ts):
 *  - v1's Diagnostics screen gets a "Diagnostics Folder" row for the phone QA loop (src/ui/native/qa-folder.ts,
 *    DiagnosticsFolder.swift): `globalThis.__TN_QA__`;
 *  - v1's Storage page gets a "Voices & models" row: Nephis's packs, voice models and leftovers to clean up
 *    (src/ui/native/storage-native.ts, ExpressiveCore StorageMap.swift): `globalThis.__TN_STORAGE__`.
 */
import type { Patch } from './v1.ts';

const STORAGE_ANCHOR = '<Section header="Limits" footer="Caches never grow past these limits; the oldest items are removed first.">';
const ANCHOR = '<Row title="Copy Full Diagnostics" tint onClick={copy} testId="diagnostics-copy" />';

export function qaPatches(): Patch[] {
  return [
    {
      file: 'ui/screens/diagnostics.tsx',
      find: new RegExp(ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      replace: `${ANCHOR}
          {globalThis.__TN_QA__ ? <Row title="Diagnostics Folder" value={globalThis.__TN_QA__.label.value} chevron onClick={() => globalThis.__TN_QA__?.open()} testId="diagnostics-folder" /> : null}`.replaceAll('$', '$$$$'),
      why: 'Diagnostics: the phone QA folder row',
    },
    {
      file: 'ui/screens/settings.tsx',
      find: new RegExp(STORAGE_ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      replace: `{globalThis.__TN_STORAGE__?.label.value ? (
              <Section>
                <Row title="Voices & models" subtitle="Nephis’s packs, voice models, leftovers to clean up" value={<span class="tabular">{globalThis.__TN_STORAGE__.label.value}</span>} chevron onClick={() => globalThis.__TN_STORAGE__?.open()} testId="storage-native" />
              </Section>
            ) : null}
            ${STORAGE_ANCHOR}`.replaceAll('$', '$$$$'),
      why: 'Storage: what the native app keeps (voice packs, models, leftovers)',
    },
  ];
}
