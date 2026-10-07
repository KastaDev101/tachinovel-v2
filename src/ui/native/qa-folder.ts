/**
 * Phone QA loop (opt-in, personal use): More › About › Diagnostics › "Diagnostics Folder" lets the user
 * pick a folder once (e.g. iCloud Drive › TachiNovel-Builds › diagnostics; a security-scoped bookmark, no
 * iCloud entitlement needed). The native side (DiagnosticsFolder.swift) then mirrors the app log, MetricKit
 * crash/hang reports and this module's short UI event trail there every few minutes and when the app
 * goes to the background, so they sync to the PC. "Report a Problem" (the same row's menu, or shaking
 * the phone) writes a small bundle: a description, a screenshot, the log tail, versions and the route.
 *
 * The trail is tiny on purpose: screen names with novel titles, tab changes and JS errors, 60 entries.
 * No chapter text, no library list, no search terms.
 *
 * The Diagnostics row comes from a build-time patch of v1's screen (tools/v1-qa.ts) that reads
 * `globalThis.__TN_QA__` (set here, before v1's UI loads).
 */
import { registerPlugin } from '@capacitor/core';
import { effect, signal, type Signal } from '@preact/signals';
import { activeTab, stack } from '@v1/ui/state/nav.ts';
import { describeRoute, pushTrail } from './qa-trail.ts';

export interface DiagFolderStatus {
  linked: boolean;
  name?: string | null;
  /** Epoch ms of the last mirror, or null. */
  lastMirror?: number | null;
}

interface DiagFolderPlugin {
  status(): Promise<DiagFolderStatus>;
  /** Native action sheet: choose/change the folder, mirror now, report a problem, stop. */
  menu(): Promise<DiagFolderStatus>;
}

export const DiagFolder = registerPlugin<DiagFolderPlugin>('DiagFolder');

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
  const apply = (s: DiagFolderStatus): void => {
    label.value = s.linked ? (s.name ?? 'On') : 'Off';
  };
  globalThis.__TN_QA__ = {
    label,
    open() {
      void DiagFolder.menu().then(apply).catch(() => undefined);
    },
  };
  void DiagFolder.status().then(apply).catch(() => undefined);

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
