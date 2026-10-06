/**
 * "What's New" entries, newest first. To announce a release, add one at the top with a new `id`: the
 * sheet shows once after the next build to anyone who hasn't seen that id. Icons are SF Symbol names
 * from components/icons.ts; colors are CSS color tokens.
 */

export interface WhatsNewItem {
  icon: string;
  color: string;
  title: string;
  detail: string;
}

export interface WhatsNewRelease {
  id: string;
  title: string;
  items: WhatsNewItem[];
}

export const WHATS_NEW: readonly WhatsNewRelease[] = [
  {
    id: '2026-10-06',
    title: 'October 2026',
    items: [
      {
        icon: 'hourglass',
        color: 'var(--indigo)',
        title: 'Reading Insights',
        detail: 'Your reading time, streaks and most-read novels, plus an optional daily goal. Find it in More.',
      },
      {
        icon: 'arrow.triangle.2.circlepath',
        color: 'var(--teal)',
        title: 'Migrate',
        detail: 'Move a novel, or a whole source, to another site. Read marks, bookmarks and your place come along.',
      },
      {
        icon: 'xmark.bin',
        color: 'var(--red)',
        title: 'Text cleanup',
        detail: 'Hide “Read at …” notices, translator credits and Patreon plugs. Settings › Reader › Text cleanup.',
      },
      {
        icon: 'magnifyingglass',
        color: 'var(--blue)',
        title: 'Genres and smarter search',
        detail: 'Tap a genre to search every source for it. Recent searches are one tap away.',
      },
      {
        icon: 'doc.text',
        color: 'var(--orange)',
        title: 'Reader extras',
        detail: 'Auto-scroll at your own speed, and find words in a chapter.',
      },
      {
        icon: 'arrow.down.to.line',
        color: 'var(--green)',
        title: 'Offline and backups',
        detail: 'Optionally keep the next chapters of what you’re reading downloaded, and back up once a day.',
      },
      {
        icon: 'safari',
        color: 'var(--purple)',
        title: 'Fewer dead ends',
        detail: 'When a site asks whether you’re a person, “Open site to verify” gets you back in.',
      },
    ],
  },
];
