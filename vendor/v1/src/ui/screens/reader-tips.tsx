/**
 * Reading tips, once: the first time a chapter opens, a small card explains the reader's gestures
 * (middle tap for controls, edge taps, double-tap info, continuous scrolling). It lives outside the
 * reader and watches the navigation stack; "Got It" stores the flag. Off under the dev/test flags
 * unless `intro: true`, like the other intros.
 */
import { createPortal } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../components/controls.tsx';
import { Icon } from '../components/icon.tsx';
import { openFlagStore, type FlagStore } from '../lib/intro.ts';
import { stack } from '../state/nav.ts';
import { settings } from '../state/store.ts';
import { introAllowed, onboardingOpen } from './onboarding.tsx';
import '../styles/extras.css';

export const READER_TIPS_KEY = 'tachinovel.tips.reader';
/** Let the chapter start loading before the card slides up. */
const DELAY_MS = 900;

export function readerTips(r: { tapZones: boolean; continuous: boolean }): { icon: string; text: string }[] {
  return [
    { icon: 'textformat.size', text: 'Tap the middle of the page for the controls: chapters, auto-scroll, night mode and Appearance for fonts and spacing.' },
    ...(r.tapZones ? [{ icon: 'chevron.right', text: 'Tap near the left or right edge to turn the page.' }] : []),
    { icon: 'clock', text: 'Double-tap to see the time, battery and how far you are.' },
    ...(r.continuous ? [{ icon: 'arrow.down', text: 'Keep scrolling: the next chapter follows on its own.' }] : []),
  ];
}

export function ReaderTips() {
  const store = useRef<FlagStore | null>(null);
  store.current ??= introAllowed() ? openFlagStore() : null;
  const top = stack.value[stack.value.length - 1]?.route.name;
  const [show, setShow] = useState(false);

  useEffect(() => {
    const s = store.current;
    if (top !== 'reader') {
      setShow(false); // left the reader before reading the tips: offer them next time
      return;
    }
    if (!s?.persistent || s.get(READER_TIPS_KEY) === '1' || onboardingOpen.value) return;
    const t = window.setTimeout(() => setShow(true), DELAY_MS);
    return () => window.clearTimeout(t);
  }, [top]);

  if (!show) return null;
  const done = (): void => {
    store.current?.set(READER_TIPS_KEY, '1');
    setShow(false);
  };
  return createPortal(
    <div class="rtips" data-testid="reader-tips">
      <div class="rtips-backdrop" onClick={done} />
      <div class="rtips-card" role="dialog" aria-modal="true" aria-labelledby="rtips-title">
        <h2 class="rtips-title" id="rtips-title">
          Reading Tips
        </h2>
        <ul class="rtips-list">
          {readerTips(settings.value.reader).map((t) => (
            <li key={t.text}>
              <span class="rtips-icon" aria-hidden="true">
                <Icon name={t.icon} size={18} />
              </span>
              <span>{t.text}</span>
            </li>
          ))}
        </ul>
        <Button variant="filled" size="large" onClick={done}>
          Got It
        </Button>
      </div>
    </div>,
    document.getElementById('overlay-root') ?? document.body,
  );
}
