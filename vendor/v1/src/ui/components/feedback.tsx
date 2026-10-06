/** Toasts (with Undo), skeletons, and empty / error / offline states. */
import { createPortal, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { bridge, errorText, toUiError, type UiError } from '../bridge/client.ts';
import { failureInfo, type FailureAction } from '../lib/source-failure.ts';
import { push, stack } from '../state/nav.ts';
import { errorToast, toasts, undoToast, expire } from '../state/toast.ts';
import { Button } from './controls.tsx';
import { Icon } from './icon.tsx';

export function ToastHost() {
  const list = toasts.value;
  const top = stack.value[stack.value.length - 1]?.route.name ?? 'tabs';
  const bottom =
    top === 'tabs'
      ? 'calc(var(--tab-space) + 4px)'
      : top === 'reader'
        ? 'calc(var(--safe-bottom) + 108px)'
        : top === 'novel'
          ? 'calc(var(--safe-bottom) + 86px)'
          : 'calc(var(--safe-bottom) + 12px)';
  return createPortal(
    <div class="toast-host" style={{ '--toast-bottom': bottom }} aria-live="polite">
      {list.map((t) => (
        <ToastView key={t.id} id={t.id} text={t.text} undo={t.undo !== undefined} actionLabel={t.actionLabel ?? 'Undo'} error={t.tone === 'error'} />
      ))}
    </div>,
    document.getElementById('overlay-root') ?? document.body,
  );
}

function ToastView(props: { id: number; text: string; undo: boolean; actionLabel: string; error: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.__TACHI_DEV__?.noAnimations) return;
    el.current?.animate(
      [
        { transform: 'translate3d(0,24px,0) scale(.96)', opacity: 0 },
        { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
      ],
      { duration: 320, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
    );
  }, []);
  return (
    <div class={`toast${props.error ? ' is-error' : ''}`} ref={el} role="status" data-testid="toast" onClick={() => expire(props.id)}>
      {props.error && <Icon name="exclamationmark.triangle" size={18} class="toast-icon" />}
      <span class="toast-text">{props.text}</span>
      {props.undo && (
        <button
          type="button"
          class="toast-undo tap tap-dim"
          onClick={(e) => {
            e.stopPropagation();
            undoToast(props.id);
          }}
          data-testid="toast-undo"
        >
          {props.actionLabel}
        </button>
      )}
    </div>
  );
}

export function EmptyState(props: { icon: string; title: string; message?: ComponentChildren; action?: { label: string; onClick: () => void }; testId?: string }) {
  return (
    <div class="state" data-testid={props.testId ?? 'empty-state'}>
      <span class="state-icon">
        <Icon name={props.icon} size={44} />
      </span>
      <h2 class="state-title">{props.title}</h2>
      {props.message !== undefined && <p class="state-message">{props.message}</p>}
      {props.action && (
        <Button variant="tinted" onClick={props.action.onClick} class="state-action">
          {props.action.label}
        </Button>
      )}
    </div>
  );
}

/**
 * `onSolve` for a source's Cloudflare check: shows the site so the user can pass it
 * (sources.solveChallenge, long timeout), then retries the action that failed.
 */
export function solveChallengeThen(pluginId: string, retry: () => void): () => Promise<void> {
  return async () => {
    try {
      await bridge().call('sources.solveChallenge', { pluginId }, { timeoutMs: 10 * 60_000 });
      retry();
    } catch (err) {
      errorToast(errorText(toUiError(err)));
    }
  };
}

/**
 * A source failure with a known reason (BridgeError.reason): plain wording and the one action that
 * helps. Verify for bot checks, Retry for a site that's down / unreachable / limiting / offline,
 * "Check for Updates" when the site changed, nothing for a site that's gone.
 */
export interface FailureView {
  title: string;
  text: string;
  action: FailureAction | null;
}

function titleCase(s: string): string {
  const small = new Set(['a', 'an', 'of', 'the']);
  return s
    .split(' ')
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function failureView(e: UiError): FailureView | null {
  if (!e.reason) return null;
  const info = failureInfo(e.reason);
  const title = e.reason === 'offline' ? 'You’re Offline' : e.reason === 'bot-check' || e.reason === 'blocked' ? 'Verification Needed' : titleCase(info.short);
  return { title, text: /[.!?]$/.test(info.text) ? info.text : `${info.text}.`, action: info.action };
}

/** The "Check for Updates" action: the Extensions page, where plugin updates are. */
export function openExtensions(): void {
  push({ name: 'settings', page: 'sources' });
}

export function ErrorState(props: { error: UiError; onRetry?: () => void; /** CLOUDFLARE errors get an "Open site to verify" button. */ onSolve?: () => Promise<void>; compact?: boolean }) {
  const [solving, setSolving] = useState(false);
  const view = failureView(props.error);
  if (view) return <FailureState view={view} onRetry={props.onRetry} onSolve={props.onSolve} compact={props.compact} offline={props.error.reason === 'offline'} />;
  const challenge = props.error.code === 'CLOUDFLARE' && props.onSolve !== undefined;
  const offline = props.error.offline || props.error.code === 'NETWORK';
  const title = props.error.offline ? 'You’re Offline' : offline ? 'Can’t Connect' : props.error.code === 'LOCKED' ? 'Chapter Locked' : challenge ? 'Verification Needed' : 'Something Went Wrong';
  const message = props.error.offline
    ? 'Check your connection and try again.'
    : props.error.code === 'LOCKED'
      ? 'This chapter is only available on the source site.'
      : challenge
        ? 'This site checks that you’re a person. Open it once to pass the check, then it loads here again.'
        : errorText(props.error);
  return (
    <div class={`state${props.compact ? ' is-compact' : ''}`} data-testid={offline ? 'offline-state' : 'error-state'}>
      <span class="state-icon">
        <Icon name={offline ? 'wifi.slash' : props.error.code === 'LOCKED' ? 'lock.fill' : 'exclamationmark.triangle'} size={props.compact ? 30 : 42} />
      </span>
      <h2 class="state-title">{title}</h2>
      <p class="state-message">{message}</p>
      {challenge && (
        <Button
          variant="filled"
          icon="safari"
          class="state-action"
          disabled={solving}
          onClick={() => {
            setSolving(true);
            void props.onSolve?.().finally(() => setSolving(false));
          }}
        >
          {solving ? 'Waiting for the site…' : 'Open site to verify'}
        </Button>
      )}
      {props.onRetry && props.error.code !== 'LOCKED' && (
        <Button variant={challenge ? 'plain' : 'tinted'} onClick={props.onRetry} class={challenge ? 'state-action-2' : 'state-action'} {...(challenge ? {} : { icon: 'arrow.clockwise' })}>
          Try Again
        </Button>
      )}
    </div>
  );
}

function FailureState(props: { view: FailureView; onRetry: (() => void) | undefined; onSolve: (() => Promise<void>) | undefined; compact: boolean | undefined; offline: boolean }) {
  const [solving, setSolving] = useState(false);
  const { view } = props;
  // Without a way to open the site, a bot check falls back to Try Again.
  const action = view.action === 'open-site' && !props.onSolve ? 'retry' : view.action;
  return (
    <div class={`state${props.compact ? ' is-compact' : ''}`} data-testid={props.offline ? 'offline-state' : 'error-state'} data-reason-action={action ?? 'none'}>
      <span class="state-icon">
        <Icon name={props.offline ? 'wifi.slash' : 'exclamationmark.triangle'} size={props.compact ? 30 : 42} />
      </span>
      <h2 class="state-title">{view.title}</h2>
      <p class="state-message">{view.text}</p>
      {action === 'open-site' && (
        <Button
          variant="filled"
          icon="safari"
          class="state-action"
          disabled={solving}
          onClick={() => {
            setSolving(true);
            void props.onSolve?.().finally(() => setSolving(false));
          }}
        >
          {solving ? 'Waiting for the site…' : 'Open site to verify'}
        </Button>
      )}
      {action === 'retry' && props.onRetry && (
        <Button variant="tinted" icon="arrow.clockwise" onClick={props.onRetry} class="state-action">
          Try Again
        </Button>
      )}
      {/* Passed the check in Safari already: a quiet second way back in. */}
      {action === 'open-site' && props.onRetry && (
        <Button variant="plain" onClick={props.onRetry} class="state-action-2">
          Try Again
        </Button>
      )}
      {action === 'update' && (
        <Button variant="tinted" icon="arrow.down.circle" onClick={openExtensions} class="state-action">
          Check for Updates
        </Button>
      )}
    </div>
  );
}

export function SkeletonLine(props: { width?: string; height?: number; class?: string }) {
  return <span class={`skel ${props.class ?? ''}`} style={{ width: props.width ?? '100%', height: `${props.height ?? 12}px` }} />;
}

export function SkeletonRows(props: { count: number; thumb?: boolean; height?: number }) {
  return (
    <div class="skel-rows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: props.count }, (_, i) => (
        <div class="skel-row" key={i} style={{ height: `${props.height ?? 64}px` }}>
          {props.thumb && <span class="skel skel-thumb" />}
          <span class="skel-row-lines">
            <SkeletonLine width={`${55 + ((i * 37) % 35)}%`} height={13} />
            <SkeletonLine width={`${30 + ((i * 23) % 25)}%`} height={10} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function SkeletonGrid(props: { count: number; columns: number }) {
  return (
    <div class="novel-grid is-comfortable" style={{ '--cols': String(props.columns) }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: props.count }, (_, i) => (
        <div class="grid-item" key={i}>
          <span class="cover skel" />
          <SkeletonLine width="85%" height={11} class="skel-title" />
          <SkeletonLine width="50%" height={11} />
        </div>
      ))}
    </div>
  );
}
