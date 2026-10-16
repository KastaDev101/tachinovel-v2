/**
 * More › About › Diagnostics (v1 screen, unchanged): "Share N Crash & Hang Reports", a tinted row right under "Copy Full
 * Diagnostics" while MetricKit reports are stored on the device (src/core/diagnostics/metrickit.ts). Their one-line
 * summaries are already in the screen's "Recent Problems" and in the copied/sent diagnostics; this shares the full
 * reports (call stacks) as one JSON file through the share sheet. Nothing is uploaded.
 *
 * Cleanup 1 (2026-10-15): a row of the list (a copy of v1's, added by v1-hooks.ts when the screen renders) instead of a
 * floating bar over it, and the count is read once when the screen opens instead of a timer checking twice a second.
 */
import { sharedClient } from '../capacitor-client.ts';

/** v2 core methods are not in v1's typed BridgeMethods. */
type Call = (method: string, args?: unknown) => Promise<unknown>;

export function label(count: number): string {
  return count === 1 ? 'Share 1 Crash or Hang Report' : `Share ${count} Crash & Hang Reports`;
}

function call(method: string, args?: unknown): Promise<unknown> {
  const client = sharedClient() as unknown as { call: Call };
  return client.call(method, args);
}

/** The row under `anchor` (Copy Full Diagnostics), hidden until the stored reports are counted (and while none are). */
export function addCrashReportsRow(anchor: HTMLElement): HTMLElement {
  const row = anchor.cloneNode(true) as HTMLElement;
  row.dataset.testid = 'diagnostics-share-crash-reports';
  row.hidden = true;
  const title = row.querySelector<HTMLElement>('.row-title');
  // At the largest text sizes the row grows to two lines instead of cutting the count off.
  title?.style.setProperty('white-space', 'normal');
  row.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void call('diagnostics.shareReports').catch(() => undefined);
  });
  anchor.after(row);
  void call('diagnostics.reports')
    .then((reports) => {
      const count = Array.isArray(reports) ? reports.length : 0;
      if (title) title.textContent = label(count);
      row.hidden = count === 0;
    })
    .catch(() => undefined);
  return row;
}
