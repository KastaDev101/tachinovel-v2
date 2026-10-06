/**
 * v2 wording for v1's UI (build-time patches, both flavors; see tools/v1.ts for the mechanism).
 *
 * v1's copy describes Scriptable: data in "iCloud Drive › Scriptable › TachiNovel", "running in
 * Scriptable", the PC narrator's audio going to BookPlayer, and v1's own release notes. v2's copy never
 * mentions Scriptable, iCloud paths or BookPlayer. Where the text depends on where v2 keeps data, the
 * platform supplies it at runtime: src/ui/native/v2-text.ts sets `globalThis.__TN_TEXT__` (from the
 * core's `v2.storage`) before v1's UI runs, and the patched strings read it when they render.
 * "What's New" lists v2's releases (`globalThis.__TN_WHATS_NEW__`), not v1's.
 *
 * Each patch must match exactly once, so a v1 change to these lines fails the build instead of quietly
 * bringing the old copy back. Requested upstream: let the platform supply these texts (docs/parity.md).
 */
import type { Patch } from './v1.ts';

/** A RegExp that matches `s` literally. */
function literal(s: string): RegExp {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** `$` is special in String.replace replacements; v2's text is data. */
function text(s: string): string {
  return s.replaceAll('$', '$$$$');
}

const SETTINGS = 'ui/screens/settings.tsx';
const HELP = 'ui/lib/help-data.ts';
const NARRATION = 'ui/screens/narration.tsx';

export function wordingPatches(): Patch[] {
  return [
    {
      file: SETTINGS,
      find: literal(
        'footer="A backup holds your library, categories, reading progress, history, settings and installed sources. Backups are saved in iCloud Drive › Scriptable › TachiNovel › backups."',
      ),
      replace: text(
        'footer={`A backup holds your library, categories, reading progress, history, settings and installed sources. Backups are saved in ${globalThis.__TN_TEXT__?.backupsWhere ?? "TachiNovel’s folder"}.`}',
      ),
      why: 'Backup & Restore footer: where v2 keeps backups',
    },
    {
      file: SETTINGS,
      find: literal("clearable: false, note: 'Synced with iCloud' }"),
      replace: text('clearable: false, get note() { return globalThis.__TN_TEXT__?.stateNote ?? "On this iPhone"; } }'),
      why: 'Storage: where library & settings live',
    },
    {
      file: SETTINGS,
      find: literal('footer="A personal web-novel reader for iPhone, running in Scriptable. Sources use the LNReader plugin format."'),
      replace: text(
        "footer={__FLAVOR__ === 'store' ? 'A web-novel reader for iPhone. Sources come from the repositories you add.' : 'A personal web-novel reader for iPhone. Sources use the LNReader plugin format.'}",
      ),
      why: 'About footer: no Scriptable',
    },
    {
      file: HELP,
      find: /a: 'Your library, progress and settings live in iCloud Drive › Scriptable › TachiNovel\. ([^'\n]*)',/,
      // A getter: the location is known once the core answered v2.storage (help renders later).
      replace: 'get a() { return `Your library, progress and settings live in ${globalThis.__TN_TEXT__?.dataWhere ?? "TachiNovel’s folder"}. $1`; },',
      why: 'Help: where the library lives',
    },
    {
      file: HELP,
      find: /a: 'Yes, with your PC’s help\.[^'\n]*BookPlayer[^'\n]*',/,
      replace: text(
        "a: 'Yes. Tap Listen in the reader and the chapter is read aloud. It keeps playing with the screen locked, through headphones or the car, and goes on to the next chapter. More › Listen in the Car has the full player.',",
      ),
      why: 'Help: listening in the car is built in',
    },
    {
      file: HELP,
      find: /a: 'Delete files from TachiNovel Audio once they’re in BookPlayer[^'\n]*',/,
      replace: text(
        "a: 'Listening goes on to the next chapter by itself. Chapters load as they’re needed, so for a drive without signal, download the next chapters first (novel page › Download).',",
      ),
      why: 'Help: next chapters while listening',
    },
    {
      file: NARRATION,
      find: literal("showToast('Couldn’t open Files. Find the audio in Files › iCloud Drive › TachiNovel Audio.');"),
      replace: text("showToast('Couldn’t open Files. Find the audio in the Files app, in the TachiNovel Audio folder.');"),
      why: 'Listen in the Car: no iCloud path',
    },
    {
      file: NARRATION,
      find: literal("'The audio shows up in Files › iCloud Drive › TachiNovel Audio.',"),
      replace: text("'The audio shows up in the TachiNovel Audio folder in the Files app.',"),
      why: 'Listen in the Car: how it works (folder)',
    },
    {
      file: NARRATION,
      find: literal("'Import the files into BookPlayer (free on the App Store). It plays them in CarPlay and remembers your place.',"),
      replace: text("'Open the player below to listen: it plays in the car and remembers your place.',"),
      why: 'Listen in the Car: how it works (player)',
    },
    {
      file: NARRATION,
      find: literal('audio appears in Files › iCloud Drive › TachiNovel Audio.</p>'),
      replace: text('audio appears in the TachiNovel Audio folder in the Files app.</p>'),
      why: 'Listen in the Car: intro',
    },
    {
      file: NARRATION,
      find: literal('is in Files › iCloud Drive › TachiNovel Audio › {audioFolderName(currentAudio.name)}. Open it there and share it to BookPlayer.'),
      replace: text('is in the TachiNovel Audio folder › {audioFolderName(currentAudio.name)}. Open the player below to listen.'),
      why: 'Listen in the Car: ready card',
    },
    {
      file: 'ui/lib/whats-new-data.ts',
      find: /export const WHATS_NEW: readonly WhatsNewRelease\[\] = \[\n[\s\S]*?\n\];/,
      replace: 'export const WHATS_NEW: readonly WhatsNewRelease[] = globalThis.__TN_WHATS_NEW__ ?? [];',
      why: "What's New lists v2's releases",
    },
  ];
}
