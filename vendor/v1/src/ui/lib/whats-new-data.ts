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
    id: '2026-10-06-later',
    title: 'Later on October 6',
    items: [
      {
        icon: 'checkmark.circle',
        color: 'var(--green)',
        title: 'No more stuck launches',
        detail: 'Tapping Close while the app is still starting closes it right away. If iCloud is slow, the app opens anyway.',
      },
      {
        icon: 'exclamationmark.triangle',
        color: 'var(--orange)',
        title: 'When iCloud is unavailable',
        detail: 'You get your library from this iPhone and a short note saying so. It catches up with iCloud by itself.',
      },
      {
        icon: 'hourglass',
        color: 'var(--indigo)',
        title: 'Your Year',
        detail: 'Reading Insights shows a calendar of the last 12 months (tap a day for its reading) and your longest reading session.',
      },
      {
        icon: 'xmark.bin',
        color: 'var(--red)',
        title: 'Cleanup suggestions',
        detail: 'Text Cleanup suggests rules for your own sources, like hiding “Read at stonescape.xyz”. Try one on chapters you’ve read before turning it on.',
      },
      {
        icon: 'internaldrive',
        color: 'var(--blue)',
        title: 'Free up space',
        detail: 'Settings › Storage shows downloads of novels that aren’t in your library, and deletes them in one tap.',
      },
      {
        icon: 'bolt.fill',
        color: 'var(--yellow)',
        title: 'Sources start faster',
        detail: 'The part that runs sources is about a third smaller, so the first search or page opens sooner.',
      },
      {
        icon: 'doc.text',
        color: 'var(--teal)',
        title: 'Report a problem',
        detail: 'More › About › Diagnostics › Send a Problem Report: a short note with your versions and the latest errors.',
      },
    ],
  },
  {
    id: '2026-10-06-overnight',
    title: 'Overnight update · October 6',
    items: [
      {
        icon: 'headphones',
        color: 'var(--indigo)',
        title: 'Listen in the car',
        detail: 'Your PC narrates the next chapters of the novels you pick. The audio lands in Files › TachiNovel Audio, ready for BookPlayer and CarPlay. Turn it on from a novel’s page.',
      },
      {
        icon: 'star.fill',
        color: 'var(--orange)',
        title: 'For You',
        detail: 'Browse › For You suggests novels like the ones you’ve been reading, from all your sources.',
      },
      {
        icon: 'book',
        color: 'var(--teal)',
        title: 'Smarter reader',
        detail: 'See how many minutes are left in a chapter, at your own pace. Jumped somewhere? “Back to …” takes you back. Caught up? New chapters are checked so you can read straight on.',
      },
      {
        icon: 'list.bullet',
        color: 'var(--blue)',
        title: 'Volumes and pictures',
        detail: 'Chapter lists show “Book One”-style volume headers, and illustrations load even from sites that used to block them.',
      },
      {
        icon: 'bell.fill',
        color: 'var(--red)',
        title: 'Faster Updates and History',
        detail: 'Long lists open right away. Mark a whole day read or download it in one tap, and History keeps loading as you scroll.',
      },
      {
        icon: 'slider.horizontal.3',
        color: 'var(--purple)',
        title: 'Source settings',
        detail: 'Sources with options now have a Settings screen: tap the gear next to a source in Browse.',
      },
      {
        icon: 'square.and.arrow.up',
        color: 'var(--green)',
        title: 'Share your reading week',
        detail: 'Reading Insights can share a picture of your week, and nothing gets lost if the app closes while saving.',
      },
    ],
  },
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
