/**
 * Over-the-air web updates (personal flavor only; compiled out of the store flavor, see core.ts).
 *
 * Most changes are web UI and core JS, so new web bundles are published with each release (tools/ota-pack.ts,
 * release workflow) on the rolling release "ota": `manifest.json` (signed, Ed25519) and the pack it names.
 *
 *   check   fetch the manifest; verify the signature with the public key in public-key.ts (native
 *           CryptoKit); accept it only for this flavor and NATIVE_LEVEL (the native↔JS contract it was
 *           built for), when it is newer than the bundle running now and not marked bad;
 *   stage   download the pack (UTF-8 JSON of the www/ files), check its SHA-256 and size against the
 *           signed manifest, write ota/bundles/<id>/ (via a temp folder), make it `state.active`;
 *   switch  the NEXT launch: WebBundle.swift loads it (UI and core) if it passes the same checks;
 *   health  each launch of an OTA bundle counts an attempt (ota/launch.json, written by Swift); the core
 *           confirms it once the UI's app.boot is answered within BOOT_DEADLINE_MS. Two unconfirmed
 *           launches in a row and Swift falls back to the embedded bundle (rolledBack); the core then
 *           marks that bundle bad so it is never staged again.
 *
 * Files (local store, <Application Support>/TachiNovel/ota/):
 *   state.json   { version: 1, active: Staged | null, bad: string[], lastCheck?, lastError? }   (core)
 *   launch.json  { id: string | null, attempt: number, at: number, confirmed?: boolean, rolledBack?: string } (Swift; core sets confirmed)
 *   bundles/<id>/index.html, core/core.js, …
 */
import type { NativeHost } from '../native-api.ts';
import type { NativePlatform } from '../platform.ts';
import { NATIVE_LEVEL } from './native-level.ts';
import { OTA_PUBLIC_KEY } from './public-key.ts';

export const MANIFEST_URL = 'https://github.com/KastaDev101/tachinovel-v2/releases/download/ota/manifest.json';
export const MANIFEST_FORMAT = 'tachinovel-ota/1';
export const PACK_FORMAT = 'tachinovel-ota-pack/1';
/** The UI must have booted within this long after launch for the launch to count as healthy. */
export const BOOT_DEADLINE_MS = 30_000;
/** Unconfirmed launches of one bundle before Swift falls back to the embedded bundle (WebBundle.swift). */
export const MAX_ATTEMPTS = 2;
/** Background checks at most this often. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_PACK_BYTES = 12 * 1024 * 1024;

export interface Manifest {
  format: string;
  id: string;
  version: string;
  build: string;
  /** ISO time of the web build (bundles are compared by it). */
  builtAt: string;
  flavor: 'personal' | 'store';
  nativeLevel: number;
  pack: { url: string; sha256: string; size: number };
  notes?: string;
  /** Ed25519 over canonicalJson(manifest without `signature`), base64. */
  signature: string;
}

export interface Staged {
  id: string;
  version: string;
  build: string;
  builtAt: string;
  nativeLevel: number;
  stagedAt: number;
}

export interface OtaState {
  version: 1;
  active: Staged | null;
  bad: string[];
  lastCheck?: number;
  lastError?: string;
}

export interface LaunchRecord {
  /** OTA bundle this launch runs, or null (embedded). */
  id: string | null;
  attempt: number;
  at: number;
  confirmed?: boolean;
  /** Set by Swift when it gave up on a bundle (too many unconfirmed launches). */
  rolledBack?: string | null;
}

export interface Running {
  source: 'embedded' | 'ota';
  id: string | null;
  version: string;
  builtAt: string;
}

export interface CheckResult {
  status: 'up-to-date' | 'staged' | 'not-configured' | 'error';
  message: string;
  version?: string;
}

/** JSON with sorted keys and no whitespace: what is signed and verified. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export function signedPayload(m: Manifest): string {
  const { signature: _signature, ...rest } = m;
  return canonicalJson(rest);
}

const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** Why a manifest can't be used here, or null when it can. */
export function rejectReason(m: Manifest, opts: { verify: (payload: string, sig: string) => boolean; flavor: string; runningBuiltAt: string; bad: readonly string[] }): string | null {
  if (m.format !== MANIFEST_FORMAT) return `unknown manifest format ${String(m.format)}`;
  if (!ID_RE.test(m.id)) return 'bad bundle id';
  if (typeof m.signature !== 'string' || !opts.verify(signedPayload(m), m.signature)) return 'signature does not verify';
  if (m.flavor !== opts.flavor) return `bundle is for the ${m.flavor} flavor`;
  if (m.nativeLevel !== NATIVE_LEVEL) return `bundle needs native level ${m.nativeLevel}, this app has ${NATIVE_LEVEL}`;
  if (opts.bad.includes(m.id)) return 'bundle was rolled back before';
  if (!(Date.parse(m.builtAt) > Date.parse(opts.runningBuiltAt))) return 'not newer than the running bundle';
  if (!/^https:\/\//.test(m.pack.url) || !/^[0-9a-f]{64}$/.test(m.pack.sha256) || !(m.pack.size > 0 && m.pack.size <= MAX_PACK_BYTES)) return 'bad pack reference';
  return null;
}

/** Pack → files, rejecting anything that isn't a plain relative path inside the bundle. */
export function parsePack(text: string): Record<string, string> {
  const pack = JSON.parse(text) as { format?: string; files?: Record<string, unknown> };
  if (pack.format !== PACK_FORMAT || !pack.files || typeof pack.files !== 'object') throw new Error('not a web bundle pack');
  const files: Record<string, string> = {};
  for (const [p, content] of Object.entries(pack.files)) {
    if (typeof content !== 'string') throw new Error(`pack entry ${p} is not text`);
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p) || p.split('/').some((s) => s === '..' || s === '.')) throw new Error(`unsafe path in pack: ${p}`);
    files[p] = content;
  }
  if (!files['index.html'] || !files['core/core.js']) throw new Error('pack lacks index.html or core/core.js');
  return files;
}

const join = (a: string, b: string): string => (a.endsWith('/') ? a + b : `${a}/${b}`);

export class Ota {
  private readonly host: NativeHost;
  private readonly platform: Pick<NativePlatform, 'http' | 'local' | 'log'>;
  private readonly dir: string;
  private readonly running: Running;
  private readonly flavor: string;
  private readonly launchAt: number;
  private readonly publicKey: string;
  private checking: Promise<CheckResult> | null = null;

  /** `publicKey` defaults to the committed key (tests pass their own). */
  constructor(host: NativeHost, platform: Pick<NativePlatform, 'http' | 'local' | 'log'>, opts: { flavor: string; version: string; builtAt: string; now: number; publicKey?: string }) {
    this.host = host;
    this.platform = platform;
    this.flavor = opts.flavor;
    this.launchAt = opts.now;
    this.publicKey = opts.publicKey ?? OTA_PUBLIC_KEY;
    this.dir = platform.local.absolute('ota');
    const id = host.info.webBundle ?? null;
    this.running = { source: id ? 'ota' : 'embedded', id, version: opts.version, builtAt: opts.builtAt };
  }

  get configured(): boolean {
    return this.publicKey.length > 0;
  }

  private path(rel: string): string {
    return join(this.dir, rel);
  }

  private readJson<T>(rel: string): T | null {
    try {
      const t = this.host.fs.readText(this.path(rel));
      return t ? (JSON.parse(t) as T) : null;
    } catch {
      return null;
    }
  }

  private writeJson(rel: string, value: unknown): void {
    this.host.fs.mkdirp(this.dir);
    const tmp = this.path(`${rel}.tmp`);
    this.host.fs.writeText(tmp, JSON.stringify(value));
    if (this.host.fs.exists(this.path(rel))) this.host.fs.remove(this.path(rel));
    this.host.fs.move(tmp, this.path(rel));
  }

  state(): OtaState {
    const s = this.readJson<OtaState>('state.json');
    return s && s.version === 1 ? { ...s, bad: Array.isArray(s.bad) ? s.bad : [] } : { version: 1, active: null, bad: [] };
  }

  launch(): LaunchRecord | null {
    return this.readJson<LaunchRecord>('launch.json');
  }

  /** At startup: take note of a rollback Swift did (mark the bundle bad, drop it). */
  reconcile(): void {
    const launch = this.launch();
    if (!launch?.rolledBack) return;
    const s = this.state();
    const bad = launch.rolledBack;
    if (!s.bad.includes(bad)) s.bad.push(bad);
    if (s.active?.id === bad) s.active = null;
    s.lastError = `bundle ${bad} did not start twice: back to the built-in one`;
    this.writeJson('state.json', s);
    this.writeJson('launch.json', { ...launch, rolledBack: null });
    this.removeBundle(bad);
    this.platform.log('warn', `Web update ${bad} failed to start twice; rolled back to the built-in bundle`);
  }

  /** The UI booted: this launch is healthy if it happened within the deadline. */
  confirmBoot(now: number): void {
    const launch = this.launch();
    if (!launch || !launch.id || launch.confirmed || launch.id !== this.running.id) return;
    if (now - this.launchAt > BOOT_DEADLINE_MS) {
      this.platform.log('warn', `Web update ${launch.id} booted after ${Math.round((now - this.launchAt) / 1000)} s: not counted as healthy`);
      return;
    }
    this.writeJson('launch.json', { ...launch, confirmed: true, attempt: 0 });
  }

  status(): { configured: boolean; running: Running; active: Staged | null; lastCheck: number | null; lastError: string | null } {
    const s = this.state();
    return { configured: this.configured, running: this.running, active: s.active, lastCheck: s.lastCheck ?? null, lastError: s.lastError ?? null };
  }

  check(opts: { force?: boolean; now: number }): Promise<CheckResult> {
    this.checking ??= this.doCheck(opts).finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async doCheck(opts: { force?: boolean; now: number }): Promise<CheckResult> {
    if (!this.configured) return { status: 'not-configured', message: 'Web updates are not set up in this build (no public key).' };
    const s = this.state();
    if (!opts.force && s.lastCheck && opts.now - s.lastCheck < CHECK_INTERVAL_MS) {
      return { status: 'up-to-date', message: 'Checked recently.' };
    }
    s.lastCheck = opts.now;
    try {
      const res = await this.platform.http.request({ url: MANIFEST_URL, timeoutMs: 20_000 });
      if (res.status === 404) {
        delete s.lastError;
        this.writeJson('state.json', s);
        return { status: 'up-to-date', message: 'No web updates published yet.' };
      }
      if (res.status !== 200) throw new Error(`manifest: HTTP ${res.status}`);
      const m = JSON.parse(res.body) as Manifest;
      const newest = s.active && Date.parse(s.active.builtAt) > Date.parse(this.running.builtAt) ? s.active.builtAt : this.running.builtAt;
      const reason = rejectReason(m, {
        verify: (payload, sig) => this.host.crypto.verifyEd25519(this.publicKey, payload, sig),
        flavor: this.flavor,
        runningBuiltAt: newest,
        bad: s.bad,
      });
      if (reason) {
        if (reason.startsWith('signature') || reason.startsWith('unknown') || reason.startsWith('bad')) throw new Error(reason);
        delete s.lastError;
        this.writeJson('state.json', s);
        return { status: 'up-to-date', message: `Up to date (${reason}).` };
      }
      const pack = await this.platform.http.request({ url: m.pack.url, timeoutMs: 120_000 });
      if (pack.status !== 200) throw new Error(`pack: HTTP ${pack.status}`);
      if (this.host.crypto.sha256Hex(pack.body) !== m.pack.sha256) throw new Error('pack checksum does not match the signed manifest');
      const files = parsePack(pack.body);
      this.install(m.id, files);
      const previous = s.active?.id;
      s.active = { id: m.id, version: m.version, build: m.build, builtAt: m.builtAt, nativeLevel: m.nativeLevel, stagedAt: opts.now };
      delete s.lastError;
      this.writeJson('state.json', s);
      if (previous && previous !== m.id && previous !== this.running.id) this.removeBundle(previous);
      this.platform.log('info', `Web update ${m.version} (${m.build}) downloaded; it applies at the next launch`);
      return { status: 'staged', message: `Version ${m.version} is ready and applies when TachiNovel next starts.`, version: m.version };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      s.lastError = message;
      this.writeJson('state.json', s);
      this.platform.log('warn', `Web update check failed: ${message}`);
      return { status: 'error', message };
    }
  }

  private install(id: string, files: Record<string, string>): void {
    const fs = this.host.fs;
    const bundles = this.path('bundles');
    const tmp = join(bundles, `${id}.tmp`);
    const final = join(bundles, id);
    fs.mkdirp(bundles);
    if (fs.exists(tmp)) fs.remove(tmp);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(tmp, rel);
      fs.mkdirp(abs.slice(0, abs.lastIndexOf('/')));
      fs.writeText(abs, content);
    }
    if (fs.exists(final)) fs.remove(final);
    fs.move(tmp, final);
  }

  private removeBundle(id: string): void {
    const p = join(this.path('bundles'), id);
    try {
      if (this.host.fs.exists(p) && id !== this.running.id) this.host.fs.remove(p);
    } catch {
      // left for the next cleanup
    }
  }
}
