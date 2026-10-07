/**
 * The crawler's app environment: the PC shell (built UI + Capacitor's native-bridge.js + built core in a
 * JSC-like vm, tests/helpers) made resettable and deterministic.
 *
 *  - Fixed clock: the page and the core both start at FIXED_NOW on every (re)load; time then flows.
 *  - Seeded Math.random in both contexts; UTC time zone, en-US locale.
 *  - No network: the core's HTTP goes to the synthetic web (fake-web.ts); the page can't fetch at all.
 *  - Resettable: the seeded store is snapshotted once; `reset()` starts a fresh core from the snapshot and
 *    reloads the page, so every crawl episode starts from the same library/history/updates/downloads.
 *  - Native layer: stateful mocks for the v2 plugins (Narration with state/progress events, Store,
 *    TachiNative, Haptics, StatusBar, SplashScreen) and recorded/steerable native UI (action sheets,
 *    alerts, share sheet, document picker = cancel, open URL).
 *  - iPhone 16 Pro in the app's full-screen WKWebView: 402×874 CSS px, safe areas 62 / 34 (the page's
 *    `env(safe-area-inset-*)` are rewritten to those values, since desktop WebKit reports 0).
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webkit, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { NativeUiApi } from '../../src/core/native-api.ts';
import { startCoreInVm, type CoreHarness } from '../helpers/native-mock.ts';
import { headersScript, nativeBridgeJs } from '../helpers/pc-shell.ts';

/** The Kokoro voices the app offers (ios/App/HDVoice/Sources/HDVoiceCore/VoiceCatalog.swift). */
const KOKORO_VOICES = [
  { id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female', blurb: 'warm, the default' },
  { id: 'af_bella', name: 'Bella', language: 'en-US', gender: 'female', blurb: 'bright' },
  { id: 'bf_emma', name: 'Emma', language: 'en-GB', gender: 'female', blurb: 'calm' },
  { id: 'am_michael', name: 'Michael', language: 'en-US', gender: 'male', blurb: 'steady' },
  { id: 'am_fenrir', name: 'Fenrir', language: 'en-US', gender: 'male', blurb: 'deep' },
  { id: 'bm_george', name: 'George', language: 'en-GB', gender: 'male', blurb: 'classic' },
];
import { createFakeWeb, FIXED_NOW, type FakeWeb } from './fake-web.ts';
import { crawlerRuntime } from './page-runtime.ts';
import { seedStore } from './seed.ts';

export type Scheme = 'dark' | 'light';

export const DEVICE = {
  name: 'iPhone 16 Pro',
  viewport: { width: 402, height: 874 },
  deviceScaleFactor: 3,
  safe: { top: 62, bottom: 34, left: 0, right: 0 },
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
} as const;

/** A native popup the core asked for (UIAlertController / share sheet / document picker / Safari). */
export interface NativeUiEvent {
  kind: 'actionSheet' | 'alert' | 'share' | 'shareFile' | 'shareImage' | 'pickFile' | 'openUrl' | 'solveChallenge';
  title?: string;
  message?: string;
  actions?: { title: string; destructive?: boolean }[];
  /** Index answered (-1 = cancel). */
  answered?: number;
  detail?: string;
}

export interface PluginCallRecord {
  plugin: string;
  method: string;
  options: Record<string, unknown>;
}

/** Shared by the page instrumentation and the crawler. */
export interface PageProbe {
  errors: string[];
  mutations: number;
  clipboard: string[];
  opened: string[];
}

export interface EnvOptions {
  wwwDir: string;
  scheme: Scheme;
  seed: number;
}

/** In-page Date/Math.random determinism (also used in the core's vm context). */
export function clockShim(now: number, seed: number): string {
  return `(function(g){
  var RealDate = g.Date; var offset = ${now} - RealDate.now();
  function FakeDate(){ var a = Array.prototype.slice.call(arguments);
    if (!(this instanceof FakeDate)) return new RealDate(RealDate.now() + offset).toString();
    var d = a.length === 0 ? new RealDate(RealDate.now() + offset) : new (Function.prototype.bind.apply(RealDate, [null].concat(a)))();
    Object.setPrototypeOf(d, FakeDate.prototype); return d; }
  FakeDate.prototype = Object.create(RealDate.prototype, { constructor: { value: FakeDate } });
  FakeDate.now = function(){ return RealDate.now() + offset; };
  FakeDate.UTC = RealDate.UTC; FakeDate.parse = RealDate.parse;
  g.__qaSetClock = function(t){ offset = t - RealDate.now(); };
  g.Date = FakeDate;
  var s = ${seed >>> 0};
  g.Math.random = function(){ s = (s + 0x6d2b79f5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
})(globalThis);`;
}

/**
 * Page instrumentation (runs before the app): error capture, a filtered mutation counter for
 * "did anything happen", clipboard/window.open recording, and listener tagging so the crawler can find
 * clickable elements that aren't buttons (Preact adds handlers with addEventListener on the element).
 */
const INSTRUMENT = `(function(){
  var probe = window.__qaProbe = { errors: [], mutations: 0, clipboard: [], opened: [] };
  window.addEventListener('error', function(e){ probe.errors.push('error: ' + (e.error && e.error.stack ? String(e.error.stack).split('\\n').slice(0,3).join(' | ') : e.message)); });
  window.addEventListener('unhandledrejection', function(e){ var r = e.reason; probe.errors.push('unhandledrejection: ' + (r && r.stack ? String(r.stack).split('\\n').slice(0,3).join(' | ') : String(r))); });
  var tagged = window.__qaClickable = new WeakSet();
  var orig = EventTarget.prototype.addEventListener;
  // Bubbling click handlers only: elements with just pointer/touch listeners are gesture surfaces, and a
  // capture-phase click listener is a delegation root swallowing the click after a long-press.
  EventTarget.prototype.addEventListener = function(type, fn, opts){
    var capture = opts === true || !!(opts && opts.capture);
    if (type === 'click' && !capture && this instanceof Element) tagged.add(this);
    return orig.call(this, type, fn, opts);
  };
  try {
    if (navigator.clipboard) navigator.clipboard.writeText = function(t){ probe.clipboard.push(String(t).slice(0, 200)); return Promise.resolve(); };
  } catch (e) {}
  window.open = function(u){ probe.opened.push(String(u)); return null; };
  // Periodic re-renders that are not reactions to a tap (v2 narration overlay ticks, car player poll).
  var NOISY = '.tn-player, .tn-listen, .tn-open-car, .tn-car';
  function noisy(n){ var el = n && n.nodeType === 1 ? n : n && n.parentElement; return !!(el && el.closest && el.closest(NOISY)); }
  function onlyPressed(m){ if (m.type !== 'attributes' || m.attributeName !== 'class') return false;
    var a = (m.oldValue || '').split(/\\s+/).filter(function(c){ return c && c !== 'is-pressed'; }).sort().join(' ');
    var b = (m.target.getAttribute('class') || '').split(/\\s+/).filter(function(c){ return c && c !== 'is-pressed'; }).sort().join(' ');
    return a === b; }
  new MutationObserver(function(list){
    for (var i = 0; i < list.length; i++) { var m = list[i];
      if (m.type === 'attributes' && /^data-qa-/.test(m.attributeName)) continue; // the crawler's own tags
      if (noisy(m.target) || onlyPressed(m)) continue; probe.mutations++; }
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true });
})();`;

/** The build's one inline script (tools/build.ts writes exactly `<script>…</script>`), or null. */
export function inlineScript(html: string): string | null {
  const open = html.indexOf('<script>');
  const close = html.lastIndexOf('</script>');
  return open >= 0 && close > open ? html.slice(open + '<script>'.length, close) : null;
}

/** Rewrite env(safe-area-inset-*) to the device's insets and re-hash the inline script for the CSP. */
export function deviceHtml(html: string): string {
  const s = DEVICE.safe;
  const sub = (text: string): string =>
    text.replace(/env\(\s*safe-area-inset-(top|bottom|left|right)\s*(?:,[^)]*)?\)/g, (_m, side: 'top' | 'bottom' | 'left' | 'right') => `${s[side]}px`);
  const oldJs = inlineScript(html);
  if (oldJs === null) throw new Error('index.html has no inline script');
  const newJs = sub(oldJs);
  const oldHash = createHash('sha256').update(oldJs, 'utf8').digest('base64');
  const newHash = createHash('sha256').update(newJs, 'utf8').digest('base64');
  let out = html.replace(oldJs, () => newJs);
  if (!out.includes(`'sha256-${oldHash}'`)) throw new Error('CSP script hash not found in index.html');
  out = out.replace(`'sha256-${oldHash}'`, `'sha256-${newHash}'`);
  // CSS (outside the script) too.
  const [head, tail] = [out.slice(0, out.indexOf('<script>')), out.slice(out.indexOf('<script>'))];
  return sub(head) + tail;
}

interface NarrationMockState {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';
  engine?: 'audio' | 'speech';
  pluginId?: string;
  novelPath?: string;
  chapterPath?: string;
  chapterName?: string;
  paragraph?: number;
  position?: number;
  duration?: number;
}

export class CrawlEnv {
  readonly web: FakeWeb;
  readonly opts: EnvOptions;
  core!: CoreHarness;
  browser!: Browser;
  context!: BrowserContext;
  page!: Page;
  private server!: Server;
  private port = 0;
  private html = '';
  private snapshotDir = '';
  private listeners = new Map<string, string>();
  /** Calls the UI made to the core since the last `takeCalls()`. */
  coreCalls: string[] = [];
  inFlight = 0;
  pluginCalls: PluginCallRecord[] = [];
  nativeUi: NativeUiEvent[] = [];
  coreErrors: string[] = [];
  /** Answers for the next native action sheets/alerts (FIFO); empty → cancel (-1). */
  readonly answers: number[] = [];
  narration: NarrationMockState = { status: 'idle' };
  audioLinked = true;
  /** Settings › Voices (NarrationPlugin voiceSettings / setVoiceSettings). */
  voicePrefs = {
    defaultVoice: 'af_heart',
    kokoroEnabled: true,
    usePCAudio: false,
    carButtons: 'chapters',
    novelVoices: {} as Record<string, string>,
    /** Voice mixer: saved mixes (NarrationPlugin saveCustomVoice / deleteCustomVoice). */
    customVoices: [] as { id: string; name: string; a: string; b: string; percent: number }[],
  };
  /** "Prepare for the drive" (NarrationPlugin prepareDrive / driveStatus / cancelDrive / clearDrive). */
  drive = {
    jobs: [] as Record<string, unknown>[],
    prepared: [] as { novelKey: string; chapterPath: string; title: string; voice: string; bytes: number; durationSec: number; createdAt: number }[],
  };

  private driveStatus(key: string | null): Record<string, unknown> {
    const prepared = this.drive.prepared.filter((c) => key === null || c.novelKey === key);
    const total = this.drive.prepared.reduce((a, c) => a + c.bytes, 0);
    return {
      jobs: this.drive.jobs.filter((j) => key === null || j.novelKey === key),
      prepared,
      bytes: key === null ? total : prepared.reduce((a, c) => a + c.bytes, 0),
      totalBytes: total,
      capBytes: 600_000_000,
    };
  }

  constructor(opts: EnvOptions) {
    this.opts = opts;
    this.web = createFakeWeb(opts.seed);
  }

  private nativeUiOverrides(): Partial<NativeUiApi> {
    const rec = (e: NativeUiEvent): void => {
      this.nativeUi.push(e);
    };
    const answer = (kind: 'actionSheet' | 'alert') => (json: string, cb: (err: string | null, r: number | null) => void) => {
      const o = JSON.parse(json) as { title?: string; message?: string; actions: { title: string; destructive?: boolean }[] };
      const a = this.answers.length > 0 ? (this.answers.shift() as number) : -1;
      rec({ kind, ...(o.title ? { title: o.title } : {}), ...(o.message ? { message: o.message } : {}), actions: o.actions, answered: a });
      setImmediate(() => cb(null, a));
    };
    return {
      actionSheet: answer('actionSheet'),
      alert: answer('alert'),
      share: (json, cb) => {
        rec({ kind: 'share', detail: json.slice(0, 200) });
        setImmediate(() => cb(null, true));
      },
      shareFile: (p, cb) => {
        rec({ kind: 'shareFile', detail: path.basename(p) });
        setImmediate(() => cb(null, true));
      },
      shareImage: (b64, cb) => {
        rec({ kind: 'shareImage', detail: `${b64.length} b64 chars` });
        setImmediate(() => (b64 ? cb(null, true) : cb('not an image', null)));
      },
      // The document picker: the user cancels (the crawler never imports files).
      pickFile: (types, _dest, cb) => {
        rec({ kind: 'pickFile', detail: types });
        setImmediate(() => cb('cancelled', null));
      },
      openUrl: (url) => rec({ kind: 'openUrl', detail: url }),
      solveChallenge: (url, cb) => {
        rec({ kind: 'solveChallenge', detail: url });
        setImmediate(() => cb(null, false));
      },
      // No SF Symbols on the PC: null makes the UI use its bundled SVG fallbacks (readable screenshots).
      symbol: () => null,
    };
  }

  private newCore(): CoreHarness {
    const core = startCoreInVm({
      wwwDir: this.opts.wwwDir,
      router: (req) => this.web.route(req),
      deferEvaluate: true,
      ui: this.nativeUiOverrides(),
      onEmit: (event, payload) => {
        const id = this.listeners.get('Core:event');
        if (id) this.fromNative({ callbackId: id, pluginId: 'Core', methodName: 'addListener', success: true, data: { event, payload }, save: true });
      },
    });
    vm.runInContext(clockShim(FIXED_NOW, this.opts.seed), core.context);
    return core;
  }

  private fromNative(result: Record<string, unknown>): void {
    void this.page?.evaluate((r) => (window as unknown as { Capacitor: { fromNative(x: unknown): void } }).Capacitor.fromNative(r), result).catch(() => undefined);
  }

  emitPluginEvent(plugin: string, event: string, data: Record<string, unknown>): void {
    const id = this.listeners.get(`${plugin}:${event}`);
    if (id) this.fromNative({ callbackId: id, pluginId: plugin, methodName: 'addListener', success: true, data, save: true });
  }

  /** Seed once (library, categories, history, updates, downloads), then snapshot the store. */
  async prepare(): Promise<void> {
    const core = this.newCore();
    // Seeded progress is a few hours old when the crawl starts.
    vm.runInContext(`__qaSetClock(${FIXED_NOW - 5 * 3_600_000})`, core.context);
    core.evaluate();
    // Seeding confirms the native prompts it triggers (the install confirmation).
    this.answers.push(0, 0, 0, 0);
    await seedStore(core, this.web);
    this.answers.length = 0;
    this.nativeUi.length = 0;
    this.snapshotDir = mkdtempSync(path.join(tmpdir(), 'tn2-crawl-seed-'));
    cpSync(core.dir, this.snapshotDir, { recursive: true });
    core.dispose();
    this.html = deviceHtml(readFileSync(path.join(this.opts.wwwDir, 'index.html'), 'utf8'));
  }

  async launch(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.startsWith('/covers/') && !url.pathname.slice(8).includes('/')) {
        try {
          res.writeHead(200).end(readFileSync(path.join(this.core.localAppDir, 'covers', decodeURIComponent(url.pathname.slice(8)))));
        } catch {
          res.writeHead(404).end();
        }
        return;
      }
      // Chapter illustrations the core fetched (images.fetch → "cache/img-<hash>.<ext>"), like TachiRouter.
      const img = /^\/cache\/(img-[A-Za-z0-9_-]+\.[A-Za-z0-9]+)$/.exec(url.pathname);
      if (img?.[1]) {
        try {
          res.writeHead(200).end(readFileSync(path.join(this.core.localAppDir, 'cache', img[1])));
        } catch {
          res.writeHead(404).end();
        }
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(this.html);
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
    this.browser = await webkit.launch();
    this.context = await this.browser.newContext({
      viewport: DEVICE.viewport,
      screen: DEVICE.viewport,
      deviceScaleFactor: DEVICE.deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
      userAgent: DEVICE.userAgent,
      colorScheme: this.opts.scheme,
      locale: 'en-US',
      timezoneId: 'UTC',
      reducedMotion: 'no-preference',
    });
    this.page = await this.context.newPage();
    const page = this.page;
    page.on('pageerror', (e) => this.pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') this.consoleErrors.push(m.text());
    });
    // The page never fetches data, but <img> loads remote covers directly (img-src https:): serve them
    // from the synthetic web; everything else is refused.
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => {
      const req = r.request();
      if (req.method() === 'GET' && req.resourceType() === 'image') {
        const res = this.web.route({ url: req.url(), method: 'GET' });
        if (res.bytes) return r.fulfill({ status: res.status ?? 200, body: Buffer.from(res.bytes), headers: res.headers ?? {} });
      }
      return r.fulfill({ status: 403, body: 'blocked' });
    });
    await page.exposeBinding('__capPost', (_src, json: string) => this.onPluginMessage(json));
    await page.addInitScript(clockShim(FIXED_NOW, this.opts.seed));
    await page.addInitScript(INSTRUMENT);
    await page.addInitScript(crawlerRuntime, { safeTop: DEVICE.safe.top, safeBottom: DEVICE.safe.bottom });
    // v1 dev flags read by the production UI: emulated safe areas, no transitions (stable screenshots).
    await page.addInitScript(
      `window.__TACHI_DEV__={safeArea:${JSON.stringify({ top: DEVICE.safe.top, bottom: DEVICE.safe.bottom })},noAnimations:true};` +
        // v1's one-time reader tips cover the reader; the crawler checks them once via help instead.
        `try{localStorage.setItem('tachinovel.tips.reader','1')}catch(e){}`,
    );
    await page.addInitScript(
      `window.Capacitor={DEBUG:false,isLoggingEnabled:false,Plugins:{}};window.WEBVIEW_SERVER_URL=location.origin;` +
        `window.webkit={messageHandlers:{bridge:{postMessage:function(m){window.__capPost(JSON.stringify(m));}}}};`,
    );
    await page.addInitScript({ path: nativeBridgeJs });
    await page.addInitScript(headersScript());
  }

  readonly pageErrors: string[] = [];
  readonly consoleErrors: string[] = [];

  private onPluginMessage(json: string): void {
    const msg = JSON.parse(json) as { callbackId: string; pluginId: string; methodName: string; options: Record<string, unknown> };
    const reply = (success: boolean, data: unknown): void =>
      this.fromNative({ callbackId: msg.callbackId, pluginId: msg.pluginId, methodName: msg.methodName, success, data, ...(success ? {} : { error: { message: String(data) } }) });
    if (msg.methodName === 'addListener') {
      this.listeners.set(`${msg.pluginId}:${String(msg.options.eventName)}`, msg.callbackId);
      return;
    }
    if (msg.methodName === 'removeListener' || msg.methodName === 'removeAllListeners') return reply(true, {});
    if (msg.pluginId === 'Core' && msg.methodName === 'call') {
      const raw = String(msg.options.json);
      let method = '?';
      try {
        method = String((JSON.parse(raw) as { method?: string }).method);
      } catch {
        // malformed: the core answers with an error envelope
      }
      this.coreCalls.push(method);
      this.inFlight++;
      const core = this.core;
      void core.callJson(raw).then((res) => {
        this.inFlight--;
        if (core !== this.core) return; // answered by a core that was reset meanwhile
        try {
          const env = JSON.parse(res) as { ok: boolean; error?: { code: string; message: string } };
          if (!env.ok && env.error && env.error.code !== 'CANCELLED') this.coreErrors.push(`${method}: ${env.error.code} ${env.error.message}`);
        } catch {
          // ignore
        }
        reply(true, { json: res });
      });
      return;
    }
    this.pluginCalls.push({ plugin: msg.pluginId, method: msg.methodName, options: msg.options });
    reply(true, this.pluginReply(msg.pluginId, msg.methodName, msg.options));
  }

  private setNarration(next: NarrationMockState): void {
    this.narration = next;
    this.emitPluginEvent('Narration', 'state', { ...next });
  }

  /** Plausible answers of the Swift plugins (NarrationPlugin, StorePlugin, TachiNativePlugin, Capacitor's). */
  private pluginReply(plugin: string, method: string, o: Record<string, unknown>): unknown {
    if (plugin === 'Narration') {
      const n = this.narration;
      switch (method) {
        case 'state':
          return { ...n };
        case 'play':
          this.setNarration({
            status: 'playing',
            engine: 'speech',
            pluginId: String(o.pluginId),
            novelPath: String(o.novelPath),
            chapterPath: String(o.chapterPath),
            chapterName: typeof o.chapterName === 'string' ? o.chapterName : '',
            paragraph: Number((o.start as { paragraph?: number } | undefined)?.paragraph ?? 0),
          });
          this.emitPluginEvent('Narration', 'progress', { chapterPath: String(o.chapterPath), engine: 'speech', paragraph: this.narration.paragraph ?? 0 });
          return {};
        case 'playNovel':
          this.setNarration({ status: 'playing', engine: 'audio', pluginId: String(o.pluginId), novelPath: String(o.novelPath), chapterPath: `${String(o.novelPath)}/1`, chapterName: 'Chapter 1', position: 0, duration: 600 });
          return {};
        case 'pause':
          if (n.status === 'playing') this.setNarration({ ...n, status: 'paused' });
          return {};
        case 'resume':
          if (n.status === 'paused') this.setNarration({ ...n, status: 'playing' });
          return {};
        case 'stop':
          this.setNarration({ status: 'idle' });
          return {};
        case 'skip':
        case 'seek':
          if (n.engine === 'audio') this.setNarration({ ...n, position: Math.max(0, Math.min(n.duration ?? 0, (n.position ?? 0) + (method === 'seek' ? Number(o.seconds) - (n.position ?? 0) : Number(o.count)))) });
          else this.setNarration({ ...n, paragraph: Math.max(0, (n.paragraph ?? 0) + Number(o.count ?? 0)) });
          return {};
        case 'setOptions':
          return {};
        case 'voices':
          return {
            voices: [
              { id: 'com.apple.voice.premium.en-US.Zoe', name: 'Zoe (Premium)', language: 'en-US', quality: 'premium', personal: false, engine: 'system' },
              { id: 'com.apple.voice.compact.en-US.Samantha', name: 'Samantha', language: 'en-US', quality: 'default', personal: false, engine: 'system' },
            ],
          };
        case 'requestPersonalVoice':
          return { status: 'denied' };
        case 'audioFolder':
          return this.audioLinked ? { linked: true, name: 'TachiNovel Audio' } : { linked: false, name: null };
        case 'pickAudioFolder':
          // Document picker: the user cancels.
          this.nativeUi.push({ kind: 'pickFile', detail: 'audio folder (Narration.pickAudioFolder)' });
          return { linked: this.audioLinked, cancelled: true };
        case 'unlinkAudioFolder':
          this.audioLinked = false;
          return { linked: false };
        case 'audioLibrary': {
          if (!this.audioLinked) return { linked: false, novels: [] };
          const alpha = this.web.demo[0];
          return {
            linked: true,
            novels: alpha
              ? [
                  {
                    key: `demo-library:novel/${alpha.slug}`,
                    pluginId: 'demo-library',
                    novelPath: `novel/${alpha.slug}`,
                    name: alpha.name,
                    chapters: [1, 2, 3].map((k) => ({ chapterPath: `novel/${alpha.slug}/${k}`, title: `Chapter ${k}`, number: k, hasTiming: true })),
                    saved: { chapterPath: `novel/${alpha.slug}/2`, seconds: 95 },
                  },
                ]
              : [],
          };
        }
        case 'audioTiming':
          return { hasAudio: false, json: null };
        case 'voiceSettings': {
          const v = this.voicePrefs;
          const key = typeof o.pluginId === 'string' && typeof o.novelPath === 'string' ? `${o.pluginId}:${o.novelPath}` : null;
          return {
            voices: KOKORO_VOICES,
            customVoices: v.customVoices,
            defaultVoice: v.defaultVoice,
            kokoroEnabled: v.kokoroEnabled,
            usePCAudio: v.usePCAudio,
            carButtons: v.carButtons,
            kokoro: { bundled: true, status: 'Ready', ready: true, crashDisabled: false, crashes: 0, revision: '006395f', bytes: 93_100_000 },
            apple: { id: 'com.apple.voice.premium.en-US.Zoe', name: 'Zoe (Premium)', language: 'en-US', quality: 'premium', onlyDefault: false },
            ...(key ? { novelVoice: v.novelVoices[key] ?? null, effectiveVoice: v.novelVoices[key] ?? v.defaultVoice } : {}),
          };
        }
        case 'setVoiceSettings': {
          const v = this.voicePrefs;
          if (typeof o.defaultVoice === 'string') v.defaultVoice = o.defaultVoice;
          if (typeof o.kokoroEnabled === 'boolean') v.kokoroEnabled = o.kokoroEnabled;
          if (typeof o.usePCAudio === 'boolean') v.usePCAudio = o.usePCAudio;
          if (o.carButtons === 'chapters' || o.carButtons === 'skip15') v.carButtons = o.carButtons;
          const novel = o.novel as { pluginId?: unknown; novelPath?: unknown; voice?: unknown } | undefined;
          if (novel && typeof novel.pluginId === 'string' && typeof novel.novelPath === 'string') {
            const key = `${novel.pluginId}:${novel.novelPath}`;
            if (typeof novel.voice === 'string' && novel.voice !== v.defaultVoice) v.novelVoices[key] = novel.voice;
            else delete v.novelVoices[key];
          }
          return {};
        }
        case 'saveCustomVoice': {
          const v = this.voicePrefs;
          const fields = { name: (typeof o.name === 'string' ? o.name.trim() : '') || 'Mix', a: typeof o.a === 'string' ? o.a : 'af_heart', b: typeof o.b === 'string' ? o.b : 'bf_emma', percent: Math.round(Number(o.percent ?? 50)) };
          // Lenient: the screen never sends two equal voices (Save is disabled); an unknown id saves a new mix.
          const old = typeof o.id === 'string' ? v.customVoices.find((m) => m.id === o.id) : undefined;
          const mix = old ? Object.assign(old, fields) : { id: `mix_${(v.customVoices.length + 1).toString(16).padStart(8, '0')}`, ...fields };
          if (!old) v.customVoices.push(mix);
          return { mix };
        }
        case 'deleteCustomVoice': {
          const v = this.voicePrefs;
          v.customVoices = v.customVoices.filter((m) => m.id !== o.id);
          if (v.defaultVoice === o.id) v.defaultVoice = 'af_heart';
          for (const [k, id] of Object.entries(v.novelVoices)) if (id === o.id) delete v.novelVoices[k];
          return {};
        }
        case 'sampleVoice':
          return { ms: 140, source: o.voice === 'apple' ? 'apple' : 'kokoro' };
        case 'voiceLab':
        case 'setVoiceLab':
          return {
            kokoro: { bundled: true, status: 'Ready', route: 'ane-cpu', routeTitle: 'Neural Engine + CPU', ahead: 3, lastLoadMs: 3200, lastLoadCold: false, memoryReleases: 0 },
            stats: { totalSentences: 0, failures: 0, firstAudio: [], sentences: [] },
            device: { model: 'iPhone17,3', os: 'Version 26.0', thermal: 'nominal', lowPower: false, memoryMB: 180, availableMB: 2600, computeDevices: ['CPU', 'GPU', 'Neural Engine (16 cores)'], battery: 0.8 },
            crashes: { total: 0, consecutive: 0, disabled: false },
            placement: [],
            routes: [
              { id: 'ane-cpu', title: 'Neural Engine + CPU', gpu: false },
              { id: 'cpu', title: 'CPU only', gpu: false },
            ],
          };
        case 'voicePlacement':
          return { stages: [] };
        case 'prepareDrive': {
          const key = `${String(o.pluginId)}:${String(o.novelPath)}`;
          const count = Number(o.chapters) || 3;
          this.drive.jobs = this.drive.jobs.filter((j) => j.novelKey !== key);
          this.drive.jobs.push({
            novelKey: key, pluginId: o.pluginId, novelPath: o.novelPath, novelName: o.novelName ?? '', count, done: 1, titles: ['Chapter 1'],
            when: o.when === 'now' ? 'now' : 'chargingOrWifi', voice: 'af_heart', state: o.when === 'now' ? 'running' : 'waiting',
            ...(o.when === 'now' ? { current: { chapterPath: 'c2', title: 'Chapter 2', sentence: 40, sentences: 120 } } : { reason: 'Waiting for charging or Wi-Fi' }),
          });
          if (!this.drive.prepared.some((c) => c.novelKey === key)) {
            this.drive.prepared.push({ novelKey: key, chapterPath: 'c1', title: 'Chapter 1', voice: 'af_heart', bytes: 6_800_000, durationSec: 1140, createdAt: 1 });
          }
          return this.driveStatus(key);
        }
        case 'driveStatus':
          return this.driveStatus(typeof o.pluginId === 'string' && typeof o.novelPath === 'string' ? `${o.pluginId}:${o.novelPath}` : null);
        case 'cancelDrive': {
          const key = `${String(o.pluginId)}:${String(o.novelPath)}`;
          this.drive.jobs = this.drive.jobs.filter((j) => j.novelKey !== key);
          return {};
        }
        case 'clearDrive': {
          const key = typeof o.pluginId === 'string' && typeof o.novelPath === 'string' ? `${o.pluginId}:${o.novelPath}` : null;
          this.drive.jobs = this.drive.jobs.filter((j) => key !== null && j.novelKey !== key);
          this.drive.prepared = this.drive.prepared.filter((c) => key !== null && c.novelKey !== key);
          return this.driveStatus(key);
        }
        case 'nowPlaying':
          return {
            info: n.status === 'idle' ? {} : { title: n.chapterName ?? '', artist: 'Novel', album: 'TachiNovel', duration: 600, elapsed: 0, rate: n.status === 'playing' ? 1 : 0 },
            commands: { buttons: this.voicePrefs.carButtons, nextTrack: this.voicePrefs.carButtons === 'chapters', skipForward: this.voicePrefs.carButtons === 'skip15' },
            state: { ...n },
            carPlayTemplates: false,
            chapterGapsMs: [],
          };
        default:
          return {};
      }
    }
    if (plugin === 'Store') {
      if (method === 'entitlements') return { pro: false, source: null };
      if (method === 'products') return { products: [] };
      return {};
    }
    if (plugin === 'StatusBar' && method === 'getInfo') return { visible: true, style: 'DARK', overlays: true };
    return {};
  }

  /** Fresh core from the seeded snapshot + page reload: the start of every crawl episode. */
  async reset(): Promise<void> {
    const old = this.core as CoreHarness | undefined;
    this.listeners.clear();
    this.narration = { status: 'idle' };
    this.audioLinked = true;
    this.answers.length = 0;
    const core = this.newCore();
    // Every store root of the seeded install (local/, icloud/, documents/, …).
    for (const name of readdirSync(this.snapshotDir)) {
      rmSync(path.join(core.dir, name), { recursive: true, force: true });
      cpSync(path.join(this.snapshotDir, name), path.join(core.dir, name), { recursive: true });
    }
    core.evaluate();
    this.core = core;
    old?.dispose();
    this.inFlight = 0;
    // The UI keeps small per-device state in localStorage (What's New seen, last tab, filters): a fresh
    // launch starts without it, like a reinstall (the reader-tips flag is re-set by the init script).
    await this.page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        // about:blank before the first load
      }
    }).catch(() => undefined);
    await this.page.goto(`http://127.0.0.1:${this.port}/`);
    await this.page.locator('[data-testid="screen-library"]').waitFor({ timeout: 20_000 });
  }

  async close(): Promise<void> {
    await this.browser?.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.core?.dispose();
    if (this.snapshotDir) rmSync(this.snapshotDir, { recursive: true, force: true });
  }
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}
