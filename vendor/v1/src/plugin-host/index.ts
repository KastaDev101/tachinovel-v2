/**
 * Portable plugin host: runs LNReader-format plugins (published ones unmodified, and ours) in Node,
 * Scriptable's JavaScriptCore or a WebView. Depends only on ECMAScript built-ins and PluginHostDeps.
 * See docs/plugin-survey.md for what the shim provides and why.
 */
// Must stay the first import: installs `atob` where missing, before cheerio's modules initialize.
import './polyfills/ensure-atob.ts';
import type { CreatePluginHost, PluginHost, PluginHostDeps } from '../shared/contracts/plugin-host.ts';
import { pluginInfo, type PluginInfo } from './adapter.ts';
import { PluginContext } from './context.ts';
import { PROVIDED_MODULES } from './modules.ts';
import { createNet } from './net.ts';
import { loadSource, type LoadedSource } from './source.ts';

/** PluginHost whose load() returns a LoadedSource (SourceAdapter with getSettings/setSettings always present). */
export interface SettingsPluginHost extends PluginHost {
  load(code: string, opts?: { expectedId?: string; sourceUrl?: string }): LoadedSource;
}

export const createPluginHost = ((deps: PluginHostDeps): SettingsPluginHost => {
  const net = createNet(deps);
  const host: SettingsPluginHost = {
    providedModules: PROVIDED_MODULES,
    load(code, opts) {
      const label = opts?.sourceUrl ?? (opts?.expectedId ? `plugin "${opts.expectedId}"` : 'plugin');
      const ctx = new PluginContext(deps, net, opts?.expectedId);
      return loadSource(code, ctx, label, opts?.expectedId);
    },
  };
  return host;
}) satisfies CreatePluginHost;

export { pluginInfo, type PluginInfo, type LoadedSource };
export { SettingsError, type PluginSetting, type PluginSettingOption, type PluginSettings, type PluginSettingValue, type PluginSettingValues } from './settings.ts';
export { IPHONE_SAFARI_UA } from './net.ts';
export { SHADOWED_GLOBALS, INJECTED_GLOBALS } from './loader.ts';
