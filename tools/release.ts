/**
 * Versions and releases (docs/release.md). package.json `version` is the single source of truth:
 *
 *   package.json "2.1.0-beta.2"  →  iOS CFBundleShortVersionString "2.1.0"  (MARKETING_VERSION)
 *   CI run number                →  iOS CFBundleVersion                     (CURRENT_PROJECT_VERSION)
 *
 * Apple only accepts up to three period-separated integers as the marketing version, so a pre-release
 * suffix stays in package.json, the About screen, the tag and the release name, not in the bundle.
 *
 * Usage:
 *   node tools/release.ts version                 print the iOS marketing version (for CI scripts)
 *   node tools/release.ts check                   fail unless the Xcode project matches package.json
 *   node tools/release.ts prepare <version>       bump package.json + lockfile + Xcode project, merge the
 *                                                 changelog.d/ fragments into CHANGELOG "Unreleased" (and
 *                                                 delete them), move it into a dated <version> section
 *   node tools/release.ts verify-tag <tag> [--notes=<file>]
 *                                                 release workflow gate: tag == v<package version>, project
 *                                                 in sync, CHANGELOG section present (written to <file>)
 *   node tools/release.ts notes <version>         print that version's CHANGELOG section
 *   node tools/release.ts changelog               preview "Unreleased" with the pending fragments merged
 *   node tools/release.ts fragments-check <base>  pull request check (CI job "changelog"): app changes
 *                                                 since <base> come with a changelog.d/ fragment
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkFragments, FRAGMENTS_DIR, listFragments, mergeFragments, parseFragment, readFragments } from './changelog.ts';

export const root = path.resolve(import.meta.dirname, '..');
export const REPO_URL = 'https://github.com/KastaDev101/tachinovel-v2';
const PBXPROJ = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const CHANGELOG = path.join(root, 'CHANGELOG.md');

/** SemVer 2.0.0 (https://semver.org), without build metadata (`+…` is not used for app versions). */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export interface ParsedVersion {
  version: string;
  /** "major.minor.patch": what iOS shows as the version (CFBundleShortVersionString). */
  marketing: string;
  prerelease: boolean;
}

export function parseVersion(version: string): ParsedVersion {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`"${version}" is not a semantic version like 2.1.0 or 2.1.0-beta.1`);
  return { version, marketing: `${m[1]}.${m[2]}.${m[3]}`, prerelease: m[4] !== undefined };
}

export function packageVersion(dir = root): string {
  return (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string }).version;
}

/** Every MARKETING_VERSION in the project (one per build configuration of the app target). */
export function projectMarketingVersions(pbx: string): string[] {
  return [...pbx.matchAll(/^\s*MARKETING_VERSION = ([^;]+);$/gm)].map((m) => m[1]!.replace(/^"|"$/g, ''));
}

export function setProjectMarketingVersion(pbx: string, marketing: string): string {
  if (projectMarketingVersions(pbx).length === 0) throw new Error('no MARKETING_VERSION in project.pbxproj');
  return pbx.replace(/^(\s*MARKETING_VERSION = )[^;]+;$/gm, `$1${marketing};`);
}

/** Problems that make the Xcode project disagree with package.json (empty = in sync). */
export function projectVersionProblems(pbx: string, version: string): string[] {
  const { marketing } = parseVersion(version);
  const found = projectMarketingVersions(pbx);
  if (found.length === 0) return ['project.pbxproj has no MARKETING_VERSION'];
  return found.filter((v) => v !== marketing).map((v) => `project.pbxproj MARKETING_VERSION ${v} ≠ ${marketing} (package.json ${version}); run node tools/release.ts prepare ${version}`);
}

const HEADING = /^## \[([^\]]+)\][^\n]*$/gm;

/** The body of `## [<version>]` in a Keep a Changelog file (without the heading), or null. */
export function changelogSection(changelog: string, version: string): string | null {
  const text = changelog.replace(/\r\n/g, '\n');
  const headings = [...text.matchAll(HEADING)];
  const i = headings.findIndex((h) => h[1] === version);
  if (i < 0) return null;
  const start = headings[i]!.index! + headings[i]![0].length;
  const next = headings[i + 1]?.index ?? text.length;
  // Link reference definitions ("[1.0.0]: https://…") at the end belong to the file, not the section.
  const lines = text.slice(start, next).split('\n');
  while (lines.length > 0 && /^\s*$|^\[[^\]]+\]: \S+$/.test(lines[lines.length - 1]!)) lines.pop();
  return lines.join('\n').trim();
}

/**
 * Moves "Unreleased" into a new `## [<version>] - <date>` section, leaves an empty Unreleased on top and
 * updates the compare links at the bottom.
 */
export function prepareChangelog(changelog: string, version: string, date: string, repoUrl = REPO_URL): string {
  const text = changelog.replace(/\r\n/g, '\n');
  if (changelogSection(text, version) !== null) throw new Error(`CHANGELOG.md already has a [${version}] section`);
  const unreleased = changelogSection(text, 'Unreleased');
  if (unreleased === null) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  if (!/^- /m.test(unreleased)) throw new Error('CHANGELOG.md "Unreleased" has no entries to release');
  const previous = [...text.matchAll(HEADING)].map((h) => h[1]!).find((v) => v !== 'Unreleased');

  let out = text.replace(/^## \[Unreleased\][^\n]*$/m, `## [Unreleased]\n\n## [${version}] - ${date}`);
  const links = [`[Unreleased]: ${repoUrl}/compare/v${version}...HEAD`, previous ? `[${version}]: ${repoUrl}/compare/v${previous}...v${version}` : `[${version}]: ${repoUrl}/releases/tag/v${version}`];
  out = out.replace(/^\[Unreleased\]: \S+$/m, links.join('\n'));
  if (!out.includes(links[0]!)) out = `${out.trimEnd()}\n\n${links.join('\n')}\n`;
  return out;
}

function setLockVersion(lock: string, version: string): string {
  const data = JSON.parse(lock) as { version?: string; packages?: Record<string, { version?: string }> };
  data.version = version;
  const self = data.packages?.[''];
  if (self) self.version = version;
  return `${JSON.stringify(data, null, 2)}\n`;
}

function setPackageVersion(pkg: string, version: string): string {
  if (!/^ {2}"version": "[^"]*",$/m.test(pkg)) throw new Error('package.json has no top-level "version"');
  return pkg.replace(/^( {2}"version": )"[^"]*",$/m, `$1"${version}",`);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

function main(argv: string[]): void {
  const [cmd, arg] = argv;
  const version = packageVersion();
  switch (cmd) {
    case 'version':
      console.log(parseVersion(version).marketing);
      return;
    case 'check': {
      const problems = projectVersionProblems(readFileSync(PBXPROJ, 'utf8'), version);
      if (problems.length) fail(problems.join('\n'));
      console.log(`version ${version} (iOS ${parseVersion(version).marketing}) in sync`);
      return;
    }
    case 'prepare': {
      if (!arg) fail('usage: node tools/release.ts prepare <version>');
      const next = parseVersion(arg);
      if (!existsSync(CHANGELOG)) fail('CHANGELOG.md not found');
      const fragments = readFragments(root);
      const merged = mergeFragments(readFileSync(CHANGELOG, 'utf8'), fragments.map((f) => f.entries));
      const changelog = prepareChangelog(merged, next.version, today());
      writeFileSync(path.join(root, 'package.json'), setPackageVersion(readFileSync(path.join(root, 'package.json'), 'utf8'), next.version));
      const lockPath = path.join(root, 'package-lock.json');
      if (existsSync(lockPath)) writeFileSync(lockPath, setLockVersion(readFileSync(lockPath, 'utf8'), next.version));
      writeFileSync(PBXPROJ, setProjectMarketingVersion(readFileSync(PBXPROJ, 'utf8'), next.marketing));
      writeFileSync(CHANGELOG, changelog);
      for (const f of fragments) rmSync(path.join(root, f.file));
      console.log(`prepared ${next.version} (iOS ${next.marketing}${next.prerelease ? ', pre-release' : ''}): package.json, package-lock.json, project.pbxproj, CHANGELOG.md (${fragments.length} fragment(s) merged and removed)`);
      console.log(`next: open a "Release ${next.version}" PR; after it merges, tag main: git tag -a v${next.version} -m "TachiNovel ${next.version}" && git push origin v${next.version}`);
      return;
    }
    case 'verify-tag': {
      if (!arg) fail('usage: node tools/release.ts verify-tag <tag> [--notes=<file>]');
      const parsed = parseVersion(version);
      if (arg !== `v${version}`) fail(`tag ${arg} does not match package.json version ${version} (expected v${version})`);
      const problems = projectVersionProblems(readFileSync(PBXPROJ, 'utf8'), version);
      if (problems.length) fail(problems.join('\n'));
      const notes = existsSync(CHANGELOG) ? changelogSection(readFileSync(CHANGELOG, 'utf8'), version) : null;
      if (!notes) fail(`CHANGELOG.md has no "## [${version}]" section with notes; run node tools/release.ts prepare ${version} before tagging`);
      const notesOut = argv.find((a) => a.startsWith('--notes='))?.slice('--notes='.length);
      if (notesOut) writeFileSync(notesOut, `${notes}\n`);
      const out = process.env.GITHUB_OUTPUT;
      if (out) appendFileSync(out, `version=${version}\nmarketing=${parsed.marketing}\nprerelease=${parsed.prerelease}\n`);
      console.log(`tag ${arg} ok: ${version} (iOS ${parsed.marketing})${parsed.prerelease ? ', pre-release' : ''}`);
      return;
    }
    case 'notes': {
      const v = arg ?? version;
      const notes = existsSync(CHANGELOG) ? changelogSection(readFileSync(CHANGELOG, 'utf8'), v) : null;
      if (notes === null) fail(`no [${v}] section in CHANGELOG.md`);
      console.log(notes);
      return;
    }
    case 'changelog': {
      const merged = mergeFragments(readFileSync(CHANGELOG, 'utf8'), readFragments(root).map((f) => f.entries));
      console.log(changelogSection(merged, 'Unreleased') ?? '');
      return;
    }
    case 'fragments-check': {
      if (!arg) fail('usage: node tools/release.ts fragments-check <base-ref>');
      const changed = execFileSync('git', ['diff', '--name-only', `${arg}...HEAD`], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
      const present = new Set(listFragments(root).map((n) => `${FRAGMENTS_DIR}/${n}`));
      const fragments = changed.filter((f) => present.has(f));
      // Every fragment in the tree must parse (also checked by tests/release.test.ts).
      for (const f of present) parseFragment(readFileSync(path.join(root, f), 'utf8'), f);
      const r = checkFragments(changed, fragments);
      const level = r.level === 'error' ? 'error' : r.level === 'notice' ? 'warning' : 'notice';
      console.log(`::${level} title=Changelog::${r.message}`);
      if (r.level === 'error') process.exit(1);
      return;
    }
    default:
      fail('usage: node tools/release.ts version | check | prepare <version> | verify-tag <tag> [--notes=<file>] | notes [<version>] | changelog | fragments-check <base>');
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
