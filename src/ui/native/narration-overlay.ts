/**
 * "Listen" overlay for the v1 reader (scaffold until the reader gets a first-class control).
 *
 * - A floating headphones button while the reader is on screen; a mini player while narrating.
 * - Paragraphs are taken from the reader's DOM, so the native engine reads exactly what is shown and
 *   highlight indexes line up with v1's ChapterPosition.paragraph.
 * - pluginId/novelPath for a chapter come from observed bridge calls (chapter.get / progress.save);
 *   the v1 UI is not modified.
 * - Progress events highlight the spoken paragraph (class tn-speaking) and keep it in view unless the
 *   user scrolled away in the last few seconds.
 */
import { observeCalls } from '../capacitor-client.ts';
import { Narration, type NarrationProgress, type NarrationState } from './narration.ts';
import { chapterBody, locateReadingPoint, paragraphsOf, readerRoot } from './reader-dom.ts';

interface ChapterRef {
  pluginId: string;
  novelPath: string;
  chapterPath: string;
  name?: string;
}

const STYLE = `
.tn-listen{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:calc(env(safe-area-inset-bottom) + 132px);z-index:60;
  width:48px;height:48px;border-radius:24px;border:0;background:rgba(168,180,255,.92);color:#15151a;display:flex;align-items:center;justify-content:center;
  box-shadow:0 4px 16px rgba(0,0,0,.35);-webkit-tap-highlight-color:transparent;transition:transform .15s,opacity .2s}
.tn-listen:active{transform:scale(.92)}
.tn-listen[hidden],.tn-player[hidden]{display:none}
.tn-player{position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom) + 12px);z-index:61;display:flex;align-items:center;gap:12px;
  padding:10px 12px;border-radius:16px;background:rgba(40,40,48,.82);-webkit-backdrop-filter:blur(20px) saturate(1.6);color:#f2f2f7;
  font:500 14px -apple-system,system-ui;box-shadow:0 6px 24px rgba(0,0,0,.35)}
.tn-player .tn-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tn-player button{border:0;background:transparent;color:inherit;width:36px;height:36px;border-radius:18px;display:flex;align-items:center;justify-content:center}
.tn-player button:active{background:rgba(255,255,255,.12)}
.rd-body > .tn-speaking{background:rgba(168,180,255,.18);border-radius:6px;box-shadow:0 0 0 4px rgba(168,180,255,.18)}
`;

const ICON_HEADPHONES =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z"/><path d="M3 15a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z"/></svg>';
const ICON_PAUSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const ICON_PLAY = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg>';
const ICON_CLOSE =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

export function installNarrationOverlay(): void {
  const chapters = new Map<string, ChapterRef>();
  let novelName = '';
  let state: NarrationState = { status: 'idle' };
  let lastUserScroll = 0;
  let highlighted: Element | null = null;

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
  listen.innerHTML = ICON_HEADPHONES;
  listen.hidden = true;

  const player = document.createElement('div');
  player.className = 'tn-player';
  player.hidden = true;
  player.innerHTML = `<button type="button" class="tn-toggle" aria-label="Pause">${ICON_PAUSE}</button><span class="tn-title"></span><button type="button" class="tn-stop" aria-label="Stop">${ICON_CLOSE}</button>`;
  document.body.append(listen, player);
  const toggle = player.querySelector<HTMLButtonElement>('.tn-toggle') as HTMLButtonElement;
  const title = player.querySelector<HTMLElement>('.tn-title') as HTMLElement;
  const stop = player.querySelector<HTMLButtonElement>('.tn-stop') as HTMLButtonElement;

  const active = (): boolean => state.status === 'playing' || state.status === 'paused' || state.status === 'loading';

  function render(): void {
    const inReader = readerRoot() !== null;
    listen.hidden = !inReader || active();
    player.hidden = !active();
    toggle.innerHTML = state.status === 'paused' ? ICON_PLAY : ICON_PAUSE;
    toggle.setAttribute('aria-label', state.status === 'paused' ? 'Play' : 'Pause');
    title.textContent = state.chapterName ?? novelName;
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
    novelName = root.querySelector('.rd-top-novel')?.textContent ?? '';
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
  toggle.addEventListener('click', () => void (state.status === 'paused' ? Narration.resume() : Narration.pause()));
  stop.addEventListener('click', () => void Narration.stop());

  document.addEventListener('touchmove', () => (lastUserScroll = Date.now()), { passive: true, capture: true });

  function highlight(p: NarrationProgress): void {
    const root = readerRoot();
    const body = root ? chapterBody(root, p.chapterPath) : null;
    const el = body?.children[p.paragraph] ?? null;
    if (el === highlighted) return;
    highlighted?.classList.remove('tn-speaking');
    highlighted = el;
    if (!el) return;
    el.classList.add('tn-speaking');
    if (Date.now() - lastUserScroll > 4000) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  void Narration.addListener('state', (s) => {
    state = s;
    if (!active()) {
      highlighted?.classList.remove('tn-speaking');
      highlighted = null;
    }
    render();
  });
  void Narration.addListener('progress', highlight);
  void Narration.state()
    .then((s) => {
      state = s;
      render();
    })
    .catch(() => undefined);

  // The reader mounts/unmounts with navigation; a cheap periodic check keeps the button in sync.
  setInterval(render, 600);
  render();
}
