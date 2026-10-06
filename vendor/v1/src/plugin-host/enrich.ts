/**
 * Host-side enrichment of browse results for specific published plugins, which stay pinned and
 * unmodified. An enricher reads the HTML responses the plugin itself fetched during the call (kept by
 * the fetch shim only for calls that ask for them) and fills fields the plugin doesn't — never extra
 * requests. Anything it can't match is left alone.
 */
import type { NovelSummary } from '../shared/contracts/domain.ts';

export interface CapturedResponse {
  url: string;
  body: string;
}

export interface BrowseEnricher {
  /** Which responses of a popular/search call to keep. */
  capture: (url: string) => boolean;
  /** Fills fields on `items` in place from the captured responses. */
  enrich: (items: NovelSummary[], responses: readonly CapturedResponse[]) => void;
}

const RR_ITEM = /class="[^"]*\bfiction-list-item\b[^"]*"[\s\S]*?(?=class="[^"]*\bfiction-list-item\b|$)/g;
const RR_HREF = /href="\/fiction\/(\d+)\//;
const RR_CHAPTERS = /<span>\s*([\d,]+)\s+Chapters?\s*<\/span>/i;

/** Royal Road list pages show "N Chapters" per fiction; the plugin's novel paths are `fiction/<id>`. */
const royalroad: BrowseEnricher = {
  capture: (url) => /^https:\/\/www\.royalroad\.com\/fictions\//.test(url),
  enrich(items, responses) {
    const counts = new Map<string, number>();
    for (const { body } of responses) {
      for (const block of body.match(RR_ITEM) ?? []) {
        const id = RR_HREF.exec(block)?.[1];
        const n = RR_CHAPTERS.exec(block)?.[1];
        if (id && n) counts.set(`fiction/${id}`, parseInt(n.replace(/,/g, ''), 10));
      }
    }
    for (const item of items) {
      const n = counts.get(item.path);
      if (item.chapterCount === undefined && n !== undefined && Number.isFinite(n)) item.chapterCount = n;
    }
  },
};

export const BROWSE_ENRICHERS: Readonly<Record<string, BrowseEnricher>> = Object.freeze({ royalroad });
