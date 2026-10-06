/**
 * First-run onboarding: three swipeable cards over an empty library (Browse sources, Add to your
 * library, Long-press for more), skippable and shown once. LaunchIntro decides at launch between this
 * and the "What's New" sheet (lib/intro.ts); flags live in localStorage.
 */
import { signal } from '@preact/signals';
import { createPortal } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../components/controls.tsx';
import { Icon } from '../components/icon.tsx';
import { decideIntro, INTRO_KEYS, openFlagStore, unseenReleases, type FlagStore } from '../lib/intro.ts';
import { WHATS_NEW, type WhatsNewRelease } from '../lib/whats-new-data.ts';
import { popToRoot, selectTab } from '../state/nav.ts';
import { buildVersion, library } from '../state/store.ts';
import { WhatsNewSheet, whatsNewOpen } from './whats-new.tsx';
import '../styles/extras.css';

/** Set to show the welcome tour (at first launch, or again from Help & Tips). */
export const onboardingOpen = signal(false);

interface Card {
  icon: string;
  badge?: string;
  title: string;
  text: string;
}

const CARDS: readonly Card[] = [
  {
    icon: 'safari',
    title: 'Browse sources',
    text: 'Find novels on Stonescape, Royal Road and more in Browse. Search one source, or every source at once.',
  },
  {
    icon: 'books.vertical.fill',
    badge: 'plus',
    title: 'Add to your library in one tap',
    text: 'Tap Add to Library on a novel’s page. New chapters show up in Updates, and your place is saved as you read.',
  },
  {
    icon: 'square.grid.2x2.fill',
    badge: 'ellipsis',
    title: 'Long-press for more',
    text: 'Touch and hold a cover, a chapter or a row for quick actions like Mark as Read, Download and Remove.',
  },
];

export function Onboarding(props: { onDone: (getStarted: boolean) => void }) {
  const pages = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const last = index === CARDS.length - 1;

  function go(i: number): void {
    const el = pages.current;
    if (!el) return;
    setIndex(i);
    const instant = window.__TACHI_DEV__?.noAnimations === true || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ left: i * el.clientWidth, behavior: instant ? 'auto' : 'smooth' });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onDone(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return createPortal(
    <div class="onb" role="dialog" aria-modal="true" aria-label="Welcome to TachiNovel" data-testid="onboarding">
      <div class="onb-top">
        <button type="button" class="onb-skip tap tap-dim" onClick={() => props.onDone(false)} data-testid="onboarding-skip">
          Skip
        </button>
      </div>
      <div
        class="onb-pages"
        ref={pages}
        onScroll={(e) => {
          const el = e.currentTarget;
          const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
          if (i !== index) setIndex(Math.min(CARDS.length - 1, Math.max(0, i)));
        }}
      >
        {CARDS.map((c, i) => (
          <section class="onb-page" key={c.title} role="group" aria-label={`${i + 1} of ${CARDS.length}`} aria-hidden={i !== index} data-testid="onboarding-card">
            <span class="onb-art" aria-hidden="true">
              <Icon name={c.icon} size={54} />
              {c.badge && (
                <span class="onb-badge">
                  <Icon name={c.badge} size={20} />
                </span>
              )}
            </span>
            <h2 class="onb-title">{c.title}</h2>
            <p class="onb-text">{c.text}</p>
          </section>
        ))}
      </div>
      <div class="onb-dots">
        {CARDS.map((c, i) => (
          <button
            type="button"
            key={c.title}
            class={`onb-dot${i === index ? ' is-on' : ''}`}
            aria-label={`Card ${i + 1} of ${CARDS.length}`}
            aria-current={i === index}
            onClick={() => go(i)}
          />
        ))}
      </div>
      <div class="onb-actions">
        <Button variant="filled" size="large" onClick={() => (last ? props.onDone(true) : go(index + 1))}>
          {last ? 'Start Browsing' : 'Continue'}
        </Button>
      </div>
    </div>,
    document.getElementById('overlay-root') ?? document.body,
  );
}

/** Intros (onboarding, What's New, reading tips) stay off under the dev/test flags unless `intro: true`. */
export function introAllowed(): boolean {
  return !(__DEV_BUILD__ && window.__TACHI_DEV__ && window.__TACHI_DEV__.intro !== true);
}

/**
 * Launch-time intro: onboarding for a new user, otherwise "What's New" once per build with unseen news.
 * Decided once when the app has booted. Under the dev/test flags it stays off unless `intro: true`.
 */
export function LaunchIntro() {
  const [boot] = useState<{ store: FlagStore; show: 'onboarding' | 'whatsNew' | null; unseen: readonly WhatsNewRelease[] } | null>(() => {
    if (!introAllowed()) return null;
    const store = openFlagStore();
    const d = decideIntro({
      libraryEmpty: library.value.length === 0,
      persistent: store.persistent,
      onboarded: store.get(INTRO_KEYS.onboarded) === '1',
      lastBuild: store.get(INTRO_KEYS.build),
      seenRelease: store.get(INTRO_KEYS.seen),
      build: buildVersion.value,
      latestRelease: WHATS_NEW[0]?.id ?? null,
    });
    const unseen = unseenReleases(WHATS_NEW, store.get(INTRO_KEYS.seen));
    for (const [k, v] of Object.entries(d.write)) store.set(INTRO_KEYS[k as keyof typeof INTRO_KEYS], v);
    return { store, show: d.show, unseen };
  });
  // First run shows the tour from the very first frame; later it opens through onboardingOpen.
  const [firstRun, setFirstRun] = useState(boot?.show === 'onboarding');

  useEffect(() => {
    if (boot?.show === 'whatsNew') whatsNewOpen.value = true;
  }, []);

  const release = WHATS_NEW[0];
  // At launch: what's new since the last release seen. Opened later (About): every release.
  const [releases, setReleases] = useState<readonly WhatsNewRelease[]>(boot?.show === 'whatsNew' && boot.unseen.length > 0 ? boot.unseen : WHATS_NEW);
  return (
    <>
      {(firstRun || onboardingOpen.value) && (
        <Onboarding
          onDone={(getStarted) => {
            (boot?.store ?? openFlagStore()).set(INTRO_KEYS.onboarded, '1');
            onboardingOpen.value = false;
            setFirstRun(false);
            if (getStarted) {
              popToRoot();
              selectTab('browse');
            }
          }}
        />
      )}
      {release && (
        <WhatsNewSheet
          open={whatsNewOpen.value}
          releases={releases}
          onClose={() => {
            whatsNewOpen.value = false;
            const store = boot?.store ?? openFlagStore();
            store.set(INTRO_KEYS.build, buildVersion.value);
            store.set(INTRO_KEYS.seen, release.id);
            setReleases(WHATS_NEW);
          }}
        />
      )}
    </>
  );
}
