/**
 * "PC shell": the closest thing to the iOS app that runs on Windows.
 *
 *   WebKit (Playwright) page            Node
 *   ───────────────────────────         ─────────────────────────────────────────────
 *   www/index.html (built UI)    ◄────  tiny HTTP server (also serves /covers/*, /cache/img-* like TachiRouter)
 *   Capacitor's REAL native-bridge.js   ← injected exactly like CAPBridgeViewController does
 *   window.webkit.messageHandlers ───►  fake CAPBridge: routes plugin calls
 *        .bridge.postMessage                Core.call → the BUILT core.js in a vm (native-mock)
 *   Capacitor.fromNative(...)    ◄────      core events → the "event" listener (like CorePlugin)
 *
 * Only the Swift layer is replaced; UI, transport protocol and core are the real artifacts.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { webkit, devices, type Browser, type Page } from 'playwright-core';
import type { CoreHarness, MockOptions } from './native-mock.ts';
import { startCoreInVm } from './native-mock.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const nativeBridgeJs = path.join(root, 'node_modules', '@capacitor', 'ios', 'Capacitor', 'Capacitor', 'assets', 'native-bridge.js');

type Rtype = 'promise' | 'callback' | null;
/** Plugin headers as JSExport.swift builds them (base methods + the plugin's own). */
const PLUGINS: Record<string, Record<string, Rtype>> = {
  Core: { call: 'promise' },
  TachiNative: { setKeepAwake: 'promise' },
  // Keep in sync with NarrationPlugin.swift pluginMethods.
  Narration: Object.fromEntries(
    ['play', 'pause', 'resume', 'stop', 'skip', 'setOptions', 'voices', 'requestPersonalVoice', 'state', 'seek', 'playNovel', 'audioFolder', 'pickAudioFolder', 'unlinkAudioFolder', 'audioLibrary', 'audioTiming'].map(
      (m) => [m, 'promise' as Rtype],
    ),
  ),
  Haptics: { impact: 'promise', notification: 'promise', vibrate: 'promise', selectionStart: 'promise', selectionChanged: 'promise', selectionEnd: 'promise' },
  Store: { products: 'promise', purchase: 'promise', restore: 'promise', entitlements: 'promise', manageSubscriptions: 'promise', redeemOfferCode: 'promise' },
  SplashScreen: { show: 'promise', hide: 'promise' },
  StatusBar: { setStyle: 'promise', setBackgroundColor: 'promise', show: 'promise', hide: 'promise', getInfo: 'promise', setOverlaysWebView: 'promise' },
};

function headersScript(): string {
  const base = [
    { name: 'addListener', rtype: null },
    { name: 'removeListener', rtype: null },
    { name: 'removeAllListeners', rtype: 'promise' },
    { name: 'checkPermissions', rtype: 'promise' },
    { name: 'requestPermissions', rtype: 'promise' },
  ];
  const headers = Object.entries(PLUGINS).map(([name, methods]) => ({
    name,
    methods: [...base, ...Object.entries(methods).map(([m, rtype]) => ({ name: m, rtype }))],
  }));
  return `(function(w){var a=(w.Capacitor=w.Capacitor||{});a.PluginHeaders=(a.PluginHeaders||[]).concat(${JSON.stringify(headers)});})(window);`;
}

export interface PluginCall {
  pluginId: string;
  methodName: string;
  options: Record<string, unknown>;
}

export interface PcShell {
  readonly page: Page;
  readonly core: CoreHarness;
  /** Every non-Core plugin call the UI made (Narration.play, SplashScreen.hide, …). */
  readonly pluginCalls: PluginCall[];
  readonly pageErrors: string[];
  readonly consoleErrors: string[];
  /** Push a plugin event to the page's listeners, like CAPPlugin.notifyListeners. */
  emitPluginEvent(plugin: string, event: string, data: Record<string, unknown>): void;
  /** Canned answers for non-Core plugin methods (default: {}). */
  readonly pluginReplies: Map<string, (options: Record<string, unknown>) => unknown>;
  close(): Promise<void>;
}

export async function startPcShell(opts: {
  wwwDir: string;
  core: Omit<MockOptions, 'wwwDir' | 'onEmit'>;
  beforeLoad?: (core: CoreHarness) => Promise<void>;
  /** localStorage entries set before the UI boots (e.g. v1's one-time reader tips). */
  initStorage?: Record<string, string>;
}): Promise<PcShell> {
  let page: Page | null = null;
  const listeners = new Map<string, string>(); // `${plugin}:${event}` → callbackId
  const fromNative = (result: Record<string, unknown>): void => {
    void page?.evaluate((r) => (window as unknown as { Capacitor: { fromNative(x: unknown): void } }).Capacitor.fromNative(r), result).catch(() => undefined);
  };
  const core = startCoreInVm({
    ...opts.core,
    wwwDir: opts.wwwDir,
    onEmit(event, payload) {
      const id = listeners.get('Core:event');
      if (id) fromNative({ callbackId: id, pluginId: 'Core', methodName: 'addListener', success: true, data: { event, payload }, save: true });
    },
  });
  await opts.beforeLoad?.(core);

  const html = readFileSync(path.join(opts.wwwDir, 'index.html'), 'utf8');
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/covers/') && !url.pathname.slice(8).includes('/')) {
      try {
        res.writeHead(200).end(readFileSync(path.join(core.localAppDir, 'covers', url.pathname.slice(8))));
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    // Chapter illustrations the core fetched (v1 images.fetch → "cache/img-<hash>.<ext>"), like TachiRouter.
    const img = /^\/cache\/(img-[A-Za-z0-9_-]+\.[A-Za-z0-9]+)$/.exec(url.pathname);
    if (img?.[1]) {
      try {
        res.writeHead(200).end(readFileSync(path.join(core.localAppDir, 'cache', img[1])));
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const browser: Browser = await webkit.launch();
  const context = await browser.newContext({ ...devices['iPhone 15 Pro'], colorScheme: 'dark' });
  page = await context.newPage();
  const pluginCalls: PluginCall[] = [];
  const pluginReplies = new Map<string, (options: Record<string, unknown>) => unknown>();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  // No real network from the page (the UI never fetches; remote covers fail → covers.fetch, like CORP sites).
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 403, body: 'blocked' }));

  await page.exposeBinding('__capPost', (_src, json: string) => {
    const msg = JSON.parse(json) as { callbackId: string; pluginId: string; methodName: string; options: Record<string, unknown> };
    const reply = (success: boolean, data: unknown): void => fromNative({ callbackId: msg.callbackId, pluginId: msg.pluginId, methodName: msg.methodName, success, data });
    if (msg.methodName === 'addListener') {
      listeners.set(`${msg.pluginId}:${String(msg.options.eventName)}`, msg.callbackId);
      return;
    }
    if (msg.pluginId === 'Core' && msg.methodName === 'call') {
      void core.callJson(String(msg.options.json)).then((res) => reply(true, { json: res }));
      return;
    }
    pluginCalls.push({ pluginId: msg.pluginId, methodName: msg.methodName, options: msg.options });
    const canned = pluginReplies.get(`${msg.pluginId}.${msg.methodName}`);
    if (canned) return reply(true, canned(msg.options));
    if (msg.pluginId === 'Narration' && msg.methodName === 'state') return reply(true, { status: 'idle' });
    if (msg.pluginId === 'Narration' && msg.methodName === 'audioTiming') return reply(true, { hasAudio: false, json: null });
    if (msg.pluginId === 'Store' && msg.methodName === 'entitlements') return reply(true, { pro: false, source: null });
    reply(true, {});
  });
  // Same injection order as CAPBridgeViewController: Capacitor global → native bridge → plugin headers.
  await page.addInitScript(`window.Capacitor={DEBUG:false,isLoggingEnabled:false,Plugins:{}};window.WEBVIEW_SERVER_URL=location.origin;` +
    `window.webkit={messageHandlers:{bridge:{postMessage:function(m){window.__capPost(JSON.stringify(m));}}}};`);
  await page.addInitScript({ path: nativeBridgeJs });
  if (opts.initStorage) {
    await page.addInitScript((entries: Record<string, string>) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    }, opts.initStorage);
  }
  await page.addInitScript(headersScript());
  await page.goto(`http://127.0.0.1:${port}/`);

  return {
    page,
    core,
    pluginCalls,
    pageErrors,
    consoleErrors,
    pluginReplies,
    emitPluginEvent(plugin, event, data) {
      const id = listeners.get(`${plugin}:${event}`);
      if (id) fromNative({ callbackId: id, pluginId: plugin, methodName: 'addListener', success: true, data, save: true });
    },
    async close() {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      core.dispose();
    },
  };
}
