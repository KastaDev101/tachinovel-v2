/**
 * Build-time patches (both flavors) for "Download with audio" (src/ui/native/audio-ui.tsx), reading
 * `globalThis.__TN_AUDIO__` (set by v2 before the user reaches these screens; without it, a v1 build, v1 behaves as
 * before). Each must match exactly once (tools/v1.ts):
 *  - novel page: the chapter selection's Download opens the download sheet; the ••• menu gets "Download…" (and "Remove
 *    Downloaded Audio" while the novel has audio); chapter rows show the audio badges (the list is virtualized, so the
 *    row asks for its badge instead of a DOM hook);
 *  - More › Downloads: the audio Queue at the top, the Narration Audio section under Automatic;
 *  - More › Storage: a Narration Audio row.
 */
import type { Patch } from './v1.ts';

const lit = (s: string): RegExp => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const rep = (s: string): string => s.replaceAll('$', '$$$$');

const CTX = '{ pluginId: props.pluginId, novelPath: props.path, name: details.name, cover: details.cover, chapters, lastRead, markReadAt: settings.peek().reader.markReadAt }';
const DOWNLOAD = `  function download(indexes: number[]): void {
`;
const MENU_END = `      ...(inLib ? [{ title: 'Set Categories' }, { title: 'Migrate' }] : []),
    ];`;
const MENU_LAST = `    else if (choice === 'Migrate') push({ name: 'migrateSearch', pluginId: props.pluginId, path: props.path });`;
const BADGE = `{c.downloaded && <Icon name="arrow.down.circle.fill" size={17} class="chapter-dl" />}`;
const DOWNLOADS_TOP = `<Screen class="is-grouped" title="Downloads" back="More" testId="screen-downloads">
      <div class="grouped">`;
const AUTO = `<AutoDownloadSection />`;
const STORAGE_ANCHOR = '<Section header="Limits" footer="Caches never grow past these limits; the oldest items are removed first.">';

export function audioPatches(): Patch[] {
  return [
    {
      file: 'ui/screens/novel.tsx',
      find: lit(DOWNLOAD),
      replace: rep(`${DOWNLOAD}    if (globalThis.__TN_AUDIO__) {
      setSelection(null);
      return globalThis.__TN_AUDIO__.download({ ...${CTX}, selected: indexes });
    }
`),
      why: 'novel page: the selection’s Download opens the download sheet',
    },
    {
      file: 'ui/screens/novel.tsx',
      find: lit(MENU_END),
      replace: rep(`      ...(inLib ? [{ title: 'Set Categories' }, { title: 'Migrate' }] : []),
      ...(globalThis.__TN_AUDIO__?.menu(key) ?? []),
    ];`),
      why: 'novel page: Download… and Remove Downloaded Audio in the ••• menu',
    },
    {
      file: 'ui/screens/novel.tsx',
      find: lit(MENU_LAST),
      replace: rep(`${MENU_LAST}
    else if (choice) globalThis.__TN_AUDIO__?.onMenu(choice, ${CTX});`),
      why: 'novel page: the ••• menu’s audio items',
    },
    {
      file: 'ui/screens/novel.tsx',
      find: lit(BADGE),
      replace: rep(`{globalThis.__TN_AUDIO__ ? globalThis.__TN_AUDIO__.badge(key, c.path, c.downloaded) : ${BADGE.slice(1, -1)}}`),
      why: 'novel page: audio badges on chapter rows',
    },
    {
      file: 'ui/screens/settings.tsx',
      find: lit(DOWNLOADS_TOP),
      replace: rep(`${DOWNLOADS_TOP}
        {globalThis.__TN_AUDIO__?.queue()}`),
      why: 'Downloads: the audio queue',
    },
    {
      file: 'ui/screens/settings.tsx',
      find: lit(AUTO),
      replace: rep(`${AUTO}
        {globalThis.__TN_AUDIO__?.storage()}`),
      why: 'Downloads: Narration Audio',
    },
    {
      file: 'ui/screens/settings.tsx',
      find: lit(STORAGE_ANCHOR),
      replace: rep(`{globalThis.__TN_AUDIO__?.storageRow()}
            ${STORAGE_ANCHOR}`),
      why: 'Storage: Narration Audio',
    },
  ];
}
