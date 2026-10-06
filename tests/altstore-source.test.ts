/**
 * tools/altstore-source.ts: the AltStore source the release workflow publishes on the rolling
 * "altstore-source" release (AltStore's source format: https://faq.altstore.io/developers/make-a-source).
 */
import { describe, expect, it } from 'vitest';
import { type AltSource, type AltVersion, buildSource, KEEP_VERSIONS, plainNotes } from '../tools/altstore-source.ts';

const info = { bundleId: 'com.kasta.tachinovel', version: '2.0.0', build: '12', minOS: '17.0', privacy: {} };
const entry = (build: string): AltVersion => ({
  version: '2.0.0',
  buildVersion: build,
  marketingVersion: '2.0.0-alpha.1',
  date: '2026-10-06T00:00:00Z',
  downloadURL: `https://github.com/KastaDev101/tachinovel-v2/releases/download/v2.0.0-alpha.${build}/TachiNovel-2.0.0-alpha.${build}-unsigned.ipa`,
  size: 1_500_000,
  minOSVersion: '17.0',
});

describe('AltStore source', () => {
  it('has the fields AltStore requires, and no entitlements (the sideload IPA has none)', () => {
    const s = buildSource(null, info, entry('12'));
    expect(s).toMatchObject({ name: 'TachiNovel', news: [] });
    const app = s.apps[0]!;
    expect(app).toMatchObject({ name: 'TachiNovel', bundleIdentifier: 'com.kasta.tachinovel', developerName: 'Kasta' });
    expect(app.localizedDescription.length).toBeGreaterThan(0);
    expect(app.iconURL).toMatch(/^https:\/\/.+\.png$/);
    expect(app.appPermissions).toEqual({ entitlements: [], privacy: {} });
    const v = app.versions[0]!;
    for (const k of ['version', 'buildVersion', 'date', 'downloadURL', 'size'] as const) expect(v[k]).toBeTruthy();
    expect(v.downloadURL).toMatch(/\/releases\/download\/v[^/]+\/TachiNovel-[^/]+-unsigned\.ipa$/);
  });

  it('puts the new build first, keeps earlier ones, never duplicates a build, and caps the list', () => {
    let s: AltSource | null = null;
    for (let b = 1; b <= KEEP_VERSIONS + 3; b++) s = buildSource(s, { ...info, build: String(b) }, entry(String(b)));
    s = buildSource(s, { ...info, build: String(KEEP_VERSIONS + 3) }, entry(String(KEEP_VERSIONS + 3))); // re-run of the same release
    const builds = s.apps[0]!.versions.map((v) => v.buildVersion);
    expect(builds[0]).toBe(String(KEEP_VERSIONS + 3));
    expect(builds).toHaveLength(KEEP_VERSIONS);
    expect(new Set(builds).size).toBe(builds.length);
  });

  it('lists every privacy string of the IPA', () => {
    const s = buildSource(null, { ...info, privacy: { NSMicrophoneUsageDescription: 'For voice notes.' } }, entry('1'));
    expect(s.apps[0]!.appPermissions.privacy).toEqual({ NSMicrophoneUsageDescription: 'For voice notes.' });
  });

  it('turns release notes into plain text', () => {
    expect(plainNotes('## [2.0.0] - 2026-10-06\n\n### Added\n\n- **Listen** in `the reader` ([#7](https://x))\n')).toBe(
      '[2.0.0] - 2026-10-06\n\nAdded\n\n• Listen in the reader (#7)',
    );
    expect(plainNotes('x'.repeat(5000)).length).toBeLessThanOrEqual(4000);
  });
});
