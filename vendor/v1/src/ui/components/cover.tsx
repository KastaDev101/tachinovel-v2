/**
 * Fixed 2:3 cover box: placeholder underneath, lazy + async-decoded image fading in on load.
 * Remote covers that can't load directly (Cross-Origin-Resource-Policy) are fetched by the script
 * (`covers.fetch`) once the cover is near the viewport; see lib/cover-loader.ts.
 */
import type { RefObject, TargetedEvent } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { bridge } from '../bridge/client.ts';
import { createCoverLoader } from '../lib/cover-loader.ts';
import { Icon } from './icon.tsx';
import { ScrollContext } from './screen.tsx';

const loader = createCoverLoader(async (pluginId, url) => (await bridge().call('covers.fetch', { pluginId, url }, { timeoutMs: 30_000 })).src);

type Phase = 'direct' | 'proxy-wait' | 'proxy' | 'failed';

/**
 * One IntersectionObserver per scroll container (its root), so the 400 px look-ahead applies inside
 * the screen's own scroller (a viewport-rooted observer is clipped by it and fires only on screen).
 */
const observers = new Map<Element | null, { io: IntersectionObserver; callbacks: Map<Element, () => void> }>();

function whenNear(el: Element, root: Element | null, fn: () => void): () => void {
  let o = observers.get(root);
  if (!o) {
    const callbacks = new Map<Element, () => void>();
    const io = new IntersectionObserver(
      (items) => {
        for (const it of items) {
          if (!it.isIntersecting) continue;
          const cb = callbacks.get(it.target);
          callbacks.delete(it.target);
          io.unobserve(it.target);
          cb?.();
        }
      },
      { root, rootMargin: '400px 0px' },
    );
    o = { io, callbacks };
    observers.set(root, o);
  }
  const entry = o;
  entry.callbacks.set(el, fn);
  entry.io.observe(el);
  return () => {
    entry.callbacks.delete(el);
    entry.io.unobserve(el);
    if (entry.callbacks.size === 0) {
      entry.io.disconnect();
      if (observers.get(root) === entry) observers.delete(root);
    }
  };
}

interface CoverState {
  src: string | null;
  phase: Phase;
}

function initialState(url: string | undefined): CoverState {
  if (!url) return { src: null, phase: 'failed' };
  const init = loader.initial(url);
  if (init.failed) return { src: null, phase: 'failed' };
  return init.src !== null ? { src: init.src, phase: init.src === url ? 'direct' : 'proxy' } : { src: null, phase: 'proxy-wait' };
}

/** Resolved cover src for `url` (direct, or via covers.fetch once `box` is near the viewport). */
export function useCoverSrc(url: string | undefined, pluginId: string | undefined, box: RefObject<HTMLElement | null>): CoverState & { onError: () => void } {
  const [state, setState] = useState<CoverState>(() => initialState(url));
  const scroller = useContext(ScrollContext);

  const lastUrl = useRef(url);
  useEffect(() => {
    if (lastUrl.current === url) return;
    lastUrl.current = url;
    setState(initialState(url));
  }, [url]);

  useEffect(() => {
    if (state.phase !== 'proxy-wait' || !url) return;
    const el = box.current;
    if (!el || !pluginId) {
      setState({ src: null, phase: 'failed' });
      return;
    }
    let cancelled = false;
    const stop = whenNear(el, scroller?.current ?? null, () => {
      void loader.resolve(pluginId, url).then((src) => {
        if (!cancelled) setState(src ? { src, phase: 'proxy' } : { src: null, phase: 'failed' });
      });
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [state.phase, url, pluginId]);

  const onError = (): void => {
    if (state.phase === 'direct' && url && loader.canProxy(url) && pluginId) {
      loader.directFailed(url);
      setState({ src: null, phase: 'proxy-wait' });
    } else {
      setState({ src: null, phase: 'failed' });
    }
  };
  return { ...state, onError };
}

function onLoad(e: TargetedEvent<HTMLImageElement>): void {
  e.currentTarget.classList.add('is-loaded');
}

function checkDone(img: HTMLImageElement | null, onError: () => void): void {
  if (!img?.complete) return;
  // Already decoded (cache): show without the fade.
  if (img.naturalWidth > 0) img.classList.add('is-loaded', 'no-fade');
  // Some engines finish blocked loads without an error event.
  else if (img.currentSrc) onError();
}

export function Cover(props: { src?: string | undefined; pluginId?: string | undefined; title?: string; class?: string; eager?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const c = useCoverSrc(props.src, props.pluginId, box);
  return (
    <div class={`cover ${props.class ?? ''}`} ref={box} data-cover={c.phase}>
      <div class="cover-fallback" aria-hidden="true">
        <Icon name="book.closed" size={26} />
      </div>
      {c.src && (
        <img
          key={c.src}
          class="cover-img"
          src={c.src}
          alt={props.title ? `Cover of ${props.title}` : ''}
          loading={props.eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          ref={(img) => checkDone(img, c.onError)}
          onLoad={onLoad}
          onError={c.onError}
        />
      )}
    </div>
  );
}

/** Blurred cover behind a header (shares the cover loader, so no extra covers.fetch). */
export function CoverBackdrop(props: { src?: string | undefined; pluginId?: string | undefined; class?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const c = useCoverSrc(props.src, props.pluginId, box);
  return (
    <div class={props.class} ref={box} aria-hidden="true">
      {c.src && <img src={c.src} alt="" class="hero-bg-img" decoding="async" onError={c.onError} />}
    </div>
  );
}
