/**
 * Changelog fragments (changelog.d/README.md): every pull request adds its own small file instead of
 * editing CHANGELOG.md, so parallel PRs never conflict there. At release time `node tools/release.ts
 * prepare <version>` merges them into CHANGELOG.md and deletes them.
 *
 * Fragment format (Keep a Changelog sections, one or more bullets each):
 *
 *   ### Added
 *
 *   - Crash reports in Settings › Diagnostics.
 *     A continuation line is indented by two spaces.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const FRAGMENTS_DIR = 'changelog.d';
export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'] as const;
export type Section = (typeof SECTIONS)[number];
export type Entries = Map<Section, string[]>;

const isSection = (s: string): s is Section => (SECTIONS as readonly string[]).includes(s);

/** Sections and their bullet entries (each entry keeps its continuation lines). Throws on anything else. */
export function parseEntries(markdown: string, where: string): Entries {
  const out: Entries = new Map();
  let section: Section | null = null;
  let entry: string[] | null = null;
  const flush = (): void => {
    if (section && entry) out.get(section)?.push(entry.join('\n'));
    entry = null;
  };
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line === '') continue;
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      flush();
      const name = heading[1]!.trim();
      if (!isSection(name)) throw new Error(`${where}: unknown section "${name}" (use ${SECTIONS.join(', ')})`);
      section = name;
      if (!out.has(section)) out.set(section, []);
      continue;
    }
    if (line.startsWith('- ')) {
      if (!section) throw new Error(`${where}: a bullet before any "### Section" heading`);
      flush();
      entry = [line];
      continue;
    }
    if (line.startsWith('  ') && entry) {
      entry.push(line);
      continue;
    }
    throw new Error(`${where}: unexpected line "${line.slice(0, 60)}" (fragments hold "### Section" headings and "- " bullets)`);
  }
  flush();
  for (const [name, list] of out) if (list.length === 0) throw new Error(`${where}: section "${name}" has no entries`);
  return out;
}

/** A fragment must have at least one entry. */
export function parseFragment(text: string, file: string): Entries {
  const entries = parseEntries(text, file);
  if (entries.size === 0) throw new Error(`${file}: no entries (add "### Added" or another section with a "- " bullet)`);
  return entries;
}

/** Fragment file names in changelog.d/ (README.md excluded), sorted. */
export function listFragments(root: string): string[] {
  const dir = path.join(root, FRAGMENTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md') && n.toLowerCase() !== 'readme.md')
    .sort();
}

export function readFragments(root: string): { file: string; entries: Entries }[] {
  return listFragments(root).map((n) => {
    const file = `${FRAGMENTS_DIR}/${n}`;
    return { file, entries: parseFragment(readFileSync(path.join(root, file), 'utf8'), file) };
  });
}

function render(entries: Entries): string {
  const parts: string[] = [];
  for (const s of SECTIONS) {
    const list = entries.get(s);
    if (list && list.length > 0) parts.push(`### ${s}\n\n${list.join('\n')}`);
  }
  return parts.join('\n\n');
}

/**
 * Adds fragment entries to CHANGELOG.md's "## [Unreleased]" section (after what is already there),
 * grouped by section in Keep a Changelog order.
 */
export function mergeFragments(changelog: string, fragments: Entries[]): string {
  const text = changelog.replace(/\r\n/g, '\n');
  const head = /^## \[Unreleased\][^\n]*\n/m.exec(text);
  if (!head) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  const start = head.index + head[0].length;
  const nextHeading = text.slice(start).search(/^## \[|^\[[^\]]+\]: \S+$/m);
  const end = nextHeading < 0 ? text.length : start + nextHeading;
  const merged: Entries = parseEntries(text.slice(start, end), 'CHANGELOG.md Unreleased');
  for (const f of fragments) {
    for (const [s, list] of f) merged.set(s, [...(merged.get(s) ?? []), ...list]);
  }
  const body = render(merged);
  return `${text.slice(0, start)}\n${body ? `${body}\n\n` : ''}${text.slice(end).replace(/^\n+/, '')}`;
}

export interface FragmentCheck {
  level: 'ok' | 'notice' | 'error';
  message: string;
}

/**
 * Pull request check: a PR that changes the app (src/ or ios/) adds a fragment; other PRs get a
 * reminder only. Release PRs (CHANGELOG.md assembled, package.json bumped) pass.
 */
export function checkFragments(changed: string[], fragmentFiles: string[]): FragmentCheck {
  const code = changed.filter((f) => f.startsWith('src/') || f.startsWith('ios/'));
  const release = changed.includes('CHANGELOG.md') && changed.includes('package.json');
  if (fragmentFiles.length > 0) {
    const direct = changed.includes('CHANGELOG.md') && !release ? ' (and CHANGELOG.md was edited directly: leave that to the release)' : '';
    return { level: direct ? 'notice' : 'ok', message: `changelog fragment: ${fragmentFiles.join(', ')}${direct}` };
  }
  if (release) return { level: 'ok', message: 'release PR: CHANGELOG.md assembled from fragments' };
  if (code.length > 0) {
    return {
      level: 'error',
      message: `this PR changes the app (${code.slice(0, 3).join(', ')}${code.length > 3 ? ', …' : ''}) but adds no changelog fragment: add ${FRAGMENTS_DIR}/<branch-name>.md (see ${FRAGMENTS_DIR}/README.md)`,
    };
  }
  return { level: 'notice', message: `no changelog fragment; fine for docs/CI/dependency-only changes, otherwise add ${FRAGMENTS_DIR}/<branch-name>.md` };
}
