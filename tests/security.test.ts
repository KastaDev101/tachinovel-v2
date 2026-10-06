/**
 * Security review fixes that can be checked on the PC (docs/security-review.md): deep-link path
 * validation (SR-6), and configuration guards for the Swift/config fixes (SR-1 to SR-5) so a later edit
 * can't quietly undo them.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deepLinkProblem, MAX_DEEP_LINK_PATH, pathProblem } from '../src/core/deep-link.ts';
import { buildAll } from '../tools/build.ts';
import { startCoreInVm } from './helpers/native-mock.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
const SITE = 'https://www.example-novels.test/';

describe('deep-link paths (SR-6)', () => {
  it('accepts site-relative paths and absolute URLs on the source site', () => {
    for (const ok of ['novel/alpha', 'novel/alpha/1', '/series/123?page=2', 'book:42', 'https://www.example-novels.test/novel/x', 'http://WWW.example-novels.test:443/a', '//www.example-novels.test/x']) {
      expect(pathProblem(ok, SITE), ok).toBeNull();
    }
  });

  it('refuses other hosts, credentials, other schemes, control characters and overlong paths', () => {
    expect(pathProblem('https://evil.test/x', SITE)).toMatch(/source's site/);
    expect(pathProblem('//evil.test/x', SITE)).toMatch(/source's site/);
    expect(pathProblem('https://www.example-novels.test@evil.test/x', SITE)).toMatch(/credentials/);
    expect(pathProblem('https://www.example-novels.test.evil.test/x', SITE)).toMatch(/source's site/);
    expect(pathProblem('ftp://www.example-novels.test/x', SITE)).toMatch(/http/);
    expect(pathProblem('https://www.example-novels.test/x', undefined)).toMatch(/source's site/);
    expect(pathProblem('novel/a\nb', SITE)).toMatch(/invalid characters/);
    expect(pathProblem('novel\\..\\x', SITE)).toMatch(/invalid characters/);
    expect(pathProblem('x'.repeat(MAX_DEEP_LINK_PATH + 1), SITE)).toMatch(/too long/);
    expect(pathProblem('', SITE)).toMatch(/empty/);
  });

  it('the built core refuses a link that points an installed source at another host', async () => {
    const www = path.join(root, '.cache', 'test-www-security');
    await buildAll({ flavor: 'store', ads: false, dev: false, outDir: www });
    const core = startCoreInVm({ wwwDir: www, routes: {}, answers: [0] });
    try {
      await core.call('app.boot');
      await core.call('sources.install', { code: read('tests/fixtures/demo-site/spec.json') });
      const bad = await core.callRaw('app.openLink', { pluginId: 'demo-library', novelPath: 'https://evil.test/novel/alpha' });
      expect(bad.ok).toBe(false);
      expect(bad.error?.code).toBe('INVALID_ARGS');
      await expect(core.call('app.openLink', { pluginId: 'demo-library', novelPath: 'https://novels.example.test/novel/alpha' })).resolves.toEqual({ delivered: true });
      await expect(core.call('app.openLink', { pluginId: 'demo-library', novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1' })).resolves.toEqual({ delivered: true });
    } finally {
      core.dispose();
    }
  });

  it('checks both the novel and the chapter path', () => {
    expect(deepLinkProblem({ novelPath: 'novel/alpha', chapterPath: 'novel/alpha/1' }, SITE)).toBeNull();
    expect(deepLinkProblem({ novelPath: 'novel/alpha' }, SITE)).toBeNull();
    expect(deepLinkProblem({ novelPath: 'https://evil.test/' }, SITE)).toMatch(/^novel: /);
    expect(deepLinkProblem({ novelPath: 'novel/alpha', chapterPath: '//evil.test/1' }, SITE)).toMatch(/^chapter: /);
  });
});

describe('configuration guards', () => {
  it('SR-1: the web view is not made inspectable in Release builds', () => {
    expect(read('capacitor.config.ts')).not.toMatch(/^\s*webContentsDebuggingEnabled:\s*true/m);
  });

  it('SR-2: the file router keeps paths inside the web bundle', () => {
    const src = read('ios/App/App/Native/Shell/MainViewController.swift');
    expect(src).toContain('standardizedFileURL');
    expect(src).toMatch(/guard target\.hasPrefix\(bundleRoot \+ "\/"\)/);
  });

  it('SR-3: only http(s) navigations may leave the app', () => {
    const src = read('ios/App/App/Native/Shell/CorePlugin.swift');
    expect(src).toMatch(/override public func shouldOverrideLoad/);
    expect(src).toMatch(/case "capacitor", "http", "https", "about", "data", "blob":/);
  });

  it('SR-4: core log lines are private in the system log of Release builds', () => {
    const src = read('ios/App/App/Native/Core/NativeHostAPI.swift');
    const release = src.slice(src.indexOf('#else', src.indexOf('let log: @convention(block)')));
    expect(release.slice(0, release.indexOf('#endif'))).not.toContain('privacy: .public');
  });

  it('App Transport Security has no exceptions', () => {
    expect(read('ios/App/App/Info.plist')).not.toContain('NSAppTransportSecurity');
  });
});
