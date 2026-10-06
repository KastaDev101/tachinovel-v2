/** The script's user-facing notices as a calm banner under the top bar (never over the reader). */
import { createPortal } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { stack } from '../state/nav.ts';
import { dismissNotice, notices } from '../state/notices.ts';
import { Icon } from './icon.tsx';

/** How long a notice stays up unless dismissed. */
const SHOW_MS = 12_000;

export function NoticeHost() {
  const route = stack.value[stack.value.length - 1]?.route.name;
  const notice = notices.value[0];
  // Reading: keep the page clean; the notice waits until the reader is closed.
  const visible = notice !== undefined && route !== 'reader';

  // Right under the screen's whole top bar (title row plus tabs/search field, which vary per screen).
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!visible) return;
    const bar = document.querySelector('.nav-root > .layer:last-child .navbar');
    setTop(bar ? bar.getBoundingClientRect().bottom + 8 : null);
  }, [visible, notice?.id, stack.value.length]);

  useEffect(() => {
    if (!visible || !notice) return;
    const t = window.setTimeout(() => dismissNotice(notice.id), SHOW_MS);
    return () => window.clearTimeout(t);
  }, [visible, notice?.id]);

  if (!visible || !notice) return null;
  return createPortal(
    <div class="notice" role="status" aria-live="polite" style={top !== null ? { top: `${top}px` } : undefined} data-testid="notice">
      <Icon name="info.circle" size={18} class="notice-icon" />
      <span class="notice-text">{notice.message}</span>
      <button type="button" class="notice-close tap tap-dim" aria-label="Dismiss" onClick={() => dismissNotice(notice.id)} data-testid="notice-dismiss">
        <Icon name="xmark" size={14} />
      </button>
    </div>,
    document.getElementById('overlay-root') ?? document.body,
  );
}
