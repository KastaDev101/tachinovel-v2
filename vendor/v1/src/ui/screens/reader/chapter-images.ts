/**
 * Illustrations in chapter text. A direct load is tried first (lazy, near the viewport); when the
 * site blocks it (Stonescape sends Cross-Origin-Resource-Policy, like for covers) the script fetches
 * it (`images.fetch`) and the <img> gets the local copy. Hosts that block are remembered, so their
 * later images skip the doomed direct load and are fetched once near the screen; at most three
 * fetches run at once. No broken-image icon ever shows: images stay invisible until loaded (their
 * space is kept when width/height are known) and collapse if they can't be had.
 */
import { bridge } from '../../bridge/client.ts';
import { createCoverLoader } from '../../lib/cover-loader.ts';

const loader = createCoverLoader(async (pluginId, url) => (await bridge().call('images.fetch', { pluginId, url }, { timeoutMs: 45_000 })).src, { maxInFlight: 3 });

/** Wires every <img> in a freshly inserted chapter body. Returns a cleanup for when it unmounts. */
export function wireChapterImages(body: HTMLElement, pluginId: string, opts: { root: Element | null; margin: string }): () => void {
  const imgs = Array.from(body.querySelectorAll('img'));
  if (imgs.length === 0) return () => undefined;
  let alive = true;
  let io: IntersectionObserver | null = null;
  const waiting = new Map<Element, string>();

  const shown = (img: HTMLImageElement): void => {
    img.classList.remove('is-pending');
  };
  const gone = (img: HTMLImageElement): void => {
    img.onerror = null;
    img.removeAttribute('src');
    img.classList.remove('is-pending');
    img.classList.add('is-gone');
  };
  const viaScript = (img: HTMLImageElement, url: string): void => {
    void loader.resolve(pluginId, url).then((src) => {
      if (!alive) return;
      if (!src) {
        gone(img);
        return;
      }
      img.onerror = () => gone(img);
      img.src = src;
    });
  };
  const whenNear = (img: HTMLImageElement, url: string): void => {
    img.removeAttribute('src'); // no doomed direct request
    waiting.set(img, url);
    io ??= new IntersectionObserver(
      (items) => {
        for (const it of items) {
          if (!it.isIntersecting) continue;
          const u = waiting.get(it.target);
          if (u === undefined) continue;
          waiting.delete(it.target);
          io?.unobserve(it.target);
          viaScript(it.target as HTMLImageElement, u);
        }
      },
      { root: opts.root, rootMargin: opts.margin },
    );
    io.observe(img);
  };

  for (const img of imgs) {
    const url = img.getAttribute('src');
    if (!url) continue;
    img.classList.add('is-pending');
    img.onload = () => shown(img);
    const first = loader.initial(url);
    if (first.failed) {
      gone(img);
      continue;
    }
    if (first.src === null) {
      whenNear(img, url);
      continue;
    }
    if (first.src !== url) {
      img.src = first.src; // fetched earlier this session
      continue;
    }
    const onDirectError = (): void => {
      if (!loader.canProxy(url)) {
        gone(img);
        return;
      }
      loader.directFailed(url);
      img.onerror = null;
      img.removeAttribute('src');
      viaScript(img, url); // a lazy image only loads near the screen, so fetch right away
    };
    img.onerror = onDirectError;
    if (img.complete) {
      if (img.naturalWidth > 0) shown(img);
      else if (img.currentSrc) onDirectError();
    }
  }

  return () => {
    alive = false;
    io?.disconnect();
  };
}
