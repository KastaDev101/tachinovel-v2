/**
 * Listening UI layered over the v1 UI (v1 itself is not modified):
 *
 * - Reader: a "Listen" button (headphones). Tap = listen from the first visible paragraph: the chapter's
 *   PC-narrated audio if the linked folder has it, else the system voice reading exactly the paragraphs
 *   the reader shows (so highlight indexes match v1's ChapterPosition.paragraph).
 * - While listening: a mini player on every screen (title, engine, play/pause, stop); tapping the title
 *   opens the car player (car-mode.ts).
 * - Highlighting: narrated audio → the spoken SENTENCE (timestamps re-aligned onto the reader's DOM,
 *   highlight.ts); system voice → the spoken paragraph. The view follows along unless the user
 *   scrolled in the last few seconds.
 * - More › Listen in the Car (v1 screen): an "Open player" button at the bottom.
 * pluginId/novelPath for a chapter come from observed bridge calls (chapter.get / progress.save).
 */
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { observeCalls } from '../capacitor-client.ts';
import { installCarMode } from './car-mode.ts';
import { alignChapter, clearPaint, HIGHLIGHT_CSS, paintSegment, type ChapterAlignment } from './highlight.ts';
import { Narration, type NarrationProgress, type NarrationState } from './narration.ts';
import { chapterBody, locateReadingPoint, paragraphsOf, readerRoot } from './reader-dom.ts';

interface ChapterRef {
  pluginId: string;
  novelPath: string;
  chapterPath: string;
}

const STYLE = `
.tn-listen{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:calc(env(safe-area-inset-bottom) + 132px);z-index:60;
  width:52px;height:52px;border-radius:26px;border:0;background:rgba(168,180,255,.94);color:#15151a;display:flex;align-items:center;justify-content:center;
  box-shadow:0 4px 16px rgba(0,0,0,.35);-webkit-tap-highlight-color:transparent;transition:transform .15s,opacity .2s}
.tn-listen:active{transform:scale(.92)}
.tn-listen[hidden],.tn-player[hidden],.tn-open-car[hidden]{display:none}
.tn-player{position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom) + 12px);z-index:61;display:flex;align-items:center;gap:10px;
  padding:8px 10px;border-radius:16px;background:rgba(40,40,48,.86);-webkit-backdrop-filter:blur(20px) saturate(1.6);color:#f2f2f7;
  font:500 14px -apple-system,system-ui;box-shadow:0 6px 24px rgba(0,0,0,.35)}
.tn-player .tn-title{flex:1;min-width:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit;padding:4px 2px}
.tn-player .tn-title b{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tn-player .tn-title small{display:block;color:#a1a1aa;font-size:12px}
.tn-player button.tn-ic{border:0;background:transparent;color:inherit;width:40px;height:40px;border-radius:20px;display:flex;align-items:center;justify-content:center;flex:none}
.tn-player button.tn-ic:active{background:rgba(255,255,255,.12)}
.tn-open-car{position:fixed;left:16px;right:16px;bottom:calc(env(safe-area-inset-bottom) + 16px);z-index:59;height:54px;border:0;border-radius:16px;
  background:#a8b4ff;color:#15151a;font:600 17px -apple-system,system-ui;box-shadow:0 6px 24px rgba(0,0,0,.35)}
.rd-body > .tn-speaking,.rd-body .tn-speaking{background:rgba(168,180,255,.16);border-radius:6px;box-shadow:0 0 0 4px rgba(168,180,255,.16)}
${HIGHLIGHT_CSS}
`;

const ICON_HEADPHONES =
  '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z"/><path d="M3 15a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z"/></svg>';
const ICON_PAUSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const ICON_PLAY = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg>';
const ICON_CLOSE =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function tapFeedback(): void {
  void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
}

export function installNarrationOverlay(): void {
  const chapters = new Map<string, ChapterRef>();
  let state: NarrationState = { status: 'idle' };
  let lastUserScroll = 0;
  let paragraphEl: Element | null = null;
  /** Timestamp alignment per chapter (re-made when the reader re-renders the chapter body). */
  const alignments = new Map<string, ChapterAlignment | null>();
  const timingRequests = new Map<string, Promise<string | null>>();
  const car = installCarMode();

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

  const listen = document.createElement('button');
  listen.className = 'tn-listen';
  listen.type = 'button';
  listen.setAttribute('aria-label', 'Listen from here');
  listen.dataset.testid = 'listen-button';
  listen.innerHTML = ICON_HEADPHONES;
  listen.hidden = true;

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

  document.body.append(listen, player, openCar);
  const toggle = player.querySelector<HTMLButtonElement>('.tn-toggle') as HTMLButtonElement;
  const titleBtn = player.querySelector<HTMLButtonElement>('.tn-title') as HTMLButtonElement;
  const stop = player.querySelector<HTMLButtonElement>('.tn-stop') as HTMLButtonElement;

  const active = (): boolean => state.status === 'playing' || state.status === 'paused' || state.status === 'loading';

  function render(): void {
    const inReader = readerRoot() !== null;
    const onNarrationScreen = document.querySelector('[data-testid="screen-narration"]') !== null && !readerRoot();
    listen.hidden = !inReader || active() || car.isOpen;
    player.hidden = !active() || car.isOpen;
    openCar.hidden = !onNarrationScreen || active() || car.isOpen;
    toggle.innerHTML = state.status === 'paused' ? ICON_PLAY : ICON_PAUSE;
    toggle.setAttribute('aria-label', state.status === 'paused' ? 'Play' : 'Pause');
    (titleBtn.querySelector('b') as HTMLElement).textContent = state.chapterName ?? '';
    (titleBtn.querySelector('small') as HTMLElement).textContent =
      state.status === 'loading' ? 'Loading…' : state.engine === 'audio' ? 'Narrated audio' : state.status === 'error' ? (state.error ?? 'Error') : 'System voice';
  }

  listen.addEventListener('click', () => {
    const root = readerRoot();
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
    void Narration.play({
      pluginId: ref.pluginId,
      novelPath: ref.novelPath,
      chapterPath: ref.chapterPath,
      novelName,
      chapterName,
      paragraphs: paragraphsOf(body),
      start: { paragraph: point.paragraph },
      autoContinue: true,
    });
  });
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
    // System voice (or audio without usable timestamps): the paragraph.
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
