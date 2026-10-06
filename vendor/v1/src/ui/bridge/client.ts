/**
 * Bridge selection: the phone transport (Scriptable long-poll) on the device, the mock bridge when
 * `window.__TACHI_DEV__` is set (dev server, e2e tests).
 */
import type { SourceFailureReason } from '../../shared/contracts/domain.ts';
import { BridgeCallError, type BridgeClient, type ErrorCode } from '../../shared/contracts/protocol.ts';
import { createMockBridge } from '../dev/mock-bridge.ts';
import { createPhoneBridge } from './phone-client.ts';

let client: BridgeClient | null = null;

export function bridge(): BridgeClient {
  if (!client) {
    // __DEV_BUILD__ is a build-time constant: phone builds drop the mock bridge and its fixtures.
    if (__DEV_BUILD__ && window.__TACHI_DEV__) client = createMockBridge(window.__TACHI_DEV__);
    else client = createPhoneBridge();
  }
  return client;
}

/** Errors as the UI shows them. */
export interface UiError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  offline: boolean;
  /** Source failures: why the site failed (plain wording + the right action). */
  reason?: SourceFailureReason;
}

export function toUiError(err: unknown): UiError {
  if (err instanceof BridgeCallError) {
    // `reason` rides along on source failures (BridgeError.reason).
    const reason = err.reason;
    const offline = reason === 'offline' || (err.code === 'NETWORK' && (navigator.onLine === false || /offline|internet/i.test(err.message)));
    return { code: err.code, message: err.message, retryable: err.retryable, offline, ...(reason ? { reason } : {}) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'UNKNOWN', message, retryable: true, offline: false };
}

/** Short human text for an error (toasts). */
export function errorText(e: UiError): string {
  if (e.offline) return 'You’re offline';
  switch (e.code) {
    case 'NETWORK':
      return 'Couldn’t connect to the source';
    case 'TIMEOUT':
      return 'The source took too long to respond';
    case 'CLOUDFLARE':
      return 'The site is behind a browser check';
    case 'NOT_FOUND':
      return 'Not found';
    case 'LOCKED':
      return 'This chapter is locked';
    case 'PLUGIN':
      return 'The source plugin failed';
    case 'STORAGE':
      return 'Couldn’t save on this device';
    case 'INVALID_ARGS':
    case 'UNKNOWN_METHOD':
    case 'UNKNOWN':
      return e.message || 'Something went wrong';
  }
}

/** Fire-and-forget logging to the script's log file. */
export function logToScript(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
  bridge()
    .call('app.log', { level, message, data })
    .catch(() => undefined);
}
