/**
 * TachiNovel.js entry (Scriptable): creates the Scriptable platform and hands over to run.ts
 * (run lock → state + UI in parallel → bridge server → flush → Script.complete(); fatal errors: log + Alert).
 * Must not export anything (built as a plain script with top-level await).
 */
import type { LogLevel } from '../shared/contracts/platform.ts';
import { createApp } from './app.ts';
import { createScriptablePlatform } from './platform/scriptable.ts';
import { startWebViewHost } from './platform/webview-host.ts';
import { runTachiNovel } from './run.ts';
import { createRunLock } from './services/run-lock.ts';

const BUILD = `${__BUILD_VERSION__}+${__BUILD_HASH__}`;
const BUILD_STAMP = `${BUILD}@${__BUILD_TIME__}`;

interface Flags {
  fastPresent: boolean;
  /** browserFetch POST as one callback evaluation instead of start + short polls (comparison only). */
  browserPostCallback: boolean;
}

/** Optional synced `flags.json` toggles for phone checks (no rebuild needed). */
async function readFlags(platform: ReturnType<typeof createScriptablePlatform>): Promise<Flags> {
  try {
    const text = await platform.synced.readText('flags.json');
    const v: unknown = text ? JSON.parse(text) : null;
    const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    return { fastPresent: o.fastPresent === true, browserPostCallback: o.browserPostCallback === true };
  } catch {
    return { fastPresent: false, browserPostCallback: false };
  }
}

async function main(): Promise<void> {
  const platform = createScriptablePlatform();
  const log = (level: LogLevel, message: string, data?: unknown): void => platform.log(level, message, data);
  // One instance at a time (a widget/Shortcut deep link can start a second run while the app is open).
  // The busy-launch rules (newest wins once its view is on screen; yield quietly when present() is
  // refused) live in run.ts, where they are unit-tested.
  await runTachiNovel({
    platform,
    lock: createRunLock(platform),
    buildVersion: BUILD,
    // Deep links: scriptable:///run/TachiNovel?plugin=...&novel=...[&chapter=...] (args read by the platform adapter).
    createApp,
    startHost: () =>
      startWebViewHost({
        local: platform.local,
        buildStamp: BUILD_STAMP,
        log,
        // Read after present(), during the view's settle wait: an iCloud read never holds the screen.
        fastPresent: async () => {
          const flags = await readFlags(platform);
          if (flags.browserPostCallback) platform.setBrowserPostMode('callback');
          return flags.fastPresent;
        },
      }),
  });
}

await main();
