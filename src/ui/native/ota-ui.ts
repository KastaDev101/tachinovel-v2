/**
 * More › About › "App Update" (personal flavor; the row comes from tools/v1-ota.ts): shows which web
 * bundle runs (the app's own, or a web update) and checks for a newer one (core `ota.check`, which
 * downloads and verifies it; it applies at the next launch).
 */
import { signal } from '@preact/signals';
import { sharedClient } from '../capacitor-client.ts';

interface OtaStatus {
  configured: boolean;
  running: { source: 'embedded' | 'ota'; id: string | null; version: string; builtAt: string };
  active: { id: string; version: string; builtAt: string } | null;
  lastError: string | null;
}

interface CheckResult {
  status: 'up-to-date' | 'staged' | 'not-configured' | 'error';
  message: string;
}

interface OtaGlobal {
  label: ReturnType<typeof signal<string>>;
  check(): void;
}

declare global {
  /** Read by v1's About screen, patched at build time (tools/v1-ota.ts). */
  var __TN_OTA__: OtaGlobal | undefined;
}

/** v2 core methods aren't in v1's typed bridge. */
type Call = (method: string, args?: unknown) => Promise<unknown>;

export function labelFor(s: OtaStatus | null): string {
  if (!s) return '';
  const running = `${s.running.version}${s.running.source === 'ota' ? ' (web update)' : ''}`;
  const staged = s.active && s.active.id !== s.running.id && Date.parse(s.active.builtAt) > Date.parse(s.running.builtAt);
  return staged ? `${running} · ${s.active?.version ?? ''} on next launch` : running;
}

export function installOtaUi(): void {
  const client = sharedClient() as unknown as { call: Call };
  const label = signal('');
  const refresh = (): void => {
    void client
      .call('ota.status')
      .then((s) => {
        label.value = labelFor(s as OtaStatus | null);
      })
      .catch(() => undefined);
  };
  let busy = false;
  globalThis.__TN_OTA__ = {
    label,
    check() {
      if (busy) return;
      busy = true;
      label.value = 'Checking…';
      void client
        .call('ota.check', { force: true })
        .then((r) => {
          const res = r as CheckResult;
          const title = res.status === 'staged' ? 'Update Ready' : res.status === 'error' ? 'Couldn’t Check' : 'App Update';
          return client.call('native.alert', { title, message: res.message, actions: [{ title: 'OK' }] });
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
          refresh();
        });
    },
  };
  refresh();
}
