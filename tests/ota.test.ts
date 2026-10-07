/**
 * Signed web updates (src/core/ota/ota.ts, tools/ota-pack.ts, WebBundle.swift): what gets staged, what is
 * refused (signature, checksum, native level, flavor, unsafe paths, older builds) and how a bundle that
 * didn't start twice is rolled back and never taken again.
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NativeHost } from '../src/core/native-api.ts';
import { NATIVE_LEVEL } from '../src/core/ota/native-level.ts';
import { BOOT_DEADLINE_MS, type Manifest, MANIFEST_URL, Ota, PACK_FORMAT } from '../src/core/ota/ota.ts';
import { generate } from '../tools/ota-keygen.ts';
import { buildUpdate, signManifest, verifiesWithAppKey } from '../tools/ota-pack.ts';

const tmp = mkdtempSync(path.join(tmpdir(), 'tn2-ota-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const BASE = 'https://github.com/KastaDev101/tachinovel-v2/releases/download/ota';
const RUNNING_BUILT_AT = '2026-10-06T10:00:00.000Z';

const key = generate();
const otherKey = generate();

function www(name: string, builtAt: string, flavor = 'personal'): string {
  const dir = path.join(tmp, name);
  mkdirSync(path.join(dir, 'core'), { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), `<!doctype html><title>${name}</title>`);
  writeFileSync(path.join(dir, 'core', 'core.js'), `/* core ${name} */`);
  writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ time: builtAt, flavor }));
  return dir;
}

interface Site {
  routes: Map<string, { status: number; body: string }>;
}

let n = 0;
function setup(opts: { webBundle?: string | null; site: Site; now?: number; local?: string }) {
  const local = opts.local ?? path.join(tmp, `local-${++n}`);
  mkdirSync(local, { recursive: true });
  const logs: string[] = [];
  const host = {
    info: { webBundle: opts.webBundle ?? null },
    fs: {
      readText: (p: string) => (existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf8') : null),
      writeText: (p: string, t: string) => writeFileSync(p, t),
      exists: (p: string) => existsSync(p),
      remove: (p: string) => rmSync(p, { recursive: true, force: true }),
      move: (a: string, b: string) => renameSync(a, b),
      mkdirp: (p: string) => void mkdirSync(p, { recursive: true }),
      list: (p: string) => readdirSync(p),
    },
    crypto: {
      sha256Hex: (t: string) => createHash('sha256').update(t, 'utf8').digest('hex'),
      verifyEd25519(pub: string, msg: string, sig: string) {
        try {
          const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub, 'base64')]);
          return verifySignature(null, Buffer.from(msg, 'utf8'), createPublicKey({ key: der, format: 'der', type: 'spki' }), Buffer.from(sig, 'base64'));
        } catch {
          return false;
        }
      },
    },
  } as unknown as NativeHost;
  const platform = {
    http: {
      request: (req: { url: string }) => {
        const r = opts.site.routes.get(req.url) ?? { status: 404, body: 'not found' };
        return Promise.resolve({ url: req.url, status: r.status, headers: {}, body: r.body });
      },
    },
    local: { absolute: (p: string) => path.join(local, p).split(path.sep).join('/') },
    log: (_level: string, message: string) => logs.push(message),
  } as unknown as ConstructorParameters<typeof Ota>[1];
  const ota = new Ota(host, platform, { flavor: 'personal', version: '2.0.0', builtAt: RUNNING_BUILT_AT, now: opts.now ?? Date.now(), publicKey: key.publicRawBase64 });
  return { ota, local, logs };
}

function publish(update: { manifest: Manifest; pack: string; packName: string }): Site {
  return {
    routes: new Map([
      [MANIFEST_URL, { status: 200, body: JSON.stringify(update.manifest) }],
      [`${BASE}/${update.packName}`, { status: 200, body: update.pack }],
    ]),
  };
}

function update(name: string, builtAt: string, opts: { flavor?: string; privateKeyPem?: string } = {}) {
  return buildUpdate({ www: www(name, builtAt, opts.flavor), version: '2.0.1', build: name, baseUrl: BASE, privateKeyPem: opts.privateKeyPem ?? key.privatePem });
}

let good: ReturnType<typeof update>;
beforeAll(() => {
  good = update('57', '2026-10-07T10:00:00.000Z');
});

describe('web updates: staging', () => {
  it('stages a newer signed bundle for the next launch', async () => {
    const { ota, local } = setup({ site: publish(good) });
    const r = await ota.check({ force: true, now: Date.now() });
    expect(r).toMatchObject({ status: 'staged', version: '2.0.1' });
    const dir = path.join(local, 'ota', 'bundles', good.manifest.id);
    expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('<title>57</title>');
    expect(readFileSync(path.join(dir, 'core', 'core.js'), 'utf8')).toContain('core 57');
    expect(ota.status().active).toMatchObject({ id: good.manifest.id, nativeLevel: NATIVE_LEVEL });
    expect(readdirSync(path.join(local, 'ota', 'bundles'))).toEqual([good.manifest.id]); // no temp folder left
  });

  it('says up to date when nothing is published (404)', async () => {
    const { ota } = setup({ site: { routes: new Map() } });
    expect((await ota.check({ force: true, now: Date.now() })).status).toBe('up-to-date');
  });

  it('paces background checks', async () => {
    const { ota } = setup({ site: { routes: new Map() } });
    const now = Date.now();
    await ota.check({ now });
    expect((await ota.check({ now: now + 60_000 })).message).toMatch(/recently/);
  });
});

describe('web updates: refusals', () => {
  it('rejects a manifest changed after signing', async () => {
    const tampered = { ...good, manifest: { ...good.manifest, version: '9.9.9' } };
    const { ota, local } = setup({ site: publish(tampered) });
    const r = await ota.check({ force: true, now: Date.now() });
    expect(r).toMatchObject({ status: 'error' });
    expect(r.message).toMatch(/signature/);
    expect(existsSync(path.join(local, 'ota', 'bundles'))).toBe(false);
  });

  it('rejects a bundle signed with another key', async () => {
    const { ota } = setup({ site: publish(update('58', '2026-10-07T11:00:00.000Z', { privateKeyPem: otherKey.privatePem })) });
    expect((await ota.check({ force: true, now: Date.now() })).message).toMatch(/signature/);
    expect(ota.status().active).toBeNull();
  });

  it('rejects a pack that does not match the signed checksum', async () => {
    const site = publish(good);
    site.routes.set(`${BASE}/${good.packName}`, { status: 200, body: good.pack.replace('core 57', 'evil 57') });
    const { ota } = setup({ site });
    expect((await ota.check({ force: true, now: Date.now() })).message).toMatch(/checksum/);
    expect(ota.status().active).toBeNull();
  });

  it('does not apply a bundle built for another native level', async () => {
    const { signature: _s, ...rest } = good.manifest;
    const other = { ...good, manifest: signManifest({ ...rest, nativeLevel: NATIVE_LEVEL + 1 }, key.privatePem) };
    const { ota } = setup({ site: publish(other) });
    const r = await ota.check({ force: true, now: Date.now() });
    expect(r.status).toBe('up-to-date');
    expect(r.message).toMatch(/native level/);
    expect(ota.status().active).toBeNull();
  });

  it('does not apply a store-flavor bundle or one that is not newer', async () => {
    expect(() => update('59', '2026-10-07T12:00:00.000Z', { flavor: 'store' })).toThrow(/personal/);
    const older = update('40', '2026-10-01T00:00:00.000Z');
    const { ota } = setup({ site: publish(older) });
    expect((await ota.check({ force: true, now: Date.now() })).message).toMatch(/not newer/);
  });

  it('refuses unsafe paths inside a validly signed pack', async () => {
    const evilPack = JSON.stringify({ format: PACK_FORMAT, files: { 'index.html': 'x', 'core/core.js': 'x', '../escape.js': 'x' } });
    const { signature: _s, ...rest } = good.manifest;
    const manifest = signManifest(
      { ...rest, pack: { ...rest.pack, sha256: createHash('sha256').update(evilPack, 'utf8').digest('hex'), size: Buffer.byteLength(evilPack) } },
      key.privatePem,
    );
    const { ota, local } = setup({ site: publish({ manifest, pack: evilPack, packName: good.packName }) });
    expect((await ota.check({ force: true, now: Date.now() })).message).toMatch(/unsafe path/);
    expect(existsSync(path.join(local, 'ota', 'escape.js'))).toBe(false);
  });
});

describe('web updates: health and rollback', () => {
  it('confirms a launch whose UI booted in time, not a late one', () => {
    const launchAt = Date.now();
    const { ota, local } = setup({ webBundle: 'b1', site: { routes: new Map() }, now: launchAt });
    mkdirSync(path.join(local, 'ota'), { recursive: true });
    writeFileSync(path.join(local, 'ota', 'launch.json'), JSON.stringify({ id: 'b1', attempt: 1, at: launchAt }));
    ota.confirmBoot(launchAt + BOOT_DEADLINE_MS + 1);
    expect(ota.launch()?.confirmed).toBeFalsy();
    ota.confirmBoot(launchAt + 2000);
    expect(ota.launch()).toMatchObject({ id: 'b1', confirmed: true, attempt: 0 });
  });

  it('marks a bundle that failed to start twice as bad and never stages it again', async () => {
    const site = publish(good);
    const first = setup({ site });
    await first.ota.check({ force: true, now: Date.now() });
    // Two launches of it never reached app.boot: Swift fell back to the embedded bundle and said so.
    writeFileSync(path.join(first.local, 'ota', 'launch.json'), JSON.stringify({ id: null, attempt: 0, at: Date.now(), rolledBack: good.manifest.id }));
    const next = setup({ site, local: first.local });
    next.ota.reconcile();
    expect(next.ota.status()).toMatchObject({ active: null, lastError: expect.stringMatching(/did not start/) as unknown });
    expect(existsSync(path.join(first.local, 'ota', 'bundles', good.manifest.id))).toBe(false);
    expect(next.logs.some((l) => l.includes('rolled back'))).toBe(true);
    const r = await next.ota.check({ force: true, now: Date.now() });
    expect(r.message).toMatch(/rolled back before/);
    expect(next.ota.status().active).toBeNull();
  });
});

describe('web updates: native level', () => {
  it('the release refuses a signing key that does not match the app key', () => {
    const { manifest } = update('keycheck', '2026-10-06T13:00:00.000Z');
    expect(verifiesWithAppKey(manifest, key.publicRawBase64)).toBe(true);
    expect(verifiesWithAppKey(manifest, otherKey.publicRawBase64)).toBe(false);
    expect(verifiesWithAppKey(manifest, '')).toBe(false);
  });

  it('Swift and the web bundle agree on the native level', () => {
    const swift = readFileSync(path.resolve(import.meta.dirname, '..', 'ios', 'App', 'App', 'Native', 'Core', 'WebBundle.swift'), 'utf8');
    expect(Number(/static let nativeLevel = (\d+)/.exec(swift)?.[1])).toBe(NATIVE_LEVEL);
  });
});
