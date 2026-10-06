/**
 * The source handed out by host.load: a SourceAdapter that can also read and change the plugin's
 * settings (contract: SourceAdapter.getSettings / setSettings, see settings.ts).
 *
 * Values are stored exactly where LNReader stores them — the plugin's own @libs/storage, under the
 * setting's key — so `storage.get(key)` in the plugin returns what the user chose. Most plugins
 * read their settings once, in the constructor, so after a change the plugin code is evaluated
 * again (same context: same storage, cookies and limits) and calls go to the new instance; calls
 * already running finish on the old one.
 */
import type { SourceAdapter, SourceMeta } from '../shared/contracts/plugin-host.ts';
import { aliasPluginInfo, createAdapter, pluginInfo } from './adapter.ts';
import type { PluginContext } from './context.ts';
import { PluginStorage } from './libs/storage.ts';
import { evaluatePluginCode, resolvePlugin } from './loader.ts';
import { readSettings, SettingsError, validateSettings, writeSettings, type PluginSettings, type PluginSettingValues } from './settings.ts';

/** SourceAdapter with the (contract-optional) settings methods always present. */
export interface LoadedSource extends SourceAdapter {
  /** Current values (`stored ?? default`) for every setting in meta.settings; {} when it has none. */
  getSettings(): PluginSettingValues;
  /**
   * Saves the given values (the others are left as they are) and reloads the plugin so they apply.
   * Returns all current values. Throws SettingsError for an unknown key, a value of the wrong type,
   * a value that is not one of the options, or when the plugin fails to load with the new values
   * (nothing is changed then).
   */
  setSettings(values: Record<string, unknown>): PluginSettingValues;
}

function schemaOf(adapter: SourceAdapter): PluginSettings | undefined {
  return pluginInfo(adapter)?.settings;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function loadSource(code: string, ctx: PluginContext, label: string, expectedId: string | undefined): LoadedSource {
  const build = (id: string | undefined): SourceAdapter => {
    const exported = evaluatePluginCode(code, ctx, label);
    const plugin = resolvePlugin(exported, label, id);
    ctx.bind(plugin.id, plugin.site);
    return createAdapter(plugin, ctx);
  };
  const storage = new PluginStorage(ctx);

  let current = build(expectedId);
  const id = current.meta.id;
  // Loaded without a known id, the constructor could not see stored values (storage is bound to
  // the id only once the plugin object exists): load again if any setting has a stored value.
  const firstSchema = schemaOf(current);
  if (!expectedId && firstSchema && Object.keys(firstSchema).some((k) => storage.get(k) !== undefined)) current = build(id);

  const source: LoadedSource = {
    get meta(): SourceMeta {
      return current.meta;
    },
    popular: (page, opts) => current.popular(page, opts),
    search: (query, page) => current.search(query, page),
    novel: (path) => current.novel(path),
    chapter: (path) => current.chapter(path),
    resolveUrl: (path, isNovel) => current.resolveUrl(path, isNovel),
    getSettings(): PluginSettingValues {
      const schema = schemaOf(current);
      return schema ? readSettings(schema, storage) : {};
    },
    setSettings(values: Record<string, unknown>): PluginSettingValues {
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new SettingsError('Settings must be an object of key → value');
      const valid = validateSettings(schemaOf(current) ?? {}, values);
      const keys = Object.keys(valid);
      if (!keys.length) return source.getSettings();
      const kv = ctx.kv();
      const before = new Map(keys.map((k) => [k, kv.get(k)] as const));
      writeSettings(valid, storage);
      try {
        current = build(id);
      } catch (err) {
        for (const [k, item] of before) {
          if (item === undefined) kv.delete(k);
          else kv.set(k, item);
        }
        throw new SettingsError(`${current.meta.name} does not load with these settings: ${describe(err)}`);
      }
      return source.getSettings();
    },
  };
  aliasPluginInfo(source, () => current);
  return source;
}
