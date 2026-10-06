/**
 * Diagnostics (More › About › Diagnostics): versions, device, storage, installed sources, the latest
 * warnings and errors from the script's log (app.logs), and a settings summary, plus "Copy
 * Diagnostics", which hands the plain-text report to the native share sheet.
 */
import { useEffect } from 'preact/hooks';
import { bridge, errorText, toUiError, type UiError } from '../bridge/client.ts';
import { Button, Row, Section } from '../components/controls.tsx';
import { SkeletonRows } from '../components/feedback.tsx';
import { useAsync } from '../components/hooks.ts';
import { Screen } from '../components/screen.tsx';
import { diagnosticsText, problemReport, RECENT_PROBLEMS, sourceLine, STORAGE_LABELS, storageTotal } from '../lib/diagnostics.ts';
import { formatBytes, plural, relativeTime } from '../lib/format.ts';
import { Icon } from '../components/icon.tsx';
import { useNow } from '../components/hooks.ts';
import { buildVersion, categories, library, reloadSources, settings, sources } from '../state/store.ts';
import { errorToast, showToast } from '../state/toast.ts';
import type { StorageCategory } from '../../shared/contracts/domain.ts';
import '../styles/extras.css';

/** A part that couldn't be read, with why and a Retry (pull to refresh retries everything). */
function RetryRow(props: { title: string; error: UiError | null | undefined; onRetry: () => void; testId: string }) {
  return (
    <Row
      title={props.title}
      subtitle={props.error ? errorText(props.error) : undefined}
      trailing={
        <Button variant="tinted" size="small" onClick={props.onRetry} label={`Retry: ${props.title}`}>
          Retry
        </Button>
      }
      testId={props.testId}
    />
  );
}

export function DiagnosticsScreen() {
  const device = useAsync(() => bridge().call('native.device'), []);
  const storage = useAsync(() => bridge().call('storage.usage'), []);
  const logs = useAsync(() => bridge().call('app.logs', { level: 'warn', limit: RECENT_PROBLEMS }), []);
  const now = useNow();
  useEffect(() => {
    void reloadSources();
  }, []);
  const list = [...sources.value].sort((a, b) => a.name.localeCompare(b.name));

  function report(): string {
    return diagnosticsText({
      now: Date.now(),
      build: buildVersion.value,
      ui: { version: __BUILD_VERSION__, hash: __BUILD_HASH__, time: __BUILD_TIME__ },
      device: device.data ?? null,
      storage: storage.data ?? null,
      sources: sources.value,
      library: { novels: library.value.length, categories: categories.value.length },
      settings: settings.value,
      logs: logs.data ?? null,
    });
  }

  function copy(): void {
    bridge()
      .call('native.share', { text: report() })
      .then(() => showToast('Diagnostics ready to paste'))
      .catch((err: unknown) => errorToast(errorText(toUiError(err))));
  }

  function sendReport(): void {
    const text = problemReport({
      now: Date.now(),
      build: buildVersion.value,
      ui: { version: __BUILD_VERSION__, hash: __BUILD_HASH__, time: __BUILD_TIME__ },
      device: device.data ?? null,
      logs: logs.data ?? null,
    });
    bridge()
      .call('native.share', { text }, { timeoutMs: 600_000 })
      .catch((err: unknown) => errorToast(errorText(toUiError(err))));
  }

  return (
    <Screen class="is-grouped" title="Diagnostics" back="About" testId="screen-diagnostics" onRefresh={() => Promise.all([device.reload({ silent: true }), storage.reload({ silent: true }), logs.reload({ silent: true }), reloadSources()]).then(() => undefined)}>
      <div class="grouped">
        <Section footer="A problem report is short: your app and iOS versions, the latest problems, and a line for you to say what happened. Full diagnostics add storage, sources and settings. Your library list, searches and reading history aren’t in either; a recent problem can mention a source or a novel.">
          <Row title="Send a Problem Report" tint onClick={sendReport} testId="diagnostics-send" />
          <Row title="Copy Full Diagnostics" tint onClick={copy} testId="diagnostics-copy" />
        </Section>

        <Section header="Recent Problems" footer={`The last ${RECENT_PROBLEMS} warnings and errors the app logged.`}>
          {logs.status === 'loading' && !logs.data ? (
            <SkeletonRows count={2} height={56} />
          ) : !logs.data ? (
            <RetryRow title="Couldn’t read the log" error={logs.error} onRetry={() => void logs.reload()} testId="diagnostics-log-error" />
          ) : logs.data.length === 0 ? (
            <Row title="No problems logged" leading={<Icon name="checkmark.circle.fill" size={22} class="diag-ok" />} disabled testId="diagnostics-no-problems" />
          ) : (
            logs.data.map((l, i) => (
              <div class={`row diag-log is-${l.level === 'error' ? 'error' : 'warn'}`} key={`${l.at}-${i}`} data-testid="diagnostics-problem">
                <Icon name="exclamationmark.triangle" size={18} class="diag-log-icon" />
                <span class="row-main">
                  <span class="diag-log-text selectable">{l.message}</span>
                  <span class="row-subtitle">
                    {l.level === 'error' ? 'Error' : 'Warning'} · {relativeTime(l.at, now)}
                  </span>
                </span>
              </div>
            ))
          )}
        </Section>

        <Section header="App">
          <Row title="Version" value={<span class="tabular selectable">{buildVersion.value || __BUILD_VERSION__}</span>} />
          <Row title="UI build" value={<span class="tabular">{__BUILD_HASH__}</span>} />
          <Row title="Library" value={plural(library.value.length, 'novel')} />
          <Row title="Categories" value={String(categories.value.length)} />
        </Section>

        <Section header="Device">
          {device.status === 'loading' && !device.data ? (
            <SkeletonRows count={2} height={48} />
          ) : device.data ? (
            <>
              <Row title="Model" value={device.data.model} testId="diagnostics-model" />
              <Row title="iOS" value={device.data.systemVersion} />
              <Row title="Battery" value={`${Math.round(device.data.batteryLevel * 100)}%${device.data.charging ? ' · charging' : ''}`} />
            </>
          ) : (
            <RetryRow title="Device info unavailable" error={device.error} onRetry={() => void device.reload()} testId="diagnostics-device-error" />
          )}
        </Section>

        <Section header="Storage">
          {storage.status === 'loading' && !storage.data ? (
            <SkeletonRows count={3} height={48} />
          ) : storage.data ? (
            <>
              <Row title="Total" value={<span class="tabular">{formatBytes(storageTotal(storage.data))}</span>} testId="diagnostics-storage" />
              {(Object.keys(STORAGE_LABELS) as StorageCategory[]).map((k) => (
                <Row key={k} title={STORAGE_LABELS[k].replace(/^./, (c) => c.toUpperCase())} value={<span class="tabular">{formatBytes(storage.data?.bytes[k] ?? 0)}</span>} />
              ))}
            </>
          ) : (
            <RetryRow title="Storage info unavailable" error={storage.error} onRetry={() => void storage.reload()} testId="diagnostics-storage-error" />
          )}
        </Section>

        <Section header={`Sources · ${list.length}`}>
          {list.map((s) => (
            <Row key={s.id} title={s.name} subtitle={sourceLine(s).slice(s.name.length + 1)} testId="diagnostics-source" />
          ))}
        </Section>

      </div>
    </Screen>
  );
}
