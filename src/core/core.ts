/**
 * The v2 core: v1's script-side app (services + handlers, unchanged) on the native platform, plus a
 * direct request dispatcher (no long-poll: the native bridge allows concurrent calls) and a few v2-only
 * methods used by native code (narration, background refresh).
 *
 * Who calls the dispatcher:
 *  - the UI, through the Capacitor `Core` plugin (CorePlugin.swift → CoreHost.call);
 *  - native code directly (NarrationController asks for the next chapter's text while the screen is
 *    locked; the BGAppRefreshTask runs updates.backgroundCheck). The WebView is not involved, which is
 *    why the core lives in a native-owned JSContext instead of the WebView (docs/architecture.md).
 */
import { type App, createApp } from '@v1/script/app.ts';
import { errorMessage, toBridgeError } from '@v1/script/lib/errors.ts';
import { novelKeyString, type ChapterMeta } from '@v1/shared/contracts/domain.ts';
import type { MethodHandlers, RequestEnvelope, ResponseEnvelope } from '@v1/shared/contracts/protocol.ts';
import { deepLinkProblem } from './deep-link.ts';
import { clearReports, type DiagnosticSummary, exportReports, listReports, recordPayload } from './diagnostics/metrickit.ts';
import type { NativeHost } from './native-api.ts';
import { htmlToBlocks, validateLexicon, type Lexicon } from '@v1tts/frontend.ts';
import { emptyLexiconStore, lexiconsFor, paragraphMapper, speechScript, type LexiconStore, type SpeechScript } from './narration/speech-script.ts';
import { narrationScript, type NarrationParagraph } from './narration/text.ts';
import { createNativePlatform, type NativePlatform } from './platform.ts';
import { createGatedLoader, jsPluginsAllowed } from './sources/gate.ts';

/** v2-only methods (not in v1's BridgeMethods). Same envelope format. */
export interface V2Methods {
  'v2.info': { args: void; result: V2Info };
  /**
   * Narration script for a chapter (fetched/cached like chapter.get). `script` is the sentence script for
   * the speech engine (v1 narration front-end + the novel's pronunciation lexicon); `paragraphs` is the
   * older paragraph/sentence form, kept for callers that don't know `script`.
   */
  'narration.chapterText': {
    args: { pluginId: string; novelPath: string; chapterPath: string };
    result: { chapterPath: string; title: string; paragraphs: NarrationParagraph[]; script: SpeechScript; next?: ChapterMeta; prev?: ChapterMeta };
  };
  /** Pronunciation lexicons (Settings › Voices › Pronunciations): the global one, and a novel's own. */
  'narration.lexicon.get': { args: { novelKey?: string }; result: { global: Lexicon; novel: Lexicon | null } };
  /** Replace the global lexicon (no novelKey) or a novel's. Validated like the PC narrator's lexicons. */
  'narration.lexicon.set': { args: { novelKey?: string; lexicon: Lexicon }; result: { entries: number } };
  /**
   * Where narration should resume for a novel (CarPlay "Continue listening", lock-screen resume): the
   * last chapter read and its saved paragraph; if that chapter was finished, the start of the next one.
   * null when the novel has no reading progress.
   */
  'narration.resumePoint': {
    args: { pluginId: string; novelPath: string };
    result: { chapterPath: string; chapterName?: string; paragraph: number } | null;
  };
  /** BGAppRefreshTask: check library updates within the time budget, then flush. */
  'updates.backgroundCheck': { args: { budgetMs?: number }; result: { newChapters: number; checked: boolean } };
  /** App moved to background: flush debounced state now (native holds a background task assertion). */
  'app.background': { args: void; result: void };
  /** tachinovel://open?… deep link while running → v1's `app.deepLink` event (installed sources only). */
  'app.openLink': { args: { pluginId: string; novelPath: string; chapterPath?: string }; result: { delivered: boolean } };
  /** MetricKit payload JSON from MetricDiagnostics.swift: stored on the device and logged (diagnostics/metrickit.ts). */
  'diagnostics.metricPayload': { args: { json: string }; result: { added: number } };
  /** Stored crash/hang reports, newest first. */
  'diagnostics.reports': { args: void; result: DiagnosticSummary[] };
  /** Share every stored report as one JSON file through the share sheet (nothing is uploaded). */
  'diagnostics.shareReports': { args: void; result: { shared: number } };
  'diagnostics.clearReports': { args: void; result: { removed: number } };
}

export interface V2Info {
  flavor: 'personal' | 'store';
  build: string;
  jsPlugins: boolean;
  ads: boolean;
  platform: string;
  launchReason: string;
}

export interface Core {
  readonly app: App;
  readonly platform: NativePlatform;
  /** Handle one RequestEnvelope JSON; always resolves with a ResponseEnvelope JSON. */
  handle(requestJson: string): Promise<string>;
}

type AnyHandler = (args: never) => Promise<unknown>;

/** Pronunciation lexicons (synced store). */
const LEXICON_FILE = 'narration-lexicons.json';

/** A chapter counts as finished for resume purposes from this scroll/listen fraction on. */
const FINISHED_AT = 0.98;

function respond(id: number, result: unknown): string {
  return JSON.stringify({ kind: 'res', id, ok: true, result: result === undefined ? null : result } satisfies ResponseEnvelope);
}

function fail(id: number, err: unknown): string {
  return JSON.stringify({ kind: 'res', id, ok: false, error: toBridgeError(err) } satisfies ResponseEnvelope);
}

/** Personal flavor: copy bundled built-in plugins into synced app/ when the build changes (v1 deploy parity). */
async function installBundledApp(platform: NativePlatform, build: string): Promise<void> {
  if (__FLAVOR__ !== 'personal') return;
  const stampPath = 'app/build.txt';
  if ((await platform.synced.readText(stampPath)) === build) return;
  const list = platform.host.bundle.read('app/manifest.json');
  const files = list ? (JSON.parse(list) as string[]) : [];
  for (const rel of files) {
    const code = platform.host.bundle.read(`app/${rel}`);
    if (code !== null) await platform.synced.writeText(`app/${rel}`, code);
  }
  await platform.synced.writeText(stampPath, build);
}

export async function startCore(host: NativeHost, opts: { build: string }): Promise<Core> {
  const platform = createNativePlatform(host);
  await installBundledApp(platform, opts.build).catch((err: unknown) => platform.log('warn', `Bundled app files: ${errorMessage(err)}`));
  const app = await createApp({
    platform,
    buildVersion: opts.build,
    loadPluginHost: createGatedLoader(platform),
    solveChallenge: (url) => platform.solveChallenge(url),
    flushLogs: () => platform.flushLogs({ mirror: false }),
  });
  app.attachEvents((event, payload) => host.emit(event, JSON.stringify(payload ?? null)));

  const v1 = app.handlers as unknown as Record<string, AnyHandler>;

  async function loadLexicons(): Promise<LexiconStore> {
    const text = await platform.synced.readText(LEXICON_FILE).catch(() => null);
    if (!text) return emptyLexiconStore();
    try {
      const s = JSON.parse(text) as Partial<LexiconStore>;
      const base = emptyLexiconStore();
      return {
        schemaVersion: 1,
        global: s.global && validateLexicon(s.global).length === 0 ? s.global : base.global,
        novels: Object.fromEntries(Object.entries(s.novels ?? {}).filter(([, l]) => validateLexicon(l).length === 0)),
      };
    } catch {
      return emptyLexiconStore();
    }
  }
  const v2: { [K in keyof V2Methods]: (args: V2Methods[K]['args']) => Promise<V2Methods[K]['result']> } = {
    'v2.info': () =>
      Promise.resolve({
        flavor: __FLAVOR__,
        build: opts.build,
        jsPlugins: jsPluginsAllowed(),
        ads: __ADS__,
        platform: host.info.platform,
        launchReason: host.info.launchReason,
      }),
    'narration.chapterText': async (args) => {
      const get = v1['chapter.get'] as (a: unknown) => ReturnType<MethodHandlers['chapter.get']>;
      const ch = await get({ pluginId: args.pluginId, novelPath: args.novelPath, chapterPath: args.chapterPath });
      const paragraphs = narrationScript(ch.html, ch.title);
      const blocks = htmlToBlocks(ch.html);
      const lexicons = lexiconsFor(await loadLexicons(), novelKeyString({ pluginId: args.pluginId, path: args.novelPath }));
      return {
        chapterPath: ch.chapterPath,
        title: ch.title,
        paragraphs,
        script: speechScript(blocks, { title: ch.title, lexicons, paragraphOf: paragraphMapper(blocks, paragraphs.map((p) => p.text)) }),
        ...(ch.next ? { next: ch.next } : {}),
        ...(ch.prev ? { prev: ch.prev } : {}),
      };
    },
    'narration.lexicon.get': async (args) => {
      const store = await loadLexicons();
      const key = typeof args?.novelKey === 'string' ? args.novelKey : undefined;
      return { global: store.global, novel: key ? (store.novels[key] ?? null) : null };
    },
    'narration.lexicon.set': async (args) => {
      const problems = validateLexicon(args?.lexicon);
      if (problems.length > 0) throw Object.assign(new Error(`Invalid pronunciation list: ${problems.slice(0, 3).join('; ')}`), { code: 'INVALID_ARGS' });
      const lexicon: Lexicon = { schemaVersion: 1, entries: args.lexicon.entries };
      const store = await loadLexicons();
      if (typeof args.novelKey === 'string' && args.novelKey) {
        if (lexicon.entries.length > 0) store.novels[args.novelKey] = lexicon;
        else delete store.novels[args.novelKey];
      } else {
        store.global = lexicon;
      }
      await platform.synced.writeText(LEXICON_FILE, JSON.stringify(store));
      return { entries: lexicon.entries.length };
    },
    'narration.resumePoint': async (args) => {
      if (!args || typeof args.pluginId !== 'string' || typeof args.novelPath !== 'string') {
        throw Object.assign(new Error('pluginId and novelPath are required'), { code: 'INVALID_ARGS' });
      }
      const prog = await app.services.progress.get(novelKeyString({ pluginId: args.pluginId, path: args.novelPath }));
      const last = prog.value.lastChapterPath;
      if (!last) return null;
      const pos = prog.position(last);
      const lastName = prog.value.lastChapterName;
      if (!pos || pos.percent < FINISHED_AT) {
        return { chapterPath: last, ...(lastName ? { chapterName: lastName } : {}), paragraph: Math.max(0, Math.floor(pos?.paragraph ?? 0)) };
      }
      // Finished: continue with the next readable chapter (chapter.get knows prev/next from the stored list).
      const get = v1['chapter.get'] as (a: unknown) => ReturnType<MethodHandlers['chapter.get']>;
      const ch = await get({ pluginId: args.pluginId, novelPath: args.novelPath, chapterPath: last }).catch(() => null);
      const next = ch?.next;
      if (next && !next.locked) return { chapterPath: next.path, chapterName: next.name, paragraph: 0 };
      return { chapterPath: last, ...(lastName ? { chapterName: lastName } : {}), paragraph: 0 };
    },
    'updates.backgroundCheck': async (args) => {
      const budget = Math.max(1000, Math.min(args?.budgetMs ?? 25_000, 25_000));
      const check = v1['library.checkUpdates'] as (a: unknown) => Promise<{ newChapters: number }>;
      const timedOut = platform.sleep(budget).then(() => null);
      const result = await Promise.race([check({}).catch(() => null), timedOut]);
      await app.flush();
      return result ? { newChapters: result.newChapters, checked: true } : { newChapters: 0, checked: false };
    },
    'app.background': async () => {
      await app.flush();
      await platform.flushLogs();
    },
    'app.openLink': (args) => {
      if (!args || typeof args.pluginId !== 'string' || typeof args.novelPath !== 'string') {
        return Promise.reject(Object.assign(new Error('pluginId and novelPath are required'), { code: 'INVALID_ARGS' }));
      }
      const link: { pluginId: string; novelPath: string; chapterPath?: string } = { pluginId: args.pluginId, novelPath: args.novelPath };
      if (typeof args.chapterPath === 'string') link.chapterPath = args.chapterPath;
      // Links can come from any app or web page: keep the paths on the source's own site (security review SR-6).
      const problem = deepLinkProblem(link, app.services.sources.get(link.pluginId)?.site);
      if (problem) return Promise.reject(Object.assign(new Error(`Deep link refused (${problem})`), { code: 'INVALID_ARGS' }));
      return Promise.resolve({ delivered: app.deliverDeepLink(link) });
    },
    'diagnostics.metricPayload': async (args) => {
      if (!args || typeof args.json !== 'string') throw Object.assign(new Error('json is required'), { code: 'INVALID_ARGS' });
      const added = await recordPayload(platform.local, args.json, platform.now(), (level, message) => platform.log(level, message));
      if (added > 0) await platform.flushLogs({ mirror: false });
      return { added };
    },
    'diagnostics.reports': () => listReports(platform.local),
    'diagnostics.shareReports': async () => {
      const reports = await listReports(platform.local);
      const file = await exportReports(platform.local, { app: opts.build, exportedAt: platform.now() });
      if (!file) return { shared: 0 };
      await platform.native.shareFile(platform.local.absolute(file));
      return { shared: reports.length };
    },
    'diagnostics.clearReports': () => Promise.resolve({ removed: clearReports(platform.local) }),
  };
  const table: Record<string, AnyHandler | undefined> = { ...v1, ...(v2 as unknown as Record<string, AnyHandler>) };

  async function handle(requestJson: string): Promise<string> {
    let env: RequestEnvelope;
    try {
      env = JSON.parse(requestJson) as RequestEnvelope;
    } catch {
      return fail(0, Object.assign(new Error('Malformed request'), { code: 'INVALID_ARGS' }));
    }
    const id = typeof env.id === 'number' ? env.id : 0;
    const fn = typeof env.method === 'string' ? table[env.method] : undefined;
    if (!fn) return fail(id, Object.assign(new Error(`Unknown method ${String(env.method)}`), { code: 'UNKNOWN_METHOD' }));
    try {
      const result = await fn(env.args as never);
      // The UI booted from the new free-sideload layout: its old copies may go at the next launch.
      if (env.method === 'app.boot') platform.layout?.confirm();
      return respond(id, result);
    } catch (err) {
      return fail(id, err);
    }
  }

  return { app, platform, handle };
}
