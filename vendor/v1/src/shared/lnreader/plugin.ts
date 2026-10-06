/**
 * Vendored from LNReader/lnreader-plugins `src/types/plugin.ts` (MIT License,
 * Copyright (c) 2021 Rajarshee Chatterjee). Modified: import paths, and the
 * TachiNovel extension `locked` on ChapterItem (see below).
 */
import type { FilterToValues, Filters } from './filters.ts';

export namespace Plugin {
  export type ChapterItem = {
    name: string;
    path: string;
    /** "YYYY-MM-DD" or ISO string, or just a display string. */
    releaseTime?: string | null;
    chapterNumber?: number;
    /** For novels without pages only. */
    page?: string;
    scanlator?: string | string[];
    /**
     * TachiNovel extension (not in upstream LNReader): the chapter exists but is
     * paywalled/coin-locked. The app shows it as locked and never fetches it.
     */
    locked?: boolean;
  };
  export type NovelItem = {
    name: string;
    path: string;
    cover?: string;
    /** TachiNovel extension (not in upstream LNReader): total chapters, when the listing knows it. */
    chapterCount?: number;
  };
  export type SourceNovel = {
    /** Comma separated genre list -> "action,fantasy,romance" */
    genres?: string;
    summary?: string;
    author?: string;
    artist?: string;
    status?: string;
    /** Rating out of 5 as float */
    rating?: number;
    chapters?: ChapterItem[];
  } & NovelItem;

  export type SourcePage = {
    chapters: ChapterItem[];
  };

  export type PopularNovelsOptions<Q extends Filters | undefined = Filters | undefined> = {
    showLatestNovels?: boolean;
    filters: Q extends undefined ? undefined : FilterToValues<Q>;
  };
  export type PluginItem = {
    id: string;
    name: string;
    version: string;
    icon: string;
    site: string;
  };
  export type ImageRequestInit = {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };

  export type PluginBase = {
    id: string;
    name: string;
    /** Relative path without static, e.g. "src/vi/hakolightnovel/icon.png" */
    icon: string;
    /** Ignored by TachiNovel (security: never injected into the UI). */
    customJS?: string;
    /** Applied to reader content only after sanitizing. */
    customCSS?: string;
    site: string;
    imageRequestInit?: ImageRequestInit;
    filters?: Filters;
    version: string;
    /** Whether access to LocalStorage/SessionStorage is required. */
    webStorageUtilized?: boolean;
    popularNovels(pageNo: number, options: PopularNovelsOptions<Filters>): Promise<NovelItem[]>;
    /** Novel metadata and its first page. */
    parseNovel(novelPath: string): Promise<SourceNovel>;
    parseChapter(chapterPath: string): Promise<string>;
    searchNovels(searchTerm: string, pageNo: number): Promise<NovelItem[]>;
    resolveUrl?(path: string, isNovel?: boolean): string;
  };

  export type PagePlugin = {
    parseNovel(novelPath: string): Promise<SourceNovel & { totalPages: number }>;
    parsePage(novelPath: string, page: string): Promise<SourcePage>;
  } & PluginBase;
}
