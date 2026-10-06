/**
 * Build-time patch (both flavors): v1's Diagnostics screen gets a "Diagnostics Folder" row for the phone
 * QA loop (src/ui/native/qa-folder.ts, DiagnosticsFolder.swift). It reads `globalThis.__TN_QA__`, set by
 * v2 before v1's UI loads; without it (a v1 build) nothing is shown. Must match exactly once (tools/v1.ts).
 */
import type { Patch } from './v1.ts';

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
  ];
}
