/** The Xcode project stays consistent with ios/App/App/Native/** (edited from Windows by tools/ios-project.ts). */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { updateProject, validateProject } from '../tools/ios-project.ts';

const root = path.resolve(import.meta.dirname, '..');
const pbx = readFileSync(path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'utf8');

function swift(dir: string, rel = ''): string[] {
  return readdirSync(dir).flatMap((n) => {
    const abs = path.join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    return statSync(abs).isDirectory() ? swift(abs, r) : n.endsWith('.swift') ? [r] : [];
  });
}

describe('ios project', () => {
  const files = swift(path.join(root, 'ios', 'App', 'App', 'Native'));

  it('is structurally valid', () => {
    expect(validateProject(pbx)).toEqual([]);
  });

  it('registers every native Swift file (run node tools/ios-project.ts after adding one)', () => {
    expect(updateProject(pbx, files)).toBe(pbx);
    for (const f of files) expect(pbx).toContain(`path = "${f}"`);
  });

  it('targets iOS 17 and signs with App.entitlements', () => {
    expect(pbx).not.toMatch(/IPHONEOS_DEPLOYMENT_TARGET = 1[0-6]\./);
    expect(pbx.match(/CODE_SIGN_ENTITLEMENTS = App\/App.entitlements;/g)?.length).toBe(2);
  });

  it('keeps JavaScriptCore and Capacitor apart (their JSValue types clash)', () => {
    for (const f of files) {
      const src = readFileSync(path.join(root, 'ios', 'App', 'App', 'Native', f), 'utf8');
      const jsc = /^import JavaScriptCore$/m.test(src);
      const cap = /^import Capacitor$/m.test(src);
      expect(jsc && cap, f).toBe(false);
    }
  });
});
