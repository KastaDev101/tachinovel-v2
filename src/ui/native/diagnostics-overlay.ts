/**
 * Settings › Diagnostics (v1 screen, unchanged): a "Share Crash & Hang Reports" button when MetricKit
 * reports are stored on the device (src/core/diagnostics/metrickit.ts). Their one-line summaries are
 * already in the screen's "Recent problems" and in the copied/sent diagnostics; this shares the full
 * reports (call stacks) as one JSON file through the share sheet. Nothing is uploaded.
 *
 * Like the narration overlay, the button lives outside v1's Preact tree (fixed position on <body>).
 */
import { sharedClient } from '../capacitor-client.ts';

const CSS = `
.tn-crash{position:fixed;left:16px;right:16px;bottom:calc(env(safe-area-inset-bottom) + 16px);z-index:58;height:50px;border:0;border-radius:14px;
  display:flex;align-items:center;justify-content:center;text-align:center;background:rgba(40,40,48,.96);
  -webkit-backdrop-filter:blur(20px) saturate(1.6);color:#a8b4ff;font:600 16px -apple-system,system-ui,sans-serif;
  box-shadow:0 6px 24px rgba(0,0,0,.35);-webkit-tap-highlight-color:transparent;transition:opacity .15s}
.tn-crash:active{opacity:.6}
.tn-crash.is-raised{bottom:calc(env(safe-area-inset-bottom) + 84px)}
.tn-crash[hidden]{display:none}
/* Keep the end of the Diagnostics list reachable above the button. */
body.tn-crash-shown [data-testid="screen-diagnostics"] .screen-scroll{padding-bottom:calc(env(safe-area-inset-bottom) + 84px)}
`;

/** v2 core methods are not in v1's typed BridgeMethods. */
type Call = (method: string, args?: unknown) => Promise<unknown>;

export function label(count: number): string {
  return count === 1 ? 'Share 1 Crash or Hang Report' : `Share ${count} Crash & Hang Reports`;
}

function diagnosticsOnTop(): boolean {
  const layers = document.querySelectorAll('.nav-root > .layer');
  const top = layers[layers.length - 1];
  return top !== undefined && top.querySelector('[data-testid="screen-diagnostics"]') !== null;
}

export function installDiagnosticsOverlay(): void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tn-crash';
  button.hidden = true;
  button.setAttribute('data-testid', 'diagnostics-share-crash-reports');
  document.body.appendChild(button);

  const client = sharedClient() as unknown as { call: Call };
  const call: Call = (method, args) => client.call(method, args);
  let onScreen = false;
  let count = 0;

  const render = (): void => {
    button.hidden = !(onScreen && count > 0);
    document.body.classList.toggle('tn-crash-shown', !button.hidden);
    button.textContent = label(count);
    // Above the narration mini player when it is showing.
    button.classList.toggle('is-raised', document.querySelector('.tn-player:not([hidden])') !== null);
  };

  const refresh = async (): Promise<void> => {
    try {
      const reports = await call('diagnostics.reports');
      count = Array.isArray(reports) ? reports.length : 0;
    } catch {
      count = 0;
    }
    render();
  };

  button.addEventListener('click', () => {
    void call('diagnostics.shareReports', undefined).catch(() => undefined);
  });

  setInterval(() => {
    const visible = diagnosticsOnTop();
    if (visible && !onScreen) {
      onScreen = true;
      void refresh();
    } else if (!visible && onScreen) {
      onScreen = false;
      render();
    }
  }, 600);
}
