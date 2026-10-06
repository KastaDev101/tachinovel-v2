/** Build outputs: flavor guarantees the App Store risk analysis relies on, and the v1 UI transport swap. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildAll } from '../tools/build.ts';

const root = path.resolve(import.meta.dirname, '..');
const out = (f: string): string => path.join(root, '.cache', `test-build-${f}`);
const read = (f: string, rel: string): string => readFileSync(path.join(out(f), rel), 'utf8');

beforeAll(async () => {
  await buildAll({ flavor: 'store', ads: false, dev: false, outDir: out('store') });
  await buildAll({ flavor: 'personal', ads: false, dev: false, outDir: out('personal') });
  await buildAll({ flavor: 'store', ads: true, dev: false, outDir: out('store-ads') });
});

describe('store flavor', () => {
  it('ships no JS plugin host, no built-in plugins, no LNReader repo, no plugin verification table', () => {
    expect(existsSync(path.join(out('store'), 'core', 'lib', 'plugin-host.js'))).toBe(false);
    expect(existsSync(path.join(out('store'), 'core', 'app'))).toBe(false);
    const core = read('store', 'core/core.js');
    expect(core).not.toMatch(/lnreader-plugins\/plugins\/v3\.0\.0\/\.dist/);
    expect(core).not.toMatch(/stonescape/i);
    expect(core).not.toMatch(/"generatedAt"|novelupdates|novelbin/i);
    expect(core).toContain('BUILTIN_SOURCES = []');
    expect(core).toContain('DEFAULT_REPOS = []');
  });

  it('UI: strict CSP, Capacitor transport instead of the Scriptable long-poll, ads only with --ads', () => {
    const html = read('store', 'index.html');
    expect(html).toMatch(/Content-Security-Policy" content="default-src 'none'; script-src 'sha256-/);
    expect(html).toMatch(/connect-src 'none'/);
    expect(html).not.toContain('__bridge');
    expect(html).toContain('"Core"');
    expect(html).not.toContain('ca-app-pub-');
    expect(read('store-ads', 'index.html')).toContain('ca-app-pub-3940256099942544');
  });
});

describe('personal flavor', () => {
  it('ships the v1 plugin host and built-in Stonescape', () => {
    expect(read('personal', 'core/lib/plugin-host.js')).toContain('createPluginHost');
    expect(JSON.parse(read('personal', 'core/app/manifest.json'))).toEqual(['plugins/stonescape.js']);
    expect(read('personal', 'core/core.js')).toMatch(/lnreader-plugins/);
  });
});
