/**
 * Listening UI layered over the v1 UI (v1 itself is not modified):
 *
 * - Reader: "Listen" in the reader's bottom bar (next to Chapters / Auto-scroll / Night / Appearance, same
 *   style), so it shows and hides with the bars. Tap = listen from the paragraph at the top of the page (v1's
 *   reading line), or on from the sentence heard last when listening stopped and the page wasn't touched since, with the
 *   novel's voice: Kokoro on device (bundled), the system voice standing in sentence by sentence when Kokoro
 *   can't keep up. While listening it becomes "Player" (opens the Listen player). The sentence script is built from exactly what the reader shows (speech-dom.ts, the v1
 *   narration front-end + the pronunciation lexicon). PC-narrated audio only with Settings › Voices ›
 *   Advanced › "Use PC audio when available".
 * - While listening: a mini player on every screen (title, voice, play/pause, stop); tapping the title
 *   opens the Listen player (car-mode.ts). In the reader it follows the bars: hidden while reading with the
 *   bars hidden.
 * - Highlighting: the spoken SENTENCE for every source (speech: from the script's canonical ranges;
 *   narrated audio: timestamps re-aligned onto the reader's DOM, highlight.ts).
 * - Follow along (narration-follow.ts): the view keeps the spoken sentence in the middle; a finger in the reader lets
 *   go of it and a "Back to narration" pill brings it back. Back in the app after listening with the phone locked or
 *   in the car, and when the reader shows again, it jumps to the sentence being spoken (switching chapters if
 *   narration went on) and marks it briefly.
 * - More › Listen in the Car (v1 screen): an "Open player" button at the bottom.
 * pluginId/novelPath for a chapter come from observed bridge calls (chapter.get / progress.save).
 */
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { fallbackIconUrl } from '@v1/ui/components/icons.ts';
import { replaceTop } from '@v1/ui/state/nav.ts';
import { symbols } from '@v1/ui/state/store.ts';
import type { Lexicon } from '@v1tts/frontend.ts';
import { blockRange } from '@v1tts/player/dom-blocks.ts';
import { callCore, observeCalls } from '../capacitor-client.ts';
import { installCarMode } from './car-mode.ts';
import { alignChapter, clearPaint, HIGHLIGHT_CSS, paintRange, paintSegment, type ChapterAlignment } from './highlight.ts';
import { Narration, type NarrationProgress, type NarrationState } from './narration.ts';
import {
  canReattach,
  missingChapterAction,
  nthInParagraph,
  READER_JUMP_CONTROLS,
  returnTarget,
  scrollModeFor,
  SWITCH_GRACE_MS,
  SWITCH_REPEAT_MS,
  targetFromState,
  type FollowTarget,
  type Heard,
} from './narration-follow.ts';
import { chapterBody, chapterSections, locateReadingPoint, paragraphsOf, readerRoot } from './reader-dom.ts';
import { domSpeechScript, listMemory, rangeForSentence, rememberListened, type DomScript } from './speech-dom.ts';
import { voiceLabel } from './voices-ui.ts';
import { fs } from './type.ts';

interface ChapterRef {
  pluginId: string;
  novelPath: string;
  chapterPath: string;
}

const STYLE = `
/* "Listen" joins the reader's bottom tools: they share the row so five fit on a narrow phone. */
.rd-tools:has(.tn-rd-listen) .rd-tool{width:auto;flex:1 1 0;min-width:0}
.rd-tools .tn-rd-listen span{white-space:nowrap}
.tn-player[hidden],.tn-open-car[hidden]{display:none}
/* While the mini player shows, v1's toasts sit above it instead of overlapping it (reader, tabs, novel page):
   at their usual place, or just above the player's top, whichever is higher. */
html.tn-player-on .toast-host{bottom:max(var(--toast-bottom, calc(var(--safe-bottom) + 12px)), calc(var(--tn-player-top, 0px) + 8px))}
.tn-player{position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom) + 12px);z-index:61;display:flex;align-items:center;gap:10px;
  padding:8px 10px;border-radius:16px;background:rgba(40,40,48,.86);-webkit-backdrop-filter:blur(20px) saturate(1.6);color:#f2f2f7;
  font:500 ${fs(14)} -apple-system,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35)}
.tn-player .tn-title{flex:1;min-width:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit;padding:4px 2px}
.tn-player .tn-title b{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tn-player .tn-title small{display:block;color:#a1a1aa;font-size:${fs(12)}}
.tn-player button.tn-ic{border:0;background:transparent;color:inherit;width:40px;height:40px;border-radius:20px;display:flex;align-items:center;justify-content:center;flex:none}
.tn-player button.tn-ic:active{background:rgba(255,255,255,.12)}
.tn-open-car{position:fixed;left:16px;right:16px;bottom:calc(env(safe-area-inset-bottom) + 16px);z-index:59;min-height:54px;border:0;border-radius:16px;
  padding:12px 16px;box-sizing:border-box;line-height:1.25;
  background:#a8b4ff;color:#15151a;font:600 ${fs(17)} -apple-system,system-ui,sans-serif;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.35)}
/* Room at the end of the scrolling content for the floating player / button, so nothing stays under them
   (their height follows Dynamic Type: measured in render). */
html.tn-player-on .screen-scroll>.scroll-content::after,html.tn-player-on .reader-content::after,
html.tn-open-car-on [data-testid="screen-narration"] .screen-scroll>.scroll-content::after{content:"";display:block;height:max(72px, calc(var(--tn-float-h, 60px) + 12px))}
.rd-body > .tn-speaking,.rd-body .tn-speaking{background:rgba(168,180,255,.16);border-radius:6px;box-shadow:0 0 0 4px rgba(168,180,255,.16)}
/* Jumped to the narration: the paragraph glows briefly (with v1's "you were here" bar in the margin). */
@keyframes tn-here{0%,45%{background-color:rgba(168,180,255,.26)}100%{background-color:rgba(168,180,255,0)}}
.rd-body > .tn-here{animation:tn-here 2.4s ease;border-radius:6px}
/* "Back to narration": the reader was scrolled away from the spoken sentence while listening. */
.tn-follow[hidden]{display:none}
.tn-follow{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom) + 16px);z-index:62;display:flex;align-items:center;gap:6px;
  min-height:36px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:6px 14px;border:0;border-radius:18px;background:rgba(40,40,48,.86);
  -webkit-backdrop-filter:blur(20px) saturate(1.6);color:#a8b4ff;font:600 ${fs(14)} -apple-system,system-ui,sans-serif;white-space:nowrap;
  box-shadow:0 4px 18px rgba(0,0,0,.3)}
.tn-follow:active{opacity:.7}
${HIGHLIGHT_CSS}
`;

const ICON_PAUSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const ICON_PLAY = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg>';
const ICON_FOLLOW =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10v4M7 7v10M11 4v16M15 8v8M19 11v2"/></svg>';
const ICON_CLOSE =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/** The novel's cover (library entry, else its reading history), or undefined: native shows it on the lock screen. */
async function novelCover(pluginId: string, novelPath: string): Promise<string | undefined> {
  const key = `${pluginId}:${novelPath}`;
  const lib = await callCore<{ key: string; cover?: string }[]>('library.list', {}).catch(() => []);
  const hit = lib.find((e) => e.key === key)?.cover;
  if (hit) return hit;
  const hist = await callCore<{ pluginId: string; path: string; cover?: string }[]>('history.list', { limit: 50 }).catch(() => []);
  return hist.find((h) => h.pluginId === pluginId && h.path === novelPath && h.cover)?.cover;
}

function tapFeedback(): void {
  void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
}

/** The screen the user sees: the last layer of v1's navigation stack. */
function topLayer(): Element | null {
  const layers = document.querySelectorAll('.nav-root > .layer');
  return layers[layers.length - 1] ?? null;
}

/** v1's bottom-anchored UI on a screen: tab bar, reader bottom bar, Start/Resume button, selection toolbar. */
const BOTTOM_UI = '.tabbar:not(.is-hidden), .reader.bars-visible .rd-bottom, .fab, .toolbar';

/**
 * Where the mini player sits: 8 px above the screen's own bottom UI (it used to cover the tab bar, the
 * reader's bottom bar and the Resume button), else just above the home indicator (the CSS default).
 */
export function playerBottom(top: Element | null, viewportHeight = window.innerHeight): string {
  let edge: number | null = null;
  for (const el of top?.querySelectorAll(BOTTOM_UI) ?? []) {
    const r = el.getBoundingClientRect();
    // The reader's bar slides in with a transform: place the player above where it ends up, not where
    // it is mid-slide (it is pinned to the bottom, so its layout height says where).
    const bar = el.matches('.rd-bottom') && el instanceof HTMLElement;
    const rTop = bar ? viewportHeight - el.offsetHeight : r.top;
    const rBottom = bar ? viewportHeight : r.bottom;
    if (r.height === 0 || rTop >= viewportHeight || rBottom < viewportHeight - 160) continue;
    edge = edge === null ? rTop : Math.min(edge, rTop);
  }
  return edge === null ? '' : `${Math.round(viewportHeight - edge + 8)}px`;
}

/** VoiceOver label of the mini player's title button: "<novel>, <chapter>" (what is playing). */
export function playerTitleLabel(state: Pick<NarrationState, 'novelName' | 'chapterName'>): string {
  const parts = [state.novelName, state.chapterName].map((s) => s?.trim()).filter((s): s is string => !!s);
  return parts.length ? parts.join(', ') : 'Open the player';
}

let openPlayer: (() => void) | null = null;

/** Open the Listen player (More › Listen, the mini player). */
export function openListenPlayer(): void {
  openPlayer?.();
}

export function installNarrationOverlay(): void {
  const chapters = new Map<string, ChapterRef>();
  let state: NarrationState = { status: 'idle' };
  let lastUserScroll = 0;
  /** The sentence heard last (speech: the reader's paragraph and the sentence in it) and when: Listen goes on from it. */
  let lastSpoken: { chapterPath: string; paragraph: number; sentence?: number; at: number } | null = null;
  /** A Listen tap is still starting (lexicon, cover, play): another tap meanwhile would start a second read. */
  let starting = false;
  let paragraphEl: Element | null = null;
  /** Timestamp alignment per chapter (re-made when the reader re-renders the chapter body). */
  const alignments = new Map<string, ChapterAlignment | null>();
  const timingRequests = new Map<string, Promise<string | null>>();
  /** Speech: the reader's own script per chapter (re-made when the reader re-renders the body). */
  const speechScripts = new Map<string, DomScript>();
  // ---- Follow along (narration-follow.ts) ----
  /** The reader keeps the spoken sentence in view; false after a finger moved it elsewhere (the pill shows). */
  let attached = true;
  /** The latest progress report (any engine), with the novel playing then. */
  let heard: Heard | null = null;
  /** When the app went to the background (screen locked, another app, CarPlay only). */
  let hiddenAt = 0;
  /** Back from the background: a sync with native's state is due; progress reports meanwhile are only recorded. */
  let returning = false;
  let returnTimer = 0;
  /** The reader that was following and the chapter it showed the narration in. */
  let followed: { reader: HTMLElement; chapterPath: string } | null = null;
  /** A reader is opening on the narrated chapter (switched to it, or just opened): jump once its text is in. */
  let pending: { target: FollowTarget; until: number } | null = null;
  let lastSwitch: { chapterPath: string; at: number } | null = null;
  let switchTimer = 0;
  /** The reader on top as last seen, and when a reader was last on screen. */
  let shownReader: HTMLElement | null = null;
  let readerSeenAt = 0;
  /** Readers already shown once (a reader uncovered again is not a new one). */
  const seenReaders = new WeakSet<HTMLElement>();
  const car = installCarMode();
  openPlayer = () => {
    car.open();
    render();
  };

  // Learn which novel each chapter belongs to from bridge traffic.
  observeCalls((method, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if ((method === 'chapter.get' || method === 'progress.save') && typeof a.chapterPath === 'string' && typeof a.pluginId === 'string' && typeof a.novelPath === 'string') {
      chapters.set(a.chapterPath, { pluginId: a.pluginId, novelPath: a.novelPath, chapterPath: a.chapterPath });
    }
  });

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);

  const player = document.createElement('div');
  player.className = 'tn-player';
  player.hidden = true;
  player.dataset.testid = 'mini-player';
  // The title button's VoiceOver label is "<novel>, <chapter>" (set in render) with "Opens the player" as
  // its hint (aria-describedby → accessibilityHint); its visible lines are the chapter and the voice.
  player.innerHTML =
    `<button type="button" class="tn-ic tn-toggle" aria-label="Pause">${ICON_PAUSE}</button>` +
    `<button type="button" class="tn-title" aria-label="Open the player" aria-describedby="tn-player-hint"><b></b><small></small></button>` +
    `<button type="button" class="tn-ic tn-stop" aria-label="Stop">${ICON_CLOSE}</button><span id="tn-player-hint" hidden>Opens the player</span>`;

  const openCar = document.createElement('button');
  openCar.className = 'tn-open-car';
  openCar.type = 'button';
  openCar.textContent = 'Open the player';
  openCar.hidden = true;
  openCar.dataset.testid = 'open-car-player';

  const backToNarration = document.createElement('button');
  backToNarration.className = 'tn-follow';
  backToNarration.type = 'button';
  backToNarration.hidden = true;
  backToNarration.dataset.testid = 'back-to-narration';
  backToNarration.innerHTML = `${ICON_FOLLOW}<span>Back to narration</span>`;

  document.body.append(player, openCar, backToNarration);
  const toggle = player.querySelector<HTMLButtonElement>('.tn-toggle') as HTMLButtonElement;
  const titleBtn = player.querySelector<HTMLButtonElement>('.tn-title') as HTMLButtonElement;
  const stop = player.querySelector<HTMLButtonElement>('.tn-stop') as HTMLButtonElement;

  const active = (): boolean => state.status === 'playing' || state.status === 'paused' || state.status === 'loading';

  /** Writes only on change: render() runs every 600 ms and must not churn the DOM under a finger. */
  const set = {
    hidden(el: HTMLElement, v: boolean): void {
      if (el.hidden !== v) el.hidden = v;
    },
    html(el: HTMLElement, v: string): void {
      if (el.dataset.tnHtml !== v) {
        el.dataset.tnHtml = v;
        el.innerHTML = v;
      }
    },
    text(el: HTMLElement, v: string): void {
      if (el.textContent !== v) el.textContent = v;
    },
    attr(el: Element, name: string, v: string): void {
      if (el.getAttribute(name) !== v) el.setAttribute(name, v);
    },
    bottom(el: HTMLElement, v: string): void {
      if (el.style.bottom !== v) el.style.bottom = v;
    },
  };

  function render(): void {
    // Only the screen on top counts: a reader or the Listen in the Car screen further down the stack
    // (covered by a pushed screen) must not put its buttons over the visible one.
    const top = topLayer();
    const reader = top?.querySelector<HTMLElement>('[data-testid="screen-reader"]') ?? null;
    const onNarrationScreen = !!top?.querySelector('[data-testid="screen-narration"]');
    if (reader) readerTool(reader);
    // In the reader the mini player shows and hides with the bars (like the Listen tool itself).
    const barsHidden = !!reader && !reader.classList.contains('bars-visible'); // the reader root is v1's `.reader`
    set.hidden(player, !active() || car.isOpen || barsHidden);
    set.hidden(openCar, !onNarrationScreen || active() || car.isOpen);
    document.documentElement.classList.toggle('tn-player-on', !player.hidden);
    document.documentElement.classList.toggle('tn-open-car-on', !openCar.hidden);
    if (!player.hidden) {
      set.bottom(player, playerBottom(top));
      const edge = `${Math.round(window.innerHeight - player.getBoundingClientRect().top)}px`;
      if (document.documentElement.style.getPropertyValue('--tn-player-top') !== edge) document.documentElement.style.setProperty('--tn-player-top', edge);
    }
    set.html(toggle, state.status === 'paused' ? ICON_PLAY : ICON_PAUSE);
    set.attr(toggle, 'aria-label', state.status === 'paused' ? 'Play' : 'Pause');
    set.text(titleBtn.querySelector('b') as HTMLElement, state.chapterName ?? '');
    set.text(
      titleBtn.querySelector('small') as HTMLElement,
      state.status === 'loading' ? 'Loading…' : state.status === 'error' ? (state.error ?? 'Error') : voiceLabel(state),
    );
    set.attr(titleBtn, 'aria-label', playerTitleLabel(state));
    // Follow along: a reader that (re)appears on top catches up with the narration; "Back to narration" while detached.
    if (reader && document.visibilityState !== 'hidden') {
      if (reader !== shownReader) {
        const seen = readerSeenAt;
        shownReader = reader;
        onReaderShown(reader, seen);
      }
      readerSeenAt = Date.now();
    } else if (!reader) {
      shownReader = null;
    }
    applyPending();
    const narrated = state.pluginId && state.novelPath ? `${state.pluginId}:${state.novelPath}` : null;
    set.hidden(backToNarration, attached || !active() || car.isOpen || !reader || !narrated || readerNovel(reader) !== narrated);
    if (!backToNarration.hidden) {
      // Above the mini player when it shows (bars up), else just above the home indicator (the CSS default).
      set.bottom(backToNarration, player.hidden ? '' : `${Math.round(window.innerHeight - player.getBoundingClientRect().top + 8)}px`);
    }
    // Room under scrolling content for whichever floating control shows (taller with larger text).
    const float = !player.hidden ? player : !openCar.hidden ? openCar : null;
    if (float) {
      const h = `${float.offsetHeight}px`;
      if (document.documentElement.style.getPropertyValue('--tn-float-h') !== h) document.documentElement.style.setProperty('--tn-float-h', h);
    }
  }

  /** The "Listen" tool in the reader's bottom bar (re-added when v1 re-renders the bar). */
  function readerTool(reader: HTMLElement): void {
    const bar = reader.querySelector<HTMLElement>('.rd-tools');
    if (!bar) return;
    let tool = bar.querySelector<HTMLButtonElement>('[data-testid="reader-listen"]');
    if (!tool) {
      tool = document.createElement('button');
      tool.type = 'button';
      tool.className = 'rd-tool tap tap-dim tn-rd-listen';
      tool.dataset.testid = 'reader-listen';
      const icon = symbols.value.headphones ?? fallbackIconUrl('headphones');
      tool.innerHTML = `<i class="icon" style="--icon:url(&quot;${icon.replace(/"/g, '%22')}&quot;);--icon-size:22px" aria-hidden="true"></i><span></span>`;
      tool.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (active()) {
          tapFeedback();
          car.open();
          render();
        } else {
          listenFromHere();
        }
      });
      bar.append(tool);
      // Follow the bars right away (render() also runs on a timer): v1 toggles `bars-visible` on the root.
      if (!reader.dataset.tnBars) {
        reader.dataset.tnBars = '1';
        new MutationObserver(() => {
          render();
          window.setTimeout(render, 320); // again once the bars' 280 ms slide is over
        }).observe(reader, { attributes: true, attributeFilter: ['class'] });
      }
    }
    const on = active();
    set.text(tool.querySelector('span') as HTMLElement, on ? 'Player' : 'Listen');
    set.attr(tool, 'aria-label', on ? 'Open the Listen player' : 'Listen from here');
    if (tool.classList.contains('is-on') !== on) tool.classList.toggle('is-on', on);
  }

  function listenFromHere(): void {
    if (starting) return;
    const root = topLayer()?.querySelector<HTMLElement>('[data-testid="screen-reader"]') ?? null;
    if (!root) return;
    // From v1's reading line, just under the status bar (reader.tsx: the scroller's top + the inset + 1): the paragraph
    // the reader keeps as its position. 8 px sat inside that band, so Listen began with the paragraph before it,
    // hidden under the status bar.
    const scrollerTop = root.querySelector('.reader-scroll')?.getBoundingClientRect().top ?? 0;
    const line = scrollerTop + (root.querySelector<HTMLElement>('.rd-inset-probe')?.offsetHeight ?? 0) + 1;
    let point: { chapterPath: string; paragraph: number; sentence?: number } | null = locateReadingPoint(root, line, window.innerHeight);
    // Listening stopped and the page wasn't touched after the last sentence heard: follow() kept that sentence in the
    // middle of the screen, so go on from it. From the top line she read again the paragraphs just heard (Kasta,
    // 2026-10-12: "replays certain lines or paragraphs for no reason"). Only while its paragraph is still on screen.
    const heard = lastSpoken && lastUserScroll < lastSpoken.at ? lastSpoken : null;
    const heardBox = heard ? chapterBody(root, heard.chapterPath)?.children[heard.paragraph]?.getBoundingClientRect() : undefined;
    if (heard && heardBox && heardBox.bottom > line && heardBox.top < window.innerHeight) {
      point = { chapterPath: heard.chapterPath, paragraph: heard.paragraph, ...(heard.sentence !== undefined ? { sentence: heard.sentence } : {}) };
    }
    if (!point) return;
    const ref = chapters.get(point.chapterPath);
    const body = chapterBody(root, point.chapterPath);
    if (!ref || !body) return;
    tapFeedback();
    starting = true;
    // Listening from this page: the reader follows the voice from here.
    attached = true;
    followed = { reader: root, chapterPath: point.chapterPath };
    pending = null;
    const novelName = root.querySelector('.rd-top-novel')?.textContent ?? '';
    const chapterName = root.querySelector('.rd-top-chapter')?.textContent ?? point.chapterPath;
    const start = { paragraph: point.paragraph, ...(point.sentence !== undefined ? { sentence: point.sentence } : {}) };
    void (async () => {
      try {
        // The novel's pronunciation lexicon (global + its own), then the script from the reader's DOM.
        const l = await callCore<{ global?: Lexicon; novel?: Lexicon | null }>('narration.lexicon.get', { novelKey: `${ref.pluginId}:${ref.novelPath}` }).catch(() => null);
        const lexicons = [l?.global, l?.novel].filter((x): x is Lexicon => !!x);
        let script: DomScript | null = null;
        try {
          script = domSpeechScript(body, { title: chapterName, lexicons, lists: listMemory(`${ref.pluginId}:${ref.novelPath}`, ref.chapterPath) });
          speechScripts.set(ref.chapterPath, script);
          rememberListened(chapterName, script.script);
        } catch (err) {
          console.warn('speech script failed; native splits the paragraphs', err);
        }
        // The novel's cover for the lock screen, CarPlay and Control Center (Kasta, 2026-10-09: the square was empty).
        const coverUrl = await novelCover(ref.pluginId, ref.novelPath);
        await Narration.play({
          pluginId: ref.pluginId,
          novelPath: ref.novelPath,
          chapterPath: ref.chapterPath,
          novelName,
          chapterName,
          ...(coverUrl ? { coverUrl } : {}),
          paragraphs: paragraphsOf(body),
          ...(script && script.script.items.length > 0 ? { script: script.script } : {}),
          start,
          autoContinue: true,
        });
      } catch (err) {
        console.warn('listen failed', err);
      } finally {
        starting = false;
      }
    })();
  }
  toggle.addEventListener('click', () => {
    tapFeedback();
    void (state.status === 'paused' ? Narration.resume() : Narration.pause());
  });
  stop.addEventListener('click', () => {
    tapFeedback();
    void Narration.stop();
  });
  titleBtn.addEventListener('click', () => {
    car.open();
    render();
  });
  openCar.addEventListener('click', () => {
    tapFeedback();
    car.open();
    render();
  });

  // A drag, not a tap: iOS sends touchmove for a tap's own finger jitter (the bars tap, the Listen tap itself),
  // which would otherwise discard the resume point and let go of the narration for a plain tap.
  let touchY: number | null = null;
  document.addEventListener(
    'touchstart',
    (e) => {
      touchY = e.touches?.[0]?.clientY ?? null;
    },
    { passive: true, capture: true },
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      const y = e.touches?.[0]?.clientY;
      if (touchY === null || y === undefined || Math.abs(y - touchY) > 10) {
        lastUserScroll = Date.now();
        if (inTopReader(e.target)) detach();
      }
    },
    { passive: true, capture: true },
  );
  // A wheel (PC shell, a trackpad) scrolls the reader like a finger.
  document.addEventListener(
    'wheel',
    (e) => {
      if (!inTopReader(e.target)) return;
      lastUserScroll = Date.now();
      detach();
    },
    { passive: true, capture: true },
  );
  // The reader's own jumps (prev/next, the chapter list, the slider, "Back to Ch. …", find): the user goes somewhere else.
  const onJumpControl = (e: Event): void => {
    const t = e.target;
    if (t instanceof Element && t.closest(READER_JUMP_CONTROLS) && topReader()) detach();
  };
  document.addEventListener('click', onJumpControl, { capture: true });
  document.addEventListener('input', onJumpControl, { capture: true });

  backToNarration.addEventListener('click', () => {
    tapFeedback();
    attached = true;
    const t = targetFromState(state, heard);
    render();
    if (t) void highlight(t, { force: true, flash: true, allowSwitch: true });
  });

  /** The reader on the top layer (the one on screen), if any. */
  function topReader(): HTMLElement | null {
    return topLayer()?.querySelector<HTMLElement>('[data-testid="screen-reader"]') ?? null;
  }

  function inTopReader(target: EventTarget | null): boolean {
    const r = topReader();
    return !!r && target instanceof Node && r.contains(target);
  }

  /** "pluginId:novelPath" of the novel a reader shows (its chapters were fetched through chapter.get). */
  function readerNovel(root: HTMLElement): string | null {
    for (const s of root.querySelectorAll<HTMLElement>('.rd-chapter[data-path]')) {
      const ref = s.dataset.path ? chapters.get(s.dataset.path) : undefined;
      if (ref) return `${ref.pluginId}:${ref.novelPath}`;
    }
    return null;
  }

  /** Let go of the narration (a finger moved the reader): it stays where the user put it, the pill shows. */
  function detach(): void {
    window.clearTimeout(switchTimer);
    pending = null;
    // Nothing is being narrated: nothing to let go of (the next listen follows from the start).
    if (!attached || !active()) return;
    attached = false;
    render();
  }

  interface FollowOptions {
    /** Follow even if detached (the pill, back in the app, a reader opened on the narration). */
    force?: boolean;
    /** Mark the paragraph briefly (a jump the user should notice). */
    flash?: boolean;
    /** The chapter isn't in the reader: open the reader on it. */
    allowSwitch?: boolean;
  }

  function follow(el: Element | null, chapterPath: string, opts: FollowOptions): void {
    const root = topReader();
    // Only the reader on screen scrolls; one covered by another screen catches up when it shows again.
    if (!el || !root || !root.contains(el) || document.visibilityState === 'hidden') return;
    const vh = window.innerHeight;
    if (opts.force) attached = true;
    else if (!attached && canReattach(el.getBoundingClientRect(), vh, lastUserScroll, Date.now())) attached = true;
    if (!attached) return render();
    followed = { reader: root, chapterPath };
    const mode = scrollModeFor(el.getBoundingClientRect(), vh);
    el.scrollIntoView({ block: 'center', behavior: mode === 'instant' ? 'auto' : 'smooth' });
    if (opts.flash) flashParagraph(el);
    render();
  }

  /** The spoken paragraph glows briefly, with v1's "you were here" bar in the margin (reader.css .rd-resume-mark). */
  function flashParagraph(el: Element): void {
    const p = el.closest('.rd-body > *') ?? el;
    p.classList.remove('tn-here', 'rd-resume-mark');
    void (p as HTMLElement).offsetWidth; // restart the animations
    p.classList.add('tn-here', 'rd-resume-mark');
    window.setTimeout(() => p.classList.remove('tn-here', 'rd-resume-mark'), 3200);
    // Narration isn't running any more (it ended or stopped while away): the sentence highlight goes with the mark.
    if (!active()) window.setTimeout(() => !active() && clearAll(), 3200);
  }

  function clearAll(): void {
    clearPaint();
    paragraphEl?.classList.remove('tn-speaking');
    paragraphEl = null;
  }

  /** A report as a target in the novel playing now. */
  function withNovel(p: NarrationProgress): FollowTarget | null {
    const ref = chapters.get(p.chapterPath);
    const pluginId = state.pluginId ?? ref?.pluginId;
    const novelPath = state.novelPath ?? ref?.novelPath;
    if (!pluginId || !novelPath) return null;
    return { ...p, pluginId, novelPath, ...(state.novelName ? { novelName: state.novelName } : {}) };
  }

  const isTarget = (p: NarrationProgress): p is FollowTarget => typeof (p as Partial<FollowTarget>).pluginId === 'string' && typeof (p as Partial<FollowTarget>).novelPath === 'string';

  /** The narrated chapter has no text in the reader on screen (narration-follow.ts missingChapterAction). */
  function onMissing(p: NarrationProgress, opts: FollowOptions): void {
    const root = topReader();
    // Paged mode has no chapter column (.rd-chapter): it isn't followed.
    if (!root || document.visibilityState === 'hidden' || !root.querySelector('.rd-chapter')) return;
    const t = isTarget(p) ? p : withNovel(p);
    if (!t || readerNovel(root) !== `${t.pluginId}:${t.novelPath}`) return;
    const action = missingChapterAction({
      sectionMounted: chapterSections(root).some((s) => s.dataset.path === t.chapterPath),
      forced: !!opts.allowSwitch,
      attached,
      followedMounted: !!followed && followed.reader === root && !!chapterBody(root, followed.chapterPath),
    });
    if (action === 'switch') return switchTo(t);
    if (action === 'detach') return detach();
    // Asked to go there and its text is still loading: go once it is in.
    if (action === 'wait' && opts.allowSwitch) pending = { target: t, until: Date.now() + 15_000 };
    if (action === 'switch-soon') {
      window.clearTimeout(switchTimer);
      switchTimer = window.setTimeout(() => {
        const r = topReader();
        if (!attached || r !== root || heard?.chapterPath !== t.chapterPath) return;
        if (chapterSections(r).some((s) => s.dataset.path === t.chapterPath)) return; // appended meanwhile
        switchTo(t, true);
      }, SWITCH_GRACE_MS);
    }
  }

  /**
   * Open the reader on the narrated chapter (it replaces the one on screen, like v1's own chapter jumps). A switch of our
   * own (`auto`, narration ran on) isn't repeated for a while: a chapter that doesn't open must not loop.
   */
  function switchTo(t: FollowTarget, auto = false): void {
    const now = Date.now();
    if (auto && lastSwitch && lastSwitch.chapterPath === t.chapterPath && now - lastSwitch.at < SWITCH_REPEAT_MS) return;
    lastSwitch = { chapterPath: t.chapterPath, at: now };
    pending = { target: t, until: now + 20_000 };
    followed = null;
    attached = true;
    replaceTop({ name: 'reader', pluginId: t.pluginId, novelPath: t.novelPath, chapterPath: t.chapterPath, ...(t.novelName ? { novelName: t.novelName } : {}) });
  }

  /** A reader opening on the narrated chapter: once its text is in (and v1 restored its position), go to the sentence. */
  function applyPending(): void {
    if (!pending) return;
    if (Date.now() > pending.until) {
      pending = null;
      return;
    }
    const root = topReader();
    const body = root ? chapterBody(root, pending.target.chapterPath) : null;
    if (!body || body.children.length === 0) return;
    const latest = heard && heard.chapterPath === pending.target.chapterPath ? withNovel(heard) : null;
    const t = latest ?? pending.target;
    pending = null;
    // After v1's restore (same frame as the body) and its first tick.
    requestAnimationFrame(() => requestAnimationFrame(() => void highlight(t, { force: true, flash: true })));
  }

  /** A reader came on screen: a new one (opened, switched to) or one uncovered again (back from Settings, …). */
  function onReaderShown(root: HTMLElement, lastSeen: number): void {
    const fresh = !seenReaders.has(root);
    seenReaders.add(root);
    if (fresh) {
      followed = null;
      attached = true;
    }
    if (pending) return; // our own switch: its jump comes with the text
    // A new reader goes to any narration in progress (paused too); one uncovered again only catches up with what was
    // narrated while it was covered, and only if it was following (a finger put it elsewhere: it stays there).
    const t = fresh ? (returnTarget(state, heard, lastSeen) ?? (active() ? targetFromState(state, heard) : null)) : attached ? returnTarget(state, heard, lastSeen) : null;
    if (!t) return;
    if (fresh) {
      // It opens where reading stopped (native saved the listening position): jump to the sentence once the text is in,
      // if it is that chapter (a reader opened on another chapter is left alone).
      pending = { target: t, until: Date.now() + 15_000 };
      return;
    }
    void highlight(t, { force: true, flash: true, allowSwitch: true });
  }

  /** Back in the app: native kept narrating (lock screen, CarPlay) while the WebView slept; catch up with it. */
  async function syncOnReturn(): Promise<void> {
    try {
      state = await Narration.state();
    } catch {
      // keep the last known state
    }
    returning = false;
    render();
    const t = returnTarget(state, heard, hiddenAt);
    if (!t) return;
    if (!active()) clearAll();
    void highlight(t, { force: true, flash: true, allowSwitch: true });
  }

  document.addEventListener('visibilitychange', () => {
    window.clearTimeout(returnTimer);
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      returning = false;
      return;
    }
    // Reports queued while asleep arrive first: let them land, then ask native where it is.
    returning = true;
    returnTimer = window.setTimeout(() => void syncOnReturn(), 350);
  });

  async function alignmentFor(p: NarrationProgress, body: HTMLElement): Promise<ChapterAlignment | null> {
    const cached = alignments.get(p.chapterPath);
    if (cached !== undefined && (cached === null || cached.body === body)) return cached;
    const ref = chapters.get(p.chapterPath) ?? (state.pluginId && state.novelPath ? { pluginId: state.pluginId, novelPath: state.novelPath, chapterPath: p.chapterPath } : null);
    if (!ref) return null;
    let req = timingRequests.get(p.chapterPath);
    if (!req) {
      req = Narration.audioTiming(ref).then((r) => r.json).catch(() => null);
      timingRequests.set(p.chapterPath, req);
    }
    const json = await req;
    const al = json ? alignChapter(p.chapterPath, body, json) : null;
    alignments.set(p.chapterPath, al);
    return al;
  }

  async function highlight(p: NarrationProgress, opts: FollowOptions = {}): Promise<void> {
    const root = topReader() ?? readerRoot();
    const body = root ? chapterBody(root, p.chapterPath) : null;
    if (!body) {
      clearAll();
      return onMissing(p, opts);
    }
    if (p.engine === 'audio' && p.segment !== undefined) {
      const al = await alignmentFor(p, body);
      if (al && al.mode !== 'none') {
        paragraphEl?.classList.remove('tn-speaking');
        paragraphEl = null;
        return follow(paintSegment(al, p.segment), p.chapterPath, opts);
      }
    }
    if (p.engine !== 'audio' && (p.block !== undefined || p.sentence !== undefined)) {
      let dom = speechScripts.get(p.chapterPath);
      if (!dom || dom.body !== body) {
        dom = domSpeechScript(body);
        speechScripts.set(p.chapterPath, dom);
      }
      let range = p.block !== undefined ? rangeForSentence(dom, p) : null;
      // Native's state has no canonical range (back in the app): the sentence by its number in the paragraph.
      if (!range && p.block === undefined && p.sentence !== undefined) {
        const it = nthInParagraph(dom.script.items, p.paragraph, p.sentence);
        const block = it ? dom.blocks[it.block] : undefined;
        range = it && block ? blockRange(block, it.start, it.end) : null;
      }
      if (range) {
        paragraphEl?.classList.remove('tn-speaking');
        paragraphEl = null;
        return follow(paintRange(range, body.children[p.paragraph] ?? null), p.chapterPath, opts);
      }
    }
    // No sentence position (or audio without usable timestamps): the paragraph.
    clearPaint();
    const el = body.children[p.paragraph] ?? null;
    if (el === paragraphEl && !opts.force) return;
    paragraphEl?.classList.remove('tn-speaking');
    paragraphEl = el;
    if (!el) return;
    el.classList.add('tn-speaking');
    follow(el, p.chapterPath, opts);
  }

  void Narration.addListener('state', (s) => {
    state = { ...state, ...s };
    if (!active()) {
      clearAll();
      // Letting go lasts one listen: the next one (Listen, CarPlay, the lock screen) is followed again.
      attached = true;
    }
    render();
  });
  void Narration.addListener('progress', (p) => {
    // Speech paragraphs are the reader's own; audio's are the manifest's blocks (highlight.ts re-aligns those).
    if (p.engine !== 'audio') lastSpoken = { chapterPath: p.chapterPath, paragraph: p.paragraph, ...(p.sentence !== undefined ? { sentence: p.sentence } : {}), at: Date.now() };
    heard = {
      ...p,
      ...(state.pluginId ? { pluginId: state.pluginId } : {}),
      ...(state.novelPath ? { novelPath: state.novelPath } : {}),
      ...(state.novelName ? { novelName: state.novelName } : {}),
      at: Date.now(),
    };
    // In the background (locked, CarPlay) nothing is painted: back in the app the reader jumps to where narration is.
    if (document.visibilityState === 'hidden' || returning) return;
    if (pending) return applyPending();
    void highlight(p);
  });
  void Narration.state()
    .then((s) => {
      state = s;
      render();
    })
    .catch(() => undefined);

  // The reader mounts/unmounts with navigation; a cheap periodic check keeps the buttons in sync.
  setInterval(render, 600);
  render();
}
