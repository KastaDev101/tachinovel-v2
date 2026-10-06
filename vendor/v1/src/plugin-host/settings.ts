/**
 * Plugin settings, as the LNReader app implements them (LNReader/lnreader, MIT):
 *   - src/plugins/types/index.ts: `pluginSettings?: { [key]: TextSetting | SwitchSetting | SelectSetting | CheckboxGroupSetting }`,
 *     `type` optional (missing = Text), `value` = the default;
 *   - src/screens/browse/hooks/usePluginSettings.ts: the settings screen shows
 *     `storage.get(key) ?? setting.value` and saves with `storage.set(key, value)` — the plugin's own
 *     @libs/storage, same keys, same item format;
 *   - plugins read them with `storage.get(key)`, usually in their constructor (so a change applies
 *     when the plugin is loaded again; the host reloads it, see source.ts).
 *
 * Settings that sign in to a site (email, password, session cookie, sign-in link, token) are left
 * out of the schema: the app only reads what sites serve logged-out. The plugin then simply sees
 * them unset, which is its logged-out path.
 *
 * Contract: SourceMeta.settings, SourceAdapter.getSettings/setSettings, sources.settings.get/set
 * (types in src/shared/contracts/domain.ts, SettingsError in plugin-host.ts).
 */
import type { PluginSetting, PluginSettingOption, PluginSettings, PluginSettingValue, PluginSettingValues } from '../shared/contracts/domain.ts';
import { SettingsError } from '../shared/contracts/plugin-host.ts';
import type { PluginStorage } from './libs/storage.ts';

export { SettingsError };
export type { PluginSetting, PluginSettingOption, PluginSettings, PluginSettingValue, PluginSettingValues };

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

function options(v: unknown): PluginSettingOption[] {
  if (!Array.isArray(v)) return [];
  const out: PluginSettingOption[] = [];
  for (const o of v as unknown[]) {
    if (o && typeof o === 'object') {
      const r = o as { label?: unknown; value?: unknown };
      const value = str(r.value);
      out.push({ label: str(r.label) || value, value });
    }
  }
  return out;
}

/** Key or label of a setting that signs in to the site (credentials, session, sign-in links). */
const LOGIN_SETTING = /pass(?:word|wd)|e-?mail|log-?in|log in|sign-?in|sign in|session|cookie|token|api.?key|credential|user.?name/i;

/** True for a setting the app never offers (it would sign in to the site). */
export function isLoginSetting(key: string, label: string): boolean {
  return LOGIN_SETTING.test(key) || LOGIN_SETTING.test(label);
}

/**
 * The plugin's `pluginSettings` as a clean schema, or undefined when it has none. Tolerates what
 * published plugins actually write (a Switch defaulting to "" or "true", a missing type = Text,
 * numbers as option values); unknown types, malformed entries and sign-in settings are skipped
 * (the keys of the latter are pushed to `dropped`).
 */
export function normalizeSettings(raw: unknown, dropped?: string[]): PluginSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: PluginSettings = {};
  for (const [key, def] of Object.entries(raw as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue;
    const d = def as { type?: unknown; label?: unknown; value?: unknown; options?: unknown };
    const label = str(d.label) || key;
    if (isLoginSetting(key, label)) {
      dropped?.push(key);
      continue;
    }
    const type = d.type === undefined ? 'Text' : str(d.type);
    switch (type) {
      case 'Text':
        out[key] = { type: 'Text', label, value: str(d.value) };
        break;
      case 'Switch':
        out[key] = { type: 'Switch', label, value: d.value === true || d.value === 'true' };
        break;
      case 'Select': {
        const opts = options(d.options);
        out[key] = { type: 'Select', label, value: str(d.value) || (opts[0]?.value ?? ''), options: opts };
        break;
      }
      case 'CheckboxGroup': {
        const opts = options(d.options);
        const value = Array.isArray(d.value) ? (d.value as unknown[]).map(str).filter((x) => opts.some((o) => o.value === x)) : [];
        out[key] = { type: 'CheckboxGroup', label, value, options: opts };
        break;
      }
      default:
        break;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** A stored or default value coerced to the setting's type (what the settings screen shows). */
function coerce(setting: PluginSetting, v: unknown): PluginSettingValue {
  switch (setting.type) {
    case 'Switch':
      return v === true || v === 'true';
    case 'Text':
      return typeof v === 'string' ? v : str(v);
    case 'Select':
      return typeof v === 'string' && setting.options.some((o) => o.value === v) ? v : setting.value;
    case 'CheckboxGroup':
      return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string' && setting.options.some((o) => o.value === x)) : setting.value;
  }
}

/** Current values: `storage.get(key) ?? default`, as LNReader's settings screen reads them. */
export function readSettings(schema: PluginSettings, storage: PluginStorage): PluginSettingValues {
  const out: PluginSettingValues = {};
  for (const [key, setting] of Object.entries(schema)) {
    const stored: unknown = storage.get(key);
    out[key] = stored === undefined || stored === null ? setting.value : coerce(setting, stored);
  }
  return out;
}

/** Checks values against the schema; throws SettingsError naming the first bad key. Undefined values are skipped. */
export function validateSettings(schema: PluginSettings, values: Record<string, unknown>): PluginSettingValues {
  const out: PluginSettingValues = {};
  for (const [key, v] of Object.entries(values)) {
    if (v === undefined) continue;
    const setting = Object.prototype.hasOwnProperty.call(schema, key) ? schema[key] : undefined;
    if (!setting) throw new SettingsError(`Unknown setting "${key}"`);
    switch (setting.type) {
      case 'Switch':
        if (typeof v !== 'boolean') throw new SettingsError(`Setting "${key}" must be true or false`);
        out[key] = v;
        break;
      case 'Text':
        if (typeof v !== 'string') throw new SettingsError(`Setting "${key}" must be text`);
        out[key] = v;
        break;
      case 'Select':
        if (typeof v !== 'string' || !setting.options.some((o) => o.value === v)) throw new SettingsError(`Setting "${key}" must be one of its options`);
        out[key] = v;
        break;
      case 'CheckboxGroup':
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && setting.options.some((o) => o.value === x))) {
          throw new SettingsError(`Setting "${key}" must be a list of its options`);
        }
        out[key] = [...new Set(v as string[])];
        break;
    }
  }
  return out;
}

/** Saves values the way LNReader does: `storage.set(key, value)` in the plugin's own storage. */
export function writeSettings(values: PluginSettingValues, storage: PluginStorage): void {
  for (const [key, v] of Object.entries(values)) storage.set(key, v);
}
