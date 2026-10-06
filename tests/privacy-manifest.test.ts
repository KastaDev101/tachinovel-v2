/**
 * The app's privacy manifest (ios/App/App/PrivacyInfo.xcprivacy) matches the code: every required-reason
 * API the app's Swift code calls is declared with an approved reason, nothing is declared that isn't used,
 * there is no tracking, and the manifest ships in the app bundle.
 * Categories and reasons: https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../tools/third-party.ts';

const root = path.resolve(import.meta.dirname, '..');
const appDir = path.join(root, 'ios', 'App', 'App');
const manifest = readFileSync(path.join(appDir, 'PrivacyInfo.xcprivacy'), 'utf8');
const pbx = readFileSync(path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'utf8');

/** Required-reason API categories: how to spot them in Swift, and the reasons Apple accepts for each. */
const CATEGORIES: Record<string, { uses: RegExp; reasons: string[] }> = {
  NSPrivacyAccessedAPICategoryFileTimestamp: {
    uses: /\.(creationDate|modificationDate)\b|fileModificationDate|contentModificationDate(Key)?\b|creationDateKey|\b(getattrlist|getattrlistbulk|fgetattrlist|getattrlistat|fstatat|lstat|fstat)\s*\(|\bstat\s*\(/,
    reasons: ['DDA9.1', 'C617.1', '3B52.1', '0A2A.1'],
  },
  NSPrivacyAccessedAPICategorySystemBootTime: {
    uses: /\bsystemUptime\b|\bmach_absolute_time\s*\(/,
    reasons: ['35F9.1', '8FFB.1', '3D61.1'],
  },
  NSPrivacyAccessedAPICategoryDiskSpace: {
    uses: /volumeAvailableCapacity\w*Key|volumeTotalCapacityKey|\.systemFreeSize\b|\.systemSize\b|\b(statfs|statvfs|fstatfs|fstatvfs)\s*\(/,
    reasons: ['85F4.1', 'E174.1', '7D9E.1', 'B728.1'],
  },
  NSPrivacyAccessedAPICategoryActiveKeyboards: {
    uses: /\bactiveInputModes\b/,
    reasons: ['3EC4.1', '54BD.1'],
  },
  NSPrivacyAccessedAPICategoryUserDefaults: {
    uses: /\bUserDefaults\b|\bNSUserDefaults\b|@AppStorage\b/,
    reasons: ['CA92.1', '1C8F.1', 'C56D.1', 'AC6B.1'],
  },
};

function swiftFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const abs = path.join(dir, n);
    if (statSync(abs).isDirectory()) return n === 'public' ? [] : swiftFiles(abs);
    return n.endsWith('.swift') ? [abs] : [];
  });
}

/** Category → files using it (comments stripped, so prose about an API doesn't count). */
function usedCategories(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of swiftFiles(appDir)) {
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const [cat, { uses }] of Object.entries(CATEGORIES)) {
      if (uses.test(code)) used.set(cat, [...(used.get(cat) ?? []), path.relative(root, file).replace(/\\/g, '/')]);
    }
  }
  return used;
}

/** Declared category → reasons, from the plist (simple, format-specific parse of this file). */
function declared(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const xml = stripComments(manifest);
  for (const m of xml.matchAll(/<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/g)) {
    out.set(m[1]!, [...m[2]!.matchAll(/<string>([^<]+)<\/string>/g)].map((r) => r[1]!));
  }
  return out;
}

describe('privacy manifest', () => {
  it('declares every required-reason API the Swift code uses, with an approved reason', () => {
    const decl = declared();
    for (const [cat, files] of usedCategories()) {
      expect(decl.has(cat), `${cat} is used in ${files.join(', ')} but not declared`).toBe(true);
      const reasons = decl.get(cat) ?? [];
      expect(reasons.length, cat).toBeGreaterThan(0);
      for (const r of reasons) expect(CATEGORIES[cat]!.reasons, `${cat}: unknown reason ${r}`).toContain(r);
    }
  });

  it('declares nothing the code does not use', () => {
    const used = usedCategories();
    for (const cat of declared().keys()) {
      expect(Object.keys(CATEGORIES), `unknown category ${cat}`).toContain(cat);
      expect(used.has(cat), `${cat} is declared but no Swift file uses it`).toBe(true);
    }
  });

  it('does not track and collects no data (personal and ad-free store builds)', () => {
    const xml = stripComments(manifest);
    expect(xml).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
    expect(xml).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/);
    expect(xml).toMatch(/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/);
  });

  it('ships in the app bundle (Copy Bundle Resources)', () => {
    expect(pbx).toMatch(/PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile;/);
    expect(pbx).toMatch(/\/\* Resources \*\/ = \{[\s\S]*?PrivacyInfo\.xcprivacy in Resources[\s\S]*?\};/);
  });

  it('the scanner sees the APIs it is meant to see', () => {
    const sample = 'let d = attrs[.modificationDate]\nUserDefaults.standard.set(1, forKey: "k")\nlet up = ProcessInfo.processInfo.systemUptime';
    const hits = Object.entries(CATEGORIES).filter(([, c]) => c.uses.test(sample)).map(([k]) => k);
    expect(hits).toEqual(['NSPrivacyAccessedAPICategoryFileTimestamp', 'NSPrivacyAccessedAPICategorySystemBootTime', 'NSPrivacyAccessedAPICategoryUserDefaults']);
    expect(CATEGORIES.NSPrivacyAccessedAPICategoryDiskSpace!.uses.test('let v = try url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])')).toBe(true);
  });
});
