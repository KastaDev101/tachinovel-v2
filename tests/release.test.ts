/** Versioning and release notes (tools/release.ts, docs/release.md). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changelogSection, packageVersion, parseVersion, prepareChangelog, projectMarketingVersions, projectVersionProblems, setProjectMarketingVersion } from '../tools/release.ts';

const root = path.resolve(import.meta.dirname, '..');
const pbx = readFileSync(path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'utf8');
const REPO = 'https://github.com/example/app';

const CHANGELOG = `# Changelog

Intro.

## [Unreleased]

### Added

- Thing three.

## [1.1.0] - 2026-09-01

### Fixed

- Thing two.

## [1.0.0] - 2026-08-01

- Thing one.

[Unreleased]: ${REPO}/compare/v1.1.0...HEAD
[1.1.0]: ${REPO}/compare/v1.0.0...v1.1.0
[1.0.0]: ${REPO}/releases/tag/v1.0.0
`;

describe('version', () => {
  it('maps a SemVer version to the iOS marketing version', () => {
    expect(parseVersion('2.0.0')).toEqual({ version: '2.0.0', marketing: '2.0.0', prerelease: false });
    expect(parseVersion('2.1.3-alpha.1')).toEqual({ version: '2.1.3-alpha.1', marketing: '2.1.3', prerelease: true });
    expect(parseVersion('10.0.12-rc.2')).toMatchObject({ marketing: '10.0.12', prerelease: true });
  });

  it('rejects versions Apple or SemVer would not accept', () => {
    for (const bad of ['2.0', '2', 'v2.0.0', '02.0.0', '2.0.0-', '2.0.0+build.5', '2.0.0.1', '']) expect(() => parseVersion(bad), bad).toThrow();
  });

  it('keeps the Xcode project in sync with package.json (run node tools/release.ts prepare <version>)', () => {
    expect(projectMarketingVersions(pbx).length).toBe(2);
    expect(projectVersionProblems(pbx, packageVersion(root))).toEqual([]);
  });

  it('rewrites every MARKETING_VERSION', () => {
    const next = setProjectMarketingVersion(pbx, '9.8.7');
    expect(projectMarketingVersions(next)).toEqual(['9.8.7', '9.8.7']);
    expect(projectVersionProblems(next, '9.8.7-beta.1')).toEqual([]);
    expect(projectVersionProblems(next, '9.8.8')).toHaveLength(2);
  });
});

describe('changelog', () => {
  it('extracts one version section without the link definitions', () => {
    expect(changelogSection(CHANGELOG, '1.1.0')).toBe('### Fixed\n\n- Thing two.');
    expect(changelogSection(CHANGELOG, '1.0.0')).toBe('- Thing one.');
    expect(changelogSection(CHANGELOG, 'Unreleased')).toBe('### Added\n\n- Thing three.');
    expect(changelogSection(CHANGELOG, '3.0.0')).toBeNull();
    expect(changelogSection(CHANGELOG.replace(/\n/g, '\r\n'), '1.1.0')).toBe('### Fixed\n\n- Thing two.');
  });

  it('moves Unreleased into a dated version section and updates the compare links', () => {
    const out = prepareChangelog(CHANGELOG, '1.2.0-beta.1', '2026-10-06', REPO);
    expect(out).toContain('## [Unreleased]\n\n## [1.2.0-beta.1] - 2026-10-06\n\n### Added\n\n- Thing three.');
    expect(changelogSection(out, 'Unreleased')).toBe('');
    expect(changelogSection(out, '1.2.0-beta.1')).toBe('### Added\n\n- Thing three.');
    expect(out).toContain(`[Unreleased]: ${REPO}/compare/v1.2.0-beta.1...HEAD\n[1.2.0-beta.1]: ${REPO}/compare/v1.1.0...v1.2.0-beta.1\n[1.1.0]:`);
  });

  it('links the first release to its tag', () => {
    const first = `# Changelog\n\n## [Unreleased]\n\n- Start.\n\n[Unreleased]: ${REPO}/commits/main\n`;
    const out = prepareChangelog(first, '2.0.0-alpha.1', '2026-10-06', REPO);
    expect(out).toContain(`[Unreleased]: ${REPO}/compare/v2.0.0-alpha.1...HEAD\n[2.0.0-alpha.1]: ${REPO}/releases/tag/v2.0.0-alpha.1`);
  });

  it('refuses an empty release or a version that already exists', () => {
    const empty = prepareChangelog(CHANGELOG, '1.2.0', '2026-10-06', REPO);
    expect(() => prepareChangelog(empty, '1.3.0', '2026-10-07', REPO)).toThrow(/no entries/);
    expect(() => prepareChangelog(CHANGELOG, '1.1.0', '2026-10-06', REPO)).toThrow(/already/);
    expect(() => prepareChangelog('# Changelog\n', '1.0.0', '2026-10-06', REPO)).toThrow(/Unreleased/);
  });
});
