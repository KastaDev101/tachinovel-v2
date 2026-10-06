/**
 * Help & Tips content (More › Help & Tips): short questions and answers in plain words, grouped by
 * topic, some with a button that opens the right screen. Edit freely; ids must stay unique.
 */
import type { Route, TabName } from '../state/nav.ts';

export type HelpAction = { label: string; route: Route } | { label: string; tab: TabName };

export interface HelpItem {
  id: string;
  q: string;
  a: string;
  action?: HelpAction;
}

export interface HelpTopic {
  title: string;
  items: HelpItem[];
}

export const HELP: readonly HelpTopic[] = [
  {
    title: 'Getting Started',
    items: [
      {
        id: 'find',
        q: 'How do I find novels?',
        a: 'Open Browse and pick a source, or tap the magnifying glass to search every source at once. On a novel’s page, tap a genre to find more like it.',
        action: { label: 'Open Browse', tab: 'browse' },
      },
      {
        id: 'add',
        q: 'How do I add a novel to my library?',
        a: 'Open the novel and tap Add to Library, or touch and hold its cover in Browse. New chapters of library novels show up in Updates.',
      },
      {
        id: 'sources',
        q: 'How do I add more sources?',
        a: 'Go to More › Extensions and tap Get next to a source. The + button adds a plugin link or a whole repository. Only add plugins you trust: they run inside the app.',
        action: { label: 'Open Extensions', route: { name: 'settings', page: 'sources' } },
      },
    ],
  },
  {
    title: 'Reading',
    items: [
      {
        id: 'controls',
        q: 'Where are the reader controls?',
        a: 'Tap the middle of the page for the chapter list, auto-scroll, night mode and Appearance (fonts, size, spacing and themes). Tap near the left or right edge to turn the page, and double-tap to see the time, battery and how far you are.',
      },
      {
        id: 'offline',
        q: 'Can I read offline?',
        a: 'Chapters normally stream as you read. To keep some on the phone, download them from a novel’s page, or turn on Auto-download in More › Downloads to keep the next few chapters ready.',
        action: { label: 'Open Downloads', route: { name: 'settings', page: 'downloads' } },
      },
      {
        id: 'junk',
        q: 'How do I hide “Read at …” lines and other junk?',
        a: 'Add a rule in More › Reader › Text cleanup. Start from a suggestion and try it on a chapter you’ve read before you save it.',
        action: { label: 'Open Text Cleanup', route: { name: 'settings', page: 'cleanup' } },
      },
      {
        id: 'insights',
        q: 'How do I keep track of my reading?',
        a: 'More › Reading Insights shows your reading time, streak and most-read novels. Set a daily goal there to fill a ring each day.',
        action: { label: 'Open Reading Insights', route: { name: 'stats' } },
      },
    ],
  },
  {
    title: 'When Something’s Wrong',
    items: [
      {
        id: 'verify',
        q: 'A source says “Verification Needed”',
        a: 'The site wants to check that you’re a person. Tap Open site to verify, pass the check, and TachiNovel tries again on its own.',
      },
      {
        id: 'moved',
        q: 'A source stopped working. Can I keep my progress?',
        a: 'Use More › Migrate to move the novel, or every novel from that source, to another one. Read marks, bookmarks, your place, categories and history come along.',
        action: { label: 'Open Migrate', route: { name: 'migrate' } },
      },
      {
        id: 'report',
        q: 'How do I report a problem?',
        a: 'Open More › About › Diagnostics and tap Copy Diagnostics, then paste it into your message. It lists versions, storage, sources and recent errors, not your library.',
        action: { label: 'Open Diagnostics', route: { name: 'diagnostics' } },
      },
    ],
  },
  {
    title: 'Your Data',
    items: [
      {
        id: 'backup',
        q: 'Is my library backed up?',
        a: 'Your library, progress and settings live in iCloud Drive › Scriptable › TachiNovel. Backups, including the optional daily one, are in its backups folder; restore one from More › Backup & Restore.',
        action: { label: 'Open Backup & Restore', route: { name: 'settings', page: 'backup' } },
      },
      {
        id: 'space',
        q: 'How much space does TachiNovel use?',
        a: 'Without downloads it stays small, and its caches clean themselves up. See and clear each part in More › Storage.',
        action: { label: 'Open Storage', route: { name: 'settings', page: 'storage' } },
      },
    ],
  },
];

function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[“”"’']/g, '');
}

/** Topics with only the items whose question or answer contains every word of `query`. */
export function searchHelp(topics: readonly HelpTopic[], query: string): HelpTopic[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return topics.map((t) => ({ ...t, items: [...t.items] }));
  return topics
    .map((t) => ({ ...t, items: t.items.filter((it) => words.every((w) => norm(`${it.q} ${it.a}`).includes(w))) }))
    .filter((t) => t.items.length > 0);
}
