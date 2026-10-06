/**
 * The novel page's data, shared with the reader so opening a chapter and coming back costs one
 * novel.get (a 3,000-chapter list is a big bridge message on the phone). The reader applies its
 * progress here (read flags, partial progress, last-read position, bookmarks); the novel page shows
 * that on reveal instead of refetching.
 */
import type { ChapterPosition, ChapterView } from '../../shared/contracts/domain.ts';
import type { NovelPage } from '../../shared/contracts/protocol.ts';

const MAX_PAGES = 4;
const pages = new Map<string, NovelPage>();

export function novelKey(pluginId: string, path: string): string {
  return `${pluginId}:${path}`;
}

export function putNovelPage(key: string, page: NovelPage): void {
  pages.delete(key);
  pages.set(key, page);
  while (pages.size > MAX_PAGES) {
    const oldest = pages.keys().next().value;
    if (oldest === undefined) break;
    pages.delete(oldest);
  }
}

export function getNovelPage(key: string): NovelPage | undefined {
  return pages.get(key);
}

function patchChapters(key: string, fn: (c: ChapterView) => ChapterView, extra?: Partial<NovelPage>): void {
  const p = pages.get(key);
  if (!p) return;
  pages.set(key, { ...p, chapters: p.chapters.map(fn), ...extra });
}

/** A progress.save from the reader, mirrored locally. */
export function noteProgress(key: string, chapterPath: string, position: ChapterPosition, finished: boolean): void {
  patchChapters(
    key,
    (c) => {
      if (c.path !== chapterPath) return c;
      if (finished || c.read) {
        const { progress: _drop, ...rest } = c;
        return { ...rest, read: true };
      }
      return { ...c, progress: position.percent };
    },
    { lastRead: { chapterPath, position } },
  );
}

export function noteBookmark(key: string, chapterPath: string, bookmarked: boolean): void {
  patchChapters(key, (c) => (c.path === chapterPath ? { ...c, bookmarked } : c));
}
