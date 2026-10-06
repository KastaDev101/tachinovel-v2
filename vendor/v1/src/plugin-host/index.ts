/**
 * Portable plugin host: runs LNReader-format plugins (published ones unmodified, and ours) in Node,
 * Scriptable's JavaScriptCore or a WebView. Depends only on ECMAScript built-ins and PluginHostDeps.
 * See docs/plugin-survey.md for what the shim provides and why.
 */
// Must stay the first import: installs `atob` where missing, before cheerio's modules initialize.
import './polyfills/ensure-atob.ts';
import type { CreatePluginHost, PluginHost, SourceAdapter } from '../shared/contracts/plugin-host.ts';
import { createAdapter, pluginInfo, type PluginInfo } from './adapter.ts';
import { PluginContext } from './context.ts';
import { evaluatePluginCode, resolvePlugin } from './loader.ts';
import { PROVIDED_MODULES } from './modules.ts';
import { createNet } from './net.ts';

export const createPluginHost: CreatePluginHost = (deps) => {
  const net = createNet(deps);
  const host: PluginHost = {
    providedModules: PROVIDED_MODULES,
    load(code, opts): SourceAdapter {
      const label = opts?.sourceUrl ?? (opts?.expectedId ? `plugin "${opts.expectedId}"` : 'plugin');
      const ctx = new PluginContext(deps, net, opts?.expectedId);
      const exported = evaluatePluginCode(code, ctx, label);
      const plugin = resolvePlugin(exported, label, opts?.expectedId);
      ctx.bind(plugin.id, plugin.site);
      return createAdapter(plugin, ctx);
    },
  };
  return host;
};

export { pluginInfo, type PluginInfo };
export { IPHONE_SAFARI_UA } from './net.ts';
export { SHADOWED_GLOBALS, INJECTED_GLOBALS } from './loader.ts';
