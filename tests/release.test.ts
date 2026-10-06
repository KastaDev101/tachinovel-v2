/** Versioning and release notes (tools/release.ts, docs/release.md). */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFragments, mergeFragments, parseFragment, readFragments } from '../tools/changelog.ts';
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

describe('changelog fragments', () => {
  const FRAGMENT = '### Added\n\n- Crash reports in Diagnostics.\n  Kept on the device.\n\n### Fixed\n\n- A typo.\n';

  it('parses sections and multi-line bullets, and rejects anything else', () => {
    const f = parseFragment(FRAGMENT, 'x.md');
    expect([...f.keys()]).toEqual(['Added', 'Fixed']);
    expect(f.get('Added')).toEqual(['- Crash reports in Diagnostics.\n  Kept on the device.']);
    expect(() => parseFragment('', 'a.md')).toThrow(/no entries/);
    expect(() => parseFragment('- no section\n', 'b.md')).toThrow(/before any/);
    expect(() => parseFragment('### Improved\n\n- x\n', 'c.md')).toThrow(/unknown section/);
    expect(() => parseFragment('### Added\n\nSome prose.\n', 'd.md')).toThrow(/unexpected line/);
    expect(() => parseFragment('### Added\n\n### Fixed\n\n- x\n', 'e.md')).toThrow(/no entries/);
  });

  it('merges fragments into Unreleased after what is there, in Keep a Changelog order', () => {
    const merged = mergeFragments(CHANGELOG, [parseFragment(FRAGMENT, 'x.md'), parseFragment('### Added\n\n- Second.\n', 'y.md')]);
    expect(changelogSection(merged, 'Unreleased')).toBe('### Added\n\n- Thing three.\n- Crash reports in Diagnostics.\n  Kept on the device.\n- Second.\n\n### Fixed\n\n- A typo.');
    expect(changelogSection(merged, '1.1.0')).toBe('### Fixed\n\n- Thing two.');
    const released = prepareChangelog(merged, '1.2.0', '2026-10-07', REPO);
    expect(changelogSection(released, '1.2.0')).toContain('- Second.');
    expect(mergeFragments('# Changelog\n\n## [Unreleased]\n\n[Unreleased]: x\n', [])).toBe('# Changelog\n\n## [Unreleased]\n\n[Unreleased]: x\n');
  });

  it('asks app-changing PRs for a fragment and only reminds the others', () => {
    expect(checkFragments(['src/core/core.ts', 'changelog.d/x.md'], ['changelog.d/x.md']).level).toBe('ok');
    expect(checkFragments(['ios/App/App/AppDelegate.swift'], []).level).toBe('error');
    expect(checkFragments(['docs/roadmap.md', '.github/workflows/ios.yml'], []).level).toBe('notice');
    expect(checkFragments(['CHANGELOG.md', 'package.json', 'package-lock.json', 'changelog.d/x.md'], []).level).toBe('ok');
    expect(checkFragments(['CHANGELOG.md', 'src/ui/main.ts', 'changelog.d/x.md'], ['changelog.d/x.md']).level).toBe('notice');
  });

  it('every fragment in changelog.d/ is well formed', () => {
    expect(() => readFragments(root)).not.toThrow();
  });
});

describe('release rehearsal (the CLI steps release.yml runs, on a copy of this tree)', () => {
  it('prepare then verify-tag yields the version outputs and the assembled notes', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'tachi-release-'));
    try {
      for (const f of ['package.json', 'package-lock.json', 'CHANGELOG.md', 'tools/release.ts', 'tools/changelog.ts', 'ios/App/App.xcodeproj/project.pbxproj']) {
        mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
        cpSync(path.join(root, f), path.join(tmp, f));
      }
      cpSync(path.join(root, 'changelog.d'), path.join(tmp, 'changelog.d'), { recursive: true });
      // Right after a release Unreleased is empty; one extra fragment keeps the rehearsal meaningful.
      writeFileSync(path.join(tmp, 'changelog.d', 'zz-rehearsal.md'), '### Fixed\n\n- Rehearsal entry.\n');
      const pending = readFragments(tmp).length;
      const run = (...args: string[]) => {
        const r = spawnSync(process.execPath, [path.join(tmp, 'tools', 'release.ts'), ...args], {
          encoding: 'utf8',
          env: { ...process.env, GITHUB_OUTPUT: path.join(tmp, 'out.txt') },
        });
        expect(r.status, `${args.join(' ')}: ${r.stderr}`).toBe(0);
        return r.stdout;
      };

      expect(run('prepare', '99.1.0-rc.1')).toContain(`${pending} fragment(s) merged and removed`);
      expect(readdirSync(path.join(tmp, 'changelog.d')).filter((n) => n !== 'README.md')).toEqual([]);
      run('verify-tag', 'v99.1.0-rc.1', `--notes=${path.join(tmp, 'notes.md')}`);
      expect(readFileSync(path.join(tmp, 'out.txt'), 'utf8')).toBe('version=99.1.0-rc.1\nmarketing=99.1.0\nprerelease=true\n');
      const notes = readFileSync(path.join(tmp, 'notes.md'), 'utf8');
      expect(notes).toContain('### Fixed');
      expect(notes).toContain('- Rehearsal entry.');
      expect(changelogSection(readFileSync(path.join(tmp, 'CHANGELOG.md'), 'utf8'), 'Unreleased')).toBe('');
      expect(projectMarketingVersions(readFileSync(path.join(tmp, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8'))).toEqual(['99.1.0', '99.1.0']);
      expect(packageVersion(tmp)).toBe('99.1.0-rc.1');

      // A tag that does not match the prepared version is refused.
      const wrong = spawnSync(process.execPath, [path.join(tmp, 'tools', 'release.ts'), 'verify-tag', 'v99.1.0'], { encoding: 'utf8' });
      expect(wrong.status).toBe(1);
      expect(wrong.stderr).toMatch(/does not match/);
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });
});
