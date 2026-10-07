/**
 * AltStore source (https://faq.altstore.io/developers/make-a-source) for the sideloaded app: once the
 * source URL is added in AltStore, each new release shows up as an "Update".
 *
 * The release workflow runs this after publishing v<version>: it reads the IPA's own Info.plist (values
 * extracted by the workflow into --info), points `downloadURL` at that release's versioned IPA asset,
 * merges the entry into the previous apps.json (newest first, a few versions kept) and uploads the result
 * to the rolling release `altstore-source` (stable URL below).
 *
 *   node tools/altstore-source.ts --info=info.json --ipa=<file> --url=<download URL> --notes=<file>
 *        [--previous=<apps.json>] [--label=<package version>] --out=apps.json
 *
 * info.json (from the IPA): { bundleId, version, build, minOS, privacy: { NS…UsageDescription: text } }
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { REPO_URL } from './release.ts';

export const SOURCE_URL = `${REPO_URL}/releases/download/altstore-source/apps.json`;
export const ICON_URL = 'https://raw.githubusercontent.com/KastaDev101/tachinovel-v2/main/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png';
const TINT = '#a8b4ff';
/** Versions listed (AltStore treats the first as the latest). */
export const KEEP_VERSIONS = 10;
const MAX_NOTES = 4000;

export interface IpaInfo {
  bundleId: string;
  /** CFBundleShortVersionString */
  version: string;
  /** CFBundleVersion */
  build: string;
  minOS?: string;
  /** NS…UsageDescription keys of the Info.plist (AltStore wants every one listed). */
  privacy?: Record<string, string>;
}

export interface AltVersion {
  version: string;
  buildVersion: string;
  marketingVersion?: string;
  date: string;
  localizedDescription?: string;
  downloadURL: string;
  size: number;
  minOSVersion?: string;
}

export interface AltApp {
  name: string;
  bundleIdentifier: string;
  developerName: string;
  subtitle?: string;
  localizedDescription: string;
  iconURL: string;
  tintColor?: string;
  category?: string;
  versions: AltVersion[];
  appPermissions: { entitlements: string[]; privacy: Record<string, string> };
}

export interface AltSource {
  name: string;
  identifier: string;
  subtitle?: string;
  description?: string;
  iconURL?: string;
  website?: string;
  tintColor?: string;
  apps: AltApp[];
  news: unknown[];
}

/** Release notes are Markdown; AltStore shows plain text. Keep the words, drop the markup. */
export function plainNotes(markdown: string): string {
  const text = markdown
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}[ \t]*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[ \t]*[-*][ \t]+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > MAX_NOTES ? `${text.slice(0, MAX_NOTES - 1).trimEnd()}…` : text;
}

/** apps.json with `entry` as the newest version (an entry for the same build is replaced, not duplicated). */
export function buildSource(previous: AltSource | null, info: IpaInfo, entry: AltVersion): AltSource {
  const old = previous?.apps.find((a) => a.bundleIdentifier === info.bundleId)?.versions ?? [];
  const versions = [entry, ...old.filter((v) => !(v.version === entry.version && v.buildVersion === entry.buildVersion))].slice(0, KEEP_VERSIONS);
  const app: AltApp = {
    name: 'TachiNovel',
    bundleIdentifier: info.bundleId,
    developerName: 'Kasta',
    subtitle: 'Web novels: read and listen.',
    localizedDescription:
      'A web-novel reader: browse sources, keep a library, read with progress saved, and listen with the lock screen and car controls. Unsigned build for sideloading with a free Apple ID.',
    iconURL: ICON_URL,
    tintColor: TINT,
    category: 'entertainment',
    versions,
    // The sideload IPA carries no entitlements (ci/ios-unsigned-ipa.sh refuses restricted ones).
    appPermissions: { entitlements: [], privacy: { ...(info.privacy ?? {}) } },
  };
  return {
    name: 'TachiNovel',
    identifier: 'io.github.kastadev101.tachinovel',
    subtitle: 'Sideload builds of TachiNovel',
    description: 'Unsigned builds from the TachiNovel GitHub releases, for AltStore with a free Apple ID.',
    iconURL: ICON_URL,
    website: REPO_URL,
    tintColor: TINT,
    apps: [app],
    news: previous?.news ?? [],
  };
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

if (import.meta.main) {
  const need = (name: string): string => {
    const v = arg(name);
    if (!v) throw new Error(`--${name}= is required`);
    return v;
  };
  const info = JSON.parse(readFileSync(need('info'), 'utf8')) as IpaInfo;
  const ipa = need('ipa');
  const prevPath = arg('previous');
  let previous: AltSource | null = null;
  if (prevPath && existsSync(prevPath)) {
    try {
      previous = JSON.parse(readFileSync(prevPath, 'utf8')) as AltSource;
    } catch {
      console.warn(`ignoring unreadable ${prevPath}`);
    }
  }
  const label = arg('label');
  const notesPath = arg('notes');
  const entry: AltVersion = {
    version: info.version,
    buildVersion: info.build,
    ...(label && label !== info.version ? { marketingVersion: label } : {}),
    date: new Date().toISOString(),
    ...(notesPath && existsSync(notesPath) ? { localizedDescription: plainNotes(readFileSync(notesPath, 'utf8')) } : {}),
    downloadURL: need('url'),
    size: statSync(ipa).size,
    ...(info.minOS ? { minOSVersion: info.minOS } : {}),
  };
  const out = need('out');
  writeFileSync(out, `${JSON.stringify(buildSource(previous, info, entry), null, 2)}\n`);
  console.log(`${out}: ${info.bundleId} ${info.version} (${info.build}), ${entry.size} bytes → ${entry.downloadURL}`);
}
