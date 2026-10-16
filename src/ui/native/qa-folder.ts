/**
 * Phone QA loop (opt-in, personal use): More › About › Diagnostics › "Diagnostics Folder" lets the user
 * pick a folder once (e.g. iCloud Drive › TachiNovel-Diagnostics; a security-scoped bookmark, no
 * iCloud entitlement needed). The native side (DiagnosticsFolder.swift) then mirrors the app log, MetricKit
 * crash/hang reports and this module's short UI event trail there at launch, every few minutes (every 10 minutes
 * while a voice works), when a voice stops and when the app goes to the background, so they sync to the PC. A folder that can't
 * be reached any more shows "Disconnected – tap to reconnect" on the row, and a toast once per launch. "Report a Problem" (the same row's menu, or shaking
 * the phone) writes a small bundle: a description, a screenshot, the log tail, versions and the route.
 *
 * The trail is tiny on purpose: screen names with novel titles, tab changes and JS errors, 60 entries.
 * No chapter text, no library list, no search terms.
 *
 * The Diagnostics row comes from a build-time patch of v1's screen (tools/v1-qa.ts) that reads
 * `globalThis.__TN_QA__` (set here, before v1's UI loads).
 */
import { effect, signal, type Signal } from '@preact/signals';
import { activeTab, stack } from '@v1/ui/state/nav.ts';
import { showToast } from '@v1/ui/state/toast.ts';
import { DiagFolder, folderLabel, type DiagFolderStatus } from './diag-folder.ts';
import { describeRoute, pushTrail } from './qa-trail.ts';

interface QaGlobal {
  /** Row value: the folder's name, or "Off". */
  label: Signal<string>;
  open(): void;
}

declare global {
  /** Read by v1's Diagnostics screen, patched at build time (tools/v1-qa.ts). */
  var __TN_QA__: QaGlobal | undefined;
}

export function installQaFolder(): void {
  const label = signal('Off');
  let warned = false;
  const apply = (s: DiagFolderStatus): void => {
    label.value = folderLabel(s);
    // Once per launch: a folder that stopped working says so instead of failing silently (Kasta 2026-10-13).
    if (s.linked && s.state === 'disconnected' && !warned) {
      warned = true;
      showToast('Diagnostics folder disconnected – reconnect it in More › About › Diagnostics', { tone: 'error', durationMs: 6000 });
    } else if (s.linked && s.upload && !warned) {
      // Copies are written, but iCloud doesn't take them: the PC sees nothing (2026-10-15).
      warned = true;
      showToast('Diagnostics aren’t reaching iCloud – see More › About › Diagnostics', { tone: 'error', durationMs: 6000 });
    }
  };
  const refresh = (): void => {
    void DiagFolder.status().then(apply).catch(() => undefined);
  };
  globalThis.__TN_QA__ = {
    label,
    open() {
      void DiagFolder.menu().then(apply).catch(() => undefined);
    },
  };
  refresh();
  // The native side copies 8 s after launch and on every return to the app: read how it went.
  setTimeout(refresh, 15_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(refresh, 3000);
  });

  // The trail: screens pushed and tabs chosen (deduplicated), and uncaught errors.
  let last = '';
  effect(() => {
    const top = stack.value[stack.value.length - 1]?.route;
    const tab = activeTab.value;
    const line = !top || top.name === 'tabs' ? `tab: ${tab}` : describeRoute(top);
    if (line === last) return;
    last = line;
    pushTrail({ e: line.startsWith('tab:') ? 'tab' : 'screen', d: line });
  });
  window.addEventListener('error', (ev) => pushTrail({ e: 'error', d: String(ev.message || ev.error) }));
  window.addEventListener('unhandledrejection', (ev) => pushTrail({ e: 'error', d: `unhandled: ${String((ev.reason as Error | undefined)?.message ?? ev.reason)}` }));
}
