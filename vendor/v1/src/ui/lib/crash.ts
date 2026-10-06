/**
 * Last-resort crash reporting: any uncaught error or unhandled rejection is sent to the script's
 * log (iCloud TachiNovel/logs/app.log) and shown on screen instead of leaving a blank page.
 */
import { logToScript } from '../bridge/client.ts';

let shown = 0;

function describe(reason: unknown): { message: string; stack: string } {
  if (reason instanceof Error) return { message: `${reason.name}: ${reason.message}`, stack: reason.stack ?? '' };
  try {
    return { message: typeof reason === 'string' ? reason : JSON.stringify(reason), stack: '' };
  } catch {
    return { message: String(reason), stack: '' };
  }
}

function show(kind: string, message: string, stack: string): void {
  if (shown++ > 3) return; // don't flood the screen
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText =
    'position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom) + 96px);z-index:2147483647;' +
    'background:#3a0d12;color:#fff;border:1px solid #ff453a;border-radius:12px;padding:12px 14px;' +
    'font:13px/1.35 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-height:45vh;overflow:auto;' +
    '-webkit-user-select:text;user-select:text';
  box.textContent = `TachiNovel ${kind}\n${message}\n\n${stack.split('\n').slice(0, 8).join('\n')}`;
  document.body.appendChild(box);
}

function report(kind: string, reason: unknown): void {
  const { message, stack } = describe(reason);
  logToScript('error', `UI ${kind}: ${message}`, { stack: stack.slice(0, 2000) });
  show(kind, message, stack);
}

export function installCrashReporting(): void {
  window.addEventListener('error', (e) => report('error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => report('unhandled rejection', e.reason));
}
