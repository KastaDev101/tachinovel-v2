/**
 * Source policy gate: the v2 `loadPluginHost` passed to v1's createApp (ServicesOptions.loadPluginHost,
 * an existing v1 extension point, so v1's SourceService is reused unchanged).
 *
 * - Declarative specs (JSON, format "tachinovel-source/1") → the declarative engine (both flavors).
 * - LNReader JavaScript plugins → v1's plugin host, ONLY in the 'personal' flavor. The store flavor's
 *   bundle does not even contain the JS plugin host (dead-code eliminated via __FLAVOR__), so the App
 *   Store binary has no code path that executes downloaded code (guideline 2.5.2).
 */
import { PluginLoadError, type CreatePluginHost, type PluginHostDeps, type SourceAdapter } from '@v1/shared/contracts/plugin-host.ts';
import { lazyPluginHost } from '@v1/script/services/services.ts';
import type { LoadPluginHost, PluginHostWithInfo } from '@v1/script/services/sources.ts';
import type { NativePlatform } from '../platform.ts';
import { looksLikeSpec } from '../declarative/spec.ts';

interface DeclarativeModule {
  createDeclarativeHost: (deps: PluginHostDeps) => PluginHostWithInfo & {
    imageRequestInit(adapter: SourceAdapter): { headers?: Record<string, string> } | undefined;
  };
}

export const JS_PLUGINS_UNSUPPORTED =
  'This version only supports source definitions (JSON). JavaScript plugins are not supported.';

export function jsPluginsAllowed(): boolean {
  return __FLAVOR__ === 'personal';
}

function loadDeclarative(platform: NativePlatform): DeclarativeModule {
  const factory = platform.host.bundle.loadModule('lib/declarative-host.js');
  const mod: { exports: unknown } = { exports: {} };
  factory(mod, mod.exports, (id: string) => {
    throw new Error(`declarative-host.js: require("${id}") is not available`);
  });
  const m = mod.exports as Partial<DeclarativeModule>;
  if (typeof m.createDeclarativeHost !== 'function') throw new Error('declarative-host.js does not export createDeclarativeHost');
  return m as DeclarativeModule;
}

export function createGatedLoader(platform: NativePlatform, loadDecl: () => DeclarativeModule = () => loadDeclarative(platform)): LoadPluginHost {
  return async (deps) => {
    const decl = loadDecl().createDeclarativeHost(deps);
    let js: PluginHostWithInfo | null = null;
    if (__FLAVOR__ === 'personal') js = await lazyPluginHost(platform)(deps);
    const fromJs = new WeakSet<SourceAdapter>();
    return {
      providedModules: js?.providedModules ?? [],
      load(code, opts) {
        if (looksLikeSpec(code)) return decl.load(code, opts);
        if (!js) throw new PluginLoadError(JS_PLUGINS_UNSUPPORTED);
        const adapter = js.load(code, opts);
        fromJs.add(adapter);
        return adapter;
      },
      imageRequestInit(adapter) {
        if (fromJs.has(adapter)) return js?.imageRequestInit?.(adapter);
        return decl.imageRequestInit(adapter);
      },
    };
  };
}

export type { CreatePluginHost };
