/**
 * Listening UI layered over the v1 UI (v1 itself is not modified):
 *
 * - Reader: "Listen" in the reader's bottom bar (next to Chapters / Auto-scroll / Night / Appearance, same
 *   style), so it shows and hides with the bars. Tap = listen from the first visible paragraph with the
 *   novel's voice: Kokoro on device (bundled), the system voice standing in sentence by sentence when Kokoro
 *   can't keep up. While listening it becomes "Player" (opens the Listen player). The sentence script is built from exactly what the reader shows (speech-dom.ts, the v1
 *   narration front-end + the pronunciation lexicon). PC-narrated audio only with Settings › Voices ›
 *   Advanced › "Use PC audio when available".
 * - While listening: a mini player on every screen (title, voice, play/pause, stop); tapping the title
 *   opens the Listen player (car-mode.ts). In the reader it follows the bars: hidden while reading with the
 *   bars hidden.
 * - Highlighting: the spoken SENTENCE for every source (speech: from the script's canonical ranges;
 *   narrated audio: timestamps re-aligned onto the reader's DOM, highlight.ts). The view follows along
 *   unless the user scrolled in the last few seconds.
 * - More › Listen in the Car (v1 screen): an "Open player" button at the bottom.
 * pluginId/novelPath for a chapter come from observed bridge calls (chapter.get / progress.save).
 */
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { fallbackIconUrl } from '@v1/ui/components/icons.ts';
import { symbols } from '@v1/ui/state/store.ts';
import type { Lexicon } from '@v1tts/frontend.ts';
import { callCore, observeCalls } from '../capacitor-client.ts';
import { installCarMode } from './car-mode.ts';
import { alignChapter, clearPaint, HIGHLIGHT_CSS, paintRange, paintSegment, type ChapterAlignment } from './highlight.ts';
import { Narration, type NarrationProgress, type NarrationState } from './narration.ts';
import { chapterBody, locateReadingPoint, paragraphsOf, readerRoot } from './reader-dom.ts';
import { domSpeechScript, rangeForSentence, type DomScript } from './speech-dom.ts';
import { voiceLabel } from './voices-ui.ts';

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
  font:500 14px -apple-system,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35)}
.tn-player .tn-title{flex:1;min-width:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit;padding:4px 2px}
.tn-player .tn-title b{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tn-player .tn-title small{display:block;color:#a1a1aa;font-size:12px}
.tn-player button.tn-ic{border:0;background:transparent;color:inherit;width:40px;height:40px;border-radius:20px;display:flex;align-items:center;justify-content:center;flex:none}
.tn-player button.tn-ic:active{background:rgba(255,255,255,.12)}
.tn-open-car{position:fixed;left:16px;right:16px;bottom:calc(env(safe-area-inset-bottom) + 16px);z-index:59;height:54px;border:0;border-radius:16px;
  background:#a8b4ff;color:#15151a;font:600 17px -apple-system,system-ui,sans-serif;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.35)}
/* Room at the end of the scrolling content for the floating player / button, so nothing stays under them. */
html.tn-player-on .screen-scroll>.scroll-content::after,html.tn-player-on .reader-content::after,
html.tn-open-car-on [data-testid="screen-narration"] .screen-scroll>.scroll-content::after{content:"";display:block;height:72px}
.rd-body > .tn-speaking,.rd-body .tn-speaking{background:rgba(168,180,255,.16);border-radius:6px;box-shadow:0 0 0 4px rgba(168,180,255,.16)}
${HIGHLIGHT_CSS}
`;

const ICON_PAUSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const ICON_PLAY = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg>';
const ICON_CLOSE =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

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

let openPlayer: (() => void) | null = null;

/** Open the Listen player (More › Listen, the mini player). */
export function openListenPlayer(): void {
  openPlayer?.();
}

export function installNarrationOverlay(): void {
  const chapters = new Map<string, ChapterRef>();
  let state: NarrationState = { status: 'idle' };
  let lastUserScroll = 0;
  let paragraphEl: Element | null = null;
  /** Timestamp alignment per chapter (re-made when the reader re-renders the chapter body). */
  const alignments = new Map<string, ChapterAlignment | null>();
  const timingRequests = new Map<string, Promise<string | null>>();
  /** Speech: the reader's own script per chapter (re-made when the reader re-renders the body). */
  const speechScripts = new Map<string, DomScript>();
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
  player.innerHTML = `<button type="button" class="tn-ic tn-toggle" aria-label="Pause">${ICON_PAUSE}</button><button type="button" class="tn-title" aria-label="Open the player"><b></b><small></small></button><button type="button" class="tn-ic tn-stop" aria-label="Stop">${ICON_CLOSE}</button>`;

  const openCar = document.createElement('button');
  openCar.className = 'tn-open-car';
  openCar.type = 'button';
  openCar.textContent = 'Open the player';
  openCar.hidden = true;
  openCar.dataset.testid = 'open-car-player';

  document.body.append(player, openCar);
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
    const root = topLayer()?.querySelector<HTMLElement>('[data-testid="screen-reader"]') ?? null;
    if (!root) return;
    // From the first visible paragraph (the reader hides its bars while reading).
    const point = locateReadingPoint(root, 8, window.innerHeight);
    if (!point) return;
    const ref = chapters.get(point.chapterPath);
    const body = chapterBody(root, point.chapterPath);
    if (!ref || !body) return;
    tapFeedback();
    const novelName = root.querySelector('.rd-top-novel')?.textContent ?? '';
    const chapterName = root.querySelector('.rd-top-chapter')?.textContent ?? point.chapterPath;
    void (async () => {
      // The novel's pronunciation lexicon (global + its own), then the script from the reader's DOM.
      const l = await callCore<{ global?: Lexicon; novel?: Lexicon | null }>('narration.lexicon.get', { novelKey: `${ref.pluginId}:${ref.novelPath}` }).catch(() => null);
      const lexicons = [l?.global, l?.novel].filter((x): x is Lexicon => !!x);
      let script: DomScript | null = null;
      try {
        script = domSpeechScript(body, { title: chapterName, lexicons });
        speechScripts.set(ref.chapterPath, script);
      } catch (err) {
        console.warn('speech script failed; native splits the paragraphs', err);
      }
      await Narration.play({
        pluginId: ref.pluginId,
        novelPath: ref.novelPath,
        chapterPath: ref.chapterPath,
        novelName,
        chapterName,
        paragraphs: paragraphsOf(body),
        ...(script && script.script.items.length > 0 ? { script: script.script } : {}),
        start: { paragraph: point.paragraph },
        autoContinue: true,
      });
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

  document.addEventListener('touchmove', () => (lastUserScroll = Date.now()), { passive: true, capture: true });

  function follow(el: Element | null): void {
    if (el && Date.now() - lastUserScroll > 4000) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function clearAll(): void {
    clearPaint();
    paragraphEl?.classList.remove('tn-speaking');
    paragraphEl = null;
  }

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

  async function highlight(p: NarrationProgress): Promise<void> {
    const root = readerRoot();
    const body = root ? chapterBody(root, p.chapterPath) : null;
    if (!body) return clearAll();
    if (p.engine === 'audio' && p.segment !== undefined) {
      const al = await alignmentFor(p, body);
      if (al && al.mode !== 'none') {
        paragraphEl?.classList.remove('tn-speaking');
        paragraphEl = null;
        return follow(paintSegment(al, p.segment));
      }
    }
    if (p.engine === 'speech' && p.block !== undefined) {
      let dom = speechScripts.get(p.chapterPath);
      if (!dom || dom.body !== body) {
        dom = domSpeechScript(body);
        speechScripts.set(p.chapterPath, dom);
      }
      const range = rangeForSentence(dom, p);
      if (range) {
        paragraphEl?.classList.remove('tn-speaking');
        paragraphEl = null;
        return follow(paintRange(range, body.children[p.paragraph] ?? null));
      }
    }
    // No sentence position (or audio without usable timestamps): the paragraph.
    clearPaint();
    const el = body.children[p.paragraph] ?? null;
    if (el === paragraphEl) return;
    paragraphEl?.classList.remove('tn-speaking');
    paragraphEl = el;
    if (!el) return;
    el.classList.add('tn-speaking');
    follow(el);
  }

  void Narration.addListener('state', (s) => {
    state = { ...state, ...s };
    if (!active()) clearAll();
    render();
  });
  void Narration.addListener('progress', (p) => void highlight(p));
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
